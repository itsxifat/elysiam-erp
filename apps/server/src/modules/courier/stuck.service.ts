import { Inject, Injectable, Logger } from '@nestjs/common';
import { withGlobal, withOrg, type Tx } from '@elysium/db';
import { maskPhonesInText } from '@elysium/domain';
import {
  assertStuckThreshold,
  calendarDaysSince,
  courierHadParcel,
  courierStatusMap,
  isTerminalParcelStatus,
  NOT_RECEIVED_HOURS,
  notReceivedByCourier,
  STUCK_THRESHOLD_DAYS,
  stuckCutoffDate,
  type ParcelStatus,
} from '@elysium/domain/courier';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeWhere } from '../../platform/auth/scope.js';
import { emit } from '../../platform/events/outbox.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { CourierError } from './courier.errors.js';
import { COURIER_QUEUES, type RepollPayload } from './courier.queues.js';
import * as repo from './courier.repository.js';
import { IAM_API, type IamApi } from '../iam/iam.api.js';
import { ORDERS_PORT, type OrdersPort } from './ports/orders.port.js';
import { CourierSyncService } from './sync.service.js';

/**
 * The stuck-parcel queue (M15: "active consignments with no status change in N days, with
 * bulk re-poll, an escalation note and a courier-ready export. This is where COD cash
 * actually goes missing").
 *
 * ## Five reasons, each named on the row
 *
 * - **`no_status_change`** — with the courier, not finished, and the status has not changed
 *   for N or more Asia/Dhaka calendar days. The rider who delivered and did not report, the
 *   hub that lost the parcel.
 * - **`unknown_status`** — the courier's latest word on an active parcel mapped to `unknown`:
 *   a word no mapping table knows, or one a map sends to `unknown` on purpose (Pathao's
 *   exchange and payment notices). Listed **immediately**, not after N days: an unmapped word
 *   is how a parcel the courier has delivered sits at `shipped` with its COD unbooked, and it
 *   is the one failure the mapping tests cannot catch because the word did not exist when they
 *   were written. On a finished parcel such words change nothing and list nothing.
 * - **`unposted_delivery`** — the courier reports the parcel delivered and no delivery was
 *   booked: a partial delivery with no collected figure, or a delivery that reached an order
 *   not at `shipped`. Listed at once; the manual status route, with the figure, settles it.
 * - **`return_not_received`** — the courier says it returned the parcel, and the warehouse
 *   has not received it within the threshold.
 * - **`booking_failed`** — every booking attempt spent, or a refusal no retry could change.
 *   The parcel never reached a courier; nothing moves until somebody rebooks it. This is also
 *   where M12's "flag the order" is visible: the flag lives on the consignment, and this queue
 *   is the operational view of it.
 * - **`not_received`** (D-903) — we handed the parcel over (the order shipped) the brand's
 *   hours ago or more (five unless Settings → Order workflow says otherwise), and the courier
 *   still says nothing that proves it has it: Steadfast's `in_review`, never `pending`. The
 *   rider never reached the hub with it. Hours, not days: it is found the same afternoon. The
 *   sweep (`delivery.not_received_sweep`) tells the supervisors once per parcel.
 *
 * Row scope: §6's branch narrowing on the parcel's branch, plus "own" mapped onto the person
 * who queued the booking — the nearest thing a consignment has to an owner. A sales agent
 * sees the parcels they booked.
 */

export type StuckReason =
  | 'no_status_change'
  | 'unknown_status'
  | 'booking_failed'
  | 'unposted_delivery'
  | 'return_not_received'
  | 'not_received';

export interface StuckParcel {
  readonly consignmentId: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly courierId: string;
  readonly courierName: string;
  readonly branchId: string | null;
  readonly consignmentNo: string | null;
  readonly trackingCode: string | null;
  readonly status: string;
  readonly rawStatus: string | null;
  readonly lastEventRawStatus: string | null;
  readonly lastEventAt: string | null;
  readonly bookingState: string;
  readonly bookingFailureCode: string | null;
  readonly codAmountPoisha: string;
  /** Asia/Dhaka date the status last changed. */
  readonly statusSince: string;
  readonly daysStuck: number;
  readonly lastPolledAt: string | null;
  readonly reasons: readonly StuckReason[];
  readonly escalationCount: number;
  readonly lastEscalationNote: string | null;
  readonly lastEscalationAt: string | null;
  /** D-903: when we handed it to the courier (the order shipped); null before. */
  readonly handedOverAt: string | null;
}

