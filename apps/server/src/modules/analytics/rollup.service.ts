import { Inject, Injectable } from '@nestjs/common';
import { withGlobal, withOrg, type Tx } from '@elysium/db';
import { addDays, businessDate, daysBetween, toIsoDate, type IsoDate } from '@elysium/domain';
import { rollupOrders, type OrderDayFact, type OrderMetrics } from '@elysium/domain/analytics';
import { sql } from 'drizzle-orm';

import type { DeliveredEvent } from '../../platform/events/dispatcher.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { HR_API, type HrApi } from '../hr/hr.api.js';
import { MARKETING_API, type MarketingApi } from '../marketing/marketing.api.js';
import { ORDERS_API, type AnalyticsOrderFact, type OrdersApi } from '../orders/orders.api.js';
import {
  ANALYTICS_QUEUES,
  eventRecomputeRange,
  MAX_ROLLUP_DAYS,
  NIGHTLY_DAYS,
  rollupBucket,
} from './analytics.queues.js';
import * as repo from './analytics.repository.js';

/** Who the rollup acts as in `app.user_id` and the outbox (D-277). Never a person. */
export const ROLLUP_ACTOR = 'usr_analytics_rollup';

/** The order events that can change a day's figures (§19). */
export const ROLLUP_EVENT_NAMES = ['order.created', 'order.status_changed'] as const;

/** The instant an Asia/Dhaka date begins. */
export function dhakaMidnight(date: string): Date {
  return new Date(`${date}T00:00:00+06:00`);
}

export function daysOf(from: IsoDate, to: IsoDate): IsoDate[] {
  const count = daysBetween(from, to) + 1;
  return Array.from({ length: Math.max(count, 0) }, (_, offset) => addDays(from, offset));
}

function domainFact(fact: AnalyticsOrderFact): OrderDayFact {
  const day = (value: string | null) => (value === null ? null : toIsoDate(value));
  return {
    orderId: fact.orderId,
    channel: fact.channel,
    branchId: fact.branchId,
    createdOn: toIsoDate(fact.createdOn),
    confirmedOn: day(fact.confirmedOn),
    deliveredOn: day(fact.deliveredOn),
    returnedOn: day(fact.returnedOn),
    cancelledOn: day(fact.cancelledOn),
    outsideDhaka: fact.outsideDhaka,
    deliveredRevenuePoisha: fact.deliveredRevenuePoisha,
    deliveredCostPoisha: fact.deliveredCostPoisha,
  };
}

function metricRow(metrics: OrderMetrics): repo.OrderMetricValues {
  return {
    ordersPlaced: metrics.ordersPlaced,
    ordersConfirmed: metrics.ordersConfirmed,
    ordersDelivered: metrics.ordersDelivered,
    ordersReturned: metrics.ordersReturned,
    ordersCancelled: metrics.ordersCancelled,
    deliveredRevenuePoisha: metrics.deliveredRevenuePoisha,
    grossProfitPoisha: metrics.grossProfitPoisha,
    deliveredOutsideDhaka: metrics.deliveredOutsideDhaka,
    returnedOutsideDhaka: metrics.returnedOutsideDhaka,
  };
}

interface AgentTotals {
  ordersConfirmed: number;
  ordersDelivered: number;
  deliveredRevenuePoisha: bigint;
  pickupCount: number;
  pickupSeconds: number;
}

/**
 * The rollups (architecture §18; M24, D-320, D-321).
 *
 * `recompute` rebuilds one brand's days from the modules that own the facts, each through
 * its `*.api.ts` (invariant 12): orders for the order events and their revenue, marketing
 * for spend and attributed campaign figures, orders again for each agent's confirmed and
 * delivered work (D-272), and HR for desk pickups (D-276). Inside one `withOrg()`
 * transaction it deletes the brand's rows for those days and inserts them again, so the
 * result depends only on the sources, never on how many times or in what order it ran.
 *
 * A per-brand advisory lock makes two recomputes of the same brand take turns: an event's
 * bucket, the nightly job and a manual refresh can all land at once, and without it the
 * second delete would not see the first's uncommitted rows and its insert would collide.
 */
@Injectable()
export class RollupService {
  constructor(
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    @Inject(MARKETING_API) private readonly marketing: MarketingApi,
    @Inject(HR_API) private readonly hr: HrApi,
  ) {}

  async recompute(
    orgId: string,
    range: { readonly from: string; readonly to: string },
    actor: string = ROLLUP_ACTOR,
  ): Promise<{ readonly days: number }> {
    return withOrg({ orgId, userId: actor }, (tx) => this.recomputeIn(tx, orgId, range));
  }

