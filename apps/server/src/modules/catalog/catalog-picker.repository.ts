import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * The inbox's product picker (M44b, D-772): what an agent selling in a chat finds as they type.
 *
 * Fast on purpose. Three narrow reads, each on an index, rather than one query with an OR that
 * no index serves: a scanned barcode or a whole SKU code (`skus_org_barcode_idx`,
 * `skus_org_code_idx`), a website slug or one it used to have (`products_org_slug_idx`,
 * `products_previous_slugs_idx`), then each typed word against `search_text` (the name, slug and
 * every SKU code, lower-cased, under 0025's trigram index), so "eid blue panjabi" finds the
 * product whatever the order of its words and a parent SKU (`ELY-PNJ-0042`) finds every size.
 * Active products only: a draft or archived product is not sold. No price and no cost here; the
 * selling prices come from `webSkus`.
 */

export interface PickerProductRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly size_chart_id: string | null;
  readonly image_file_id: string | null;
}

/** `%`, `_` and `\` typed by a person are letters, not patterns. */
const likeEscape = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The product ids for what was typed, best first, and the SKU it named exactly, if one. */
export async function pickerProductIds(
  tx: Tx,
  orgId: string,
  q: string,
  limit: number,
): Promise<{ ids: string[]; matchedSkus: Map<string, string> }> {
  const raw = q.trim();
  const lower = raw.toLowerCase();
  const ids: string[] = [];
  const matchedSkus = new Map<string, string>();
  const add = (id: string) => {
    if (!ids.includes(id)) ids.push(id);
  };

  const exact = await tx.execute<{ id: string; product_id: string }>(sql`
    select s.id, s.product_id
    from catalog.skus s
    join catalog.products p on p.org_id = s.org_id and p.id = s.product_id
    where s.org_id = ${orgId}
      and (s.barcode = ${raw} or s.code = ${raw.toUpperCase()})
      and s.status = 'active' and p.status = 'active'
    limit 1
  `);
  for (const row of exact) {
    add(row.product_id);
    matchedSkus.set(row.product_id, row.id);
  }

  if (SLUG.test(lower)) {
    const bySlug = await tx.execute<{ id: string }>(sql`
      select p.id from catalog.products p
      where p.org_id = ${orgId} and p.status = 'active'
        and (p.slug = ${lower} or p.previous_slugs @> array[${lower}]::text[])
      limit 2
    `);
    for (const row of bySlug) add(row.id);
  }

  const words = [...new Set(lower.split(/\s+/).filter((word) => [...word].length >= 2))].slice(
    0,
    6,
  );
  if (words.length > 0 && ids.length < limit) {
    const phrase = likeEscape(lower);
    const conditions = words.map((word) => sql`p.search_text like ${'%' + likeEscape(word) + '%'}`);
    const rows = await tx.execute<{ id: string }>(sql`
      select p.id
      from catalog.products p
      where p.org_id = ${orgId} and p.status = 'active'
        and ${sql.join(conditions, sql` and `)}
      order by
        case
          when lower(p.name) like ${phrase + '%'} then 0
          when lower(p.name) like ${'% ' + phrase + '%'} then 1
          when lower(p.name) like ${'%' + phrase + '%'} then 2
          else 3
        end,
        p.sequence desc
      limit ${limit}
    `);
    for (const row of rows) add(row.id);
  }
  return { ids: ids.slice(0, limit), matchedSkus };
}

/** These products, active ones only, with their size chart and first photo; order kept. */
export async function pickerProductsByIds(
  tx: Tx,
  orgId: string,
  ids: readonly string[],
): Promise<PickerProductRow[]> {
  if (ids.length === 0) return [];
  const rows = await tx.execute<PickerProductRow>(sql`
    select p.id, p.name, p.size_chart_id,
      (select i.file_id from catalog.product_images i
        where i.org_id = p.org_id and i.product_id = p.id
        order by i.position, i.created_at limit 1) as image_file_id
    from catalog.products p
    where p.org_id = ${orgId} and p.status = 'active'
      and p.id = any (${sql.param([...ids])}::uuid[])
  `);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined ? [] : [row];
  });
}

/** The brand's colour names (values of a colour list), for reading them in a chat. */
export async function colourNames(tx: Tx, orgId: string): Promise<string[]> {
  const rows = await tx.execute<{ label: string }>(sql`
    select distinct v.label
    from catalog.attribute_values v
    join catalog.attributes a on a.org_id = v.org_id and a.id = v.attribute_id
    where v.org_id = ${orgId} and a.kind = 'colour'
    order by v.label
    limit 500
  `);
  return rows.map((row) => row.label);
}
