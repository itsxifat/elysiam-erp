import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { findCostFields } from '@elysium/contracts';
import { withOrg, withSystem } from '@elysium/db';
import { poisha } from '@elysium/domain';
import { decodeStorefrontCursor } from '@elysium/domain/storefront';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  ORG_B,
  startHttpHarness,
  type Client,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { resetFilesEnv } from '../files/files.config.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import { makeLocation, warehouseId } from '../inventory/inventory.testing.js';
import { newKeyId } from '../intake/signature.js';
import {
  insertTestSiteKey,
  signedGet,
  signedHeaders,
  TEST_MASTER_KEY,
  type TestSiteKey,
} from './storefront.testing.js';
import { deriveStorefrontSecret, fingerprint } from './signature.js';

/**
 * The brand's website, run from its ERP, over HTTP on real PostgreSQL (M33 checks 1 to 3).
 *
 * One harness, one brand set up the way a merchandiser would: a category tree, a size list,
 * products shown and hidden, stock in the warehouse and on a showroom shelf, some of it held
 * for an order. Then the website's side of it, signed with a website key: what the shop
 * lists, what a product page says each size has, where an old address leads, and what the
 * API refuses to anyone whose signature is not right.
 */

let harness: HttpHarness;
let admin: RoleClient;
let marketing: RoleClient;
let sales: RoleClient;
let warehouse: RoleClient;
let adminB: RoleClient;
let key: TestSiteKey;

interface Seeded {
  readonly menswear: string;
  readonly shirts: string;
  readonly hidden: string;
  readonly sizeIds: { readonly S: string; readonly M: string; readonly L: string };
  readonly shirt: {
    readonly id: string;
    readonly slug: string;
    readonly skus: Record<string, string>;
  };
  readonly polo: { readonly id: string; readonly slug: string };
  readonly secret: { readonly id: string; readonly slug: string };
  readonly archived: { readonly id: string; readonly slug: string };
  readonly warehouse: string;
  readonly showroom: string;
}

let seeded: Seeded;

const suffix = randomUUID().slice(0, 6);

async function json<T>(
  client: Client,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: T; raw: string }> {
  const response = await client.request(method, url, body === undefined ? {} : { body });
  return {
    status: response.statusCode,
    body: (response.body === '' ? undefined : JSON.parse(response.body)) as T,
    raw: response.body,
  };
}

async function signed<T>(pathAndQuery: string, extra: Record<string, string> = {}) {
  const response = await signedGet(harness.server, key, pathAndQuery, extra);
  return {
    status: response.statusCode,
    headers: response.headers,
    raw: response.body,
    body: (response.body === '' ? undefined : JSON.parse(response.body)) as T,
  };
}

interface Card {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly sizes: readonly string[];
  readonly inStock: boolean;
  readonly price: { readonly min: { readonly poisha: string; readonly taka: string } };
}

async function createProduct(input: {
  name: string;
  slug: string;
  categoryId: string;
  sizes: readonly string[];
  attributeId: string;
  pricePoisha: string;
  status?: 'active' | 'draft' | 'archived';
}) {
  const created = await json<{
    id: string;
    slug: string;
    skus: { id: string; attributes: { valueId: string; valueLabel: string }[] }[];
  }>(admin.client, 'POST', '/v1/catalog/products', {
    name: input.name,
    slug: input.slug,
    categoryId: input.categoryId,
    status: input.status ?? 'active',
    pricePoisha: input.pricePoisha,
    axes: [{ attributeId: input.attributeId, valueIds: input.sizes }],
  });
  expect(created.status, created.raw).toBe(201);
  return created.body;
}

async function receive(skuId: string, locationId: string, qty: number): Promise<void> {
  const inventory = harness.app.get<InventoryApi>(INVENTORY_API, { strict: false });
  await withOrg({ orgId: ORG_A, userId: admin.userId }, async (tx) => {
    await inventory.receiveOpening(
      tx,
      { orgId: ORG_A, userId: admin.userId },
      {
        openingId: randomUUID(),
        occurredAt: new Date(),
        lines: [{ skuId, locationId, qty, unitCostPoisha: poisha(42_000) }],
      },
    );
  });
}

async function hold(skuId: string, locationId: string, qty: number): Promise<void> {
  const inventory = harness.app.get<InventoryApi>(INVENTORY_API, { strict: false });
  await withOrg({ orgId: ORG_A, userId: admin.userId }, async (tx) => {
    await inventory.reserve(
      tx,
      { orgId: ORG_A, userId: admin.userId },
      { refType: 'order', refId: randomUUID(), lines: [{ skuId, locationId, qty }] },
    );
  });
}

async function setWeb(productId: string, body: Record<string, unknown>) {
  const response = await json<{ web: { webVisible: boolean } }>(
    marketing.client,
    'PUT',
    `/v1/storefront/products/${productId}`,
    body,
  );
  expect(response.status, response.raw).toBe(200);
  return response.body;
}

