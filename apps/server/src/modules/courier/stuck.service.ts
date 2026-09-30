import { Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import { maskPhonesInText } from '@elysium/domain';
import {
  assertStuckThreshold,
  calendarDaysSince,
  isTerminalParcelStatus,
  STUCK_THRESHOLD_DAYS,
  stuckCutoffDate,
  type ParcelStatus,
} from '@elysium/domain/courier';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { CourierError } from './courier.errors.js';
import { COURIER_QUEUES, type RepollPayload } from './courier.queues.js';
import * as repo from './courier.repository.js';

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
  | 'return_not_received';

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

@Injectable()
export class StuckParcelsService {
  constructor(private readonly audit: AuditService) {}

  async list(
    context: ActiveContext,
    request: object,
    options: { thresholdDays?: number | undefined; courierId?: string | undefined },
    now: Date = new Date(),
  ): Promise<{ thresholdDays: number; cutoffDate: string; items: readonly StuckParcel[] }> {
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

    const rows = await withOrg({ orgId: context.orgId, userId: context.userId }, (tx) =>
      repo.stuckCandidates(tx, context.orgId, {
        cutoffDate,
        courierId: options.courierId,
        branchWhere,
        limit: 500,
      }),
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
        courierName: row.courier_name,
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
      });
    }

    return { thresholdDays, cutoffDate, items };
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
