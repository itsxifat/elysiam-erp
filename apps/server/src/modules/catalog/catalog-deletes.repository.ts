import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { USAGE_EXAMPLES } from '../../platform/references/references.js';

/**
 * The SQL behind deleting and archiving catalog rows (M39a, D-621 to D-626).
 *
 * Only the catalog's own tables. What other modules hold about these rows is asked through
 * `CatalogReferences` (each module counts its own); what exists only because of a SKU or a
 * location (its price history, its empty stock rows) leaves by the database's cascade, which
 * 0119's triggers confine to exactly that.
 *
 * Every delete locks first: `for update` on the rows about to go, in id order, so a
 * reference committing at the same moment either is seen by the count that follows (it
 * committed first) or waits on the lock and then fails on its foreign key (it came second).
 */

// --- categories ----------------------------------------------------------------------------

/** Everything a category row holds, for the audit's before image. */
export interface CategoryImage extends Record<string, unknown> {
  readonly id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly slug: string;
  readonly code: string;
  readonly path: string;
  readonly depth: number;
  readonly position: number;
  readonly is_active: boolean;
  readonly web_visible: boolean;
  readonly featured: boolean;
  readonly gender: string | null;
  readonly description: string | null;
  readonly image_file_id: string | null;
}

const CATEGORY_IMAGE = sql`id, parent_id, name, slug, code, path, depth, position, is_active,
  web_visible, featured, gender, description, image_file_id`;

export async function lockCategory(
  tx: Tx,
  orgId: string,
  id: string,
  mode: 'update' | 'share' = 'update',
): Promise<CategoryImage | undefined> {
  const rows = await tx.execute<CategoryImage>(sql`
    select ${CATEGORY_IMAGE} from catalog.categories
    where org_id = ${orgId} and id = ${id}
    ${mode === 'update' ? sql`for update` : sql`for share`}
  `);
  return rows[0];
}

export async function categoryImage(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<CategoryImage | undefined> {
  const rows = await tx.execute<CategoryImage>(sql`
    select ${CATEGORY_IMAGE} from catalog.categories where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

export interface Named extends Record<string, unknown> {
  readonly id: string;
  readonly label: string;
}

export interface CountedNames {
  readonly count: number;
  readonly examples: Named[];
}

/** Products filed directly in the category, any status. */
export async function productsInCategory(
  tx: Tx,
  orgId: string,
  categoryId: string,
): Promise<CountedNames> {
  const total = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from catalog.products
    where org_id = ${orgId} and category_id = ${categoryId}
  `);
  const named = await tx.execute<Named>(sql`
    select id, name as label from catalog.products
    where org_id = ${orgId} and category_id = ${categoryId}
    order by name limit ${USAGE_EXAMPLES}
  `);
  return { count: total[0]?.n ?? 0, examples: [...named] };
}

/** The categories directly below this one. */
export async function childCategories(
  tx: Tx,
  orgId: string,
  categoryId: string,
  lock = false,
): Promise<{ id: string; name: string; slug: string }[]> {
  const rows = await tx.execute<{ id: string; name: string; slug: string }>(sql`
    select id, name, slug from catalog.categories
    where org_id = ${orgId} and parent_id = ${categoryId}
    order by position, name
    ${lock ? sql`for update` : sql``}
  `);
  return [...rows];
}

/** The slugs taken among the children of `parentId` (null: the top level). */
export async function siblingSlugs(
  tx: Tx,
  orgId: string,
  parentId: string | null,
  except: readonly string[],
): Promise<Set<string>> {
  const rows = await tx.execute<{ slug: string }>(sql`
    select slug from catalog.categories
    where org_id = ${orgId}
      and ${parentId === null ? sql`parent_id is null` : sql`parent_id = ${parentId}::uuid`}
      and not (id = any (${sql.param([...except])}::uuid[]))
  `);
  return new Set(rows.map((row) => row.slug));
}

/** Move every product of one category to another (null: no category). The ids moved. */
export async function moveCategoryProducts(
  tx: Tx,
  orgId: string,
  fromId: string,
  toId: string | null,
): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    update catalog.products
    set category_id = ${toId}::uuid, updated_at = now()
    where org_id = ${orgId} and category_id = ${fromId}
    returning id
  `);
  return rows.map((row) => row.id);
}

/** A new parent (and, when it would collide there, a new slug); 0026's trigger re-paths. */
export async function reparentCategory(
  tx: Tx,
  orgId: string,
  id: string,
  parentId: string | null,
  slug: string,
): Promise<void> {
  await tx.execute(sql`
    update catalog.categories
    set parent_id = ${parentId}::uuid, slug = ${slug}, updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

export async function deleteCategory(tx: Tx, orgId: string, id: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from catalog.categories where org_id = ${orgId} and id = ${id} returning id
  `);
  return rows.length === 1;
}

export async function setCategoryActive(
  tx: Tx,
  orgId: string,
  id: string,
  active: boolean,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update catalog.categories set is_active = ${active}, updated_at = now()
    where org_id = ${orgId} and id = ${id}
    returning id
  `);
  return rows.length === 1;
}

