import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * M39b's catalog statements (D-635 to D-646): variant prices and regular prices, the
 * product-wide price history, per-colour photos, weights, duplicates and the product list's
 * bulk changes.
 *
 * Its own file so the console's original statements in `catalog.repository.ts` stay where
 * they were. Same rules: raw and parameterised, inside the caller's `withOrg()` transaction,
 * and **no cost column anywhere** (invariant 5). `compare_at_poisha` is the regular selling
 * price a website strikes through, not a cost.
 */

export interface SkuPriceRow extends Record<string, unknown> {
  readonly id: string;
  readonly product_id: string;
  readonly code: string;
  readonly price_poisha: string;
  readonly compare_at_poisha: string | null;
  readonly status: string;
}

/**
 * The SKUs a reprice names, locked for the rest of the transaction.
 *
 * `for no key update` (a price is not a key): it serialises two reprices of one SKU without
 * blocking the key-share lock every stock movement, order line and till line takes on the SKU
 * through its foreign key (ledger audit W3). It locks so the regular-price check the service makes against the current price
 * cannot be overtaken by another reprice of the same SKU between the read and the write
 * (the CHECK would still refuse it, but as a 500-shaped surprise rather than a message).
 */
export async function skuPricesForUpdate(
  tx: Tx,
  orgId: string,
  skuIds: readonly string[],
): Promise<SkuPriceRow[]> {
  if (skuIds.length === 0) return [];
  const rows = await tx.execute<SkuPriceRow>(sql`
    select id, product_id, code, price_poisha::text as price_poisha,
           compare_at_poisha::text as compare_at_poisha, status::text as status
    from catalog.skus
    where org_id = ${orgId} and id = any (${sql.param([...skuIds])}::uuid[])
    order by id
    for no key update
  `);
  return [...rows];
}

/**
 * The values a copy would put on new variants, with their lists, locked `for share` (lists
 * first, then values, each in id order: the order an archive or delete takes them in), and
 * which of them are archived, read under the lock (M39a, D-624). An archive that commits
 * first is seen; one that comes after waits for this transaction.
 */
export async function lockValuesLive(
  tx: Tx,
  orgId: string,
  valueIds: readonly string[],
): Promise<Set<string>> {
  if (valueIds.length === 0) return new Set();
  const ids = sql.param([...new Set(valueIds)]);
  const lists = await tx.execute<{ id: string; is_active: boolean }>(sql`
    select a.id, a.is_active from catalog.attributes a
    where a.org_id = ${orgId}
      and a.id in (
        select v.attribute_id from catalog.attribute_values v
        where v.org_id = ${orgId} and v.id = any (${ids}::uuid[])
      )
    order by a.id
    for share
  `);
  const values = await tx.execute<{ id: string; attribute_id: string; is_active: boolean }>(sql`
    select v.id, v.attribute_id, v.is_active from catalog.attribute_values v
    where v.org_id = ${orgId} and v.id = any (${ids}::uuid[])
    order by v.id
    for share
  `);
  const archivedLists = new Set(lists.filter((row) => !row.is_active).map((row) => row.id));
  return new Set(
    values
      .filter((row) => !row.is_active || archivedLists.has(row.attribute_id))
      .map((row) => row.id),
  );
}

/**
 * Write a SKU's price and regular price. The history row is migration 0121's trigger's;
 * the reason reaches it through `setPriceContext`.
 */
