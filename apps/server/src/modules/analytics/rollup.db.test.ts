import { randomUUID } from 'node:crypto';

import { withAnalytics, withOrg, withSystem } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_QUEUES } from '../../job-queues.js';
import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import {
  createBranch,
  ORG_A,
  ORG_B,
  startHttpHarness,
  type HttpHarness,
} from '../../testing/http-harness.js';
import { seedProductWithSkus } from '../inventory/inventory.testing.js';
import { seedCustomer } from '../orders/orders.testing.js';
import { ANALYTICS_QUEUES, rollupBucket } from './analytics.queues.js';
import { registerAnalyticsJobs } from './analytics.worker.js';
import { RollupService } from './rollup.service.js';

/**
 * M24 acceptance check 1: the rollups equal direct queries on seeded data, against real
 * Postgres.
 *
 * Two brands are seeded with a deterministic mix of orders over ten Asia/Dhaka days —
 * pending, confirmed, delivered in full (with line and order discounts), delivered in part,
 * returned, cancelled after confirming and cancelled before it; online and through a
 * showroom; four channels; shipped inside and outside Dhaka; at hours either side of Dhaka
 * midnight — plus two campaigns with daily spend, two agents and their desk pickups.
 *
 * Then the job's own path (`RollupService.recompute`, reading every source through its
 * owner's `*.api.ts`) fills the five tables, and each table is compared, row for row, with
 * a query written straight against `sales`, `marketing` and `hr` — no shared code with the
 * rollup. The seed's one simplification is stated where the direct revenue query relies on
 * it: discounts appear only on orders delivered in full, so the delivered net value is
 * `Σ unit price × delivered − order discount` without the pro-rating M10's partial delivery
 * does (which `computePartialDelivery`'s own tests cover).
 */

const FROM = '2026-08-28';
const TO = '2026-09-06';
const AGENTS = ['usr_rollup_agent_a', 'usr_rollup_agent_b'] as const;
const CHANNELS = ['facebook', 'whatsapp', 'phone', 'walk_in'] as const;
const DAYS = Array.from({ length: 10 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 7, 28 + index));
  return date.toISOString().slice(0, 10);
});

let harness: HttpHarness;
let rollup: RollupService;
let jobs: JobsRuntime;

/** A small deterministic generator, so a failure reproduces exactly. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

/** An instant on a Dhaka date at a Dhaka clock time. */
function at(date: string, hour: number, minute = 0, second = 0): Date {
  const pad = (value: number) => String(value).padStart(2, '0');
  return new Date(`${date}T${pad(hour)}:${pad(minute)}:${pad(second)}+06:00`);
}

function nextDay(date: string, by = 1): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + by);
  return value.toISOString().slice(0, 10);
}

interface World {
  readonly orgId: string;
  readonly prefix: string;
  readonly seed: number;
  readonly orders: number;
}

let orderSeq = 0;

