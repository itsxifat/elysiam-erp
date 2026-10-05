import { createHash, randomUUID } from 'node:crypto';

import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import {
  ORG_A,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { seedProductWithSkus, warehouseId } from '../inventory/inventory.testing.js';
import { applyOrderMigrations, seedStockLevel } from '../orders/orders.testing.js';
import { MARKETPLACE_QUEUE_DEFINITIONS } from '../marketplace/marketplace.queues.js';
import { NOTIFY_QUEUES } from '../notify/notify.queues.js';
import { signStorefront } from './signature.js';
import { STOREFRONT_QUEUE_DEFINITIONS } from './storefront.queues.js';
import { insertPublicImageRow, insertTestSiteKey, type TestSiteKey } from './storefront.testing.js';
import { FakeTrackingGateway, TRACKING_GATEWAY } from './tracking.gateway.js';
import { TrackingService } from './tracking.service.js';

/**
 * Campaign links and the website's tracking on real Postgres (M35b, D-551, D-552): links made
 * on the console and read by the website's server by code, their view counter; the tracking
 * settings with the token and the API secret sealed and never shown or sent to the website;
 * browser events hashed before they are kept and sent by the worker; the server-side Purchase
 * of a checkout under the browser's own id.
 */

let harness: HttpHarness;
let jobs: JobsRuntime | undefined;
let admin: RoleClient;
let marketing: RoleClient;
let sales: RoleClient;
let key: TestSiteKey;
let gateway: FakeTrackingGateway;
let productId = '';
let skuId = '';
let categoryId = '';
let area = { districtId: 0, thanaId: 0 };
const suffix = randomUUID().slice(0, 6);
const TOKEN = 'EAAB-test-access-token-never-real-0001';
const API_SECRET = 'ga4-secret-test-0001';

async function signed(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  idempotencyKey?: string,
) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await harness.server.inject({
    method,
    url: path,
    headers: {
      'x-api-key': key.keyId,
      'x-api-timestamp': timestamp,
      'x-api-signature': signStorefront(key.secret, {
        timestamp,
        method,
        pathAndQuery: path,
        ...(raw === undefined ? {} : { idempotencyKey: idempotencyKey ?? '', rawBody: raw }),
      }),
      ...(raw === undefined ? {} : { 'content-type': 'application/json' }),
      ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
    },
    ...(raw === undefined ? {} : { payload: raw }),
  });
  return {
    status: response.statusCode,
    body: (response.body === '' ? undefined : JSON.parse(response.body)) as Record<string, unknown>,
    raw: response.body,
  };
}

function link(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Eid campaign',
    baseType: 'category',
    categoryId,
    customPath: '',
    highlightProductIds: [productId],
    banner: {
      enabled: true,
      text: 'Eid 20% off',
      bgColor: '#B85C3A',
      textColor: '#FFFFFF',
      link: '/shop',
    },
    modal: {
      enabled: false,
      type: 'text',
      title: '',
      text: '',
      imageFileId: null,
      ctaText: '',
      ctaLink: '',
    },
    isActive: true,
    ...overrides,
  };
}

function trackingSettings(overrides: Record<string, unknown> = {}) {
  return {
    meta: {
      pixelEnabled: true,
      capiEnabled: true,
      pixelId: '123456789012345',
      datasetId: '',
      apiVersion: 'v21.0',
      accessToken: TOKEN,
      testEventCode: 'TEST123',
      defaultCountryCode: '880',
    },
    ga4: {
      clientEnabled: true,
      mpEnabled: true,
      measurementId: 'G-ABCDE12345',
      apiSecret: API_SECRET,
    },
    proxy: {
      metaScriptPath: '/e1/s.js',
      metaCollectPath: '/e1/t',
      ga4ScriptPath: '/e2/s.js',
      ga4CollectPath: '/e2',
    },
    testMode: false,
    events: [
      { name: 'Purchase', enabled: true, client: true, server: true, meta: true, ga4: true },
      { name: 'AddToCart', enabled: true, client: true, server: false, meta: true, ga4: true },
    ],
    logRetentionDays: 30,
    ...overrides,
  };
}

