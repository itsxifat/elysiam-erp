import { Inject, Injectable } from '@nestjs/common';
import type { CallAttemptInput } from '@elysium/contracts';
import type {
  PhoneCallAnsweredInput,
  PhoneCallListQuery,
  PhoneCallPlaceInput,
} from '@elysium/contracts/telephony';
import { withOrg, type Tx } from '@elysium/db';
import { isNormalizableBdPhone, maskPhone, normalizeBdPhone } from '@elysium/domain';
import { customerPhoneFrom, envoDialNumber, storedNumber } from '@elysium/domain/telephony';
import { sql, type SQL } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeHasNoRowDimension, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { MemoryRateLimiter } from '../../platform/http/rate-limit.js';
import { FILES_API, type FilesApi } from '../files/files.api.js';
import { IAM_API, type IamApi } from '../iam/iam.api.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { envoFailure, TelephonyConnectionsService } from './connections.service.js';
import { announce } from './ingest.service.js';
import type { EnvoGateway, EnvoLiveCall } from './providers/envo-gateway.js';
import { TELEPHONY_CONFIG, type TelephonyConfig } from './telephony.config.js';
import { mapTelephonyErrors, TelephonyError } from './telephony.errors.js';
import * as repo from './telephony.repository.js';
import { CALLING_ROLES } from './telephony.roles.js';
import { ENVO_GATEWAY } from './telephony.tokens.js';

export const RECORDING_PURPOSE = 'call-recording' as const;

/** A call's own scope (D-841): `own` is the person on it, or the order's owner when linked. */
const CALL_SCOPE = { createdBy: sql`c.user_id`, assignedTo: sql`c.order_owner_user_id` };

/** A second press within this long, to the same number, is the same call (D-834). */
const DOUBLE_PRESS_SECONDS = 20;

/** An inbound call answered in the browser is the newest from that number in these minutes. */
const ANSWERED_WINDOW_MS = 3 * 60_000;

/** A call ringing or answered this recently names its caller in the screen pop (D-843). */
const LIVE_LOOKUP_MS = 3 * 60_000;

/**
 * How often a claim may ask Envo's live calls, a minute: per person (the console's phone asks at
 * most four times for one answer) and per connection, so repeated claims cannot spend the
 * brand key's shared budget that Calls, the sync and Settings → Calls need (recheck N1).
 */
const CLAIMS_PER_PERSON_PER_MINUTE = 8;
const CLAIMS_PER_CONNECTION_PER_MINUTE = 30;

/** Envo's live states of a call that is talking: `talking` (bridged) or a channel `up`. */
const TALKING_STATES = new Set(['talking', 'up']);

/** Why the console's phone does not start for a person with an extension (D-843). */
export type PhoneNotReady =
  'switched_off' | 'no_key' | 'stand_in' | 'extension_off' | 'no_web_phone';

/** A double press found inside the transaction: undone, so M41's gate is not told twice. */
class RepeatedPress extends Error {
  constructor(readonly row: repo.CallRow) {
    super('the same call');
  }
}

const OPEN_STATUSES = new Set([
  'pending',
  'on_hold',
  'confirmed',
  'packed',
  'shipped',
  'return_in_transit',
  'exchange',
]);

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/** The start of an Asia/Dhaka calendar date, as an instant (invariant 8); a typed 400 if none. */
function dhakaDayStart(date: string): Date {
  const at = new Date(`${date}T00:00:00+06:00`);
  // A day the calendar has not (2026-13-01, 2026-02-30) is refused rather than rolled over.
  if (Number.isNaN(at.getTime()) || dhakaDateOf(at) !== date) {
    throw new TelephonyError('TELEPHONY_INVALID', `${date} is not a calendar date.`);
  }
  return at;
}

function dhakaDateOf(at: Date): string {
  return new Date(at.getTime() + 6 * 3600_000).toISOString().slice(0, 10);
}

type Names = ReadonlyMap<string, string>;