export async function writeSkuPrices(
  tx: Tx,
  orgId: string,
  skuId: string,
  pricePoisha: bigint,
  compareAtPoisha: bigint | null,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update catalog.skus set
      price_poisha = ${pricePoisha.toString()}::bigint,
      compare_at_poisha = ${compareAtPoisha === null ? null : compareAtPoisha.toString()}::bigint,
      updated_at = now()
    where org_id = ${orgId} and id = ${skuId}
    returning id
  `);
  return rows.length === 1;
}

export interface PriceHistoryRow extends Record<string, unknown> {
  readonly sku_id: string;
  readonly sku_code: string;
  readonly from_poisha: string | null;
  readonly to_poisha: string;
  readonly compare_at_from_poisha: string | null;
  readonly compare_at_to_poisha: string | null;
  readonly changed_by: string | null;
  readonly reason: string | null;
  readonly created_at: Date;
}

/** Every price change of every variant of a product, newest first (D-636). */
export async function productPriceHistory(
  tx: Tx,
  orgId: string,
  productId: string,
  limit: number,
): Promise<PriceHistoryRow[]> {
  const rows = await tx.execute<PriceHistoryRow>(sql`
    select h.sku_id, s.code as sku_code, h.from_poisha::text as from_poisha,
           h.to_poisha::text as to_poisha,
           h.compare_at_from_poisha::text as compare_at_from_poisha,
           h.compare_at_to_poisha::text as compare_at_to_poisha,
           h.changed_by, h.reason, h.created_at
    from catalog.sku_price_history h
    join catalog.skus s on s.org_id = h.org_id and s.id = h.sku_id
    where h.org_id = ${orgId} and s.product_id = ${productId}
    order by h.created_at desc, h.id desc
    limit ${limit}
  `);
  return [...rows];
}

/** Every value id of the brand's size lists (attributes of kind `size`). */
export async function sizeValueIds(tx: Tx, orgId: string): Promise<Set<string>> {
  const rows = await tx.execute<{ id: string }>(sql`
    select v.id from catalog.attribute_values v
    join catalog.attributes a on a.org_id = v.org_id and a.id = v.attribute_id
    where v.org_id = ${orgId} and a.kind = 'size'
  `);
  return new Set(rows.map((row) => row.id));
}

/** The attribute kind of a value of this brand, or nothing. */
export async function valueKind(
  tx: Tx,
  orgId: string,
  valueId: string,
): Promise<{ kind: string; label: string } | undefined> {
  const rows = await tx.execute<{ kind: string; label: string }>(sql`
    select a.kind::text as kind, v.label
    from catalog.attribute_values v
    join catalog.attributes a on a.org_id = v.org_id and a.id = v.attribute_id
    where v.org_id = ${orgId} and v.id = ${valueId}
  `);
  return rows[0];
}

/** Which colour a product's photo shows (D-643). */
export async function setImageColour(
  tx: Tx,
  orgId: string,
  productId: string,
  imageId: string,
  colourValueId: string | null,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update catalog.product_images set colour_value_id = ${colourValueId}::uuid
    where org_id = ${orgId} and product_id = ${productId} and id = ${imageId}
    returning id
  `);
  return rows.length === 1;
}

/** A variant's own weight, or null for the product's (D-645). */
export async function setSkuWeight(
  tx: Tx,
  orgId: string,
  skuId: string,
  weightGrams: number | null,
): Promise<{ id: string; code: string } | undefined> {
  const rows = await tx.execute<{ id: string; code: string }>(sql`
    update catalog.skus set weight_grams = ${weightGrams}::integer, updated_at = now()
    where org_id = ${orgId} and id = ${skuId}
    returning id, code
  `);
  return rows[0];
}

/** Each SKU's weight for a courier: its own, else its product's; null when neither has one. */
export async function skuWeights(
  tx: Tx,
  orgId: string,
  skuIds: readonly string[],
): Promise<Map<string, number | null>> {
  if (skuIds.length === 0) return new Map();
  const rows = await tx.execute<{ id: string; grams: number | null }>(sql`
    select s.id, coalesce(s.weight_grams, p.weight_grams) as grams
    from catalog.skus s
    join catalog.products p on p.org_id = s.org_id and p.id = s.product_id
    where s.org_id = ${orgId} and s.id = any (${sql.param([...skuIds])}::uuid[])
  `);
  return new Map(rows.map((row) => [row.id, row.grams]));
}

/**
 * Archive or restore many SKUs at once (D-639: "stop selling XS in all colours"). Returns the
 * rows it changed; a SKU already in that status is left alone and not returned.
 */