async function eventRows(where: ReturnType<typeof sql>) {
  return withSystem(
    async (tx) => [
      ...(await tx.execute<{
        id: string;
        event_id: string;
        event_name: string;
        source: string;
        status: string;
        payload_sealed: Buffer | null;
        user_masked: { email: string; phone: string };
        match_keys: Record<string, boolean>;
        custom_data: Record<string, unknown>;
        meta: Record<string, unknown>;
      }>(sql`
          select id, event_id, event_name, source, status, payload_sealed, user_masked, match_keys,
                 custom_data, meta
          from storefront.tracking_events where org_id = ${ORG_A} and ${where}
          order by created_at
        `)),
    ],
    { orgId: ORG_A },
  );
}

beforeAll(async () => {
  harness = await startHttpHarness('web-marketing');
  await applyOrderMigrations();
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues: [...STOREFRONT_QUEUE_DEFINITIONS, ...MARKETPLACE_QUEUE_DEFINITIONS, ...NOTIFY_QUEUES],
    logger: pino({ level: 'silent' }),
    pollingIntervalSeconds: 0.5,
  });
  const bound: unknown = harness.app.get(TRACKING_GATEWAY, { strict: false });
  if (!(bound instanceof FakeTrackingGateway))
    throw new Error('the suite expects the fake gateway');
  gateway = bound;
  admin = await harness.asRole('org_admin', ORG_A);
  marketing = await harness.asRole('marketing', ORG_A);
  sales = await harness.asRole('sales', ORG_A);
  key = await insertTestSiteKey(ORG_A);
  const seeded = await seedProductWithSkus(ORG_A, `wm${suffix}`, 1);
  productId = seeded.productId;
  skuId = seeded.skus[0]?.id ?? '';
  const ids = await withSystem(
    async (tx) => {
      await tx.execute(sql`
        update catalog.products set web_visible = true where org_id = ${ORG_A} and id = ${productId}
      `);
      return (
        await tx.execute<{ category_id: string }>(sql`
          select category_id from catalog.products where id = ${productId}
        `)
      )[0];
    },
    { orgId: ORG_A },
  );
  categoryId = ids?.category_id ?? '';
  await seedStockLevel(ORG_A, {
    skuId,
    locationId: await warehouseId(ORG_A),
    qty: 20,
    unitCostPoisha: 60_000n,
  });
  const found = await withSystem(
    async (tx) =>
      (
        await tx.execute<{ district_id: number; thana_id: number }>(sql`
          select a.district_id,
                 coalesce(a.thana_id, (select t.id from ref.thanas t
                                        where t.district_id = a.district_id order by t.id limit 1)) as thana_id
          from sales.delivery_zone_areas a
          join sales.delivery_zones z on z.org_id = a.org_id and z.id = a.zone_id
          where a.org_id = ${ORG_A} and z.is_active
          order by a.district_id limit 1
        `)
      )[0],
    { orgId: ORG_A },
  );
  area = { districtId: found?.district_id ?? 0, thanaId: found?.thana_id ?? 0 };
}, 300_000);

afterAll(async () => {
  await jobs?.stop();
  await harness.close();
});

