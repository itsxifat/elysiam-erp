import { withSystem } from '@elysium/db';
import { businessDate } from '@elysium/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  APP_DOMAIN,
  ORG_A,
  ORIGIN,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { CrmService } from './crm.service.js';
import { applyOrderMigrations, seedCustomer, seedOrder } from './orders.testing.js';

/**
 * The buyer profile and the re-engagement list over HTTP, against real Postgres (M16).
 *
 * The phones are test values for this suite, not anybody's. Dates are relative to the day
 * the suite runs, because the routes ask "lapsed as of today"; every fixture sits well
 * clear of a boundary (5 or 100 days back against a 90-day cut-off), so the hour it runs
 * at cannot move a buyer across it.
 */

let harness: HttpHarness;
let admin: RoleClient;
let marketing: RoleClient;
let sales: RoleClient;

const OTHER_AGENT = 'usr_crm_other_agent';

interface Sku {
  readonly id: string;
  readonly code: string;
  readonly productName: string;
}
const sku: Record<'kurtaM' | 'kurtaL' | 'saree', Sku> = {} as never;

/** Two categories, a size attribute, and three SKUs: kurta in M and L, a saree with no size. */
async function seedCatalog(): Promise<void> {
  await withSystem(
    async (tx) => {
      const category = async (name: string, code: string) =>
        (
          await tx.execute<{ id: string }>(sql`
            insert into catalog.categories (org_id, name, slug, code)
            values (${ORG_A}, ${name}, ${name.toLowerCase().replace(/ /g, '-')}, ${code})
            returning id
          `)
        )[0]?.id ?? '';
      const kurtas = await category('Crm Kurta', 'CRMK');
      const sarees = await category('Crm Saree', 'CRMS');

      const [size] = await tx.execute<{ id: string }>(sql`
        insert into catalog.attributes (org_id, code, name, kind)
        values (${ORG_A}, 'CRMSIZE', 'Size', 'size') returning id
      `);
      const value = async (code: string) =>
        (
          await tx.execute<{ id: string }>(sql`
            insert into catalog.attribute_values (org_id, attribute_id, code, label)
            values (${ORG_A}, ${size?.id ?? ''}, ${code}, ${code}) returning id
          `)
        )[0]?.id ?? '';
      const medium = await value('M');
      const large = await value('L');

      const product = async (seq: number, name: string, categoryId: string) =>
        (
          await tx.execute<{ id: string }>(sql`
            insert into catalog.products (org_id, category_id, sequence, name, slug, status)
            values (${ORG_A}, ${categoryId}, ${seq}, ${name}, ${`crm-${String(seq)}`}, 'active')
            returning id
          `)
        )[0]?.id ?? '';
      const kurta = await product(9301, 'Crm Kurta Classic', kurtas);
      const saree = await product(9302, 'Crm Saree Silk', sarees);

      const skuOf = async (
        productId: string,
        productName: string,
        code: string,
        valueId: string | null,
      ): Promise<Sku> => {
        const [row] = await tx.execute<{ id: string }>(sql`
          insert into catalog.skus (org_id, product_id, code, variant_key, price_poisha, status)
          values (${ORG_A}, ${productId}, ${code}, ${code}, 150000, 'active') returning id
        `);
        const id = row?.id ?? '';
        if (valueId !== null) {
          await tx.execute(sql`
            insert into catalog.sku_values (org_id, sku_id, attribute_id, value_id)
            values (${ORG_A}, ${id}, ${size?.id ?? ''}, ${valueId})
          `);
        }
        return { id, code, productName };
      };
      sku.kurtaM = await skuOf(kurta, 'Crm Kurta Classic', 'CRMK-KRT-9301-M', medium);
      sku.kurtaL = await skuOf(kurta, 'Crm Kurta Classic', 'CRMK-KRT-9301-L', large);
      sku.saree = await skuOf(saree, 'Crm Saree Silk', 'CRMS-SRE-9302', null);
    },
    { orgId: ORG_A },
  );
}

function line(item: Sku, qty: number, delivered = 0) {
  return {
    skuId: item.id,
    skuCode: item.code,
    productName: item.productName,
    qty,
    unitPricePoisha: 150_000n,
    deliveredQty: delivered,
  };
}

