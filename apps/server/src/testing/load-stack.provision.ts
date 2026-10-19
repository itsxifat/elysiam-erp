import { randomBytes } from 'node:crypto';

import type { MembershipRole } from '@elysium/contracts';
import { createAuth, RecordingSmsProvider, SEED_ORG_IDS, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import {
  createTestUser,
  grantMembership,
  startTestDatabase,
  type TestDatabase,
} from '@elysium/db/testing';

import { applyIntakeMigrations } from '../modules/intake/intake.testing.js';
import { warehouseId } from '../modules/inventory/inventory.testing.js';

/**
 * The k6 load test's stack: a throwaway database at §29's sizes (M30).
 *
 * Test-only, run as a process of its own by `scripts/load-test.mjs` —
 * `node --env-file=.env dist/testing/load-stack.provision.js create` from `apps/server` —
 * which then starts the built API and worker against what this prints, and runs k6 at
 * them. The same shape as `desk-stack.provision.ts`, the console's real-stack harness:
 *
 * * **A database of its own**, made by `startTestDatabase` on the local Postgres and
 *   dropped through the harness's own `stop()` when the runner writes `stop` to stdin. A
 *   load test against `elysium_dev` would leave thousands of orders in a developer's data
 *   and measure whatever else that database happens to hold.
 * * **§29's sizes.** 20,000 SKUs (2,000 products of 10, with varied names and codes, as the
 *   catalog bench seeds them, so the trigram indexes answer the real question), every SKU
 *   in stock at the warehouse, and 5,000 buyers with an address, so a phone lookup is an
 *   index probe into a table of a realistic size rather than into an empty one.
 * * **Users through the real flow**: `createTestUser`, `grantMembership`, and a password set
 *   through Better Auth's reset flow. Four sales agents (the desk's sessions) and one
 *   marketing user (who issues the intake key through the real route). None of these roles
 *   has a second-factor wall (§6).
 * * **Throwaway values only** (invariant 10): `@example.invalid` addresses, a random
 *   password that exists only in this process's stdout and the runner that reads it.
 *
 * Refuses a non-local server and `NODE_ENV=production`, as the desk stack does.
 */

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export const LOAD_PRODUCTS = 2_000;
export const LOAD_SKUS_PER_PRODUCT = 10;
export const LOAD_CUSTOMERS = 5_000;

/** The buyers' numbers: +8801711000001 … +8801711005000, so k6 can pick one without a list. */
export const LOAD_PHONE_PREFIX = '+8801711';

function adminUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_ADMIN_URL ?? '';
  if (url === '') throw new Error('load-stack: DATABASE_ADMIN_URL is not set (apps/server/.env).');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('load-stack: refusing to run with NODE_ENV=production.');
  }
  const host = new URL(url).hostname;
  if (!LOCAL.has(host)) throw new Error(`load-stack: refusing to run against ${host}.`);
  return url;
}

