import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import { withSystem } from '@elysium/db';
import { ncomSignatureHeader, verifyNcomSignature } from '@elysium/domain/storefront';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import {
  ORG_A,
  ORG_B,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { seedProductWithSkus, warehouseId } from '../inventory/inventory.testing.js';
import { applyOrderMigrations, seedStockLevel, stockAt } from '../orders/orders.testing.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { STOREFRONT_QUEUE_DEFINITIONS } from '../storefront/storefront.queues.js';
import { MARKETPLACE_QUEUE_DEFINITIONS } from './marketplace.queues.js';
import { NcomOrdersService } from './ncom-orders.service.js';
import { NcomTransport } from './ncom.transport.js';

/**
 * The ncom.bd connector end to end on real Postgres (M35b, D-553, D-556; M35 acceptance check
 * 4): the old site's own `ncom-check.mjs` and `ncom-order-check.mjs`, ported to `scripts/`, run
 * against the ERP on a listening port, then every rule the scripts cannot see: holds through
 * the inventory reservation, the old ids, order intake's prices and idempotency, revisions,
 * the webhook and the outbox's backoff.
 */

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '../../../../..');

const CONNECTOR_KEY = 'ncomcat_test_key';
const CONNECTOR_SECRET = 'ncomsec_connector_secret_for_tests';
const ORDER_KEY = 'ncomord_test_key';
const ORDER_SECRET = 'ncomsec_order_secret_for_tests';
const WEBHOOK_SECRET = 'ncomwh_webhook_secret_for_tests';

let harness: HttpHarness;
let jobs: JobsRuntime | undefined;
let admin: RoleClient;
let base = '';
let warehouse = '';
let productId = '';
let skuA = '';
let skuB = '';
let hiddenProduct = '';
const suffix = randomUUID().slice(0, 6);
const LEGACY_PRODUCT = '64f0c0ffee0000000000aaaa';
const LEGACY_VARIANT = '64f0c0ffee0000000000bbbb';

async function connector(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  options: { readonly key?: string; readonly secret?: string; readonly signature?: string } = {},
) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const response = await harness.server.inject({
    method,
    url: `/ncom/${ORG_A}/v1${path}`,
    headers: {
      'x-ncom-key': options.key ?? CONNECTOR_KEY,
      'x-ncom-contract': '1',
      'x-ncom-signature':
        options.signature ??
        ncomSignatureHeader(options.secret ?? CONNECTOR_SECRET, raw, Math.floor(Date.now() / 1000)),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { payload: raw }),
  });
  return {
    status: response.statusCode,
    headers: response.headers,
    body: (response.body === '' ? undefined : JSON.parse(response.body)) as Record<string, unknown>,
  };
}

async function handover(envelope: Record<string, unknown>, key: string, secret = ORDER_SECRET) {
  const raw = JSON.stringify(envelope);
  const response = await harness.server.inject({
    method: 'POST',
    url: `/ncom/${ORG_A}/orders`,
    headers: {
      'content-type': 'application/json',
      'x-ncom-key': ORDER_KEY,
      'x-ncom-contract': '1',
      'x-ncom-idempotency-key': key,
      'x-ncom-signature': ncomSignatureHeader(secret, raw, Math.floor(Date.now() / 1000)),
    },
    payload: raw,
  });
  return {
    status: response.statusCode,
    body: JSON.parse(response.body) as Record<string, unknown>,
  };
}

function order(id: string, lines: Record<string, unknown>[], money: Record<string, number>) {
  return {
    id,
    orderNumber: `NC-${id.slice(0, 8)}`,
    customer: { name: 'Rahima Akter', phone: '01712345678', email: null },
    shippingAddress: {
      name: 'Rahima Akter',
      phone: '01712345678',
      address1: 'House 5, Road 3, Dhanmondi',
      address2: null,
      city: 'Dhaka',
      province: null,
      countryCode: 'BD',
    },
    lines,
    subtotalCents: money.subtotal,
    discountTotalCents: money.discount,
    shippingTotalCents: money.shipping,
    totalCents: money.total,
    note: 'Call first',
    campaign: { pageTitle: 'Eid page', offerLabel: 'Buy 2', offerPriceCents: 250000 },
    store: { name: 'ncom store', url: 'https://store.ncom.bd' },
  };
}

function line(skuId: string, qty: number, unitCents: number, extra: Record<string, unknown> = {}) {
  return {
    productId,
    variantId: skuId,
    source: 'website',
    title: 'Shirt',
    variantTitle: null,
    sku: null,
    quantity: qty,
    unitPriceCents: unitCents,
    totalCents: unitCents * qty,
    ...extra,
  };
}