/** An order placed `daysAgo` days back, delivered two days later when `delivered` is set. */
async function placed(
  customerId: string,
  input: {
    readonly daysAgo: number;
    readonly status: string;
    readonly lines: ReturnType<typeof line>[];
    readonly createdBy?: string;
    readonly assignedTo?: string | null;
  },
): Promise<string> {
  const { id } = await seedOrder(ORG_A, {
    customerId,
    status: input.status,
    lines: input.lines,
    createdBy: input.createdBy ?? OTHER_AGENT,
    assignedTo: input.assignedTo === undefined ? OTHER_AGENT : input.assignedTo,
  });
  await withSystem(
    (tx) =>
      tx.execute(sql`
        update sales.orders
        set created_at = now() - make_interval(days => ${input.daysAgo}),
            delivered_at = case when ${input.status} = 'delivered'
                                then now() - make_interval(days => ${input.daysAgo - 2})
                                else null end
        where org_id = ${ORG_A} and id = ${id}
      `),
    { orgId: ORG_A },
  );
  return id;
}

/** The counters the order transitions maintain, written as they would have left them. */
async function counters(customerId: string, delivered: number, ltvPoisha: bigint) {
  await withSystem(
    (tx) =>
      tx.execute(sql`
        update sales.customers
        set delivered_count = ${delivered}, orders_total = ${delivered},
            ltv_poisha = ${ltvPoisha.toString()}::bigint
        where org_id = ${ORG_A} and id = ${customerId}
      `),
    { orgId: ORG_A },
  );
}

async function get<T>(actor: RoleClient, url: string): Promise<{ status: number; body: T }> {
  const response = await actor.client.request('GET', url);
  return { status: response.statusCode, body: JSON.parse(response.body) as T };
}

async function download(actor: RoleClient, url: string) {
  return harness.server.inject({
    method: 'GET',
    url,
    headers: { host: APP_DOMAIN, origin: ORIGIN, cookie: actor.client.cookieHeader() },
  });
}

const buyers: Record<string, string> = {};