/** Scope columns for a consignment row. See the class comment for "own". */
function consignmentScope(request: object) {
  return scopeWhere(request, {
    branchId: sql`c.branch_id`,
    createdBy: sql`c.created_by`,
    // A consignment has no assignee; a clause on it matches nothing rather than everything.
    assignedTo: sql`null::text`,
  });
}

/**
 * How many parcels one sweep asks a courier about per brand (D-903); the rest wait 15 minutes.
 * At most 20 courier questions of 15 s each stay inside the job's 14 minutes.
 */
const NOT_RECEIVED_BATCH = 20;

/** A branch manager and the branches their role reaches (empty: the whole brand). */
export interface BranchManager {
  readonly userId: string;
  readonly branchIds: readonly string[];
}

/**
 * The branch managers a parcel's alert reaches (D-903): those whose role covers its branch, and
 * those whose role reaches the whole brand. A parcel of no branch reaches only the latter, as the
 * stuck queue's branch scope shows it only to them (§6).
 */
export function managersFor(managers: readonly BranchManager[], branchId: string | null): string[] {
  const ids = managers
    .filter(
      (manager) =>
        manager.branchIds.length === 0 ||
        (branchId !== null && manager.branchIds.includes(branchId)),
    )
    .map((manager) => manager.userId);
  return [...new Set(ids)];
}

@Injectable()
export class StuckParcelsService {
  private readonly logger = new Logger(StuckParcelsService.name);

  constructor(
    @Inject(ORDERS_PORT) private readonly orders: OrdersPort,
    private readonly audit: AuditService,
    // D-903: the sweep asks the courier before it judges, and tells the people who can act.
    private readonly sync: CourierSyncService,
    @Inject(IAM_API) private readonly iam: IamApi,
  ) {}

  async list(
    context: ActiveContext,
    request: object,
    options: { thresholdDays?: number | undefined; courierId?: string | undefined },
    now: Date = new Date(),
  ): Promise<{
    thresholdDays: number;
    cutoffDate: string;
    notReceivedHours: number;
    items: readonly StuckParcel[];
  }> {
    const thresholdDays = options.thresholdDays ?? STUCK_THRESHOLD_DAYS.default;
    try {
      assertStuckThreshold(thresholdDays);
    } catch (error) {
      throw new CourierError(
        'CONSIGNMENT_INVALID',
        error instanceof Error ? error.message : 'That threshold is out of range.',
      );
    }
    const cutoffDate = stuckCutoffDate(now, thresholdDays);
    const branchWhere = consignmentScope(request);

    // The rows and their couriers' names in one transaction: the names belong to M10,
    // which owns `sales.couriers`, so they are asked for rather than joined (invariant 12).
    const { rows, courierNames, hours } = await withOrg(
      { orgId: context.orgId, userId: context.userId },
      async (tx) => {
        const hours =
          (await repo.notReceivedHoursSetting(tx, context.orgId)) ?? NOT_RECEIVED_HOURS.default;
        const found = await repo.stuckCandidates(tx, context.orgId, {
          cutoffDate,
          courierId: options.courierId,
          branchWhere,
          limit: 500,
        });
        const parties = await this.orders.courierParties(
          tx,
          context.orgId,
          found.map((row) => row.courier_id),
        );
        return {
          rows: found,
          courierNames: new Map(parties.map((party) => [party.id, party.name])),
          hours,
        };
      },
    );

    const items: StuckParcel[] = [];
    for (const row of rows) {
      const reasons = reasonsFor(row, cutoffDate);
      if (reasons.length === 0) continue;
      const since = new Date(row.since_at);
      items.push({
        consignmentId: row.id,
        orderId: row.order_id,
        orderNo: row.order_no,
        courierId: row.courier_id,
        courierName: courierNames.get(row.courier_id) ?? '',
        branchId: row.branch_id,
        consignmentNo: row.consignment_no,
        trackingCode: row.tracking_code,
        status: row.status,
        rawStatus: row.raw_status,
        lastEventRawStatus: row.last_event_raw,
        lastEventAt: row.last_event_at,
        bookingState: row.booking_state,
        bookingFailureCode: row.booking_failure_code,
        codAmountPoisha: row.cod_amount_poisha,
        statusSince: row.since_on,
        daysStuck: calendarDaysSince(since, now),
        lastPolledAt: row.last_polled_at,
        reasons,
        escalationCount: row.escalation_count,
        lastEscalationNote: row.last_escalation_note,
        lastEscalationAt: row.last_escalation_at,
        handedOverAt:
          row.handed_over_at === null ? null : new Date(row.handed_over_at).toISOString(),
      });
    }

    return { thresholdDays, cutoffDate, notReceivedHours: hours, items };
  }