async function seedWorld(world: World): Promise<void> {
  const random = generator(world.seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const { skus } = await seedProductWithSkus(world.orgId, `${world.prefix}rollup`, 3);
  const customer = await seedCustomer(world.orgId, {
    phoneE164: world.orgId === ORG_A ? '+8801711000801' : '+8801711000802',
    name: 'Rollup Buyer',
  });
  const branch = await createBranch(world.orgId, `${world.prefix.toUpperCase()}R`);

  await withSystem(
    async (tx) => {
      const area = async (where: SQL) => {
        const found = await tx.execute<{ district_id: number; thana_id: number }>(sql`
          select t.district_id, t.id as thana_id from ref.thanas t where ${where}
          order by t.id limit 1
        `);
        const row = found[0];
        if (row === undefined) throw new Error('the seed has no geography');
        return row;
      };
      // District 47 is Dhaka in the vendored geography (D-045).
      const dhaka = await area(sql`t.district_id = 47`);
      const outside = await area(sql`t.district_id <> 47`);

      const campaigns: string[] = [];
      for (const name of ['Eid', 'Puja']) {
        const rows = await tx.execute<{ id: string }>(sql`
          insert into marketing.campaigns (org_id, name, platform, created_by)
          values (${world.orgId}, ${`${world.prefix} ${name}`}, 'meta', 'usr_rollup_seed')
          returning id
        `);
        campaigns.push(rows[0]?.id ?? '');
      }
      // Spend on most days for both campaigns, and one day outside the range.
      for (const day of [nextDay(FROM, -1), ...DAYS]) {
        for (const campaign of campaigns) {
          if (random() < 0.25) continue;
          const amount = BigInt(Math.floor(random() * 500_000) + 10_000);
          await tx.execute(sql`
            insert into marketing.ad_spend
              (org_id, campaign_id, spend_date, amount_poisha, source, entered_by)
            values (${world.orgId}, ${campaign}, ${day}::date, ${amount}, 'manual',
                    'usr_rollup_seed')
          `);
        }
      }

      for (let index = 0; index < world.orders; index += 1) {
        orderSeq += 1;
        // A day from one before the range to the range's last, so an order created outside
        // the range can still deliver inside it.
        const createdDay = nextDay(FROM, Math.floor(random() * (DAYS.length + 1)) - 1);
        // Either side of Dhaka midnight, and the middle of the day.
        const hour = pick([0, 0, 9, 13, 23]);
        const createdAt = at(createdDay, hour, hour === 0 ? 10 : 50);
        const scenario = Math.floor(random() * 7);
        const agent = pick(AGENTS);
        const channel = pick(CHANNELS);
        const area = random() < 0.4 ? outside : dhaka;
        const campaign = random() < 0.6 ? pick(campaigns) : null;
        const later = (days: number, h: number, m = 5) => at(nextDay(createdDay, days), h, m);

        const confirmedAt = scenario === 0 || scenario === 6 ? null : later(pick([0, 1]), 23, 40);
        const deliveredAt = scenario === 2 || scenario === 3 ? later(pick([2, 3]), 0, 20) : null;
        const returnedAt = scenario === 4 ? later(4, 14) : null;
        const cancelledAt =
          scenario === 5
            ? later(2, 10)
            : scenario === 6
              ? later(0, hour === 23 ? 23 : 15, 55)
              : null;
        const status = [
          'pending',
          'confirmed',
          'delivered',
          'partially_delivered',
          'returned',
          'cancelled',
          'cancelled',
        ][scenario]!;

        const lineCount = 1 + Math.floor(random() * 2);
        const lines = Array.from({ length: lineCount }, (_, position) => {
          const qty = 1 + Math.floor(random() * 3);
          const unit = BigInt(50_000 + Math.floor(random() * 200_000));
          const delivered =
            scenario === 2 ? qty : scenario === 3 ? Math.max(qty - 1, position === 0 ? 1 : 0) : 0;
          return {
            sku: skus[position % skus.length]!,
            qty,
            unit,
            // Discounts only on orders delivered in full (see the file comment).
            discount: scenario === 2 && position === 0 ? 5_000n : 0n,
            delivered,
            returned: scenario === 4 ? qty : 0,
            cost: deliveredAt === null ? null : (unit * 6n) / 10n,
          };
        });
        const items = lines.reduce((sum, line) => sum + line.unit * BigInt(line.qty), 0n);
        const discount =
          lines.reduce((sum, line) => sum + line.discount, 0n) + (scenario === 2 ? 2_000n : 0n);
        const delivery = 6_000n;

        const rows = await tx.execute<{ id: string }>(sql`
          insert into sales.orders (
            org_id, order_no, channel, source, branch_id, customer_id, ship_name,
            ship_phone_e164, ship_district_id, ship_thana_id, ship_address_line, items_poisha,
            discount_poisha, delivery_charge_poisha, advance_paid_poisha, cod_amount_poisha,
            status, created_by, assigned_to, confirmed_by, created_at, confirmed_at,
            delivered_at, returned_at, cancelled_at)
          values (
            ${world.orgId}, ${`ANL-2609-${String(orderSeq).padStart(5, '0')}`},
            ${channel}::sales.order_channel,
            ${JSON.stringify(campaign === null ? {} : { campaignId: campaign })}::jsonb,
            ${random() < 0.35 ? branch : null}::uuid, ${customer}, 'Rollup Buyer',
            '+8801711000801', ${area.district_id}, ${area.thana_id}, 'House 1, Road 1',
            ${items}, ${discount}, ${delivery}, 0, ${items - discount + delivery},
            ${status}::sales.order_status, 'usr_rollup_desk', ${agent},
            ${confirmedAt === null ? null : agent}, ${createdAt.toISOString()}::timestamptz,
            ${confirmedAt?.toISOString() ?? null}::timestamptz,
            ${deliveredAt?.toISOString() ?? null}::timestamptz,
            ${returnedAt?.toISOString() ?? null}::timestamptz,
            ${cancelledAt?.toISOString() ?? null}::timestamptz)
          returning id
        `);
        const orderId = rows[0]?.id ?? '';
        for (const [position, line] of lines.entries()) {
          await tx.execute(sql`
            insert into sales.order_lines
              (org_id, order_id, sku_id, sku_code, product_name, qty, unit_price_poisha,
               discount_poisha, delivered_qty, returned_qty, dispatch_unit_cost_poisha, position)
            values (${world.orgId}, ${orderId}, ${line.sku.id}, ${line.sku.code}, 'Rollup product',
                    ${line.qty}, ${line.unit}, ${line.discount}, ${line.delivered},
                    ${line.returned}, ${line.cost}, ${position})
          `);
        }

        // The desk: created into the queue, then claimed by the agent a few minutes later.
        if (confirmedAt !== null || random() < 0.3) {
          const claimedAt = new Date(
            createdAt.getTime() + (30 + Math.floor(random() * 900)) * 1000,
          );
          for (const [kind, when, assignee, actor] of [
            ['created', createdAt, null, 'usr_rollup_desk'],
            ['claimed', claimedAt, agent, agent],
          ] as const) {
            await tx.execute(sql`
              insert into hr.desk_events
                (org_id, event_id, order_id, kind, assignee_user_id, actor_user_id, occurred_at)
              values (${world.orgId}, ${randomUUID()}, ${orderId}, ${kind}, ${assignee}, ${actor},
                      ${when.toISOString()}::timestamptz)
            `);
          }
        }
      }
    },
    { orgId: world.orgId },
  );
}

// --- the direct queries ---------------------------------------------------------------

/**
 * Every order of the brand with its Dhaka days, delivered net value and dispatch cost,
 * computed straight from `sales` (see the file comment for the discount simplification).
 */
const ORDER_FACTS = (orgId: string) => sql`
  select o.id, o.channel::text as channel, o.branch_id, o.source ->> 'campaignId' as campaign_id,
         o.status::text as status, o.confirmed_by,
         (o.created_at at time zone 'Asia/Dhaka')::date as created_on,
         (o.confirmed_at at time zone 'Asia/Dhaka')::date as confirmed_on,
         (o.delivered_at at time zone 'Asia/Dhaka')::date as delivered_on,
         (o.returned_at at time zone 'Asia/Dhaka')::date as returned_on,
         case when o.confirmed_at is not null
              then (o.cancelled_at at time zone 'Asia/Dhaka')::date end as cancelled_on,
         o.ship_district_id <> 47 as outside,
         o.items_poisha - o.discount_poisha as placed,
         (select coalesce(sum(l.unit_price_poisha * l.delivered_qty), 0)
            from sales.order_lines l where l.org_id = o.org_id and l.order_id = o.id)
           - case when (select bool_and(l.delivered_qty = l.qty) from sales.order_lines l
                        where l.org_id = o.org_id and l.order_id = o.id)
                  then o.discount_poisha else 0 end as revenue,
         (select coalesce(sum(l.dispatch_unit_cost_poisha * l.delivered_qty), 0)
            from sales.order_lines l where l.org_id = o.org_id and l.order_id = o.id) as cost,
         exists (select 1 from sales.order_lines l
                 where l.org_id = o.org_id and l.order_id = o.id and l.delivered_qty > 0)
           as any_delivered
  from sales.orders o
  where o.org_id = ${orgId}`;

const DAY_SERIES = sql`
  select generate_series(${FROM}::date, ${TO}::date, interval '1 day')::date as d`;

const ORDER_SUMS = sql`
  count(*) filter (where f.created_on = days.d)::int as orders_placed,
  count(*) filter (where f.confirmed_on = days.d)::int as orders_confirmed,
  count(*) filter (where f.delivered_on = days.d)::int as orders_delivered,
  count(*) filter (where f.returned_on = days.d)::int as orders_returned,
  count(*) filter (where f.cancelled_on = days.d)::int as orders_cancelled,
  coalesce(sum(f.revenue) filter (where f.delivered_on = days.d), 0)::text
    as delivered_revenue_poisha,
  coalesce(sum(f.revenue - f.cost) filter (where f.delivered_on = days.d), 0)::text
    as gross_profit_poisha,
  count(*) filter (where f.delivered_on = days.d and f.outside)::int as delivered_outside_dhaka,
  count(*) filter (where f.returned_on = days.d and f.outside)::int as returned_outside_dhaka`;

const ANY_EVENT = sql`(f.created_on = days.d or f.confirmed_on = days.d or f.delivered_on = days.d
  or f.returned_on = days.d or f.cancelled_on = days.d)`;

/** The pickups: a claim out of the queue, timed from the order's creation (D-276). */
const PICKUPS = (orgId: string) => sql`
  select c.assignee_user_id as agent,
         (c.occurred_at at time zone 'Asia/Dhaka')::date as day,
         floor(extract(epoch from c.occurred_at - k.occurred_at))::int as seconds
  from hr.desk_events c
  join hr.desk_events k on k.org_id = c.org_id and k.order_id = c.order_id and k.kind = 'created'
  where c.org_id = ${orgId} and c.kind = 'claimed'`;

function direct(orgId: string): Record<string, SQL> {
  return {
    daily_org: sql`
      with f as (${ORDER_FACTS(orgId)}), days as (${DAY_SERIES}), p as (${PICKUPS(orgId)})
      select days.d::text as business_date, ${ORDER_SUMS},
             (select coalesce(sum(s.amount_poisha), 0) from marketing.ad_spend s
              where s.org_id = ${orgId} and s.spend_date = days.d)::text as spend_poisha,
             (select count(*) from p where p.day = days.d)::int as pickup_count,
             (select coalesce(sum(p.seconds), 0) from p where p.day = days.d)::text as pickup_seconds
      from days cross join f
      group by days.d`,
    daily_channel: sql`
      with f as (${ORDER_FACTS(orgId)}), days as (${DAY_SERIES})
      select days.d::text as business_date, f.channel as key, ${ORDER_SUMS}
      from days join f on ${ANY_EVENT}
      group by days.d, f.channel`,
    daily_branch: sql`
      with f as (${ORDER_FACTS(orgId)}), days as (${DAY_SERIES})
      select days.d::text as business_date, f.branch_id::text as key, ${ORDER_SUMS}
      from days join f on ${ANY_EVENT} and f.branch_id is not null
      group by days.d, f.branch_id`,
    daily_campaign: sql`
      with f as (${ORDER_FACTS(orgId)}), days as (${DAY_SERIES}),
      orders as (
        select days.d, f.campaign_id,
               count(*) filter (where f.confirmed_on = days.d)::int as confirmed,
               count(*) filter (where f.delivered_on = days.d)::int as delivered,
               count(*) filter (where f.returned_on = days.d)::int as returned,
               coalesce(sum(f.revenue) filter (where f.delivered_on = days.d), 0) as revenue,
               coalesce(sum(f.placed) filter (where f.confirmed_on = days.d), 0) as placed
        from days join f
          on f.confirmed_on = days.d or f.delivered_on = days.d or f.returned_on = days.d
        group by days.d, f.campaign_id
      ),
      spend as (
        select s.spend_date as d, s.campaign_id::text as campaign_id, sum(s.amount_poisha) as amount
        from marketing.ad_spend s
        where s.org_id = ${orgId} and s.spend_date between ${FROM}::date and ${TO}::date
        group by s.spend_date, s.campaign_id
      )
      select coalesce(o.d, s.d)::text as business_date,
             coalesce(o.campaign_id, s.campaign_id) as key,
             coalesce(s.amount, 0)::text as spend_poisha,
             coalesce(o.confirmed, 0) as orders_confirmed,
             coalesce(o.delivered, 0) as orders_delivered,
             coalesce(o.returned, 0) as orders_returned,
             coalesce(o.revenue, 0)::text as delivered_revenue_poisha,
             coalesce(o.placed, 0)::text as placed_revenue_poisha
      from orders o
      full join spend s on s.d = o.d and s.campaign_id is not distinct from o.campaign_id
      where coalesce(s.amount, 0) <> 0 or coalesce(o.confirmed, 0) + coalesce(o.delivered, 0)
            + coalesce(o.returned, 0) <> 0`,
    daily_agent: sql`
      with f as (${ORDER_FACTS(orgId)}), days as (${DAY_SERIES}), p as (${PICKUPS(orgId)}),
      work as (
        select f.confirmed_by as agent, f.confirmed_on as day, 1 as confirmed, 0 as delivered,
               0::bigint as revenue
        from f where f.confirmed_by is not null and f.status <> 'cancelled'
        union all
        select f.confirmed_by, f.delivered_on, 0, 1, f.revenue
        from f where f.confirmed_by is not null and f.delivered_on is not null and f.any_delivered
      ),
      w as (
        select agent, day, sum(confirmed)::int as confirmed, sum(delivered)::int as delivered,
               sum(revenue) as revenue
        from work where day between ${FROM}::date and ${TO}::date group by agent, day
      ),
      pk as (
        select agent, day, count(*)::int as n, sum(seconds) as seconds
        from p where day between ${FROM}::date and ${TO}::date group by agent, day
      )
      select coalesce(w.day, pk.day)::text as business_date, coalesce(w.agent, pk.agent) as key,
             coalesce(w.confirmed, 0) as orders_confirmed,
             coalesce(w.delivered, 0) as orders_delivered,
             coalesce(w.revenue, 0)::text as delivered_revenue_poisha,
             coalesce(pk.n, 0) as pickup_count, coalesce(pk.seconds, 0)::text as pickup_seconds
      from w full join pk on pk.agent = w.agent and pk.day = w.day`,
  };
}

/** What the rollup wrote, in the same shape as the direct query for that table. */
function rolledUp(orgId: string): Record<string, SQL> {
  const metrics = sql`orders_placed, orders_confirmed, orders_delivered, orders_returned,
    orders_cancelled, delivered_revenue_poisha::text, gross_profit_poisha::text,
    delivered_outside_dhaka, returned_outside_dhaka`;
  const range = sql`org_id = ${orgId} and business_date between ${FROM}::date and ${TO}::date`;
  return {
    daily_org: sql`
      select business_date::text as business_date, ${metrics}, spend_poisha::text,
             pickup_count, pickup_seconds::text
      from analytics.daily_org where ${range}`,
    daily_channel: sql`
      select business_date::text as business_date, channel as key, ${metrics}
      from analytics.daily_channel where ${range}`,
    daily_branch: sql`
      select business_date::text as business_date, branch_id::text as key, ${metrics}
      from analytics.daily_branch where ${range}`,
    daily_campaign: sql`
      select business_date::text as business_date, campaign_id::text as key,
             spend_poisha::text, orders_confirmed, orders_delivered, orders_returned,
             delivered_revenue_poisha::text, placed_revenue_poisha::text
      from analytics.daily_campaign where ${range}`,
    daily_agent: sql`
      select business_date::text as business_date, user_id as key, orders_confirmed,
             orders_delivered, delivered_revenue_poisha::text, pickup_count,
             pickup_seconds::text
      from analytics.daily_agent where ${range}`,
  };
}

type Row = Record<string, unknown>;

/** A cell as text: every column the queries return is a number, a string or null. */
function cell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  throw new Error(`unexpected cell ${typeof value}`);
}

