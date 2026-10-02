import { createHash, randomUUID } from 'node:crypto';

import { withOrg, withSystem } from '@elysium/db';
import { poisha } from '@elysium/domain';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ALL_QUEUES } from '../../job-queues.js';
import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { attachScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { ORG_A, ORG_B, startHttpHarness, type HttpHarness } from '../../testing/http-harness.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import {
  seedProductWithSkus,
  warehouseId,
  type SeededSku,
} from '../inventory/inventory.testing.js';
import { OrdersService } from '../orders/orders.service.js';
import { ownRiderCourier, seedCustomer } from '../orders/orders.testing.js';
import { mapPromoErrors } from '../promo/promo.errors.js';
import { PromoService } from '../promo/promo.service.js';
import { MarketingService } from './marketing.service.js';
import { MetaJobsService } from './meta-jobs.service.js';
import { FakeMetaGateway, META_GATEWAY, MetaApiError } from './providers/meta-gateway.js';

/**
 * The marketing module against real Postgres (M18, architecture §11).
 *
 * - **Check 1** — the dashboard reproduces hand-computed CPO, CPDO, ROAS, placed ROAS and
 *   return rate from real orders and real spend rows (the domain's fixture dataset is
 *   `packages/domain/src/marketing/metrics.test.ts`).
 * - **Check 2** — the Meta spend import, run twice and over overlapping ranges, holds one
 *   figure per (campaign, day), and never replaces a figure a person entered.
 * - **Check 3** — a delivered order queues one Purchase, sent once, hashes only, with the
 *   order id as `event_id` (the payload snapshot is `capi.payload.test.ts`).
 * - **Check 4** — each order lands on the campaign §11's priority order says, through the
 *   real order source, promo code and ref rows.
 *
 * Every date in the dashboard fixture is a fixed instant at noon Dhaka (06:00Z), so the
 * test does not depend on the day it runs. Phones are test values, not anybody's.
 */

const ACTOR = 'usr_marketing_db';
const SEPTEMBER = { from: '2026-09-01', to: '2026-09-30' };

let harness: HttpHarness;
let jobs: JobsRuntime;
let marketing: MarketingService;
let meta: MetaJobsService;
let gateway: FakeMetaGateway;

function context(orgId = ORG_A): ActiveContext {
  return {
    orgId,
    userId: ACTOR,
    isSuperAdmin: false,
    roles: ['org_admin'],
    branchIds: [],
    branchIdsByRole: {},
    requestId: randomUUID(),
  } as unknown as ActiveContext;
}

function request(): AuditableRequest {
  const value = {} as AuditableRequest;
  attachScope(value, 'update', 'Order', { kind: 'all' });
  return value;
}

beforeAll(async () => {
  harness = await startHttpHarness('marketing-db');
  // The delivery hook enqueues in the delivering transaction, so a runtime must exist. It
  // attaches no handler, so nothing runs behind the test's back: every send and import
  // below is called explicitly.
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues: ALL_QUEUES,
    logger: pino({ level: 'silent' }),
  });
  marketing = harness.app.get(MarketingService);
  meta = harness.app.get(MetaJobsService);
  const bound: unknown = harness.app.get(META_GATEWAY, { strict: false });
  if (!(bound instanceof FakeMetaGateway)) throw new Error('the suite expects the fake gateway');
  gateway = bound;
}, 600_000);

afterAll(async () => {
  await jobs?.stop();
  await harness?.close();
}, 120_000);

beforeEach(() => {
  gateway.clear();
});

// --- fixtures -------------------------------------------------------------------------

let orderSeq = 0;

interface FactLine {
  readonly sku: SeededSku;
  readonly qty: number;
  readonly unitPoisha: bigint;
  readonly lineDiscountPoisha?: bigint;
  readonly delivered?: number;
  readonly returned?: number;
}

interface FactOrder {
  readonly orgId?: string;
  readonly customerId: string;
  readonly status: 'confirmed' | 'delivered' | 'partially_delivered' | 'returned';
  readonly source?: Record<string, string>;
  readonly promoCodeId?: string;
  readonly confirmedAt?: string;
  readonly deliveredAt?: string;
  readonly returnedAt?: string;
  readonly orderDiscountPoisha?: bigint;
  readonly lines: readonly FactLine[];
}

/**
 * An order at its final status with the timestamps a dashboard reads, written directly.
 *
 * Inserting at a status is legal (0041's trigger guards `UPDATE OF status`), and it is
 * what makes the dates exact: a real transition stamps `now()`. Check 3 below drives the
 * real transitions instead, because there the hook is what is under test.
 */