export async function setSkuStatuses(
  tx: Tx,
  orgId: string,
  skuIds: readonly string[],
  status: 'active' | 'archived',
): Promise<{ id: string; code: string; product_id: string }[]> {
  if (skuIds.length === 0) return [];
  const rows = await tx.execute<{ id: string; code: string; product_id: string }>(sql`
    update catalog.skus set status = ${status}::catalog.sku_status, updated_at = now()
    where org_id = ${orgId} and id = any (${sql.param([...skuIds])}::uuid[])
      and status <> ${status}::catalog.sku_status
    returning id, code, product_id
  `);
  return [...rows];
}

/** SKU ids of this brand among those given, with their product and status. */
export async function skuOwners(
  tx: Tx,
  orgId: string,
  skuIds: readonly string[],
): Promise<{ id: string; code: string; product_id: string; status: string }[]> {
  if (skuIds.length === 0) return [];
  const rows = await tx.execute<{ id: string; code: string; product_id: string; status: string }>(
    sql`
      select id, code, product_id, status::text as status from catalog.skus
      where org_id = ${orgId} and id = any (${sql.param([...skuIds])}::uuid[])
      order by id
      for no key update
    `,
  );
  return [...rows];
}

/** Archive, restore or re-file many products at once (D-642). Returns the ids it changed. */
export async function updateProducts(
  tx: Tx,
  orgId: string,
  productIds: readonly string[],
  patch: {
    readonly status?: string | undefined;
    readonly changeCategory: boolean;
    readonly categoryId: string | null;
  },
): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    update catalog.products p set
      status = coalesce(${patch.status ?? null}::catalog.product_status, p.status),
      category_id = case when ${patch.changeCategory} then ${patch.categoryId}::uuid
                         else p.category_id end,
      updated_at = now()
    where p.org_id = ${orgId} and p.id = any (${sql.param([...productIds])}::uuid[])
    returning p.id
  `);
  return rows.map((row) => row.id);
}

/**
 * Web addresses already taken at or near `base`: a product's own, or an old one that still
 * leads to a product (M33's previous slugs), so a duplicate never takes an address that
 * redirects somewhere else.
 */
export async function slugsNear(tx: Tx, orgId: string, base: string): Promise<Set<string>> {
  const pattern = `${base.replace(/[\\%_]/g, (match) => `\\${match}`)}-%`;
  const rows = await tx.execute<{ slug: string }>(sql`
    select slug from catalog.products
    where org_id = ${orgId} and (slug = ${base} or slug like ${pattern} escape '\\')
    union
    select previous.slug from catalog.products p, unnest(p.previous_slugs) as previous(slug)
    where p.org_id = ${orgId}
      and (previous.slug = ${base} or previous.slug like ${pattern} escape '\\')
  `);
  return new Set(rows.map((row) => row.slug));
}

/** A product's photos onto another product, in the same order and colours (D-641). */
export async function copyImages(
  tx: Tx,
  orgId: string,
  fromProductId: string,
  toProductId: string,
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into catalog.product_images
      (org_id, product_id, file_id, position, alt_text, colour_value_id)
    select org_id, ${toProductId}::uuid, file_id, position, alt_text, colour_value_id
    from catalog.product_images
    where org_id = ${orgId} and product_id = ${fromProductId}
    order by position, created_at
    returning id
  `);
  return rows.length;
}

/**
 * Every SKU of the brand (or of one product) with its product's name, for the supply
 * module's standard-price spreadsheet (D-638). Codes and names only, never a price.
 */
export async function skuDirectory(
  tx: Tx,
  orgId: string,
  filter: { readonly productId?: string | undefined; readonly activeOnly: boolean },
): Promise<
  { id: string; code: string; product_id: string; product_name: string; status: string }[]
> {
  const rows = await tx.execute<{
    id: string;
    code: string;
    product_id: string;
    product_name: string;
    status: string;
  }>(sql`
    select s.id, s.code, s.product_id, p.name as product_name, s.status::text as status
    from catalog.skus s
    join catalog.products p on p.org_id = s.org_id and p.id = s.product_id
    where s.org_id = ${orgId}
      and ${filter.productId === undefined ? sql`true` : sql`s.product_id = ${filter.productId}`}
      and ${filter.activeOnly ? sql`s.status = 'active' and p.status <> 'archived'` : sql`true`}
    order by p.sequence, s.position, s.code
    limit 20000
  `);
  return [...rows];
}