/** Rows as sorted, comparable records: every value a string, keyed by date and key. */
async function rows(orgId: string, query: SQL): Promise<string[]> {
  const found = await withSystem(async (tx) => tx.execute<Row>(query), { orgId });
  return [...found]
    .map((row) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(row)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, value]) => [key, cell(value)]),
        ),
      ),
    )
    .sort();
}

async function expectRollupEqualsDirect(orgId: string): Promise<void> {
  const expected = direct(orgId);
  const actual = rolledUp(orgId);
  for (const table of Object.keys(expected)) {
    const want = await rows(orgId, expected[table]!);
    const got = await rows(orgId, actual[table]!);
    // Not vacuous: every table has rows to compare.
    expect(want.length, `${table} for ${orgId} has rows`).toBeGreaterThan(0);
    expect(got, `${table} for ${orgId}`).toEqual(want);
  }
}

beforeAll(async () => {
  harness = await startHttpHarness('analytics-rollup');
  rollup = harness.app.get(RollupService);
  // The worker role installs pg-boss's schema; no handler is attached, so a job enqueued by
  // the triggers below sits in `pgboss.job` for the test to read and nothing runs it.
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues: ALL_QUEUES,
    logger: pino({ level: 'silent' }),
  });
  await seedWorld({ orgId: ORG_A, prefix: 'a', seed: 24_001, orders: 140 });
  await seedWorld({ orgId: ORG_B, prefix: 'b', seed: 24_002, orders: 60 });
}, 600_000);

