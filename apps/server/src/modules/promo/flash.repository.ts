import { sql } from 'drizzle-orm';
import type { Tx } from '@elysium/db';

/**
 * Every query for flash sales (M35a, D-542; architecture §10).
 *
 * Two of them are the concurrency control, and both are single conditional statements:
 *
 * - `claimUnits` takes units with `units_sold + qty <= unit_limit` (and the sale live, and
 *   the price the caller charges still the sale price) in the UPDATE's own `where`. Twenty
 *   buyers racing for the last five units resolve against the row lock: the sixth finds no
 *   row and is refused. Nothing reads the count and then writes it (invariant 3's shape).
 * - `releaseClaim` marks a claim released only while it is still `claimed`, so a cancel
 *   delivered twice gives the units back once.
 */

export interface FlashSaleRow extends Record<string, unknown> {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly description: string;
  readonly slug: string;
  readonly banner_file_id: string | null;
  readonly enabled: boolean;
  readonly show_on_home: boolean;
  readonly priority: number;
  /** `timestamptz` arrives from a raw query as text; the service reads it with `instant()`. */
  readonly starts_at: string | Date | null;
  readonly ends_at: string | Date | null;
  readonly created_at: string | Date;
  readonly updated_at: string | Date;
}

const SALE_COLUMNS = sql`
  s.id, s.title, s.subtitle, s.description, s.slug, s.banner_file_id, s.enabled,
  s.show_on_home, s.priority, s.starts_at, s.ends_at, s.created_at, s.updated_at
`;

export interface FlashSaleSummaryRow extends FlashSaleRow {
  readonly skus: number;
  readonly units_sold: number;
  /** Null when any SKU on sale offers all its stock. */
  readonly units_offered: number | null;
}

/** The brand's sales, newest first, each with what is on it and what it has sold. */
export async function listSales(
  tx: Tx,
  orgId: string,
  limit: number,
): Promise<FlashSaleSummaryRow[]> {
  const rows = await tx.execute<FlashSaleSummaryRow>(sql`
    select ${SALE_COLUMNS},
           count(i.id) filter (where i.enabled)::int as skus,
           coalesce(sum(i.units_sold), 0)::int as units_sold,
           case when bool_or(i.enabled and i.unit_limit is null) then null
                else coalesce(sum(i.unit_limit) filter (where i.enabled), 0)::int end
             as units_offered
    from promo.flash_sales s
    left join promo.flash_sale_items i on i.org_id = s.org_id and i.flash_sale_id = s.id
    where s.org_id = ${orgId}
    group by s.id
    order by s.created_at desc, s.id
    limit ${limit}
  `);
  return [...rows];
}

export async function saleById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<FlashSaleRow | undefined> {
  const rows = await tx.execute<FlashSaleRow>(sql`
    select ${SALE_COLUMNS} from promo.flash_sales s
    where s.org_id = ${orgId} and s.id = ${id}
  `);
  return rows[0];
}

export interface FlashItemRow extends Record<string, unknown> {
  readonly id: string;
  readonly flash_sale_id: string;
  readonly sku_id: string;
  readonly sale_price_poisha: string;
  readonly unit_limit: number | null;
  readonly units_sold: number;
  readonly enabled: boolean;
}

/** A sale's SKUs, switched-on first, then the switched-off ones (they may have sold units). */
export async function itemsOfSale(tx: Tx, orgId: string, saleId: string): Promise<FlashItemRow[]> {
  const rows = await tx.execute<FlashItemRow>(sql`
    select id, flash_sale_id, sku_id, sale_price_poisha::text, unit_limit, units_sold, enabled
    from promo.flash_sale_items
    where org_id = ${orgId} and flash_sale_id = ${saleId}
    order by enabled desc, created_at, sku_id
  `);
  return [...rows];
}

export interface NewFlashSale {
  readonly orgId: string;
  readonly title: string;
  readonly subtitle: string;
  readonly description: string;
  readonly slug: string;
  readonly bannerFileId: string | null;
  readonly enabled: boolean;
  readonly showOnHome: boolean;
  readonly priority: number;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly createdBy: string;
}

