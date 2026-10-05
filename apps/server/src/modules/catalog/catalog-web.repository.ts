import type { Tx } from '@elysium/db';
import { escapeLike, type StorefrontCursor, type StorefrontSort } from '@elysium/domain/storefront';
import { sql, type SQL } from 'drizzle-orm';

/**
 * The catalog's SQL for the brand's website (M33, D-500, D-501, D-506).
 *
 * Its own file so the website's reads sit together and the console's statements in
 * `catalog.repository.ts` stay as they were. Same rules: raw, parameterised, inside the
 * caller's `withOrg()` transaction, and **no cost column anywhere** (invariant 5) — the
 * website reads the selling price and nothing a margin could be derived from.
 *
 * What the website sees of a product is decided here once, in `webWhere`: active, shown on
 * the website, and at least one active SKU. A product nobody can buy is not on a shop page.
 */

// --- the web fields --------------------------------------------------------------------------

export interface ProductWebRow extends Record<string, unknown> {
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
}

const WEB_COLUMNS = sql`web_visible, featured, new_arrival, gender, material, care_instructions,
  tags, size_chart_id, seo_title, seo_description, previous_slugs`;

export async function webFieldsOf(
  tx: Tx,
  orgId: string,
  productId: string,
): Promise<ProductWebRow | undefined> {
  const rows = await tx.execute<ProductWebRow>(sql`
    select ${WEB_COLUMNS} from catalog.products where org_id = ${orgId} and id = ${productId}
  `);
  return rows[0];
}

/** A field to write, or absent to leave alone. `null` is a value here (clear it). */
export type Change<T> = { readonly set: true; readonly value: T } | undefined;

function assign<T>(change: Change<T>, column: SQL, cast: SQL): SQL {
  return change === undefined
    ? column
    : sql`${change.value === null ? null : (change.value as unknown)}::${cast}`;
}

export interface ProductWebPatch {
  readonly webVisible?: Change<boolean>;
  readonly featured?: Change<boolean>;
  readonly newArrival?: Change<boolean>;
  readonly gender?: Change<string | null>;
  readonly material?: Change<string | null>;
  readonly careInstructions?: Change<string | null>;
  readonly tags?: Change<readonly string[]>;
  readonly sizeChartId?: Change<string | null>;
  readonly seoTitle?: Change<string | null>;
  readonly seoDescription?: Change<string | null>;
}

/**
 * Write the website card, one statement. `previous_slugs` is not here: only the slug
 * trigger writes it.
 */
export async function setWebFields(
  tx: Tx,
  orgId: string,
  productId: string,
  patch: ProductWebPatch,
): Promise<ProductWebRow | undefined> {
  const tags =
    patch.tags === undefined ? sql`tags` : sql`${sql.param([...patch.tags.value])}::text[]`;
  const rows = await tx.execute<ProductWebRow>(sql`
    update catalog.products set
      web_visible = ${assign(patch.webVisible, sql`web_visible`, sql`boolean`)},
      featured = ${assign(patch.featured, sql`featured`, sql`boolean`)},
      new_arrival = ${assign(patch.newArrival, sql`new_arrival`, sql`boolean`)},
      gender = ${assign(patch.gender, sql`gender`, sql`text`)},
      material = ${assign(patch.material, sql`material`, sql`text`)},
      care_instructions = ${assign(patch.careInstructions, sql`care_instructions`, sql`text`)},
      tags = ${tags},
      size_chart_id = ${assign(patch.sizeChartId, sql`size_chart_id`, sql`uuid`)},
      seo_title = ${assign(patch.seoTitle, sql`seo_title`, sql`text`)},
      seo_description = ${assign(patch.seoDescription, sql`seo_description`, sql`text`)},
      updated_at = now()
    where org_id = ${orgId} and id = ${productId}
    returning ${WEB_COLUMNS}
  `);
  return rows[0];
}

export interface CategoryWebRow extends Record<string, unknown> {
  readonly id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly slug: string;
  readonly position: number;
  readonly is_active: boolean;
  readonly web_visible: boolean;
  readonly featured: boolean;
  readonly gender: string | null;
  readonly description: string | null;
  readonly image_file_id: string | null;
}

const CATEGORY_WEB_COLUMNS = sql`id, parent_id, name, slug, position, is_active, web_visible,
  featured, gender, description, image_file_id`;

export async function webCategories(tx: Tx, orgId: string): Promise<CategoryWebRow[]> {
  const rows = await tx.execute<CategoryWebRow>(sql`
    select ${CATEGORY_WEB_COLUMNS} from catalog.categories where org_id = ${orgId} order by path
  `);
  return [...rows];
}

export interface CategoryWebPatch {
  readonly webVisible?: Change<boolean>;
  readonly featured?: Change<boolean>;
  readonly gender?: Change<string | null>;
  readonly description?: Change<string | null>;
  readonly imageFileId?: Change<string | null>;
}

