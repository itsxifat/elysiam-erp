import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '@elysium/db';

/**
 * The CRM's queries (M16; architecture §10 "Buyer profiles").
 *
 * In the orders module because the buyer is its row: `sales.customers`, the orders that
 * make a buyer's history, and the two CRM tables M16 added beside them — segments and the
 * occasions already greeted — all live in `sales`, which this module owns. Promo codes and
 * messages belong to other modules and are reached through `PROMO_PORT` and `NOTIFY_PORT`,
 * never by reading their tables (invariant 12, `module-boundaries.test.ts`).
 */

export interface OccasionBuyerRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  /** E.164; the address a greeting goes to. Never logged unmasked (invariant 10). */
  readonly phone_e164: string;
  readonly birthday: string | null;
  readonly anniversary: string | null;
}

/** Every buyer with a birthday or an anniversary on file. The domain decides who is due. */
export async function buyersWithOccasions(tx: Tx, orgId: string): Promise<OccasionBuyerRow[]> {
  const rows = await tx.execute<OccasionBuyerRow>(sql`
    select id, name, phone_e164, birthday::text as birthday, anniversary::text as anniversary
    from sales.customers
    where org_id = ${orgId} and (birthday is not null or anniversary is not null)
  `);
  return [...rows];
}

/** Whether this buyer has been greeted for this occasion this year. The fast path only. */
export async function occasionIssued(
  tx: Tx,
  orgId: string,
  customerId: string,
  occasion: string,
  year: number,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from sales.occasion_issues
    where org_id = ${orgId} and customer_id = ${customerId}
      and occasion = ${occasion} and year = ${year}
  `);
  return rows.length > 0;
}

/**
 * Record a greeting, once and for good.
 *
 * Deliberately **not** `on conflict do nothing`. The unique index on
 * `(org, customer, occasion, year)` is what makes check 2 true, and a conflict here has to
 * roll back the code and the message written earlier in the same transaction — which
 * only happens if this statement fails. Swallowing the conflict would commit an orphan
 * code and a queued message for a buyer who was already greeted. The row is immutable
 * after insert (0079), so it carries its code and message from the start.
 */
export async function insertOccasionIssue(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly occasion: string;
    readonly year: number;
    readonly promoCodeId: string;
    readonly messageId: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into sales.occasion_issues (org_id, customer_id, occasion, year, promo_code_id, message_id)
    values (${input.orgId}, ${input.customerId}, ${input.occasion}, ${input.year},
            ${input.promoCodeId}, ${input.messageId})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('an occasion issue insert returned no row');
  return id;
}

export interface ActivityRow extends Record<string, unknown> {
  readonly id: string;
  /** Asia/Dhaka calendar date of the last delivered order, or null. */
  readonly last_delivered_on: string | null;
  readonly delivered_count: number;
  readonly ltv_poisha: string;
}

/**
 * What RFM is computed from, per buyer.
 *
 * Frequency and value come from the counters the order transitions maintain, so a nightly
 * run over a brand's whole buyer list does not sum every order it ever took. Recency is the
 * last *delivered* order's date, because that is the domain's definition: a buyer whose
 * last three orders were all returned has not bought anything recently.
 */
export async function buyerActivity(tx: Tx, orgId: string): Promise<ActivityRow[]> {
  const rows = await tx.execute<ActivityRow>(sql`
    select c.id,
           (select (max(o.delivered_at) at time zone 'Asia/Dhaka')::date::text
              from sales.orders o
             where o.org_id = c.org_id and o.customer_id = c.id
               and o.delivered_at is not null) as last_delivered_on,
           c.delivered_count,
           c.ltv_poisha::text as ltv_poisha
    from sales.customers c
    where c.org_id = ${orgId}
  `);
  return [...rows];
}

/** One buyer's segment, replaced by the night's run. */
export async function upsertSegment(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly recency: number;
    readonly frequency: number;
    readonly monetary: number;
    readonly segment: string;
    readonly computedOn: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into sales.customer_segments
      (org_id, customer_id, recency, frequency, monetary, segment, computed_on)
    values (${input.orgId}, ${input.customerId}, ${input.recency}, ${input.frequency},
            ${input.monetary}, ${input.segment}, ${input.computedOn})
    on conflict (org_id, customer_id) do update
      set recency = excluded.recency, frequency = excluded.frequency,
          monetary = excluded.monetary, segment = excluded.segment,
          computed_on = excluded.computed_on, updated_at = now()
  `);
}

export interface SegmentRow extends Record<string, unknown> {
  readonly recency: number;
  readonly frequency: number;
  readonly monetary: number;
  readonly segment: string;
  readonly computed_on: string;
}

export async function segmentOf(
  tx: Tx,
  orgId: string,
  customerId: string,
): Promise<SegmentRow | undefined> {
  const rows = await tx.execute<SegmentRow>(sql`
    select recency, frequency, monetary, segment, computed_on::text as computed_on
    from sales.customer_segments
    where org_id = ${orgId} and customer_id = ${customerId}
  `);
  return rows[0];
}

export interface OccasionIssueRow extends Record<string, unknown> {
  readonly occasion: string;
  readonly year: number;
  readonly promo_code_id: string | null;
  readonly created_at: Date;
}

