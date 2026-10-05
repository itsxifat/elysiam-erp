import { createHash, randomUUID } from 'node:crypto';

import { withOrg, withSystem } from '@elysium/db';
import { DEFAULT_ADVANCE_POLICY, subtypeInfo } from '@elysium/domain';
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
import { NOTIFY_QUEUES } from '../notify/notify.queues.js';
import { EmailService } from '../notify/emails.service.js';
import { MAILER, FakeMailer } from '../notify/providers/mailer.js';
import { warehouseId, seedProductWithSkus } from '../inventory/inventory.testing.js';
import {
  applyOrderMigrations,
  balancesBySubtype,
  seedCustomer,
  seedOrder,
  seedStockLevel,
  stockAt,
  trialBalanceDifference,
} from '../orders/orders.testing.js';
import { PROMO_API, type PromoApi } from '../promo/promo.api.js';
import { WALLETS_API, type WalletsApi } from '../wallets/wallets.api.js';
import { OrderMail } from './order-mail.js';
import { PaymentsService, SSLCOMMERZ_WALLET } from './payments.service.js';
import { PAYMENT_GATEWAY, FakePaymentGateway } from './sslcommerz.gateway.js';
import { signStorefront } from './signature.js';
import { STOREFRONT_CONFIG, type StorefrontConfig } from './storefront.config.js';
import { STOREFRONT_QUEUE_DEFINITIONS, STOREFRONT_QUEUES } from './storefront.queues.js';
import { insertTestSiteKey, type TestSiteKey } from './storefront.testing.js';

/**
 * Buying on the website, over HTTP on real PostgreSQL (M34 checks 1 to 4 and 6).
 *
 * One brand set up the way its org admin would: products on the website with stock in the
 * warehouse, SSLCommerz switched on against the fake gateway, an email server switched on
 * against the fake mailer. Then the website's side of it, signed with a website key: quotes,
 * checkouts (and two of them racing for the last unit, and twenty for a five-unit flash sale),
 * online payments right and wrong, accounts from sign-up to Google, and the emails.
 */

let harness: HttpHarness;
let jobs: JobsRuntime | undefined;
let admin: RoleClient;
let marketing: RoleClient;
let key: TestSiteKey;
let mailer: FakeMailer;
let gateway: FakePaymentGateway;
let payments: PaymentsService;
let warehouse = '';
let area = { districtId: 0, thanaId: 0 };
let fee = 0n;
const suffix = randomUUID().slice(0, 6);
let skus: { id: string; code: string }[] = [];
let hiddenSku = '';

interface Money {
  readonly poisha: string;
  readonly taka: string;
}

async function signed<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<{ status: number; body: T; headers: Record<string, unknown>; raw: string }> {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
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
  };
  const response = await harness.server.inject({
    method,
    url: path,
    headers,
    ...(raw === undefined ? {} : { payload: raw }),
  });
  return {
    status: response.statusCode,
    body: (response.body === '' ? undefined : JSON.parse(response.body)) as T,
    headers: response.headers,
    raw: response.body,
  };
}

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `0171${String(Date.now() % 1000).padStart(3, '0')}${String(phoneCounter).padStart(4, '0')}`;
}

interface QuoteBody {
  quote: {
    lines: {
      skuId: string;
      qty: number;
      unitPrice: Money;
      compareAt: Money | null;
      flashSale: boolean;
    }[];
    unavailable: {
      skuId: string | null;
      variantId: string | null;
      reason: string;
      availableQty: number;
    }[];
    items: Money;
    delivery: Money;
    discount: Money;
    total: Money;
    deliverable: boolean | null;
    zone: string | null;
  };
}

async function quote(lines: { skuId?: string; variantId?: string; qty: number }[], extra = {}) {
  return signed<QuoteBody>('POST', '/storefront/v1/cart/quote', {
    lines,
    address: area,
    ...extra,
  });
}

interface CheckoutBody {
  order: {
    orderNo: string;
    viewToken: string;
    total: Money;
    payment: { method: string; required: boolean };
  };
  code?: string;
  lines?: { skuId: string }[];
  quote?: QuoteBody['quote'];
}

async function checkout(
  lines: { skuId: string; qty: number }[],
  expectedTotal: string,
  options: {
    readonly key?: string;
    readonly method?: 'cod' | 'sslcommerz';
    readonly email?: string;
    readonly phone?: string;
    readonly accountId?: string;
    readonly expectedLines?: { skuId: string; unitPricePoisha: string }[];
  } = {},
) {
  return signed<CheckoutBody>(
    'POST',
    '/storefront/v1/checkout',
    {
      lines,
      contact: {
        name: 'Rahima Akter',
        phone: options.phone ?? nextPhone(),
        ...(options.email === undefined ? {} : { email: options.email }),
      },
      address: { ...area, addressLine: 'House 7, Road 3' },
      paymentMethod: options.method ?? 'cod',
      ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
      expected: {
        totalPoisha: expectedTotal,
        ...(options.expectedLines === undefined ? {} : { lines: options.expectedLines }),
      },
    },
    options.key ?? randomUUID(),
  );
}

async function orderIdOf(orderNo: string): Promise<string> {
  return withSystem(
    async (tx) =>
      (
        await tx.execute<{ id: string }>(sql`
          select id from sales.orders where org_id = ${ORG_A} and order_no = ${orderNo}
        `)
      )[0]?.id ?? '',
    { orgId: ORG_A },
  );
}

async function one<T extends Record<string, unknown>>(
  query: ReturnType<typeof sql>,
): Promise<T | undefined> {
  return withSystem(async (tx) => (await tx.execute<T>(query))[0] as T | undefined, {
    orgId: ORG_A,
  });
}

