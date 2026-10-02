import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * The analytics module's SQL (M24). It names `analytics.*` and the global `org` schema
 * and nothing else: every source figure arrives through its owner's `*.api.ts`
 * (invariant 12), and the module-boundary ratchet holds this file to that.
 *
 * Two kinds of caller, and the comments say which each function is for:
 *
 * - **`withOrg()`** (the `erp_app` pool, one brand): the rollup's writes and the org
 *   dashboard's reads. RLS scopes every row; the `org_id` filters are belt and braces.
 * - **`withAnalytics()`** (the `erp_analytics` pool, every brand, read-only): the
 *   leaderboard, the insight rules' group medians and the consolidated dashboard. That role
 *   can read the five `daily_*` tables and `org.organizations`, and write nothing (D-329).
 */

// --- writing a day (withOrg) -------------------------------------------------------

export interface OrderMetricValues {
  readonly ordersPlaced: number;
  readonly ordersConfirmed: number;
  readonly ordersDelivered: number;
  readonly ordersReturned: number;
  readonly ordersCancelled: number;
  readonly deliveredRevenuePoisha: bigint;
  readonly grossProfitPoisha: bigint;
  readonly deliveredOutsideDhaka: number;
  readonly returnedOutsideDhaka: number;
}

export interface OrgDayRow extends OrderMetricValues {
  readonly businessDate: string;
  readonly spendPoisha: bigint;
  readonly pickupCount: number;
  readonly pickupSeconds: number;
}

export interface KeyedDayRow extends OrderMetricValues {
  readonly businessDate: string;
  readonly key: string;
}

export interface CampaignDayRow {
  readonly businessDate: string;
  readonly campaignId: string | null;
  readonly spendPoisha: bigint;
  readonly ordersConfirmed: number;
  readonly ordersDelivered: number;
  readonly ordersReturned: number;
  readonly deliveredRevenuePoisha: bigint;
  readonly placedRevenuePoisha: bigint;
}

export interface AgentDayRow {
  readonly businessDate: string;
  readonly userId: string;
  readonly ordersConfirmed: number;
  readonly ordersDelivered: number;
  readonly deliveredRevenuePoisha: bigint;
  readonly pickupCount: number;
  readonly pickupSeconds: number;
}

/** Remove an org's rollup rows for `from`–`to` from all five tables, before they are rebuilt. */
export async function deleteDays(tx: Tx, orgId: string, from: string, to: string): Promise<void> {
  for (const table of [
    sql`analytics.daily_org`,
    sql`analytics.daily_branch`,
    sql`analytics.daily_channel`,
    sql`analytics.daily_campaign`,
    sql`analytics.daily_agent`,
  ]) {
    await tx.execute(sql`
      delete from ${table}
      where org_id = ${orgId} and business_date between ${from}::date and ${to}::date
    `);
  }
}

const metricValues = (row: OrderMetricValues) => sql`
  ${row.ordersPlaced}, ${row.ordersConfirmed}, ${row.ordersDelivered}, ${row.ordersReturned},
  ${row.ordersCancelled}, ${row.deliveredRevenuePoisha}, ${row.grossProfitPoisha},
  ${row.deliveredOutsideDhaka}, ${row.returnedOutsideDhaka}`;

const METRIC_COLUMNS = sql`orders_placed, orders_confirmed, orders_delivered, orders_returned,
  orders_cancelled, delivered_revenue_poisha, gross_profit_poisha, delivered_outside_dhaka,
  returned_outside_dhaka`;

export async function insertOrgDay(tx: Tx, orgId: string, row: OrgDayRow): Promise<void> {
  await tx.execute(sql`
    insert into analytics.daily_org
      (org_id, business_date, ${METRIC_COLUMNS}, spend_poisha, pickup_count, pickup_seconds)
    values (${orgId}, ${row.businessDate}::date, ${metricValues(row)}, ${row.spendPoisha},
            ${row.pickupCount}, ${row.pickupSeconds})
  `);
}

export async function insertBranchDay(tx: Tx, orgId: string, row: KeyedDayRow): Promise<void> {
  await tx.execute(sql`
    insert into analytics.daily_branch (org_id, business_date, branch_id, ${METRIC_COLUMNS})
    values (${orgId}, ${row.businessDate}::date, ${row.key}::uuid, ${metricValues(row)})
  `);
}