export function callView(row: repo.CallRow, names: Names) {
  const person = (id: string | null) => (id === null ? null : { id, name: names.get(id) ?? null });
  return {
    id: row.id,
    connectionId: row.connection_id,
    envoCallId: row.envo_call_id,
    firstSeen: row.first_seen,
    direction: row.direction,
    status: row.status,
    answered: row.answered,
    disposition: row.disposition,
    from: row.from_number,
    to: row.to_number,
    customerPhone: row.customer_phone_e164,
    extension: row.extension,
    person: person(row.user_id),
    customer: row.customer_id === null ? null : { id: row.customer_id, name: row.customer_name },
    order: row.order_id === null ? null : { id: row.order_id, orderNo: row.order_no ?? '' },
    orderOwner: person(row.order_owner_user_id),
    talkSeconds: row.talk_seconds,
    durationSeconds: row.duration_seconds,
    occurredAt: iso(row.occurred_at),
    requestedAt: iso(row.requested_at),
    startedAt: iso(row.started_at),
    answeredAt: iso(row.answered_at),
    endedAt: iso(row.ended_at),
    recording: {
      status: row.recording_status,
      playable: row.recording_status === 'stored',
      error: row.recording_error,
    },
    outcome: row.outcome,
    error: row.error_code === null ? null : { code: row.error_code, detail: row.error_detail },
  };
}

/**
 * Calling through Envo (M47, D-834 to D-845): a person's Call from their own extension, the call
 * log with its filters, a call's recording for the people who may hear it, recording a call's
 * verification outcome on its order, the browser's phone answering an incoming call, the caller's
 * customer and open orders, and the web phone's token. Envo is asked only after the transaction
 * that prepared the request has committed (invariant 6).
 */
@Injectable()
export class TelephonyCallsService {
  /** Per process, in memory: it guards Envo's budget, not an exact count across replicas. */
  private readonly claims = new MemoryRateLimiter();

  constructor(
    private readonly audit: AuditService,
    private readonly connections: TelephonyConnectionsService,
    @Inject(ENVO_GATEWAY) private readonly gateway: EnvoGateway,
    @Inject(TELEPHONY_CONFIG) private readonly config: TelephonyConfig,
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    @Inject(IAM_API) private readonly iam: IamApi,
    @Inject(FILES_API) private readonly files: FilesApi,
  ) {}

  private async names(tx: Tx, orgId: string): Promise<Names> {
    const members = await this.iam.activeMembers(tx, orgId);
    return new Map(members.map((member) => [member.userId, member.name]));
  }

  /**
   * The signed-in person's extension and its connection, or null (`TELEPHONY_NO_EXTENSION`). An
   * extension still given to someone who no longer places calls here (their role taken away,
   * D-846) is not theirs to use.
   */
  private async myPhone(tx: Tx, context: ActiveContext) {
    const assignment = await repo.assignmentOfUser(tx, context.orgId, context.userId);
    if (assignment === undefined) return null;
    const members = await this.iam.activeMembers(tx, context.orgId, { roles: CALLING_ROLES });
    if (!members.some((member) => member.userId === context.userId)) return null;
    const connection = await repo.connectionById(tx, context.orgId, assignment.connection_id);
    if (connection === undefined) return null;
    return { assignment, connection };
  }

  private noExtension(): TelephonyError {
    return new TelephonyError(
      'TELEPHONY_NO_EXTENSION',
      'You have no extension yet. A supervisor gives you one in Settings → Calls.',
    );
  }