/**
 * Whether a file may be a category's picture: stored, public, uploaded for category images.
 * The same three conditions as a product image (`attachImage`), for the same reasons.
 */
export async function isCategoryImage(tx: Tx, orgId: string, fileId: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    select f.id from files.objects f
    where f.org_id = ${orgId} and f.id = ${fileId}
      and f.status = 'stored' and f.visibility = 'public' and f.purpose = 'category-image'
  `);
  return rows.length === 1;
}

export async function setCategoryWebFields(
  tx: Tx,
  orgId: string,
  categoryId: string,
  patch: CategoryWebPatch,
): Promise<CategoryWebRow | undefined> {
  const rows = await tx.execute<CategoryWebRow>(sql`
    update catalog.categories set
      web_visible = ${assign(patch.webVisible, sql`web_visible`, sql`boolean`)},
      featured = ${assign(patch.featured, sql`featured`, sql`boolean`)},
      gender = ${assign(patch.gender, sql`gender`, sql`text`)},
      description = ${assign(patch.description, sql`description`, sql`text`)},
      image_file_id = ${assign(patch.imageFileId, sql`image_file_id`, sql`uuid`)},
      updated_at = now()
    where org_id = ${orgId} and id = ${categoryId}
    returning ${CATEGORY_WEB_COLUMNS}
  `);
  return rows[0];
}

export async function productsUsingSizeChart(
  tx: Tx,
  orgId: string,
  sizeChartId: string,
): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from catalog.products
    where org_id = ${orgId} and size_chart_id = ${sizeChartId}
  `);
  return rows[0]?.n ?? 0;
}

// --- the shop's list -------------------------------------------------------------------------

export interface WebFilter {
  /** Null: any category. An empty list: none (an unknown or hidden category). */
  readonly categoryIds: readonly string[] | null;
  readonly gender: string | null;
  readonly tags: readonly string[];
  readonly size: string | null;
  readonly minPricePoisha: bigint | null;
  readonly maxPricePoisha: bigint | null;
  readonly featured: boolean;
  readonly newArrival: boolean;
  readonly onSale: boolean;
  /** Lower-case words, every one of which must match. */
  readonly search: readonly string[];
  readonly excludeIds?: readonly string[];
  readonly ids?: readonly string[];
}

/** What the website may see of a product, and the shopper's filters, as one condition. */
function webWhere(orgId: string, filter: WebFilter): SQL {
  const conditions: SQL[] = [
    sql`p.org_id = ${orgId}`,
    sql`p.web_visible`,
    sql`p.status = 'active'`,
    sql`exists (select 1 from catalog.skus s
                where s.org_id = p.org_id and s.product_id = p.id and s.status = 'active')`,
  ];
  if (filter.ids !== undefined) {
    conditions.push(
      filter.ids.length === 0
        ? sql`false`
        : sql`p.id = any (${sql.param([...filter.ids])}::uuid[])`,
    );
  }
  if (filter.categoryIds !== null) {
    conditions.push(
      filter.categoryIds.length === 0
        ? sql`false`
        : sql`p.category_id = any (${sql.param([...filter.categoryIds])}::uuid[])`,
    );
  }
  if (filter.gender !== null) conditions.push(sql`p.gender = ${filter.gender}`);
  if (filter.tags.length > 0) {
    conditions.push(sql`p.tags @> ${sql.param([...filter.tags])}::text[]`);
  }
  if (filter.size !== null) {
    conditions.push(sql`exists (
      select 1 from catalog.skus s
      join catalog.sku_values v on v.org_id = s.org_id and v.sku_id = s.id
      join catalog.attributes a on a.org_id = v.org_id and a.id = v.attribute_id and a.kind = 'size'
      join catalog.attribute_values av on av.org_id = v.org_id and av.id = v.value_id
      where s.org_id = p.org_id and s.product_id = p.id and s.status = 'active'
        and (lower(av.label) = lower(${filter.size}) or lower(av.code) = lower(${filter.size})))`);
  }
  if (filter.minPricePoisha !== null || filter.maxPricePoisha !== null) {
    // Any one size in range, as the old shop filtered (a product "from ৳900 to ৳1,400"
    // is in a ৳1,000-৳1,200 search when one of its sizes is).
    const min = filter.minPricePoisha === null ? null : filter.minPricePoisha.toString();
    const max = filter.maxPricePoisha === null ? null : filter.maxPricePoisha.toString();
    conditions.push(sql`exists (
      select 1 from catalog.skus s
      where s.org_id = p.org_id and s.product_id = p.id and s.status = 'active'
        and (${min}::bigint is null or s.price_poisha >= ${min}::bigint)
        and (${max}::bigint is null or s.price_poisha <= ${max}::bigint))`);
  }
  if (filter.featured) conditions.push(sql`p.featured`);
  if (filter.newArrival) conditions.push(sql`p.new_arrival`);
  // Nothing is on offer until M35's flash sales exist (D-511): the old shop's "on sale"
  // filter also matched nothing, through a field its products never had.
  if (filter.onSale) conditions.push(sql`false`);
  for (const word of filter.search) {
    const pattern = `%${escapeLike(word)}%`;
    conditions.push(sql`(
      p.search_text like ${pattern} escape '\\'
      or exists (select 1 from catalog.categories c
                 where c.org_id = p.org_id and c.id = p.category_id
                   and c.is_active and c.web_visible
                   and (lower(c.name) like ${pattern} escape '\\' or c.slug like ${pattern} escape '\\')))`);
  }
  if (filter.excludeIds !== undefined && filter.excludeIds.length > 0) {
    conditions.push(sql`p.id <> all (${sql.param([...filter.excludeIds])}::uuid[])`);
  }
  return sql.join(conditions, sql` and `);
}