afterAll(async () => {
  await jobs?.stop();
  await harness?.close();
}, 120_000);

describe('check 1: every rollup table equals a direct query over its sources', () => {
  it('is not vacuous: the seed exercises every kind of row', async () => {
    const counts = await withSystem(
      async (tx) =>
        tx.execute<Row>(sql`
          select count(*) filter (where delivered_at is not null)::int as delivered,
                 count(*) filter (where status = 'partially_delivered')::int as partial,
                 count(*) filter (where returned_at is not null)::int as returned,
                 count(*) filter (where cancelled_at is not null and confirmed_at is not null)::int
                   as cancelled_after,
                 count(*) filter (where branch_id is not null)::int as branched,
                 count(*) filter (where ship_district_id <> 47)::int as outside,
                 count(*) filter (where source ? 'campaignId')::int as attributed
          from sales.orders where org_id = ${ORG_A} and order_no like 'ANL-%'
        `),
      { orgId: ORG_A },
    );
    const row = counts[0] ?? {};
    for (const key of Object.keys(row)) expect(Number(row[key]), key).toBeGreaterThan(3);
  });

  it('holds for both brands after the job recomputes them', async () => {
    await rollup.recompute(ORG_A, { from: FROM, to: TO });
    await rollup.recompute(ORG_B, { from: FROM, to: TO });
    await expectRollupEqualsDirect(ORG_A);
    await expectRollupEqualsDirect(ORG_B);

    // A day row for every day of the range, quiet ones included.
    const days = await rows(
      ORG_A,
      sql`select business_date::text from analytics.daily_org
          where org_id = ${ORG_A} and business_date between ${FROM}::date and ${TO}::date`,
    );
    expect(days).toHaveLength(DAYS.length);
  });

  it('is idempotent: a rerun, and a rerun of part of the range, change nothing', async () => {
    const before = await rows(ORG_A, rolledUp(ORG_A).daily_org!);
    await rollup.recompute(ORG_A, { from: FROM, to: TO });
    await rollup.recompute(ORG_A, { from: '2026-09-01', to: '2026-09-03' });
    expect(await rows(ORG_A, rolledUp(ORG_A).daily_org!)).toEqual(before);
    await expectRollupEqualsDirect(ORG_A);
  });

  it('follows its sources: a spend correction is picked up on the next run', async () => {
    await withSystem(
      async (tx) => {
        await tx.execute(sql`
          update marketing.ad_spend set amount_poisha = amount_poisha + 12345
          where org_id = ${ORG_A} and spend_date = '2026-09-02'::date
        `);
      },
      { orgId: ORG_A },
    );
    await rollup.recompute(ORG_A, { from: FROM, to: TO });
    await expectRollupEqualsDirect(ORG_A);
  });

  it('takes turns when recomputes of one brand overlap, and still equals the direct query', async () => {
    // The event bucket, the nightly run and a manual refresh can all land at once; the
    // per-brand advisory lock makes the second wait rather than collide with the first.
    await Promise.all([
      rollup.recompute(ORG_A, { from: FROM, to: TO }),
      rollup.recompute(ORG_A, { from: '2026-09-01', to: TO }),
      rollup.recompute(ORG_A, { from: FROM, to: '2026-09-02' }),
    ]);
    await expectRollupEqualsDirect(ORG_A);
  });

  it('runs through the worker’s handler, as pg-boss would call it', async () => {
    const handlers = new Map<
      string,
      (job: { orgId: string | null; payload: unknown }) => Promise<void>
    >();
    await registerAnalyticsJobs({
      jobs: {
        work: (
          queue: string,
          handler: (job: { orgId: string | null; payload: unknown }) => Promise<void>,
        ) => {
          handlers.set(queue, handler);
          return Promise.resolve();
        },
      } as never,
      dispatcher: { on: () => undefined } as never,
      rollup,
      report: () => Promise.resolve(),
    });
    await withSystem(
      async (tx) => {
        await tx.execute(sql`delete from analytics.daily_org where org_id = ${ORG_B}`);
      },
      { orgId: ORG_B },
    );
    await handlers.get(ANALYTICS_QUEUES.rollup)?.({
      orgId: ORG_B,
      payload: { from: FROM, to: TO },
    });
    await expectRollupEqualsDirect(ORG_B);
  });
});