/** Is `candidateId` this category or below it? A target there would be deleted with it. */
export async function isInSubtree(
  tx: Tx,
  orgId: string,
  rootId: string,
  candidateId: string,
): Promise<boolean> {
  const rows = await tx.execute<{ inside: boolean }>(sql`
    select exists (
      select 1 from catalog.categories cat
      join catalog.categories root on root.org_id = cat.org_id and root.id = ${rootId}::uuid
      where cat.org_id = ${orgId} and cat.id = ${candidateId}::uuid
        and (cat.id = root.id or starts_with(cat.path, root.path || '/'))
    ) as inside
  `);
  return rows[0]?.inside === true;
}

// --- attribute lists and values ------------------------------------------------------------

export interface AttributeImage extends Record<string, unknown> {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly is_variant: boolean;
  readonly position: number;
  readonly is_active: boolean;
}

export async function lockAttribute(
  tx: Tx,
  orgId: string,
  id: string,
  lock = true,
): Promise<AttributeImage | undefined> {
  const rows = await tx.execute<AttributeImage>(sql`
    select id, code, name, kind::text as kind, is_variant, position, is_active
    from catalog.attributes where org_id = ${orgId} and id = ${id}
    ${lock ? sql`for update` : sql``}
  `);
  return rows[0];
}

export interface ValueImage extends Record<string, unknown> {
  readonly id: string;
  readonly attribute_id: string;
  readonly code: string;
  readonly label: string;
  readonly position: number;
  readonly is_active: boolean;
}

/** Values of one list, locked; one value when `valueId` is given. */
export async function lockValues(
  tx: Tx,
  orgId: string,
  attributeId: string,
  valueId?: string,
  lock = true,
): Promise<ValueImage[]> {
  const rows = await tx.execute<ValueImage>(sql`
    select id, attribute_id, code, label, position, is_active
    from catalog.attribute_values
    where org_id = ${orgId} and attribute_id = ${attributeId}
      and ${valueId === undefined ? sql`true` : sql`id = ${valueId}::uuid`}
    order by id
    ${lock ? sql`for update` : sql``}
  `);
  return [...rows];
}

/**
 * The variants carrying a list (any of its values) or one value: how many, how many still
 * active, and a few of their products by name.
 */