async function orderRow(orderId: string) {
  return withSystem(
    async (tx) =>
      (
        await tx.execute<{
          channel: string;
          status: string;
          cod_amount_poisha: string;
          discount_poisha: string;
          delivery_charge_poisha: string;
          stock_held_at: Date | null;
        }>(sql`
          select channel::text, status::text, cod_amount_poisha::text, discount_poisha::text,
                 delivery_charge_poisha::text, stock_held_at
          from sales.orders where org_id = ${ORG_A} and id = ${orderId}
        `)
      )[0],
    { orgId: ORG_A },
  );
}

beforeAll(async () => {
  harness = await startHttpHarness('marketplace');
  await applyOrderMigrations();
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues: [...STOREFRONT_QUEUE_DEFINITIONS, ...MARKETPLACE_QUEUE_DEFINITIONS],
    logger: pino({ level: 'silent' }),
    pollingIntervalSeconds: 0.5,
  });
  admin = await harness.asRole('org_admin', ORG_A);
  warehouse = await warehouseId(ORG_A);

  const seeded = await seedProductWithSkus(ORG_A, `ncom${suffix}`, 2);
  productId = seeded.productId;
  skuA = seeded.skus[0]?.id ?? '';
  skuB = seeded.skus[1]?.id ?? '';
  const hidden = await seedProductWithSkus(ORG_A, `ncomh${suffix}`, 1);
  hiddenProduct = hidden.productId;
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        update catalog.products set web_visible = true where org_id = ${ORG_A} and id = ${productId}
      `);
      // The old site's ids for one product and one size (M36's map), so offers ncom saved
      // against the old site keep resolving.
      await tx.execute(sql`
        insert into storefront.legacy_ids (org_id, kind, legacy_id, erp_id) values
          (${ORG_A}, 'product', ${LEGACY_PRODUCT}, ${productId}),
          (${ORG_A}, 'variant', ${LEGACY_VARIANT}, ${skuB})
      `);
    },
    { orgId: ORG_A },
  );
  await seedStockLevel(ORG_A, {
    skuId: skuA,
    locationId: warehouse,
    qty: 10,
    unitCostPoisha: 50_000n,
  });
  await seedStockLevel(ORG_A, {
    skuId: skuB,
    locationId: warehouse,
    qty: 3,
    unitCostPoisha: 50_000n,
  });

  const saved = await admin.client.request('PUT', '/v1/marketplace/ncom', {
    body: {
      enabled: true,
      acceptOrders: true,
      includeDrafts: false,
      allowSearch: true,
      allowCategories: true,
      allowReserve: true,
      defaultWeightGrams: 400,
      publicBaseUrl: 'https://shop.example.com',
      baseUrl: 'https://ncom.example.test/api/v1',
      connectorKeyId: CONNECTOR_KEY,
      orderKeyId: ORDER_KEY,
      connectorSecret: CONNECTOR_SECRET,
      orderSecret: ORDER_SECRET,
      webhookSecret: WEBHOOK_SECRET,
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);

  await harness.app.listen(0, '127.0.0.1');
  const address = harness.app.getHttpServer().address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  base = `http://127.0.0.1:${String(port)}`;
}, 180_000);

afterAll(async () => {
  await jobs?.stop();
  await harness.close();
});

describe('the old site’s conformance checkers, against the ERP (check 4)', () => {
  it('ncom-check.mjs passes every check', async () => {
    const { stdout } = await run(
      process.execPath,
      [
        path.join(ROOT, 'scripts/ncom-check.mjs'),
        '--url',
        `${base}/ncom/${ORG_A}/v1`,
        '--key',
        CONNECTOR_KEY,
        '--secret',
        CONNECTOR_SECRET,
      ],
      { timeout: 60_000 },
    );
    expect(stdout).not.toContain('FAIL');
    expect(stdout).toMatch(/All essential checks passed|Every check passed/);
    expect(stdout).toContain('POST /reserve refuses an impossible quantity');
  });

  it('ncom-order-check.mjs passes every check', async () => {
    const { stdout } = await run(
      process.execPath,
      [
        path.join(ROOT, 'scripts/ncom-order-check.mjs'),
        '--url',
        `${base}/ncom/${ORG_A}/orders`,
        '--key',
        ORDER_KEY,
        '--secret',
        ORDER_SECRET,
        '--product',
        productId,
        '--variant',
        skuA,
      ],
      { timeout: 60_000 },
    );
    expect(stdout).toContain('All checks passed');
  });
});