interface JobRow extends Record<string, unknown> {
  readonly singleton_key: string | null;
  readonly start_after: Date | string;
  readonly org_id: string | null;
  readonly from: string;
  readonly to: string;
}

async function rollupJobs(where: SQL): Promise<JobRow[]> {
  const rows = await withSystem(async (tx) =>
    tx.execute<JobRow>(sql`
      select singleton_key, start_after, data ->> 'orgId' as org_id,
             data -> 'payload' ->> 'from' as "from", data -> 'payload' ->> 'to' as "to"
      from pgboss.job
      where name = ${ANALYTICS_QUEUES.rollup} and ${where}
      order by singleton_key
    `),
  );
  return [...rows];
}

describe('the jobs that run the rollup (D-320)', () => {
  it('fans out the last seven days to every active brand at night, once a day', async () => {
    const at = new Date('2026-09-10T21:00:00.000Z'); // 03:00 Dhaka on the 11th
    const brands = await rollup.fanOut(at);
    expect(brands).toBeGreaterThanOrEqual(5);

    const queued = () => rollupJobs(sql`singleton_key like 'nightly:%:2026-09-11'`);
    const first = await queued();
    expect(first).toHaveLength(brands);
    expect(new Set(first.map((job) => job.org_id))).toContain(ORG_A);
    for (const job of first) {
      expect(job).toMatchObject({ from: '2026-09-05', to: '2026-09-11' });
      expect(job.singleton_key).toBe(`nightly:${job.org_id ?? ''}:2026-09-11`);
    }

    // The cron's own retry, or a second worker, collapses on the singleton key.
    await rollup.fanOut(at);
    expect(await queued()).toHaveLength(brands);
  });

  it('turns an order event into one recompute of its own day through today, after the burst', async () => {
    // Created at 23:59:50 Dhaka on 1 Sept, dispatched ten seconds later, after midnight.
    const occurredAt = new Date('2026-09-01T17:59:50.000Z');
    const now = new Date('2026-09-01T18:00:00.000Z');
    const event = {
      id: randomUUID(),
      orgId: ORG_B,
      name: 'order.created',
      payload: { id: randomUUID() },
      rooms: [],
      attempts: 0,
      occurredAt,
      actorUserId: null,
    };
    await rollup.enqueueForEvent(event, now);
    // A second event in the same ten seconds is the same job.
    await rollup.enqueueForEvent({ ...event, id: randomUUID() }, new Date(now.getTime() + 4_000));

    const bucket = rollupBucket(ORG_B, now);
    const found = await rollupJobs(sql`singleton_key like ${`rollup:${ORG_B}:%`}`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      org_id: ORG_B,
      from: '2026-09-01',
      to: '2026-09-02',
      singleton_key: `${bucket.singletonKey}:2026-09-01:2026-09-02`,
    });
    // Started only after the bucket closed, so the burst's last commit is in it.
    expect(new Date(found[0]?.start_after ?? 0).getTime()).toBeGreaterThanOrEqual(
      bucket.startAfter.getTime(),
    );
  });
});