/** Insert a sale, or nothing when the brand already has that slug. */
export async function insertSale(tx: Tx, input: NewFlashSale): Promise<string | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into promo.flash_sales (
      org_id, title, subtitle, description, slug, banner_file_id, enabled, show_on_home,
      priority, starts_at, ends_at, created_by)
    values (
      ${input.orgId}, ${input.title}, ${input.subtitle}, ${input.description}, ${input.slug},
      ${input.bannerFileId}, ${input.enabled}, ${input.showOnHome}, ${input.priority},
      ${input.startsAt?.toISOString() ?? null}::timestamptz,
      ${input.endsAt?.toISOString() ?? null}::timestamptz, ${input.createdBy})
    on conflict (org_id, slug) do nothing
    returning id
  `);
  return rows[0]?.id;
}

/**
 * Change a sale's terms. False when the slug is another sale's: the unique index decides,
 * and the caller's transaction rolls back nothing it has not already refused.
 */
export async function updateSale(
  tx: Tx,
  orgId: string,
  id: string,
  input: Omit<NewFlashSale, 'orgId' | 'createdBy'>,
): Promise<'updated' | 'missing' | 'slug_taken'> {
  const taken = await tx.execute<{ id: string }>(sql`
    select id from promo.flash_sales
    where org_id = ${orgId} and slug = ${input.slug} and id <> ${id}
  `);
  if (taken.length > 0) return 'slug_taken';
  const rows = await tx.execute<{ id: string }>(sql`
    update promo.flash_sales set
      title = ${input.title}, subtitle = ${input.subtitle}, description = ${input.description},
      slug = ${input.slug}, banner_file_id = ${input.bannerFileId}, enabled = ${input.enabled},
      show_on_home = ${input.showOnHome}, priority = ${input.priority},
      starts_at = ${input.startsAt?.toISOString() ?? null}::timestamptz,
      ends_at = ${input.endsAt?.toISOString() ?? null}::timestamptz, updated_at = now()
    where org_id = ${orgId} and id = ${id}
    returning id
  `);
  return rows.length > 0 ? 'updated' : 'missing';
}

export async function setSaleEnabled(
  tx: Tx,
  orgId: string,
  id: string,
  enabled: boolean,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update promo.flash_sales set enabled = ${enabled}, updated_at = now()
    where org_id = ${orgId} and id = ${id}
    returning id
  `);
  return rows.length > 0;
}

/** Whether a slug is free in this brand. A hint for choosing one; the unique index decides. */
export async function slugTaken(tx: Tx, orgId: string, slug: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from promo.flash_sales where org_id = ${orgId} and slug = ${slug}
  `);
  return rows.length > 0;
}

/**
 * Put a SKU on a sale, or change its price and limit, and switch it on.
 *
 * `units_sold` is never written here: an edit cannot reset what sold. A limit below what has
 * already sold breaks `flash_sale_items_sold_within_limit`, which the service reports.
 */
export async function upsertItem(
  tx: Tx,
  orgId: string,
  saleId: string,
  item: {
    readonly skuId: string;
    readonly salePricePoisha: bigint;
    readonly unitLimit: number | null;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into promo.flash_sale_items (
      org_id, flash_sale_id, sku_id, sale_price_poisha, unit_limit, enabled)
    values (${orgId}, ${saleId}, ${item.skuId}, ${item.salePricePoisha.toString()},
            ${item.unitLimit}, true)
    on conflict (org_id, flash_sale_id, sku_id) do update set
      sale_price_poisha = excluded.sale_price_poisha,
      unit_limit = excluded.unit_limit,
      enabled = true,
      updated_at = now()
  `);
}

/** Switch off the sale's SKUs that are not in `keep`; they stay, with what they sold. */
export async function disableItemsExcept(
  tx: Tx,
  orgId: string,
  saleId: string,
  keep: readonly string[],
): Promise<void> {
  await tx.execute(sql`
    update promo.flash_sale_items set enabled = false, updated_at = now()
    where org_id = ${orgId} and flash_sale_id = ${saleId} and enabled
      and not (sku_id = any (${sql.param([...keep])}::uuid[]))
  `);
}

export interface OfferRow extends Record<string, unknown> {
  readonly item_id: string;
  readonly sale_id: string;
  readonly sku_id: string;
  readonly sale_price_poisha: string;
  readonly unit_limit: number | null;
  readonly units_sold: number;
  readonly starts_at: string | Date | null;
  readonly ends_at: string | Date | null;
  readonly priority: number;
}

/**
 * Every switched-on offer on these SKUs that has not ended by `now`. Whether each is live
 * yet, and which one prices a line, is the domain's (`rankFlashOffers`).
 */
export async function offersForSkus(
  tx: Tx,
  orgId: string,
  skuIds: readonly string[],
  now: Date,
): Promise<OfferRow[]> {
  if (skuIds.length === 0) return [];
  const rows = await tx.execute<OfferRow>(sql`
    select i.id as item_id, s.id as sale_id, i.sku_id, i.sale_price_poisha::text,
           i.unit_limit, i.units_sold, s.starts_at, s.ends_at, s.priority
    from promo.flash_sale_items i
    join promo.flash_sales s on s.org_id = i.org_id and s.id = i.flash_sale_id
    where i.org_id = ${orgId} and i.sku_id = any (${sql.param([...skuIds])}::uuid[])
      and i.enabled and s.enabled
      and (s.ends_at is null or s.ends_at >= ${now.toISOString()}::timestamptz)
    order by i.sku_id, i.id
  `);
  return [...rows];
}