beforeAll(async () => {
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_LOCAL_ROOT = await mkdtemp(path.join(tmpdir(), 'erp-storefront-e2e-'));
  resetFilesEnv();
  harness = await startHttpHarness('storefront');
  admin = await harness.asRole('org_admin', ORG_A);
  marketing = await harness.asRole('marketing', ORG_A);
  sales = await harness.asRole('sales', ORG_A);
  warehouse = await harness.asRole('warehouse', ORG_A);
  adminB = await harness.asRole('org_admin', ORG_B);
  key = await insertTestSiteKey(ORG_A);

  // The size list, in the order a shopper reads it.
  const attribute = await json<{ id: string }>(admin.client, 'POST', '/v1/catalog/attributes', {
    code: `WSZ_${suffix.toUpperCase().replace(/[^A-Z0-9]/g, '0')}`,
    name: 'Web size',
    kind: 'size',
    isVariant: true,
  });
  expect(attribute.status, attribute.raw).toBe(201);
  const value = async (code: string, position: number) => {
    const created = await json<{ id: string }>(
      admin.client,
      'POST',
      `/v1/catalog/attributes/${attribute.body.id}/values`,
      { code, label: code, position },
    );
    expect(created.status, created.raw).toBe(201);
    return created.body.id;
  };
  const sizeIds = { S: await value('S', 0), M: await value('M', 1), L: await value('L', 2) };

  const category = async (name: string, slug: string, code: string, parentId?: string) => {
    const created = await json<{ id: string }>(admin.client, 'POST', '/v1/catalog/categories', {
      name,
      slug,
      code,
      ...(parentId === undefined ? {} : { parentId }),
    });
    expect(created.status, created.raw).toBe(201);
    return created.body.id;
  };
  const code = suffix
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '0')
    .slice(0, 5);
  const menswear = await category('Menswear', `menswear-${suffix}`, `MW${code}`);
  const shirts = await category('Shirts', `shirts-${suffix}`, `SH${code}`, menswear);
  const hidden = await category('Hidden', `hidden-${suffix}`, `HD${code}`);

  const shirtBody = await createProduct({
    name: `Oxford shirt ${suffix}`,
    slug: `oxford-shirt-${suffix}`,
    categoryId: shirts,
    sizes: [sizeIds.S, sizeIds.M, sizeIds.L],
    attributeId: attribute.body.id,
    pricePoisha: '250000',
  });
  const skus: Record<string, string> = {};
  for (const sku of shirtBody.skus) {
    const label = sku.attributes[0]?.valueLabel;
    if (label !== undefined) skus[label] = sku.id;
  }
  const poloBody = await createProduct({
    name: `Pique polo ${suffix}`,
    slug: `pique-polo-${suffix}`,
    categoryId: menswear,
    sizes: [sizeIds.M],
    attributeId: attribute.body.id,
    pricePoisha: '120000',
  });
  const secretBody = await createProduct({
    name: `Unreleased jacket ${suffix}`,
    slug: `unreleased-jacket-${suffix}`,
    categoryId: menswear,
    sizes: [sizeIds.M],
    attributeId: attribute.body.id,
    pricePoisha: '900000',
  });
  const archivedBody = await createProduct({
    name: `Old tee ${suffix}`,
    slug: `old-tee-${suffix}`,
    categoryId: menswear,
    sizes: [sizeIds.M],
    attributeId: attribute.body.id,
    pricePoisha: '50000',
  });

  // On the website: the shirt and the polo. The jacket stays off it; the tee is shown but
  // archived, which keeps it off the website all the same.
  await setWeb(shirtBody.id, {
    webVisible: true,
    featured: true,
    gender: 'men',
    tags: ['Cotton', 'Summer'],
  });
  await setWeb(poloBody.id, {
    webVisible: true,
    newArrival: true,
    gender: 'men',
    tags: ['cotton'],
  });
  await setWeb(archivedBody.id, { webVisible: true });
  const archive = await json(admin.client, 'PATCH', `/v1/catalog/products/${archivedBody.id}`, {
    status: 'archived',
  });
  expect(archive.status, archive.raw).toBe(200);

  const main = await warehouseId(ORG_A);
  const showroom = await makeLocation(ORG_A, {
    code: `SR-${code}`,
    name: 'Showroom shelf',
    kind: 'showroom',
  });
  // S: 5 in the warehouse; M: 4 in the warehouse with 1 held for an order, 9 on the
  // showroom shelf; L: only on the showroom shelf.
  await receive(skus.S ?? '', main, 5);
  await receive(skus.M ?? '', main, 4);
  await hold(skus.M ?? '', main, 1);
  await receive(skus.M ?? '', showroom, 9);
  await receive(skus.L ?? '', showroom, 3);

  seeded = {
    menswear,
    shirts,
    hidden,
    sizeIds,
    shirt: { id: shirtBody.id, slug: shirtBody.slug, skus },
    polo: { id: poloBody.id, slug: poloBody.slug },
    secret: { id: secretBody.id, slug: secretBody.slug },
    archived: { id: archivedBody.id, slug: archivedBody.slug },
    warehouse: main,
    showroom,
  };
}, 300_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

// --- check 3: who may read -------------------------------------------------------------------