describe('the connector', () => {
  it('refuses every unsigned, wrongly signed, stale or foreign-key call with one answer', async () => {
    const answers = await Promise.all([
      connector('GET', '/ping', undefined, { signature: '' }),
      connector('GET', '/ping', undefined, { secret: 'wrong' }),
      connector('GET', '/ping', undefined, {
        signature: ncomSignatureHeader(CONNECTOR_SECRET, '', Math.floor(Date.now() / 1000) - 3_600),
      }),
      connector('GET', '/ping', undefined, { key: 'ncomcat_wrong' }),
    ]);
    for (const answer of answers) {
      expect(answer.status).toBe(401);
      expect(answer.body).toEqual({
        ok: false,
        error: { code: 'unauthorized', message: 'Invalid signature.' },
      });
      expect(answer.headers['cache-control']).toContain('no-store');
    }
    // Another brand has no connector: the same refusal, never another brand's catalogue.
    const other = await harness.server.inject({ method: 'GET', url: `/ncom/${ORG_B}/v1/ping` });
    expect(other.statusCode).toBe(401);
  });

  it('serves products with live stock at the selling price, old ids where the map has them', async () => {
    const page = await connector('GET', '/products?limit=50');
    expect(page.status).toBe(200);
    const products = page.body.products as {
      id: string;
      status: string;
      variants: { id: string; price: string; available: number; policy: string }[];
    }[];
    const ours = products.find((product) => product.id === LEGACY_PRODUCT);
    expect(ours?.status).toBe('active');
    expect(ours?.variants.map((variant) => variant.id).sort()).toEqual(
      [LEGACY_VARIANT, skuA].sort(),
    );
    const a = ours?.variants.find((variant) => variant.id === skuA);
    expect(a).toMatchObject({ price: '1500.00', policy: 'deny' });
    // Drafts are off for this brand: the product not on the website is not listed.
    expect(products.some((product) => product.id === hiddenProduct)).toBe(false);
    expect(JSON.stringify(page.body)).not.toMatch(/cost|wac/i);

    const byIds = await connector('GET', `/products?ids=${LEGACY_PRODUCT},${hiddenProduct}`);
    expect((byIds.body.products as { id: string }[]).map((product) => product.id)).toEqual([
      LEGACY_PRODUCT,
    ]);
    const one = await connector('GET', `/products/product-ncom${suffix}`);
    expect(one.status).toBe(200);
    expect((one.body.product as { id: string }).id).toBe(LEGACY_PRODUCT);
  });

  it('reports stock for SKU ids and old variant ids, in order, and zero for anything unknown', async () => {
    const stock = await connector('POST', '/stock', { ids: [skuA, LEGACY_VARIANT, 'nope'] });
    const rows = stock.body.stock as { id: string; available: number }[];
    expect(rows.map((row) => row.id)).toEqual([skuA, LEGACY_VARIANT, 'nope']);
    expect(rows[2]?.available).toBe(0);
    expect(rows[1]?.available).toBeGreaterThan(0);
  });

  it('holds through the inventory reservation, once per reference, and gives back exactly that', async () => {
    const before = await stockAt(ORG_A, skuB, warehouse);
    const ref = `hold-${suffix}`;
    const lines = [
      { variantId: LEGACY_VARIANT, quantity: 1 },
      { variantId: skuB, quantity: 1 },
    ];
    const held = await connector('POST', '/reserve', { orderRef: ref, lines });
    expect(held.body).toEqual({ ok: true, held: 2 });
    expect((await stockAt(ORG_A, skuB, warehouse)).reserved).toBe(before.reserved + 2);

    const retry = await connector('POST', '/reserve', { orderRef: ref, lines });
    expect(retry.body).toEqual({ ok: true, idempotent: true });
    expect((await stockAt(ORG_A, skuB, warehouse)).reserved).toBe(before.reserved + 2);

    const tooMany = await connector('POST', '/reserve', {
      orderRef: `big-${suffix}`,
      lines: [{ variantId: skuB, quantity: 50 }],
    });
    expect(tooMany.body).toMatchObject({ ok: false });
    expect((tooMany.body.rejected as { reason: string }[])[0]?.reason).toMatch(/left|Sold out/);

    const released = await connector('POST', '/release', { orderRef: ref });
    expect(released.body).toEqual({ ok: true, released: 2 });
    const again = await connector('POST', '/release', { orderRef: ref });
    expect(again.body).toEqual({ ok: true, released: 0, noop: true });
    expect(await stockAt(ORG_A, skuB, warehouse)).toEqual(before);
  });

  it('lets exactly one of two holds racing for the last units through', async () => {
    const before = await stockAt(ORG_A, skuB, warehouse);
    const free = before.onHand - before.reserved;
    const results = await Promise.all(
      [1, 2].map((n) =>
        connector('POST', '/reserve', {
          orderRef: `race-${String(n)}-${suffix}`,
          lines: [{ variantId: skuB, quantity: free }],
        }),
      ),
    );
    expect(results.filter((result) => result.body.ok === true)).toHaveLength(1);
    const after = await stockAt(ORG_A, skuB, warehouse);
    expect(after.reserved).toBe(before.onHand);
    expect(after.reserved).toBeLessThanOrEqual(after.onHand);
    for (const n of [1, 2])
      await connector('POST', '/release', { orderRef: `race-${String(n)}-${suffix}` });
  });
});

