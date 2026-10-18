import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';
import {
  customerSide,
  isExtensionNumber,
  matchClick,
  phoneCallProgress,
  phoneCallStatusAfter,
  recordingIdFrom,
  storedNumber,
  type EnvoCallFacts,
  type PhoneCallDirection,
  type PhoneCallDisposition,
  type PhoneCallStatus,
} from '@elysium/domain/telephony';

import { emit } from '../../platform/events/outbox.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { IAM_API, type IamApi } from '../iam/iam.api.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { CALLING_ROLES } from './telephony.roles.js';
import { TELEPHONY_QUEUES } from './telephony.queues.js';
import * as repo from './telephony.repository.js';

/** Who the database sees acting when Envo's word is applied. Not a person. */
export const TELEPHONY_SYSTEM_USER = 'system:telephony';

/** How long before a call's start a click may have been made, and after (clock skew). */
const MATCH_BEFORE_MS = 3 * 60_000;
const MATCH_AFTER_MS = 5_000;

export type IngestOutcome = 'created' | 'matched' | 'updated' | 'unchanged';

/**
 * Envo's word about a call, applied to `telephony.calls` (M47, D-835 to D-838): from a webhook
 * body (`telephony.process_webhook`) or a row of the call history (the sync). One function for
 * both, so a call the webhook described and the sync later lists is one call, and the sync fills
 * exactly what a missed webhook would have.
 *
 * A call Envo names for the first time is the newest click of the connection whose extension or
 * number is on it, from the three minutes before it started (Envo's `POST /calls` answers with no
 * id); otherwise a new row, its person found by the extension on it (its holder, when they still
 * place calls and already held it when the call started, D-846), its customer by the phone on
 * the customer's side (`ORDERS_API.buyerIdByPhone`), and its order the customer's newest open one.
 * Then its progress moves forward only (`phoneCallProgress`; the trigger holds the same rule), and
 * a recording on the connection's own host is queued for download. Runs in the caller's
 * transaction, under a lock on the Envo call, and never calls Envo (invariant 6).
 */
@Injectable()
export class TelephonyIngestService {
  constructor(
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    @Inject(IAM_API) private readonly iam: IamApi,
  ) {}

  /**
   * Whom an extension names on a call that started at `at` (D-846): its holder, when they are
   * still a member who places calls and held it before the call began. A call the sync or a late
   * webhook brings in after the extension changed hands is nobody's rather than the new
   * holder's (they would hear a conversation they were not on); a supervisor sees it.
   */
  async holderAt(
    tx: Tx,
    orgId: string,
    connectionId: string,
    extension: string,
    at: Date,
  ): Promise<string | null> {
    const assignment = await repo.assignmentOfExtension(tx, orgId, connectionId, extension);
    if (assignment === undefined) return null;
    if (new Date(assignment.created_at).getTime() > at.getTime()) return null;
    const members = await this.iam.activeMembers(tx, orgId, { roles: CALLING_ROLES });
    return members.some((member) => member.userId === assignment.user_id)
      ? assignment.user_id
      : null;
  }

  async apply(
    tx: Tx,
    orgId: string,
    connection: repo.ConnectionRow,
    facts: EnvoCallFacts,
    source: 'webhook' | 'sync',
    now: Date = new Date(),
  ): Promise<{ readonly callId: string; readonly outcome: IngestOutcome }> {
    await repo.lockEnvoCall(tx, orgId, connection.id, facts.callId);
    let call = await repo.callByEnvoId(tx, orgId, connection.id, facts.callId);
    let outcome: IngestOutcome = 'updated';

    if (call === undefined) {
      const at = facts.startedAt ?? now;
      const pending = await repo.pendingClicks(
        tx,
        orgId,
        connection.id,
        new Date(at.getTime() - MATCH_BEFORE_MS),
        new Date(at.getTime() + MATCH_AFTER_MS),
      );
      const click = matchClick(
        pending.flatMap((row) =>
          row.extension === null || row.customer_phone_e164 === null || row.requested_at === null
            ? []
            : [
                {
                  id: row.id,
                  extension: row.extension,
                  toE164: row.customer_phone_e164,
                  requestedAt: new Date(row.requested_at),
                },
              ],
        ),
        facts,
        at,
      );
      if (click !== null) {
        call = await repo.updateCall(tx, orgId, click.id, { envoCallId: facts.callId });
        outcome = 'matched';
      } else {
        call = await this.create(tx, orgId, connection, facts, source, now);
        outcome = 'created';
      }
    }

    const before = call;
    const change = await this.progress(tx, orgId, connection, call, facts, now);
    const after =
      Object.keys(change).length === 0 ? call : await repo.updateCall(tx, orgId, call.id, change);

    if (after.recording_status === 'pending' && before.recording_status !== 'pending') {
      await enqueue(
        tx,
        TELEPHONY_QUEUES.fetchRecording.name,
        { callId: after.id },
        { orgId, ref: after.id, singletonKey: `recording:${after.id}` },
      );
    }
    const moved =
      outcome !== 'updated' ||
      after.status !== before.status ||
      after.answered !== before.answered ||
      after.recording_status !== before.recording_status ||
      after.user_id !== before.user_id;
    if (moved) await announce(tx, orgId, after);
    return {
      callId: after.id,
      outcome: outcome === 'updated' && Object.keys(change).length === 0 ? 'unchanged' : outcome,
    };
  }