describe('the signature (check 3)', () => {
  const path = '/storefront/v1/catalog/categories';

  async function expectRefused(headers: Record<string, string>, url = path): Promise<string> {
    const response = await harness.server.inject({ method: 'GET', url, headers });
    expect(response.statusCode, response.body).toBe(401);
    return (JSON.parse(response.body) as { code: string; detail?: string; message?: string }).code;
  }

  it('accepts a correctly signed read', async () => {
    const response = await signed(path);
    expect(response.status, response.raw).toBe(200);
  });

  it('refuses no headers, a malformed key and an unknown key, all the same way', async () => {
    const codes = [
      await expectRefused({}),
      await expectRefused({ ...signedHeaders(key, path), 'x-api-key': 'pk_nonsense' }),
      await expectRefused(signedHeaders({ keyId: newKeyId(ORG_A), secret: key.secret }, path)),
    ];
    expect(new Set(codes)).toEqual(new Set(['UNAUTHENTICATED']));
  });

  it('refuses a wrong signature and a signature for another path', async () => {
    await expectRefused(signedHeaders({ keyId: key.keyId, secret: 'sk_wrong' }, path));
    // Signed for the categories, sent to the products: the path is in what is signed.
    await expectRefused(signedHeaders(key, path), '/storefront/v1/catalog/products');
    // The query is signed too.
    await expectRefused(signedHeaders(key, `${path}?a=1`), `${path}?a=2`);
  });

  it('refuses a timestamp outside five minutes, either side', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expectRefused(signedHeaders(key, path, { timestamp: String(now - 301) }));
    await expectRefused(signedHeaders(key, path, { timestamp: String(now + 301) }));
    const inside = await harness.server.inject({
      method: 'GET',
      url: path,
      headers: signedHeaders(key, path, { timestamp: String(now - 200) }),
    });
    expect(inside.statusCode).toBe(200);
  });

  it('refuses a key once it is revoked on Website → Connection', async () => {
    const fresh = await insertTestSiteKey(ORG_A);
    expect((await signedGet(harness.server, fresh, path)).statusCode).toBe(200);
    const revoked = await json(
      marketing.client,
      'POST',
      `/v1/storefront/site-keys/${fresh.id}/revoke`,
    );
    expect(revoked.status, revoked.raw).toBe(201);
    expect((await signedGet(harness.server, fresh, path)).statusCode).toBe(401);
  });

  it('refuses a key issued under another master key, and a landing-page key', async () => {
    const other = await insertTestSiteKey(ORG_A, {
      master: 'another-master-key-of-at-least-32-chars!!',
    });
    expect((await signedGet(harness.server, other, path)).statusCode).toBe(401);

    // An intake key for the same brand, signed as the intake would derive it: not a website key.
    const keyId = newKeyId(ORG_A);
    const secret = deriveStorefrontSecret(TEST_MASTER_KEY, keyId);
    await withSystem(
      async (tx) => {
        await tx.execute(sql`
          insert into intake.site_keys (org_id, label, key_id, secret_sha256, created_by)
          values (${ORG_A}, 'Landing page', ${keyId}, ${fingerprint(secret)}, 'usr_test')
        `);
      },
      { orgId: ORG_A },
    );
    expect((await signedGet(harness.server, { keyId, secret }, path)).statusCode).toBe(401);
  });

  it('issues a key once with its secret, lists it without one, and the key reads', async () => {
    const issued = await json<{ id: string; keyId: string; secret: string }>(
      marketing.client,
      'POST',
      '/v1/storefront/site-keys',
      { label: 'Shop' },
    );
    expect(issued.status, issued.raw).toBe(201);
    expect(issued.body.secret).toMatch(/^sk_/);
    const list = await json<{ items: Record<string, unknown>[] }>(
      marketing.client,
      'GET',
      '/v1/storefront/site-keys',
    );
    expect(list.raw).not.toContain(issued.body.secret);
    expect(list.body.items.some((row) => row.keyId === issued.body.keyId)).toBe(true);
    const read = await signedGet(harness.server, issued.body, path);
    expect(read.statusCode, read.body).toBe(200);
  });

  it('reads only the brand the key belongs to', async () => {
    const keyB = await insertTestSiteKey(ORG_B);
    const response = await signedGet(
      harness.server,
      keyB,
      '/storefront/v1/catalog/products?limit=60',
    );
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { items: Card[] };
    expect(body.items.some((item) => item.slug.endsWith(suffix))).toBe(false);
  });
});

// --- check 1: what the website sees -----------------------------------------------------------

