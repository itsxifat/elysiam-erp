import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

import type { ActiveContext } from '../../platform/http/context.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { seedCustomer, seedOrder } from '../orders/orders.testing.js';
import { insertPublicImageRow, insertTestSiteKey, type TestSiteKey } from './storefront.testing.js';
import { tokenHash } from './tokens.js';
import {
  prepareWebMarketingFixtures,
  WEB_MARKETING_PUBLIC_FIXTURES,
  WEB_MARKETING_PUBLIC_WRITE_FIXTURES,
  WEB_MARKETING_ROUTE_FIXTURES,
} from './web-marketing.route-fixtures.js';

/**
 * How the route-matrix suite and the cost sweep call M33's routes (D-070).
 *
 * Mutations are given real rows and fresh values per call, so every admitted role's call
 * succeeds and leaves an audit row: a slide to edit and a fresh one to delete, a menu item,
 * a size chart, a key to revoke, a product and a category to set website fields on. Rows
 * are written directly or through `CatalogService` by a seeding actor, never by a role under
 * test, so no role's audit count moves for a reason the suite did not cause.
 *
 * `STOREFRONT_PUBLIC_FIXTURES` is the signed read API, which neither suite can reach as a
 * role: the cost sweep drives it with a website key of its own (invariant 5 across the
 * storefront too).
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';

interface Fixtures {
  readonly imageId: string;
  readonly slideId: string;
  readonly navItemId: string;
  readonly chartId: string;
  readonly productId: string;
  readonly productSlug: string;
  readonly categoryId: string;
  /** M34: a website account, one of its orders, a guest token for it and a live flash sale. */
  readonly accountId: string;
  readonly accountEmail: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly viewToken: string;
  readonly flashSlug: string;
}

/** The fixture account's password: its hash is bcrypt of this, made once (cost 4). */
export const FIXTURE_ACCOUNT_PASSWORD = 'route-matrix-password';
const FIXTURE_ACCOUNT_HASH = '$2b$04$SxV0oWDX3cssBpphEGZxxeNnrTRMolPVGao2PD76lhXPMkIiklzC.';

let prepared: Fixtures | undefined;

const seeder = {
  userId: 'usr_storefront_fixture',
  orgId: ORG_A,
  roles: ['org_admin'],
  branchIds: [],
  branchIdsByRole: { org_admin: [] },
  isSuperAdmin: false,
  requestId: randomUUID(),
} as unknown as ActiveContext;

async function insertSlide(imageId: string): Promise<string> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into storefront.hero_slides (org_id, desktop_file_id, link, position)
        values (${ORG_A}, ${imageId}, '/', 900) returning id
      `);
      return rows[0]?.id ?? '';
    },
    { orgId: ORG_A },
  );
}

async function insertNavItem(): Promise<string> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into storefront.nav_items (org_id, kind, label, href, position)
        values (${ORG_A}, 'link', 'Route matrix', '/route-matrix', 900) returning id
      `);
      return rows[0]?.id ?? '';
    },
    { orgId: ORG_A },
  );
}