async function factOrder(input: FactOrder): Promise<string> {
  orderSeq += 1;
  const orgId = input.orgId ?? ORG_A;
  const items = input.lines.reduce((sum, line) => sum + line.unitPoisha * BigInt(line.qty), 0n);
  const discount =
    input.lines.reduce((sum, line) => sum + (line.lineDiscountPoisha ?? 0n), 0n) +
    (input.orderDiscountPoisha ?? 0n);
  const delivery = 6_000n;
  const cod = items - discount + delivery;
  return withSystem(
    async (tx) => {
      const area = await tx.execute<{ district_id: number; thana_id: number }>(sql`
        select t.district_id, t.id as thana_id from ref.thanas t order by t.id limit 1
      `);
      const rows = await tx.execute<{ id: string }>(sql`
        insert into sales.orders (
          org_id, order_no, channel, source, customer_id, ship_name, ship_phone_e164,
          ship_district_id, ship_thana_id, ship_address_line, items_poisha, discount_poisha,
          delivery_charge_poisha, advance_paid_poisha, cod_amount_poisha, status,
          promo_code_id, confirmed_at, delivered_at, returned_at, created_by)
        values (
          ${orgId}, ${`MKT-2609-${String(orderSeq).padStart(5, '0')}`}, 'facebook',
          ${JSON.stringify(input.source ?? {})}::jsonb, ${input.customerId}, 'Marketing Buyer',
          '+8801711000555', ${area[0]?.district_id ?? 1}, ${area[0]?.thana_id ?? 1},
          'House 1, Road 1, Dhaka', ${items}, ${discount}, ${delivery}, 0, ${cod},
          ${input.status}::sales.order_status, ${input.promoCodeId ?? null}::uuid,
          ${input.confirmedAt ?? null}::timestamptz, ${input.deliveredAt ?? null}::timestamptz,
          ${input.returnedAt ?? null}::timestamptz, ${ACTOR})
        returning id
      `);
      const id = rows[0]?.id ?? '';
      for (const [position, line] of input.lines.entries()) {
        await tx.execute(sql`
          insert into sales.order_lines
            (org_id, order_id, sku_id, sku_code, product_name, qty, unit_price_poisha,
             discount_poisha, delivered_qty, returned_qty, position)
          values (${orgId}, ${id}, ${line.sku.id}, ${line.sku.code}, 'Fixture product',
                  ${line.qty}, ${line.unitPoisha}, ${line.lineDiscountPoisha ?? 0n},
                  ${line.delivered ?? 0}, ${line.returned ?? 0}, ${position})
        `);
      }
      return id;
    },
    { orgId },
  );
}

const noon = (date: string) => `${date}T06:00:00.000Z`;

/** A database refusal's message: drizzle wraps the trigger's in `cause`. */
async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    const messages: string[] = [];
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
      messages.push(current.message);
    }
    return messages.join(' | ');
  }
  return 'not refused';
}

async function campaign(name: string, refs: { kind: string; value: string }[]) {
  const created = await marketing.createCampaign(context(), request(), {
    name,
    platform: 'meta',
    refs: refs as never,
  });
  return created.id;
}

async function spend(campaignId: string, spendDate: string, amountPoisha: string) {
  await marketing.upsertSpend(context(), request(), { campaignId, spendDate, amountPoisha });
}

async function spendRows(orgId: string, from: string, to: string) {
  return withSystem(
    async (tx) =>
      tx.execute<{ campaign_id: string; spend_date: string; amount: string; source: string }>(sql`
        select campaign_id, spend_date::text as spend_date, amount_poisha::text as amount, source
        from marketing.ad_spend
        where org_id = ${orgId} and spend_date between ${from}::date and ${to}::date
        order by spend_date, campaign_id
      `),
    { orgId },
  );
}

async function connect(settings: { capiEnabled?: boolean; spendImportEnabled?: boolean }) {
  await marketing.saveConnection(context(), request(), {
    // The edge schema strips `act_`; the service takes the digits.
    adAccountId: '1234567890',
    pixelId: '5550001',
    token: 'EAAB-test-system-user-token-not-real-0001',
    ...settings,
  });
}

// --- checks 1 and 4: the dashboard on real orders ---------------------------------------