describe('the rollups are tenant data, and only the analytics role reads across brands', () => {
  it('shows one brand its own rows only', async () => {
    const seen = await withOrg({ orgId: ORG_A, userId: 'usr_rollup_reader' }, (tx) =>
      tx.execute<Row>(sql`select distinct org_id from analytics.daily_org`),
    );
    expect([...seen].map((row) => row.org_id)).toEqual([ORG_A]);
  });

  it('shows erp_analytics every brand’s org, channel and campaign days, and nothing else in the schema', async () => {
    const seen = await withAnalytics((tx) =>
      tx.execute<Row>(sql`select distinct org_id from analytics.daily_org order by 1`),
    );
    expect([...seen].map((row) => row.org_id).sort()).toEqual([ORG_A, ORG_B].sort());

    // The owner's reporting reads (migration 0103, D-483): counts and sums per day.
    for (const table of ['daily_channel', 'daily_campaign']) {
      await withAnalytics((tx) => tx.execute(sql.raw(`select count(*) from analytics.${table}`)));
    }

    // The branch and agent rollups stay single-brand (D-329), and so does the narrative cache.
    for (const table of ['daily_branch', 'daily_agent', 'narratives']) {
      await expect(
        withAnalytics((tx) => tx.execute(sql.raw(`select count(*) from analytics.${table}`))),
        table,
      ).rejects.toThrow();
    }
  });

  it('gives erp_analytics no write on any analytics table, by grant and not only read-only', async () => {
    const privileges = await withSystem(async (tx) =>
      tx.execute<Row>(sql`
        select c.relname as table_name, p.privilege
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p(privilege)
        where n.nspname = 'analytics' and c.relkind = 'r'
          and has_table_privilege('erp_analytics', c.oid, p.privilege)
      `),
    );
    expect([...privileges]).toEqual([]);
  });

  it('refuses a row written for another brand', async () => {
    await expect(
      withOrg({ orgId: ORG_A, userId: 'usr_rollup_reader' }, (tx) =>
        tx.execute(sql`
          insert into analytics.daily_org (org_id, business_date)
          values (${ORG_B}, '2001-01-01'::date)
        `),
      ),
    ).rejects.toThrow();
  });
});