/** 2,000 products × 10 SKUs, in one statement per table (the catalog bench's method). */
async function seedCatalog(orgId: string): Promise<void> {
  const words = ['panjabi', 'kurta', 'saree', 'shirt', 'tshirt', 'jeans', 'kameez', 'hijab'];
  const fabrics = ['embroidered', 'printed', 'cotton', 'silk', 'linen'];
  const colours = ['RED', 'BLUE', 'GREEN', 'BLACK', 'WHITE'];
  const sizes = ['S', 'M'];
  const list = (values: readonly string[]) =>
    sql.join(
      values.map((value) => sql`${value}`),
      sql`, `,
    );

  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into catalog.sku_settings (org_id, org_code, last_sequence)
        values (${orgId}, 'LD', ${LOAD_PRODUCTS})
        on conflict (org_id) do update set last_sequence = ${LOAD_PRODUCTS}
      `);
      await tx.execute(sql`
        insert into catalog.products (org_id, sequence, name, slug, status)
        select ${orgId}, n,
               (array[${list(words)}])[1 + (n % ${words.length})]
                 || ' ' || (array[${list(fabrics)}])[1 + (n % ${fabrics.length})]
                 || ' ' || n::text,
               'load-' || n::text,
               'active'
        from generate_series(1, ${LOAD_PRODUCTS}) as n
      `);
      await tx.execute(sql`
        insert into catalog.skus (org_id, product_id, code, variant_key, price_poisha, position)
        select ${orgId}, p.id,
               'LD-' || lpad(p.sequence::text, 4, '0') || '-' || v.colour || '-' || v.size,
               v.colour || '/' || v.size,
               100000 + (p.sequence % 500) * 100,
               v.ord
        from catalog.products p
        cross join (
          select colour, size, row_number() over () as ord
          from unnest(array[${list(colours)}]) as colour
          cross join unnest(array[${list(sizes)}]) as size
        ) v
        where p.org_id = ${orgId} and p.slug like 'load-%'
      `);
    },
    { orgId },
  );
}

/**
 * Every SKU on the warehouse's shelf, written as `seedStockLevel` writes one: the level,
 * the cost basis and the opening movement that explains it (invariant 3's audit trail).
 */
async function seedStock(orgId: string, locationId: string): Promise<void> {
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into inventory.stock_levels (org_id, sku_id, location_id, on_hand)
        select ${orgId}, s.id, ${locationId}, 10000
        from catalog.skus s where s.org_id = ${orgId} and s.code like 'LD-%'
      `);
      await tx.execute(sql`
        insert into inventory.sku_costs (org_id, sku_id, wac_poisha, qty_basis)
        select ${orgId}, s.id, 60000, 10000
        from catalog.skus s where s.org_id = ${orgId} and s.code like 'LD-%'
      `);
      await tx.execute(sql`
        insert into inventory.stock_movements
          (org_id, sku_id, location_id, kind, qty_delta, unit_cost_poisha, ref_type,
           business_date, created_by, created_txid)
        select ${orgId}, s.id, ${locationId}, 'opening_balance', 10000, 60000, 'fixture',
               (now() at time zone 'Asia/Dhaka')::date, 'usr_load_provision',
               pg_current_xact_id()
        from catalog.skus s where s.org_id = ${orgId} and s.code like 'LD-%'
      `);
    },
    { orgId },
  );
}