describe('the dashboard on real orders (checks 1 and 4)', () => {
  /*
   * Two campaigns, eight orders and their spend, computed by hand in poisha.
   *
   *   Eid  (meta campaign 1202, meta ad 9001, utm eid-sale)   spend 500,000 + 300,000
   *   Puja (utm puja; promo code PUJA10 belongs to it)        spend 200,000
   *   (an Eid figure on 31 August is outside September and must not count)
   *
   *   O1 explicit Eid id (+ utm puja, ignored)   conf 09-10 deliv 09-12   2×150,000      → Eid
   *   O2 ad 9001 (+ utm puja, ignored)           conf 09-11 deliv 09-13   200,000 −20,000 → Eid
   *   O3 utm " EID-SALE " (trimmed, any case)    conf 09-12 ret 09-20     100,000        → Eid
   *   O4 code PUJA10 (+ utm eid-sale, ignored)   conf 09-14 deliv 09-16   120,000 −12,000 → Puja
   *   O5 explicit Meta id 1202                   conf 08-28 deliv 09-02   50,000         → Eid
   *   O6 nothing                                 conf 09-15 deliv 09-17   80,000         → none
   *   O7 a stale explicit id, then ad 9001       conf 09-18 (open)        70,000         → Eid
   *   O8 utm puja, 1 of 2 delivered              conf 09-20 deliv 09-22   2×100,000      → Puja
   *
   *   Eid:  confirmed O1 O2 O3 O7 = 4; delivered O1 O2 O5 = 3, revenue 300,000 + 180,000
   *         + 50,000 = 530,000; returned 1; placed 300,000 + 180,000 + 100,000 + 70,000
   *         = 650,000; spend 800,000.
   *         CPO 200,000 · CPDO 266,666.67 → 266,667 · ROAS 6,625 bps · placed 8,125 bps
   *         · return rate 1/4 = 2,500 bps
   *   Puja: confirmed 2; delivered 2, revenue 108,000 + 100,000 = 208,000; placed 308,000;
   *         spend 200,000. CPO 100,000 · CPDO 100,000 · ROAS 10,400 · placed 15,400 · 0
   *   none: confirmed 1, delivered 1, revenue 80,000; no spend: CPO and CPDO 0, no ROAS.
   *   All:  spend 1,000,000; confirmed 7; delivered 6; revenue 818,000; placed 1,038,000;
   *         returned 1. CPO 142,857.14 → 142,857 · CPDO 166,666.67 → 166,667
   *         · ROAS 8,180 · placed 10,380 · return rate 1/7 = 1,428.57 → 1,429
   */
  let eid = '';
  let puja = '';
  const orders: Record<string, string> = {};

  beforeAll(async () => {
    const { skus } = await seedProductWithSkus(ORG_A, 'mktdash', 1);
    const sku = skus[0]!;
    const buyer = await seedCustomer(ORG_A, { phoneE164: '+8801711000555', name: 'Dash Buyer' });

    eid = await campaign('Eid', [
      { kind: 'meta_campaign', value: '1202' },
      { kind: 'meta_ad', value: '9001' },
      { kind: 'utm_campaign', value: 'Eid-Sale' },
    ]);
    puja = await campaign('Puja', [{ kind: 'utm_campaign', value: 'puja' }]);
    const code = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ id: string }>(sql`
            insert into promo.codes (org_id, code, kind, value_bps, campaign_id, created_by)
            values (${ORG_A}, 'PUJA10', 'percent', 1000, ${puja}, ${ACTOR})
            returning id
          `)
        )[0]?.id ?? '',
      { orgId: ORG_A },
    );

    await spend(eid, '2026-08-31', '999999');
    await spend(eid, '2026-09-10', '500000');
    await spend(eid, '2026-09-11', '300000');
    await spend(puja, '2026-09-14', '200000');

    const one = (qty: number, unit: bigint, extra: Partial<FactLine> = {}) => [
      { sku, qty, unitPoisha: unit, delivered: 0, ...extra },
    ];
    orders.o1 = await factOrder({
      customerId: buyer,
      status: 'delivered',
      source: { campaignId: eid, utmCampaign: 'puja' },
      confirmedAt: noon('2026-09-10'),
      deliveredAt: noon('2026-09-12'),
      lines: one(2, 150_000n, { delivered: 2 }),
    });
    orders.o2 = await factOrder({
      customerId: buyer,
      status: 'delivered',
      source: { adId: '9001', utmCampaign: 'puja' },
      confirmedAt: noon('2026-09-11'),
      deliveredAt: noon('2026-09-13'),
      lines: one(1, 200_000n, { lineDiscountPoisha: 20_000n, delivered: 1 }),
    });
    orders.o3 = await factOrder({
      customerId: buyer,
      status: 'returned',
      source: { utmCampaign: ' EID-SALE ' },
      confirmedAt: noon('2026-09-12'),
      returnedAt: noon('2026-09-20'),
      lines: one(1, 100_000n, { returned: 1 }),
    });
    orders.o4 = await factOrder({
      customerId: buyer,
      status: 'delivered',
      source: { utmCampaign: 'eid-sale' },
      promoCodeId: code,
      confirmedAt: noon('2026-09-14'),
      deliveredAt: noon('2026-09-16'),
      orderDiscountPoisha: 12_000n,
      lines: one(1, 120_000n, { delivered: 1 }),
    });
    orders.o5 = await factOrder({
      customerId: buyer,
      status: 'delivered',
      source: { campaignId: '1202' },
      confirmedAt: noon('2026-08-28'),
      deliveredAt: noon('2026-09-02'),
      lines: one(1, 50_000n, { delivered: 1 }),
    });
    orders.o6 = await factOrder({
      customerId: buyer,
      status: 'delivered',
      confirmedAt: noon('2026-09-15'),
      deliveredAt: noon('2026-09-17'),
      lines: one(1, 80_000n, { delivered: 1 }),
    });
    orders.o7 = await factOrder({
      customerId: buyer,
      status: 'confirmed',
      source: { campaignId: randomUUID(), adId: '9001' },
      confirmedAt: noon('2026-09-18'),
      lines: one(1, 70_000n),
    });
    orders.o8 = await factOrder({
      customerId: buyer,
      status: 'partially_delivered',
      source: { utmCampaign: 'puja' },
      confirmedAt: noon('2026-09-20'),
      deliveredAt: noon('2026-09-22'),
      lines: one(2, 100_000n, { delivered: 1, returned: 1 }),
    });

    // Another brand's order carrying the same UTM, delivered the same month: invisible.
    const otherSku = (await seedProductWithSkus(ORG_B, 'mktother', 1)).skus[0]!;
    const otherBuyer = await seedCustomer(ORG_B, {
      phoneE164: '+8801711000556',
      name: 'Other Brand Buyer',
    });
    await factOrder({
      orgId: ORG_B,
      customerId: otherBuyer,
      status: 'delivered',
      source: { utmCampaign: 'eid-sale' },
      confirmedAt: noon('2026-09-10'),
      deliveredAt: noon('2026-09-12'),
      lines: [{ sku: otherSku, qty: 1, unitPoisha: 999_000n, delivered: 1 }],
    });
  }, 120_000);

  it('reproduces the hand-computed figures per campaign, unattributed and in total', async () => {
    const board = await marketing.dashboard(context(), SEPTEMBER);
    const byName = new Map(board.campaigns.map((row) => [row.name, row.metrics]));

    expect(byName.get('Eid')).toEqual({
      spendPoisha: '800000',
      confirmedOrders: 4,
      deliveredOrders: 3,
      returnedOrders: 1,
      deliveredRevenuePoisha: '530000',
      placedRevenuePoisha: '650000',
      cpoPoisha: '200000',
      cpdoPoisha: '266667',
      roasBps: '6625',
      placedRoasBps: '8125',
      returnRateBps: '2500',
    });
    expect(byName.get('Puja')).toEqual({
      spendPoisha: '200000',
      confirmedOrders: 2,
      deliveredOrders: 2,
      returnedOrders: 0,
      deliveredRevenuePoisha: '208000',
      placedRevenuePoisha: '308000',
      cpoPoisha: '100000',
      cpdoPoisha: '100000',
      roasBps: '10400',
      placedRoasBps: '15400',
      returnRateBps: '0',
    });
    expect(board.unattributed).toEqual({
      spendPoisha: '0',
      confirmedOrders: 1,
      deliveredOrders: 1,
      returnedOrders: 0,
      deliveredRevenuePoisha: '80000',
      placedRevenuePoisha: '80000',
      // No spend over one order is a cost of zero, not an unknown one; only a zero
      // denominator is null (D-255).
      cpoPoisha: '0',
      cpdoPoisha: '0',
      roasBps: null,
      placedRoasBps: null,
      returnRateBps: '0',
    });
    expect(board.total).toEqual({
      spendPoisha: '1000000',
      confirmedOrders: 7,
      deliveredOrders: 6,
      returnedOrders: 1,
      deliveredRevenuePoisha: '818000',
      placedRevenuePoisha: '1038000',
      cpoPoisha: '142857',
      cpdoPoisha: '166667',
      roasBps: '8180',
      placedRoasBps: '10380',
      returnRateBps: '1429',
    });
  });

  it('attributes each order by §11’s priority: explicit, ad referral, utm, none (check 4)', async () => {
    const board = await marketing.dashboard(context(), SEPTEMBER);
    // O1, O4 (promo code) and O5 (Meta campaign id) explicit; O2 and O7 by the ad; O3 and
    // O8 by the UTM; O6 by nothing.
    expect(board.attribution).toEqual({ explicit: 3, ad_referral: 2, utm: 2, none: 1 });
  });

  it('draws one point a day, summing to the period’s spend and delivered revenue', async () => {
    const board = await marketing.dashboard(context(), SEPTEMBER);
    expect(board.series).toHaveLength(30);
    const sum = (key: 'spendPoisha' | 'deliveredRevenuePoisha') =>
      board.series.reduce((total, point) => total + BigInt(point[key]), 0n);
    expect(sum('spendPoisha')).toBe(1_000_000n);
    expect(sum('deliveredRevenuePoisha')).toBe(818_000n);
    expect(board.series.find((point) => point.date === '2026-09-12')).toEqual({
      date: '2026-09-12',
      spendPoisha: '0',
      deliveredRevenuePoisha: '300000',
    });
  });

  it('moves an order when a mapping changes, because attribution is read, not stored', async () => {
    // Remove Puja's UTM: O8 falls through to nothing; O4 still has its promo code.
    const before = await marketing.listCampaigns(context(), undefined);
    const ref = before.items
      .find((row) => row.id === puja)
      ?.refs.find((item) => item.kind === 'utm_campaign');
    await marketing.removeRef(context(), request(), puja, ref?.id ?? '');
    const board = await marketing.dashboard(context(), SEPTEMBER);
    expect(board.attribution).toEqual({ explicit: 3, ad_referral: 2, utm: 1, none: 2 });
    await marketing.addRef(context(), request(), puja, { kind: 'utm_campaign', value: 'puja' });
  });

  it('refuses a ref another campaign already holds', async () => {
    await expect(
      marketing.addRef(context(), request(), puja, { kind: 'meta_ad', value: '9001' }),
    ).rejects.toMatchObject({ code: 'MARKETING_REF_TAKEN' });
  });
});