describe('orders ncom hands over', () => {
  it('files an order at ncom’s prices, holds its stock, and answers a retry with the same order', async () => {
    const id = randomUUID();
    const before = await stockAt(ORG_A, skuA, warehouse);
    // Two shirts at ৳1,250 each on ncom's page, ৳60 delivery: ৳2,560 to collect.
    const envelope = {
      version: 1,
      topic: 'order.created',
      idempotencyKey: id,
      order: order(id, [line(skuA, 2, 125_000)], {
        subtotal: 250_000,
        discount: 0,
        shipping: 6_000,
        total: 256_000,
      }),
    };
    const placed = await handover(envelope, id);
    expect(placed.status).toBe(201);
    const orderId = placed.body.orderId as string;
    const row = await orderRow(orderId);
    expect(row).toMatchObject({
      channel: 'marketplace',
      status: 'pending',
      cod_amount_poisha: '256000',
      delivery_charge_poisha: '6000',
    });
    expect(row?.stock_held_at).not.toBeNull();
    expect((await stockAt(ORG_A, skuA, warehouse)).reserved).toBe(before.reserved + 2);

    const retry = await handover(envelope, id);
    expect(retry).toEqual({
      status: 200,
      body: { ok: true, deduped: true, orderId, orderNumber: placed.body.orderNumber },
    });

    // A change must build on the revision the ERP holds.
    const stale = await handover(
      { topic: 'order.updated', baseRevision: 5, revision: 6, order: { ...envelope.order } },
      `${id}:u1`,
    );
    expect(stale).toEqual({
      status: 409,
      body: { error: 'This shop holds a different version of the order', revision: 0 },
    });

    // Their bundle price changes: one shirt now, ৳1,400, ৳60 delivery.
    const changed = await handover(
      {
        topic: 'order.updated',
        baseRevision: 0,
        revision: 1,
        order: order(id, [line(skuA, 1, 140_000)], {
          subtotal: 140_000,
          discount: 0,
          shipping: 6_000,
          total: 146_000,
        }),
      },
      `${id}:u2`,
    );
    expect(changed).toEqual({ status: 200, body: { ok: true, revision: 1 } });
    expect((await orderRow(orderId))?.cod_amount_poisha).toBe('146000');
    expect((await stockAt(ORG_A, skuA, warehouse)).reserved).toBe(before.reserved + 1);

    const cancelled = await handover(
      { topic: 'order.cancelled', baseRevision: 1, revision: 2, reason: 'Customer', order: { id } },
      `${id}:c`,
    );
    expect(cancelled).toEqual({ status: 200, body: { ok: true, revision: 2 } });
    expect((await orderRow(orderId))?.status).toBe('cancelled');
    expect(await stockAt(ORG_A, skuA, warehouse)).toEqual(before);
    // ncom caused the cancel: nothing is queued to tell it back.
    const queued = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ n: number }>(sql`
            select count(*)::int as n from marketplace.ncom_outbox
            where org_id = ${ORG_A} and order_id = ${orderId}
          `)
        )[0]?.n,
      { orgId: ORG_A },
    );
    expect(queued).toBe(0);
  });

  it('records a gift ncom stores itself, and collects only the brand’s goods when ncom’s total carries others', async () => {
    const id = randomUUID();
    const placed = await handover(
      {
        topic: 'order.created',
        order: order(
          id,
          [
            line(skuA, 1, 150_000),
            {
              productId: 'ncom-p',
              variantId: 'ncom-v',
              source: 'ncom',
              title: 'Tote bag',
              quantity: 1,
              unitPriceCents: 30_000,
              totalCents: 30_000,
            },
          ],
          { subtotal: 180_000, discount: 0, shipping: 6_000, total: 186_000 },
        ),
      },
      id,
    );
    expect(placed.status).toBe(201);
    const row = await orderRow(placed.body.orderId as string);
    // ৳1,500 shirt + ৳60 delivery; the ৳300 tote is ncom's to collect for.
    expect(row?.cod_amount_poisha).toBe('156000');
    const record = await withSystem(
      async (tx) =>
        (
          await tx.execute<{
            foreign_poisha: string;
            warnings: string[];
            foreign_items: unknown[];
          }>(sql`
            select foreign_poisha::text, warnings, foreign_items from marketplace.ncom_orders
            where org_id = ${ORG_A} and ncom_order_id = ${id}
          `)
        )[0],
      { orgId: ORG_A },
    );
    expect(record?.foreign_poisha).toBe('30000');
    expect(record?.foreign_items).toHaveLength(1);
    expect(record?.warnings.join(' ')).toMatch(/does not stock/);
  });

  it('refuses an unsigned or foreign handover, and a shop not accepting orders', async () => {
    const id = randomUUID();
    const envelope = {
      topic: 'order.created',
      order: order(id, [line(skuA, 1, 150_000)], {
        subtotal: 150_000,
        discount: 0,
        shipping: 0,
        total: 150_000,
      }),
    };
    expect((await handover(envelope, id, 'wrong-secret')).status).toBe(401);
    const unsigned = await harness.server.inject({
      method: 'POST',
      url: `/ncom/${ORG_A}/orders`,
      headers: { 'content-type': 'application/json', 'x-ncom-key': ORDER_KEY },
      payload: JSON.stringify(envelope),
    });
    expect(unsigned.statusCode).toBe(401);
  });

  it('takes over a hold ncom made for the order before handing it over', async () => {
    const id = randomUUID();
    const before = await stockAt(ORG_A, skuA, warehouse);
    await connector('POST', '/reserve', {
      orderRef: id,
      lines: [{ variantId: skuA, quantity: 1 }],
    });
    expect((await stockAt(ORG_A, skuA, warehouse)).reserved).toBe(before.reserved + 1);
    const placed = await handover(
      {
        topic: 'order.created',
        order: order(id, [line(skuA, 1, 150_000)], {
          subtotal: 150_000,
          discount: 0,
          shipping: 0,
          total: 150_000,
        }),
      },
      id,
    );
    expect(placed.status).toBe(201);
    // One unit held, by the order now, not two.
    expect((await stockAt(ORG_A, skuA, warehouse)).reserved).toBe(before.reserved + 1);
    const hold = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ state: string; converted_order_id: string }>(sql`
            select state, converted_order_id from marketplace.ncom_holds
            where org_id = ${ORG_A} and order_ref = ${id}
          `)
        )[0],
      { orgId: ORG_A },
    );
    expect(hold).toEqual({ state: 'converted', converted_order_id: placed.body.orderId });
  });
});