/** 5,000 buyers, each with a default address, numbered so k6 can pick one. */
async function seedCustomers(
  orgId: string,
  area: { districtId: number; thanaId: number },
): Promise<void> {
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into sales.customers (org_id, phone_e164, name)
        select ${orgId}, ${LOAD_PHONE_PREFIX} || lpad(n::text, 6, '0'), 'Load Buyer ' || n::text
        from generate_series(1, ${LOAD_CUSTOMERS}) as n
      `);
      // M48: each buyer's number, as the resolver reads it.
      await tx.execute(sql`
        insert into sales.customer_phones (org_id, customer_id, phone_e164, rank, source)
        select c.org_id, c.id, c.phone_e164, 1, 'import' from sales.customers c
        where c.org_id = ${orgId}
          and not exists (select 1 from sales.customer_phones p
                          where p.org_id = c.org_id and p.customer_id = c.id)
      `);
      await tx.execute(sql`
        insert into sales.customer_addresses
          (org_id, customer_id, district_id, thana_id, address_line, is_default)
        select ${orgId}, c.id, ${area.districtId}, ${area.thanaId}, 'House 1, Road 1, Savar', true
        from sales.customers c
        where c.org_id = ${orgId} and c.phone_e164 like ${`${LOAD_PHONE_PREFIX}%`}
      `);
    },
    { orgId },
  );
  await withSystem(async (tx) => {
    for (const table of [
      'catalog.products',
      'catalog.skus',
      'inventory.stock_levels',
      'sales.customers',
      'sales.customer_addresses',
    ]) {
      await tx.execute(sql.raw(`analyze ${table}`));
    }
  });
}

async function create(): Promise<void> {
  process.env.TEST_DATABASE_URL = adminUrl();
  const database: TestDatabase = await startTestDatabase('loadk6');
  await applyIntakeMigrations();

  const orgId = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
  const run = randomBytes(4).toString('hex');
  const password = randomBytes(18).toString('base64url');

  const tokens = new Map<string, string>();
  const created = createAuth({
    baseUrl: process.env.LOAD_API_URL ?? 'http://localhost:3120',
    secret: process.env.AUTH_SECRET ?? randomBytes(32).toString('hex'),
    trustedOrigins: [process.env.LOAD_ORIGIN ?? 'http://localhost:5193'],
    sms: new RecordingSmsProvider(),
    rateLimitEnabled: false,
    onPasswordToken: ({ email, token }) => {
      tokens.set(email, token);
      return Promise.resolve();
    },
  });
  const { auth } = created;

  const people: readonly { label: string; role: MembershipRole }[] = [
    { label: 'desk1', role: 'sales' },
    { label: 'desk2', role: 'sales' },
    { label: 'desk3', role: 'sales' },
    { label: 'desk4', role: 'sales' },
    { label: 'marketing', role: 'marketing' },
  ];
  const users: { label: string; role: string; email: string; userId: string }[] = [];
  for (const { label, role } of people) {
    const email = `load.${label}.${run}@example.invalid`;
    const user = await createTestUser({ email, name: `Load ${label}` });
    await grantMembership({ userId: user.id, orgId, role });
    await auth.api.requestPasswordReset({ body: { email, redirectTo: '/accept-invite' } });
    const token = tokens.get(email);
    if (token === undefined) throw new Error(`load-stack: no reset token for ${label}.`);
    await auth.api.resetPassword({ body: { newPassword: password, token } });
    users.push({ label, role, email, userId: user.id });
  }
  await created.close();

  const area = await withSystem(async (tx) => {
    const rows = await tx.execute<{ district_id: number; thana_id: number }>(sql`
      select t.district_id, t.id as thana_id from ref.thanas t order by t.id limit 1
    `);
    const first = rows[0];
    if (first === undefined) throw new Error('load-stack: the seed has no thanas.');
    return { districtId: Number(first.district_id), thanaId: Number(first.thana_id) };
  });

  const location = await warehouseId(orgId);
  await seedCatalog(orgId);
  await seedStock(orgId, location);
  await seedCustomers(orgId, area);

  const skus = await withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string; code: string }>(sql`
        select id, code from catalog.skus
        where org_id = ${orgId} and code like 'LD-%'
        order by code
      `);
      return rows.map((row) => ({ id: row.id, code: row.code }));
    },
    { orgId },
  );

  process.stdout.write(
    `${JSON.stringify({
      databaseName: database.databaseName,
      appUrl: database.appUrl,
      ownerUrl: database.ownerUrl,
      analyticsUrl: database.analyticsUrl,
      adminUrl: database.adminUrl,
      orgId,
      password,
      users,
      locationId: location,
      area,
      phonePrefix: LOAD_PHONE_PREFIX,
      customers: LOAD_CUSTOMERS,
      skuCount: skus.length,
      // Every 10th SKU (one per product): enough to spread order lines and reservations
      // over 2,000 rows, as a real desk's orders spread over the catalogue.
      skus: skus.filter((_, index) => index % LOAD_SKUS_PER_PRODUCT === 0),
    })}\n`,
  );

  await new Promise<void>((resolve) => {
    let buffered = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      buffered += chunk;
      if (buffered.includes('stop')) resolve();
    });
    process.stdin.on('end', () => resolve());
  });
  await database.stop();
}

const [command] = process.argv.slice(2);
if (command !== undefined) {
  const work =
    command === 'create'
      ? create()
      : Promise.reject(new Error('usage: load-stack.provision.js create'));

  work.then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(
        `load-stack failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
