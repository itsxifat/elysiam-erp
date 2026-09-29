import { inflateRawSync } from 'node:zlib';

import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  APP_DOMAIN,
  ORG_A,
  ORIGIN,
  auditRowsFor,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { applyOrderMigrations } from './orders.testing.js';

/**
 * The buyer list and its export (M11 acceptance check 2): **the export's row count equals
 * a direct SQL count for the same filters.**
 *
 * The direct count is written here, independently of `buyers.repository.ts` — a different
 * formulation (`count(distinct …)` rather than a grouped CTE, and the size rule as an
 * explicit walk over the code's segments rather than a regular expression) — so the two can
 * only agree by both being right. A test that called the repository's own count would be
 * comparing a query with itself.
 *
 * Every filter the Build list names is exercised on its own and in combination, against a
 * fixture built so that each filter excludes something: a cancelled order that would
 * otherwise match, a size that appears as a colour-adjacent segment, a second order from
 * the same buyer that must not make them two rows.
 */

let harness: HttpHarness;
let admin: RoleClient;
let marketing: RoleClient;
let sales: RoleClient;

const today = new Date();
function dhakaDate(offsetDays: number): string {
  const instant = new Date(today.getTime() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(instant);
}

interface Sku {
  readonly id: string;
  readonly code: string;
}
const sku: Record<string, Sku> = {};

/** Two products with sized SKU codes, written the way `buildSkuCode` writes them. */
async function seedSizedCatalog(): Promise<void> {
  await withSystem(
    async (tx) => {
      const products = [
        {
          seq: 9101,
          name: 'Kurta Classic',
          slug: 'buyers-kurta-classic',
          codes: ['BLK-M', 'BLK-L', 'RED-M'],
        },
        { seq: 9102, name: 'Denim Pant', slug: 'buyers-denim-pant', codes: ['32', '34'] },
      ];
      for (const product of products) {
        const rows = await tx.execute<{ id: string }>(sql`
          insert into catalog.products (org_id, sequence, name, slug, status)
          values (${ORG_A}, ${product.seq}, ${product.name}, ${product.slug}, 'active')
          returning id
        `);
        const productId = rows[0]?.id;
        if (productId === undefined) throw new Error('product insert returned nothing');
        for (const [index, variant] of product.codes.entries()) {
          const code = `TSTB-${product.seq === 9101 ? 'KRT' : 'PNT'}-${String(product.seq)}-${variant}`;
          const inserted = await tx.execute<{ id: string }>(sql`
            insert into catalog.skus (org_id, product_id, code, variant_key, price_poisha, status)
            values (${ORG_A}, ${productId}, ${code}, ${`b${String(index)}`}, 120000, 'active')
            returning id
          `);
          const id = inserted[0]?.id;
          if (id === undefined) throw new Error('sku insert returned nothing');
          sku[code] = { id, code };
        }
      }
    },
    { orgId: ORG_A },
  );
}

let phoneSeed = 30_000_000 + Math.floor(Math.random() * 40_000_000);
function freshPhone(): string {
  phoneSeed += 1;
  return `+88019${String(phoneSeed)}`;
}

function skuId(code: string): string {
  const found = sku[code];
  if (found === undefined) throw new Error(`no fixture SKU ${code}`);
  return found.id;
}

async function order(input: {
  readonly phone: string;
  readonly channel: string;
  readonly codes: readonly string[];
  readonly daysAgo?: number;
  readonly cancel?: boolean;
}): Promise<string> {
  const response = await admin.client.request('POST', '/v1/orders', {
    body: {
      channel: input.channel,
      customer: {
        phone: input.phone,
        name: 'Buyer List Fixture',
        address: { districtId: 47, thanaId: 365, addressLine: 'House 2, Road 9, Savar' },
      },
      lines: input.codes.map((code) => ({ skuId: skuId(code), qty: 1 })),
    },
  });
  if (response.statusCode !== 201) throw new Error(`order failed: ${response.body}`);
  const { id } = JSON.parse(response.body) as { id: string };
  if (input.cancel === true) {
    /*
     * Written as a fixture, the way `seedOrder` writes any status, rather than through
     * `POST /cancel`. That route asks the courier module whether a parcel is live, and this
     * suite is about the buyer list — it should not fail because another module's pending
     * migration has not reached the test database. `pending → cancelled` is a move 0041's
     * trigger allows, so the row is one the state machine could have produced.
     */
    await withSystem(
      async (tx) =>
        tx.execute(sql`
          update sales.orders
          set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Buyer changed their mind'
          where org_id = ${ORG_A} and id = ${id}
        `),
      { orgId: ORG_A },
    );
  }
  if (input.daysAgo !== undefined) {
    // Moved back in time directly: nothing on the order path may back-date an order, which
    // is the point of that path, and this fixture needs orders from other weeks.
    await withSystem(
      async (tx) =>
        tx.execute(sql`
          update sales.orders set created_at = now() - make_interval(days => ${input.daysAgo ?? 0})
          where org_id = ${ORG_A} and id = ${id}
        `),
      { orgId: ORG_A },
    );
  }
  return id;
}

beforeAll(async () => {
  harness = await startHttpHarness('orders-buyers');
  await applyOrderMigrations();
  await seedSizedCatalog();

  admin = await harness.asRole('org_admin', ORG_A);
  marketing = await harness.asRole('marketing', ORG_A);
  sales = await harness.asRole('sales', ORG_A);

  // B1..B6, as described in the file comment.
  const b1 = freshPhone();
  const b2 = freshPhone();
  const b3 = freshPhone();
  const b4 = freshPhone();
  const b5 = freshPhone();
  const b6 = freshPhone();
  await order({ phone: b1, channel: 'facebook', codes: ['TSTB-KRT-9101-BLK-M'] });
  await order({ phone: b2, channel: 'whatsapp', codes: ['TSTB-KRT-9101-BLK-L'] });
  await order({
    phone: b3,
    channel: 'facebook',
    codes: ['TSTB-KRT-9101-RED-M', 'TSTB-PNT-9102-32'],
    daysAgo: 10,
  });
  await order({ phone: b4, channel: 'landing_page', codes: ['TSTB-PNT-9102-34'] });
  await order({ phone: b4, channel: 'facebook', codes: ['TSTB-KRT-9101-BLK-M'], cancel: true });
  await order({ phone: b5, channel: 'facebook', codes: ['TSTB-KRT-9101-BLK-M'] });
  await order({ phone: b5, channel: 'facebook', codes: ['TSTB-KRT-9101-BLK-M'], daysAgo: 2 });
  await order({ phone: b6, channel: 'website', codes: ['TSTB-PNT-9102-32'], daysAgo: 40 });
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

// --- the independent count --------------------------------------------------------

interface Filters {
  readonly product?: string;
  readonly sku?: string;
  readonly size?: string;
  readonly from?: string;
  readonly to?: string;
  readonly channel?: string;
}

/** The same definition, written a second way. */
async function directCount(filters: Filters): Promise<number> {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{ n: number }>(sql`
        select count(distinct o.customer_id)::int as n
        from sales.orders o
        join sales.order_lines l on l.order_id = o.id and l.org_id = o.org_id
        where o.org_id = ${ORG_A}
          and o.status::text <> 'cancelled'
          and (${filters.channel ?? null}::text is null or o.channel::text = ${filters.channel ?? null})
          and (${filters.from ?? null}::date is null
               or (o.created_at at time zone 'Asia/Dhaka')::date >= ${filters.from ?? null}::date)
          and (${filters.to ?? null}::date is null
               or (o.created_at at time zone 'Asia/Dhaka')::date <= ${filters.to ?? null}::date)
          and (${filters.product ?? null}::text is null
               or position(lower(${filters.product ?? null}) in lower(l.product_name)) > 0)
          and (${filters.sku ?? null}::text is null or l.sku_code = ${filters.sku ?? null})
          and (${filters.size ?? null}::text is null or exists (
                select 1
                from unnest(string_to_array(l.sku_code, '-')) with ordinality as seg(part, pos)
                where seg.part = ${filters.size ?? null}
                  and seg.pos > (
                    select min(s.pos)
                    from unnest(string_to_array(l.sku_code, '-')) with ordinality as s(part, pos)
                    where s.part ~ '^[0-9]{4,}$'
                  )
              ))
      `),
    { orgId: ORG_A },
  );
  return rows[0]?.n ?? 0;
}

/** The byte-order mark the CSV starts with, so Excel reads its Bangla as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

function queryOf(filters: Filters): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(filters) as [string, string | undefined][]) {
    if (value !== undefined) params.set(name, value);
  }
  return params.toString();
}

/** A raw GET, for the file: the harness client decodes bodies as text, which an XLSX is not. */
async function download(actor: RoleClient, url: string) {
  const response = await harness.server.inject({
    method: 'GET',
    url,
    headers: { host: APP_DOMAIN, origin: ORIGIN, cookie: actor.client.cookieHeader() },
  });
  return response;
}

/** Rows in an XLSX's only sheet, header excluded. */
function xlsxRows(archive: Buffer): number {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (name === 'xl/worksheets/sheet1.xml') {
      const start =
        localOffset +
        30 +
        archive.readUInt16LE(localOffset + 26) +
        archive.readUInt16LE(localOffset + 28);
      const xml = inflateRawSync(archive.subarray(start, start + compressedSize)).toString('utf8');
      return (xml.match(/<row /g)?.length ?? 0) - 1;
    }
    cursor += 46 + nameLength;
  }
  throw new Error('no sheet in that workbook');
}

// --- check 2 ------------------------------------------------------------------------

const CASES: readonly {
  readonly name: string;
  readonly filters: Filters;
  readonly expected?: number;
}[] = [
  { name: 'no filter at all', filters: {} },
  // B1, B2, B3, B5 — B4's kurta order was cancelled.
  { name: 'product', filters: { product: 'kurta' }, expected: 4 },
  // B1, B3, B5 — BLK-L is not M, the pants are 32/34, B4's M was cancelled.
  { name: 'size', filters: { size: 'M' }, expected: 3 },
  // B1, B5 — B5 twice, still one buyer.
  { name: 'SKU', filters: { sku: 'TSTB-KRT-9101-BLK-M' }, expected: 2 },
  // B3 and B6.
  { name: 'a numeric size', filters: { size: '32' }, expected: 2 },
  { name: 'channel', filters: { channel: 'facebook' } },
  { name: 'date range', filters: { from: dhakaDate(-7), to: dhakaDate(0) } },
  // B1 and B5 only: B3's M is ten days old and B2's is L.
  {
    name: 'everything at once',
    filters: {
      product: 'Kurta',
      size: 'M',
      channel: 'facebook',
      from: dhakaDate(-7),
      to: dhakaDate(0),
    },
    expected: 2,
  },
];

describe('check 2: the export counts what SQL counts', () => {
  for (const testCase of CASES) {
    it(`agrees for ${testCase.name}, in the list, the CSV and the XLSX`, async () => {
      const query = queryOf(testCase.filters);
      const expected = await directCount(testCase.filters);
      if (testCase.expected !== undefined) expect(expected).toBe(testCase.expected);

      const page = await marketing.client.request('GET', `/v1/buyers?limit=200&${query}`);
      expect(page.statusCode).toBe(200);
      const listed = JSON.parse(page.body) as { total: number; items: unknown[] };
      expect(listed.total).toBe(expected);

      const csv = await download(marketing, `/v1/buyers/export?format=csv&${query}`);
      expect(csv.statusCode).toBe(200);
      expect(csv.headers['content-type']).toMatch(/^text\/csv/);
      const csvLines = csv.rawPayload.toString('utf8').replace(BOM, '').split('\r\n');
      // Header, the rows, and the empty string after the final CRLF.
      expect(csvLines.length - 2).toBe(expected);
      expect(Number(csv.headers['x-row-count'])).toBe(expected);

      const xlsx = await download(marketing, `/v1/buyers/export?format=xlsx&${query}`);
      expect(xlsx.statusCode).toBe(200);
      expect(xlsxRows(xlsx.rawPayload)).toBe(expected);
    }, 60_000);
  }

  it('writes one row per buyer however many orders they placed', async () => {
    const page = JSON.parse(
      (await marketing.client.request('GET', `/v1/buyers?sku=TSTB-KRT-9101-BLK-M`)).body,
    ) as { items: { orders: number; units: number }[] };
    expect(page.items.map((item) => item.orders).sort()).toEqual([1, 2]);
  }, 60_000);

  it('records who exported what, and not the numbers themselves', async () => {
    await download(admin, '/v1/buyers/export?format=csv&size=M');
    const rows = await withSystem(
      async (tx) =>
        tx.execute<{ entity_id: string; after: unknown }>(sql`
          select entity_id, after from audit.audit_log
          where org_id = ${ORG_A} and action = 'buyers.exported' and actor_user_id = ${admin.userId}
        `),
      { orgId: ORG_A },
    );
    expect(rows).toHaveLength(1);
    const entry = rows[0];
    expect(entry?.after).toMatchObject({ format: 'csv', rows: 3, filters: { size: 'M' } });
    expect(JSON.stringify(entry?.after)).not.toMatch(/\+8801/);
    expect((await auditRowsFor(ORG_A, entry?.entity_id ?? '')).length).toBe(1);
  }, 60_000);

  it('is §6’s BuyerExport: marketing and org_admin, never the desk', async () => {
    expect((await sales.client.request('GET', '/v1/buyers')).statusCode).toBe(403);
    expect((await download(sales, '/v1/buyers/export?format=csv')).statusCode).toBe(403);
    expect((await admin.client.request('GET', '/v1/buyers')).statusCode).toBe(200);
  }, 60_000);

  it('refuses a size that is not a variant code instead of matching nothing', async () => {
    const response = await marketing.client.request('GET', '/v1/buyers?size=M%7CL');
    expect(response.statusCode).toBe(400);
  }, 60_000);
});