describe('back to ncom: the outbox', () => {
  it('sends a change signed with the order key, in order, and backs off the old way', async () => {
    const id = randomUUID();
    const placed = await handover(
      {
        topic: 'order.created',
        order: order(id, [line(skuA, 1, 150_000)], {
          subtotal: 150_000,
          discount: 0,
          shipping: 0,
          total: 150_000,
        }),
      },
      id,
    );
    const orderId = placed.body.orderId as string;
    const service = harness.app.get(NcomOrdersService);
    const orders = harness.app.get<OrdersApi>(ORDERS_API);
    // Staff confirm it: the change ncom is told about.
    await withSystem(
      async (tx) => {
        await orders.transition(tx, { orgId: ORG_A, userId: admin.userId }, orderId, 'confirm');
        await service.queueChange(tx, ORG_A, orderId, 'confirmed', 'Status changed to confirmed');
      },
      { orgId: ORG_A, userId: admin.userId },
    );

    const transport = harness.app.get(NcomTransport);
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    let answer = 503;
    transport.fetchImpl = (url, init) => {
      seen.push({
        url,
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      });
      return Promise.resolve(new Response('{}', { status: answer }));
    };

    await service.send(ORG_A, orderId);
    const pending = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ status: string; attempts: number; wait: number }>(sql`
            select status, attempts, extract(epoch from next_attempt_at - now())::int as wait
            from marketplace.ncom_outbox where org_id = ${ORG_A} and order_id = ${orderId}
          `)
        )[0],
      { orgId: ORG_A },
    );
    expect(pending?.status).toBe('pending');
    expect(pending?.attempts).toBe(1);
    expect(pending?.wait).toBeGreaterThan(10);
    expect(pending?.wait).toBeLessThanOrEqual(15);

    const sent = seen[0];
    expect(sent?.url).toBe('https://ncom.example.test/api/orders/callback');
    expect(sent?.headers['x-ncom-key']).toBe(ORDER_KEY);
    expect(
      verifyNcomSignature(
        ORDER_SECRET,
        sent?.body ?? '',
        sent?.headers['x-ncom-signature'],
        Date.now(),
      ).ok,
    ).toBe(true);
    const message = JSON.parse(sent?.body ?? '{}') as {
      topic: string;
      baseRevision: number;
      revision: number;
      idempotencyKey: string;
      order: { id: string; status: string; fulfilmentStatus: string; totalCents: number };
    };
    expect(message).toMatchObject({
      topic: 'order.updated',
      baseRevision: 0,
      revision: 1,
      idempotencyKey: `erp:${orderId}:1`,
      order: { id, status: 'processing', fulfilmentStatus: 'confirmed', totalCents: 150_000 },
    });

    // Not due yet: nothing is sent.
    await service.send(ORG_A, orderId);
    expect(seen).toHaveLength(1);
    // Due, and ncom takes it.
    await withSystem(
      (tx) =>
        tx.execute(sql`
          update marketplace.ncom_outbox set next_attempt_at = now() - interval '1 second'
          where org_id = ${ORG_A} and order_id = ${orderId}
        `),
      { orgId: ORG_A },
    );
    answer = 200;
    await service.send(ORG_A, orderId);
    const delivered = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ status: string; payload_sealed: Buffer | null }>(sql`
            select status, payload_sealed from marketplace.ncom_outbox
            where org_id = ${ORG_A} and order_id = ${orderId}
          `)
        )[0],
      { orgId: ORG_A },
    );
    expect(delivered).toEqual({ status: 'delivered', payload_sealed: null });

    // A 409 stops the queue for a person.
    await withSystem(
      async (tx) => {
        await service.queueChange(tx, ORG_A, orderId, 'on_hold', null);
      },
      { orgId: ORG_A, userId: admin.userId },
    );
    answer = 409;
    await service.send(ORG_A, orderId);
    const refused = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ status: string }>(sql`
            select status from marketplace.ncom_outbox
            where org_id = ${ORG_A} and order_id = ${orderId} and revision = 2
          `)
        )[0],
      { orgId: ORG_A },
    );
    expect(refused?.status).toBe('refused');
  });
});