export async function variantsUsing(
  tx: Tx,
  orgId: string,
  by: { readonly attributeId: string } | { readonly valueId: string },
): Promise<{ count: number; active: number; examples: Named[] }> {
  const where =
    'attributeId' in by
      ? sql`v.attribute_id = ${by.attributeId}::uuid`
      : sql`v.value_id = ${by.valueId}::uuid`;
  const totals = await tx.execute<{ n: number; active: number }>(sql`
    select count(*)::int as n, count(*) filter (where s.status = 'active')::int as active
    from catalog.sku_values v
    join catalog.skus s on s.org_id = v.org_id and s.id = v.sku_id
    where v.org_id = ${orgId} and ${where}
  `);
  const named = await tx.execute<Named>(sql`
    select distinct p.id, p.name as label
    from catalog.sku_values v
    join catalog.skus s on s.org_id = v.org_id and s.id = v.sku_id
    join catalog.products p on p.org_id = s.org_id and p.id = s.product_id
    where v.org_id = ${orgId} and ${where}
    order by p.name
    limit ${USAGE_EXAMPLES}
  `);
  return {
    count: totals[0]?.n ?? 0,
    active: totals[0]?.active ?? 0,
    examples: [...named],
  };
}

export async function deleteAttributeWithValues(
  tx: Tx,
  orgId: string,
  attributeId: string,
): Promise<boolean> {
  await tx.execute(sql`
    delete from catalog.attribute_values where org_id = ${orgId} and attribute_id = ${attributeId}
  `);
  const rows = await tx.execute<{ id: string }>(sql`
    delete from catalog.attributes where org_id = ${orgId} and id = ${attributeId} returning id
  `);
  return rows.length === 1;
}

export async function deleteValue(
  tx: Tx,
  orgId: string,
  attributeId: string,
  valueId: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from catalog.attribute_values
    where org_id = ${orgId} and attribute_id = ${attributeId} and id = ${valueId}
    returning id
  `);
  return rows.length === 1;
}

export async function setAttributeActive(
  tx: Tx,
  orgId: string,
  id: string,
  active: boolean,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update catalog.attributes set is_active = ${active}, updated_at = now()
    where org_id = ${orgId} and id = ${id} returning id
  `);
  return rows.length === 1;
}

export async function setValueActive(
  tx: Tx,
  orgId: string,
  attributeId: string,
  valueId: string,
  active: boolean,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update catalog.attribute_values set is_active = ${active}, updated_at = now()
    where org_id = ${orgId} and attribute_id = ${attributeId} and id = ${valueId}
    returning id
  `);
  return rows.length === 1;
}

/** Archive every active variant carrying a value, in one statement. The codes archived. */
export async function archiveSkusWithValue(
  tx: Tx,
  orgId: string,
  valueId: string,
): Promise<{ id: string; code: string }[]> {
  const rows = await tx.execute<{ id: string; code: string }>(sql`
    update catalog.skus s set status = 'archived', updated_at = now()
    from catalog.sku_values v
    where s.org_id = ${orgId} and v.org_id = s.org_id and v.sku_id = s.id
      and v.value_id = ${valueId}::uuid and s.status = 'active'
    returning s.id, s.code
  `);
  return [...rows];
}

/** Positions 0..n-1 in the order given; every value of the list must be named once. */
export async function reorderValues(
  tx: Tx,
  orgId: string,
  attributeId: string,
  valueIds: readonly string[],
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    update catalog.attribute_values v
    set position = ordered.position - 1, updated_at = now()
    from unnest(${sql.param([...valueIds])}::uuid[]) with ordinality as ordered(id, position)
    where v.org_id = ${orgId} and v.attribute_id = ${attributeId} and v.id = ordered.id
    returning v.id
  `);
  return rows.length;
}

/** Which of these values, or their lists, are archived (a new variant may not carry them). */
export async function archivedAmong(
  tx: Tx,
  orgId: string,
  valueIds: readonly string[],
): Promise<{ id: string; label: string; list: string }[]> {
  if (valueIds.length === 0) return [];
  const rows = await tx.execute<{ id: string; label: string; list: string }>(sql`
    select av.id, av.label, a.name as list
    from catalog.attribute_values av
    join catalog.attributes a on a.org_id = av.org_id and a.id = av.attribute_id
    where av.org_id = ${orgId} and av.id = any (${sql.param([...valueIds])}::uuid[])
      and (not av.is_active or not a.is_active)
  `);
  return [...rows];
}