// --- check 2: the spend import ---------------------------------------------------------

describe('the Meta spend import is idempotent per (campaign, day) (check 2)', () => {
  const row = (campaignId: string, name: string, day: string, adId: string, value: string) => ({
    campaignId,
    campaignName: name,
    adId,
    accountCurrency: 'BDT',
    dateStart: day,
    dateStop: day,
    spend: value,
  });

  let known = '';

  beforeAll(async () => {
    await connect({ spendImportEnabled: true });
    known = await campaign('Always on', [{ kind: 'meta_campaign', value: '3303' }]);
    // A person's figure for a day Meta also reports: it stays (D-252).
    await spend(known, '2026-08-06', '99900');
  });

  it('writes one figure per campaign per day, creates an unknown campaign once, and keeps a person’s figure', async () => {
    gateway.setInsights([
      row('3303', 'Always on', '2026-08-05', 'ad-1', '1000.50'),
      row('3303', 'Always on', '2026-08-05', 'ad-2', '500'),
      row('3303', 'Always on', '2026-08-06', 'ad-1', '400'),
      row('7777', 'Retargeting', '2026-08-05', 'ad-7', '200'),
      row('7777', 'Retargeting', '2026-08-06', 'ad-7', '300.25'),
    ]);

    const first = await meta.importSpend(ORG_A, { from: '2026-08-05', to: '2026-08-06' });
    expect(first).toMatchObject({ status: 'ok', written: 3, keptManual: 1, campaignsCreated: 1 });

    const second = await meta.importSpend(ORG_A, { from: '2026-08-05', to: '2026-08-06' });
    expect(second).toMatchObject({ status: 'ok', written: 3, keptManual: 1, campaignsCreated: 0 });

    const campaigns = await marketing.listCampaigns(context(), undefined);
    const retargeting = campaigns.items.filter((item) => item.name === 'Retargeting');
    expect(retargeting).toHaveLength(1);
    expect(retargeting[0]?.origin).toBe('meta_import');
    expect(retargeting[0]?.refs.map((ref) => `${ref.kind}:${ref.value}`).sort()).toEqual([
      'meta_ad:ad-7',
      'meta_campaign:7777',
    ]);
    const id = retargeting[0]?.id ?? '';

    expect(
      (await spendRows(ORG_A, '2026-08-05', '2026-08-06')).map((item) => ({
        ...item,
        campaign_id: item.campaign_id === known ? 'known' : item.campaign_id === id ? 'new' : '?',
      })),
    ).toEqual(
      expect.arrayContaining([
        { campaign_id: 'known', spend_date: '2026-08-05', amount: '150050', source: 'meta' },
        { campaign_id: 'known', spend_date: '2026-08-06', amount: '99900', source: 'manual' },
        { campaign_id: 'new', spend_date: '2026-08-05', amount: '20000', source: 'meta' },
        { campaign_id: 'new', spend_date: '2026-08-06', amount: '30025', source: 'meta' },
      ]),
    );
    expect(await spendRows(ORG_A, '2026-08-05', '2026-08-06')).toHaveLength(4);
  });

  it('replaces, never adds, when an overlapping range brings a revised figure', async () => {
    gateway.setInsights([
      row('7777', 'Retargeting', '2026-08-06', 'ad-7', '310'),
      row('7777', 'Retargeting', '2026-08-07', 'ad-7', '50'),
    ]);
    const result = await meta.importSpend(ORG_A, { from: '2026-08-06', to: '2026-08-07' });
    expect(result).toMatchObject({ status: 'ok', written: 2, keptManual: 0 });

    const rows = await spendRows(ORG_A, '2026-08-05', '2026-08-07');
    expect(rows).toHaveLength(5);
    const total = rows.reduce((sum, item) => sum + BigInt(item.amount), 0n);
    // 150,050 + 99,900 + 20,000 + 31,000 (was 30,025) + 5,000
    expect(total).toBe(305_950n);
  });

  it('lets a person correct an imported figure, and the next import leaves it alone', async () => {
    const [imported] = await spendRows(ORG_A, '2026-08-07', '2026-08-07');
    await spend(imported?.campaign_id ?? '', '2026-08-07', '4500');
    await meta.importSpend(ORG_A, { from: '2026-08-07', to: '2026-08-07' });
    expect(await spendRows(ORG_A, '2026-08-07', '2026-08-07')).toEqual([
      expect.objectContaining({ amount: '4500', source: 'manual' }),
    ]);
  });

  it('records a refused import without touching the figures', async () => {
    gateway.setInsights([
      { ...row('7777', 'Retargeting', '2026-08-05', 'ad-7', '1'), accountCurrency: 'USD' },
    ]);
    const before = await spendRows(ORG_A, '2026-08-05', '2026-08-07');
    const result = await meta.importSpend(ORG_A, { from: '2026-08-05', to: '2026-08-05' });
    expect(result.status).toBe('failed');
    expect(await spendRows(ORG_A, '2026-08-05', '2026-08-07')).toEqual(before);
    expect((await marketing.getConnection(context())).lastImportStatus).toBe('failed');
  });

  it('refuses, in the database, an import overwriting a person’s figure or moving a day', async () => {
    expect(
      await refusal(
        withSystem(
          (tx) =>
            tx.execute(sql`
              update marketing.ad_spend set source = 'meta'
              where org_id = ${ORG_A} and source = 'manual'
            `),
          { orgId: ORG_A },
        ),
      ),
    ).toMatch(/MARKETING_SPEND_IMMUTABLE/);
    expect(
      await refusal(
        withSystem(
          (tx) =>
            tx.execute(sql`
              update marketing.ad_spend set spend_date = spend_date + 1 where org_id = ${ORG_A}
            `),
          { orgId: ORG_A },
        ),
      ),
    ).toMatch(/MARKETING_SPEND_IMMUTABLE/);
  });
});