async function insertChart(): Promise<string> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into storefront.size_charts (org_id, name, columns, rows)
        values (${ORG_A}, ${`Route matrix ${randomUUID().slice(0, 8)}`}, array['Size','Chest'],
                '[["M","40"]]'::jsonb)
        returning id
      `);
      return rows[0]?.id ?? '';
    },
    { orgId: ORG_A },
  );
}

/** Called once from each suite's `beforeAll`, after the harness boots. Idempotent. */
export async function prepareStorefrontFixtures(): Promise<void> {
  if (prepared !== undefined) return;
  const catalog = new CatalogService();
  const suffix = randomUUID().slice(0, 6);
  // Past the highest product sequence already used, not merely past the counter: other
  // suites' fixtures write products with `max(sequence) + 1` and leave the counter behind
  // (the inventory fixtures' note), and the route-matrix suite runs them all first.
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into catalog.sku_settings (org_id, org_code, last_sequence)
        select o.id,
               coalesce(upper(substring(regexp_replace(o.slug, '[^A-Za-z0-9]', '', 'g') from 1 for 3)), 'ORG'),
               coalesce((select max(p.sequence) from catalog.products p where p.org_id = o.id), 0)
        from org.organizations o where o.id = ${ORG_A}
        on conflict (org_id) do update
          set last_sequence = greatest(catalog.sku_settings.last_sequence, excluded.last_sequence)
      `);
    },
    { orgId: ORG_A },
  );
  const category = await catalog.createCategory(seeder, {
    name: 'Website fixture',
    slug: `website-fixture-${suffix}`,
    code: `WF${suffix
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '0')
      .slice(0, 6)}`,
  });
  const product = await catalog.createProduct(seeder, {
    name: 'Website fixture tee',
    slug: `website-fixture-tee-${suffix}`,
    categoryId: category.id,
    status: 'active',
    pricePoisha: '150000',
    axes: [],
    generateSkus: true,
  });
  // On the website, so the signed reads below have a product to describe.
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        update catalog.products set web_visible = true, featured = true, tags = '{fixture}'
        where org_id = ${ORG_A} and id = ${product.id}
      `);
    },
    { orgId: ORG_A },
  );
  const imageId = await insertPublicImageRow(ORG_A);
  const web = await prepareWebsiteRows(product.id, suffix);
  prepared = {
    imageId,
    slideId: await insertSlide(imageId),
    navItemId: await insertNavItem(),
    chartId: await insertChart(),
    productId: product.id,
    productSlug: product.slug,
    categoryId: category.id,
    ...web,
  };
  // M35b: a campaign link for the reads and the website's code.
  await prepareWebMarketingFixtures();
}

/**
 * M34's rows: a verified account with a known password, a website order of it with a guest
 * view token, and a live flash sale on the fixture product, so every signed read answers 200.
 */
async function prepareWebsiteRows(productId: string, suffix: string) {
  const sku = await withSystem(
    async (tx) =>
      (
        await tx.execute<{ id: string; code: string }>(sql`
          select id, code from catalog.skus where org_id = ${ORG_A} and product_id = ${productId}
          order by code limit 1
        `)
      )[0],
    { orgId: ORG_A },
  );
  if (sku === undefined) throw new Error('the fixture product has no SKU');
  const phone = `+8801712${String(Date.now() % 1_000_000).padStart(6, '0')}`;
  const customerId = await seedCustomer(ORG_A, { phoneE164: phone, name: 'Website fixture' });
  const order = await seedOrder(ORG_A, {
    status: 'pending',
    customerId,
    lines: [
      {
        skuId: sku.id,
        skuCode: sku.code,
        productName: 'Website fixture tee',
        qty: 1,
        unitPricePoisha: 150_000n,
      },
    ],
  });
  const accountEmail = `fixture-${suffix}@example.com`;
  const viewToken = `fixturetoken${suffix}`.padEnd(43, 'x').slice(0, 43);
  const flashSlug = `fixture-flash-${suffix}`;
  const accountId = await withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into storefront.customer_accounts
          (org_id, email, email_verified_at, password_hash, name, phone_e164, customer_id)
        values (${ORG_A}, ${accountEmail}, now(), ${FIXTURE_ACCOUNT_HASH}, 'Website fixture',
                ${phone}, ${customerId})
        returning id
      `);
      const id = rows[0]?.id ?? '';
      await tx.execute(sql`
        insert into storefront.web_orders (org_id, order_id, account_id, email, locale, payment_method, phone_e164)
        values (${ORG_A}, ${order.id}, ${id}, ${accountEmail}, 'en', 'cod', ${phone})
      `);
      await tx.execute(sql`
        insert into storefront.order_view_tokens (org_id, order_id, token_sha256, purpose)
        values (${ORG_A}, ${order.id}, ${tokenHash(viewToken)}, 'confirmation')
      `);
      const sale = await tx.execute<{ id: string }>(sql`
        insert into promo.flash_sales (org_id, title, slug, enabled, created_by)
        values (${ORG_A}, 'Fixture flash', ${flashSlug}, true, 'usr_storefront_fixture')
        returning id
      `);
      await tx.execute(sql`
        insert into promo.flash_sale_items (org_id, flash_sale_id, sku_id, sale_price_poisha, unit_limit)
        values (${ORG_A}, ${sale[0]?.id ?? ''}, ${sku.id}, 120000, 5)
      `);
      return id;
    },
    { orgId: ORG_A },
  );
  return {
    accountId,
    accountEmail,
    orderId: order.id,
    orderNo: order.orderNo,
    viewToken,
    flashSlug,
  };
}

function state(): Fixtures {
  if (prepared === undefined) {
    throw new Error('call prepareStorefrontFixtures() in the suite’s beforeAll first');
  }
  return prepared;
}