// --- products and SKUs ---------------------------------------------------------------------

export interface ProductImage extends Record<string, unknown> {
  readonly id: string;
  readonly category_id: string | null;
  readonly sequence: number;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly status: string;
  readonly web_visible: boolean;
  readonly featured: boolean;
  readonly new_arrival: boolean;
  readonly gender: string | null;
  readonly material: string | null;
  readonly care_instructions: string | null;
  readonly tags: string[];
  readonly size_chart_id: string | null;
  readonly seo_title: string | null;
  readonly seo_description: string | null;
  readonly previous_slugs: string[];
  readonly created_by: string | null;
  readonly created_at: Date;
}

export async function lockProduct(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<ProductImage | undefined> {
  const rows = await tx.execute<ProductImage>(sql`
    select id, category_id, sequence, name, slug, description, status::text as status,
           web_visible, featured, new_arrival, gender, material, care_instructions, tags,
           size_chart_id, seo_title, seo_description, previous_slugs, created_by, created_at
    from catalog.products where org_id = ${orgId} and id = ${id}
    for update
  `);
  return rows[0];
}

export interface SkuImage extends Record<string, unknown> {
  readonly id: string;
  readonly product_id: string;
  readonly code: string;
  readonly variant_key: string;
  readonly barcode: string | null;
  readonly price_poisha: string;
  readonly status: string;
  readonly position: number;
  readonly values: { attribute: string; value: string; code: string }[];
}

/** SKUs, locked in id order, with the values they carry (for the before image). */
export async function lockSkus(
  tx: Tx,
  orgId: string,
  by: { readonly productId: string } | { readonly skuId: string },
): Promise<SkuImage[]> {
  const where =
    'productId' in by ? sql`s.product_id = ${by.productId}::uuid` : sql`s.id = ${by.skuId}::uuid`;
  const locked = await tx.execute<{ id: string }>(sql`
    select s.id from catalog.skus s where s.org_id = ${orgId} and ${where}
    order by s.id
    for update
  `);
  if (locked.length === 0) return [];
  const rows = await tx.execute<SkuImage>(sql`
    select s.id, s.product_id, s.code, s.variant_key, s.barcode, s.price_poisha::text as price_poisha,
           s.status::text as status, s.position,
           coalesce(json_agg(json_build_object('attribute', a.name, 'value', av.label, 'code', av.code)
                             order by a.position, a.code)
                    filter (where v.sku_id is not null), '[]'::json) as values
    from catalog.skus s
    left join catalog.sku_values v on v.org_id = s.org_id and v.sku_id = s.id
    left join catalog.attributes a on a.org_id = v.org_id and a.id = v.attribute_id
    left join catalog.attribute_values av on av.org_id = v.org_id and av.id = v.value_id
    where s.org_id = ${orgId} and s.id = any (${sql.param(locked.map((row) => row.id))}::uuid[])
    group by s.id
    order by s.position, s.code
  `);
  return [...rows];
}

/** A product's name, status and SKU ids, unlocked, for a usage report. */
export async function productSummary(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<{ name: string; status: string; skuIds: string[] } | undefined> {
  const rows = await tx.execute<{ name: string; status: string; sku_ids: string[] }>(sql`
    select p.name, p.status::text as status,
           coalesce(array_agg(s.id) filter (where s.id is not null), '{}') as sku_ids
    from catalog.products p
    left join catalog.skus s on s.org_id = p.org_id and s.product_id = p.id
    where p.org_id = ${orgId} and p.id = ${id}
    group by p.id
  `);
  const row = rows[0];
  return row === undefined
    ? undefined
    : { name: row.name, status: row.status, skuIds: row.sku_ids };
}

/** A SKU as a person names it (`Black Panjabi · M / Red`), its status and its product. */
export async function skuLabel(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<{ label: string; status: string; productId: string; productName: string } | undefined> {
  const rows = await tx.execute<{
    code: string;
    status: string;
    product_id: string;
    product_name: string;
  }>(sql`
    select s.code, s.status::text as status, p.id as product_id, p.name as product_name
    from catalog.skus s
    join catalog.products p on p.org_id = s.org_id and p.id = s.product_id
    where s.org_id = ${orgId} and s.id = ${id}
  `);
  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        label: `${row.product_name} · ${row.code}`,
        status: row.status,
        productId: row.product_id,
        productName: row.product_name,
      };
}

export async function imageFileIds(tx: Tx, orgId: string, productId: string): Promise<string[]> {
  const rows = await tx.execute<{ file_id: string }>(sql`
    select file_id from catalog.product_images
    where org_id = ${orgId} and product_id = ${productId}
    order by position
  `);
  return rows.map((row) => row.file_id);
}

export async function deleteSkus(
  tx: Tx,
  orgId: string,
  skuIds: readonly string[],
): Promise<number> {
  if (skuIds.length === 0) return 0;
  const rows = await tx.execute<{ id: string }>(sql`
    delete from catalog.skus
    where org_id = ${orgId} and id = any (${sql.param([...skuIds])}::uuid[])
    returning id
  `);
  return rows.length;
}

export async function deleteProduct(tx: Tx, orgId: string, id: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from catalog.products where org_id = ${orgId} and id = ${id} returning id
  `);
  return rows.length === 1;
}

/** Who stands at a slug now: `archived`, another status, or nobody. */
export async function slugHolder(
  tx: Tx,
  orgId: string,
  slug: string,
): Promise<{ status: string } | undefined> {
  const rows = await tx.execute<{ status: string }>(sql`
    select status::text as status from catalog.products where org_id = ${orgId} and slug = ${slug}
  `);
  return rows[0];
}

/** Every current slug that is `base` or `base-N`, to pick the next free suffix from. */
export async function slugsLike(tx: Tx, orgId: string, base: string): Promise<Set<string>> {
  const rows = await tx.execute<{ slug: string }>(sql`
    select slug from catalog.products
    where org_id = ${orgId} and (slug = ${base} or slug ~ ('^' || ${base} || '-[0-9]+$'))
  `);
  return new Set(rows.map((row) => row.slug));
}

/** The category code inside a product's existing SKU codes, if any (D-623). */
export async function productCodePrefix(
  tx: Tx,
  orgId: string,
  productId: string,
): Promise<string | undefined> {
  const rows = await tx.execute<{ code: string }>(sql`
    select code from catalog.skus where org_id = ${orgId} and product_id = ${productId}
    order by position, created_at
    limit 1
  `);
  return rows[0]?.code;
}

// --- size charts (the website's, through `CatalogApi`) -------------------------------------

/** The products showing a size chart, any status, with a few names (D-628). */
export async function sizeChartProducts(
  tx: Tx,
  orgId: string,
  sizeChartId: string,
): Promise<CountedNames> {
  const total = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from catalog.products
    where org_id = ${orgId} and size_chart_id = ${sizeChartId}
  `);
  const named = await tx.execute<Named>(sql`
    select id, name as label from catalog.products
    where org_id = ${orgId} and size_chart_id = ${sizeChartId}
    order by name limit ${USAGE_EXAMPLES}
  `);
  return { count: total[0]?.n ?? 0, examples: [...named] };
}

/** Every product on one chart moved to another (or none); the ids moved. */
export async function reassignSizeChart(
  tx: Tx,
  orgId: string,
  fromId: string,
  toId: string | null,
): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    update catalog.products set size_chart_id = ${toId}::uuid, updated_at = now()
    where org_id = ${orgId} and size_chart_id = ${fromId}
    returning id
  `);
  return rows.map((row) => row.id);
}
