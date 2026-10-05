import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

import type { ActiveContext } from '../../platform/http/context.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { insertPublicImageRow, insertTestSiteKey, type TestSiteKey } from './storefront.testing.js';

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
}

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
  prepared = {
    imageId,
    slideId: await insertSlide(imageId),
    navItemId: await insertNavItem(),
    chartId: await insertChart(),
    productId: product.id,
    productSlug: product.slug,
    categoryId: category.id,
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
  'PUT /v1/storefront/categories/:id': () => ({
    url: `/v1/storefront/categories/${state().categoryId}`,
    body: { description: `Route matrix ${randomUUID().slice(0, 6)}` },
  }),
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
};