/** The greetings a buyer has been sent, newest first, for the profile. */
export async function occasionsOf(
  tx: Tx,
  orgId: string,
  customerId: string,
): Promise<OccasionIssueRow[]> {
  const rows = await tx.execute<OccasionIssueRow>(sql`
    select occasion, year, promo_code_id, created_at
    from sales.occasion_issues
    where org_id = ${orgId} and customer_id = ${customerId}
    order by created_at desc
    limit 20
  `);
  return [...rows];
}

/**
 * Units a buyer kept, per SKU: the delivered quantity on delivered orders.
 *
 * What the profile's favourite categories and sizes are ranked from. Delivered, because a
 * parcel refused at the door is not a preference.
 */
export async function keptUnitsBySku(
  tx: Tx,
  orgId: string,
  customerId: string,
): Promise<{ sku_id: string; units: number }[]> {
  const rows = await tx.execute<{ sku_id: string; units: number }>(sql`
    select l.sku_id, sum(l.delivered_qty)::int as units
    from sales.orders o
    join sales.order_lines l on l.org_id = o.org_id and l.order_id = o.id
    where o.org_id = ${orgId} and o.customer_id = ${customerId}
      and o.delivered_at is not null and l.delivered_qty > 0
    group by l.sku_id
  `);
  return [...rows];
}

export interface ProfileOrderRow extends Record<string, unknown> {
  readonly id: string;
  readonly order_no: string;
  readonly status: string;
  readonly channel: string;
  readonly cod_amount_poisha: string;
  readonly created_at: string;
}

/** A buyer's latest orders that the caller may see (`scope` is the §6 filter over `o`). */
export async function recentOrders(
  tx: Tx,
  orgId: string,
  customerId: string,
  scope: SQL,
  limit: number,
): Promise<ProfileOrderRow[]> {
  const rows = await tx.execute<ProfileOrderRow>(sql`
    select o.id, o.order_no, o.status::text as status, o.channel::text as channel,
           o.cod_amount_poisha::text as cod_amount_poisha, o.created_at
    from sales.orders o
    where o.org_id = ${orgId} and o.customer_id = ${customerId} and ${scope}
    order by o.created_at desc, o.id
    limit ${limit}
  `);
  return [...rows];
}

export interface ReengagementFilters {
  /** Buyers whose last order is on or before this Asia/Dhaka date. */
  readonly lastOrderOnOrBefore: string;
  readonly minDelivered: number;
  readonly segment?: string | undefined;
  /** E.164 numbers to leave out: everyone who opted out of marketing SMS. */
  readonly excludePhones: readonly string[];
}

/**
 * Who has not bought for a while (architecture §10 "Re-engagement lists").
 *
 * **A lapsed buyer** has at least `minDelivered` delivered orders, and their latest order
 * that was not cancelled was placed on or before the cut-off, by the Dhaka calendar. The
 * latest *placed* order rather than the latest delivered one: somebody whose parcel is on a
 * van today has bought, and texting them "we miss you" is the wrong message. A cancelled
 * order does not count as buying, for the reason the buyer list gives.
 *
 * One definition for the page, the count and the file, as in `buyers.repository.ts`.
 */
function lapsedSql(orgId: string, filters: ReengagementFilters, scope: SQL): SQL {
  return sql`
    with activity as (
      select o.customer_id,
             max((o.created_at at time zone 'Asia/Dhaka')::date) as last_order_on
      from sales.orders o
      where o.org_id = ${orgId} and o.status <> 'cancelled' and ${scope}
      group by o.customer_id
    )
    select c.id as customer_id, c.name, c.phone_e164, c.delivered_count,
           c.ltv_poisha::text as ltv_poisha, a.last_order_on::text as last_order_on,
           s.segment
    from activity a
    join sales.customers c on c.org_id = ${orgId} and c.id = a.customer_id
    left join sales.customer_segments s on s.org_id = c.org_id and s.customer_id = c.id
    where a.last_order_on <= ${filters.lastOrderOnOrBefore}::date
      and c.delivered_count >= ${filters.minDelivered}
      and ${filters.segment === undefined ? sql`true` : sql`s.segment = ${filters.segment}`}
      and c.phone_e164 <> all (${sql.param([...filters.excludePhones])}::text[])`;
}

export interface LapsedRow extends Record<string, unknown> {
  readonly customer_id: string;
  readonly name: string;
  readonly phone_e164: string;
  readonly delivered_count: number;
  readonly ltv_poisha: string;
  readonly last_order_on: string;
  readonly segment: string | null;
}

/** The page, or with `page` null the whole list (the export). Longest-lapsed last. */
export async function lapsedRows(
  tx: Tx,
  orgId: string,
  filters: ReengagementFilters,
  scope: SQL,
  page: { readonly limit: number; readonly offset: number } | null,
): Promise<LapsedRow[]> {
  const rows = await tx.execute<LapsedRow>(sql`
    select * from (${lapsedSql(orgId, filters, scope)}) lapsed
    order by last_order_on desc, customer_id
    ${page === null ? sql`` : sql`limit ${page.limit} offset ${page.offset}`}
  `);
  return [...rows];
}

export async function lapsedCount(
  tx: Tx,
  orgId: string,
  filters: ReengagementFilters,
  scope: SQL,
): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from (${lapsedSql(orgId, filters, scope)}) lapsed
  `);
  return rows[0]?.n ?? 0;
}