  /** A call Envo told us about that no click started. */
  private async create(
    tx: Tx,
    orgId: string,
    connection: repo.ConnectionRow,
    facts: EnvoCallFacts,
    source: 'webhook' | 'sync',
    now: Date,
  ): Promise<repo.CallRow> {
    const direction = facts.direction;
    const customerPhone = customerSide(facts);
    // The ERP's side of the call: the caller of an outbound or internal call, the number dialled
    // of an internal one. An inbound call says which number it came in on, not who answered.
    const extension =
      direction !== 'inbound' && isExtensionNumber(facts.from)
        ? facts.from
        : direction === 'internal' && isExtensionNumber(facts.to)
          ? facts.to
          : null;
    const assignee =
      extension === null
        ? null
        : await this.holderAt(tx, orgId, connection.id, extension, facts.startedAt ?? now);
    const link = customerPhone === null ? null : await this.customerLink(tx, orgId, customerPhone);
    return repo.insertCall(tx, {
      orgId,
      connectionId: connection.id,
      envoCallId: facts.callId,
      firstSeen: source,
      direction,
      status: phoneCallStatusAfter(null, facts.event),
      fromNumber: storedNumber(facts.from),
      toNumber: storedNumber(facts.to),
      customerPhoneE164: customerPhone,
      extension,
      userId: assignee,
      customerId: link?.customerId ?? null,
      customerName: link?.customerName ?? null,
      orderId: link?.order?.id ?? null,
      orderNo: link?.order?.orderNo ?? null,
      orderOwnerUserId: link?.order?.assignedTo ?? null,
      occurredAt: facts.startedAt ?? now,
      requestedAt: null,
    });
  }

  /** The buyer a phone names, with their newest open order (D-835). */
  async customerLink(
    tx: Tx,
    orgId: string,
    phoneE164: string,
  ): Promise<{
    readonly customerId: string;
    readonly customerName: string | null;
    readonly order: {
      readonly id: string;
      readonly orderNo: string;
      readonly assignedTo: string | null;
    } | null;
  } | null> {
    const customerId = await this.orders.buyerIdByPhone(tx, orgId, phoneE164);
    if (customerId === undefined) return null;
    const panel = await this.orders.customerPanel(tx, orgId, customerId, 0, systemViewer(orgId));
    const [order] = await this.orders.openOrdersOfCustomer(tx, orgId, customerId, 1);
    return {
      customerId,
      customerName: panel?.name ?? null,
      order:
        order === undefined
          ? null
          : { id: order.id, orderNo: order.orderNo, assignedTo: order.assignedTo },
    };
  }

