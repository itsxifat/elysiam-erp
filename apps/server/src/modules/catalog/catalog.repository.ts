import type { Tx } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Every SQL statement the catalog module runs.
 *
 * Raw and parameterised, in one file, following `ledger.repository.ts`: the
 * tenancy rules say raw SQL lives only in repositories and is never built by
 * string interpolation. Everything here runs inside a caller's `withOrg()`
 * transaction, so RLS already confines each query to the active org; the explicit
 * `org_id = ${orgId}` filters are for the planner and the reader, not the control.
 *
 * ## Two statements worth reading before the rest
 *
 * `takeSequence` is the per-org SKU counter. One statement — insert, on conflict
 * bump, returning — because a select followed by an update hands two concurrent
 * product creations the same number, and the second one then dies on
 * `products_org_sequence_idx` with a 500 for something that was nobody's mistake.
 *
 * `searchProducts` is check 2. The `like '%…%'` runs against `search_text`, which
 * migration 0026 keeps as the lower-cased name, slug and every SKU code of the
 * product, and migration 0025 covers with a `gin_trgm_ops` index. The fragment is
 * lower-cased here so the comparison is `like`, not `ilike`: both use the index,
 * and folding once on the way in beats folding every row the scan touches.
 */

/** Columns of a catalog row that leaves the module. Never a cost column. */
const PRODUCT_COLUMNS = sql`p.id, p.org_id, p.category_id, p.sequence, p.name, p.slug,
  p.description, p.status::text as status, p.created_by, p.created_at, p.updated_at`;

const SKU_COLUMNS = sql`s.id, s.org_id, s.product_id, s.code, s.variant_key, s.barcode,
  s.price_poisha, s.status::text as status, s.position`;