export interface WebCardRow extends Record<string, unknown> {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly category_id: string | null;
  readonly gender: string | null;
  readonly tags: string[];
  readonly featured: boolean;
  readonly new_arrival: boolean;
  /** `created_at` to the microsecond, as UTC ISO text: the newest/oldest cursor's key. */
  readonly created_key: string;
  readonly name_key: string;
  /** Selling prices of the active SKUs, poisha as decimal strings. */
  readonly min_price: string;
  readonly max_price: string;
}

/** Each sort's order, and the keyset condition that resumes after a cursor. */
function ordering(
  sort: StorefrontSort,
  cursor: StorefrontCursor | null,
): {
  readonly orderBy: SQL;
  readonly after: SQL;
} {
  switch (sort) {
    case 'newest':
    case 'oldest': {
      const direction = sort === 'newest' ? sql`desc` : sql`asc`;
      const after =
        cursor !== null && (cursor.sort === 'newest' || cursor.sort === 'oldest')
          ? sort === 'newest'
            ? sql`(w.created_at, w.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
            : sql`(w.created_at, w.id) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
          : sql`true`;
      return { orderBy: sql`w.created_at ${direction}, w.id ${direction}`, after };
    }
    case 'price-asc':
      return {
        orderBy: sql`w.min_price asc, w.id asc`,
        after:
          cursor?.sort === 'price-asc'
            ? sql`(w.min_price, w.id) > (${cursor.pricePoisha}::bigint, ${cursor.id}::uuid)`
            : sql`true`,
      };
    case 'price-desc':
      return {
        orderBy: sql`w.max_price desc, w.id desc`,
        after:
          cursor?.sort === 'price-desc'
            ? sql`(w.max_price, w.id) < (${cursor.pricePoisha}::bigint, ${cursor.id}::uuid)`
            : sql`true`,
      };
    case 'featured':
      return {
        orderBy: sql`w.featured desc, w.created_at desc, w.id desc`,
        after:
          cursor?.sort === 'featured'
            ? sql`(w.featured, w.created_at, w.id)
                  < (${cursor.featured}::boolean, ${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
            : sql`true`,
      };
    case 'name':
      return {
        orderBy: sql`w.name_key asc, w.id asc`,
        after:
          cursor?.sort === 'name'
            ? sql`(w.name_key, w.id) > (${cursor.name}::text, ${cursor.id}::uuid)`
            : sql`true`,
      };
  }
}

/** One page of the shop, `limit` rows (ask for one more to learn whether there is a next). */
export async function webProductPage(
  tx: Tx,
  orgId: string,
  filter: WebFilter,
  page: {
    readonly sort: StorefrontSort;
    readonly cursor: StorefrontCursor | null;
    readonly limit: number;
    readonly offset: number;
  },
): Promise<WebCardRow[]> {
  const { orderBy, after } = ordering(page.sort, page.cursor);
  const rows = await tx.execute<WebCardRow>(sql`
    select w.id, w.slug, w.name, w.category_id, w.gender, w.tags, w.featured, w.new_arrival,
           w.created_key, w.name_key, w.min_price::text as min_price, w.max_price::text as max_price
    from (
      select p.id, p.slug, p.name, p.category_id, p.gender, p.tags, p.featured, p.new_arrival,
        p.created_at,
        to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_key,
        lower(p.name) as name_key,
        (select min(s.price_poisha) from catalog.skus s
          where s.org_id = p.org_id and s.product_id = p.id and s.status = 'active') as min_price,
        (select max(s.price_poisha) from catalog.skus s
          where s.org_id = p.org_id and s.product_id = p.id and s.status = 'active') as max_price
      from catalog.products p
      where ${webWhere(orgId, filter)}
    ) w
    where ${after}
    order by ${orderBy}
    limit ${page.limit} offset ${page.offset}
  `);
  return [...rows];
}

export async function webProductCount(tx: Tx, orgId: string, filter: WebFilter): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from catalog.products p where ${webWhere(orgId, filter)}
  `);
  return rows[0]?.n ?? 0;
}

// --- one product -----------------------------------------------------------------------------

export interface WebProductRow extends WebCardRow {
  readonly description: string | null;
  readonly material: string | null;
  readonly care_instructions: string | null;
  readonly size_chart_id: string | null;
  readonly seo_title: string | null;
  readonly seo_description: string | null;
}

/** The product the website shows at this address now, or nothing. */
export async function webProductBySlug(
  tx: Tx,
  orgId: string,
  slug: string,
): Promise<WebProductRow | undefined> {
  const rows = await tx.execute<WebProductRow>(sql`
    select p.id, p.slug, p.name, p.category_id, p.gender, p.tags, p.featured, p.new_arrival,
      to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_key,
      lower(p.name) as name_key,
      (select min(s.price_poisha)::text from catalog.skus s
        where s.org_id = p.org_id and s.product_id = p.id and s.status = 'active') as min_price,
      (select max(s.price_poisha)::text from catalog.skus s
        where s.org_id = p.org_id and s.product_id = p.id and s.status = 'active') as max_price,
      p.description, p.material, p.care_instructions, p.size_chart_id, p.seo_title,
      p.seo_description
    from catalog.products p
    where ${webWhere(orgId, emptyFilter())} and p.slug = ${slug}
  `);
  return rows[0];
}

/**
 * Where an old address leads now: the current slug of the shown product that used to live
 * there, or nothing. The slug trigger keeps an address in at most one product's history, so
 * there is never a choice to make; `limit 2` and the length check refuse to guess if there
 * ever were.
 */
export async function webRedirectFor(
  tx: Tx,
  orgId: string,
  slug: string,
): Promise<string | undefined> {
  const rows = await tx.execute<{ slug: string }>(sql`
    select p.slug from catalog.products p
    where ${webWhere(orgId, emptyFilter())} and p.previous_slugs @> array[${slug}]::text[]
    limit 2
  `);
  return rows.length === 1 ? rows[0]?.slug : undefined;
}

export function emptyFilter(): WebFilter {
  return {
    categoryIds: null,
    gender: null,
    tags: [],
    size: null,
    minPricePoisha: null,
    maxPricePoisha: null,
    featured: false,
    newArrival: false,
    onSale: false,
    search: [],
  };
}

export interface WebSkuRow extends Record<string, unknown> {
  readonly id: string;
  readonly product_id: string;
  readonly code: string;
  readonly price_poisha: string;
  readonly position: number;
  /** `[{ kind, name, label, position }]`, attribute order. */
  readonly attrs: readonly {
    readonly kind: string;
    readonly name: string;
    readonly label: string;
    readonly position: number;
  }[];
}

/** The active SKUs of these products with their values: sizes, colours, the rest. */
export async function webSkusOf(
  tx: Tx,
  orgId: string,
  productIds: readonly string[],
): Promise<WebSkuRow[]> {
  if (productIds.length === 0) return [];
  const rows = await tx.execute<WebSkuRow>(sql`
    select s.id, s.product_id, s.code, s.price_poisha::text as price_poisha, s.position,
      coalesce(
        json_agg(json_build_object('kind', a.kind::text, 'name', a.name, 'label', av.label,
                                   'position', av.position)
                 order by a.position, a.code) filter (where v.sku_id is not null),
        '[]'::json) as attrs
    from catalog.skus s
    left join catalog.sku_values v on v.org_id = s.org_id and v.sku_id = s.id
    left join catalog.attributes a on a.org_id = v.org_id and a.id = v.attribute_id
    left join catalog.attribute_values av on av.org_id = v.org_id and av.id = v.value_id
    where s.org_id = ${orgId}
      and s.product_id = any (${sql.param([...productIds])}::uuid[])
      and s.status = 'active'
    group by s.id
    order by s.product_id, s.position, s.code
  `);
  return [...rows];
}

export interface WebImageRow extends Record<string, unknown> {
  readonly product_id: string;
  readonly file_id: string;
  readonly alt_text: string | null;
}

export async function webImagesOf(
  tx: Tx,
  orgId: string,
  productIds: readonly string[],
): Promise<WebImageRow[]> {
  if (productIds.length === 0) return [];
  const rows = await tx.execute<WebImageRow>(sql`
    select i.product_id, i.file_id, i.alt_text from catalog.product_images i
    where i.org_id = ${orgId} and i.product_id = any (${sql.param([...productIds])}::uuid[])
    order by i.product_id, i.position, i.created_at
  `);
  return [...rows];
}