describe('campaign links', () => {
  it('are made on the console under a five-digit code and read by the website by it', async () => {
    const created = await marketing.client.request('POST', '/v1/storefront/campaign-links', {
      body: link(),
    });
    expect(created.statusCode, created.body).toBe(201);
    const { id, code } = JSON.parse(created.body) as { id: string; code: string };
    expect(code).toMatch(/^[1-9]\d{4}$/);

    const listed = JSON.parse(
      (await sales.client.request('GET', '/v1/storefront/campaign-links')).body,
    ) as { items: { id: string; path: string; views: number }[] };
    const mine = listed.items.find((item) => item.id === id);
    expect(mine?.path).toBe(`/shop?category=cat-wm${suffix}&cu=${code}`);

    const read = await signed('GET', `/storefront/v1/custom-links/${code}`);
    expect(read.status).toBe(200);
    expect(read.body.customLink).toMatchObject({
      code,
      title: 'Eid campaign',
      basePath: `/shop?category=cat-wm${suffix}`,
      banner: { text: 'Eid 20% off', link: '/shop' },
      modal: null,
    });
    const cards = (read.body.customLink as { highlightProducts: { id: string }[] })
      .highlightProducts;
    expect(cards.map((card) => card.id)).toEqual([productId]);

    for (let i = 0; i < 3; i += 1) {
      expect((await signed('POST', `/storefront/v1/custom-links/${code}/views`, {})).status).toBe(
        200,
      );
    }
    const after = JSON.parse(
      (await marketing.client.request('GET', `/v1/storefront/campaign-links/${id}`)).body,
    ) as { link: { views: number } };
    expect(after.link.views).toBe(3);

    // Switched off, the website no longer finds it, and counts nothing.
    await marketing.client.request('PUT', `/v1/storefront/campaign-links/${id}`, {
      body: link({ isActive: false }),
    });
    expect((await signed('GET', `/storefront/v1/custom-links/${code}`)).status).toBe(404);
    expect((await signed('POST', `/storefront/v1/custom-links/${code}/views`, {})).status).toBe(
      404,
    );
  });

  it('refuse an unsafe path, a foreign image and a sales agent', async () => {
    const unsafe = await marketing.client.request('POST', '/v1/storefront/campaign-links', {
      body: link({ baseType: 'custom', customPath: '//evil.example/x' }),
    });
    expect(unsafe.statusCode).toBe(400);
    const notPublic = await marketing.client.request('POST', '/v1/storefront/campaign-links', {
      body: link({
        modal: {
          enabled: true,
          type: 'image',
          title: 'Hi',
          text: '',
          imageFileId: await insertPublicImageRow(ORG_A, 'product-image'),
          ctaText: '',
          ctaLink: '',
        },
      }),
    });
    expect(notPublic.statusCode).toBe(400);
    const bySales = await sales.client.request('POST', '/v1/storefront/campaign-links', {
      body: link(),
    });
    expect(bySales.statusCode).toBe(403);
  });

  /*
   * M35b joined to M39a's deletes at integration (D-551, D-621): the website's references
   * checker counts a link's category and its highlighted products, so neither is deleted out
   * from under a link already shared, and the usage answer names the link.
   */
  it('keep the category they open and the products they highlight from a delete, and are named', async () => {
    const tag = randomUUID().replace(/-/g, '').slice(0, 6);
    const madeCategory = await admin.client.request('POST', '/v1/catalog/categories', {
      body: { name: `Eid range ${tag}`, slug: `eid-range-${tag}`, code: `L${tag.toUpperCase()}` },
    });
    expect(madeCategory.statusCode, madeCategory.body).toBeLessThan(300);
    const category = (JSON.parse(madeCategory.body) as { id: string }).id;
    const madeProduct = await admin.client.request('POST', '/v1/catalog/products', {
      body: {
        name: `Eid kurta ${tag}`,
        slug: `eid-kurta-${tag}`,
        pricePoisha: '150000',
        status: 'active',
      },
    });
    expect(madeProduct.statusCode, madeProduct.body).toBeLessThan(300);
    const product = (JSON.parse(madeProduct.body) as { id: string }).id;

    const created = await marketing.client.request('POST', '/v1/storefront/campaign-links', {
      body: link({ title: 'Eid range', categoryId: category, highlightProductIds: [product] }),
    });
    expect(created.statusCode, created.body).toBe(201);
    const { id, code } = JSON.parse(created.body) as { id: string; code: string };
    const named = {
      reason: 'campaign_links',
      count: 1,
      movable: false,
      examples: [{ id, label: `Eid range (${code})` }],
    };

    interface Usage {
      readonly canDelete: boolean;
      readonly canEmptyAndDelete: boolean;
      readonly uses: readonly { reason: string; count: number; movable: boolean }[];
    }
    const usageOf = async (url: string) =>
      JSON.parse((await admin.client.request('GET', url)).body) as Usage;
    const refusal = async (method: 'DELETE' | 'POST', url: string, body?: unknown) => {
      const response = await admin.client.request(method, url, body === undefined ? {} : { body });
      return {
        status: response.statusCode,
        ...(JSON.parse(response.body) as { code?: string; detail?: string }),
      };
    };

    // The category: nothing but the link uses it, and the link is not moved for it.
    const categoryUsage = await usageOf(`/v1/catalog/categories/${category}/usage`);
    expect(categoryUsage).toMatchObject({ canDelete: false, canEmptyAndDelete: false });
    expect(categoryUsage.uses).toEqual([named]);
    const refusedCategory = await refusal('DELETE', `/v1/catalog/categories/${category}`);
    expect(refusedCategory).toMatchObject({ status: 409, code: 'CATALOG_IN_USE' });
    expect(refusedCategory.detail).toContain('1 campaign link');
    expect(
      await refusal('POST', `/v1/catalog/categories/${category}/empty-and-delete`, {
        targetCategoryId: categoryId,
      }),
    ).toMatchObject({ status: 409, code: 'CATALOG_IN_USE' });

    // The highlighted product.
    const productUsage = await usageOf(`/v1/catalog/products/${product}/usage`);
    expect(productUsage.canDelete).toBe(false);
    expect(productUsage.uses).toEqual([named]);
    const refusedProduct = await refusal('DELETE', `/v1/catalog/products/${product}`);
    expect(refusedProduct).toMatchObject({ status: 409, code: 'CATALOG_IN_USE' });
    expect(refusedProduct.detail).toContain('1 campaign link');

    // Switched off, the link still keeps both: switched on again, it must still open them.
    const off = await marketing.client.request('PUT', `/v1/storefront/campaign-links/${id}`, {
      body: link({
        title: 'Eid range',
        categoryId: category,
        highlightProductIds: [product],
        isActive: false,
      }),
    });
    expect(off.statusCode, off.body).toBe(200);
    expect((await refusal('DELETE', `/v1/catalog/categories/${category}`)).status).toBe(409);
    expect((await refusal('DELETE', `/v1/catalog/products/${product}`)).status).toBe(409);

    // With the link deleted, both go.
    const gone = await marketing.client.request('DELETE', `/v1/storefront/campaign-links/${id}`);
    expect(gone.statusCode, gone.body).toBeLessThan(300);
    expect((await usageOf(`/v1/catalog/categories/${category}/usage`)).canDelete).toBe(true);
    const deletedProduct = await admin.client.request('DELETE', `/v1/catalog/products/${product}`);
    expect(deletedProduct.statusCode, deletedProduct.body).toBeLessThan(300);
    const deletedCategory = await admin.client.request(
      'DELETE',
      `/v1/catalog/categories/${category}`,
    );
    expect(deletedCategory.statusCode, deletedCategory.body).toBeLessThan(300);
  });
});

