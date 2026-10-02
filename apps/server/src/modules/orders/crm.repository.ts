import { sql } from 'drizzle-orm';
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