describe('what the shop shows (check 1)', () => {
  it('lists shown products only: never the hidden, the archived or the SKU-less', async () => {
    const list = await signed<{ items: Card[]; total: number }>(
      `/storefront/v1/catalog/products?category=${seeded.menswear}&limit=60`,
    );
    expect(list.status, list.raw).toBe(200);
    const slugs = list.body.items.map((item) => item.slug).sort();
    expect(slugs).toEqual([seeded.polo.slug, seeded.shirt.slug].sort());
    expect(list.body.total).toBe(2);
    const search = await signed<{ items: Card[] }>(
      `/storefront/v1/catalog/search?q=${encodeURIComponent(`jacket ${suffix}`)}`,
    );
    expect(search.body.items).toEqual([]);
  });

  it('answers 404 for a hidden product’s page and an archived one’s', async () => {
    expect((await signed(`/storefront/v1/catalog/products/${seeded.secret.slug}`)).status).toBe(
      404,
    );
    expect((await signed(`/storefront/v1/catalog/products/${seeded.archived.slug}`)).status).toBe(
      404,
    );
    expect((await signed('/storefront/v1/catalog/products/no-such-thing')).status).toBe(404);
  });

  it('gives each size its available quantity at the web locations only, with no cost', async () => {
    const page = await signed<{
      product: {
        variants: {
          skuId: string;
          size: string;
          availableQty: number;
          inStock: boolean;
          price: { poisha: string; taka: string };
        }[];
        breadcrumb: { slug: string }[];
        sizes: string[];
      };
    }>(`/storefront/v1/catalog/products/${seeded.shirt.slug}`);
    expect(page.status, page.raw).toBe(200);
    const bySize = Object.fromEntries(
      page.body.product.variants.map((variant) => [variant.size, variant.availableQty]),
    );
    // The warehouse only (the default web location): S 5, M 4 less 1 held, L none there.
    expect(bySize).toEqual({ S: 5, M: 3, L: 0 });
    expect(page.body.product.sizes).toEqual(['S', 'M', 'L']);
    expect(page.body.product.variants[0]?.price).toEqual({ poisha: '250000', taka: '2500.00' });
    expect(page.body.product.breadcrumb.map((crumb) => crumb.slug)).toEqual([
      `menswear-${suffix}`,
      `shirts-${suffix}`,
    ]);
    expect(findCostFields(page.body)).toEqual([]);
    expect(page.raw).not.toMatch(/cost|wac|42000/i);
  });

  it('counts the showroom once the brand sells the website from it too', async () => {
    const before = await json<{ webLocationIds: string[] }>(
      marketing.client,
      'GET',
      '/v1/storefront/settings',
    );
    expect(before.body.webLocationIds).toEqual([seeded.warehouse]);
    const saved = await json(marketing.client, 'PATCH', '/v1/storefront/settings', {
      webLocationIds: [seeded.warehouse, seeded.showroom],
    });
    expect(saved.status, saved.raw).toBe(200);

    const page = await signed<{ product: { variants: { size: string; availableQty: number }[] } }>(
      `/storefront/v1/catalog/products/${seeded.shirt.slug}`,
    );
    const bySize = Object.fromEntries(
      page.body.product.variants.map((v) => [v.size, v.availableQty]),
    );
    expect(bySize).toEqual({ S: 5, M: 12, L: 3 });

    const back = await json(marketing.client, 'PATCH', '/v1/storefront/settings', {
      webLocationIds: [seeded.warehouse],
    });
    expect(back.status, back.raw).toBe(200);
  });

  it('refuses another brand’s location and a location that cannot sell', async () => {
    const otherBrand = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ id: string }>(
            sql`select id from org.locations where org_id = ${ORG_B} limit 1`,
          )
        )[0]?.id,
      { orgId: ORG_B },
    );
    const refused = await json<{ code: string }>(
      marketing.client,
      'PATCH',
      '/v1/storefront/settings',
      {
        webLocationIds: [otherBrand],
      },
    );
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('STOREFRONT_INVALID');
  });

  it('filters by category subtree, gender, tags, size, price and flags', async () => {
    const slugsFor = async (query: string) =>
      (
        await signed<{ items: Card[] }>(`/storefront/v1/catalog/products?${query}&limit=60`)
      ).body.items
        .map((item) => item.slug)
        .filter((slug) => slug.endsWith(suffix))
        .sort();
    expect(await slugsFor(`category=shirts-${suffix}`)).toEqual([seeded.shirt.slug]);
    expect(await slugsFor(`category=menswear-${suffix}&gender=men`)).toHaveLength(2);
    expect(await slugsFor('tags=summer')).toEqual([seeded.shirt.slug]);
    expect(await slugsFor('tags=cotton')).toEqual([seeded.polo.slug, seeded.shirt.slug].sort());
    expect(await slugsFor('size=L')).toEqual([seeded.shirt.slug]);
    expect(await slugsFor('minPricePoisha=200000')).toEqual([seeded.shirt.slug]);
    expect(await slugsFor('maxPricePoisha=150000')).toEqual([seeded.polo.slug]);
    expect(await slugsFor('featured=true')).toEqual([seeded.shirt.slug]);
    expect(await slugsFor('newArrival=true')).toEqual([seeded.polo.slug]);
    expect(await slugsFor('onSale=true')).toEqual([]);
    expect(await slugsFor(`q=${encodeURIComponent(`oxford ${suffix}`)}`)).toEqual([
      seeded.shirt.slug,
    ]);
    expect(await slugsFor(`category=hidden-${suffix}`)).toEqual([]);
  });

  it('refuses a malformed parameter with 400 naming it', async () => {
    const response = await signed<{ code: string; message?: string; detail?: string }>(
      '/storefront/v1/catalog/products?limit=500',
    );
    expect(response.status).toBe(400);
    expect(response.raw).toContain('limit');
  });

  it('pages with a cursor through every product once, in price order', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string =
        `/storefront/v1/catalog/products?sort=price-asc&limit=1` +
        (cursor === null ? '' : `&cursor=${cursor}`);
      const page = await signed<{ items: Card[]; nextCursor: string | null; total: number }>(query);
      expect(page.status, page.raw).toBe(200);
      seen.push(...page.body.items.map((item) => item.id));
      cursor = page.body.nextCursor;
      if (cursor !== null) expect(decodeStorefrontCursor(cursor, 'price-asc')).not.toBeNull();
      pages += 1;
    } while (cursor !== null && pages < 50);
    expect(new Set(seen).size).toBe(seen.length);
    const total = (await signed<{ total: number }>('/storefront/v1/catalog/products')).body.total;
    expect(seen.length).toBe(total);
  });

  it('sets ETag and the cache rule, and answers 304 to a matching If-None-Match', async () => {
    const first = await signed('/storefront/v1/catalog/categories');
    expect(first.headers['cache-control']).toBe('private, max-age=30, stale-while-revalidate=300');
    const etag = first.headers.etag;
    expect(typeof etag).toBe('string');
    const again = await signed('/storefront/v1/catalog/categories', {
      'if-none-match': String(etag),
    });
    expect(again.status).toBe(304);
    expect(again.raw).toBe('');
  });
});

// --- check 2: old addresses -------------------------------------------------------------------

describe('old addresses (check 2)', () => {
  it('redirects an old slug to the new one, and lets go of it when another product takes it', async () => {
    const oldSlug = seeded.polo.slug;
    const newSlug = `pique-polo-classic-${suffix}`;
    const renamed = await json<{ web: { previousSlugs: string[] } }>(
      admin.client,
      'PATCH',
      `/v1/catalog/products/${seeded.polo.id}`,
      { slug: newSlug },
    );
    expect(renamed.status, renamed.raw).toBe(200);
    const view = await json<{ web: { previousSlugs: string[] } }>(
      admin.client,
      'GET',
      `/v1/catalog/products/${seeded.polo.id}`,
    );
    expect(view.body.web.previousSlugs).toEqual([oldSlug]);

    const moved = await signed<{ redirect: { slug: string } }>(
      `/storefront/v1/catalog/products/${oldSlug}`,
    );
    expect(moved.status, moved.raw).toBe(200);
    expect(moved.body).toEqual({ redirect: { slug: newSlug } });
    const current = await signed<{ product: { slug: string } }>(
      `/storefront/v1/catalog/products/${newSlug}`,
    );
    expect(current.body.product.slug).toBe(newSlug);

    // The jacket takes the polo's old address: it is now the jacket's, not a redirect.
    await setWeb(seeded.secret.id, { webVisible: true });
    const taken = await json(admin.client, 'PATCH', `/v1/catalog/products/${seeded.secret.id}`, {
      slug: oldSlug,
    });
    expect(taken.status, taken.raw).toBe(200);
    const now = await signed<{ product: { id: string } }>(
      `/storefront/v1/catalog/products/${oldSlug}`,
    );
    expect(now.body.product.id).toBe(seeded.secret.id);
    const polo = await json<{ web: { previousSlugs: string[] } }>(
      admin.client,
      'GET',
      `/v1/catalog/products/${seeded.polo.id}`,
    );
    expect(polo.body.web.previousSlugs).toEqual([]);

    // Back as they were for the other suites in this file.
    await json(admin.client, 'PATCH', `/v1/catalog/products/${seeded.secret.id}`, {
      slug: seeded.secret.slug,
    });
    await setWeb(seeded.secret.id, { webVisible: false });
  });
});

