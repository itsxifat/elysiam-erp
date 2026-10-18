import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';
import {
  answeredAfter,
  customerSide,
  isExtensionNumber,
  isPhoneCallOver,
  matchClick,
  phoneCallStatusAfter,
  recordingIdFrom,
  storedNumber,
  type EnvoCallFacts,
  type PhoneCallStatus,
} from '@elysium/domain/telephony';

import { emit } from '../../platform/events/outbox.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
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
 * id); otherwise a new row, its person found by the extension on it, its customer by the phone on
 * the customer's side (`ORDERS_API.buyerIdByPhone`), and its order the customer's newest open one.
 * Then its progress moves forward only (the trigger holds the same rule), and a recording on the
 * connection's own host is queued for download. Runs in the caller's transaction, under a lock on
 * the Envo call, and never calls Envo (invariant 6).
 */
@Injectable()
export class TelephonyIngestService {
  constructor(@Inject(ORDERS_API) private readonly orders: OrdersApi) {}

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
        ? undefined
        : await repo.assignmentOfExtension(tx, orgId, connection.id, extension);
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
      userId: assignee?.user_id ?? null,
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
    const current = call.status as PhoneCallStatus;
    const status = phoneCallStatusAfter(current, facts.event);
    if (status !== current) change.status = status;
    const ended = isPhoneCallOver(status) && status === 'ended';
    const answered = answeredAfter(call.answered, facts);
    if (answered !== call.answered) change.answered = answered;

    if (call.direction === 'unknown' && facts.direction !== 'unknown') {
      change.direction = facts.direction;
    }
    const wasEnded = current === 'ended';
    const from = storedNumber(facts.from);
    const to = storedNumber(facts.to);
    if (from !== null && from !== call.from_number && (!wasEnded || call.from_number === null)) {
      change.fromNumber = from;
    }
    if (to !== null && to !== call.to_number && (!wasEnded || call.to_number === null)) {
      change.toNumber = to;
    }
    if (facts.disposition !== null && facts.disposition !== call.disposition) {
      change.disposition = facts.disposition;
    }
    if (facts.talkSeconds !== null && facts.talkSeconds !== call.talk_seconds) {
      change.talkSeconds = facts.talkSeconds;
    }
    if (facts.durationSeconds !== null && facts.durationSeconds !== call.duration_seconds) {
      change.durationSeconds = facts.durationSeconds;
    }
    if (call.started_at === null) change.startedAt = facts.startedAt ?? now;
    if (call.answered_at === null && answered) {
      change.answeredAt = facts.answeredAt ?? now;
    }
    if (call.ended_at === null && ended) {
      change.endedAt =
        facts.endedAt ??
        (facts.startedAt !== null && facts.durationSeconds !== null
          ? new Date(facts.startedAt.getTime() + facts.durationSeconds * 1000)
          : now);
    }

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
    if (call.customer_id === null && customerPhone !== null) {
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
        const assignee = await repo.assignmentOfExtension(tx, orgId, connection.id, extension);
        change.extension = extension;
        if (assignee !== undefined) change.userId = assignee.user_id;
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