  /**
   * D-903, every quarter hour (`delivery.not_received_sweep`): each brand's parcels handed over
   * its hours ago with no word yet of the courier having them. Each is asked about first (one
   * poll, no transaction open, invariant 6), so a stale stored word never raises the alarm: a
   * courier that does not answer leaves the parcel for the next sweep, and one that now says it
   * has the parcel ends it. A parcel still not received (`notReceivedByCourier`, reading every
   * word the courier ever gave through today's vocabulary) is flagged once: an automatic
   * escalation note (`NOT_RECEIVED_BY`), which is also what lists it in the queue, an audit row,
   * and `parcel.not_received` for the org admins and the branch managers whose branches cover it.
   * A brand that fails is logged and the others are swept.
   */
  async sweepNotReceived(now: Date = new Date()): Promise<number> {
    const orgIds = await withGlobal(async (tx) =>
      (
        await tx.execute<{ id: string }>(
          sql`select id from org.organizations where is_active order by slug`,
        )
      ).map((row) => row.id),
    );
    let flagged = 0;
    for (const orgId of orgIds) {
      try {
        flagged += await this.sweepBrand(orgId, now);
      } catch (error) {
        this.logger.warn(
          `not-received sweep of org ${orgId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return flagged;
  }

  private async sweepBrand(orgId: string, now: Date): Promise<number> {
    const actor = { orgId, userId: repo.NOT_RECEIVED_BY };
    const { hours, candidates } = await withOrg(actor, async (tx) => {
      const hours = (await repo.notReceivedHoursSetting(tx, orgId)) ?? NOT_RECEIVED_HOURS.default;
      const candidates = await repo.notReceivedCandidates(
        tx,
        orgId,
        new Date(now.getTime() - hours * 3_600_000),
        NOT_RECEIVED_BATCH,
      );
      return { hours, candidates };
    });
    let flagged = 0;
    let managers: readonly BranchManager[] | undefined;
    for (const candidate of candidates) {
      try {
        // The courier's word now, not the one stored: outside any transaction.
        const asked = await this.sync.pollConsignment(orgId, candidate.id);
        if (asked === 'failed') continue;
        const done = await withOrg(actor, async (tx) => {
          const facts = await repo.notReceivedFacts(tx, orgId, candidate.id);
          if (facts === undefined || facts.flagged) return false;
          const status = facts.status as ParcelStatus;
          const missing = notReceivedByCourier({
            bookingState: facts.booking_state,
            status,
            handedOverAt:
              facts.handover_confirmed_at === null ? null : new Date(facts.handover_confirmed_at),
            courierHadIt: courierHadParcel({
              status,
              map: courierStatusMap(candidate.provider_code),
              events: facts.events,
            }),
            now,
            hours,
          });
          if (!missing) return false;
          const said =
            asked === 'unknown'
              ? 'it has no such parcel'
              : facts.raw_status === null
                ? 'nothing yet'
                : `"${facts.raw_status}"`;
          const saved = await repo.insertEscalation(tx, {
            orgId,
            consignmentId: candidate.id,
            note: `Not received by the courier: handed over ${String(hours)} or more hours ago, and the courier says ${said}.`,
            createdBy: repo.NOT_RECEIVED_BY,
          });
          await this.audit.record(tx, {
            orgId,
            actorUserId: null,
            operation: 'create',
            action: 'courier.parcel.not_received',
            entityType: 'Order',
            entityId: candidate.order_id,
            before: null,
            after: { consignmentId: candidate.id, escalationId: saved.id, hours },
          });
          managers ??= await this.branchManagers(tx, orgId);
          await emit(
            tx,
            'parcel.not_received',
            {
              consignmentId: candidate.id,
              orderId: candidate.order_id,
              userIds: managersFor(managers, candidate.branch_id),
            },
            { orgId },
          );
          return true;
        });
        if (done) flagged += 1;
      } catch (error) {
        // One parcel that cannot be judged (an order its courier's word cannot move, say) leaves
        // the rest of the brand's batch to be swept (D-903's audit, W2).
        this.logger.warn(
          `not-received sweep of a parcel of org ${orgId} failed: ${maskPhonesInText(error instanceof Error ? error.message : String(error))}`,
        );
      }
    }
    return flagged;
  }

  /**
   * The brand's branch managers and the branches their role reaches (empty: the whole brand),
   * so a parcel's alert reaches only those whose stuck queue will show it (§6's branch scope).
   */
  private async branchManagers(tx: Tx, orgId: string): Promise<readonly BranchManager[]> {
    const members = await this.iam.activeMembers(tx, orgId, { roles: ['branch_manager'] });
    const found: BranchManager[] = [];
    for (const member of members) {
      const scopes = await this.iam.roleScopes(tx, orgId, member.userId);
      for (const scope of scopes) {
        if (scope.role === 'branch_manager')
          found.push({ userId: member.userId, branchIds: scope.branchIds });
      }
    }
    return found;
  }

  /**
   * The queue as a CSV a courier's support desk can work from.
   *
   * Their number first, then ours, the status they last gave, since when, and the COD. No
   * recipient name, phone or address: the courier already has them against its own number,
   * and a file that is emailed to a third party is exactly where invariant 10 is easiest to
   * break. Amounts are taka with two decimals, from integer poisha, never through a float.
   */
  async exportCsv(
    context: ActiveContext,
    request: object,
    options: { thresholdDays?: number | undefined; courierId?: string | undefined },
    now: Date = new Date(),
  ): Promise<{ filename: string; csv: string }> {
    const { items, cutoffDate } = await this.list(context, request, options, now);
    const header = [
      'consignment_no',
      'tracking_code',
      'our_reference',
      'courier',
      'last_status',
      'status_since',
      'days_without_change',
      'cod_amount_taka',
      'reason',
      'our_note',
    ];
    const lines = items
      // A parcel that never reached the courier is ours to fix, not theirs to chase.
      .filter((item) => item.bookingState === 'booked')
      .map((item) =>
        [
          item.consignmentNo ?? '',
          item.trackingCode ?? '',
          item.orderNo,
          item.courierName,
          item.lastEventRawStatus ?? item.rawStatus ?? item.status,
          item.statusSince,
          String(item.daysStuck),
          takaText(BigInt(item.codAmountPoisha)),
          item.reasons.join(' '),
          // A note is free text a person typed, and this file goes to a third party: any
          // phone number in it is masked (invariant 10; M15 ledger audit m4).
          maskPhonesInText(item.lastEscalationNote ?? ''),
        ]
          .map(csvField)
          .join(','),
      );
    // CRLF and a BOM: the file is opened by a courier's support desk in Excel, which reads a
    // BOM-less UTF-8 file as Windows-1252 and turns any Bangla in a note into mojibake.
    const csv = `\uFEFF${[header.join(','), ...lines].join('\r\n')}\r\n`;
    return { filename: `stuck-parcels-${cutoffDate}.csv`, csv };
  }

  /** Add a note to a parcel's escalation trail. Append-only (migration 0067). */
  async escalate(
    context: ActiveContext,
    request: AuditableRequest,
    consignmentId: string,
    input: { note: string },
  ) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const consignment = await repo.consignmentById(tx, context.orgId, consignmentId);
      if (consignment === undefined) {
        throw new CourierError('CONSIGNMENT_NOT_FOUND', 'No such consignment.');
      }
      assertInScope(request, { branchId: consignment.branch_id });

      const saved = await repo.insertEscalation(tx, {
        orgId: context.orgId,
        consignmentId,
        note: input.note,
        createdBy: context.userId,
      });

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'courier.parcel.escalated',
        entityType: 'Order',
        entityId: consignment.order_id,
        before: null,
        after: { consignmentId, escalationId: saved.id },
        requestId: context.requestId,
        request,
      });

      return {
        id: saved.id,
        consignmentId,
        note: input.note,
        createdBy: context.userId,
        createdAt: saved.created_at,
      };
    });
  }

  /**
   * Queue a re-poll of the chosen parcels. The courier calls happen in the worker
   * (`delivery.repoll_parcels`, invariant 6); this only checks each id is the caller's, is
   * with a courier, and is not finished.
   */
  async requestRepoll(
    context: ActiveContext,
    request: AuditableRequest,
    input: { consignmentIds: readonly string[] },
  ) {
    const ids = [...new Set(input.consignmentIds)];
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const pollable = await repo.pollableConsignments(
        tx,
        context.orgId,
        ids,
        consignmentScope(request),
      );
      if (pollable.length === 0) {
        return { queued: 0, skipped: ids.length };
      }
      const payload: RepollPayload = {
        consignmentIds: pollable.map((row) => row.id),
        actorUserId: context.userId,
      };
      await enqueue(tx, COURIER_QUEUES.repoll, payload, {
        orgId: context.orgId,
        ref: pollable[0]?.id ?? null,
        requestId: context.requestId,
      });
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'courier.parcels.repoll_requested',
        entityType: 'Order',
        entityId: pollable[0]?.id ?? context.orgId,
        before: null,
        after: { consignmentIds: payload.consignmentIds },
        requestId: context.requestId,
        request,
      });
      return { queued: pollable.length, skipped: ids.length - pollable.length };
    });
  }
}

/** Why a candidate row is in the queue. Empty means it is not. */
export function reasonsFor(row: repo.StuckRow, cutoffDate: string): StuckReason[] {
  if (row.booking_state === 'failed') return ['booking_failed'];

  const reasons: StuckReason[] = [];
  const status = row.status as ParcelStatus;
  if (row.booking_state !== 'booked') return reasons;

  /*
   * Finished at the courier, not in our books. A delivery the courier reported and no journal
   * followed — a partial delivery with no collected figure, which waits for a person with the
   * manual status route — and a parcel the courier says it returned that the warehouse has not
   * received. The courier has nothing more to say about either, so without these two reasons
   * no clock would ever list them (M15 ledger audit M2).
   */
  if ((status === 'delivered' || status === 'partial_delivered') && row.delivered_at === null) {
    return ['unposted_delivery'];
  }
  if (status === 'returned_to_merchant' && !row.has_return_receipt) {
    return row.since_on <= cutoffDate ? ['return_not_received'] : [];
  }
  if (isTerminalParcelStatus(status)) return reasons;

  // D-903 first: the sweep asked the courier and found the parcel never reached it.
  if (row.not_received) reasons.push('not_received');
  if (row.since_on <= cutoffDate) reasons.push('no_status_change');

  /*
   * Any word that leaves us not knowing where an active parcel is — one no map knows, or one a
   * map sends to `unknown` on purpose. The second kind is not noise on an *active* parcel:
   * Pathao's `order.exchanged` or `order.paid` on a parcel our books still call shipped is a
   * delivery we deliberately did not book, and a person has to settle it now, not in N days.
   */
  if (status === 'unknown' || row.last_event_status === 'unknown') reasons.push('unknown_status');

  return reasons;
}

function takaText(poisha: bigint): string {
  const negative = poisha < 0n;
  const magnitude = negative ? -poisha : poisha;
  return `${negative ? '-' : ''}${(magnitude / 100n).toString()}.${(magnitude % 100n).toString().padStart(2, '0')}`;
}

/**
 * One CSV field, quoted when it has to be, and never a formula.
 *
 * A note typed by a person can begin with `=`, `+`, `-` or `@`, and a spreadsheet opens such a
 * cell as a formula — in a file sent to a third party, that is an injection into somebody
 * else's computer. Prefixed with an apostrophe, which every spreadsheet reads as "text".
 */
function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