export async function insertChannelDay(tx: Tx, orgId: string, row: KeyedDayRow): Promise<void> {
  await tx.execute(sql`
    insert into analytics.daily_channel (org_id, business_date, channel, ${METRIC_COLUMNS})
    values (${orgId}, ${row.businessDate}::date, ${row.key}, ${metricValues(row)})
  `);
}

export async function insertCampaignDay(tx: Tx, orgId: string, row: CampaignDayRow): Promise<void> {
  await tx.execute(sql`
    insert into analytics.daily_campaign
      (org_id, business_date, campaign_id, spend_poisha, orders_confirmed, orders_delivered,
       orders_returned, delivered_revenue_poisha, placed_revenue_poisha)
    values (${orgId}, ${row.businessDate}::date, ${row.campaignId}::uuid, ${row.spendPoisha},
            ${row.ordersConfirmed}, ${row.ordersDelivered}, ${row.ordersReturned},
            ${row.deliveredRevenuePoisha}, ${row.placedRevenuePoisha})
  `);
}

export async function insertAgentDay(tx: Tx, orgId: string, row: AgentDayRow): Promise<void> {
  await tx.execute(sql`
    insert into analytics.daily_agent
      (org_id, business_date, user_id, orders_confirmed, orders_delivered,
       delivered_revenue_poisha, pickup_count, pickup_seconds)
    values (${orgId}, ${row.businessDate}::date, ${row.userId}, ${row.ordersConfirmed},
            ${row.ordersDelivered}, ${row.deliveredRevenuePoisha}, ${row.pickupCount},
            ${row.pickupSeconds})
  `);
}

// --- reading one brand (withOrg) ----------------------------------------------------

/** Order metrics as SQL sums, the shape every period read returns. */
const METRIC_SUMS = sql`
  coalesce(sum(orders_placed), 0)::int as orders_placed,
  coalesce(sum(orders_confirmed), 0)::int as orders_confirmed,
  coalesce(sum(orders_delivered), 0)::int as orders_delivered,
  coalesce(sum(orders_returned), 0)::int as orders_returned,
  coalesce(sum(orders_cancelled), 0)::int as orders_cancelled,
  coalesce(sum(delivered_revenue_poisha), 0)::text as delivered_revenue_poisha,
  coalesce(sum(gross_profit_poisha), 0)::text as gross_profit_poisha,
  coalesce(sum(delivered_outside_dhaka), 0)::int as delivered_outside_dhaka,
  coalesce(sum(returned_outside_dhaka), 0)::int as returned_outside_dhaka`;

export interface MetricSumRow extends Record<string, unknown> {
  readonly orders_placed: number;
  readonly orders_confirmed: number;
  readonly orders_delivered: number;
  readonly orders_returned: number;
  readonly orders_cancelled: number;
  readonly delivered_revenue_poisha: string;
  readonly gross_profit_poisha: string;
  readonly delivered_outside_dhaka: number;
  readonly returned_outside_dhaka: number;
}

export interface OrgDaySumRow extends OrgTotals {
  readonly business_date: string;
  readonly computed_at: Date | string | null;
}

/** The brand's days in a range, oldest first. Days never computed are absent. */
export async function orgDays(
  tx: Tx,
  orgId: string,
  from: string,
  to: string,
): Promise<OrgDaySumRow[]> {
  const rows = await tx.execute<OrgDaySumRow>(sql`
    select business_date::text as business_date, ${METRIC_SUMS},
           coalesce(sum(spend_poisha), 0)::text as spend_poisha,
           coalesce(sum(pickup_count), 0)::int as pickup_count,
           coalesce(sum(pickup_seconds), 0)::text as pickup_seconds,
           max(computed_at) as computed_at
    from analytics.daily_org
    where org_id = ${orgId} and business_date between ${from}::date and ${to}::date
    group by business_date
    order by business_date
  `);
  return [...rows];
}

export interface KeyedSumRow extends MetricSumRow {
  readonly key: string;
}

export async function channelSums(
  tx: Tx,
  orgId: string,
  from: string,
  to: string,
): Promise<KeyedSumRow[]> {
  const rows = await tx.execute<KeyedSumRow>(sql`
    select channel as key, ${METRIC_SUMS}
    from analytics.daily_channel
    where org_id = ${orgId} and business_date between ${from}::date and ${to}::date
    group by channel
    order by channel
  `);
  return [...rows];
}