  async recomputeIn(
    tx: Tx,
    orgId: string,
    range: { readonly from: string; readonly to: string },
  ): Promise<{ readonly days: number }> {
    const from = toIsoDate(range.from);
    const to = toIsoDate(range.to);
    const days = daysOf(from, to);
    if (days.length === 0 || days.length > MAX_ROLLUP_DAYS) {
      throw new RangeError(`A recompute covers 1 to ${String(MAX_ROLLUP_DAYS)} days.`);
    }

    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`analytics.rollup:${orgId}`}))`);

    const facts = await this.orders.analyticsFacts(tx, orgId, { from, to });
    const campaignDays = await this.marketing.campaignDays(tx, orgId, { from, to });
    const agentResults = await this.orders.agentResults(tx, orgId, { from, to });
    const pickups = await this.hr.pickups(tx, orgId, {
      from: dhakaMidnight(from),
      to: dhakaMidnight(addDays(to, 1)),
    });

    const spendByDay = new Map<string, bigint>();
    for (const row of campaignDays) {
      spendByDay.set(
        row.businessDate,
        (spendByDay.get(row.businessDate) ?? 0n) + BigInt(row.inputs.spendPoisha),
      );
    }

    const agents = new Map<string, AgentTotals & { businessDate: string; userId: string }>();
    const agentEntry = (businessDate: string, userId: string) => {
      const key = `${businessDate}|${userId}`;
      let found = agents.get(key);
      if (found === undefined) {
        found = {
          businessDate,
          userId,
          ordersConfirmed: 0,
          ordersDelivered: 0,
          deliveredRevenuePoisha: 0n,
          pickupCount: 0,
          pickupSeconds: 0,
        };
        agents.set(key, found);
      }
      return found;
    };
    for (const result of agentResults) {
      const entry = agentEntry(result.businessDate, result.userId);
      entry.ordersConfirmed += result.confirmedOrders;
      entry.ordersDelivered += result.deliveredOrders;
      entry.deliveredRevenuePoisha += result.deliveredRevenuePoisha;
    }
    const pickupsByDay = new Map<string, { count: number; seconds: number }>();
    for (const pickup of pickups) {
      const day = businessDate(pickup.pickedAt);
      const entry = agentEntry(day, pickup.agent);
      entry.pickupCount += 1;
      entry.pickupSeconds += pickup.seconds;
      const total = pickupsByDay.get(day) ?? { count: 0, seconds: 0 };
      pickupsByDay.set(day, { count: total.count + 1, seconds: total.seconds + pickup.seconds });
    }

    await repo.deleteDays(tx, orgId, from, to);

    for (const day of rollupOrders(facts.map(domainFact), days)) {
      const pickupTotals = pickupsByDay.get(day.date) ?? { count: 0, seconds: 0 };
      await repo.insertOrgDay(tx, orgId, {
        businessDate: day.date,
        ...metricRow(day.org),
        spendPoisha: spendByDay.get(day.date) ?? 0n,
        pickupCount: pickupTotals.count,
        pickupSeconds: pickupTotals.seconds,
      });
      for (const [branchId, metrics] of day.byBranch) {
        await repo.insertBranchDay(tx, orgId, {
          businessDate: day.date,
          key: branchId,
          ...metricRow(metrics),
        });
      }
      for (const [channel, metrics] of day.byChannel) {
        await repo.insertChannelDay(tx, orgId, {
          businessDate: day.date,
          key: channel,
          ...metricRow(metrics),
        });
      }
    }

    for (const row of campaignDays) {
      await repo.insertCampaignDay(tx, orgId, {
        businessDate: row.businessDate,
        campaignId: row.campaignId,
        spendPoisha: BigInt(row.inputs.spendPoisha),
        ordersConfirmed: row.inputs.confirmedOrders,
        ordersDelivered: row.inputs.deliveredOrders,
        ordersReturned: row.inputs.returnedOrders,
        deliveredRevenuePoisha: BigInt(row.inputs.deliveredRevenuePoisha),
        placedRevenuePoisha: BigInt(row.inputs.placedRevenuePoisha),
      });
    }

    for (const entry of agents.values()) {
      // A day outside the range cannot occur (every source was asked for the range), but
      // a row written for one would survive the next recompute's delete, so refuse it.
      if (entry.businessDate < from || entry.businessDate > to) continue;
      await repo.insertAgentDay(tx, orgId, entry);
    }

    return { days: days.length };
  }

  // --- the jobs' halves ---------------------------------------------------------------

  /**
   * The outbox subscriber's half: one recompute per brand per ten-second bucket, of the day
   * the event happened through today. Usually one day; two when an event from just before
   * Dhaka midnight is dispatched just after it, so that day is not left stale until the
   * nightly run. Idempotent by the bucket key, so the dispatcher's at-least-once delivery
   * costs nothing.
   */
  async enqueueForEvent(event: DeliveredEvent, now: Date = new Date()): Promise<void> {
    const { from, to: today } = eventRecomputeRange(event.occurredAt, now);
    const bucket = rollupBucket(event.orgId, now);
    await withOrg({ orgId: event.orgId, userId: ROLLUP_ACTOR }, (tx) =>
      enqueue(
        tx,
        ANALYTICS_QUEUES.rollup,
        { from, to: today },
        {
          orgId: event.orgId,
          singletonKey: `${bucket.singletonKey}:${from}:${today}`,
          startAfter: bucket.startAfter,
          ref: event.id,
        },
      ),
    );
  }

  /** The nightly fan-out: the last seven Dhaka days for every active brand. */
  async fanOut(now: Date = new Date()): Promise<number> {
    const today = businessDate(now);
    const from = addDays(today, -(NIGHTLY_DAYS - 1));
    const orgIds = await withGlobal(async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        select id from org.organizations where is_active order by slug
      `);
      return [...rows].map((row) => row.id);
    });
    for (const orgId of orgIds) {
      await withOrg({ orgId, userId: ROLLUP_ACTOR }, (tx) =>
        enqueue(
          tx,
          ANALYTICS_QUEUES.rollup,
          { from, to: today },
          { orgId, singletonKey: `nightly:${orgId}:${today}` },
        ),
      );
    }
    return orgIds.length;
  }
}