async function allIds(table: 'hero_slides' | 'nav_items'): Promise<string[]> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        table === 'hero_slides'
          ? sql`select id from storefront.hero_slides where org_id = ${ORG_A} order by position desc, id`
          : sql`select id from storefront.nav_items where org_id = ${ORG_A} order by position desc, id`,
      );
      return rows.map((row) => row.id);
    },
    { orgId: ORG_A },
  );
}

export const STOREFRONT_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/storefront/settings': () => ({ url: '/v1/storefront/settings' }),
  'PATCH /v1/storefront/settings': () => ({
    url: '/v1/storefront/settings',
    body: {
      announcement: { enabled: true, text: `Route matrix ${randomUUID().slice(0, 6)}`, link: '' },
    },
  }),

  'GET /v1/storefront/hero-slides': () => ({ url: '/v1/storefront/hero-slides' }),
  'POST /v1/storefront/hero-slides': () => ({
    url: '/v1/storefront/hero-slides',
    body: {
      desktopFileId: state().imageId,
      mobileFileId: null,
      link: '/shop',
      altText: 'Route matrix',
      isActive: false,
    },
  }),
  'PUT /v1/storefront/hero-slides/order': async () => ({
    url: '/v1/storefront/hero-slides/order',
    body: { ids: await allIds('hero_slides') },
  }),
  'PUT /v1/storefront/hero-slides/:id': () => ({
    url: `/v1/storefront/hero-slides/${state().slideId}`,
    body: {
      desktopFileId: state().imageId,
      mobileFileId: null,
      link: `/shop?rm=${randomUUID().slice(0, 6)}`,
      altText: null,
      isActive: true,
    },
  }),
  'DELETE /v1/storefront/hero-slides/:id': async () => ({
    url: `/v1/storefront/hero-slides/${await insertSlide(state().imageId)}`,
  }),

  'GET /v1/storefront/nav-items': () => ({ url: '/v1/storefront/nav-items' }),
  'POST /v1/storefront/nav-items': () => ({
    url: '/v1/storefront/nav-items',
    body: {
      parentId: null,
      kind: 'link',
      label: 'Route matrix',
      href: '/sale',
      categoryId: null,
      highlighted: false,
      isActive: false,
    },
  }),
  'PUT /v1/storefront/nav-items/layout': async () => ({
    url: '/v1/storefront/nav-items/layout',
    body: {
      items: (await allIds('nav_items')).map((id, position) => ({ id, parentId: null, position })),
    },
  }),
  'PUT /v1/storefront/nav-items/:id': () => ({
    url: `/v1/storefront/nav-items/${state().navItemId}`,
    body: {
      parentId: null,
      kind: 'link',
      label: `RM ${randomUUID().slice(0, 6)}`,
      href: '/route-matrix',
      categoryId: null,
      highlighted: true,
      isActive: true,
    },
  }),
  'DELETE /v1/storefront/nav-items/:id': async () => ({
    url: `/v1/storefront/nav-items/${await insertNavItem()}`,
  }),

  'GET /v1/storefront/size-charts': () => ({ url: '/v1/storefront/size-charts' }),
  'POST /v1/storefront/size-charts': () => ({
    url: '/v1/storefront/size-charts',
    body: {
      name: `Route matrix ${randomUUID().slice(0, 8)}`,
      columns: ['Size', 'Chest (cm)'],
      rows: [['M', '96']],
    },
  }),
  'PUT /v1/storefront/size-charts/:id': () => ({
    url: `/v1/storefront/size-charts/${state().chartId}`,
    body: {
      name: `Route matrix chart ${randomUUID().slice(0, 8)}`,
      columns: ['Size', 'Chest (cm)'],
      rows: [['L', '102']],
    },
  }),
  'DELETE /v1/storefront/size-charts/:id': async () => ({
    url: `/v1/storefront/size-charts/${await insertChart()}`,
  }),

  'GET /v1/storefront/site-keys': () => ({ url: '/v1/storefront/site-keys' }),
  'POST /v1/storefront/site-keys': () => ({
    url: '/v1/storefront/site-keys',
    body: { label: 'Route matrix website' },
  }),
  'POST /v1/storefront/site-keys/:id/revoke': async () => ({
    url: `/v1/storefront/site-keys/${(await insertTestSiteKey(ORG_A)).id}/revoke`,
  }),

  'PUT /v1/storefront/products/:id': () => ({
    url: `/v1/storefront/products/${state().productId}`,
    body: { featured: true, tags: ['fixture', randomUUID().slice(0, 6)] },
  }),
  // M39b (D-642): the product list's bulk website switches.
  'PUT /v1/storefront/products': () => ({
    url: '/v1/storefront/products',
    body: { productIds: [state().productId], webVisible: true },
  }),
  'PUT /v1/storefront/categories/:id': () => ({
    url: `/v1/storefront/categories/${state().categoryId}`,
    body: { description: `Route matrix ${randomUUID().slice(0, 6)}` },
  }),

  // M34: Website → Payments, Email and Customers, and the order page's website card.
  'GET /v1/storefront/payments': () => ({ url: '/v1/storefront/payments' }),
  'PUT /v1/storefront/payments': () => ({
    url: '/v1/storefront/payments',
    body: {
      enabled: false,
      mode: 'sandbox',
      storeId: 'routematrix',
      storePassword: `rm-${randomUUID().slice(0, 8)}`,
    },
  }),
  'GET /v1/storefront/payments/sessions': () => ({ url: '/v1/storefront/payments/sessions' }),
  'GET /v1/storefront/email': () => ({ url: '/v1/storefront/email' }),
  'PUT /v1/storefront/email': () => ({
    url: '/v1/storefront/email',
    body: {
      enabled: false,
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      username: 'routematrix',
      password: `rm-${randomUUID().slice(0, 8)}`,
      fromName: 'Route matrix',
      fromEmail: 'route-matrix@example.com',
    },
  }),
  'POST /v1/storefront/email/test': () => ({
    url: '/v1/storefront/email/test',
    body: { to: 'route-matrix@example.com' },
  }),
  'GET /v1/storefront/email/log': () => ({ url: '/v1/storefront/email/log' }),
  'GET /v1/storefront/accounts': () => ({ url: '/v1/storefront/accounts' }),
  'GET /v1/storefront/orders/:orderId': () => ({
    url: `/v1/storefront/orders/${state().orderId}`,
  }),
  // M35b: campaign links and tracking.
  ...WEB_MARKETING_ROUTE_FIXTURES,
};