export interface BranchSumRow extends KeyedSumRow {
  readonly name: string | null;
}

/** Per branch, with its name from the global `org` schema (same org, through RLS). */
export async function branchSums(
  tx: Tx,
  orgId: string,
  from: string,
  to: string,
): Promise<BranchSumRow[]> {
  const rows = await tx.execute<BranchSumRow>(sql`
    select d.branch_id::text as key, min(b.name) as name, ${METRIC_SUMS}
    from analytics.daily_branch d
    left join org.branches b on b.org_id = d.org_id and b.id = d.branch_id
    where d.org_id = ${orgId} and d.business_date between ${from}::date and ${to}::date
    group by d.branch_id
    order by min(b.name), d.branch_id
  `);
  return [...rows];
}

export interface CampaignSumRow extends Record<string, unknown> {
  readonly campaign_id: string | null;
  readonly spend_poisha: string;
  readonly orders_confirmed: number;
  readonly orders_delivered: number;
  readonly orders_returned: number;
  readonly delivered_revenue_poisha: string;
  readonly placed_revenue_poisha: string;
}

export async function campaignSums(
  tx: Tx,
  orgId: string,
  from: string,
  to: string,
): Promise<CampaignSumRow[]> {
  const rows = await tx.execute<CampaignSumRow>(sql`
    select campaign_id::text as campaign_id,
           coalesce(sum(spend_poisha), 0)::text as spend_poisha,
           coalesce(sum(orders_confirmed), 0)::int as orders_confirmed,
           coalesce(sum(orders_delivered), 0)::int as orders_delivered,
           coalesce(sum(orders_returned), 0)::int as orders_returned,
           coalesce(sum(delivered_revenue_poisha), 0)::text as delivered_revenue_poisha,
           coalesce(sum(placed_revenue_poisha), 0)::text as placed_revenue_poisha
    from analytics.daily_campaign
    where org_id = ${orgId} and business_date between ${from}::date and ${to}::date
    group by campaign_id
    order by sum(spend_poisha) desc, campaign_id nulls last
  `);
  return [...rows];
}

export interface AgentSumRow extends Record<string, unknown> {
  readonly user_id: string;
  readonly orders_confirmed: number;
  readonly orders_delivered: number;
  readonly delivered_revenue_poisha: string;
  readonly pickup_count: number;
  readonly pickup_seconds: string;
}

export async function agentSums(
  tx: Tx,
  orgId: string,
  from: string,
  to: string,
): Promise<AgentSumRow[]> {
  const rows = await tx.execute<AgentSumRow>(sql`
    select user_id,
           coalesce(sum(orders_confirmed), 0)::int as orders_confirmed,
           coalesce(sum(orders_delivered), 0)::int as orders_delivered,
           coalesce(sum(delivered_revenue_poisha), 0)::text as delivered_revenue_poisha,
           coalesce(sum(pickup_count), 0)::int as pickup_count,
           coalesce(sum(pickup_seconds), 0)::text as pickup_seconds
    from analytics.daily_agent
    where org_id = ${orgId} and business_date between ${from}::date and ${to}::date
    group by user_id
    order by sum(delivered_revenue_poisha) desc, user_id
  `);
  return [...rows];
}

// --- the narrative cache (withOrg) --------------------------------------------------

export interface NarrativeRow extends Record<string, unknown> {
  readonly body: string;
  readonly provider: string;
  readonly generated_on: string;
  readonly created_at: Date | string;
}

export async function narrativeFor(
  tx: Tx,
  orgId: string,
  month: string,
  generatedOn: string,
): Promise<NarrativeRow | undefined> {
  const rows = await tx.execute<NarrativeRow>(sql`
    select body, provider, generated_on::text as generated_on, created_at
    from analytics.narratives
    where org_id = ${orgId} and month = ${month} and generated_on = ${generatedOn}::date
  `);
  return rows[0];
}