/**
 * Take `qty` units of one offer for an order, or refuse.
 *
 * Every condition the claim depends on is in the UPDATE's `where`, re-checked against the
 * row as it stands once any concurrent claim has committed: the SKU and sale still switched
 * on, the sale live at `now`, the units still there, and the sale price still the one the
 * caller is charging (a price edited between the quote and the order refuses rather than
 * charging a price the buyer never saw).
 */
export async function claimUnits(
  tx: Tx,
  orgId: string,
  claim: {
    readonly itemId: string;
    readonly skuId: string;
    readonly qty: number;
    readonly salePricePoisha: bigint;
    readonly now: Date;
  },
): Promise<boolean> {
  const at = claim.now.toISOString();
  const rows = await tx.execute<{ id: string }>(sql`
    update promo.flash_sale_items i
    set units_sold = i.units_sold + ${claim.qty}, updated_at = now()
    from promo.flash_sales s
    where i.org_id = ${orgId} and i.id = ${claim.itemId} and i.sku_id = ${claim.skuId}
      and i.enabled and i.sale_price_poisha = ${claim.salePricePoisha.toString()}
      and (i.unit_limit is null or i.units_sold + ${claim.qty} <= i.unit_limit)
      and s.org_id = i.org_id and s.id = i.flash_sale_id and s.enabled
      and (s.starts_at is null or s.starts_at <= ${at}::timestamptz)
      and (s.ends_at is null or s.ends_at >= ${at}::timestamptz)
    returning i.id
  `);
  return rows.length > 0;
}

/** The record of a claim. One per (order, offer): the unique index refuses a second. */
export async function insertClaim(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly itemId: string;
    readonly orderId: string;
    readonly skuId: string;
    readonly qty: number;
    readonly salePricePoisha: bigint;
  },
): Promise<string | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into promo.flash_claims (
      org_id, flash_sale_item_id, order_id, sku_id, qty, sale_price_poisha)
    values (${input.orgId}, ${input.itemId}, ${input.orderId}, ${input.skuId}, ${input.qty},
            ${input.salePricePoisha.toString()})
    on conflict (org_id, order_id, flash_sale_item_id) do nothing
    returning id
  `);
  return rows[0]?.id;
}

export interface ClaimRow extends Record<string, unknown> {
  readonly id: string;
  readonly flash_sale_item_id: string;
  readonly sku_id: string;
  readonly qty: number;
  readonly sale_price_poisha: string;
}

/** An order's claims still held, oldest first, so a partial release is deterministic. */
export async function heldClaims(tx: Tx, orgId: string, orderId: string): Promise<ClaimRow[]> {
  const rows = await tx.execute<ClaimRow>(sql`
    select id, flash_sale_item_id, sku_id, qty, sale_price_poisha::text
    from promo.flash_claims
    where org_id = ${orgId} and order_id = ${orderId} and status = 'claimed'
    order by created_at, id
  `);
  return [...rows];
}

/** An order's claims, held or released, for its detail. */
export async function claimsOfOrder(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<(ClaimRow & { status: string; released_qty: number })[]> {
  const rows = await tx.execute<ClaimRow & { status: string; released_qty: number }>(sql`
    select id, flash_sale_item_id, sku_id, qty, sale_price_poisha::text, status, released_qty
    from promo.flash_claims
    where org_id = ${orgId} and order_id = ${orderId}
    order by created_at, id
  `);
  return [...rows];
}

/**
 * Mark a claim released, giving back `qty` of its units. Only while it is still `claimed`:
 * the second of two releases finds no row. Returns false when it was already released.
 */
export async function releaseClaim(
  tx: Tx,
  orgId: string,
  claimId: string,
  qty: number,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update promo.flash_claims
    set status = 'released', released_qty = ${qty}, released_at = now(), updated_at = now()
    where org_id = ${orgId} and id = ${claimId} and status = 'claimed' and ${qty} <= qty
    returning id
  `);
  return rows.length > 0;
}

/** Give units back to a sale. The claim's own release decides how many and that it is once. */
export async function returnUnits(
  tx: Tx,
  orgId: string,
  itemId: string,
  qty: number,
): Promise<void> {
  if (qty <= 0) return;
  const rows = await tx.execute<{ id: string }>(sql`
    update promo.flash_sale_items
    set units_sold = units_sold - ${qty}, updated_at = now()
    where org_id = ${orgId} and id = ${itemId} and units_sold >= ${qty}
    returning id
  `);
  if (rows.length === 0) {
    // Every unit given back was counted in by a claim, so this is a broken invariant, not
    // a state a caller can produce; refusing rolls the release back with the transaction.
    throw new Error('a flash release would take a sale below zero units sold');
  }
}