export interface ProductRow extends Record<string, unknown> {
  readonly id: string;
  readonly org_id: string;
  readonly category_id: string | null;
  readonly sequence: number;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly status: string;
  readonly created_by: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface SkuRow extends Record<string, unknown> {
  readonly id: string;
  readonly org_id: string;
  readonly product_id: string;
  readonly code: string;
  readonly variant_key: string;
  readonly barcode: string | null;
  /** `bigint` comes back as a decimal string from the driver, which is what §23 sends. */
  readonly price_poisha: string;
  readonly status: string;
  readonly position: number;
}

export interface CategoryRow extends Record<string, unknown> {
  readonly id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly slug: string;
  readonly code: string;
  readonly path: string;
  readonly depth: number;
  readonly position: number;
  readonly is_active: boolean;
}

export interface AttributeRow extends Record<string, unknown> {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly is_variant: boolean;
  readonly position: number;
}

export interface AttributeValueRow extends Record<string, unknown> {
  readonly id: string;
  readonly attribute_id: string;
  readonly code: string;
  readonly label: string;
  readonly position: number;
}

// --- the per-org SKU counter and prefix -------------------------------------

/**
 * Take the next SKU sequence number for this org, atomically.
 *
 * `on conflict do update` takes a row lock, so two concurrent creations serialise
 * on it and get 7 and 8 rather than 7 and 7. The default `org_code` is the first
 * three alphanumerics of the org's slug, upper-cased — a starting point an admin
 * can change, not a decision this statement is making permanently.
 */
export async function takeSequence(
  tx: Tx,
  orgId: string,
): Promise<{ sequence: number; orgCode: string }> {
  const rows = await tx.execute<{ last_sequence: number; org_code: string }>(sql`
    insert into catalog.sku_settings (org_id, org_code, last_sequence)
    values (
      ${orgId},
      coalesce(
        (select upper(substring(regexp_replace(o.slug, '[^A-Za-z0-9]', '', 'g') from 1 for 3))
         from org.organizations o where o.id = ${orgId}),
        'ORG'
      ),
      1
    )
    on conflict (org_id) do update
      set last_sequence = catalog.sku_settings.last_sequence + 1,
          updated_at = now()
    returning last_sequence, org_code
  `);

  const row = rows[0];
  if (row === undefined) throw new Error('The SKU counter returned no row.');
  return { sequence: row.last_sequence, orgCode: row.org_code };
}

export async function skuSettings(
  tx: Tx,
  orgId: string,
): Promise<{ orgCode: string; lastSequence: number } | undefined> {
  const rows = await tx.execute<{ org_code: string; last_sequence: number }>(sql`
    select org_code, last_sequence from catalog.sku_settings where org_id = ${orgId}
  `);
  const row = rows[0];
  return row === undefined ? undefined : { orgCode: row.org_code, lastSequence: row.last_sequence };
}

export async function setOrgCode(tx: Tx, orgId: string, orgCode: string): Promise<void> {
  await tx.execute(sql`
    insert into catalog.sku_settings (org_id, org_code, last_sequence)
    values (${orgId}, ${orgCode}, 0)
    on conflict (org_id) do update set org_code = ${orgCode}, updated_at = now()
  `);
}

// --- categories -------------------------------------------------------------

export async function listCategories(tx: Tx, orgId: string): Promise<CategoryRow[]> {
  const rows = await tx.execute<CategoryRow>(sql`
    select id, parent_id, name, slug, code, path, depth, position, is_active
    from catalog.categories
    where org_id = ${orgId}
    order by path
  `);
  return [...rows];
}

export async function insertCategory(
  tx: Tx,
  orgId: string,
  input: {
    readonly name: string;
    readonly slug: string;
    readonly code: string;
    readonly parentId: string | null;
    readonly position: number;
  },
): Promise<CategoryRow> {
  const rows = await tx.execute<CategoryRow>(sql`
    insert into catalog.categories (org_id, parent_id, name, slug, code, position)
    values (${orgId}, ${input.parentId}, ${input.name}, ${input.slug}, ${input.code}, ${input.position})
    returning id, parent_id, name, slug, code, path, depth, position, is_active
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('The category insert returned no row.');
  return row;
}

/**
 * Update a category, leaving out whatever the caller did not name.
 *
 * `coalesce(param, column)` rather than a dynamically assembled SET list: a
 * hand-built list is where interpolation creeps back in, and `null` from an
 * absent field means "unchanged" for every column here except `parent_id`, which
 * is why that one takes an explicit flag.
 */
export async function updateCategory(
  tx: Tx,
  orgId: string,
  id: string,
  input: {
    readonly name?: string | undefined;
    readonly slug?: string | undefined;
    readonly position?: number | undefined;
    readonly isActive?: boolean | undefined;
    readonly changeParent: boolean;
    readonly parentId: string | null;
  },
): Promise<CategoryRow | undefined> {
  const rows = await tx.execute<CategoryRow>(sql`
    update catalog.categories set
      name = coalesce(${input.name ?? null}, name),
      slug = coalesce(${input.slug ?? null}, slug),
      position = coalesce(${input.position ?? null}::integer, position),
      is_active = coalesce(${input.isActive ?? null}::boolean, is_active),
      parent_id = case when ${input.changeParent} then ${input.parentId}::uuid else parent_id end,
      updated_at = now()
    where org_id = ${orgId} and id = ${id}
    returning id, parent_id, name, slug, code, path, depth, position, is_active
  `);
  return rows[0];
}

export async function categoryById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<CategoryRow | undefined> {
  const rows = await tx.execute<CategoryRow>(sql`
    select id, parent_id, name, slug, code, path, depth, position, is_active
    from catalog.categories where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

// --- attributes -------------------------------------------------------------

export async function listAttributes(tx: Tx, orgId: string): Promise<AttributeRow[]> {
  const rows = await tx.execute<AttributeRow>(sql`
    select id, code, name, kind::text as kind, is_variant, position
    from catalog.attributes where org_id = ${orgId}
    order by position, code
  `);
  return [...rows];
}

export async function listAttributeValues(
  tx: Tx,
  orgId: string,
  attributeIds?: readonly string[],
): Promise<AttributeValueRow[]> {
  const rows = await tx.execute<AttributeValueRow>(sql`
    select id, attribute_id, code, label, position
    from catalog.attribute_values
    where org_id = ${orgId}
      and ${
        attributeIds === undefined
          ? sql`true`
          : sql`attribute_id = any (${sql.param(attributeIds)}::uuid[])`
      }
    order by attribute_id, position, code
  `);
  return [...rows];
}

export async function insertAttribute(
  tx: Tx,
  orgId: string,
  input: {
    readonly code: string;
    readonly name: string;
    readonly kind: string;
    readonly isVariant: boolean;
    readonly position: number;
  },
): Promise<AttributeRow> {
  const rows = await tx.execute<AttributeRow>(sql`
    insert into catalog.attributes (org_id, code, name, kind, is_variant, position)
    values (${orgId}, ${input.code}, ${input.name}, ${input.kind}::catalog.attribute_kind,
            ${input.isVariant}, ${input.position})
    returning id, code, name, kind::text as kind, is_variant, position
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('The attribute insert returned no row.');
  return row;
}

export async function insertAttributeValue(
  tx: Tx,
  orgId: string,
  attributeId: string,
  input: { readonly code: string; readonly label: string; readonly position: number },
): Promise<AttributeValueRow> {
  const rows = await tx.execute<AttributeValueRow>(sql`
    insert into catalog.attribute_values (org_id, attribute_id, code, label, position)
    values (${orgId}, ${attributeId}, ${input.code}, ${input.label}, ${input.position})
    returning id, attribute_id, code, label, position
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('The attribute value insert returned no row.');
  return row;
}

export async function attributeExists(tx: Tx, orgId: string, id: string): Promise<boolean> {
  const rows = await tx.execute<{ ok: boolean }>(sql`
    select exists (select 1 from catalog.attributes where org_id = ${orgId} and id = ${id}) as ok
  `);
  return rows[0]?.ok === true;
}

// --- products ---------------------------------------------------------------

export async function insertProduct(
  tx: Tx,
  orgId: string,
  input: {
    readonly categoryId: string | null;
    readonly sequence: number;
    readonly name: string;
    readonly slug: string;
    readonly description: string | null;
    readonly status: string;
    readonly createdBy: string | null;
  },
): Promise<ProductRow> {
  const rows = await tx.execute<ProductRow>(sql`
    insert into catalog.products
      (org_id, category_id, sequence, name, slug, description, status, created_by)
    values (${orgId}, ${input.categoryId}, ${input.sequence}, ${input.name}, ${input.slug},
            ${input.description}, ${input.status}::catalog.product_status, ${input.createdBy})
    returning id, org_id, category_id, sequence, name, slug, description,
              status::text as status, created_by, created_at, updated_at
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('The product insert returned no row.');
  return row;
}

export async function productById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<ProductRow | undefined> {
  const rows = await tx.execute<ProductRow>(sql`
    select ${PRODUCT_COLUMNS} from catalog.products p
    where p.org_id = ${orgId} and p.id = ${id}
  `);
  return rows[0];
}

export async function updateProduct(
  tx: Tx,
  orgId: string,
  id: string,
  input: {
    readonly name?: string | undefined;
    readonly slug?: string | undefined;
    readonly status?: string | undefined;
    readonly changeCategory: boolean;
    readonly categoryId: string | null;
    readonly changeDescription: boolean;
    readonly description: string | null;
  },
): Promise<ProductRow | undefined> {
  const rows = await tx.execute<ProductRow>(sql`
    update catalog.products p set
      name = coalesce(${input.name ?? null}, p.name),
      slug = coalesce(${input.slug ?? null}, p.slug),
      status = coalesce(${input.status ?? null}::catalog.product_status, p.status),
      category_id = case when ${input.changeCategory} then ${input.categoryId}::uuid else p.category_id end,
      description = case when ${input.changeDescription} then ${input.description} else p.description end,
      updated_at = now()
    where p.org_id = ${orgId} and p.id = ${id}
    returning p.id, p.org_id, p.category_id, p.sequence, p.name, p.slug, p.description,
              p.status::text as status, p.created_by, p.created_at, p.updated_at
  `);
  return rows[0];
}

export interface ProductListRow extends ProductRow {
  readonly category_name: string | null;
  readonly sku_count: number;
  /** The cheapest active SKU, so a list can show "from ৳x". Selling price only. */
  readonly min_price_poisha: string | null;
  readonly max_price_poisha: string | null;
  readonly image_file_id: string | null;
}

/**
 * The product list: search, filter, keyset page (check 2).
 *
 * Keyset rather than OFFSET. A catalog list is scrolled, and OFFSET 20000 reads
 * and discards 20,000 rows — the p95 the check measures is exactly the tail where
 * that shows. The cursor is `sequence`, which is per-org, unique and never
 * changes (0026 freezes it), so a page boundary cannot shift under an edit the way
 * it would with `created_at`.
 */
export async function searchProducts(
  tx: Tx,
  orgId: string,
  query: {
    readonly q?: string | undefined;
    readonly categoryId?: string | undefined;
    readonly status?: string | undefined;
    readonly limit: number;
    readonly afterSequence?: number | undefined;
  },
): Promise<ProductListRow[]> {
  const fragment = query.q === undefined ? null : query.q.toLowerCase();

  const rows = await tx.execute<ProductListRow>(sql`
    select ${PRODUCT_COLUMNS},
      c.name as category_name,
      (select count(*)::int from catalog.skus s
        where s.org_id = p.org_id and s.product_id = p.id and s.status = 'active') as sku_count,
      (select min(s.price_poisha)::text from catalog.skus s
        where s.org_id = p.org_id and s.product_id = p.id and s.status = 'active') as min_price_poisha,
      (select max(s.price_poisha)::text from catalog.skus s
        where s.org_id = p.org_id and s.product_id = p.id and s.status = 'active') as max_price_poisha,
      (select i.file_id from catalog.product_images i
        where i.org_id = p.org_id and i.product_id = p.id
        order by i.position, i.created_at limit 1) as image_file_id
    from catalog.products p
    left join catalog.categories c on c.org_id = p.org_id and c.id = p.category_id
    where p.org_id = ${orgId}
      and ${fragment === null ? sql`true` : sql`p.search_text like ${'%' + fragment + '%'}`}
      and ${
        query.categoryId === undefined
          ? sql`true`
          : // Everything under that category, not only its direct children: a
            // person filtering by "Menswear" means the subtree, and `path` is
            // maintained by 0026 precisely so this is an index range rather than
            // a recursive query on every list render.
            sql`(p.category_id = ${query.categoryId}::uuid
                 or c.path like (select cc.path || '/%' from catalog.categories cc
                                 where cc.org_id = p.org_id and cc.id = ${query.categoryId}::uuid))`
      }
      and ${query.status === undefined ? sql`true` : sql`p.status = ${query.status}::catalog.product_status`}
      and ${query.afterSequence === undefined ? sql`true` : sql`p.sequence > ${query.afterSequence}`}
    order by p.sequence
    limit ${query.limit}
  `);
  return [...rows];
}

// --- SKUs -------------------------------------------------------------------

export async function skusOfProduct(tx: Tx, orgId: string, productId: string): Promise<SkuRow[]> {
  const rows = await tx.execute<SkuRow>(sql`
    select ${SKU_COLUMNS} from catalog.skus s
    where s.org_id = ${orgId} and s.product_id = ${productId}
    order by s.position, s.code
  `);
  return [...rows];
}

export async function variantKeysOfProduct(
  tx: Tx,
  orgId: string,
  productId: string,
): Promise<string[]> {
  // `for update` on the product row is taken by the caller; this read only needs
  // to see every existing key so `matrixPlan` can exclude them.
  const rows = await tx.execute<{ variant_key: string }>(sql`
    select variant_key from catalog.skus where org_id = ${orgId} and product_id = ${productId}
  `);
  return rows.map((row) => row.variant_key);
}

export interface NewSku {
  readonly productId: string;
  readonly code: string;
  readonly variantKey: string;
  readonly pricePoisha: bigint;
  readonly position: number;
  readonly values: readonly { readonly attributeId: string; readonly valueId: string }[];
}

/**
 * Insert the new SKUs and their variant values.
 *
 * One multi-row insert for the SKUs and one for their values, rather than a loop:
 * a fifteen-variant matrix is two round trips instead of thirty, and — more
 * importantly — one statement each means the whole matrix is one atomic step, so
 * a failure on the twelfth variant cannot leave eleven behind.
 */
export async function insertSkus(
  tx: Tx,
  orgId: string,
  newSkus: readonly NewSku[],
): Promise<SkuRow[]> {
  if (newSkus.length === 0) return [];

  const skuRows = await tx.execute<SkuRow>(sql`
    insert into catalog.skus (org_id, product_id, code, variant_key, price_poisha, position)
    values ${sql.join(
      newSkus.map(
        (sku) =>
          sql`(${orgId}, ${sku.productId}, ${sku.code}, ${sku.variantKey},
               ${sku.pricePoisha.toString()}::bigint, ${sku.position})`,
      ),
      sql`, `,
    )}
    returning id, org_id, product_id, code, variant_key, barcode, price_poisha,
              status::text as status, position
  `);

  const byKey = new Map(skuRows.map((row) => [row.variant_key, row.id]));
  const values = newSkus.flatMap((sku) =>
    sku.values.map((value) => ({ skuId: byKey.get(sku.variantKey), ...value })),
  );

  if (values.length > 0) {
    await tx.execute(sql`
      insert into catalog.sku_values (org_id, sku_id, attribute_id, value_id)
      values ${sql.join(
        values.map(
          (value) =>
            sql`(${orgId}, ${value.skuId ?? null}, ${value.attributeId}, ${value.valueId})`,
        ),
        sql`, `,
      )}
    `);
  }

  return [...skuRows];
}

export async function searchSkus(
  tx: Tx,
  orgId: string,
  query: {
    readonly q?: string | undefined;
    readonly code?: string | undefined;
    readonly limit: number;
  },
): Promise<(SkuRow & { product_name: string; category_id: string | null })[]> {
  const fragment = query.q === undefined ? null : query.q.toUpperCase();
  const rows = await tx.execute<SkuRow & { product_name: string; category_id: string | null }>(sql`
    select ${SKU_COLUMNS}, p.name as product_name, p.category_id
    from catalog.skus s
    join catalog.products p on p.org_id = s.org_id and p.id = s.product_id
    where s.org_id = ${orgId}
      and ${
        query.code === undefined
          ? sql`true`
          : // A scanner's exact hit: the unique btree indexes answer this, so it
            // never touches the trigram index.
            sql`(s.code = ${query.code.toUpperCase()} or s.barcode = ${query.code})`
      }
      and ${fragment === null ? sql`true` : sql`s.code like ${'%' + fragment + '%'}`}
    order by s.code
    limit ${query.limit}
  `);
  return [...rows];
}

/**
 * The till's price list: active SKUs of active products, keyset-paged by code.
 *
 * Its own narrow column list rather than `SKU_COLUMNS`: the till needs five
 * fields, and a row that never selects a column cannot leak it.
 */
export async function sellableSkus(
  tx: Tx,
  orgId: string,
  page: { readonly afterCode: string | null; readonly limit: number },
): Promise<
  {
    id: string;
    code: string;
    barcode: string | null;
    product_name: string;
    price_poisha: string;
  }[]
> {
  const rows = await tx.execute<{
    id: string;
    code: string;
    barcode: string | null;
    product_name: string;
    price_poisha: string;
  }>(sql`
    select s.id, s.code, s.barcode, p.name as product_name, s.price_poisha::text as price_poisha
    from catalog.skus s
    join catalog.products p on p.org_id = s.org_id and p.id = s.product_id
    where s.org_id = ${orgId} and s.status = 'active' and p.status = 'active'
      and ${page.afterCode === null ? sql`true` : sql`s.code > ${page.afterCode}`}
    order by s.code
    limit ${page.limit}
  `);
  return [...rows];
}

export async function skusByIds(
  tx: Tx,
  orgId: string,
  ids: readonly string[],
): Promise<(SkuRow & { product_name: string; category_id: string | null })[]> {
  if (ids.length === 0) return [];
  const rows = await tx.execute<SkuRow & { product_name: string; category_id: string | null }>(sql`
    select ${SKU_COLUMNS}, p.name as product_name, p.category_id
    from catalog.skus s
    join catalog.products p on p.org_id = s.org_id and p.id = s.product_id
    where s.org_id = ${orgId} and s.id = any (${sql.param([...ids])}::uuid[])
    order by s.code
  `);
  return [...rows];
}

/**
 * Category name and size label per SKU (M16's buyer favourites).
 *
 * At most one size per SKU: `sku_values_pk` is one value per attribute, and a product with
 * two attributes of kind `size` would be a catalog mistake, so the lowest-positioned one
 * wins rather than the row doubling.
 */
export async function skuFacets(
  tx: Tx,
  orgId: string,
  ids: readonly string[],
): Promise<{ sku_id: string; category_name: string | null; size_label: string | null }[]> {
  if (ids.length === 0) return [];
  const rows = await tx.execute<{
    sku_id: string;
    category_name: string | null;
    size_label: string | null;
  }>(sql`
    select s.id as sku_id, c.name as category_name,
           (select v.label
              from catalog.sku_values sv
              join catalog.attributes a on a.org_id = sv.org_id and a.id = sv.attribute_id
              join catalog.attribute_values v on v.org_id = sv.org_id and v.id = sv.value_id
             where sv.org_id = s.org_id and sv.sku_id = s.id and a.kind = 'size'
             order by a.position, a.code
             limit 1) as size_label
    from catalog.skus s
    join catalog.products p on p.org_id = s.org_id and p.id = s.product_id
    left join catalog.categories c on c.org_id = p.org_id and c.id = p.category_id
    where s.org_id = ${orgId} and s.id = any (${sql.param([...ids])}::uuid[])
  `);
  return [...rows];
}

export async function skusByCodes(
  tx: Tx,
  orgId: string,
  codes: readonly string[],
): Promise<SkuRow[]> {
  if (codes.length === 0) return [];
  const rows = await tx.execute<SkuRow>(sql`
    select ${SKU_COLUMNS} from catalog.skus s
    where s.org_id = ${orgId} and s.code = any (${sql.param([...codes])}::text[])
  `);
  return [...rows];
}

/** Every SKU code and barcode in the org, any status, for M14a's SKU importer. */
export async function allSkuCodesAndBarcodes(
  tx: Tx,
  orgId: string,
): Promise<{ code: string; barcode: string | null }[]> {
  const rows = await tx.execute<{ code: string; barcode: string | null }>(sql`
    select code, barcode from catalog.skus where org_id = ${orgId}
  `);
  return [...rows];
}

/** Every product's name and slug, for M14a's SKU importer. */
export async function productNamesAndSlugs(
  tx: Tx,
  orgId: string,
): Promise<{ name: string; slug: string }[]> {
  const rows = await tx.execute<{ name: string; slug: string }>(sql`
    select name, slug from catalog.products where org_id = ${orgId}
  `);
  return [...rows];
}

export async function allSkuCodesAndPrices(
  tx: Tx,
  orgId: string,
): Promise<{ code: string; price_poisha: string }[]> {
  const rows = await tx.execute<{ code: string; price_poisha: string }>(sql`
    select code, price_poisha from catalog.skus where org_id = ${orgId} and status = 'active'
  `);
  return [...rows];
}

/**
 * Set the price of one SKU.
 *
 * The history row is written by migration 0026's trigger, not here. `reason` and
 * the acting user reach it through transaction-local settings, which is what
 * `setPriceContext` below is for — the alternative is passing them down as columns
 * the `skus` table has no business carrying.
 */
export async function setSkuPrice(
  tx: Tx,
  orgId: string,
  skuId: string,
  pricePoisha: bigint,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update catalog.skus set price_poisha = ${pricePoisha.toString()}::bigint, updated_at = now()
    where org_id = ${orgId} and id = ${skuId}
    returning id
  `);
  return rows.length === 1;
}

export async function setSkuPriceByCode(
  tx: Tx,
  orgId: string,
  code: string,
  pricePoisha: bigint,
  barcode: string | null,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update catalog.skus set
      price_poisha = ${pricePoisha.toString()}::bigint,
      barcode = coalesce(${barcode}, barcode),
      updated_at = now()
    where org_id = ${orgId} and code = ${code}
    returning id
  `);
  return rows.length === 1;
}

/**
 * Tell 0026's price-history trigger why the price changed.
 *
 * Transaction-local (`set_config(…, true)`), so it cannot leak to the next
 * borrower of a pooled connection — the same reason `withOrg` sets `app.org_id`
 * that way (D-043).
 */
export async function setPriceContext(tx: Tx, reason: string | null): Promise<void> {
  await tx.execute(sql`select set_config('app.price_reason', ${reason ?? ''}, true)`);
}

export async function setSkuBarcode(
  tx: Tx,
  orgId: string,
  skuId: string,
  barcode: string | null,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update catalog.skus set barcode = ${barcode}, updated_at = now()
    where org_id = ${orgId} and id = ${skuId}
    returning id
  `);
  return rows.length === 1;
}

export async function priceHistory(
  tx: Tx,
  orgId: string,
  skuId: string,
  limit: number,
): Promise<
  {
    from_poisha: string | null;
    to_poisha: string;
    changed_by: string | null;
    reason: string | null;
    created_at: Date;
  }[]
> {
  const rows = await tx.execute<{
    from_poisha: string | null;
    to_poisha: string;
    changed_by: string | null;
    reason: string | null;
    created_at: Date;
  }>(sql`
    select from_poisha, to_poisha, changed_by, reason, created_at
    from catalog.sku_price_history
    where org_id = ${orgId} and sku_id = ${skuId}
    order by created_at desc, id desc
    limit ${limit}
  `);
  return [...rows];
}

// --- images -----------------------------------------------------------------

export interface ImageRow extends Record<string, unknown> {
  readonly id: string;
  readonly file_id: string;
  readonly position: number;
  readonly alt_text: string | null;
}

export async function imagesOfProduct(
  tx: Tx,
  orgId: string,
  productId: string,
): Promise<ImageRow[]> {
  const rows = await tx.execute<ImageRow>(sql`
    select i.id, i.file_id, i.position, i.alt_text
    from catalog.product_images i
    where i.org_id = ${orgId} and i.product_id = ${productId}
    order by i.position, i.created_at
  `);
  return [...rows];
}

/**
 * Attach an image, but only a file that is public, stored and an image.
 *
 * The `insert … select … where` shape is the point: it is one statement, so there
 * is no window between checking the file and using it. A `pending` file — a
 * presigned upload that never completed — attached to a product is a broken
 * image on a product page, and a *private* file attached here would be served
 * from the public bucket path by anything that trusted the join.
 */
export async function attachImage(
  tx: Tx,
  orgId: string,
  productId: string,
  fileId: string,
  altText: string | null,
): Promise<ImageRow | undefined> {
  const rows = await tx.execute<ImageRow>(sql`
    insert into catalog.product_images (org_id, product_id, file_id, position, alt_text)
    select ${orgId}, ${productId}, f.id,
      coalesce((select max(i.position) + 1 from catalog.product_images i
                where i.org_id = ${orgId} and i.product_id = ${productId}), 0),
      ${altText}
    from files.objects f
    where f.org_id = ${orgId}
      and f.id = ${fileId}
      and f.status = 'stored'
      and f.visibility = 'public'
      and f.purpose = 'product-image'
    returning id, file_id, position, alt_text
  `);
  return rows[0];
}

export async function detachImage(
  tx: Tx,
  orgId: string,
  productId: string,
  imageId: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from catalog.product_images
    where org_id = ${orgId} and product_id = ${productId} and id = ${imageId}
    returning id
  `);
  return rows.length === 1;
}

/**
 * Write a new image order.
 *
 * One statement with a VALUES list joined on, rather than an UPDATE per image:
 * the ordering is one fact, and applying it row by row means a page refresh in
 * the middle of the loop shows an order nobody chose. The row count comes back so
 * the service can refuse an `imageIds` list that is not exactly this product's
 * images.
 */
export async function reorderImages(
  tx: Tx,
  orgId: string,
  productId: string,
  imageIds: readonly string[],
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    update catalog.product_images i
    set position = ordered.position
    from (values ${sql.join(
      imageIds.map((id, index) => sql`(${id}::uuid, ${index}::integer)`),
      sql`, `,
    )}) as ordered(id, position)
    where i.org_id = ${orgId} and i.product_id = ${productId} and i.id = ordered.id
    returning i.id
  `);
  return rows.length;
}

// --- variant values, for presentation ---------------------------------------

export interface SkuValueRow extends Record<string, unknown> {
  readonly sku_id: string;
  readonly attribute_id: string;
  readonly attribute_code: string;
  readonly attribute_name: string;
  readonly value_id: string;
  readonly value_code: string;
  readonly value_label: string;
  readonly attribute_position: number;
}

export async function valuesOfSkus(
  tx: Tx,
  orgId: string,
  skuIds: readonly string[],
): Promise<SkuValueRow[]> {
  if (skuIds.length === 0) return [];
  const rows = await tx.execute<SkuValueRow>(sql`
    select v.sku_id, v.attribute_id, a.code as attribute_code, a.name as attribute_name,
           v.value_id, av.code as value_code, av.label as value_label,
           a.position as attribute_position
    from catalog.sku_values v
    join catalog.attributes a on a.org_id = v.org_id and a.id = v.attribute_id
    join catalog.attribute_values av on av.org_id = v.org_id and av.id = v.value_id
    where v.org_id = ${orgId} and v.sku_id = any (${sql.param([...skuIds])}::uuid[])
    order by a.position, a.code
  `);
  return [...rows];
}

/** A scope filter the handler must apply, as `scopeWhere` produced it. */
export type ScopeSql = SQL;
