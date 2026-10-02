import { sql } from 'drizzle-orm';
import type { Tx } from '@elysium/db';

/**
 * Every query the promo module runs (architecture §10; M16).
 *
 * Raw SQL, parameterized, in one file, filtering on `org_id` even though RLS already
 * does — the rule the rest of this repo keeps, for the day somebody runs one of these as
 * `erp_owner` in a script.
 *
 * The one piece of real concurrency control in this module is `claimUse`. Everything else
 * is a read or an append.
 *
 * Nothing here reads another module's tables. A code scoped to a category needs each
 * SKU's category, and that comes from `CatalogApi.skusByIds` — invariant 12, which
 * `../module-boundaries.test.ts` enforces.
 */

export interface PromoCodeRow extends Record<string, unknown> {
  readonly id: string;
  readonly code: string;
  readonly kind: string;
  readonly value_bps: number;
  readonly value_poisha: string;
  readonly min_order_poisha: string | null;
  readonly max_discount_poisha: string | null;
  readonly total_limit: number | null;
  readonly per_customer_limit: number | null;
  readonly used_count: number;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly channels: unknown;
  readonly sku_ids: unknown;
  readonly category_ids: unknown;
  readonly customer_id: string | null;
  readonly campaign_id: string | null;
  readonly origin: string;
  readonly status: string;
  readonly created_by: string;
  readonly created_at: Date;
}

const CODE_COLUMNS = sql`
  c.id, c.code, c.kind, c.value_bps, c.value_poisha::text, c.min_order_poisha::text,
  c.max_discount_poisha::text, c.total_limit, c.per_customer_limit, c.used_count,
  c.valid_from, c.valid_to, c.channels, c.sku_ids, c.category_ids, c.customer_id,
  c.campaign_id, c.origin, c.status, c.created_by, c.created_at
`;

/** One code by its word. Case-insensitive, because people type codes however they like. */
export async function codeByWord(
  tx: Tx,
  orgId: string,
  code: string,
): Promise<PromoCodeRow | undefined> {
  const rows = await tx.execute<PromoCodeRow>(sql`
    select ${CODE_COLUMNS} from promo.codes c
    where c.org_id = ${orgId} and c.code = ${code.trim().toUpperCase()}
  `);
  return rows[0];
}

export async function codeById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<PromoCodeRow | undefined> {
  const rows = await tx.execute<PromoCodeRow>(sql`
    select ${CODE_COLUMNS} from promo.codes c
    where c.org_id = ${orgId} and c.id = ${id}
  `);
  return rows[0];
}

export async function listCodes(
  tx: Tx,
  orgId: string,
  filters: { readonly status?: string | undefined; readonly limit: number },
): Promise<PromoCodeRow[]> {
  const rows = await tx.execute<PromoCodeRow>(sql`
    select ${CODE_COLUMNS} from promo.codes c
    where c.org_id = ${orgId}
      and ${filters.status === undefined ? sql`true` : sql`c.status = ${filters.status}`}
    order by c.created_at desc, c.code
    limit ${filters.limit}
  `);
  return [...rows];
}

export interface NewPromoCode {
  readonly orgId: string;
  readonly code: string;
  readonly kind: string;
  readonly valueBps: number;
  readonly valuePoisha: bigint;
  readonly minOrderPoisha: bigint | null;
  readonly maxDiscountPoisha: bigint | null;
  readonly totalLimit: number | null;
  readonly perCustomerLimit: number | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly channels: readonly string[];
  readonly skuIds: readonly string[];
  readonly categoryIds: readonly string[];
  readonly customerId: string | null;
  readonly campaignId: string | null;
  readonly origin: string;
  readonly createdBy: string;
}

/**
 * Insert a code, or nothing when the brand already has that word.
 *
 * `on conflict do nothing` rather than a read followed by an insert: the unique index on
 * `(org_id, code)` is the only thing that can decide this without a race, and two people
 * creating `EID25` at once must not become two rows.
 */