  /**
   * The console's phone: whether this person has one, and where its widget comes from (D-843).
   * `ready` only when the web phone can start: the connection on with a key that opens, a real
   * Envo (not the stand-in, whose token Envo would refuse), and the extension enabled in Envo
   * with its web phone on (Envo's `webPhone`; a desk-phone extension calls through its desk
   * phone and has no web phone to start). Envo's extension list is read after the transaction
   * (cached ten seconds); when Envo cannot be asked, the phone tries and says what happened.
   */
  async me(context: ActiveContext, request: object) {
    scopeHasNoRowDimension(request, 'the caller’s own extension, by their user id');
    return mapTelephonyErrors(async () => {
      const mine = await withOrg({ orgId: context.orgId, userId: context.userId }, (tx) =>
        this.myPhone(tx, context),
      );
      if (mine === null) return { phone: null };
      const notReady = await this.phoneNotReady(mine, context.orgId);
      return {
        phone: {
          connectionId: mine.connection.id,
          connectionName: mine.connection.name,
          extension: mine.assignment.extension,
          baseUrl: mine.connection.base_url,
          ready: notReady === null,
          notReady,
        },
      };
    });
  }

  private async phoneNotReady(
    mine: { readonly assignment: repo.AssignmentRow; readonly connection: repo.ConnectionRow },
    orgId: string,
  ): Promise<PhoneNotReady | null> {
    if (!mine.connection.enabled) return 'switched_off';
    if (mine.connection.api_key_fingerprint === null) return 'no_key';
    if (this.gateway.provider === 'fake') return 'stand_in';
    let envo;
    try {
      envo = this.connections.open(mine.connection, orgId, { requireEnabled: true });
    } catch {
      return 'no_key';
    }
    const listed = await this.connections.extensionInEnvo(
      mine.connection.id,
      envo,
      mine.assignment.extension,
    );
    if (listed === 'unknown') return null;
    if (listed?.enabled !== true) return 'extension_off';
    return listed.webPhone ? null : 'no_web_phone';
  }

  /**
   * A web phone token for the caller's own extension only (D-843): Envo's
   * `POST /api/v1/webphone/token`, short-lived. The answer has `token` at its top, as the widget's
   * `tokenUrl` expects, and the API key never leaves the server.
   */
  async phoneToken(context: ActiveContext, request: object) {
    scopeHasNoRowDimension(request, 'a token for the caller’s own extension');
    return mapTelephonyErrors(async () => {
      const mine = await withOrg({ orgId: context.orgId, userId: context.userId }, (tx) =>
        this.myPhone(tx, context),
      );
      if (mine === null) throw this.noExtension();
      const envo = this.connections.open(mine.connection, context.orgId, { requireEnabled: true });
      try {
        const token = await this.gateway.webphoneToken(envo, {
          extension: mine.assignment.extension,
          ttlSeconds: this.config.TELEPHONY_PHONE_TOKEN_TTL_SECONDS,
        });
        return {
          token: token.token,
          extension: token.extension,
          expiresAt: token.expiresAt,
          baseUrl: mine.connection.base_url,
          sipDomain: token.sipDomain,
        };
      } catch (error) {
        throw envoFailure(error);
      }
    });
  }