/** The manifest entries, derived from the fixtures. */
export const STOREFRONT_ROUTE_KEYS: readonly string[] = Object.keys(STOREFRONT_ROUTE_FIXTURES);

// --- the signed read API --------------------------------------------------------------------

let publicKey: TestSiteKey | undefined;

/** A website key for the signed reads, issued once. */
export async function storefrontTestKey(): Promise<TestSiteKey> {
  publicKey ??= await insertTestSiteKey(ORG_A);
  return publicKey;
}

/** Every signed read route, with a path that has rows behind it. */
export const STOREFRONT_PUBLIC_FIXTURES: Readonly<Record<string, () => string>> = {
  'GET /storefront/v1/catalog/products': () => '/storefront/v1/catalog/products?limit=50',
  'GET /storefront/v1/catalog/products/:slug': () =>
    `/storefront/v1/catalog/products/${state().productSlug}`,
  'GET /storefront/v1/catalog/categories': () => '/storefront/v1/catalog/categories',
  'GET /storefront/v1/catalog/search': () => '/storefront/v1/catalog/search?q=fixture',
  'GET /storefront/v1/site': () => '/storefront/v1/site',
  'GET /storefront/v1/size-charts/:id': () => `/storefront/v1/size-charts/${state().chartId}`,
  'GET /storefront/v1/geo/districts': () => '/storefront/v1/geo/districts',
  'GET /storefront/v1/geo/thanas': () => '/storefront/v1/geo/thanas?districtId=1',
  // M34
  'GET /storefront/v1/accounts/:id': () => `/storefront/v1/accounts/${state().accountId}`,
  'GET /storefront/v1/accounts/:id/orders': () =>
    `/storefront/v1/accounts/${state().accountId}/orders`,
  'GET /storefront/v1/accounts/:id/orders/:orderNo': () =>
    `/storefront/v1/accounts/${state().accountId}/orders/${state().orderNo}`,
  'GET /storefront/v1/orders/:orderNo': () =>
    `/storefront/v1/orders/${state().orderNo}?token=${state().viewToken}`,
  'GET /storefront/v1/flash-sales': () => '/storefront/v1/flash-sales',
  'GET /storefront/v1/flash-sales/:slug': () => `/storefront/v1/flash-sales/${state().flashSlug}`,
  // M35b: campaign links and the tracking config.
  ...WEB_MARKETING_PUBLIC_FIXTURES,
};