export async function insertCode(tx: Tx, input: NewPromoCode): Promise<string | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into promo.codes (
      org_id, code, kind, value_bps, value_poisha, min_order_poisha, max_discount_poisha,
      total_limit, per_customer_limit, valid_from, valid_to, channels, sku_ids,
      category_ids, customer_id, campaign_id, origin, created_by)
    values (
      ${input.orgId}, ${input.code}, ${input.kind}, ${input.valueBps},
      ${input.valuePoisha.toString()}, ${input.minOrderPoisha?.toString() ?? null},
      ${input.maxDiscountPoisha?.toString() ?? null}, ${input.totalLimit},
      ${input.perCustomerLimit}, ${input.validFrom}, ${input.validTo},
      ${JSON.stringify([...input.channels])}::jsonb,
      ${JSON.stringify([...input.skuIds])}::jsonb,
      ${JSON.stringify([...input.categoryIds])}::jsonb,
      ${input.customerId}, ${input.campaignId}, ${input.origin}, ${input.createdBy})
    on conflict (org_id, code) do nothing
    returning id
  `);
  return rows[0]?.id;
}

/** Only the status moves after a code exists: its terms are what buyers were told. */
export async function setCodeStatus(
  tx: Tx,
  orgId: string,
  id: string,
  status: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update promo.codes set status = ${status}, updated_at = now()
    where org_id = ${orgId} and id = ${id}
    returning id
  `);
  return rows.length > 0;
}

/** This buyer's applied redemptions of this code, and everybody's. */
export async function usageOf(
  tx: Tx,
  orgId: string,
  codeId: string,
  customerId: string | null,
): Promise<{ total: number; byCustomer: number }> {
  const rows = await tx.execute<{ total: number; by_customer: number }>(sql`
    select count(*)::int as total,
           count(*) filter (
             where ${customerId === null ? sql`false` : sql`r.customer_id = ${customerId}`}
           )::int as by_customer
    from promo.redemptions r
    where r.org_id = ${orgId} and r.code_id = ${codeId} and r.status = 'applied'
  `);
  return { total: rows[0]?.total ?? 0, byCustomer: rows[0]?.by_customer ?? 0 };
}

/**
 * Take one use of a code, or refuse because the last one has gone.
 *
 * The whole of the limit's concurrency control, and the reason it is a conditional UPDATE
 * rather than a read and a write: two orders claiming the last use of a code arrive at the
 * same moment, both read `used_count = 9` against a limit of 10, and both proceed. Here
 * the second one's `where` finds no row and it is told the code is finished — the same
 * shape invariant 3 requires of a stock reservation, and for the same reason.
 *
 * Returns the new count and the code's per-buyer limit, or undefined when the code is
 * gone, archived or exhausted. The UPDATE also leaves this transaction holding the code's
 * row lock until it ends, which is what makes `appliedByCustomer` after it a safe re-count.
 */
export async function claimUse(
  tx: Tx,
  orgId: string,
  codeId: string,
): Promise<{ readonly usedCount: number; readonly perCustomerLimit: number | null } | undefined> {
  const rows = await tx.execute<{ used_count: number; per_customer_limit: number | null }>(sql`
    update promo.codes
    set used_count = used_count + 1, updated_at = now()
    where org_id = ${orgId} and id = ${codeId} and status = 'active'
      and (total_limit is null or used_count < total_limit)
    returning used_count, per_customer_limit
  `);
  const row = rows[0];
  return row === undefined
    ? undefined
    : { usedCount: row.used_count, perCustomerLimit: row.per_customer_limit };
}

/**
 * This buyer's applied redemptions of a code, other than the one for `orderId`.
 *
 * Read after `claimUse`, under the code's row lock: a concurrent order for the same buyer
 * either committed before this transaction got the lock — and READ COMMITTED's next
 * statement sees its redemption — or is waiting behind it. The order's own redemption is
 * left out so a retried submission is still recognised as a replay.
 */