async function waitFor<T>(probe: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error('waited too long');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Send every queued email of the brand through the fake mailer, and return what went. */
async function sendMail() {
  const emails = harness.app.get(EmailService);
  const ids = await withSystem(
    async (tx) =>
      tx.execute<{ id: string }>(sql`
        select id from notify.emails where org_id = ${ORG_A} and state = 'queued'
      `),
    { orgId: ORG_A },
  );
  for (const row of ids) await emails.deliver(ORG_A, row.id);
  return mailer.sent;
}

beforeAll(async () => {
  process.env.STOREFRONT_GATEWAY_WAIT_MS = '8000';
  harness = await startHttpHarness('storefront-buying');
  await applyOrderMigrations();
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues: [...STOREFRONT_QUEUE_DEFINITIONS, ...NOTIFY_QUEUES],
    logger: pino({ level: 'silent' }),
    pollingIntervalSeconds: 0.5,
  });
  payments = harness.app.get(PaymentsService);
  const report = () => Promise.resolve();
  // The worker's two gateway jobs, run in this process: the routes wait on what they write.
  await jobs.work(
    STOREFRONT_QUEUES.openSession.name,
    async (job) => {
      await payments.openSession(job.orgId ?? '', (job.payload as { sessionId: string }).sessionId);
    },
    report,
  );
  await jobs.work(
    STOREFRONT_QUEUES.validate.name,
    async (job) => {
      const payload = job.payload as { sessionId: string; valId: string };
      await payments.validate(job.orgId ?? '', payload.sessionId, payload.valId);
    },
    report,
  );

  const boundMailer: unknown = harness.app.get(MAILER, { strict: false });
  if (!(boundMailer instanceof FakeMailer)) throw new Error('the suite expects the fake mailer');
  mailer = boundMailer;
  const boundGateway: unknown = harness.app.get(PAYMENT_GATEWAY, { strict: false });
  if (!(boundGateway instanceof FakePaymentGateway)) throw new Error('expected the fake gateway');
  gateway = boundGateway;

  admin = await harness.asRole('org_admin', ORG_A);
  marketing = await harness.asRole('marketing', ORG_A);
  key = await insertTestSiteKey(ORG_A);
  warehouse = await warehouseId(ORG_A);

  // Four sizes on the website; a fifth product kept off it.
  const seeded = await seedProductWithSkus(ORG_A, `sfbuy${suffix}`, 4);
  skus = seeded.skus;
  const hidden = await seedProductWithSkus(ORG_A, `sfhid${suffix}`, 1);
  hiddenSku = hidden.skus[0]?.id ?? '';
  await withSystem(
    (tx) =>
      tx.execute(sql`
        update catalog.products set web_visible = true
        where org_id = ${ORG_A} and id = ${seeded.productId}
      `),
    { orgId: ORG_A },
  );
  const sku = (index: number) => skus[index]?.id ?? '';
  await seedStockLevel(ORG_A, {
    skuId: sku(0),
    locationId: warehouse,
    qty: 60,
    unitCostPoisha: 60_000n,
  });
  await seedStockLevel(ORG_A, {
    skuId: sku(1),
    locationId: warehouse,
    qty: 1,
    unitCostPoisha: 60_000n,
  });
  await seedStockLevel(ORG_A, {
    skuId: sku(2),
    locationId: warehouse,
    qty: 30,
    unitCostPoisha: 60_000n,
  });
  await seedStockLevel(ORG_A, {
    skuId: sku(3),
    locationId: warehouse,
    qty: 10,
    unitCostPoisha: 60_000n,
  });
  await seedStockLevel(ORG_A, {
    skuId: hiddenSku,
    locationId: warehouse,
    qty: 10,
    unitCostPoisha: 60_000n,
  });

  // An address in the brand's outside-Dhaka zone, which the default shipping rule charges for.
  const found = await withSystem(
    async (tx) =>
      (
        await tx.execute<{ district_id: number; thana_id: number; charge: string }>(sql`
          select a.district_id,
                 coalesce(a.thana_id, (select t.id from ref.thanas t
                                        where t.district_id = a.district_id order by t.id limit 1)) as thana_id,
                 z.charge_poisha::text as charge
          from sales.delivery_zone_areas a
          join sales.delivery_zones z on z.org_id = a.org_id and z.id = a.zone_id
          where a.org_id = ${ORG_A} and z.code = 'outside_dhaka' and z.is_active
          order by a.district_id limit 1
        `)
      )[0],
    { orgId: ORG_A },
  );
  if (found === undefined) throw new Error('no outside-Dhaka area seeded');
  area = { districtId: found.district_id, thanaId: found.thana_id };
  fee = BigInt(found.charge);

  // The website's settings: its address, both ways of paying.
  const current = await admin.client.request('GET', '/v1/storefront/settings');
  const settings = JSON.parse(current.body) as { siteInfo: Record<string, unknown> };
  const saved = await admin.client.request('PATCH', '/v1/storefront/settings', {
    body: {
      siteInfo: { ...settings.siteInfo, siteUrl: 'https://shop.example' },
      payments: { cod: true, sslcommerz: true },
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const gatewaySaved = await admin.client.request('PUT', '/v1/storefront/payments', {
    body: { enabled: true, mode: 'sandbox', storeId: 'teststore', storePassword: 'store-secret' },
  });
  expect(gatewaySaved.statusCode, gatewaySaved.body).toBe(200);
  const emailSaved = await admin.client.request('PUT', '/v1/storefront/email', {
    body: {
      enabled: true,
      host: 'smtp.example',
      port: 587,
      secure: false,
      username: 'mailer',
      password: 'mail-secret',
      fromName: 'Shop',
      fromEmail: 'shop@example.com',
    },
  });
  expect(emailSaved.statusCode, emailSaved.body).toBe(200);
}, 600_000);

afterAll(async () => {
  await jobs?.stop();
  await harness?.close();
}, 60_000);

const sku = (index: number) => skus[index]?.id ?? '';

// --- the quote --------------------------------------------------------------------------------

describe('the cart quote (D-520)', () => {
  it('prices the lines, charges the zone’s fee and adds it up', async () => {
    const response = await quote([{ skuId: sku(0), qty: 2 }]);
    expect(response.status, response.raw).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const q = response.body.quote;
    expect(q.items.poisha).toBe('300000');
    expect(q.zone).toBe('outside_dhaka');
    expect(q.deliverable).toBe(true);
    expect(q.delivery.poisha).toBe(fee.toString());
    expect(q.total.poisha).toBe((300_000n + fee).toString());
    expect(response.raw).not.toMatch(/cost|wac/i);
  });

  it('reports what cannot be bought, by reason, and an old variant id by its map', async () => {
    await withSystem(
      (tx) =>
        tx.execute(sql`
          insert into storefront.legacy_ids (org_id, kind, legacy_id, erp_id)
          values (${ORG_A}, 'variant', ${`old-${suffix}`}, ${sku(3)})
          on conflict do nothing
        `),
      { orgId: ORG_A },
    );
    const response = await quote([
      { skuId: sku(1), qty: 5 },
      { skuId: hiddenSku, qty: 1 },
      { variantId: 'never-heard-of-it', qty: 1 },
      { variantId: `old-${suffix}`, qty: 1 },
    ]);
    expect(response.status, response.raw).toBe(200);
    const q = response.body.quote;
    expect(q.unavailable.map((line) => line.reason).sort()).toEqual([
      'not_enough_stock',
      'not_found',
      'not_on_website',
    ]);
    expect(q.lines.map((line) => line.skuId)).toEqual([sku(3)]);
  });

  it('refuses a thana that is not the district’s', async () => {
    const response = await signed('POST', '/storefront/v1/cart/quote', {
      lines: [{ skuId: sku(0), qty: 1 }],
      address: { districtId: area.districtId, thanaId: 999_999 },
    });
    expect(response.status, response.raw).toBe(400);
  });
});

// --- check 1: the quote and the order agree; a moved price is refused --------------------------

describe('checkout (check 1, D-521)', () => {
  it('creates the order at the quoted total, holds the stock, and shows it to the shopper', async () => {
    const before = await stockAt(ORG_A, sku(0), warehouse);
    const priced = await quote([{ skuId: sku(0), qty: 2 }]);
    const total = priced.body.quote.total.poisha;
    const placed = await checkout([{ skuId: sku(0), qty: 2 }], total);
    expect(placed.status, placed.raw).toBe(201);
    expect(placed.body.order.total.poisha).toBe(total);
    expect(placed.body.order.viewToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const orderId = await orderIdOf(placed.body.order.orderNo);
    const order = await one<{
      cod: string;
      status: string;
      channel: string;
      held: boolean;
      assigned: string | null;
    }>(sql`
      select cod_amount_poisha::text as cod, status::text as status, channel::text as channel,
             stock_held_at is not null as held, assigned_to as assigned
      from sales.orders where org_id = ${ORG_A} and id = ${orderId}
    `);
    expect(order).toMatchObject({
      cod: total,
      status: 'pending',
      channel: 'website',
      held: true,
      assigned: null,
    });
    const after = await stockAt(ORG_A, sku(0), warehouse);
    expect(after.reserved - before.reserved).toBe(2);

    // The token is stored as its SHA-256, never as given.
    const token = await one<{ n: number }>(sql`
      select count(*)::int as n from storefront.order_view_tokens
      where org_id = ${ORG_A} and token_sha256 = ${createHash('sha256').update(placed.body.order.viewToken).digest('hex')}
    `);
    expect(token?.n).toBe(1);

    const view = await signed<{
      order: { total: Money; dueOnDelivery: Money; status: string; statusLabel: { en: string } };
    }>(
      'GET',
      `/storefront/v1/orders/${placed.body.order.orderNo}?token=${placed.body.order.viewToken}`,
    );
    expect(view.status, view.raw).toBe(200);
    expect(view.body.order.total.poisha).toBe(total);
    expect(view.body.order.dueOnDelivery.poisha).toBe(total);
    expect(view.body.order.status).toBe('placed');
    expect(view.body.order.statusLabel.en).toBe('Order placed');
    expect(view.raw).not.toMatch(/cost|wac|notes/i);

    const wrongToken = await signed(
      'GET',
      `/storefront/v1/orders/${placed.body.order.orderNo}?token=${'A'.repeat(43)}`,
    );
    expect(wrongToken.status).toBe(404);
  });

  it('refuses with CART_REPRICED and the new quote when a price moved', async () => {
    const priced = await quote([{ skuId: sku(3), qty: 1 }]);
    const oldTotal = priced.body.quote.total.poisha;
    const productId = await one<{ product_id: string }>(sql`
      select product_id from catalog.skus where org_id = ${ORG_A} and id = ${sku(3)}
    `);
    await withSystem(
      (tx) =>
        tx.execute(
          sql`update catalog.skus set price_poisha = 160000 where org_id = ${ORG_A} and id = ${sku(3)}`,
        ),
      { orgId: ORG_A },
    );
    try {
      const refused = await checkout([{ skuId: sku(3), qty: 1 }], oldTotal, {
        expectedLines: [{ skuId: sku(3), unitPricePoisha: '150000' }],
      });
      expect(refused.status, refused.raw).toBe(409);
      expect(refused.body.code).toBe('CART_REPRICED');
      expect(refused.body.quote?.total.poisha).toBe((160_000n + fee).toString());
      expect(productId).toBeDefined();
    } finally {
      await withSystem(
        (tx) =>
          tx.execute(
            sql`update catalog.skus set price_poisha = 150000 where org_id = ${ORG_A} and id = ${sku(3)}`,
          ),
        { orgId: ORG_A },
      );
    }
  });

  it('answers a retried checkout from the record, and refuses the key for another body', async () => {
    const priced = await quote([{ skuId: sku(0), qty: 1 }]);
    const idem = `retry-${randomUUID()}`;
    const phone = nextPhone();
    const first = await checkout([{ skuId: sku(0), qty: 1 }], priced.body.quote.total.poisha, {
      key: idem,
      phone,
    });
    const again = await checkout([{ skuId: sku(0), qty: 1 }], priced.body.quote.total.poisha, {
      key: idem,
      phone,
    });
    expect(first.status, first.raw).toBe(201);
    expect(again.status, again.raw).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.body.order.orderNo).toBe(first.body.order.orderNo);
    const other = await checkout([{ skuId: sku(0), qty: 2 }], priced.body.quote.total.poisha, {
      key: idem,
    });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('IDEMPOTENCY_CONFLICT');
    const missingKey = await signed('POST', '/storefront/v1/checkout', { lines: [] });
    expect(missingKey.status).toBe(400);
  });
});

// --- check 2: two shoppers, one unit ------------------------------------------------------------

describe('two shoppers racing for the last unit (check 2)', () => {
  it('gives one an order and the other OUT_OF_STOCK, and never goes below zero', async () => {
    const priced = await quote([{ skuId: sku(1), qty: 1 }]);
    const total = priced.body.quote.total.poisha;
    const [a, b] = await Promise.all([
      checkout([{ skuId: sku(1), qty: 1 }], total),
      checkout([{ skuId: sku(1), qty: 1 }], total),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses, `${a.raw} | ${b.raw}`).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.code).toBe('OUT_OF_STOCK');
    expect(loser.body.lines?.map((line) => line.skuId)).toEqual([sku(1)]);
    const level = await stockAt(ORG_A, sku(1), warehouse);
    expect(level).toEqual({ onHand: 1, reserved: 1 });
  });
});

// --- the held order through the state machine (D-532) -----------------------------------------

describe('a held website order (D-532)', () => {
  it('reserves nothing more on confirm, and a pending cancel releases exactly once', async () => {
    const priced = await quote([{ skuId: sku(3), qty: 2 }]);
    const confirmMe = await checkout([{ skuId: sku(3), qty: 2 }], priced.body.quote.total.poisha);
    const cancelMe = await checkout([{ skuId: sku(3), qty: 2 }], priced.body.quote.total.poisha);
    expect(confirmMe.status, confirmMe.raw).toBe(201);
    expect(cancelMe.status, cancelMe.raw).toBe(201);
    const held = await stockAt(ORG_A, sku(3), warehouse);

    const confirmId = await orderIdOf(confirmMe.body.order.orderNo);
    const confirmed = await admin.client.request('POST', `/v1/orders/${confirmId}/confirm`, {
      body: {},
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    expect(await stockAt(ORG_A, sku(3), warehouse)).toEqual(held);

    const cancelId = await orderIdOf(cancelMe.body.order.orderNo);
    const cancelled = await admin.client.request('POST', `/v1/orders/${cancelId}/cancel`, {
      body: { reason: 'The shopper changed their mind.' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(201);
    const released = await stockAt(ORG_A, sku(3), warehouse);
    expect(released.reserved).toBe(held.reserved - 2);
    const twice = await admin.client.request('POST', `/v1/orders/${cancelId}/cancel`, {
      body: { reason: 'Again.' },
    });
    expect(twice.statusCode).toBeGreaterThanOrEqual(400);
    expect(await stockAt(ORG_A, sku(3), warehouse)).toEqual(released);
  });
});

// --- check 3: SSLCommerz ------------------------------------------------------------------------

async function sslOrder(email = `pay-${randomUUID().slice(0, 6)}@example.com`) {
  const priced = await quote([{ skuId: sku(0), qty: 1 }]);
  const total = priced.body.quote.total.poisha;
  const placed = await checkout([{ skuId: sku(0), qty: 1 }], total, {
    method: 'sslcommerz',
    email,
  });
  expect(placed.status, placed.raw).toBe(201);
  expect(placed.body.order.payment).toEqual({ method: 'sslcommerz', required: true });
  const init = await signed<{ payment: { gatewayUrl: string; tranId: string; amount: Money } }>(
    'POST',
    '/storefront/v1/payments/sslcommerz/init',
    { orderNo: placed.body.order.orderNo, token: placed.body.order.viewToken },
  );
  expect(init.status, init.raw).toBe(200);
  expect(init.body.payment.amount.poisha).toBe(total);
  return {
    orderNo: placed.body.order.orderNo,
    orderId: await orderIdOf(placed.body.order.orderNo),
    tranId: init.body.payment.tranId,
    total,
  };
}

describe('SSLCommerz (check 3, D-525, D-526)', () => {
  it('opens a session through the worker and hands the website the gateway page', async () => {
    const order = await sslOrder();
    const sent = gateway.sessions.find((session) => session.request.tranId === order.tranId);
    expect(sent?.request.totalAmount).toBe(`${order.total.slice(0, -2)}.${order.total.slice(-2)}`);
    expect(sent?.request.ipnUrl).toMatch(new RegExp(`/storefront/ipn/sslcommerz/${ORG_A}$`));
    expect(sent?.request.successUrl).toBe('https://shop.example/api/payment/sslcommerz/success');
    expect(sent?.credentials).toMatchObject({
      storeId: 'teststore',
      storePassword: 'store-secret',
      mode: 'sandbox',
    });
  });

  it('refuses and logs a payment whose validated amount differs, and books the money owed back', async () => {
    const before = await balancesBySubtype(ORG_A);
    const order = await sslOrder();
    gateway.validations.set('VAL-SHORT', {
      status: 'VALID',
      tran_id: order.tranId,
      currency: 'BDT',
      amount: '10.00',
    });
    const back = await signed<{ payment: { status: string } }>(
      'POST',
      '/storefront/v1/payments/sslcommerz/return',
      { kind: 'success', tranId: order.tranId, valId: 'VAL-SHORT' },
    );
    expect(back.status, back.raw).toBe(200);
    expect(back.body.payment.status).toBe('refused');
    const session = await one<{ status: string; failure_reason: string }>(sql`
      select status, failure_reason from storefront.payment_sessions
      where org_id = ${ORG_A} and tran_id = ${order.tranId}
    `);
    expect(session).toEqual({ status: 'refused', failure_reason: 'amount_mismatch' });
    // Ledger audit W3: the ৳10 SSLCommerz took is booked into the clearing wallet and owed
    // back at once, never applied to the order.
    const advances = await one<{ n: number; status: string; amount: string; kept: string }>(sql`
      select count(*) over ()::int as n, status, amount_poisha::text as amount, kept_poisha::text as kept
      from sales.order_advances where org_id = ${ORG_A} and order_id = ${order.orderId}
    `);
    expect(advances).toEqual({ n: 1, status: 'refund_due', amount: '1000', kept: '0' });
    const cod = await one<{ cod: string; advance: string }>(sql`
      select cod_amount_poisha::text as cod, advance_paid_poisha::text as advance
      from sales.orders where org_id = ${ORG_A} and id = ${order.orderId}
    `);
    expect(cod).toEqual({ cod: order.total, advance: '0' });
    const balances = await balancesBySubtype(ORG_A);
    const moved = (subtype: string) => (balances.get(subtype) ?? 0n) - (before.get(subtype) ?? 0n);
    expect(moved('wallet_mfs_other')).toBe(1000n);
    expect(moved('customer_advance')).toBe(-1000n);
    expect(await trialBalanceDifference(ORG_A)).toBe(0n);
    const logged = await one<{ n: number }>(sql`
      select count(*)::int as n from audit.audit_log
      where org_id = ${ORG_A} and action = 'storefront.payment_refused' and entity_id = ${order.orderId}
    `);
    expect(logged?.n).toBe(1);
  });

  it('books a correct payment from the IPN: Dr clearing / Cr customer advances, COD to zero, once', async () => {
    const before = await balancesBySubtype(ORG_A);
    const order = await sslOrder();
    gateway.validations.set('VAL-GOOD', {
      status: 'VALID',
      tran_id: order.tranId,
      currency: 'BDT',
      amount: `${order.total.slice(0, -2)}.${order.total.slice(-2)}`,
      card_type: 'BKASH-BKash',
      bank_tran_id: 'BANKTX1',
    });
    const ipn = async () =>
      harness.server.inject({
        method: 'POST',
        url: `/storefront/ipn/sslcommerz/${ORG_A}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          tran_id: order.tranId,
          val_id: 'VAL-GOOD',
          status: 'VALID',
          amount: '1.00',
        }).toString(),
      });
    expect((await ipn()).statusCode).toBe(200);
    await waitFor(async () =>
      (
        await one<{ status: string }>(sql`
        select status from storefront.payment_sessions where org_id = ${ORG_A} and tran_id = ${order.tranId}
      `)
      )?.status === 'paid'
        ? true
        : undefined,
    );
    expect((await ipn()).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const advance = await one<{
      n: number;
      method: string;
      status: string;
      decided_by: string;
      amount: string;
    }>(sql`
      select count(*) over ()::int as n, method, status, decided_by, amount_poisha::text as amount
      from sales.order_advances where org_id = ${ORG_A} and order_id = ${order.orderId}
    `);
    expect(advance).toMatchObject({
      n: 1,
      method: 'sslcommerz',
      status: 'verified',
      decided_by: 'gateway:sslcommerz',
      amount: order.total,
    });
    const after = await one<{ cod: string; advance: string }>(sql`
      select cod_amount_poisha::text as cod, advance_paid_poisha::text as advance
      from sales.orders where org_id = ${ORG_A} and id = ${order.orderId}
    `);
    expect(after).toEqual({ cod: '0', advance: order.total });

    const balances = await balancesBySubtype(ORG_A);
    const moved = (subtype: string) => (balances.get(subtype) ?? 0n) - (before.get(subtype) ?? 0n);
    expect(moved('customer_advance')).toBe(-BigInt(order.total));
    expect(moved('wallet_mfs_other')).toBe(BigInt(order.total));
    expect(await trialBalanceDifference(ORG_A)).toBe(0n);
    const wallet = await one<{ code: string }>(sql`
      select a.code from wallets.wallets w join ledger.accounts a on a.org_id = w.org_id and a.id = w.ledger_account_id
      where w.org_id = ${ORG_A} and a.code = '1120'
    `);
    expect(wallet?.code).toBe('1120');

    const view = await signed<{ order: { payment: { status: string }; dueOnDelivery: Money } }>(
      'GET',
      `/storefront/v1/orders/${order.orderNo}?token=${'x'.repeat(43)}`,
    );
    expect(view.status).toBe(404);
  });

  it('cancels a still-pending unpaid order on a failed return, and releases its hold', async () => {
    const before = await stockAt(ORG_A, sku(0), warehouse);
    const order = await sslOrder();
    const held = await stockAt(ORG_A, sku(0), warehouse);
    expect(held.reserved).toBe(before.reserved + 1);
    const back = await signed<{ payment: { status: string } }>(
      'POST',
      '/storefront/v1/payments/sslcommerz/return',
      { kind: 'fail', tranId: order.tranId },
    );
    expect(back.status, back.raw).toBe(200);
    expect(back.body.payment.status).toBe('cancelled');
    const status = await one<{ status: string }>(sql`
      select status::text as status from sales.orders where org_id = ${ORG_A} and id = ${order.orderId}
    `);
    expect(status?.status).toBe('cancelled');
    expect(await stockAt(ORG_A, sku(0), warehouse)).toEqual(before);
  });

  it('cancels an order unpaid at sixty minutes, and leaves a paid one alone', async () => {
    const before = await stockAt(ORG_A, sku(0), warehouse);
    const order = await sslOrder();
    expect(await payments.expireUnpaid(ORG_A, order.orderId)).toBe('cancelled');
    expect(await stockAt(ORG_A, sku(0), warehouse)).toEqual(before);
    const session = await one<{ status: string }>(sql`
      select status from storefront.payment_sessions where org_id = ${ORG_A} and tran_id = ${order.tranId}
    `);
    expect(session?.status).toBe('expired');
    expect(await payments.expireUnpaid(ORG_A, order.orderId)).toBe('kept');
  });

  it('refuses online payment when the brand switched it off', async () => {
    await admin.client.request('PUT', '/v1/storefront/payments', {
      body: { enabled: false, mode: 'sandbox', storeId: 'teststore' },
    });
    try {
      const priced = await quote([{ skuId: sku(0), qty: 1 }]);
      const refused = await checkout([{ skuId: sku(0), qty: 1 }], priced.body.quote.total.poisha, {
        method: 'sslcommerz',
        email: 'off@example.com',
      });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
    } finally {
      await admin.client.request('PUT', '/v1/storefront/payments', {
        body: { enabled: true, mode: 'sandbox', storeId: 'teststore' },
      });
    }
  });

  it('C1: a sandbox store takes no money where the installation does not allow sandbox', async () => {
    const order = await sslOrder();
    const config = harness.app.get<StorefrontConfig>(STOREFRONT_CONFIG, { strict: false }) as {
      STOREFRONT_SSLCOMMERZ_ALLOW_SANDBOX: boolean;
    };
    config.STOREFRONT_SSLCOMMERZ_ALLOW_SANDBOX = false;
    try {
      const priced = await quote([{ skuId: sku(0), qty: 1 }]);
      const refused = await checkout([{ skuId: sku(0), qty: 1 }], priced.body.quote.total.poisha, {
        method: 'sslcommerz',
        email: 'sandbox@example.com',
      });
      expect(refused.status, refused.raw).toBe(409);
      expect(refused.body.code).toBe('PAYMENT_METHOD_UNAVAILABLE');

      // A test-card "payment" on a page opened before: refused, nothing booked, COD intact.
      gateway.validations.set('VAL-SANDBOX', {
        status: 'VALID',
        tran_id: order.tranId,
        currency: 'BDT',
        amount: `${order.total.slice(0, -2)}.${order.total.slice(-2)}`,
      });
      const back = await signed<{ payment: { status: string } }>(
        'POST',
        '/storefront/v1/payments/sslcommerz/return',
        { kind: 'success', tranId: order.tranId, valId: 'VAL-SANDBOX' },
      );
      expect(back.body.payment.status, back.raw).toBe('refused');
      const session = await one<{ status: string; failure_reason: string }>(sql`
        select status, failure_reason from storefront.payment_sessions
        where org_id = ${ORG_A} and tran_id = ${order.tranId}
      `);
      expect(session).toEqual({ status: 'refused', failure_reason: 'sandbox_not_accepted' });
      const booked = await one<{ n: number; cod: string }>(sql`
        select (select count(*)::int from sales.order_advances a
                where a.org_id = o.org_id and a.order_id = o.id) as n,
               o.cod_amount_poisha::text as cod
        from sales.orders o where o.org_id = ${ORG_A} and o.id = ${order.orderId}
      `);
      expect(booked).toEqual({ n: 0, cod: order.total });
    } finally {
      config.STOREFRONT_SSLCOMMERZ_ALLOW_SANDBOX = true;
    }
  });

  it('a key this server cannot open fails the check for a retry, and never refuses the payment', async () => {
    const order = await sslOrder();
    const session = await one<{ id: string }>(sql`
      select id from storefront.payment_sessions where org_id = ${ORG_A} and tran_id = ${order.tranId}
    `);
    gateway.validations.set('VAL-NOKEY', {
      status: 'VALID',
      tran_id: order.tranId,
      currency: 'BDT',
      amount: `${order.total.slice(0, -2)}.${order.total.slice(-2)}`,
    });
    const key = process.env.STOREFRONT_CREDENTIALS_KEY;
    // A worker deployed with another key (a rotation half done).
    process.env.STOREFRONT_CREDENTIALS_KEY = Buffer.alloc(32, 99).toString('base64');
    try {
      await expect(payments.validate(ORG_A, session?.id ?? '', 'VAL-NOKEY')).rejects.toThrow();
    } finally {
      process.env.STOREFRONT_CREDENTIALS_KEY = key;
    }
    const untouched = await one<{ status: string; n: number }>(sql`
      select s.status,
             (select count(*)::int from sales.order_advances a
              where a.org_id = s.org_id and a.order_id = s.order_id) as n
      from storefront.payment_sessions s where s.org_id = ${ORG_A} and s.id = ${session?.id}
    `);
    expect(untouched).toEqual({ status: 'ready', n: 0 });
    // The retry, with the right key, books it.
    expect(await payments.validate(ORG_A, session?.id ?? '', 'VAL-NOKEY')).toBe('paid:applied');
  });

  it('W1: a payment being checked keeps its order from the unpaid timer and from a fail', async () => {
    const order = await sslOrder();
    // The gateway never answers this one: the check stays in flight.
    gateway.unreachable.add('VAL-SLOW');
    const ipn = await harness.server.inject({
      method: 'POST',
      url: `/storefront/ipn/sslcommerz/${ORG_A}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ tran_id: order.tranId, val_id: 'VAL-SLOW' }).toString(),
    });
    expect(ipn.statusCode).toBe(200);
    const sessionStatus = async () =>
      (
        await one<{ status: string }>(sql`
          select status from storefront.payment_sessions where org_id = ${ORG_A} and tran_id = ${order.tranId}
        `)
      )?.status;
    expect(await sessionStatus()).toBe('validating');

    expect(await payments.expireUnpaid(ORG_A, order.orderId)).toBe('kept');
    const failed = await signed<{ payment: { status: string } }>(
      'POST',
      '/storefront/v1/payments/sslcommerz/return',
      { kind: 'fail', tranId: order.tranId },
    );
    expect(failed.body.payment.status, failed.raw).toBe('checking');
    const status = await one<{ status: string }>(sql`
      select status::text as status from sales.orders where org_id = ${ORG_A} and id = ${order.orderId}
    `);
    expect(status?.status).toBe('pending');
    expect(await sessionStatus()).toBe('validating');
  });

  it('W2: a valid payment after the order was cancelled is owed back in full, whatever the policy', async () => {
    const previous = await one<{ value: unknown }>(sql`
      select value from org.settings where org_id = ${ORG_A} and key = 'orders.advance_on_cancel'
    `);
    await setSetting('orders.advance_on_cancel', 'forfeit');
    try {
      const before = await balancesBySubtype(ORG_A);
      const order = await sslOrder();
      expect(await payments.expireUnpaid(ORG_A, order.orderId)).toBe('cancelled');
      gateway.validations.set('VAL-LATE', {
        status: 'VALID',
        tran_id: order.tranId,
        currency: 'BDT',
        amount: `${order.total.slice(0, -2)}.${order.total.slice(-2)}`,
      });
      const back = await signed<{ payment: { status: string } }>(
        'POST',
        '/storefront/v1/payments/sslcommerz/return',
        { kind: 'success', tranId: order.tranId, valId: 'VAL-LATE' },
      );
      expect(back.body.payment.status, back.raw).toBe('paid');
      const advance = await one<{ status: string; amount: string; kept: string }>(sql`
        select status, amount_poisha::text as amount, kept_poisha::text as kept
        from sales.order_advances where org_id = ${ORG_A} and order_id = ${order.orderId}
      `);
      expect(advance).toEqual({ status: 'refund_due', amount: order.total, kept: '0' });
      const balances = await balancesBySubtype(ORG_A);
      const moved = (subtype: string) =>
        (balances.get(subtype) ?? 0n) - (before.get(subtype) ?? 0n);
      expect(moved('wallet_mfs_other')).toBe(BigInt(order.total));
      expect(moved('customer_advance')).toBe(-BigInt(order.total));
      expect(moved('other_income')).toBe(0n);
      expect(await trialBalanceDifference(ORG_A)).toBe(0n);
    } finally {
      await setSetting(
        'orders.advance_on_cancel',
        typeof previous?.value === 'string' ? previous.value : DEFAULT_ADVANCE_POLICY.onCancel,
      );
    }
  });

  it('W4: the clearing wallet is the gateway’s own, never a staff wallet at its code', async () => {
    const info = subtypeInfo('wallet_mfs_other');
    const staffAccount = await withSystem(
      async (tx) => {
        const [taken] = await tx.execute<{ id: string }>(sql`
          insert into ledger.accounts (org_id, code, name, class, subtype, normal_balance)
          values (${ORG_B}, '1120', 'Rocket', ${info.class}::ledger.account_class,
                  'wallet_mfs_other'::ledger.account_subtype,
                  ${info.normalBalance}::ledger.normal_balance)
          on conflict (org_id, code) do nothing
          returning id
        `);
        if (taken === undefined) return undefined;
        await tx.execute(sql`
          insert into wallets.wallets
            (org_id, ledger_account_id, branch_id, provider, account_ref_masked, requires_daily_closing)
          values (${ORG_B}, ${taken.id}, null, 'rocket', null, false)
        `);
        return taken.id;
      },
      { orgId: ORG_B },
    );
    const wallets = harness.app.get<WalletsApi>(WALLETS_API, { strict: false });
    const ensure = () =>
      withOrg({ orgId: ORG_B, userId: 'usr_test' }, (tx) =>
        wallets.ensureSystemWallet(tx, ORG_B, SSLCOMMERZ_WALLET),
      );
    const first = await ensure();
    const again = await ensure();
    expect(again.accountId).toBe(first.accountId);
    if (staffAccount !== undefined) expect(first.accountId).not.toBe(staffAccount);
    const provider = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ provider: string }>(sql`
            select provider from wallets.wallets where org_id = ${ORG_B} and ledger_account_id = ${first.accountId}
          `)
        )[0]?.provider,
      { orgId: ORG_B },
    );
    expect(provider).toBe('sslcommerz');
  });

  it('W6: the console’s lists need an org-wide reach, and the order card the order’s own', async () => {
    const sales = await harness.asRole('sales', ORG_A);
    for (const url of [
      '/v1/storefront/accounts',
      '/v1/storefront/payments/sessions',
      '/v1/storefront/email/log',
    ]) {
      const refused = await sales.client.request('GET', url);
      expect(refused.statusCode, `${url} ${refused.body}`).toBe(403);
      const allowed = await marketing.client.request('GET', url);
      expect(allowed.statusCode, `${url} ${allowed.body}`).toBe(200);
    }
    const priced = await quote([{ skuId: sku(0), qty: 1 }]);
    const placed = await checkout([{ skuId: sku(0), qty: 1 }], priced.body.quote.total.poisha);
    expect(placed.status, placed.raw).toBe(201);
    const orderId = await orderIdOf(placed.body.order.orderNo);
    const hidden = await sales.client.request('GET', `/v1/storefront/orders/${orderId}`);
    expect(hidden.statusCode).toBe(404);
    const shown = await admin.client.request('GET', `/v1/storefront/orders/${orderId}`);
    expect(shown.statusCode, shown.body).toBe(200);
    expect(
      (JSON.parse(shown.body) as { website: { paymentMethod: string } }).website.paymentMethod,
    ).toBe('cod');
  });
});

async function setSetting(key: string, value: string): Promise<void> {
  await withSystem(
    async (tx) =>
      tx.execute(sql`
        insert into org.settings (org_id, key, value)
        values (${ORG_A}, ${key}, ${JSON.stringify(value)}::jsonb)
        on conflict (org_id, key) do update set value = excluded.value
      `),
    { orgId: ORG_A },
  );
}

// --- check 4: accounts --------------------------------------------------------------------------

interface AccountBody {
  account: {
    id: string;
    email: string;
    emailVerified: boolean;
    hasPassword: boolean;
    googleLinked: boolean;
  };
}

function codeFrom(text: string): string {
  const match = /\b(\d{6})\b/.exec(text);
  if (match?.[1] === undefined) throw new Error('no code in the email');
  return match[1];
}

describe('shopper accounts (check 4, D-522, D-523)', () => {
  it('registers, verifies with a hashed code, signs in, resets, and claims a guest order', async () => {
    const email = `rahim-${suffix}@example.com`;
    // A guest order with this email, placed before the account exists.
    const priced = await quote([{ skuId: sku(0), qty: 1 }]);
    const guest = await checkout([{ skuId: sku(0), qty: 1 }], priced.body.quote.total.poisha, {
      email,
    });
    expect(guest.status, guest.raw).toBe(201);
    // Ledger audit W5: an email-less guest order on the phone the account will give is never
    // claimed by it — a typed phone proves nothing.
    const accountPhone = nextPhone();
    const byPhone = await checkout([{ skuId: sku(0), qty: 1 }], priced.body.quote.total.poisha, {
      phone: accountPhone,
    });
    expect(byPhone.status, byPhone.raw).toBe(201);

    const registered = await signed<{ accountId: string; requiresVerification: boolean }>(
      'POST',
      '/storefront/v1/accounts/register',
      {
        email: email.toUpperCase(),
        password: 'correct-horse',
        name: 'Rahim',
        phone: accountPhone,
        locale: 'en',
        client: { ip: '203.0.113.9' },
      },
    );
    expect(registered.status, registered.raw).toBe(201);
    expect(registered.body.requiresVerification).toBe(true);
    const accountId = registered.body.accountId;

    mailer.clear();
    const sent = await sendMail();
    const codeMail = sent.find(
      (mail) => mail.email.to === email && mail.email.subject.includes('verification code'),
    );
    if (codeMail === undefined) throw new Error('no code email');
    const code = codeFrom(codeMail.email.text);

    const stored = await one<{ code_hash: string }>(sql`
      select code_hash from storefront.account_codes
      where org_id = ${ORG_A} and account_id = ${accountId} and purpose = 'verify_email'
    `);
    expect(stored?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.code_hash).not.toContain(code);
    // The sent email's sealed body is gone once it went.
    const cleared = await one<{ body: boolean }>(sql`
      select body_sealed is null as body from notify.emails where org_id = ${ORG_A} and to_email = ${email}
      order by created_at desc limit 1
    `);
    expect(cleared?.body).toBe(true);

    const notYet = await signed('POST', '/storefront/v1/accounts/sign-in', {
      email,
      password: 'correct-horse',
    });
    expect(notYet.status).toBe(403);

    const wrong = await signed('POST', '/storefront/v1/accounts/verify-email', {
      email,
      code: code === '000000' ? '000001' : '000000',
    });
    expect(wrong.status).toBe(400);
    const tries = await one<{ attempts: number }>(sql`
      select attempts from storefront.account_codes where org_id = ${ORG_A} and account_id = ${accountId}
      and purpose = 'verify_email' and consumed_at is null
    `);
    expect(tries?.attempts).toBe(1);

    const verified = await signed<AccountBody>('POST', '/storefront/v1/accounts/verify-email', {
      email,
      code,
    });
    expect(verified.status, verified.raw).toBe(200);
    expect(verified.body.account.emailVerified).toBe(true);

    const orders = await signed<{ items: { orderNo: string }[] }>(
      'GET',
      `/storefront/v1/accounts/${accountId}/orders`,
    );
    expect(orders.status, orders.raw).toBe(200);
    expect(orders.body.items.map((item) => item.orderNo)).toContain(guest.body.order.orderNo);
    expect(orders.body.items.map((item) => item.orderNo)).not.toContain(byPhone.body.order.orderNo);
    const detail = await signed(
      'GET',
      `/storefront/v1/accounts/${accountId}/orders/${guest.body.order.orderNo}`,
    );
    expect(detail.status, detail.raw).toBe(200);

    const signedIn = await signed<AccountBody>('POST', '/storefront/v1/accounts/sign-in', {
      email,
      password: 'correct-horse',
    });
    expect(signedIn.status, signedIn.raw).toBe(200);
    expect(signedIn.body.account.id).toBe(accountId);
    expect(signedIn.raw).not.toMatch(/\$2[aby]\$|password_hash|google_sub/);
    const bad = await signed('POST', '/storefront/v1/accounts/sign-in', {
      email,
      password: 'wrong-horse',
    });
    expect(bad.status).toBe(401);
    const nobody = await signed('POST', '/storefront/v1/accounts/sign-in', {
      email: `nobody-${suffix}@example.com`,
      password: 'x',
    });
    expect(nobody.status).toBe(401);
    const again = await signed('POST', '/storefront/v1/accounts/register', {
      email,
      password: 'another-pass',
      name: 'Again',
    });
    expect(again.status).toBe(409);

    // Forgotten password: a link to the inbox, its token kept as SHA-256, used once.
    mailer.clear();
    const forgot = await signed('POST', '/storefront/v1/accounts/forgot-password', { email });
    expect(forgot.status).toBe(200);
    const resetMail = (await sendMail()).find((mail) => mail.email.to === email);
    const token = /token=([A-Za-z0-9_-]{43})/.exec(resetMail?.email.text ?? '')?.[1] ?? '';
    expect(token).toHaveLength(43);
    const tokenRow = await one<{ n: number }>(sql`
      select count(*)::int as n from storefront.account_codes where org_id = ${ORG_A}
      and purpose = 'reset_password' and code_hash = ${createHash('sha256').update(token).digest('hex')}
    `);
    expect(tokenRow?.n).toBe(1);
    const reset = await signed('POST', '/storefront/v1/accounts/reset-password', {
      token,
      password: 'battery-staple',
    });
    expect(reset.status, reset.raw).toBe(200);
    const reused = await signed('POST', '/storefront/v1/accounts/reset-password', {
      token,
      password: 'third-password',
    });
    expect(reused.status).toBe(400);
    const newPass = await signed('POST', '/storefront/v1/accounts/sign-in', {
      email,
      password: 'battery-staple',
    });
    expect(newPass.status).toBe(200);

    const changed = await signed('POST', `/storefront/v1/accounts/${accountId}/change-password`, {
      currentPassword: 'battery-staple',
      newPassword: 'fourth-password',
    });
    expect(changed.status, changed.raw).toBe(200);

    const profile = await signed<
      AccountBody & { account: { addresses: unknown[]; phone: string } }
    >('PATCH', `/storefront/v1/accounts/${accountId}`, {
      phone: '01712345678',
      addresses: [
        {
          name: 'Rahim',
          phone: '01712345678',
          ...area,
          addressLine: 'House 7, Road 3',
          isDefault: true,
        },
      ],
    });
    expect(profile.status, profile.raw).toBe(200);
    expect(profile.body.account.phone).toBe('+8801712345678');
    expect(profile.body.account.addresses).toHaveLength(1);
  });

  it('links Google only to a verified address, and never to another Google login', async () => {
    const fresh = `g-${suffix}@example.com`;
    const created = await signed<AccountBody & { created: boolean }>(
      'POST',
      '/storefront/v1/accounts/google',
      {
        email: fresh,
        emailVerified: true,
        googleSub: `sub-${suffix}`,
        name: 'Gina',
      },
    );
    expect(created.status, created.raw).toBe(200);
    expect(created.body.created).toBe(true);
    expect(created.body.account).toMatchObject({
      emailVerified: true,
      hasPassword: false,
      googleLinked: true,
    });
    const same = await signed<AccountBody & { created: boolean }>(
      'POST',
      '/storefront/v1/accounts/google',
      {
        email: fresh,
        emailVerified: true,
        googleSub: `sub-${suffix}`,
      },
    );
    expect(same.body.created).toBe(false);
    expect(same.body.account.id).toBe(created.body.account.id);
    const other = await signed('POST', '/storefront/v1/accounts/google', {
      email: fresh,
      emailVerified: true,
      googleSub: `other-${suffix}`,
    });
    expect(other.status).toBe(409);
    const noPassword = await signed(
      'POST',
      `/storefront/v1/accounts/${created.body.account.id}/change-password`,
      {
        currentPassword: 'x',
        newPassword: 'whatever-new',
      },
    );
    expect(noPassword.status).toBe(409);

    // An address somebody registered and never verified: Google may not take it over.
    const unverified = `u-${suffix}@example.com`;
    await signed('POST', '/storefront/v1/accounts/register', {
      email: unverified,
      password: 'pre-hijack',
      name: 'X',
    });
    const refused = await signed<{ code: string }>('POST', '/storefront/v1/accounts/google', {
      email: unverified,
      emailVerified: true,
      googleSub: `victim-${suffix}`,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('ACCOUNT_EMAIL_UNVERIFIED');
    const notLinked = await one<{ sub: string | null }>(sql`
      select google_sub as sub from storefront.customer_accounts where org_id = ${ORG_A} and email = ${unverified}
    `);
    expect(notLinked?.sub).toBeNull();
    const unverifiedGoogle = await signed('POST', '/storefront/v1/accounts/google', {
      email: `x-${suffix}@example.com`,
      emailVerified: false,
      googleSub: 'nope',
    });
    expect(unverifiedGoogle.status).toBe(400);
  });
});

// --- emails on status changes (D-530) ----------------------------------------------------------

describe('order emails (D-529, D-530)', () => {
  it('writes a status email once per order and status, with a tokened link', async () => {
    const priced = await quote([{ skuId: sku(0), qty: 1 }]);
    const placed = await checkout([{ skuId: sku(0), qty: 1 }], priced.body.quote.total.poisha, {
      email: `notify-${suffix}@example.com`,
    });
    const orderId = await orderIdOf(placed.body.order.orderNo);
    const mail = harness.app.get(OrderMail);
    const event = {
      id: randomUUID(),
      orgId: ORG_A,
      name: 'order.status_changed',
      payload: { id: orderId, to: 'confirmed' },
      rooms: [],
      attempts: 0,
      occurredAt: new Date(),
      actorUserId: null,
    };
    await mail.onStatusChanged(event);
    await mail.onStatusChanged(event);
    const rows = await withSystem(
      (tx) =>
        tx.execute<{ template_key: string }>(sql`
          select template_key from notify.emails where org_id = ${ORG_A} and ref_id = ${orderId}
          order by created_at
        `),
      { orgId: ORG_A },
    );
    expect(rows.map((row) => row.template_key)).toEqual(['order.placed', 'order.confirmed']);
    mailer.clear();
    const sent = await sendMail();
    const ours = sent.filter((entry) => entry.email.subject.includes(placed.body.order.orderNo));
    expect(ours).toHaveLength(2);
    for (const entry of ours) {
      expect(entry.email.text).toMatch(
        /https:\/\/shop\.example\/order-confirmation\/.+\?token=[A-Za-z0-9_-]{43}/,
      );
    }
  });
});

// --- M35's check 1 in full: a five-unit flash sale and twenty shoppers -----------------------------

describe('a five-unit flash sale and twenty shoppers (D-548, M35 check 1)', () => {
  let saleId = '';

  beforeAll(async () => {
    const created = await marketing.client.request('POST', '/v1/promo/flash-sales', {
      body: {
        title: `Flash ${suffix}`,
        enabled: true,
        items: [
          { skuId: sku(2), salePricePoisha: '100000', unitLimit: 5 },
          { skuId: hiddenSku, salePricePoisha: '90000', unitLimit: 5 },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    saleId = (JSON.parse(created.body) as { id: string }).id;
  });

  it('shows only the SKUs the website sells, prices as strings', async () => {
    const list = await signed<{
      items: { id: string; items: { skuId: string; price: Money | null }[] }[];
    }>('GET', '/storefront/v1/flash-sales');
    expect(list.status, list.raw).toBe(200);
    const sale = list.body.items.find((entry) => entry.id === saleId);
    expect(sale?.items.map((item) => item.skuId)).toEqual([sku(2)]);
    expect(sale?.items[0]?.price).toEqual({ poisha: '100000', taka: '1000.00' });
    expect(list.raw).not.toContain(hiddenSku);
  });

  it('sells five at the sale price, refuses the rest as repriced, and a cancel gives one back', async () => {
    const priced = await quote([{ skuId: sku(2), qty: 1 }]);
    expect(priced.body.quote.lines[0]?.unitPrice.poisha).toBe('100000');
    expect(priced.body.quote.lines[0]?.flashSale).toBe(true);
    const total = priced.body.quote.total.poisha;
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        checkout([{ skuId: sku(2), qty: 1 }], total, {
          expectedLines: [{ skuId: sku(2), unitPricePoisha: '100000' }],
        }),
      ),
    );
    const placed = results.filter((result) => result.status === 201);
    const refused = results.filter((result) => result.status !== 201);
    expect(placed, results.map((result) => result.raw).join('\n')).toHaveLength(5);
    expect(
      refused.every((result) => result.status === 409 && result.body.code === 'CART_REPRICED'),
    ).toBe(true);
    // The repriced answer quotes the shelf price now the allocation is gone.
    expect(refused[0]?.body.quote?.lines[0]?.unitPrice.poisha).toBe('150000');

    const sold = await one<{ sold: number }>(sql`
      select units_sold as sold from promo.flash_sale_items where org_id = ${ORG_A} and flash_sale_id = ${saleId}
      and sku_id = ${sku(2)}
    `);
    expect(sold?.sold).toBe(5);
    const level = await stockAt(ORG_A, sku(2), warehouse);
    expect(level.reserved).toBe(5);
    expect(level.onHand - level.reserved).toBeGreaterThanOrEqual(0);

    // N4: no line is charged the sale price without a claim row behind it.
    const unclaimed = await one<{ n: number }>(sql`
      select count(*)::int as n from sales.order_lines l
      where l.org_id = ${ORG_A} and l.sku_id = ${sku(2)} and l.unit_price_poisha = 100000
        and not exists (select 1 from promo.flash_claims c where c.org_id = l.org_id and c.order_line_id = l.id)
    `);
    expect(unclaimed?.n).toBe(0);

    // A shopper who accepts the shelf price gets it.
    const shelf = await checkout([{ skuId: sku(2), qty: 1 }], (150_000n + fee).toString());
    expect(shelf.status, shelf.raw).toBe(201);

    // A cancel gives the unit back to the sale and the shelf.
    const first = placed[0]?.body.order.orderNo ?? '';
    const cancelled = await admin.client.request(
      'POST',
      `/v1/orders/${await orderIdOf(first)}/cancel`,
      {
        body: { reason: 'Cancelled by the shopper.' },
      },
    );
    expect(cancelled.statusCode, cancelled.body).toBe(201);
    const back = await one<{ sold: number }>(sql`
      select units_sold as sold from promo.flash_sale_items where org_id = ${ORG_A} and flash_sale_id = ${saleId}
      and sku_id = ${sku(2)}
    `);
    expect(back?.sold).toBe(4);
    expect((await stockAt(ORG_A, sku(2), warehouse)).reserved).toBe(5);
  });

  it('N5: refuses a claim, under one brand, against another brand’s order line', async () => {
    const customer = await seedCustomer(ORG_B, {
      phoneE164: '+8801711900111',
      name: 'Other brand',
    });
    const other = await seedProductWithSkus(ORG_B, `sfoth${suffix}`, 1);
    const otherOrder = await seedOrder(ORG_B, {
      status: 'pending',
      customerId: customer,
      lines: [
        {
          skuId: other.skus[0]?.id ?? '',
          skuCode: other.skus[0]?.code ?? '',
          productName: 'Other product',
          qty: 1,
          unitPricePoisha: 100_000n,
        },
      ],
    });
    const otherLine = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ id: string }>(sql`
            select id from sales.order_lines where org_id = ${ORG_B} and order_id = ${otherOrder.id}
          `)
        )[0]?.id ?? '',
      { orgId: ORG_B },
    );
    const item = await one<{ id: string }>(sql`
      select id from promo.flash_sale_items where org_id = ${ORG_A} and flash_sale_id = ${saleId} and sku_id = ${sku(2)}
    `);
    const promo = harness.app.get<PromoApi>(PROMO_API, { strict: false });
    await expect(
      withOrg({ orgId: ORG_A, userId: 'usr_test' }, (tx) =>
        promo.claimFlashUnits(tx, ORG_A, {
          orderId: otherOrder.id,
          lines: [
            {
              orderLineId: otherLine,
              skuId: other.skus[0]?.id ?? '',
              qty: 1,
              flashSaleItemId: item?.id ?? '',
              salePricePoisha: 100_000n,
            },
          ],
        }),
      ),
    ).rejects.toThrow();
  });
});

// --- the old site's customers (D-531) ---------------------------------------------------------

describe('importing the old website’s customers (D-531)', () => {
  it('dry-runs, commits once, keeps the old passwords working, and links Google by email', async () => {
    const { hash } = await import('bcryptjs');
    const { LegacyCustomersImporter } = await import('./legacy-customers.js');
    const { ORDERS_API } = await import('../orders/orders.api.js');
    const importer = new LegacyCustomersImporter(harness.app.get(ORDERS_API, { strict: false }));
    const oldHash = (await hash('old-site-password', 4)).replace(/^\$2b\$/, '$2a$');
    const file = JSON.stringify([
      {
        _id: { $oid: `a${suffix}` },
        name: 'Old Shopper',
        email: `old-${suffix}@example.com`,
        password: oldHash,
        role: 'customer',
        emailVerified: true,
        phone: '01811000123',
        createdAt: { $date: '2025-01-02T03:04:05Z' },
      },
      {
        _id: { $oid: `b${suffix}` },
        name: 'Old Google',
        email: `oldg-${suffix}@example.com`,
        role: 'customer',
        emailVerified: true,
      },
      {
        _id: { $oid: `c${suffix}` },
        name: 'Old Admin',
        email: `olda-${suffix}@example.com`,
        password: oldHash,
        role: 'admin',
      },
      { _id: { $oid: `d${suffix}` }, name: 'Guest', isGuest: true, phone: '01811000456' },
    ]);

    const dry = await importer.dryRun(ORG_A, file);
    expect(dry.written).toBeNull();
    expect(dry.plan.counts).toMatchObject({ accounts: 2, buyers: 2, staff: 1, guests: 1 });
    expect(
      await one<{ n: number }>(sql`
        select count(*)::int as n from storefront.customer_accounts where org_id = ${ORG_A}
          and email = ${`old-${suffix}@example.com`}
      `),
    ).toEqual({ n: 0 });

    const committed = await importer.commit(ORG_A, file);
    expect(committed.written).toEqual({ accounts: 2, buyers: 2 });
    const again = await importer.commit(ORG_A, file);
    expect(again.written).toEqual({ accounts: 0, buyers: 0 });
    expect(again.plan.counts.alreadyImported).toBe(2);

    const account = await one<{
      password_hash: string;
      source: string;
      customer: string | null;
      verified: boolean;
    }>(sql`
      select password_hash, source, customer_id as customer, email_verified_at is not null as verified
      from storefront.customer_accounts where org_id = ${ORG_A} and email = ${`old-${suffix}@example.com`}
    `);
    expect(account).toMatchObject({
      password_hash: oldHash,
      source: 'legacy_import',
      verified: true,
    });
    expect(account?.customer).not.toBeNull();
    const mapped = await one<{ n: number }>(sql`
      select count(*)::int as n from storefront.legacy_ids where org_id = ${ORG_A} and kind = 'customer'
        and legacy_id in (${`a${suffix}`}, ${`b${suffix}`}, ${`d${suffix}`})
    `);
    expect(mapped?.n).toBe(3);
    const staff = await one<{ n: number }>(sql`
      select count(*)::int as n from storefront.customer_accounts where org_id = ${ORG_A}
        and email = ${`olda-${suffix}@example.com`}
    `);
    expect(staff?.n).toBe(0);

    const signIn = await signed('POST', '/storefront/v1/accounts/sign-in', {
      email: `old-${suffix}@example.com`,
      password: 'old-site-password',
    });
    expect(signIn.status, signIn.raw).toBe(200);
    const google = await signed<{ created: boolean; account: { googleLinked: boolean } }>(
      'POST',
      '/storefront/v1/accounts/google',
      { email: `oldg-${suffix}@example.com`, emailVerified: true, googleSub: `oldsub-${suffix}` },
    );
    expect(google.status, google.raw).toBe(200);
    expect(google.body).toMatchObject({ created: false, account: { googleLinked: true } });
  });
});

// --- the signed writes (D-506, M34) -------------------------------------------------------------

describe('a signed write', () => {
  it('is refused when the body or the idempotency key is not the one signed', async () => {
    const body = { lines: [{ skuId: sku(0), qty: 1 }] };
    const raw = Buffer.from(JSON.stringify(body));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signStorefront(key.secret, {
      timestamp,
      method: 'POST',
      pathAndQuery: '/storefront/v1/cart/quote',
      idempotencyKey: 'key-one-12345',
      rawBody: raw,
    });
    const send = (payload: Buffer, idempotencyKey: string) =>
      harness.server.inject({
        method: 'POST',
        url: '/storefront/v1/cart/quote',
        headers: {
          'x-api-key': key.keyId,
          'x-api-timestamp': timestamp,
          'x-api-signature': signature,
          'idempotency-key': idempotencyKey,
          'content-type': 'application/json',
        },
        payload,
      });
    expect((await send(raw, 'key-one-12345')).statusCode).toBe(200);
    const tampered = Buffer.from(JSON.stringify({ lines: [{ skuId: sku(0), qty: 9 }] }));
    expect((await send(tampered, 'key-one-12345')).statusCode).toBe(401);
    expect((await send(raw, 'key-two-12345')).statusCode).toBe(401);
    const unsigned = await harness.server.inject({
      method: 'POST',
      url: '/storefront/v1/accounts/sign-in',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.co', password: 'x' }),
    });
    expect(unsigned.statusCode).toBe(401);
  });
});