describe('tracking', () => {
  it('keeps the token and the secret sealed, shows a fingerprint, and gives the website none of it', async () => {
    // Where shoppers' hashed details go is the org admin's to set (D-558, the audit's W8).
    const byMarketing = await marketing.client.request('PUT', '/v1/storefront/tracking', {
      body: trackingSettings(),
    });
    expect(byMarketing.statusCode, byMarketing.body).toBe(403);
    const saved = await admin.client.request('PUT', '/v1/storefront/tracking', {
      body: trackingSettings(),
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.body).not.toContain(TOKEN);
    expect(saved.body).not.toContain(API_SECRET);
    const view = JSON.parse(saved.body) as {
      settings: { meta: { accessTokenSet: boolean; accessTokenFingerprint: string } };
    };
    expect(view.settings.meta.accessTokenSet).toBe(true);
    expect(view.settings.meta.accessTokenFingerprint).toMatch(/^[0-9a-f]{12}$/);

    const stored = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ meta_token_sealed: Buffer }>(sql`
            select meta_token_sealed from storefront.tracking_settings where org_id = ${ORG_A}
          `)
        )[0],
      { orgId: ORG_A },
    );
    expect(Buffer.from(stored?.meta_token_sealed ?? []).toString('utf8')).not.toContain(TOKEN);

    const config = await signed('GET', '/storefront/v1/tracking/config');
    expect(config.status).toBe(200);
    expect(config.raw).not.toContain(TOKEN);
    expect(config.raw).not.toContain(API_SECRET);
    expect(config.raw).not.toContain('TEST123');
    expect(config.body).toEqual({
      tracking: {
        meta: { pixelEnabled: true, pixelId: '123456789012345' },
        ga4: { clientEnabled: true, measurementId: 'G-ABCDE12345' },
        proxy: {
          metaScriptPath: '/e1/s.js',
          metaCollectPath: '/e1/t',
          ga4ScriptPath: '/e2/s.js',
          ga4CollectPath: '/e2',
        },
        testMode: false,
        events: [
          { name: 'Purchase', enabled: true, client: true },
          { name: 'AddToCart', enabled: true, client: true },
        ],
      },
    });

    // Marketing runs the rest: the same destinations, the secrets left as they are.
    const routed = trackingSettings();
    const { accessToken: _token, ...meta } = routed.meta;
    const { apiSecret: _secret, ...ga4 } = routed.ga4;
    const byMarketingRouting = await marketing.client.request('PUT', '/v1/storefront/tracking', {
      body: { ...routed, meta, ga4, logRetentionDays: 31 },
    });
    expect(byMarketingRouting.statusCode, byMarketingRouting.body).toBe(200);
    const audited = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ n: number }>(sql`
            select count(*)::int as n from audit.audit_log
            where org_id = ${ORG_A} and action = 'storefront.tracking_updated'
          `)
        )[0]?.n,
      { orgId: ORG_A },
    );
    expect(audited).toBe(2);
  });

  it('hashes a browser event before keeping it, and the worker sends it to Meta and GA4', async () => {
    gateway.clear();
    const eventId = `vc_${suffix}`;
    const accepted = await signed('POST', '/storefront/v1/events', {
      events: [
        {
          eventName: 'ViewContent',
          eventId,
          eventSourceUrl: 'https://shop.example/shop/shirt',
          userData: { email: 'Rahim@Example.com', phone: '01712345678', fbp: 'fb.1.1.2' },
          customData: { value: 1500, currency: 'BDT', content_ids: [productId] },
          ga4: { clientId: '111.222' },
        },
        // Routed to the browser only: not sent from the server.
        { eventName: 'AddToCart', eventId: `atc_${suffix}` },
      ],
      client: { ip: '203.0.113.9', userAgent: 'Mozilla/5.0' },
    });
    expect(accepted.body).toEqual({
      ok: true,
      results: [
        { eventId, status: 'queued' },
        { eventId: `atc_${suffix}`, status: 'skipped' },
      ],
    });
    const [row] = await eventRows(sql`event_id = ${eventId}`);
    expect(row?.source).toBe('client');
    expect(row?.user_masked).toEqual({ email: 'R***@Example.com', phone: '017******78' });
    expect(row?.match_keys).toMatchObject({ email: true, phone: true, fbp: true, ip: true });
    const sealed = Buffer.from(row?.payload_sealed ?? []).toString('latin1');
    expect(sealed).not.toContain('Rahim');
    expect(sealed).not.toContain('01712345678');

    const tracking = harness.app.get(TrackingService);
    await tracking.send(ORG_A, row?.id ?? '');
    const [sent] = await eventRows(sql`event_id = ${eventId}`);
    expect(sent?.status).toBe('success');
    expect(sent?.payload_sealed).toBeNull();
    const meta = gateway.meta.at(-1);
    expect(meta?.token).toBe(TOKEN);
    expect(meta?.target).toBe('123456789012345');
    const userData = (meta?.event as { user_data: Record<string, string> }).user_data;
    expect(userData.em).toBe(createHash('sha256').update('rahim@example.com').digest('hex'));
    expect(userData.ph).toBe(createHash('sha256').update('8801712345678').digest('hex'));
    expect(userData.client_ip_address).toBe('203.0.113.9');
    expect(gateway.ga4.at(-1)?.payload).toMatchObject({ client_id: '111.222' });
    // A second run finds it sent and sends nothing.
    await tracking.send(ORG_A, row?.id ?? '');
    expect(gateway.meta).toHaveLength(1);
  });

  it('fires the checkout’s Purchase under purchase_<order no>, once', async () => {
    gateway.clear();
    const current = await admin.client.request('GET', '/v1/storefront/settings');
    const settings = JSON.parse(current.body) as { siteInfo: Record<string, unknown> };
    await admin.client.request('PATCH', '/v1/storefront/settings', {
      body: {
        siteInfo: { ...settings.siteInfo, siteUrl: 'https://shop.example' },
        payments: { cod: true, sslcommerz: false },
      },
    });
    const quoted = await signed('POST', '/storefront/v1/cart/quote', {
      lines: [{ skuId, qty: 1 }],
      address: area,
    });
    const total = (quoted.body.quote as { total: { poisha: string } }).total.poisha;
    const placed = await signed(
      'POST',
      '/storefront/v1/checkout',
      {
        lines: [{ skuId, qty: 1 }],
        contact: { name: 'Rahima Akter', phone: '01712340001', email: 'rahima@example.com' },
        address: { ...area, addressLine: 'House 7, Road 3' },
        paymentMethod: 'cod',
        expected: { totalPoisha: total },
        tracking: {
          fbp: 'fb.1.9.9',
          eventSourceUrl: 'https://shop.example/checkout',
          gaClientId: '333.444',
        },
        client: { ip: '203.0.113.10' },
      },
      randomUUID(),
    );
    expect(placed.status, placed.raw).toBe(201);
    const orderNo = (placed.body.order as { orderNo: string }).orderNo;
    const rows = await eventRows(sql`event_id = ${`purchase_${orderNo}`}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'server', event_name: 'Purchase', status: 'queued' });
    expect(rows[0]?.custom_data).toMatchObject({
      order_id: orderNo,
      currency: 'BDT',
      num_items: 1,
    });

    await harness.app.get(TrackingService).send(ORG_A, rows[0]?.id ?? '');
    const event = gateway.meta.at(-1)?.event as {
      event_id: string;
      event_source_url: string;
      user_data: Record<string, string>;
    };
    expect(event.event_id).toBe(`purchase_${orderNo}`);
    expect(event.event_source_url).toBe('https://shop.example/checkout');
    expect(event.user_data.fbp).toBe('fb.1.9.9');
    expect(event.user_data.ct).toBeDefined();
  });

  it('logs nothing personal for a brand that sends nothing, and purges past the retention', async () => {
    const tracking = harness.app.get(TrackingService);
    await withSystem(
      (tx) =>
        tx.execute(sql`
          update storefront.tracking_events set expires_at = now() - interval '1 day'
          where org_id = ${ORG_A} and status in ('success', 'skipped', 'error')
        `),
      { orgId: ORG_A },
    );
    const removed = await tracking.purgeAll();
    expect(removed).toBeGreaterThan(0);
    expect(await eventRows(sql`status = 'success'`)).toHaveLength(0);

    await marketing.client.request('PUT', '/v1/storefront/tracking', {
      body: trackingSettings({
        meta: { ...trackingSettings().meta, capiEnabled: false, accessToken: undefined },
        ga4: { ...trackingSettings().ga4, mpEnabled: false, apiSecret: undefined },
      }),
    });
    const answer = await signed('POST', '/storefront/v1/events', {
      events: [{ eventName: 'PageView', eventId: `pv_${suffix}`, userData: { email: 'x@y.z' } }],
    });
    expect(answer.body).toEqual({
      ok: true,
      results: [{ eventId: `pv_${suffix}`, status: 'skipped' }],
    });
    expect(await eventRows(sql`event_id = ${`pv_${suffix}`}`)).toHaveLength(0);
  });
});