/**
 * Every signed write route (M34), with a body: the cost sweep sends each and requires that no
 * answer — a success or a refusal — carries a cost field.
 */
export const STOREFRONT_PUBLIC_WRITE_FIXTURES: Readonly<
  Record<
    string,
    () => { readonly method: 'POST' | 'PATCH'; readonly path: string; readonly body: unknown }
  >
> = {
  'POST /storefront/v1/cart/quote': () => ({
    method: 'POST',
    path: '/storefront/v1/cart/quote',
    body: { lines: [{ skuId: skuOf(), qty: 1 }] },
  }),
  'POST /storefront/v1/checkout': () => ({
    method: 'POST',
    path: '/storefront/v1/checkout',
    body: {
      lines: [{ skuId: skuOf(), qty: 1 }],
      contact: { name: 'Sweep', phone: '01711000222' },
      address: { districtId: 1, thanaId: 1, addressLine: 'Road 1' },
      paymentMethod: 'cod',
      expected: { totalPoisha: '0' },
    },
  }),
  'POST /storefront/v1/accounts/register': () => ({
    method: 'POST',
    path: '/storefront/v1/accounts/register',
    body: {
      email: `sweep-${randomUUID().slice(0, 8)}@example.com`,
      password: 'sweep-password',
      name: 'Sweep',
    },
  }),
  'POST /storefront/v1/accounts/verify-email': () => ({
    method: 'POST',
    path: '/storefront/v1/accounts/verify-email',
    body: { email: state().accountEmail, code: '123456' },
  }),
  'POST /storefront/v1/accounts/resend-code': () => ({
    method: 'POST',
    path: '/storefront/v1/accounts/resend-code',
    body: { email: state().accountEmail },
  }),
  'POST /storefront/v1/accounts/sign-in': () => ({
    method: 'POST',
    path: '/storefront/v1/accounts/sign-in',
    body: { email: state().accountEmail, password: FIXTURE_ACCOUNT_PASSWORD },
  }),
  'POST /storefront/v1/accounts/google': () => ({
    method: 'POST',
    path: '/storefront/v1/accounts/google',
    body: {
      email: `sweep-g-${randomUUID().slice(0, 8)}@example.com`,
      emailVerified: true,
      googleSub: randomUUID(),
    },
  }),
  'POST /storefront/v1/accounts/forgot-password': () => ({
    method: 'POST',
    path: '/storefront/v1/accounts/forgot-password',
    body: { email: state().accountEmail },
  }),
  'POST /storefront/v1/accounts/reset-password': () => ({
    method: 'POST',
    path: '/storefront/v1/accounts/reset-password',
    body: { token: 'x'.repeat(43), password: 'sweep-password' },
  }),
  'PATCH /storefront/v1/accounts/:id': () => ({
    method: 'PATCH',
    path: `/storefront/v1/accounts/${state().accountId}`,
    body: { name: 'Website fixture' },
  }),
  'POST /storefront/v1/accounts/:id/change-password': () => ({
    method: 'POST',
    path: `/storefront/v1/accounts/${state().accountId}/change-password`,
    body: { currentPassword: 'not-it', newPassword: 'sweep-password' },
  }),
  'POST /storefront/v1/payments/sslcommerz/init': () => ({
    method: 'POST',
    path: '/storefront/v1/payments/sslcommerz/init',
    body: { orderNo: state().orderNo, token: state().viewToken },
  }),
  'POST /storefront/v1/payments/sslcommerz/return': () => ({
    method: 'POST',
    path: '/storefront/v1/payments/sslcommerz/return',
    body: { kind: 'cancel', tranId: 'NOSUCHTRANSACTION0000' },
  }),
  // M35b: a campaign link's view, and browser events.
  ...WEB_MARKETING_PUBLIC_WRITE_FIXTURES,
};

let fixtureSku: string | undefined;

function skuOf(): string {
  return fixtureSku ?? '00000000-0000-4000-8000-000000000000';
}

/** The fixture product's SKU, for the write fixtures. */
export async function loadFixtureSku(): Promise<void> {
  const productId = state().productId;
  fixtureSku = await withSystem(
    async (tx) =>
      (
        await tx.execute<{ id: string }>(sql`
          select id from catalog.skus where org_id = ${ORG_A} and product_id = ${productId} limit 1
        `)
      )[0]?.id,
    { orgId: ORG_A },
  );
}