// --- check 3: the Conversions API sender ------------------------------------------------

describe('a delivered order’s Purchase is queued in the delivery and sent once (check 3)', () => {
  const PHONE = '+8801712345678';
  let orderId = '';

  async function capiRows(id: string) {
    return withSystem(
      async (tx) =>
        tx.execute<{ id: string; status: string; event_id: string; payload: unknown }>(sql`
          select id, status, event_id, payload from marketing.capi_events
          where org_id = ${ORG_A} and order_id = ${id}
        `),
      { orgId: ORG_A },
    );
  }

  beforeAll(async () => {
    await connect({ capiEnabled: true });
    const orders = harness.app.get(OrdersService);
    const inventory = harness.app.get<InventoryApi>(INVENTORY_API);
    const sku = (await seedProductWithSkus(ORG_A, 'mktcapi', 1)).skus[0]!;
    const location = await warehouseId(ORG_A);
    const courierId = await ownRiderCourier(ORG_A);
    const customerId = await seedCustomer(ORG_A, { phoneE164: PHONE, name: 'Afsana Rahman' });
    const actor = { orgId: ORG_A, userId: ACTOR };
    await withOrg(actor, (tx) =>
      inventory.receiveSupply(tx, actor, {
        supplyId: randomUUID(),
        supplierId: randomUUID(),
        locationId: location,
        branchId: null,
        occurredAt: new Date(),
        lines: [{ skuId: sku.id, qty: 5, unitCostPoisha: poisha(40_000n) }],
      }),
    );
    const created = await orders.create(context(), request(), {
      channel: 'facebook',
      customerId,
      locationId: location,
      courierId,
      deliveryChargePoisha: '6000',
      lines: [{ skuId: sku.id, qty: 2, unitPricePoisha: '150000' }],
    });
    orderId = created.id;
    await orders.confirm(context(), request(), orderId);
    await orders.transition(context(), request(), orderId, 'ship', { courierId });
    expect(await capiRows(orderId)).toHaveLength(0);
    await orders.transition(context(), request(), orderId, 'deliver');
  }, 120_000);

  it('writes one queued event, keyed by the order id, and its job, with the delivery', async () => {
    const rows = await capiRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'queued', event_id: orderId, payload: null });
    const queued = await withSystem(async (tx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n from pgboss.job
        where name = 'marketing.capi_delivered'
          and data->'payload'->>'eventId' = ${rows[0]?.id ?? ''}
      `),
    );
    expect(queued[0]?.n).toBe(1);
  });

  it('a second delivery signal for the same order queues nothing', async () => {
    await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      meta.orderDelivered(tx, { orgId: ORG_A, orderId }),
    );
    expect(await capiRows(orderId)).toHaveLength(1);
  });

  it('sends hashes only, with the order id as event_id, and records Meta’s answer', async () => {
    const [row] = await capiRows(orderId);
    expect(await meta.sendConversion(ORG_A, row?.id ?? '')).toBe('sent');
    expect(gateway.sent).toHaveLength(1);
    const sent = gateway.sent[0];
    expect(sent?.pixelId).toBe('5550001');
    expect(sent?.token).toBe('EAAB-test-system-user-token-not-real-0001');
    const event = sent?.events[0];
    expect(event?.event_id).toBe(orderId);
    expect(event?.custom_data).toMatchObject({ currency: 'BDT', value: 3000, order_id: orderId });
    expect(event?.user_data.ph).toEqual([
      createHash('sha256').update('8801712345678', 'utf8').digest('hex'),
    ]);

    const [stored] = await capiRows(orderId);
    expect(stored?.status).toBe('sent');
    const text = JSON.stringify(stored?.payload) + JSON.stringify(sent?.events);
    for (const plain of ['8801712345678', '01712345678', 'afsana', 'Afsana', 'rahman', 'Rahman']) {
      expect(text).not.toContain(plain);
    }
    expect(stored?.payload).toEqual(JSON.parse(JSON.stringify(event)));
  });

  it('never sends a sent event again, and the database refuses to reopen it', async () => {
    const [row] = await capiRows(orderId);
    expect(await meta.sendConversion(ORG_A, row?.id ?? '')).toBe('already_final');
    expect(gateway.sent).toHaveLength(0);
    expect(
      await refusal(
        withSystem(
          (tx) =>
            tx.execute(sql`
              update marketing.capi_events set status = 'queued'
              where org_id = ${ORG_A} and id = ${row?.id ?? ''}
            `),
          { orgId: ORG_A },
        ),
      ),
    ).toMatch(/MARKETING_CAPI_IMMUTABLE/);
  });

  it('records a transient failure, retries it, and sends once on the retry', async () => {
    const sku = (await seedProductWithSkus(ORG_A, 'mktcapi2', 1)).skus[0]!;
    const buyer = await seedCustomer(ORG_A, { phoneE164: '+8801812345678', name: 'Retry Buyer' });
    const id = await factOrder({
      customerId: buyer,
      status: 'delivered',
      confirmedAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
      lines: [{ sku, qty: 1, unitPoisha: 90_000n, delivered: 1 }],
    });
    const eventId = await withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
      await meta.orderDelivered(tx, { orgId: ORG_A, orderId: id });
      return (
        await tx.execute<{ id: string }>(sql`
          select id from marketing.capi_events where org_id = ${ORG_A} and order_id = ${id}
        `)
      )[0]?.id;
    });

    gateway.failNextSend = new MetaApiError('Meta did not answer in time.', true, null, null, null);
    await expect(meta.sendConversion(ORG_A, eventId ?? '')).rejects.toThrow(MetaApiError);
    expect((await capiRows(id))[0]?.status).toBe('failed');

    expect(await meta.sendConversion(ORG_A, eventId ?? '')).toBe('sent');
    expect(await meta.sendConversion(ORG_A, eventId ?? '')).toBe('already_final');
    expect(gateway.sent).toHaveLength(1);
  });

  it('skips an order delivered more than seven days ago, as Meta would refuse it', async () => {
    const sku = (await seedProductWithSkus(ORG_A, 'mktcapi3', 1)).skus[0]!;
    const buyer = await seedCustomer(ORG_A, { phoneE164: '+8801912345678', name: 'Old Buyer' });
    const id = await factOrder({
      customerId: buyer,
      status: 'delivered',
      confirmedAt: noon('2026-09-01'),
      deliveredAt: noon('2026-09-02'),
      lines: [{ sku, qty: 1, unitPoisha: 90_000n, delivered: 1 }],
    });
    const eventId = await withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
      await meta.orderDelivered(tx, { orgId: ORG_A, orderId: id });
      return (
        await tx.execute<{ id: string }>(sql`
          select id from marketing.capi_events where org_id = ${ORG_A} and order_id = ${id}
        `)
      )[0]?.id;
    });
    expect(await meta.sendConversion(ORG_A, eventId ?? '', new Date('2026-09-20T06:00:00Z'))).toBe(
      'skipped',
    );
    expect(gateway.sent).toHaveLength(0);
  });

  it('never returns the token, only its fingerprint', async () => {
    const view = await marketing.getConnection(context());
    expect(view.tokenConfigured).toBe(true);
    expect(view.tokenFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(view)).not.toContain('EAAB');
    const stored = await withSystem(
      async (tx) =>
        tx.execute<{ token: string }>(sql`
          select encode(token, 'escape') as token from marketing.meta_connections
          where org_id = ${ORG_A}
        `),
      { orgId: ORG_A },
    );
    expect(stored[0]?.token).not.toContain('EAAB');
  });
});

// --- leads and segments -----------------------------------------------------------------

describe('leads and their segment reports', () => {
  it('groups leads by product, size, age band and profession', async () => {
    const skus = (await seedProductWithSkus(ORG_A, 'mktlead', 2)).skus;
    const lead = (input: Record<string, unknown>) =>
      marketing.createLead(context(), request(), {
        phone: '01700000201',
        channel: 'facebook',
        ...input,
      } as never);
    await lead({ skuId: skus[0]?.id, size: 'm', ageBand: '25_34', profession: 'Teacher' });
    await lead({ skuId: skus[0]?.id, size: ' M ', ageBand: '25_34', profession: 'teacher ' });
    const converted = await lead({ skuId: skus[1]?.id, size: 'L', ageBand: '18_24' });
    await marketing.updateLead(context(), request(), converted.id, { status: 'converted' });

    const bySize = await marketing.segments(context(), { dimension: 'size' });
    expect(bySize.rows.filter((row) => row.key === 'M' || row.key === 'L')).toEqual([
      { key: 'M', label: 'M', leads: 2, converted: 0, conversionBps: '0' },
      { key: 'L', label: 'L', leads: 1, converted: 1, conversionBps: '10000' },
    ]);
    // Both SKUs are one product: three leads, one converted, under the product's name.
    const byProduct = await marketing.segments(context(), { dimension: 'product' });
    const product = byProduct.rows.find((row) => row.leads === 3);
    expect(product).toMatchObject({ converted: 1, conversionBps: '3333' });
    expect(typeof product?.label).toBe('string');
    const byProfession = await marketing.segments(context(), { dimension: 'profession' });
    expect(byProfession.rows.find((row) => row.key === 'teacher')?.leads).toBe(2);
    const byAge = await marketing.segments(context(), { dimension: 'age_band' });
    expect(byAge.rows.map((row) => row.key).slice(0, 2)).toEqual(['18_24', '25_34']);
  });

  it('refuses a SKU or a campaign from another brand', async () => {
    const foreign = (await seedProductWithSkus(ORG_B, 'mktforeign', 1)).skus[0]!;
    await expect(
      marketing.createLead(context(), request(), {
        phone: '01700000202',
        channel: 'facebook',
        skuId: foreign.id,
      }),
    ).rejects.toMatchObject({ code: 'MARKETING_INVALID' });
    const theirs = await marketing.createCampaign(context(ORG_B), request(), {
      name: 'Theirs',
      platform: 'meta',
    });
    await expect(
      marketing.createLead(context(), request(), {
        phone: '01700000203',
        channel: 'facebook',
        campaignId: theirs.id,
      }),
    ).rejects.toMatchObject({ code: 'MARKETING_CAMPAIGN_NOT_FOUND' });
  });
});

// --- promo codes name a campaign (M16 N3, D-261) ----------------------------------------

describe('a promo code names one of its own brand’s campaigns', () => {
  it('takes its own campaign, and refuses another brand’s as a 400, not a 500', async () => {
    const promo = harness.app.get(PromoService);
    const ours = await marketing.createCampaign(context(), request(), {
      name: 'Code campaign',
      platform: 'meta',
    });
    const theirs = await marketing.createCampaign(context(ORG_B), request(), {
      name: 'Their code campaign',
      platform: 'meta',
    });
    const created = await mapPromoErrors(() =>
      promo.create(context(), request(), {
        code: 'MKTOWN1',
        kind: 'percent',
        valueBps: 500,
        campaignId: ours.id,
      }),
    );
    expect(created).toMatchObject({ campaignId: ours.id });
    await expect(
      mapPromoErrors(() =>
        promo.create(context(), request(), {
          code: 'MKTTHEIRS1',
          kind: 'percent',
          valueBps: 500,
          campaignId: theirs.id,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