  /** What this word from Envo moves on the call, each part only when it may move. */
  private async progress(
    tx: Tx,
    orgId: string,
    connection: repo.ConnectionRow,
    call: repo.CallRow,
    facts: EnvoCallFacts,
    now: Date,
  ): Promise<repo.CallChange> {
    const change: { -readonly [K in keyof repo.CallChange]: repo.CallChange[K] } = {};
    const moved = phoneCallProgress(
      {
        status: call.status as PhoneCallStatus,
        answered: call.answered,
        direction: call.direction as PhoneCallDirection,
        fromNumber: call.from_number,
        toNumber: call.to_number,
        disposition: call.disposition as PhoneCallDisposition | null,
        talkSeconds: call.talk_seconds,
        durationSeconds: call.duration_seconds,
        startedAt: call.started_at === null ? null : new Date(call.started_at),
        answeredAt: call.answered_at === null ? null : new Date(call.answered_at),
        endedAt: call.ended_at === null ? null : new Date(call.ended_at),
      },
      facts,
      now,
    );
    if (moved.status !== undefined) change.status = moved.status;
    if (moved.answered !== undefined) change.answered = moved.answered;
    if (moved.direction !== undefined) change.direction = moved.direction;
    if (moved.fromNumber !== undefined) change.fromNumber = moved.fromNumber;
    if (moved.toNumber !== undefined) change.toNumber = moved.toNumber;
    if (moved.disposition !== undefined) change.disposition = moved.disposition;
    if (moved.talkSeconds !== undefined) change.talkSeconds = moved.talkSeconds;
    if (moved.durationSeconds !== undefined) change.durationSeconds = moved.durationSeconds;
    if (moved.startedAt != null) change.startedAt = moved.startedAt;
    if (moved.answeredAt != null) change.answeredAt = moved.answeredAt;
    if (moved.endedAt != null) change.endedAt = moved.endedAt;

    // The links, once each (D-835): a call with no customer yet gets the one its phone names.
    const customerPhone =
      call.customer_phone_e164 ??
      customerSide({
        direction:
          (change.direction as EnvoCallFacts['direction'] | undefined) ??
          (call.direction as EnvoCallFacts['direction']),
        from: facts.from,
        to: facts.to,
      });
    if (call.customer_phone_e164 === null && customerPhone !== null) {
      change.customerPhoneE164 = customerPhone;
    }
    // A click's links are the click's own (D-834): a Call to a bare number names its buyer only
    // when the caller may open them, so Envo's word never adds one to the caller's row later
    // (the caller would read the buyer, their open order and its owner off their own call).
    if (call.customer_id === null && customerPhone !== null && call.first_seen !== 'click') {
      const link = await this.customerLink(tx, orgId, customerPhone);
      if (link !== null) {
        change.customerId = link.customerId;
        if (link.customerName !== null && call.customer_name === null) {
          change.customerName = link.customerName;
        }
        if (call.order_id === null && link.order !== null) {
          change.orderId = link.order.id;
          change.orderNo = link.order.orderNo;
          if (call.order_owner_user_id === null && link.order.assignedTo !== null) {
            change.orderOwnerUserId = link.order.assignedTo;
          }
        }
      }
    }
    if (call.user_id === null && call.extension === null && call.direction !== 'inbound') {
      const extension = isExtensionNumber(facts.from) ? facts.from : null;
      if (extension !== null) {
        const startedAt =
          change.startedAt ?? (call.started_at === null ? now : new Date(call.started_at));
        const assignee = await this.holderAt(tx, orgId, connection.id, extension, startedAt);
        change.extension = extension;
        if (assignee !== null) change.userId = assignee;
      }
    }

    // The recording, from the connection's own host only (D-840).
    if (call.recording_url === null && facts.recordingUrl !== null) {
      const origin = new URL(connection.base_url).origin;
      if (recordingIdFrom(facts.recordingUrl, origin) !== null) {
        change.recordingUrl = facts.recordingUrl;
        if (call.recording_status === 'none' || call.recording_status === 'failed') {
          change.recordingStatus = 'pending';
          change.recordingError = null;
        }
      } else if (call.recording_status === 'none') {
        change.recordingStatus = 'failed';
        change.recordingError = 'not_connection_host';
      }
    }

    if (Object.keys(change).length > 0) change.lastEvent = facts.event;
    return change;
  }
}

/** A viewer for reads that use none of the viewer's scope (a buyer's name, with no orders). */
function systemViewer(orgId: string): ActiveContext {
  return {
    orgId,
    userId: TELEPHONY_SYSTEM_USER,
    isSuperAdmin: false,
    roles: [],
    branchIds: [],
    branchIdsByRole: {},
    requestId: '',
  };
}

/** The realtime news of a call (D-850): ids, to the supervisors and the people it concerns. */
export async function announce(tx: Tx, orgId: string, call: repo.CallRow): Promise<void> {
  const userIds = [...new Set([call.user_id, call.order_owner_user_id])].filter(
    (id): id is string => id !== null,
  );
  await emit(
    tx,
    'telephony.call_changed',
    {
      callId: call.id,
      orderId: call.order_id,
      status: call.status as PhoneCallStatus,
      recording: call.recording_status as 'none' | 'pending' | 'stored' | 'failed' | 'expired',
      userIds,
    },
    { orgId },
  );
}