/** First writer wins: two people opening the dashboard at once cache one narrative. */
export async function insertNarrative(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly month: string;
    readonly generatedOn: string;
    readonly provider: string;
    readonly payloadSha256: string;
    readonly body: string;
    readonly createdBy: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into analytics.narratives
      (org_id, month, generated_on, provider, payload_sha256, body, created_by)
    values (${input.orgId}, ${input.month}, ${input.generatedOn}::date, ${input.provider},
            ${input.payloadSha256}, ${input.body}, ${input.createdBy})
    on conflict (org_id, month, generated_on) do nothing
  `);
}

// --- every brand (withAnalytics only) ---------------------------------------------

export interface BrandSumRow extends OrgTotals {
  readonly org_id: string;
  readonly org_name: string;
}

/**
 * Every active brand's sums for a range, a brand with no rows included as zeros. A training
 * brand is left out, as the consolidated wallet total leaves it out: its figures are
 * practice. Through `erp_analytics` only: under `erp_app` RLS would show one brand and
 * call it the group.
 */
export async function brandSums(tx: Tx, from: string, to: string): Promise<BrandSumRow[]> {
  const rows = await tx.execute<BrandSumRow>(sql`
    select o.id as org_id, o.display_name as org_name,
           coalesce(sum(d.orders_placed), 0)::int as orders_placed,
           coalesce(sum(d.orders_confirmed), 0)::int as orders_confirmed,
           coalesce(sum(d.orders_delivered), 0)::int as orders_delivered,
           coalesce(sum(d.orders_returned), 0)::int as orders_returned,
           coalesce(sum(d.orders_cancelled), 0)::int as orders_cancelled,
           coalesce(sum(d.delivered_revenue_poisha), 0)::text as delivered_revenue_poisha,
           coalesce(sum(d.gross_profit_poisha), 0)::text as gross_profit_poisha,
           coalesce(sum(d.delivered_outside_dhaka), 0)::int as delivered_outside_dhaka,
           coalesce(sum(d.returned_outside_dhaka), 0)::int as returned_outside_dhaka,
           coalesce(sum(d.spend_poisha), 0)::text as spend_poisha,
           coalesce(sum(d.pickup_count), 0)::int as pickup_count,
           coalesce(sum(d.pickup_seconds), 0)::text as pickup_seconds
    from org.organizations o
    left join analytics.daily_org d
      on d.org_id = o.id and d.business_date between ${from}::date and ${to}::date
    where o.is_active and not o.is_training
    group by o.id, o.display_name
    order by o.display_name, o.id
  `);
  return [...rows];
}

// --- summing rows that were already read ----------------------------------------------

/** A brand's figures over a period: the order sums plus spend and pickups. */
export interface OrgTotals extends MetricSumRow {
  readonly spend_poisha: string;
  readonly pickup_count: number;
  readonly pickup_seconds: string;
}

export const ZERO_BRAND: OrgTotals = {
  orders_placed: 0,
  orders_confirmed: 0,
  orders_delivered: 0,
  orders_returned: 0,
  orders_cancelled: 0,
  delivered_revenue_poisha: '0',
  gross_profit_poisha: '0',
  delivered_outside_dhaka: 0,
  returned_outside_dhaka: 0,
  spend_poisha: '0',
  pickup_count: 0,
  pickup_seconds: '0',
};

/** Add up rows of the same shape, exactly (integers and bigints, never floats). */
export function sumTotals(rows: readonly OrgTotals[]): OrgTotals {
  const big = (pick: (row: OrgTotals) => string) =>
    rows.reduce((total, row) => total + BigInt(pick(row)), 0n).toString();
  const int = (pick: (row: OrgTotals) => number) =>
    rows.reduce((total, row) => total + pick(row), 0);
  return {
    orders_placed: int((row) => row.orders_placed),
    orders_confirmed: int((row) => row.orders_confirmed),
    orders_delivered: int((row) => row.orders_delivered),
    orders_returned: int((row) => row.orders_returned),
    orders_cancelled: int((row) => row.orders_cancelled),
    delivered_revenue_poisha: big((row) => row.delivered_revenue_poisha),
    gross_profit_poisha: big((row) => row.gross_profit_poisha),
    delivered_outside_dhaka: int((row) => row.delivered_outside_dhaka),
    returned_outside_dhaka: int((row) => row.returned_outside_dhaka),
    spend_poisha: big((row) => row.spend_poisha),
    pickup_count: int((row) => row.pickup_count),
    pickup_seconds: big((row) => row.pickup_seconds),
  };
}
