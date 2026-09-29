import type { Tx } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * The buyer list (M11 Build list; acceptance check 2).
 *
 * One definition of "a buyer who matches", used by the page, the count and the export —
 * three separate queries would be three chances for the number on the screen to disagree
 * with the rows in the file, which is exactly what check 2 is about. `matchingSql` is that
 * definition, and everything below is built on it.
 *
 * **A buyer matches** when they have at least one order in this brand that is not
 * cancelled, whose Asia/Dhaka order date is inside the range, whose channel is the one
 * asked for, and which has at least one line matching every line filter given. A cancelled
 * order is not a purchase: it is how the desk undid one, and a retargeting list built from
 * it would advertise to people who said no.
 *
 * ## Why the filters read the order line's snapshot
 *
 * `product` and `sku` compare against `sku_code` and `product_name` **as the line recorded
 * them**. Those are what the buyer bought, they never change (0041 freezes a shipped line,
 * and a SKU code is immutable in the catalog), and reading them keeps this module out of
 * `catalog.*` (invariant 12).
 *
 * `size` is the one that needs a sentence. A SKU's size is a catalog attribute, and the
 * catalog's attribute tables are not this module's to read. But `buildSkuCode` writes every
 * variant value into the code as its own segment, after the product's zero-padded sequence
 * number — `ELY-SHRT-0042-BLK-M` — so "size M" is precisely "a variant segment equal to M".
 * The pattern anchors on the sequence segment (four or more digits) so that an org or a
 * category code cannot be mistaken for a variant, and `size` is validated to
 * `^[A-Z0-9]{1,8}$` at the edge, so it cannot carry a regular-expression metacharacter
 * into the pattern. The limit is stated as a decision: a colour whose code is also a size
 * code would match both. A `CatalogApi` method returning the SKUs with a given attribute
 * value is the follow-up that retires the pattern.
 */

export interface BuyerFilters {
  readonly product?: string | undefined;
  readonly sku?: string | undefined;
  readonly size?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly channel?: string | undefined;
}

/** A LIKE pattern that matches the fragment literally, wildcards and all. */
export function containsPattern(fragment: string): string {
  return `%${fragment.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** The regular expression a size code is matched with. Exported for the tests. */
export function sizePattern(size: string): string {
  if (!/^[A-Z0-9]{1,8}$/.test(size)) throw new Error('A size code is 1-8 letters or digits.');
  return `-[0-9]{4,}(-[A-Z0-9]+)*-${size}(-|$)`;
}

function lineFilter(filters: BuyerFilters): SQL {
  const clauses: SQL[] = [];
  if (filters.product !== undefined) {
    clauses.push(sql`l.product_name ilike ${containsPattern(filters.product)}`);
  }
  if (filters.sku !== undefined) clauses.push(sql`l.sku_code = ${filters.sku}`);
  if (filters.size !== undefined) clauses.push(sql`l.sku_code ~ ${sizePattern(filters.size)}`);
  return clauses.length === 0 ? sql`true` : sql.join(clauses, sql` and `);
}

/**
 * One row per matching buyer, with what they bought inside the filters.
 *
 * `scope` is the caller's §6 filter over the orders. Every role holding `export
 * BuyerExport` today holds it at `org`, so it renders `true`; it is threaded through anyway,
 * because a list of phone numbers is the last place a later, narrower grant should be able
 * to arrive without anyone noticing it had no effect.
 */
function matchingSql(orgId: string, filters: BuyerFilters, scope: SQL): SQL {
  return sql`
    select o.customer_id,
           count(distinct o.id)::int as orders,
           sum(l.qty)::int as units,
           max(o.created_at) as last_order_at
    from sales.orders o
    join sales.order_lines l on l.org_id = o.org_id and l.order_id = o.id
    where o.org_id = ${orgId}
      and ${scope}
      and o.status <> 'cancelled'
      and ${filters.channel === undefined ? sql`true` : sql`o.channel = ${filters.channel}::sales.order_channel`}
      and ${
        filters.from === undefined
          ? sql`true`
          : sql`(o.created_at at time zone 'Asia/Dhaka')::date >= ${filters.from}::date`
      }
      and ${
        filters.to === undefined
          ? sql`true`
          : sql`(o.created_at at time zone 'Asia/Dhaka')::date <= ${filters.to}::date`
      }
      and ${lineFilter(filters)}
    group by o.customer_id`;
}

export interface BuyerRow extends Record<string, unknown> {
  readonly customer_id: string;
  readonly name: string;
  readonly phone_e164: string;
  readonly district_en: string | null;
  readonly thana_en: string | null;
  readonly orders: number;
  readonly units: number;
  readonly last_order_at: string;
}

/**
 * The page, or with `limit` null the whole list (the export).
 *
 * The district and thana are the buyer's **latest** order's, not their saved default: the
 * address a parcel last went to is the one that is known to work.
 *
 * Ordered by the last matching order, newest first, then by id — the tie-break is what makes
 * offset paging stable, so a buyer cannot appear on two pages or on none while the list is
 * being read.
 */
export async function buyerRows(
  tx: Tx,
  orgId: string,
  filters: BuyerFilters,
  scope: SQL,
  page: { readonly limit: number; readonly offset: number } | null,
): Promise<BuyerRow[]> {
  const rows = await tx.execute<BuyerRow>(sql`
    with matching as (${matchingSql(orgId, filters, scope)})
    select c.id as customer_id, c.name, c.phone_e164,
           latest.district_en, latest.thana_en,
           m.orders, m.units, m.last_order_at
    from matching m
    join sales.customers c on c.org_id = ${orgId} and c.id = m.customer_id
    left join lateral (
      select d.name_en as district_en, t.name_en as thana_en
      from sales.orders o
      join ref.districts d on d.id = o.ship_district_id
      join ref.thanas t on t.id = o.ship_thana_id
      where o.org_id = ${orgId} and o.customer_id = m.customer_id
        and o.status <> 'cancelled'
        and ${scope}
      order by o.created_at desc
      limit 1
    ) latest on true
    order by m.last_order_at desc, c.id
    ${page === null ? sql`` : sql`limit ${page.limit} offset ${page.offset}`}
  `);
  return [...rows];
}

export async function buyerCount(
  tx: Tx,
  orgId: string,
  filters: BuyerFilters,
  scope: SQL,
): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    with matching as (${matchingSql(orgId, filters, scope)})
    select count(*)::int as n from matching
  `);
  return rows[0]?.n ?? 0;
}