// --- the console's Website section ------------------------------------------------------------

describe('Website settings, hero, menu and size charts', () => {
  async function uploadImage(
    client: Client,
    purpose: string,
    visibility = 'public',
  ): Promise<string> {
    const bytes = await sharp({
      create: { width: 1920, height: 750, channels: 3, background: '#335577' },
    })
      .png()
      .toBuffer();
    const ticket = await json<{ fileId: string; url: string; headers: Record<string, string> }>(
      client,
      'POST',
      '/v1/files',
      { purpose, contentType: 'image/png', sizeBytes: bytes.byteLength, visibility },
    );
    expect(ticket.status, ticket.raw).toBe(201);
    const target = new URL(ticket.body.url);
    const put = await harness.server.inject({
      method: 'PUT',
      url: `${target.pathname}${target.search}`,
      headers: { ...ticket.body.headers, host: target.host },
      payload: bytes,
    });
    expect(put.statusCode, put.body).toBe(200);
    const finalize = await json(client, 'POST', `/v1/files/${ticket.body.fileId}/finalize`);
    expect(finalize.status, finalize.raw).toBe(201);
    return ticket.body.fileId;
  }

  it('saves settings by section and the website reads them, cache forgotten on write', async () => {
    const before = await signed<{ site: { name: string }; announcement: { enabled: boolean } }>(
      '/storefront/v1/site',
    );
    expect(before.status, before.raw).toBe(200);
    // The brand's own name until somebody writes another: nothing hard-coded.
    expect(before.body.site.name.length).toBeGreaterThan(0);

    const saved = await json<{ announcement: { text: string }; social: { facebook: string } }>(
      marketing.client,
      'PATCH',
      '/v1/storefront/settings',
      {
        announcement: { enabled: true, text: 'Free delivery this week', link: '/shop' },
        social: {
          facebook: 'https://facebook.example/shop',
          instagram: '',
          tiktok: '',
          youtube: '',
        },
        testimonials: [{ name: 'Rumana', location: 'Dhaka', rating: 5, text: 'Lovely fabric.' }],
        payments: { cod: true, sslcommerz: false },
      },
    );
    expect(saved.status, saved.raw).toBe(200);
    expect(saved.body.announcement.text).toBe('Free delivery this week');

    const after = await signed<{
      announcement: { enabled: boolean; text: string };
      testimonials: { name: string }[];
      payments: { cod: boolean };
      shipping: { zones: Record<string, { fee: { poisha: string } }> };
    }>('/storefront/v1/site');
    expect(after.body.announcement).toEqual({
      enabled: true,
      text: 'Free delivery this week',
      link: '/shop',
    });
    expect(after.body.testimonials.map((t) => t.name)).toEqual(['Rumana']);
    expect(Object.keys(after.body.shipping.zones).sort()).toEqual([
      'inside_dhaka',
      'outside_dhaka',
      'suburbs',
    ]);
    // The merchant id is for labels, never the website.
    expect(after.raw).not.toContain('merchantId');
  });

  it('refuses a shipping rule with a zone in two places, and a checkout with no way to pay', async () => {
    const settings = await json<{
      shipping: { zones: Record<string, { feePoisha: string; deliveryZoneIds: string[] }> };
    }>(marketing.client, 'GET', '/v1/storefront/settings');
    const inside = settings.body.shipping.zones.inside_dhaka;
    expect(inside?.deliveryZoneIds.length).toBe(1);
    const twice = await json<{ code: string }>(
      marketing.client,
      'PATCH',
      '/v1/storefront/settings',
      {
        shipping: {
          freeShippingEnabled: true,
          freeShippingThresholdPoisha: '150000',
          zones: {
            inside_dhaka: inside,
            suburbs: { feePoisha: '10000', deliveryZoneIds: inside?.deliveryZoneIds ?? [] },
            outside_dhaka: { feePoisha: '13000', deliveryZoneIds: [] },
          },
        },
      },
    );
    expect(twice.status).toBe(400);
    expect(twice.body.code).toBe('STOREFRONT_INVALID');
    const noPay = await json(marketing.client, 'PATCH', '/v1/storefront/settings', {
      payments: { cod: false, sslcommerz: false },
    });
    expect(noPay.status).toBe(400);
  });

  it('lets sales read the settings and nothing more; the warehouse not at all', async () => {
    expect((await json(sales.client, 'GET', '/v1/storefront/settings')).status).toBe(200);
    expect(
      (
        await json(sales.client, 'PATCH', '/v1/storefront/settings', {
          payments: { cod: true, sslcommerz: true },
        })
      ).status,
    ).toBe(403);
    expect((await json(warehouse.client, 'GET', '/v1/storefront/settings')).status).toBe(403);
  });

  it('keeps hero slides in order, with their images on the public media path', async () => {
    const desktop = await uploadImage(marketing.client, 'storefront-image');
    const mobile = await uploadImage(marketing.client, 'storefront-image');
    const first = await json<{ id: string }>(
      marketing.client,
      'POST',
      '/v1/storefront/hero-slides',
      {
        desktopFileId: desktop,
        mobileFileId: mobile,
        link: '/shop?category=menswear',
        altText: 'Autumn',
        isActive: true,
      },
    );
    expect(first.status, first.raw).toBe(201);
    const second = await json<{ id: string }>(
      marketing.client,
      'POST',
      '/v1/storefront/hero-slides',
      {
        desktopFileId: desktop,
        mobileFileId: null,
        link: '/',
        altText: 'Second',
        isActive: true,
      },
    );
    expect(second.status, second.raw).toBe(201);
    const order = await json<{ items: { id: string }[] }>(
      marketing.client,
      'PUT',
      '/v1/storefront/hero-slides/order',
      {
        ids: [second.body.id, first.body.id],
      },
    );
    expect(order.status, order.raw).toBe(200);
    expect(order.body.items.map((item) => item.id)).toEqual([second.body.id, first.body.id]);

    const site = await signed<{
      hero: {
        id: string;
        desktop: { urls: { card: string; full: string }; width: number };
        mobile: unknown;
      }[];
    }>('/storefront/v1/site');
    expect(site.body.hero.map((slide) => slide.id)).toEqual([second.body.id, first.body.id]);
    const url = new URL(site.body.hero[0]?.desktop.urls.card ?? '');
    expect(url.pathname).toBe(`/media/${ORG_A}/${desktop}/card`);

    const image = await harness.server.inject({ method: 'GET', url: url.pathname });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/webp');
    expect(image.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const etag = String(image.headers.etag);
    const cached = await harness.server.inject({
      method: 'GET',
      url: url.pathname,
      headers: { 'if-none-match': etag },
    });
    expect(cached.statusCode).toBe(304);
  });

  it('refuses a slide image that is not a public website image', async () => {
    const privateFile = await uploadImage(marketing.client, 'campaign-asset', 'private');
    const refused = await json<{ code: string }>(
      marketing.client,
      'POST',
      '/v1/storefront/hero-slides',
      {
        desktopFileId: privateFile,
        mobileFileId: null,
        link: '/',
        altText: null,
        isActive: true,
      },
    );
    expect(refused.status).toBe(404);
    expect(refused.body.code).toBe('STOREFRONT_NOT_FOUND');
  });

  it('serves the media path only for public website images of that brand', async () => {
    const productImage = await uploadImage(admin.client, 'product-image');
    expect(
      (await harness.server.inject({ method: 'GET', url: `/media/${ORG_A}/${productImage}/thumb` }))
        .statusCode,
    ).toBe(200);
    // The original is never served, nor an unknown size, nor through another brand's path.
    for (const url of [
      `/media/${ORG_A}/${productImage}/original`,
      `/media/${ORG_B}/${productImage}/card`,
      `/media/${ORG_A}/${randomUUID()}/card`,
      `/media/not-a-uuid/${productImage}/card`,
    ]) {
      expect((await harness.server.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
    // A private image of a website purpose is not served either.
    const privateProduct = await uploadImage(admin.client, 'product-image', 'private');
    expect(
      (
        await harness.server.inject({
          method: 'GET',
          url: `/media/${ORG_A}/${privateProduct}/card`,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('builds the menu two levels deep, refusing a third, hiding hidden categories', async () => {
    const dropdown = await json<{ id: string }>(
      marketing.client,
      'POST',
      '/v1/storefront/nav-items',
      {
        parentId: null,
        kind: 'dropdown',
        label: 'Help',
        href: null,
        categoryId: null,
        highlighted: false,
        isActive: true,
      },
    );
    expect(dropdown.status, dropdown.raw).toBe(201);
    const child = await json(marketing.client, 'POST', '/v1/storefront/nav-items', {
      parentId: dropdown.body.id,
      kind: 'link',
      label: 'Size guide',
      href: '/size-guide',
      categoryId: null,
      highlighted: false,
      isActive: true,
    });
    expect(child.status, child.raw).toBe(201);
    const deep = await json<{ code: string }>(
      marketing.client,
      'POST',
      '/v1/storefront/nav-items',
      {
        parentId: dropdown.body.id,
        kind: 'dropdown',
        label: 'Deeper',
        href: null,
        categoryId: null,
        highlighted: false,
        isActive: true,
      },
    );
    expect(deep.status).toBe(400);
    expect(deep.body.code).toBe('STOREFRONT_INVALID');

    const menswear = await json(marketing.client, 'POST', '/v1/storefront/nav-items', {
      parentId: null,
      kind: 'category',
      label: null,
      href: null,
      categoryId: seeded.menswear,
      highlighted: true,
      isActive: true,
    });
    expect(menswear.status, menswear.raw).toBe(201);
    const hidden = await json(marketing.client, 'POST', '/v1/storefront/nav-items', {
      parentId: null,
      kind: 'category',
      label: 'Hidden',
      href: null,
      categoryId: seeded.hidden,
      highlighted: false,
      isActive: true,
    });
    expect(hidden.status, hidden.raw).toBe(201);
    const off = await json(marketing.client, 'PUT', `/v1/storefront/categories/${seeded.hidden}`, {
      webVisible: false,
    });
    expect(off.status, off.raw).toBe(200);

    const site = await signed<{
      menu: {
        label: string;
        kind: string;
        children: { label: string }[];
        subcategories: { slug: string }[];
      }[];
    }>('/storefront/v1/site');
    const labels = site.body.menu.map((entry) => entry.label);
    expect(labels).toContain('Help');
    expect(labels).toContain('Menswear');
    expect(labels).not.toContain('Hidden');
    const help = site.body.menu.find((entry) => entry.label === 'Help');
    expect(help?.children.map((item) => item.label)).toEqual(['Size guide']);
    const men = site.body.menu.find((entry) => entry.label === 'Menswear');
    expect(men?.subcategories.map((sub) => sub.slug)).toEqual([`shirts-${suffix}`]);
  });

  it('keeps a size chart a product uses, and serves it to the product page', async () => {
    const chart = await json<{ id: string }>(
      marketing.client,
      'POST',
      '/v1/storefront/size-charts',
      {
        name: `Shirts ${suffix}`,
        columns: ['Size', 'Chest (cm)', 'Length (cm)'],
        rows: [
          ['S', '96', '70'],
          ['M', '102', '72'],
        ],
      },
    );
    expect(chart.status, chart.raw).toBe(201);
    const ragged = await json(marketing.client, 'POST', '/v1/storefront/size-charts', {
      name: `Ragged ${suffix}`,
      columns: ['Size', 'Chest'],
      rows: [['S']],
    });
    expect(ragged.status).toBe(400);

    await setWeb(seeded.shirt.id, {
      sizeChartId: chart.body.id,
      material: 'Cotton',
      careInstructions: 'Cold wash',
    });
    const page = await signed<{
      product: { sizeChart: { columns: string[]; rows: string[][] }; material: string };
    }>(`/storefront/v1/catalog/products/${seeded.shirt.slug}`);
    expect(page.body.product.sizeChart.rows).toEqual([
      ['S', '96', '70'],
      ['M', '102', '72'],
    ]);
    expect(page.body.product.material).toBe('Cotton');
    const direct = await signed<{ sizeChart: { name: string } }>(
      `/storefront/v1/size-charts/${chart.body.id}`,
    );
    expect(direct.body.sizeChart.name).toBe(`Shirts ${suffix}`);

    const inUse = await json<{ code: string }>(
      marketing.client,
      'DELETE',
      `/v1/storefront/size-charts/${chart.body.id}`,
    );
    expect(inUse.status).toBe(409);
    expect(inUse.body.code).toBe('STOREFRONT_IN_USE');
  });

  it('keeps one brand’s website rows from another (RLS)', async () => {
    const mine = await json<{ items: { id: string }[] }>(
      marketing.client,
      'GET',
      '/v1/storefront/hero-slides',
    );
    const theirs = await json<{ items: { id: string }[] }>(
      adminB.client,
      'GET',
      '/v1/storefront/hero-slides',
    );
    const mineIds = new Set(mine.body.items.map((item) => item.id));
    expect(theirs.body.items.some((item) => mineIds.has(item.id))).toBe(false);
    const someId = mine.body.items[0]?.id ?? randomUUID();
    const reach = await json(adminB.client, 'DELETE', `/v1/storefront/hero-slides/${someId}`);
    expect(reach.status).toBe(404);
    const count = await withOrg({ orgId: ORG_B }, async (tx) => {
      const rows = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from storefront.hero_slides where id = ${someId}`,
      );
      return rows[0]?.n ?? -1;
    });
    expect(count).toBe(0);
  });
});

// --- from the ledger audit ----------------------------------------------------------------------

describe('audit, isolation and load (the M33 ledger audit)', () => {
  async function auditRows(action: string, entityId: string) {
    return withSystem(
      async (tx) =>
        tx.execute<{ after: Record<string, unknown> | null }>(sql`
          select after from audit.audit_log
          where org_id = ${ORG_A} and action = ${action} and entity_id = ${entityId}
          order by created_at
        `),
      { orgId: ORG_A },
    );
  }

  it('audits a key issued and revoked inside the write, never with its secret', async () => {
    const issued = await json<{ id: string; keyId: string; secret: string }>(
      marketing.client,
      'POST',
      '/v1/storefront/site-keys',
      { label: 'Audited website' },
    );
    expect(issued.status, issued.raw).toBe(201);
    const issuedRows = await auditRows('storefront.site_key_issued', issued.body.id);
    expect(issuedRows).toHaveLength(1);
    expect(JSON.stringify(issuedRows[0]?.after)).toContain(issued.body.keyId);
    expect(JSON.stringify(issuedRows)).not.toContain(issued.body.secret);

    const revoked = await json(
      marketing.client,
      'POST',
      `/v1/storefront/site-keys/${issued.body.id}/revoke`,
    );
    expect(revoked.status, revoked.raw).toBe(201);
    expect(await auditRows('storefront.site_key_revoked', issued.body.id)).toHaveLength(1);
  });

  it('audits a settings save with the delivery fees readable, not redacted', async () => {
    const settings = await json<{
      shipping: { zones: Record<string, { feePoisha: string; deliveryZoneIds: string[] }> };
    }>(marketing.client, 'GET', '/v1/storefront/settings');
    const zones = settings.body.shipping.zones;
    const saved = await json(marketing.client, 'PATCH', '/v1/storefront/settings', {
      shipping: {
        freeShippingEnabled: true,
        freeShippingThresholdPoisha: '200000',
        zones: {
          inside_dhaka: {
            feePoisha: '7000',
            deliveryZoneIds: zones.inside_dhaka?.deliveryZoneIds ?? [],
          },
          suburbs: { feePoisha: '11000', deliveryZoneIds: zones.suburbs?.deliveryZoneIds ?? [] },
          outside_dhaka: {
            feePoisha: '14000',
            deliveryZoneIds: zones.outside_dhaka?.deliveryZoneIds ?? [],
          },
        },
      },
    });
    expect(saved.status, saved.raw).toBe(200);
    const rows = await auditRows('storefront.settings_updated', ORG_A);
    const last = rows.at(-1)?.after as {
      feesPoisha?: Record<string, string>;
      sections?: string[];
    };
    expect(last.sections).toEqual(['shipping']);
    expect(last.feesPoisha).toEqual({
      inside_dhaka: '7000',
      suburbs: '11000',
      outside_dhaka: '14000',
    });
  });

  it('gives another brand’s key nothing of this brand’s: no size chart, no product', async () => {
    const keyB = await insertTestSiteKey(ORG_B);
    const chart = await json<{ id: string }>(
      marketing.client,
      'POST',
      '/v1/storefront/size-charts',
      {
        name: `Isolation ${suffix}`,
        columns: ['Size'],
        rows: [['M']],
      },
    );
    expect(chart.status, chart.raw).toBe(201);
    const chartRead = await signedGet(
      harness.server,
      keyB,
      `/storefront/v1/size-charts/${chart.body.id}`,
    );
    expect(chartRead.statusCode).toBe(404);
    const productRead = await signedGet(
      harness.server,
      keyB,
      `/storefront/v1/catalog/products/${seeded.shirt.slug}`,
    );
    expect(productRead.statusCode).toBe(404);
    // A malformed id is a 404 too, never a failed cast.
    expect((await signed(`/storefront/v1/size-charts/${'-'.repeat(36)}`)).status).toBe(404);
  });

  it('lets another brand take an old address without touching this brand’s redirect', async () => {
    const first = `linen-kurta-${suffix}`;
    const second = `linen-kurta-classic-${suffix}`;
    const kurta = await json<{ id: string }>(admin.client, 'POST', '/v1/catalog/products', {
      name: `Linen kurta ${suffix}`,
      slug: first,
      status: 'active',
      pricePoisha: '180000',
    });
    expect(kurta.status, kurta.raw).toBe(201);
    await setWeb(kurta.body.id, { webVisible: true });
    const renamed = await json(admin.client, 'PATCH', `/v1/catalog/products/${kurta.body.id}`, {
      slug: second,
    });
    expect(renamed.status, renamed.raw).toBe(200);

    const theirs = await json(adminB.client, 'POST', '/v1/catalog/products', {
      name: `Their kurta ${suffix}`,
      slug: first,
      status: 'active',
      pricePoisha: '90000',
    });
    expect(theirs.status, theirs.raw).toBe(201);

    const mine = await json<{ web: { previousSlugs: string[] } }>(
      admin.client,
      'GET',
      `/v1/catalog/products/${kurta.body.id}`,
    );
    expect(mine.body.web.previousSlugs).toEqual([first]);
    const moved = await signed<{ redirect: { slug: string } }>(
      `/storefront/v1/catalog/products/${first}`,
    );
    expect(moved.body).toEqual({ redirect: { slug: second } });
  });

  it('does not name a hidden category on a card, nor find products by its name', async () => {
    const code = `HS${suffix
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '0')
      .slice(0, 5)}`;
    const shelf = await json<{ id: string }>(admin.client, 'POST', '/v1/catalog/categories', {
      name: `Quiet shelf ${suffix}`,
      slug: `quiet-shelf-${suffix}`,
      code,
    });
    expect(shelf.status, shelf.raw).toBe(201);
    const wrap = await json<{ id: string; slug: string }>(
      admin.client,
      'POST',
      '/v1/catalog/products',
      {
        name: `Silk wrap ${suffix}`,
        slug: `silk-wrap-${suffix}`,
        categoryId: shelf.body.id,
        status: 'active',
        pricePoisha: '300000',
      },
    );
    expect(wrap.status, wrap.raw).toBe(201);
    await setWeb(wrap.body.id, { webVisible: true });
    const hidden = await json(
      marketing.client,
      'PUT',
      `/v1/storefront/categories/${shelf.body.id}`,
      {
        webVisible: false,
      },
    );
    expect(hidden.status, hidden.raw).toBe(200);

    const page = await signed<{ product: { category: unknown; breadcrumb: unknown[] } }>(
      `/storefront/v1/catalog/products/${wrap.body.slug}`,
    );
    expect(page.status, page.raw).toBe(200);
    expect(page.body.product.category).toBeNull();
    expect(page.body.product.breadcrumb).toEqual([]);
    const search = await signed<{ items: { id: string }[] }>(
      `/storefront/v1/catalog/search?q=${encodeURIComponent(`quiet-shelf-${suffix}`)}`,
    );
    expect(search.body.items.some((item) => item.id === wrap.body.id)).toBe(false);
  });

  it('refuses a malformed cursor date and a NUL with 400, not a database error', async () => {
    const impossible = Buffer.from(
      JSON.stringify(['newest', '2026-13-45T99:99:99Z', '00000000-0000-4000-8000-000000000001']),
    ).toString('base64url');
    expect((await signed(`/storefront/v1/catalog/products?cursor=${impossible}`)).status).toBe(400);
    expect((await signed('/storefront/v1/catalog/products?size=M%00')).status).toBe(400);
    // A repeated parameter is an array to the server; the last one wins, never a 500.
    expect((await signed('/storefront/v1/catalog/search?q=shirt&q=oxford')).status).toBe(200);
    expect((await signed('/storefront/v1/geo/thanas?districtId=1&districtId=2')).status).toBe(200);
  });

  it('lets only the website’s managers upload website images', async () => {
    const ticket = (client: Client) =>
      json(client, 'POST', '/v1/files', {
        purpose: 'storefront-image',
        contentType: 'image/png',
        sizeBytes: 1024,
        visibility: 'public',
      });
    expect((await ticket(warehouse.client)).status).toBe(403);
    expect((await ticket(sales.client)).status).toBe(403);
    expect((await ticket(marketing.client)).status).toBe(201);
  });

  it('answers many shoppers at once: never two connections inside one request', async () => {
    const paths = [
      '/storefront/v1/catalog/products?limit=60',
      `/storefront/v1/catalog/products/${seeded.shirt.slug}`,
      '/storefront/v1/site',
      '/storefront/v1/catalog/categories',
    ];
    const started = Date.now();
    const answers = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        signedGet(harness.server, key, paths[index % paths.length] ?? '/storefront/v1/site'),
      ),
    );
    expect(answers.map((answer) => answer.statusCode)).toEqual(answers.map(() => 200));
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);
});