  /**
   * Call a customer from your own extension (D-834): Envo rings your phone, then dials them. The
   * call is written first (`requested`), with the order and customer it is about, so Envo's
   * webhooks land on them (D-835); Envo is asked after that commits, with no retry (a retried
   * originate could ring you twice), and the row moves to `dialing` or `failed` with the reason.
   */
  async place(context: ActiveContext, request: AuditableRequest, input: PhoneCallPlaceInput) {
    return mapTelephonyErrors(async () => {
      assertInScope(request, { createdBy: context.userId });
      let prepared;
      try {
        prepared = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
          await repo.lockPersonCalls(tx, context.orgId, context.userId);
          const mine = await this.myPhone(tx, context);
          if (mine === null) throw this.noExtension();
          const envo = this.connections.open(mine.connection, context.orgId, {
            requireEnabled: true,
          });
          const target = await this.target(tx, context, request, input);
          const again = await repo.recentClick(
            tx,
            context.orgId,
            context.userId,
            target.phone,
            DOUBLE_PRESS_SECONDS,
          );
          // Undone, not committed: M41's gate wrote its notice to the owner for the first press.
          if (again !== undefined) throw new RepeatedPress(again);
          const row = await repo.insertCall(tx, {
            orgId: context.orgId,
            connectionId: mine.connection.id,
            envoCallId: null,
            firstSeen: 'click',
            direction: 'outbound',
            status: 'requested',
            fromNumber: mine.assignment.extension,
            toNumber: target.phone,
            customerPhoneE164: target.phone,
            extension: mine.assignment.extension,
            userId: context.userId,
            customerId: target.customerId,
            customerName: target.customerName,
            orderId: target.order?.id ?? null,
            orderNo: target.order?.orderNo ?? null,
            orderOwnerUserId: target.order?.assignedTo ?? null,
            occurredAt: new Date(),
            requestedAt: new Date(),
          });
          await this.audit.record(tx, {
            orgId: context.orgId,
            actorUserId: context.userId,
            operation: 'create',
            action: 'phone_call.requested',
            entityType: 'phone_call',
            entityId: row.id,
            after: {
              connectionId: mine.connection.id,
              extension: mine.assignment.extension,
              dialled: maskPhone(target.phone),
              orderId: target.order?.id ?? null,
              customerId: target.customerId,
            },
            requestId: context.requestId,
            request,
          });
          await announce(tx, context.orgId, row);
          return { row, mine, envo, target };
        });
      } catch (error) {
        if (error instanceof RepeatedPress) {
          return { call: callView(error.row, new Map()), repeated: true };
        }
        throw error;
      }

      let failure: TelephonyError | null = null;
      try {
        await this.gateway.originate(prepared.envo, {
          from: prepared.mine.assignment.extension,
          to: envoDialNumber(prepared.target.phone),
        });
      } catch (error) {
        failure = envoFailure(error);
      }
      const row = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const current = await repo.callById(tx, context.orgId, prepared.row.id, { lock: true });
        if (current === undefined) throw new Error('the call disappeared');
        // A webhook may already have named and moved it (Envo is quick): leave it be.
        if (current.status !== 'requested') return current;
        const moved = await repo.updateCall(
          tx,
          context.orgId,
          current.id,
          failure === null
            ? { status: 'dialing' }
            : {
                status: 'failed',
                errorCode:
                  failure.code === 'TELEPHONY_ENVO_REFUSED' ? 'envo_refused' : 'envo_unreachable',
                errorDetail: failure.message.slice(0, 300),
                endedAt: new Date(),
              },
        );
        await announce(tx, context.orgId, moved);
        return moved;
      });
      if (failure !== null) throw failure;
      return { call: callView(row, new Map()), repeated: false };
    });
  }

  /** Whom a Call rings: an order's buyer (or its recipient), a customer, or a phone. */
  private async target(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    input: PhoneCallPlaceInput,
  ): Promise<{
    readonly phone: string;
    readonly customerId: string | null;
    readonly customerName: string | null;
    readonly order: {
      readonly id: string;
      readonly orderNo: string;
      readonly assignedTo: string | null;
    } | null;
  }> {
    const given = input.phone === undefined ? null : this.mobile(input.phone);
    if (input.orderId !== undefined) {
      // M41's lock and owner gate (D-710): a colleague's order needs `x-acknowledge-owner: 1`.
      const order = await this.orders.phoneCallTarget(tx, context, request, input.orderId);
      const phone = given ?? order.customerPhoneE164;
      if (phone !== order.customerPhoneE164 && phone !== order.recipientPhoneE164) {
        throw new TelephonyError(
          'TELEPHONY_NUMBER_INVALID',
          `That number is not the buyer’s or the recipient’s on order ${order.orderNo}.`,
        );
      }
      const panel = await this.orders.customerPanel(
        tx,
        context.orgId,
        order.customerId,
        0,
        context,
      );
      return {
        phone,
        customerId: order.customerId,
        customerName: panel?.name ?? null,
        order: { id: order.orderId, orderNo: order.orderNo, assignedTo: order.assignedTo },
      };
    }
    if (input.customerId !== undefined) {
      const reachable = await this.orders.customerReachable(
        tx,
        context.orgId,
        input.customerId,
        context,
      );
      const panel = reachable
        ? await this.orders.customerPanel(tx, context.orgId, input.customerId, 0, context)
        : undefined;
      if (panel === undefined) throw new TelephonyError('TELEPHONY_NOT_FOUND', 'No such customer.');
      if (given !== null && given !== panel.phoneE164) {
        throw new TelephonyError('TELEPHONY_NUMBER_INVALID', 'That is not this customer’s number.');
      }
      return {
        phone: panel.phoneE164,
        customerId: panel.id,
        customerName: panel.name,
        order: null,
      };
    }
    if (given === null) {
      throw new TelephonyError('TELEPHONY_NUMBER_INVALID', 'Say whom to call.');
    }
    // A phone alone names its buyer on the call only for a person who may open that buyer
    // (D-740, as the inbox links a typed phone): the Call button is no phone-to-buyer lookup.
    // Envo's webhooks never add a buyer to a click later (`TelephonyIngestService.progress`).
    const found = (await this.orders.buyerIdByPhone(tx, context.orgId, given)) ?? null;
    const reachable =
      found !== null && (await this.orders.customerReachable(tx, context.orgId, found, context));
    const panel = reachable
      ? await this.orders.customerPanel(tx, context.orgId, found, 0, context)
      : undefined;
    return {
      phone: given,
      customerId: panel === undefined ? null : found,
      customerName: panel?.name ?? null,
      order: null,
    };
  }

  private mobile(raw: string): string {
    if (!isNormalizableBdPhone(raw)) {
      throw new TelephonyError(
        'TELEPHONY_NUMBER_INVALID',
        `"${maskPhone(raw)}" is not a Bangladeshi mobile number.`,
      );
    }
    return normalizeBdPhone(raw);
  }

  /** The call log (D-845), newest first, in the caller's scope. */
  async list(context: ActiveContext, request: object, query: PhoneCallListQuery) {
    return mapTelephonyErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const scope = scopeWhere(request, CALL_SCOPE);
        let cursor: { occurredAt: string; id: string } | undefined;
        if (query.cursor !== undefined) {
          const [at, id] = query.cursor.split('|');
          if (
            at === undefined ||
            id === undefined ||
            Number.isNaN(new Date(at).getTime()) ||
            !/^[0-9a-f-]{36}$/i.test(id)
          ) {
            throw new TelephonyError('TELEPHONY_INVALID', 'That page marker is not valid.');
          }
          cursor = { occurredAt: new Date(at).toISOString(), id };
        }
        const phone = query.phone;
        const rows = await repo.listCalls(
          tx,
          context.orgId,
          {
            ...(query.from === undefined ? {} : { from: dhakaDayStart(query.from) }),
            ...(query.to === undefined
              ? {}
              : { to: new Date(dhakaDayStart(query.to).getTime() + 86_400_000) }),
            ...(query.userId === undefined ? {} : { userId: query.userId }),
            ...(query.direction === undefined ? {} : { direction: query.direction }),
            ...(query.answered === undefined ? {} : { answered: query.answered === 'answered' }),
            ...(query.orderNo === undefined ? {} : { orderNo: query.orderNo }),
            ...(query.orderId === undefined ? {} : { orderId: query.orderId }),
            ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
            ...(phone === undefined
              ? {}
              : isNormalizableBdPhone(phone)
                ? { phoneE164: normalizeBdPhone(phone) }
                : { phoneRaw: storedNumber(phone) ?? phone }),
            ...(cursor === undefined ? {} : { cursor }),
            limit: query.limit + 1,
          },
          scope,
        );
        const names = await this.names(tx, context.orgId);
        const page = rows.slice(0, query.limit);
        const last = page[page.length - 1];
        return {
          items: page.map((row) => callView(row, names)),
          nextCursor:
            rows.length > query.limit && last !== undefined
              ? `${new Date(last.occurred_at).toISOString()}|${last.id}`
              : null,
        };
      }),
    );
  }

  async one(context: ActiveContext, request: object, id: string) {
    return mapTelephonyErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const row = await repo.callById(tx, context.orgId, id, {
          scope: scopeWhere(request, CALL_SCOPE),
        });
        if (row === undefined) throw new TelephonyError('TELEPHONY_NOT_FOUND', 'No such call.');
        return callView(row, await this.names(tx, context.orgId));
      }),
    );
  }

  /**
   * A call's recording (D-841), to a person who may see the call: the bytes, read from the files
   * storage with no transaction open (invariant 6).
   */
  async recording(context: ActiveContext, request: object, id: string) {
    return mapTelephonyErrors(async () => {
      const row = await withOrg({ orgId: context.orgId, userId: context.userId }, (tx) =>
        repo.callById(tx, context.orgId, id, { scope: scopeWhere(request, CALL_SCOPE) }),
      );
      if (row === undefined) throw new TelephonyError('TELEPHONY_NOT_FOUND', 'No such call.');
      if (row.recording_status !== 'stored' || row.recording_file_id === null) {
        throw new TelephonyError(
          'TELEPHONY_RECORDING_UNAVAILABLE',
          row.recording_status === 'pending'
            ? 'The recording is still coming from Envo.'
            : row.recording_status === 'expired'
              ? 'The recording was deleted when its retention ran out.'
              : 'This call has no recording kept here.',
        );
      }
      const bytes = await this.files.storedBytes(
        context.orgId,
        row.recording_file_id,
        RECORDING_PURPOSE,
      );
      if (bytes === null) {
        throw new TelephonyError(
          'TELEPHONY_RECORDING_UNAVAILABLE',
          'This call has no recording kept here.',
        );
      }
      return { ...bytes, envoCallId: row.envo_call_id };
    });
  }

  /**
   * The verification outcome of a call about an order (D-838): M41's attempt, through the orders
   * module with its lock, its owner gate and its audit row, in the same transaction that marks
   * the call's outcome. Once per call.
   */
  async outcome(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    input: CallAttemptInput,
  ) {
    return mapTelephonyErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const row = await repo.callById(tx, context.orgId, id, {
          lock: true,
          scope: scopeWhere(request, CALL_SCOPE),
        });
        if (row === undefined) throw new TelephonyError('TELEPHONY_NOT_FOUND', 'No such call.');
        if (row.order_id === null) {
          throw new TelephonyError(
            'TELEPHONY_OUTCOME_INVALID',
            'This call is not about an order, so there is no verification to record.',
          );
        }
        if (row.outcome !== null) {
          throw new TelephonyError(
            'TELEPHONY_OUTCOME_INVALID',
            'This call’s outcome is already recorded.',
          );
        }
        const attempt = await this.orders.recordPhoneCallOutcome(
          tx,
          context,
          request,
          row.order_id,
          input,
        );
        const moved = await repo.updateCall(tx, context.orgId, row.id, {
          outcomeAttemptId: attempt.attemptId,
          outcome: attempt.outcome,
        });
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'phone_call.outcome_recorded',
          entityType: 'phone_call',
          entityId: row.id,
          after: { orderId: row.order_id, attemptId: attempt.attemptId, outcome: attempt.outcome },
          requestId: context.requestId,
          request,
        });
        await announce(tx, context.orgId, moved);
        return callView(moved, await this.names(tx, context.orgId));
      }),
    );
  }

  /**
   * The browser's phone answered an incoming call from this number (D-836). Envo's webhooks do
   * not say which extension answered, so the newest inbound call from it on the person's
   * connection that nobody has yet becomes theirs, when:
   *
   * - it is still going here (ringing or answered, not ended): an earlier, missed call from the
   *   same number is never taken for the one picked up now (404 until Envo's `call.started` is
   *   in, which the console's phone asks again for);
   * - Envo shows it talking right now, with the person's own phone among its channels (Envo
   *   names a phone `<extension>_<SIP server>`, its web phone with `_web`): after the answer
   *   Asterisk keeps only the answering phone's channel, so a ring-group colleague who did not
   *   pick up cannot take the call and its recording. A call whose channels name no phone of
   *   the person's (still in an IVR, a queue or music on hold, its only channel the trunk's; or
   *   an Envo whose SIP usernames are not `<extension>_…`) stays nobody's, as a desk phone's
   *   answer does: a supervisor sees it.
   *
   * Envo is asked between two short transactions, never inside one (invariant 6), and at most
   * eight times a minute per person and thirty per connection (`RATE_LIMITED` past that).
   */
  async answered(context: ActiveContext, request: AuditableRequest, input: PhoneCallAnsweredInput) {
    return mapTelephonyErrors(async () => {
      const raw = storedNumber(input.from);
      if (raw === null) throw new TelephonyError('TELEPHONY_NUMBER_INVALID', 'That is no number.');
      const phone = { e164: customerPhoneFrom(input.from), raw };
      const since = () => new Date(Date.now() - ANSWERED_WINDOW_MS);
      const found = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const mine = await this.myPhone(tx, context);
        if (mine === null) throw this.noExtension();
        const call = await repo.unclaimedInbound(
          tx,
          context.orgId,
          mine.connection.id,
          phone,
          since(),
          { lock: false },
        );
        return { mine, call };
      });
      if (found.call?.envo_call_id == null) {
        throw new TelephonyError('TELEPHONY_NOT_FOUND', 'Envo has not announced that call yet.');
      }
      const envoCallId = found.call.envo_call_id;
      const person = this.claims.hit(
        `person:${context.orgId}:${context.userId}`,
        CLAIMS_PER_PERSON_PER_MINUTE,
        60,
      );
      const line = person.allowed
        ? this.claims.hit(
            `connection:${found.mine.connection.id}`,
            CLAIMS_PER_CONNECTION_PER_MINUTE,
            60,
          )
        : person;
      if (!line.allowed) {
        throw new TelephonyError(
          'RATE_LIMITED',
          'Envo was asked about answered calls too often. Wait a minute and try again.',
        );
      }
      let live: readonly EnvoLiveCall[];
      try {
        live = await this.gateway.liveCalls(
          this.connections.open(found.mine.connection, context.orgId, { requireEnabled: true }),
        );
      } catch (error) {
        throw error instanceof TelephonyError ? error : envoFailure(error);
      }
      const now = live.find((call) => call.id === envoCallId);
      if (now === undefined || !TALKING_STATES.has(now.state)) {
        throw new TelephonyError(
          'TELEPHONY_NOT_FOUND',
          'Envo does not show that call as answered right now.',
        );
      }
      if (!answeredOn(now, found.mine.assignment.extension)) {
        throw new TelephonyError('TELEPHONY_NOT_FOUND', 'Envo does not show your phone on that call.');
      }
      return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const call = await repo.unclaimedInbound(
          tx,
          context.orgId,
          found.mine.connection.id,
          phone,
          since(),
          { lock: true },
        );
        if (call === undefined || call.id !== found.call?.id) {
          throw new TelephonyError('TELEPHONY_NOT_FOUND', 'Someone else has that call now.');
        }
        const moved = await repo.updateCall(tx, context.orgId, call.id, {
          userId: context.userId,
          ...(call.extension === null ? { extension: found.mine.assignment.extension } : {}),
        });
        assertInScope(request, { createdBy: context.userId });
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'phone_call.answered_here',
          entityType: 'phone_call',
          entityId: call.id,
          after: { extension: found.mine.assignment.extension },
          requestId: context.requestId,
          request,
        });
        await announce(tx, context.orgId, moved);
        return callView(moved, await this.names(tx, context.orgId));
      });
    });
  }

  /**
   * Who is calling (the screen pop, D-843): the customer a number names, with their open orders
   * the caller may open, and whether it is the ring-back of the caller's own Call (Envo rings
   * the person first, showing the customer's number) so the phone may answer it at once.
   *
   * The buyer is named only to a person who may open them (D-740, as the order desk's lookup and
   * the inbox's panel), or whose phone that number is on right now: the ring-back of their own
   * Call, or an inbound call on their connection still ringing or answered. Any other number is
   * answered as nobody's, so the route is no phone-to-buyer lookup. Sent as a POST, so the
   * number stays out of URLs and access logs (invariant 10).
   */
  async lookup(context: ActiveContext, request: object, rawPhone: string) {
    scopeHasNoRowDimension(request, 'the caller’s own incoming call, by its number');
    return mapTelephonyErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const phone = customerPhoneFrom(rawPhone);
        if (phone === null) return { phone: null, customer: null, openOrders: [], ringBack: null };
        const ringBackRow = await repo.recentClick(tx, context.orgId, context.userId, phone, 90);
        const ringBack =
          ringBackRow === undefined
            ? null
            : {
                callId: ringBackRow.id,
                order:
                  ringBackRow.order_id === null
                    ? null
                    : { id: ringBackRow.order_id, orderNo: ringBackRow.order_no ?? '' },
              };
        const customerId = await this.orders.buyerIdByPhone(tx, context.orgId, phone);
        if (customerId === undefined) return { phone, customer: null, openOrders: [], ringBack };
        const reachable = await this.orders.customerReachable(
          tx,
          context.orgId,
          customerId,
          context,
        );
        // The ring-back of the person's own Call names its buyer when the Call did (an order or
        // a buyer they may reach); a Call to a bare number did not, and does not here either. A
        // click's buyer is the one written with it: Envo's webhooks never add one to a click.
        const ownCall = ringBackRow?.customer_id === customerId;
        if (!reachable && !ownCall) {
          const mine = await this.myPhone(tx, context);
          const ringing =
            mine !== null &&
            (await repo.liveInboundFrom(
              tx,
              context.orgId,
              mine.connection.id,
              { e164: phone, raw: phone },
              new Date(Date.now() - LIVE_LOOKUP_MS),
              context.userId,
            )) !== undefined;
          if (!ringing) return { phone, customer: null, openOrders: [], ringBack };
        }
        const panel = await this.orders.customerPanel(tx, context.orgId, customerId, 10, context);
        if (panel === undefined) return { phone, customer: null, openOrders: [], ringBack };
        return {
          phone,
          customer: {
            id: panel.id,
            name: panel.name,
            reachable,
            ...(reachable
              ? {
                  orders: panel.orders,
                  delivered: panel.delivered,
                  returned: panel.returned,
                  cancelled: panel.cancelled,
                }
              : {}),
          },
          openOrders: panel.recentOrders
            .filter((order) => OPEN_STATUSES.has(order.status))
            .map((order) => ({
              id: order.id,
              orderNo: order.orderNo,
              status: order.status,
              codAmountPoisha: order.codAmountPoisha,
              createdAt: order.createdAt.toISOString(),
            })),
          ringBack,
        };
      }),
    );
  }
}

/**
 * Whether Envo's live call shows this extension's own phone among its channels. Envo names an
 * extension's endpoints `<number>_<SIP server slug>` and its web phone `<that>_web`
 * (`createExtension`, `webEndpoint`); a trunk's endpoint has another name. No phone of this
 * extension's, no claim: a call ringing in an IVR or a queue is `up` with only the trunk's
 * channel, and must not become whoever asks first (recheck W2).
 */
export function answeredOn(call: EnvoLiveCall, extension: string): boolean {
  return call.endpoints.some((endpoint) => endpoint.startsWith(`${extension}_`));
}

/** For a route that filters calls by a column outside the call's own scope. */
export function callScopeSql(request: object): SQL {
  return scopeWhere(request, CALL_SCOPE);
}