export async function appliedByCustomer(
  tx: Tx,
  orgId: string,
  codeId: string,
  customerId: string,
  orderId: string | null,
): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from promo.redemptions
    where org_id = ${orgId} and code_id = ${codeId} and customer_id = ${customerId}
      and status = 'applied'
      and ${orderId === null ? sql`true` : sql`order_id is distinct from ${orderId}`}
  `);
  return rows[0]?.n ?? 0;
}

/** Give a use back when a redemption is released. Never below zero. */
export async function releaseUse(tx: Tx, orgId: string, codeId: string): Promise<void> {
  await tx.execute(sql`
    update promo.codes
    set used_count = greatest(used_count - 1, 0), updated_at = now()
    where org_id = ${orgId} and id = ${codeId}
  `);
}

export interface NewRedemption {
  readonly orgId: string;
  readonly codeId: string;
  readonly orderId: string | null;
  readonly posSaleId: string | null;
  readonly customerId: string | null;
  readonly discountPoisha: bigint;
  readonly deliveryDiscountPoisha: bigint;
}

/**
 * Record the discount a buyer was given, or find the one already recorded.
 *
 * `on conflict do nothing` against the unique index per (code, order): a retried order
 * submission must apply the code once, and the second attempt gets `undefined` and
 * returns the use it claimed.
 */
export async function insertRedemption(tx: Tx, input: NewRedemption): Promise<string | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into promo.redemptions (
      org_id, code_id, order_id, pos_sale_id, customer_id, discount_poisha,
      delivery_discount_poisha)
    values (${input.orgId}, ${input.codeId}, ${input.orderId}, ${input.posSaleId},
            ${input.customerId}, ${input.discountPoisha.toString()},
            ${input.deliveryDiscountPoisha.toString()})
    on conflict do nothing
    returning id
  `);
  return rows[0]?.id;
}

export interface RedemptionRow extends Record<string, unknown> {
  readonly id: string;
  readonly code_id: string;
  readonly order_id: string | null;
  readonly pos_sale_id: string | null;
  readonly customer_id: string | null;
  readonly discount_poisha: string;
  readonly delivery_discount_poisha: string;
  readonly status: string;
}

/** The applied redemption against an order, if the order carried a code. */
export async function appliedForOrder(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<RedemptionRow | undefined> {
  const rows = await tx.execute<RedemptionRow>(sql`
    select id, code_id, order_id, pos_sale_id, customer_id, discount_poisha::text,
           delivery_discount_poisha::text, status
    from promo.redemptions
    where org_id = ${orgId} and order_id = ${orderId} and status = 'applied'
  `);
  return rows[0];
}

/**
 * Mark a redemption released. Conditional on it still being applied, so a cancel
 * delivered twice gives the use back once — the trigger in 0079 refuses the second
 * transition anyway, and this means the service never reaches it.
 */
export async function releaseRedemption(tx: Tx, orgId: string, id: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update promo.redemptions
    set status = 'released', released_at = now(), updated_at = now()
    where org_id = ${orgId} and id = ${id} and status = 'applied'
    returning id
  `);
  return rows.length > 0;
}

/** Redemptions of one code, newest first, for the console's detail screen. */
export async function listRedemptions(
  tx: Tx,
  orgId: string,
  codeId: string,
  limit: number,
): Promise<RedemptionRow[]> {
  const rows = await tx.execute<RedemptionRow>(sql`
    select id, code_id, order_id, pos_sale_id, customer_id, discount_poisha::text,
           delivery_discount_poisha::text, status
    from promo.redemptions
    where org_id = ${orgId} and code_id = ${codeId}
    order by created_at desc
    limit ${limit}
  `);
  return [...rows];
}

/** Code id → campaign id, for the codes that name a campaign (M18, D-251). */
export async function campaignsOfCodes(
  tx: Tx,
  orgId: string,
  codeIds: readonly string[],
): Promise<Map<string, string>> {
  if (codeIds.length === 0) return new Map();
  const rows = await tx.execute<{ id: string; campaign_id: string }>(sql`
    select id, campaign_id from promo.codes
    where org_id = ${orgId} and campaign_id is not null
      and id in (${sql.join(
        codeIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  `);
  return new Map([...rows].map((row) => [row.id, row.campaign_id]));
}