describe('the webhook', () => {
  it('takes a signed event once and refuses an unsigned one', async () => {
    const event = JSON.stringify({
      id: `evt_${suffix}`,
      topic: 'order.held_for_review',
      data: { id: 'x' },
    });
    const send = (signature: string) =>
      harness.server.inject({
        method: 'POST',
        url: `/ncom/${ORG_A}/webhook`,
        headers: { 'content-type': 'application/json', 'x-ncom-signature': signature },
        payload: event,
      });
    const header = () => ncomSignatureHeader(WEBHOOK_SECRET, event, Math.floor(Date.now() / 1000));
    expect(JSON.parse((await send(header())).body)).toEqual({ ok: true });
    expect(JSON.parse((await send(header())).body)).toEqual({ ok: true, deduped: true });
    expect((await send('t=1,v1=00')).statusCode).toBe(401);
  });
});

describe('Website → Marketplace', () => {
  it('never shows a secret, and is org_admin’s to change', async () => {
    const view = await admin.client.request('GET', '/v1/marketplace/ncom');
    expect(view.statusCode).toBe(200);
    expect(view.body).not.toContain(CONNECTOR_SECRET);
    expect(view.body).not.toContain(ORDER_SECRET);
    expect(JSON.parse(view.body)).toMatchObject({
      settings: {
        connectorKeyId: CONNECTOR_KEY,
        connectorSecretFingerprint: expect.stringMatching(/^[0-9a-f]{12}$/),
      },
    });
    const marketing = await harness.asRole('marketing', ORG_A);
    const refused = await marketing.client.request('PUT', '/v1/marketplace/ncom', {
      body: JSON.parse(view.body).settings as unknown,
    });
    expect(refused.statusCode).toBe(403);
  });
});
