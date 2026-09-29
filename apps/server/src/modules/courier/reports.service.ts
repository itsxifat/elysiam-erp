import { Inject, Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import { addDays, businessDate, poisha, toIsoDate } from '@elysium/domain';
import {
  agingBucketFor,
  AGING_BUCKETS,
  isParcelStatus,
  summariseAging,
  summarisePerformance,
  type PerformanceParcel,
} from '@elysium/domain/courier';
import { sql } from 'drizzle-orm';

import { scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { CourierError } from './courier.errors.js';
import * as repo from './courier.repository.js';
import { LEDGER_READ_PORT, type LedgerReadPort } from './ports/ledger-read.port.js';

/**
 * Courier receivable aging and COD reconciliation (architecture §7's reports; M12's last
 * bullet).
 *
 * §7 lists both: "receivable and payable aging (0–7, 8–30, 31–60, 60+ days)" and "COD
 * reconciliation: delivered vs settled vs outstanding, by courier". They are one service
 * because they are one query with two summaries over it, and because the second is the only
 * honest way to read the first: an aging bucket is a number, and the parcels in it are the
 * answer.
 *
 * ## Two numbers, from two sources, on purpose
 *
 * The report carries the outstanding figure **twice**: once summed from the consignments
 * (`outstandingPoisha`) and once read off the ledger (`ledgerOutstandingPoisha`), and it
 * states the difference. That is not redundancy, it is the check. The consignment rows are
 * the operational record and the ledger is the book; if the two disagree, something posted
 * without a consignment or a consignment settled without a journal, and the report is where
 * anybody would notice. A report that showed one number would be a report that could be
 * wrong and look right for a year.
 *
 * ## No cost, and no cost to strip
 *
 * Nothing here is cost information: a COD amount is what a customer paid, a courier charge
 * is an expense, and neither is in `COST_FIELDS`. The report is `read LedgerReport`, which
 * §6 gives accounts and org_admin at `org` and a branch manager at `branch` — so the row
 * scope is applied to each consignment's `branch_id`, and a branch manager sees their own
 * showroom's parcels.
 */
@Injectable()
export class CourierReportsService {
  constructor(@Inject(LEDGER_READ_PORT) private readonly ledger: LedgerReadPort) {}

  /**
   * COD reconciliation: delivered, settled, outstanding, by courier (§7).
   *
   * `asOf` defaults to today in Asia/Dhaka (invariant 8), and every date in the answer is a
   * business date rather than an instant — a report whose figures moved depending on the
   * hour it was run would be a report nobody could reconcile against yesterday's copy.
   */
  async reconciliation(
    context: ActiveContext,
    request: object,
    options: { asOf?: string | undefined; courierId?: string | undefined },
  ) {
    const asOf = toIsoDate(options.asOf ?? businessDate(new Date()));
    const branchWhere = scopeWhere(request, { branchId: sql`c.branch_id` });

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.reconciliation(tx, context.orgId, {
        courierId: options.courierId,
        asOf,
        branchWhere,
      });
      const ledgerBalances = await this.ledger.courierReceivables(tx, context.orgId, asOf);

      interface Bucket {
        courierId: string;
        deliveredCount: number;
        deliveredPoisha: bigint;
        settledCount: number;
        settledPoisha: bigint;
        chargesPoisha: bigint;
        outstandingPoisha: bigint;
        aging: { since: string; amountPoisha: bigint }[];
        oldestOutstandingOn: string | null;
      }

      const byCourier = new Map<string, Bucket>();
      const outstandingRows: {
        consignmentId: string;
        courierId: string;
        orderId: string;
        orderNo: string;
        consignmentNo: string | null;
        deliveredOn: string | null;
        outstandingPoisha: string;
        ageBucket: string;
      }[] = [];

      for (const row of rows) {
        const bucket = byCourier.get(row.courier_id) ?? {
          courierId: row.courier_id,
          deliveredCount: 0,
          deliveredPoisha: 0n,
          settledCount: 0,
          settledPoisha: 0n,
          chargesPoisha: 0n,
          outstandingPoisha: 0n,
          aging: [],
          oldestOutstandingOn: null,
        };

        const collected = BigInt(row.collected_poisha);
        bucket.deliveredCount += 1;
        bucket.deliveredPoisha += collected;

        if (row.settled) {
          bucket.settledCount += 1;
          bucket.settledPoisha += BigInt(row.settled_net_poisha);
          bucket.chargesPoisha += BigInt(row.settled_charges_poisha);
        } else {
          /*
           * Outstanding is what the courier still owes for this parcel.
           *
           * The whole collection, not a share of it: a consignment is settled or it is not,
           * because §7's settlement relieves the receivable for a consignment in full — the
           * matcher refuses a row whose collection disagrees with our books, so there is no
           * partially-settled consignment for this to have to apportion.
           */
          bucket.outstandingPoisha += collected;
          const since = row.delivered_on ?? asOf;
          bucket.aging.push({ since, amountPoisha: collected });
          if (bucket.oldestOutstandingOn === null || since < bucket.oldestOutstandingOn) {
            bucket.oldestOutstandingOn = since;
          }
          if (collected > 0n) {
            outstandingRows.push({
              consignmentId: row.consignment_id,
              courierId: row.courier_id,
              orderId: row.order_id,
              orderNo: row.order_no,
              consignmentNo: row.consignment_no,
              deliveredOn: row.delivered_on,
              outstandingPoisha: collected.toString(),
              ageBucket: agingBucketFor(asOf, toIsoDate(since)),
            });
          }
        }

        byCourier.set(row.courier_id, bucket);
      }

      const couriers = [...byCourier.values()].map((bucket) => {
        const aging = summariseAging(
          asOf,
          bucket.aging.map((item) => ({
            since: toIsoDate(item.since),
            amountPoisha: poisha(item.amountPoisha),
          })),
        );
        const fromLedger = ledgerBalances.get(bucket.courierId) ?? 0n;
        return {
          courierId: bucket.courierId,
          deliveredCount: bucket.deliveredCount,
          deliveredPoisha: bucket.deliveredPoisha.toString(),
          settledCount: bucket.settledCount,
          settledPoisha: bucket.settledPoisha.toString(),
          chargesPoisha: bucket.chargesPoisha.toString(),
          outstandingPoisha: bucket.outstandingPoisha.toString(),
          /** Σ debit − Σ credit on `courier_receivable` for this courier (§7). */
          ledgerOutstandingPoisha: fromLedger.toString(),
          /*
           * The two should agree. When they do not, something posted to the receivable
           * without a consignment behind it or a consignment was settled without a journal —
           * and this figure is where anybody would notice. Reported rather than reconciled
           * away, because the fix is never arithmetic.
           */
          variancePoisha: (fromLedger - bucket.outstandingPoisha).toString(),
          oldestOutstandingOn: bucket.oldestOutstandingOn,
          aging: Object.fromEntries(AGING_BUCKETS.map((name) => [name, aging[name].toString()])),
        };
      });

      return {
        asOf,
        couriers,
        /** Every unsettled parcel, so an aging bucket can be opened rather than trusted. */
        outstanding: outstandingRows,
        totals: {
          deliveredPoisha: couriers
            .reduce((total, row) => total + BigInt(row.deliveredPoisha), 0n)
            .toString(),
          settledPoisha: couriers
            .reduce((total, row) => total + BigInt(row.settledPoisha), 0n)
            .toString(),
          outstandingPoisha: couriers
            .reduce((total, row) => total + BigInt(row.outstandingPoisha), 0n)
            .toString(),
          chargesPoisha: couriers
            .reduce((total, row) => total + BigInt(row.chargesPoisha), 0n)
            .toString(),
        },
      };
    });
  }

  /**
   * Courier performance: delivery rate, average days and return rate, by zone (M15).
   *
   * The window is by booking date in Asia/Dhaka (invariant 8), defaulting to the last thirty
   * days, and capped at a year — a report over every parcel ever booked is a report nobody
   * can act on, and a query that reads them all is one the order desk feels.
   *
   * Every ratio is computed in the domain (`summarisePerformance`), in integers: the rates are
   * basis points and the mean is a one-decimal string. Zones are returned as ids; the console
   * names them from `GET /v1/delivery-zones`, the orders module's own list, rather than this
   * module reading that module's table.
   */
  async performance(
    context: ActiveContext,
    request: object,
    options: { from?: string | undefined; to?: string | undefined; courierId?: string | undefined },
  ) {
    const to = toIsoDate(options.to ?? businessDate(new Date()));
    const from = toIsoDate(options.from ?? addDays(to, -29));
    if (from > to) {
      throw new CourierError('CONSIGNMENT_INVALID', 'The report starts after it ends.');
    }
    if (addDays(from, 366) <= to) {
      throw new CourierError('CONSIGNMENT_INVALID', 'A performance report covers a year at most.');
    }
    const branchWhere = scopeWhere(request, { branchId: sql`c.branch_id` });

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.performanceSource(tx, context.orgId, {
        from,
        to,
        courierId: options.courierId,
        branchWhere,
      });

      const names = new Map<string, string>();
      const parcels: PerformanceParcel[] = [];
      for (const row of rows) {
        names.set(row.courier_id, row.courier_name);
        if (!isParcelStatus(row.status)) continue;
        parcels.push({
          courierId: row.courier_id,
          deliveryZoneId: row.delivery_zone_id,
          status: row.status,
          bookedOn: toIsoDate(row.booked_on),
          deliveredOn: row.delivered_on === null ? null : toIsoDate(row.delivered_on),
        });
      }

      const report = summarisePerformance(parcels);
      const named = <T extends { courierId: string }>(row: T) => ({
        ...row,
        courierName: names.get(row.courierId) ?? '',
      });
      return {
        from,
        to,
        rows: report.rows.map(named),
        couriers: report.couriers.map(named),
      };
    });
  }
}