beforeAll(async () => {
  harness = await startHttpHarness('orders-crm');
  await applyOrderMigrations();
  await seedCatalog();
  admin = await harness.asRole('org_admin', ORG_A);
  marketing = await harness.asRole('marketing', ORG_A);
  sales = await harness.asRole('sales', ORG_A);

  // --- the profile's buyer: two delivered orders, one of them taken by the sales agent.
  buyers.profile = await seedCustomer(ORG_A, { phoneE164: '+8801700000301', name: 'Laila' });
  await placed(buyers.profile, {
    daysAgo: 20,
    status: 'delivered',
    lines: [line(sku.kurtaM, 2, 2), line(sku.kurtaL, 1, 1)],
    createdBy: sales.userId,
    assignedTo: sales.userId,
  });
  await placed(buyers.profile, {
    daysAgo: 10,
    status: 'delivered',
    lines: [line(sku.saree, 1, 1)],
  });
  await counters(buyers.profile, 2, 600_001n);

  // --- a buyer only another agent has sold to.
  buyers.othersOnly = await seedCustomer(ORG_A, { phoneE164: '+8801700000302', name: 'Hasan' });
  await placed(buyers.othersOnly, { daysAgo: 3, status: 'pending', lines: [line(sku.saree, 1)] });

  // --- the re-engagement fixture (90 days).
  buyers.lapsed = await seedCustomer(ORG_A, { phoneE164: '+8801700000311', name: 'Lapsed' });
  await placed(buyers.lapsed, {
    daysAgo: 100,
    status: 'delivered',
    lines: [line(sku.kurtaM, 1, 1)],
  });
  await counters(buyers.lapsed, 1, 150_000n);

  buyers.optedOut = await seedCustomer(ORG_A, { phoneE164: '+8801700000312', name: 'Quiet' });
  await placed(buyers.optedOut, {
    daysAgo: 100,
    status: 'delivered',
    lines: [line(sku.kurtaM, 1, 1)],
  });
  await counters(buyers.optedOut, 1, 150_000n);
  await withSystem(
    (tx) =>
      tx.execute(sql`
        insert into notify.opt_outs (org_id, phone, channel, created_by)
        values (${ORG_A}, '01700000312', 'sms', 'usr_crm_test') on conflict do nothing
      `),
    { orgId: ORG_A },
  );

  buyers.boughtAgain = await seedCustomer(ORG_A, { phoneE164: '+8801700000313', name: 'Back' });
  await placed(buyers.boughtAgain, {
    daysAgo: 100,
    status: 'delivered',
    lines: [line(sku.kurtaM, 1, 1)],
  });
  await placed(buyers.boughtAgain, { daysAgo: 5, status: 'pending', lines: [line(sku.saree, 1)] });
  await counters(buyers.boughtAgain, 1, 150_000n);

  buyers.cancelledSince = await seedCustomer(ORG_A, { phoneE164: '+8801700000314', name: 'Undo' });
  await placed(buyers.cancelledSince, {
    daysAgo: 100,
    status: 'delivered',
    lines: [line(sku.kurtaL, 1, 1)],
  });
  await placed(buyers.cancelledSince, {
    daysAgo: 5,
    status: 'cancelled',
    lines: [line(sku.saree, 1)],
  });
  await counters(buyers.cancelledSince, 1, 150_000n);

  buyers.neverDelivered = await seedCustomer(ORG_A, { phoneE164: '+8801700000315', name: 'None' });
  await placed(buyers.neverDelivered, {
    daysAgo: 100,
    status: 'returned',
    lines: [line(sku.kurtaM, 1)],
  });

  await harness.app.get(CrmService).runRfm(ORG_A, businessDate(new Date()));
}, 600_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

interface Profile {
  customer: { id: string; stats: { delivered: number; ltvPoisha: string } };
  averageOrderPoisha: string | null;
  favourites: {
    categories: { name: string; units: number }[];
    sizes: { label: string; units: number }[];
  };
  segment: { segment: string } | null;
  greetings: unknown[];
  recentOrders: { id: string }[];
}

describe('the buyer profile', () => {
  it('shows the totals, the average, the segment and the favourites the buyer kept', async () => {
    const { status, body } = await get<Profile>(admin, `/v1/customers/${buyers.profile}/profile`);
    expect(status).toBe(200);
    expect(body.customer.stats).toMatchObject({ delivered: 2, ltvPoisha: '600001' });
    // 600,001 / 2 = 300,000.5, half away from zero.
    expect(body.averageOrderPoisha).toBe('300001');
    expect(body.favourites.categories).toEqual([
      { name: 'Crm Kurta', units: 3 },
      { name: 'Crm Saree', units: 1 },
    ]);
    // The saree has no size, so it is not a favourite size called nothing.
    expect(body.favourites.sizes).toEqual([
      { label: 'M', units: 2 },
      { label: 'L', units: 1 },
    ]);
    expect(body.segment?.segment).toEqual(expect.any(String));
    expect(body.greetings).toEqual([]);
    expect(body.recentOrders).toHaveLength(2);
  });

  it('lists only the orders a sales agent could open, beside the brand-wide totals', async () => {
    const { status, body } = await get<Profile>(sales, `/v1/customers/${buyers.profile}/profile`);
    expect(status).toBe(200);
    expect(body.recentOrders).toHaveLength(1);
    expect(body.customer.stats.delivered).toBe(2);
  });

  it('is a 404 for a buyer outside the caller’s reach, as GET /v1/customers/:id is', async () => {
    const response = await sales.client.request(
      'GET',
      `/v1/customers/${buyers.othersOnly}/profile`,
    );
    expect(response.statusCode).toBe(404);
  });

  it('captures a birthday and an anniversary through the API, and clears one', async () => {
    const url = `/v1/customers/${buyers.neverDelivered}`;
    const set = await marketing.client.request('PATCH', url, {
      body: { birthday: '1994-03-21', anniversary: '2019-12-05' },
    });
    expect(set.statusCode, set.body).toBe(200);
    let { body } = await get<
      Profile & { customer: { birthday: string | null; anniversary: string | null } }
    >(admin, `${url}/profile`);
    expect(body.customer).toMatchObject({ birthday: '1994-03-21', anniversary: '2019-12-05' });

    // Typed on the wrong buyer: `null` takes it away, and the other date stays.
    const cleared = await marketing.client.request('PATCH', url, { body: { birthday: null } });
    expect(cleared.statusCode, cleared.body).toBe(200);
    ({ body } = await get<
      Profile & { customer: { birthday: string | null; anniversary: string | null } }
    >(admin, `${url}/profile`));
    expect(body.customer).toMatchObject({ birthday: null, anniversary: '2019-12-05' });
  });

  it('has no average for a buyer with nothing delivered', async () => {
    const { body } = await get<Profile>(admin, `/v1/customers/${buyers.neverDelivered}/profile`);
    expect(body.averageOrderPoisha).toBeNull();
    expect(body.favourites).toEqual({ categories: [], sizes: [] });
  });
});

interface Lapsed {
  total: number;
  lastOrderOnOrBefore: string;
  items: { customerId: string; phone: string; segment: string | null; ltvPoisha: string }[];
}

/** The same definition written a second way, so the route cannot agree with itself. */
async function directCount(days: number, segment?: string): Promise<number> {
  const [row] = await withSystem(
    (tx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n from sales.customers c
        where c.org_id = ${ORG_A}
          and c.delivered_count >= 1
          and exists (select 1 from sales.orders o
                      where o.org_id = c.org_id and o.customer_id = c.id and o.status <> 'cancelled')
          and not exists (
            select 1 from sales.orders o
            where o.org_id = c.org_id and o.customer_id = c.id and o.status <> 'cancelled'
              and (o.created_at at time zone 'Asia/Dhaka')::date
                  > (now() at time zone 'Asia/Dhaka')::date - ${days}::int)
          and not exists (
            select 1 from notify.opt_outs x
            where x.org_id = c.org_id and x.channel = 'sms'
              and '+880' || substr(x.phone, 2) = c.phone_e164)
          and ${
            segment === undefined
              ? sql`true`
              : sql`exists (select 1 from sales.customer_segments s
                            where s.org_id = c.org_id and s.customer_id = c.id
                              and s.segment = ${segment})`
          }
      `),
    { orgId: ORG_A },
  );
  return row?.n ?? -1;
}

describe('the re-engagement list', () => {
  it('lists buyers with nothing placed in 90 days, and leaves out who it should', async () => {
    const { status, body } = await get<Lapsed>(marketing, '/v1/crm/reengagement?days=90&limit=200');
    expect(status).toBe(200);
    const ids = body.items.map((item) => item.customerId);

    expect(ids).toContain(buyers.lapsed);
    // A cancelled order is not buying again.
    expect(ids).toContain(buyers.cancelledSince);
    // A pending order five days ago is.
    expect(ids).not.toContain(buyers.boughtAgain);
    // Asked for no more offers.
    expect(ids).not.toContain(buyers.optedOut);
    // Never received anything.
    expect(ids).not.toContain(buyers.neverDelivered);
    // Bought ten days ago.
    expect(ids).not.toContain(buyers.profile);

    expect(body.total).toBe(await directCount(90));
    expect(body.items.find((item) => item.customerId === buyers.lapsed)?.ltvPoisha).toBe('150000');
  });

  it('narrows to one segment', async () => {
    const all = await get<Lapsed>(marketing, '/v1/crm/reengagement?days=90&limit=200');
    const segment = all.body.items.find((item) => item.customerId === buyers.lapsed)?.segment;
    expect(segment).toEqual(expect.any(String));

    const { body } = await get<Lapsed>(
      marketing,
      `/v1/crm/reengagement?days=90&limit=200&segment=${segment ?? ''}`,
    );
    expect(body.items.every((item) => item.segment === segment)).toBe(true);
    expect(body.items.map((item) => item.customerId)).toContain(buyers.lapsed);
    expect(body.total).toBe(await directCount(90, segment ?? undefined));
  });

  it('exports what the list counts, and audits the filters but not the numbers', async () => {
    const listed = await get<Lapsed>(marketing, '/v1/crm/reengagement?days=90&limit=1');
    const csv = await download(marketing, '/v1/crm/reengagement/export?days=90&format=csv');
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(Number(csv.headers['x-row-count'])).toBe(listed.body.total);
    const text = csv.rawPayload.toString('utf8');
    expect(text).toContain('+8801700000311');
    expect(text).not.toContain('+8801700000312');
    // Exact taka, as text.
    expect(text).toContain('1500.00');

    const xlsx = await download(marketing, '/v1/crm/reengagement/export?days=90&format=xlsx');
    expect(xlsx.statusCode).toBe(200);

    const rows = await withSystem(
      (tx) =>
        tx.execute<{ after: unknown }>(sql`
          select after from audit.audit_log
          where org_id = ${ORG_A} and action = 'buyers.reengagement_exported'
            and actor_user_id = ${marketing.userId}
        `),
      { orgId: ORG_A },
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.after).toMatchObject({ filters: { days: 90, minDelivered: 1 } });
    expect(JSON.stringify(rows.map((row) => row.after))).not.toMatch(/\+?8801|01700/);
  });

  it('is behind export BuyerExport, like the buyer list', async () => {
    expect((await sales.client.request('GET', '/v1/crm/reengagement')).statusCode).toBe(403);
    expect((await download(sales, '/v1/crm/reengagement/export')).statusCode).toBe(403);
    expect((await admin.client.request('GET', '/v1/crm/reengagement')).statusCode).toBe(200);
  });

  it('refuses a cut-off of zero days rather than listing everybody', async () => {
    const response = await marketing.client.request('GET', '/v1/crm/reengagement?days=0');
    expect(response.statusCode).toBe(400);
  });
});
