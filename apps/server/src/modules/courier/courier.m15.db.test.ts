import { randomUUID } from 'node:crypto';

import { withOrg, withSystem } from '@elysium/db';
import { businessDate, poisha } from '@elysium/domain';
import type { SettlementFileRow } from '@elysium/domain/courier';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { attachScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import type { RateLimitStore } from '../../platform/http/rate-limit.js';
import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { ORG_A, startHttpHarness, type HttpHarness } from '../../testing/http-harness.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { TransitionsService } from '../orders/transitions.service.js';
import { CourierAccountsService } from './accounts.service.js';
import { COURIER_ADAPTERS, type CourierAdapterRegistry } from './adapters/courier-adapter.js';
import { FakeCourierAdapter } from './adapters/fake.adapter.js';
import { BookingService } from './booking.service.js';
import { resetCourierEnv } from './courier.config.js';
import { COURIER_QUEUE_DEFINITIONS } from './courier.queues.js';
import * as repo from './courier.repository.js';
import {
  applyCourierMigrations,
  makeBankWallet,
  makeCourier,
  seedShippedOrder,
  type SeededOrder,
} from './courier.testing.js';
import {
  COURIER_M15_ROUTE_KEYS,
  COURIER_ROUTE_FIXTURES,
  prepareCourierFixtures,
} from './courier.route-fixtures.js';
import { CourierLabelsService, renderLabelsHtml } from './labels.service.js';
import { CourierReportsService } from './reports.service.js';
import { CourierSelectionService } from './selection.service.js';
import { SettlementsService } from './settlements.service.js';
import { StuckParcelsService } from './stuck.service.js';
import { CourierSyncService } from './sync.service.js';
import { TRACKING_LIMITS, TRACKING_RATE_LIMITER } from './tracking.service.js';

/**
 * M15 against a real database (acceptance checks 2, 3, 4 and 5, and M12's gap 3).
 *
 * - **Check 2**: the zone → courier rules recommend the order's courier, fail over when a
 *   rule's courier cannot book, and are refused when they could not have been meant — and a
 *   booking never uses a courier the order does not name, because the delivery's receivable
 *   is booked against the order's courier. The pure rule table is in
 *   `packages/domain/src/courier/m15.test.ts`.
 * - **Check 3**: the public tracking page answers a wrong-digits order, a nonexistent order and
 *   an unknown brand with **byte-identical** bodies, over HTTP, and rate-limits guessing.
 * - **Check 4**: fetching the same statement again — sequentially, concurrently, before and
 *   after it posts — creates one batch and posts once.
 * - **Check 5**: seeded consignments past the staleness threshold are in the stuck-parcel
 *   queue, and fresh ones are not; an unmapped courier word lists a parcel at once.
 * - **M12 gap 3**: two identical webhooks processed *concurrently* give one event, one
 *   transition and one journal.
 *
 * The database, migrations (including M15's three, applied by `applyCourierMigrations`), the
 * ledger, the approvals module and the orders module's real port are all real, as in M12's
 * suite. The courier is the fake adapter, whose settlement API a test fills.
 */

let harness: HttpHarness;
let jobs: JobsRuntime;
let approvals: ApprovalsService;
let fake: FakeCourierAdapter;

let accounts: CourierAccountsService;
let booking: BookingService;
let sync: CourierSyncService;
let settlements: SettlementsService;
let reports: CourierReportsService;
let selection: CourierSelectionService;
let stuck: StuckParcelsService;
let labels: CourierLabelsService;

let courierA = '';
let courierB = '';
let courierC = '';
let accountA = '';
let accountB = '';
let walletId = '';
let zoneInside = '';
let zoneOutside = '';

const WEBHOOK_SECRET = 'a-webhook-secret-of-sufficient-length';
const ACTOR = 'usr_courier_m15';
const CHECKER = 'usr_courier_m15_checker';
const BRAND = 'elysium-lifestyle-bd';

function context(orgId = ORG_A, userId = ACTOR): ActiveContext {
  return {
    userId,
    orgId,
    roles: ['org_admin', 'accounts'],
    branchIds: [],
    isSuperAdmin: false,
    requestId: randomUUID(),
  } as unknown as ActiveContext;
}

/** A request the scope helpers accept, at org-wide scope (see M12's suite for why). */
function request(): AuditableRequest {
  const carrier = { headers: {} } as unknown as AuditableRequest;
  attachScope(carrier, 'update', 'Order', { kind: 'all' });
  return carrier;
}

async function zoneId(code: string): Promise<string> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into sales.delivery_zones (org_id, code, name_en, name_bn, charge_poisha)
        values (${ORG_A}, ${code}, ${code}, ${code}, 8000)
        on conflict (org_id, code) do update set name_en = excluded.name_en
        returning id
      `);
      return rows[0]?.id ?? '';
    },
    { orgId: ORG_A },
  );
}

async function onZone(order: SeededOrder, zone: string, courier: string): Promise<void> {
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        update sales.orders set delivery_zone_id = ${zone}, courier_id = ${courier}
        where org_id = ${ORG_A} and id = ${order.orderId}
      `);
    },
    { orgId: ORG_A },
  );
}

/** Reserve and book through the real services; returns the consignment id. */
async function book(order: SeededOrder, requested?: string): Promise<string> {
  const reserved = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
    booking.reserveConsignment(
      tx,
      { orgId: ORG_A, userId: ACTOR },
      { orderId: order.orderId, courierId: requested ?? null },
    ),
  );
  await booking.runBooking({
    orgId: ORG_A,
    payload: { consignmentId: reserved.consignmentId, orderId: order.orderId, actorUserId: ACTOR },
  });
  return reserved.consignmentId;
}

async function consignment(id: string) {
  const row = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
    repo.consignmentById(tx, ORG_A, id),
  );
  if (row === undefined) throw new Error('no consignment');
  return row;
}

async function orderStatus(orderId: string): Promise<string> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ status: string }>(sql`
        select status::text as status from sales.orders where org_id = ${ORG_A} and id = ${orderId}
      `);
      return rows[0]?.status ?? '';
    },
    { orgId: ORG_A },
  );
}

async function count(query: ReturnType<typeof sql>): Promise<number> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ count: string }>(query);
      return Number(rows[0]?.count ?? 0);
    },
    { orgId: ORG_A },
  );
}

async function journalCount(orderId: string, event: string): Promise<number> {
  return count(sql`
    select count(*) as count from ledger.journals
    where org_id = ${ORG_A} and source_type = 'order' and source_id = ${orderId}
      and idempotency_key like ${`%:${event}`}
  `);
}

/** Push a courier word through the webhook path, exactly as the courier would send it. */
async function webhook(
  consignmentId: string,
  state: string,
  options: { at?: Date; collectedPoisha?: string | null } = {},
): Promise<void> {
  const row = await consignment(consignmentId);
  fake.advance(row.consignment_no ?? '', state, options.at === undefined ? {} : { at: options.at });
  const body = fake.webhookBody(row.consignment_no ?? '');
  if (options.collectedPoisha === null) delete body.collected_poisha;
  else if (options.collectedPoisha !== undefined) body.collected_poisha = options.collectedPoisha;

  const accepted = await sync.acceptWebhook({
    orgId: ORG_A,
    providerCode: 'fake',
    headers: { 'x-fake-courier-secret': WEBHOOK_SECRET },
    raw: Buffer.from(JSON.stringify(body), 'utf8'),
  });
  if (accepted.deliveryId !== null && !accepted.duplicate) {
    await sync.runWebhook({
      orgId: ORG_A,
      payload: { deliveryId: accepted.deliveryId, courierAccountId: accountA },
    });
  }
}

/** Make a consignment look as if its status last changed `days` ago. */
async function ageStatus(consignmentId: string, days: number): Promise<void> {
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        update courier.consignments set
          status_changed_at = now() - make_interval(days => ${days}),
          last_status_at = now() - make_interval(days => ${days})
        where org_id = ${ORG_A} and id = ${consignmentId}
      `);
    },
    { orgId: ORG_A },
  );
}

beforeAll(async () => {
  process.env.COURIER_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString('base64');
  resetCourierEnv();

  harness = await startHttpHarness('courier-m15');
  await applyCourierMigrations();

  // Registered but not worked: this suite drives the handlers directly, so a background
  // worker running the same job would turn an idempotency assertion into a race. The queue
  // suite (`courier.queue.db.test.ts`) is the one that runs them through pg-boss.
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues: COURIER_QUEUE_DEFINITIONS,
    logger: pino({ level: 'silent' }),
    pollingIntervalSeconds: 0.5,
  });

  approvals = harness.app.get(ApprovalsService);
  accounts = harness.app.get(CourierAccountsService);
  booking = harness.app.get(BookingService);
  sync = harness.app.get(CourierSyncService);
  settlements = harness.app.get(SettlementsService);
  reports = harness.app.get(CourierReportsService);
  selection = harness.app.get(CourierSelectionService);
  stuck = harness.app.get(StuckParcelsService);
  labels = harness.app.get(CourierLabelsService);

  const registered = harness.app.get<CourierAdapterRegistry>(COURIER_ADAPTERS).get('fake');
  if (!(registered instanceof FakeCourierAdapter)) throw new Error('no fake adapter');
  fake = registered;

  courierA = await makeCourier(ORG_A, 'fake', 'Fake Courier');
  courierB = await makeCourier(ORG_A, 'fake_b', 'Fake Courier B');
  courierC = await makeCourier(ORG_A, 'fake_c', 'Fake Courier C');
  walletId = await makeBankWallet(ORG_A);
  zoneInside = await zoneId('inside_dhaka');
  zoneOutside = await zoneId('outside_dhaka');

  const upsert = async (courier: string, label: string) =>
    accounts.upsert(context(), request(), {
      courierId: courier,
      providerCode: 'fake',
      label,
      mode: 'sandbox',
      webhookSecret: WEBHOOK_SECRET,
      pollAfterHours: 1,
      settlementWalletId: walletId,
      isActive: true,
    });
  accountA = (await upsert(courierA, 'Fake A')).id;
  accountB = (await upsert(courierB, 'Fake B')).id;
  await upsert(courierC, 'Fake C');
}, 420_000);

afterAll(async () => {
  await jobs?.stop();
  await harness?.close();
}, 60_000);

beforeEach(async () => {
  fake.failNextBookings = 0;
  fake.rejectNextBookings = 0;
  fake.failNextFetches = 0;
  fake.issuedStatements.length = 0;
  // No rules unless a test writes them: they are the org's policy and change every booking.
  await selection.replace(context(), request(), { rules: [] });
});

// --- check 2: the selection rules, and the booking that must not split a receivable ---------

describe('zone → courier rules (check 2)', () => {
  it('recommends the rule’s courier for the order, and books only with the order’s own', async () => {
    await selection.replace(context(), request(), {
      rules: [{ priority: 10, deliveryZoneId: zoneOutside, courierId: courierB, isActive: true }],
    });

    const outside = await seedShippedOrder(ORG_A);
    await onZone(outside, zoneOutside, courierA);
    const inside = await seedShippedOrder(ORG_A);
    await onZone(inside, zoneInside, courierA);

    // The rule recommends B for the outside order; the inside order keeps its own courier.
    expect(
      await selection.preview(context(), request(), { orderId: outside.orderId }),
    ).toMatchObject({
      courierId: courierB,
      source: 'rule',
      orderCourierId: courierA,
      differsFromOrder: true,
    });
    expect(
      await selection.preview(context(), request(), { orderId: inside.orderId }),
    ).toMatchObject({ courierId: courierA, source: 'order', differsFromOrder: false });

    // Booking with a courier the order does not name is refused: the receivable would split.
    await expect(book(outside, courierB)).rejects.toThrow(/set to a different courier/);

    // The desk applies the recommendation to the order, and the booking follows it.
    await onZone(outside, zoneOutside, courierB);
    const outsideParcel = await consignment(await book(outside));
    const insideParcel = await consignment(await book(inside));
    expect(outsideParcel.courier_id).toBe(courierB);
    expect(outsideParcel.courier_account_id).toBe(accountB);
    expect(insideParcel.courier_id).toBe(courierA);
    // The zone travels with the parcel, for the performance report.
    expect(outsideParcel.delivery_zone_id).toBe(zoneOutside);
    expect(insideParcel.delivery_zone_id).toBe(zoneInside);
  });

  it('books the delivery’s receivable against the parcel’s courier — the one the statement settles', async () => {
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneInside, courierB);
    const id = await book(order);
    const parcel = await consignment(id);
    fake.advance(parcel.consignment_no ?? '', 'handed_to_customer');
    const accepted = await sync.acceptWebhook({
      orgId: ORG_A,
      providerCode: 'fake',
      headers: { 'x-fake-courier-secret': WEBHOOK_SECRET },
      raw: Buffer.from(JSON.stringify(fake.webhookBody(parcel.consignment_no ?? '')), 'utf8'),
    });
    await sync.runWebhook({
      orgId: ORG_A,
      payload: { deliveryId: accepted.deliveryId ?? '', courierAccountId: accountB },
    });

    const parties = await withSystem(
      async (tx) => {
        const rows = await tx.execute<{ party_id: string }>(sql`
          select distinct l.party_id from ledger.journal_lines l
          join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
          join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
          where l.org_id = ${ORG_A} and j.source_type = 'order' and j.source_id = ${order.orderId}
            and a.subtype = 'courier_receivable'
        `);
        return [...rows].map((row) => row.party_id);
      },
      { orgId: ORG_A },
    );
    // One party, and it is the courier whose statement will relieve it.
    expect(parties).toEqual([parcel.courier_id]);
  });

  it('honours a COD band in the recommendation', async () => {
    await selection.replace(context(), request(), {
      rules: [
        {
          priority: 10,
          deliveryZoneId: zoneInside,
          minCodPoisha: '500000',
          courierId: courierB,
          isActive: true,
        },
      ],
    });

    const big = await seedShippedOrder(ORG_A, { unitPricePoisha: 300_000n, qty: 2 });
    await onZone(big, zoneInside, courierA);
    const small = await seedShippedOrder(ORG_A, { unitPricePoisha: 10_000n, qty: 1 });
    await onZone(small, zoneInside, courierA);

    expect(
      (await selection.preview(context(), request(), { orderId: big.orderId })).courierId,
    ).toBe(courierB);
    expect(
      (await selection.preview(context(), request(), { orderId: small.orderId })).courierId,
    ).toBe(courierA);
    // A courier a person names wins over every rule.
    expect(
      (
        await selection.preview(context(), request(), {
          orderId: big.orderId,
          courierId: courierC,
        })
      ).courierId,
    ).toBe(courierC);
  });

  it('fails over past a rule whose courier cannot book, and says so', async () => {
    const off = await makeCourier(ORG_A, 'fake_off', 'Switched-off courier');
    await accounts.upsert(context(), request(), {
      courierId: off,
      providerCode: 'fake',
      label: 'Inactive',
      mode: 'sandbox',
      pollAfterHours: 1,
      isActive: false,
    });
    await selection.replace(context(), request(), {
      rules: [
        { priority: 10, deliveryZoneId: zoneOutside, courierId: off, isActive: true },
        { priority: 20, deliveryZoneId: zoneOutside, courierId: courierC, isActive: true },
      ],
    });
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneOutside, courierA);

    const preview = await selection.preview(context(), request(), { orderId: order.orderId });
    expect(preview).toMatchObject({ courierId: courierC, source: 'rule' });
    expect(preview.skippedRuleIds).toHaveLength(1);
  });

  it('refuses a rule set a person could not have meant, before writing anything', async () => {
    await expect(
      selection.replace(context(), request(), {
        rules: [
          {
            priority: 10,
            deliveryZoneId: zoneInside,
            minCodPoisha: '900',
            maxCodPoisha: '100',
            courierId: courierB,
            isActive: true,
          },
        ],
      }),
    ).rejects.toThrow(/lower bound is above the upper bound/);
    expect((await selection.list(context())).items).toHaveLength(0);
  });
});

// --- check 3: the tracking page leaks nothing ---------------------------------------------

describe('the public tracking page (check 3)', () => {
  /** A fresh client that has picked up a CSRF token, as the portal does before it posts. */
  async function portalClient() {
    const client = harness.client();
    await client.request('GET', '/health/live');
    return client;
  }

  async function track(client: Awaited<ReturnType<typeof portalClient>>, body: unknown) {
    return client.request('POST', '/v1/track', { body });
  }

  async function phoneOf(order: SeededOrder): Promise<string> {
    return withSystem(
      async (tx) => {
        const rows = await tx.execute<{ phone: string }>(sql`
          select ship_phone_e164 as phone from sales.orders
          where org_id = ${ORG_A} and id = ${order.orderId}
        `);
        return rows[0]?.phone ?? '';
      },
      { orgId: ORG_A },
    );
  }

  it('answers wrong digits, a missing order and an unknown brand with identical bytes', async () => {
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneInside, courierA);
    await book(order);
    const last4 = (await phoneOf(order)).slice(-4);
    const wrong = last4 === '0000' ? '1111' : '0000';

    const client = await portalClient();
    const wrongDigits = await track(client, {
      brand: BRAND,
      orderNo: order.orderNo,
      phoneLast4: wrong,
    });
    const missingOrder = await track(await portalClient(), {
      brand: BRAND,
      orderNo: 'CUR-2609-99999',
      phoneLast4: last4,
    });
    const unknownBrand = await track(await portalClient(), {
      brand: 'no-such-brand',
      orderNo: order.orderNo,
      phoneLast4: last4,
    });

    for (const response of [wrongDigits, missingOrder, unknownBrand]) {
      expect(response.statusCode).toBe(200);
      // Byte-identical: the one negative answer, whatever the reason.
      expect(response.body).toBe(wrongDigits.body);
      expect(response.headers['content-type']).toBe(wrongDigits.headers['content-type']);
    }
    expect(JSON.parse(wrongDigits.body)).toEqual({ found: false });
    // Nothing about the courier or the parcel reached the negative answer.
    expect(wrongDigits.body).not.toContain('Fake');
    expect(wrongDigits.body).not.toContain(order.orderNo);
  });

  it('answers the right digits with a stage — and never echoes the phone', async () => {
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneInside, courierA);
    await book(order);
    const phone = await phoneOf(order);

    const response = await track(await portalClient(), {
      brand: BRAND,
      orderNo: order.orderNo.toLowerCase(),
      phoneLast4: phone.slice(-4),
    });
    expect(response.statusCode).toBe(200);
    const answer = JSON.parse(response.body) as Record<string, unknown>;
    expect(answer).toMatchObject({
      found: true,
      orderNo: order.orderNo,
      stage: 'with_courier',
      courier: { name: 'Fake Courier' },
      codAmountPoisha: order.codAmountPoisha.toString(),
    });
    expect(response.body).not.toContain(phone.slice(-8));
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('reads Bangla digits as a customer types them', async () => {
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneInside, courierA);
    await book(order);
    const bangla = (await phoneOf(order))
      .slice(-4)
      .replace(/\d/g, (digit) => '০১২৩৪৫৬৭৮৯'[Number(digit)] ?? digit);

    const response = await track(await portalClient(), {
      brand: BRAND,
      orderNo: order.orderNo,
      phoneLast4: bangla,
    });
    expect((JSON.parse(response.body) as { found: boolean }).found).toBe(true);
  });

  it('stops guessing at one order after five tries, from any address', async () => {
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneInside, courierA);
    await book(order);
    const last4 = (await phoneOf(order)).slice(-4);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      // A fresh address every time: the per-order bucket is what an enumeration has to spend.
      const response = await track(await portalClient(), {
        brand: BRAND,
        orderNo: order.orderNo,
        phoneLast4: String(1000 + attempt),
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 5).every((status) => status === 200)).toBe(true);
    expect(statuses[5]).toBe(429);

    // Once limited, even the right digits wait: the limit is not a way to test a guess either.
    const right = await track(await portalClient(), {
      brand: BRAND,
      orderNo: order.orderNo,
      phoneLast4: last4,
    });
    expect(right.statusCode).toBe(429);
  });

  it('pauses a brand’s tracking for everyone once its misses are spent (D3, D-416)', async () => {
    const limiter = harness.app.get<RateLimitStore>(TRACKING_RATE_LIMITER, { strict: false });
    const missKey = `track:misses:${BRAND}`;
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneInside, courierA);
    await book(order);
    const last4 = (await phoneOf(order)).slice(-4);
    const right = { brand: BRAND, orderNo: order.orderNo, phoneLast4: last4 };

    // A found answer spends nothing; a miss spends one.
    const before = (await limiter.peek(missKey)).count;
    const found = await track(await portalClient(), right);
    expect(JSON.parse(found.body)).toMatchObject({ found: true });
    expect((await limiter.peek(missKey)).count).toBe(before);
    const miss = await track(await portalClient(), {
      brand: BRAND,
      orderNo: 'CUR-2609-55555',
      phoneLast4: '1234',
    });
    expect(JSON.parse(miss.body)).toEqual({ found: false });
    expect((await limiter.peek(missKey)).count).toBe(before + 1);

    // The rest of the budget, spent the way a botnet would: one guess each at many orders.
    const { limit, windowSeconds } = TRACKING_LIMITS.perBrandMisses;
    for (let spent = before + 1; spent < limit; spent += 1) {
      await limiter.hit(missKey, limit, windowSeconds);
    }

    // Now the right digits for a real order wait exactly as a guess does: no oracle.
    const paused = await track(await portalClient(), right);
    const guessed = await track(await portalClient(), {
      brand: BRAND,
      orderNo: 'CUR-2609-55556',
      phoneLast4: '4321',
    });
    for (const response of [paused, guessed]) {
      expect(response.statusCode).toBe(429);
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    }
    expect(paused.body).toBe(guessed.body);

    // Another brand's tracking is its own budget.
    const elsewhere = await track(await portalClient(), {
      brand: 'no-such-brand',
      orderNo: order.orderNo,
      phoneLast4: last4,
    });
    expect(elsewhere.statusCode).toBe(200);
  });

  it('counts a missing order against the limit exactly as a real one', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await track(await portalClient(), {
        brand: BRAND,
        orderNo: 'CUR-2609-77777',
        phoneLast4: String(2000 + attempt),
      });
      statuses.push(response.statusCode);
    }
    expect(statuses[5]).toBe(429);
  });
});

// --- check 4: settlement fetch is idempotent -----------------------------------------------

describe('settlement fetch (check 4)', () => {
  const today = businessDate(new Date());

  async function deliveredParcel() {
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneInside, courierA);
    const id = await book(order);
    await webhook(id, 'handed_to_customer');
    const row = await consignment(id);
    return { order, id, consignmentNo: row.consignment_no ?? '' };
  }

  function row(
    parcel: Awaited<ReturnType<typeof deliveredParcel>>,
    rowNo: number,
  ): SettlementFileRow {
    return {
      consignmentNo: parcel.consignmentNo,
      reference: parcel.order.orderNo,
      codCollectedPoisha: poisha(parcel.order.codAmountPoisha),
      deliveryChargePoisha: poisha(6_000n),
      returnChargePoisha: poisha(0n),
      otherChargePoisha: poisha(0n),
      netPoisha: null,
      rowNo,
    };
  }

  async function fetchOnce() {
    return settlements.runFetch({
      orgId: ORG_A,
      payload: { courierAccountId: accountA, actorUserId: 'system:courier' },
    });
  }

  async function batchesFor(reference: string): Promise<number> {
    return count(sql`
      select count(*) as count from courier.settlements
      where org_id = ${ORG_A} and courier_account_id = ${accountA} and reference = ${reference}
    `);
  }

  async function settlementJournals(settlementId: string): Promise<number> {
    return count(sql`
      select count(*) as count from ledger.journals
      where org_id = ${ORG_A} and source_type = 'courier_settlement' and source_id = ${settlementId}
    `);
  }

  it('creates one batch for one statement however often it is fetched, and posts it once', async () => {
    const first = await deliveredParcel();
    const second = await deliveredParcel();
    fake.issuedStatements.push({
      reference: 'API-S1',
      settlementDate: today,
      rows: [row(first, 1), row(second, 2)],
    });

    const one = await fetchOnce();
    expect(one.outcomes.map((entry) => entry.outcome)).toEqual(['created']);
    const settlementId = one.outcomes[0]?.settlementId ?? '';

    const two = await fetchOnce();
    expect(two.outcomes.map((entry) => entry.outcome)).toEqual(['duplicate']);
    expect(two.outcomes[0]?.settlementId).toBe(settlementId);
    expect(await batchesFor('API-S1')).toBe(1);

    // A fetched batch waits for a person, exactly as an upload does: nothing has posted.
    const imported = await settlements.get(context(), settlementId);
    expect(imported.status).toBe('imported');
    expect(await settlementJournals(settlementId)).toBe(0);

    const raised = await settlements.requestApproval(context(), request(), settlementId, {});
    await approvals.decide(context(ORG_A, CHECKER), {
      id: raised.approvalRequestId,
      decision: 'approved',
      request: request(),
    });
    expect((await settlements.get(context(), settlementId)).status).toBe('posted');
    const journals = await settlementJournals(settlementId);
    expect(journals).toBe(2);

    // Fetched again after posting: still one batch, still two journals.
    const three = await fetchOnce();
    expect(three.outcomes.map((entry) => entry.outcome)).toEqual(['duplicate']);
    expect(await batchesFor('API-S1')).toBe(1);
    expect(await settlementJournals(settlementId)).toBe(journals);

    // And every run is on record, statement by statement.
    const runs = await settlements.fetchRuns(context());
    expect(runs.items.length).toBeGreaterThanOrEqual(3);
    expect(runs.items[0]).toMatchObject({ seen: 1, duplicate: 1, created: 0, refused: 0 });
  });

  it('creates one batch when two fetches of the same statement race', async () => {
    const parcel = await deliveredParcel();
    fake.issuedStatements.push({
      reference: 'API-S2',
      settlementDate: today,
      rows: [row(parcel, 1)],
    });

    const [a, b] = await Promise.all([fetchOnce(), fetchOnce()]);
    const outcomes = [...a.outcomes, ...b.outcomes].map((entry) => entry.outcome).sort();
    expect(outcomes).toEqual(['created', 'duplicate']);
    expect(await batchesFor('API-S2')).toBe(1);
  });

  it('recognises a statement with no reference by its fingerprint', async () => {
    const parcel = await deliveredParcel();
    fake.issuedStatements.push({ reference: null, settlementDate: today, rows: [row(parcel, 1)] });

    const one = await fetchOnce();
    const two = await fetchOnce();
    expect(one.outcomes[0]?.outcome).toBe('created');
    expect(two.outcomes[0]?.outcome).toBe('duplicate');
    expect(two.outcomes[0]?.settlementId).toBe(one.outcomes[0]?.settlementId);
  });

  it('refuses a re-issued statement number with different rows instead of importing it twice', async () => {
    const parcel = await deliveredParcel();
    const other = await deliveredParcel();
    fake.issuedStatements.push({
      reference: 'API-S3',
      settlementDate: today,
      rows: [row(parcel, 1)],
    });
    await fetchOnce();

    fake.issuedStatements.length = 0;
    fake.issuedStatements.push({
      reference: 'API-S3',
      settlementDate: today,
      rows: [row(parcel, 1), row(other, 2)],
    });
    const again = await fetchOnce();
    expect(again.outcomes[0]).toMatchObject({ outcome: 'refused', code: 'IDEMPOTENCY_CONFLICT' });
    expect(await batchesFor('API-S3')).toBe(1);
  });

  it('records a statement it could not import, rather than dropping it', async () => {
    fake.issuedStatements.push({
      reference: 'API-S4',
      settlementDate: today,
      rows: [
        {
          consignmentNo: 'FK-NOT-OURS',
          reference: null,
          codCollectedPoisha: poisha(10_000n),
          deliveryChargePoisha: poisha(0n),
          returnChargePoisha: poisha(0n),
          otherChargePoisha: poisha(0n),
          netPoisha: null,
          rowNo: 1,
        },
      ],
    });
    const result = await fetchOnce();
    expect(result.outcomes[0]).toMatchObject({
      outcome: 'refused',
      code: 'SETTLEMENT_FILE_INVALID',
    });
    expect(await batchesFor('API-S4')).toBe(0);
  });

  it('records a courier that did not answer, and throws so the job retries', async () => {
    fake.failNextFetches = 1;
    await expect(fetchOnce()).rejects.toThrow();
    const runs = await settlements.fetchRuns(context());
    expect(runs.items[0]?.error).toBe('COURIER_UNAVAILABLE');
  });
});

// --- check 5: the stuck-parcel queue ------------------------------------------------------

describe('the stuck-parcel queue (check 5)', () => {
  async function parcel(): Promise<{ order: SeededOrder; id: string }> {
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneInside, courierA);
    return { order, id: await book(order) };
  }

  it('names the courier on a parcel list, through the port rather than a join', async () => {
    // `sync.listParcels` is the parcels screen's query. Its courier name used to be
    // `join sales.couriers`; it is now `OrdersPort.courierParties` (invariant 12), and
    // the name is asserted on its value because a stitch that matched nothing would
    // leave an empty column rather than fail.
    const listed = await parcel();

    const page = await sync.listParcels(context(), request(), { page: 1, pageSize: 50 });
    const row = page.items.find((item) => item.id === listed.id);

    expect(row).toBeDefined();
    expect(row?.courierId).toBe(courierA);
    expect(row?.courierName).toBe('Fake Courier');
  });

  it('lists parcels past the threshold and not fresh ones, with the reason', async () => {
    const stale = await parcel();
    await webhook(stale.id, 'moving');
    await ageStatus(stale.id, 5);

    const fresh = await parcel();
    await webhook(fresh.id, 'moving');

    const oldButDelivered = await parcel();
    await webhook(oldButDelivered.id, 'handed_to_customer');
    await ageStatus(oldButDelivered.id, 30);

    const justUnder = await parcel();
    await webhook(justUnder.id, 'moving');
    await ageStatus(justUnder.id, 2);

    const queue = await stuck.list(context(), request(), { thresholdDays: 3 });
    const listed = new Map(queue.items.map((item) => [item.consignmentId, item]));

    expect(listed.get(stale.id)?.reasons).toEqual(['no_status_change']);
    expect(listed.get(stale.id)?.daysStuck).toBeGreaterThanOrEqual(5);
    expect(listed.has(fresh.id)).toBe(false);
    expect(listed.has(oldButDelivered.id)).toBe(false);
    expect(listed.has(justUnder.id)).toBe(false);

    // The same parcel with a tighter threshold is in.
    const tight = await stuck.list(context(), request(), { thresholdDays: 2 });
    expect(tight.items.some((item) => item.consignmentId === justUnder.id)).toBe(true);
  });

  it('lists a parcel the moment the courier says a word nobody mapped (M12 gap 1)', async () => {
    const unmapped = await parcel();
    await webhook(unmapped.id, 'moving');
    // A word the fake courier's vocabulary does not contain.
    await webhook(unmapped.id, 'teleported');

    // `weird` is in the fake's vocabulary, mapped to `unknown` on purpose — like Pathao's
    // exchange notice. On an active parcel it still leaves us not knowing where it is.
    const declared = await parcel();
    await webhook(declared.id, 'moving');
    await webhook(declared.id, 'weird');

    // The same word after the parcel was delivered is harmless and lists nothing.
    const finished = await parcel();
    await webhook(finished.id, 'handed_to_customer');
    await webhook(finished.id, 'teleported');

    const fresh = await parcel();
    await webhook(fresh.id, 'moving');

    const queue = await stuck.list(context(), request(), { thresholdDays: 3 });
    const listed = new Map(queue.items.map((item) => [item.consignmentId, item]));
    expect(listed.get(unmapped.id)?.reasons).toEqual(['unknown_status']);
    expect(listed.get(unmapped.id)?.lastEventRawStatus).toBe('teleported');
    // The parcel still holds where it really was — the unmapped word replaced nothing.
    expect((await consignment(unmapped.id)).status).toBe('in_transit');
    expect(listed.get(declared.id)?.reasons).toEqual(['unknown_status']);
    expect(listed.has(finished.id)).toBe(false);
    expect(listed.has(fresh.id)).toBe(false);
  });

  it('lists a booking no retry can fix, flagged at once (M12 gap 2)', async () => {
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneInside, courierA);
    fake.rejectNextBookings = 1;
    const reserved = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      booking.reserveConsignment(tx, { orgId: ORG_A, userId: ACTOR }, { orderId: order.orderId }),
    );
    // A permanent refusal completes the job and flags the parcel on the first attempt.
    await booking.runBooking({
      orgId: ORG_A,
      payload: {
        consignmentId: reserved.consignmentId,
        orderId: order.orderId,
        actorUserId: ACTOR,
      },
    });
    const row = await consignment(reserved.consignmentId);
    expect(row.booking_state).toBe('failed');
    expect(row.booking_attempts).toBe(1);
    expect(row.booking_failure_code).toBe('COURIER_BOOKING_FAILED');

    const queue = await stuck.list(context(), request(), {});
    expect(
      queue.items.find((item) => item.consignmentId === reserved.consignmentId)?.reasons,
    ).toEqual(['booking_failed']);
  });

  it('does not reset the clock when a poll hears the same status again', async () => {
    const polled = await parcel();
    await webhook(polled.id, 'moving');
    await ageStatus(polled.id, 5);
    const before = (await consignment(polled.id)).status_changed_at;

    // The poll asks and hears `moving` again — a sign of life, not a change.
    await sync.runRepoll({
      orgId: ORG_A,
      payload: { consignmentIds: [polled.id], actorUserId: ACTOR },
    });
    const after = await consignment(polled.id);
    expect(after.status_changed_at).toBe(before);
    expect(
      (await stuck.list(context(), request(), { thresholdDays: 3 })).items.some(
        (item) => item.consignmentId === polled.id,
      ),
    ).toBe(true);

    // And a real change takes it out of the queue.
    fake.advance((await consignment(polled.id)).consignment_no ?? '', 'with_rider');
    const outcome = await sync.runRepoll({
      orgId: ORG_A,
      payload: { consignmentIds: [polled.id], actorUserId: ACTOR },
    });
    expect(outcome.polled).toBe(1);
    expect((await consignment(polled.id)).status).toBe('out_for_delivery');
    expect(
      (await stuck.list(context(), request(), { thresholdDays: 3 })).items.some(
        (item) => item.consignmentId === polled.id,
      ),
    ).toBe(false);
  });

  it('queues a bulk re-poll for the caller’s parcels only, and skips finished ones', async () => {
    const active = await parcel();
    const done = await parcel();
    await webhook(done.id, 'handed_to_customer');
    const queued = await stuck.requestRepoll(context(), request(), {
      consignmentIds: [active.id, done.id, randomUUID()],
    });
    expect(queued).toEqual({ queued: 1, skipped: 2 });
  });

  it('keeps an append-only escalation trail and exports a courier-ready file', async () => {
    const chased = await parcel();
    await webhook(chased.id, 'moving');
    await ageStatus(chased.id, 6);
    const note = await stuck.escalate(context(), request(), chased.id, {
      note: '=HYPERLINK("http://x") called the hub, they will check',
    });

    await expect(
      withSystem(
        async (tx) => {
          await tx.execute(sql`
            update courier.consignment_escalations set note = 'tidied'
            where org_id = ${ORG_A} and id = ${note.id}
          `);
        },
        { orgId: ORG_A },
      ),
    ).rejects.toThrow();

    const file = await stuck.exportCsv(context(), request(), { thresholdDays: 3 });
    const row = await consignment(chased.id);
    expect(file.csv.startsWith('﻿consignment_no,')).toBe(true);
    expect(file.csv).toContain(row.consignment_no ?? 'missing');
    expect(file.csv).toContain(chased.order.orderNo);
    // A note that starts like a formula is exported as text, never as a formula.
    expect(file.csv).toContain(`"'=HYPERLINK(""http://x"") called the hub, they will check"`);
    // No recipient data in a file that goes to a third party (invariant 10).
    expect(file.csv).not.toContain('Rahim');
    expect(file.csv).not.toMatch(/\+?8801\d{9}/);

    const timeline = await sync.timeline(context(), request(), chased.id);
    expect(timeline.escalations.map((entry) => entry.id)).toContain(note.id);
  });
});

// --- tracking rules that protect the money --------------------------------------------------

describe('a courier talking after the story ended', () => {
  it('keeps a delivered parcel delivered whatever it says next', async () => {
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneInside, courierA);
    const id = await book(order);
    await webhook(id, 'handed_to_customer');
    const deliveredAt = (await consignment(id)).status_changed_at;

    await webhook(id, 'weird');
    await webhook(id, 'moving');
    const row = await consignment(id);
    expect(row.status).toBe('delivered');
    expect(row.status_changed_at).toBe(deliveredAt);
    expect(await journalCount(order.orderId, 'delivered')).toBe(1);
  });

  it('moves nothing on a partial delivery the courier gave no figure for', async () => {
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneInside, courierA);
    const id = await book(order);

    await webhook(id, 'part_handed', { collectedPoisha: null });
    // No figure, so no journal: the only fallback left is the full COD, wrong by definition.
    expect(await orderStatus(order.orderId)).toBe('shipped');
    expect(await journalCount(order.orderId, 'delivered')).toBe(0);
    expect((await consignment(id)).collected_poisha).toBeNull();
  });

  it('starts the return path when the courier reports the parcel back', async () => {
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneInside, courierA);
    const id = await book(order);
    await webhook(id, 'back_at_warehouse');
    expect(await orderStatus(order.orderId)).toBe('return_in_transit');
    expect((await consignment(id)).returned_at).not.toBeNull();
  });
});

// --- what the M15 ledger audit found ----------------------------------------------------------

describe('what the M15 ledger audit found', () => {
  const today = businessDate(new Date());

  function statementRow(consignmentNo: string, reference: string, cod: bigint): SettlementFileRow {
    return {
      consignmentNo,
      reference,
      codCollectedPoisha: poisha(cod),
      deliveryChargePoisha: poisha(0n),
      returnChargePoisha: poisha(0n),
      otherChargePoisha: poisha(0n),
      netPoisha: null,
      rowNo: 1,
    };
  }

  async function fetchOnce() {
    return settlements.runFetch({
      orgId: ORG_A,
      payload: { courierAccountId: accountA, actorUserId: 'system:courier' },
    });
  }

  it('C1: a return the courier collected on records no collection, and cannot settle', async () => {
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneInside, courierA);
    const id = await book(order);
    // A paid return: the parcel comes back and the courier says it collected ৳60.
    await webhook(id, 'back_at_warehouse', { collectedPoisha: '6000' });

    const row = await consignment(id);
    expect(await orderStatus(order.orderId)).toBe('return_in_transit');
    expect(row.collected_poisha).toBeNull();

    // The statement's ৳60 is an exception, so nothing credits the receivable for it.
    fake.issuedStatements.push({
      reference: `C1-${randomUUID().slice(0, 6)}`,
      settlementDate: today,
      rows: [statementRow(row.consignment_no ?? '', order.orderNo, 6_000n)],
    });
    const result = await fetchOnce();
    expect(result.outcomes[0]).toMatchObject({
      outcome: 'refused',
      code: 'SETTLEMENT_FILE_INVALID',
    });

    // And the database refuses the figure on a parcel whose delivery was never booked.
    await expect(
      withSystem(
        async (tx) => {
          await tx.execute(sql`
            update courier.consignments set collected_poisha = 6000
            where org_id = ${ORG_A} and id = ${id}
          `);
        },
        { orgId: ORG_A },
      ),
    ).rejects.toThrow();
  });

  it('M1: a manual delivery dated before the courier’s last word still settles', async () => {
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneInside, courierA);
    const id = await book(order);
    await webhook(id, 'paused', { at: new Date(Date.now() - 60 * 60_000) });

    await sync.setStatusManually(context(), request(), id, {
      status: 'delivered',
      rawStatus: 'rider confirmed by phone',
      reason: 'The courier’s sync has not caught up.',
      occurredAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      collectedPoisha: order.codAmountPoisha.toString(),
    });

    const row = await consignment(id);
    expect(await orderStatus(order.orderId)).toBe('delivered');
    expect(row.status).toBe('delivered');
    const candidates = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      repo.settlementCandidates(tx, ORG_A, courierA),
    );
    expect(candidates.some((candidate) => candidate.consignment_id === id)).toBe(true);
  });

  it('M1: a delivery that arrives after a later courier word still moves the parcel', async () => {
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneInside, courierA);
    const id = await book(order);
    const now = Date.now();
    await webhook(id, 'with_rider', { at: new Date(now) });
    await webhook(id, 'handed_to_customer', { at: new Date(now - 30_000) });

    expect(await orderStatus(order.orderId)).toBe('delivered');
    expect((await consignment(id)).status).toBe('delivered');
  });

  it('M2: a delivery the courier gave no figure for is in the stuck queue at once', async () => {
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneInside, courierA);
    const id = await book(order);
    await webhook(id, 'part_handed', { collectedPoisha: null });

    const queue = await stuck.list(context(), request(), { thresholdDays: 3 });
    expect(queue.items.find((item) => item.consignmentId === id)?.reasons).toEqual([
      'unposted_delivery',
    ]);
  });

  it('M2: a parcel the courier returned and the warehouse never received is listed after N days', async () => {
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneInside, courierA);
    const id = await book(order);
    await webhook(id, 'back_at_warehouse');

    const fresh = await stuck.list(context(), request(), { thresholdDays: 3 });
    expect(fresh.items.some((item) => item.consignmentId === id)).toBe(false);

    await ageStatus(id, 5);
    const aged = await stuck.list(context(), request(), { thresholdDays: 3 });
    expect(aged.items.find((item) => item.consignmentId === id)?.reasons).toEqual([
      'return_not_received',
    ]);
  });

  it('M4: a rejected fetched statement can be fetched again once it is fixed', async () => {
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneInside, courierA);
    const id = await book(order);
    await webhook(id, 'handed_to_customer');
    const row = await consignment(id);
    const reference = `M4-${randomUUID().slice(0, 6)}`;
    fake.issuedStatements.push({
      reference,
      settlementDate: today,
      rows: [statementRow(row.consignment_no ?? '', order.orderNo, order.codAmountPoisha)],
    });

    const first = await fetchOnce();
    const firstId = first.outcomes[0]?.settlementId ?? '';
    expect(first.outcomes[0]?.outcome).toBe('created');
    await settlements.reject(context(), request(), firstId, { reason: 'Courier re-issuing it.' });

    const again = await fetchOnce();
    expect(again.outcomes[0]?.outcome).toBe('created');
    expect(again.outcomes[0]?.settlementId).not.toBe(firstId);
  });

  it('m3: a label request for another branch’s parcel says nothing about it', async () => {
    const order = await seedShippedOrder(ORG_A, { status: 'packed' });
    await onZone(order, zoneInside, courierA);
    const reserved = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      booking.reserveConsignment(tx, { orgId: ORG_A, userId: ACTOR }, { orderId: order.orderId }),
    );

    const narrowed = { headers: {} } as unknown as AuditableRequest;
    attachScope(narrowed, 'read', 'Order', {
      kind: 'some',
      anyOf: [{ field: 'branchId', in: [randomUUID()] }],
    });
    // Unbooked *and* out of scope: the answer is "does not exist", never its order number.
    await expect(labels.gather(context(), narrowed, [reserved.consignmentId])).rejects.toThrow(
      /does not exist/,
    );
  });
});

// --- M12 gap 3: concurrent duplicates -------------------------------------------------------

describe('identical webhooks processed concurrently (M12 check 3, gap 3)', () => {
  it('records one event, one transition and one journal', async () => {
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneInside, courierA);
    const id = await book(order);
    const row = await consignment(id);
    const at = new Date('2026-09-20T08:00:00.000Z');
    fake.advance(row.consignment_no ?? '', 'handed_to_customer', { at });
    const body = fake.webhookBody(row.consignment_no ?? '');

    /*
     * The same event in two different byte sequences — what a courier's retry through a
     * different proxy, or two couriers' workers, actually produce. Different bytes get past
     * the body-hash dedupe at the door, so both are stored and both jobs run; it is the lock and
     * the event dedupe key that must hold, and they have to hold *concurrently*.
     */
    const deliveries = await Promise.all(
      [JSON.stringify(body), JSON.stringify(body, null, 2)].map((text) =>
        sync.acceptWebhook({
          orgId: ORG_A,
          providerCode: 'fake',
          headers: { 'x-fake-courier-secret': WEBHOOK_SECRET },
          raw: Buffer.from(text, 'utf8'),
        }),
      ),
    );
    expect(deliveries.every((delivery) => !delivery.duplicate)).toBe(true);

    await Promise.all(
      deliveries.map((delivery) =>
        sync.runWebhook({
          orgId: ORG_A,
          payload: { deliveryId: delivery.deliveryId ?? '', courierAccountId: accountA },
        }),
      ),
    );

    expect(
      await count(sql`
        select count(*) as count from courier.consignment_events
        where org_id = ${ORG_A} and consignment_id = ${id} and status = 'delivered'
      `),
    ).toBe(1);
    expect(
      await count(sql`
        select count(*) as count from courier.consignment_events
        where org_id = ${ORG_A} and consignment_id = ${id} and applied_trigger = 'deliver'
      `),
    ).toBe(1);
    expect(await journalCount(order.orderId, 'delivered')).toBe(1);
    expect(await orderStatus(order.orderId)).toBe('delivered');
  });

  it('stores one delivery when the identical bytes arrive at the same moment', async () => {
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneInside, courierA);
    const id = await book(order);
    const row = await consignment(id);
    fake.advance(row.consignment_no ?? '', 'moving');
    const raw = Buffer.from(JSON.stringify(fake.webhookBody(row.consignment_no ?? '')), 'utf8');

    const results = await Promise.all(
      [0, 1, 2].map(() =>
        sync.acceptWebhook({
          orgId: ORG_A,
          providerCode: 'fake',
          headers: { 'x-fake-courier-secret': WEBHOOK_SECRET },
          raw,
        }),
      ),
    );
    expect(new Set(results.map((result) => result.deliveryId)).size).toBe(1);
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
  });
});

// --- the performance report ----------------------------------------------------------------

describe('courier performance by zone', () => {
  it('rates the parcels that resolved, per courier and zone', async () => {
    const perf = await makeCourier(ORG_A, 'fake_perf', 'Performance courier');
    await accounts.upsert(context(), request(), {
      courierId: perf,
      providerCode: 'fake',
      label: 'Fake perf',
      mode: 'sandbox',
      webhookSecret: WEBHOOK_SECRET,
      pollAfterHours: 1,
      settlementWalletId: walletId,
      isActive: true,
    });
    const perfAccount = (await accounts.list(context())).items.find(
      (item) => item.courierId === perf,
    );

    const outcomes = ['handed_to_customer', 'handed_to_customer', 'coming_back', 'moving'];
    for (const state of outcomes) {
      const order = await seedShippedOrder(ORG_A);
      await onZone(order, zoneOutside, perf);
      const id = await book(order, perf);
      const row = await consignment(id);
      fake.advance(row.consignment_no ?? '', state);
      const accepted = await sync.acceptWebhook({
        orgId: ORG_A,
        providerCode: 'fake',
        headers: { 'x-fake-courier-secret': WEBHOOK_SECRET },
        raw: Buffer.from(JSON.stringify(fake.webhookBody(row.consignment_no ?? '')), 'utf8'),
      });
      await sync.runWebhook({
        orgId: ORG_A,
        payload: { deliveryId: accepted.deliveryId ?? '', courierAccountId: perfAccount?.id ?? '' },
      });
    }

    const report = await reports.performance(context(), request(), { courierId: perf });
    const zone = report.rows.find((entry) => entry.deliveryZoneId === zoneOutside);
    expect(zone).toMatchObject({
      courierName: 'Performance courier',
      booked: 4,
      delivered: 2,
      returned: 1,
      inFlight: 1,
      resolved: 3,
      deliveryRateBps: 6667,
      returnRateBps: 3333,
      // Delivered the day they were booked.
      averageDeliveryDays: '0.0',
    });
  });

  it('refuses a window it cannot mean', async () => {
    await expect(
      reports.performance(context(), request(), { from: '2026-09-10', to: '2026-09-01' }),
    ).rejects.toThrow(/starts after it ends/);
    await expect(
      reports.performance(context(), request(), { from: '2024-01-01', to: '2026-09-01' }),
    ).rejects.toThrow(/a year at most/);
  });
});

// --- bulk booking and labels ----------------------------------------------------------------

describe('bulk booking and labels', () => {
  it('books many orders in their own transactions and reports each one', async () => {
    const good = await seedShippedOrder(ORG_A, { status: 'packed' });
    await onZone(good, zoneInside, courierA);
    const noCourier = await seedShippedOrder(ORG_A, { status: 'packed' });
    await withSystem(
      async (tx) => {
        await tx.execute(sql`
          update sales.orders set courier_id = null, delivery_zone_id = null
          where org_id = ${ORG_A} and id = ${noCourier.orderId}
        `);
      },
      { orgId: ORG_A },
    );
    const missing = randomUUID();

    const result = await booking.bookMany(context(), request(), {
      orderIds: [good.orderId, noCourier.orderId, missing, good.orderId],
    });
    expect(result.results).toHaveLength(3);
    expect(result.results[0]).toMatchObject({ orderId: good.orderId, enqueued: true, code: null });
    expect(result.results[1]).toMatchObject({
      orderId: noCourier.orderId,
      code: 'CONSIGNMENT_INVALID',
    });
    expect(result.results[2]).toMatchObject({ orderId: missing, code: 'ORDER_NOT_FOUND' });

    // A courier the orders do not name is refused per order, not booked beside them.
    const other = await seedShippedOrder(ORG_A, { status: 'packed' });
    await onZone(other, zoneInside, courierA);
    const mismatch = await booking.bookMany(context(), request(), {
      orderIds: [other.orderId],
      courierId: courierB,
    });
    expect(mismatch.results[0]).toMatchObject({ enqueued: false, code: 'CONSIGNMENT_INVALID' });
  });

  it('gathers a label with the full phone for the rider, and refuses an unbooked parcel', async () => {
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneInside, courierA);
    const booked = await book(order);
    const [label] = await labels.gather(context(), request(), [booked]);
    expect(label).toMatchObject({
      orderNo: order.orderNo,
      courierName: 'Fake Courier',
      codAmountPoisha: order.codAmountPoisha,
    });
    expect(label?.recipientPhone).toMatch(/^01\d{3}-\d{6}$/);

    const pending = await seedShippedOrder(ORG_A);
    await onZone(pending, zoneInside, courierA);
    const reserved = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      booking.reserveConsignment(tx, { orgId: ORG_A, userId: ACTOR }, { orderId: pending.orderId }),
    );
    await expect(
      labels.gather(context(), request(), [booked, reserved.consignmentId]),
    ).rejects.toThrow(/Not booked with the courier yet/);
  });

  it('escapes whatever a person typed, and puts no price or cost on the label', () => {
    const html = renderLabelsHtml({
      fonts: [],
      labels: [
        {
          brandName: 'Oura',
          courierName: 'Pathao',
          consignmentNo: 'DL1212',
          trackingCode: null,
          orderNo: 'OUR-2609-00042',
          recipientName: '<script>alert(1)</script>',
          recipientPhone: '01712-345678',
          addressLine: 'House 1',
          area: null,
          thana: 'Gulshan',
          district: 'Dhaka',
          codAmountPoisha: 248_000n,
          note: null,
        },
      ],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('৳2,480.00');
    expect(html).toContain('<svg');
    expect(html).not.toMatch(/cost|unit_price/i);
  });
});

// --- the new routes over HTTP -------------------------------------------------------------------

describe('M15’s routes over HTTP', () => {
  /*
   * The route-matrix suite is where each route's *guard* is proven for every role, once the
   * integrator adds these thirteen lines to its manifest. This is the module's own smoke test
   * that each one serves a real request end to end — the pipeline, the serializer, the PDF
   * renderer, the CSV — without a server error, using the very fixtures the matrix will use.
   */
  it('serves every new route to an org admin without a server error', async () => {
    await prepareCourierFixtures();
    const admin = await harness.asRole('org_admin', ORG_A);
    expect(COURIER_M15_ROUTE_KEYS).toHaveLength(13);

    for (const key of COURIER_M15_ROUTE_KEYS) {
      const fixture = COURIER_ROUTE_FIXTURES[key];
      if (fixture === undefined) throw new Error(`no fixture for ${key}`);
      const call = fixture();
      const method = key.split(' ')[0] ?? 'GET';
      const response = await admin.client.request(
        method,
        call.url,
        call.body === undefined ? {} : { body: call.body },
      );
      expect(response.statusCode, `${key} -> ${response.body.slice(0, 300)}`).toBeLessThan(500);
      if (key === 'GET /v1/courier/labels') {
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toBe('application/pdf');
      }
      if (key === 'GET /v1/courier/stuck/export') {
        expect(response.headers['content-type']).toMatch(/^text\/csv/);
      }
    }
  }, 120_000);

  it('refuses the new routes to a role the matrix does not grant them', async () => {
    const investor = await harness.asRole('investor', ORG_A);
    for (const key of ['GET /v1/courier/stuck', 'GET /v1/courier/reports/performance']) {
      const fixture = COURIER_ROUTE_FIXTURES[key];
      if (fixture === undefined) throw new Error(`no fixture for ${key}`);
      const response = await investor.client.request('GET', fixture().url);
      expect(response.statusCode, key).toBe(403);
    }
  }, 60_000);
});

// --- the webhook route over HTTP --------------------------------------------------------------

describe('a courier webhook over HTTP', () => {
  /*
   * The platform's CSRF hook used to refuse every state-changing request with no
   * `erp_csrf` cookie, and a courier's server has none — so over real HTTP M12's webhook
   * route answered 403 before it ran, for every courier, while M12's suite (which calls
   * `acceptWebhook` directly) never saw it. The exemption for `/v1/courier/webhooks/` has now
   * landed in `csrf.ts`; this test is what keeps it there — through the real pipeline, no
   * cookie, and the courier's shared secret as the only authority.
   */
  it('reaches the route with no browser cookie, on the courier’s secret alone', async () => {
    const order = await seedShippedOrder(ORG_A);
    await onZone(order, zoneInside, courierA);
    const id = await book(order);
    const row = await consignment(id);
    fake.advance(row.consignment_no ?? '', 'moving');

    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/courier/webhooks/${ORG_A}/fake`,
      headers: {
        'content-type': 'application/json',
        'x-fake-courier-secret': WEBHOOK_SECRET,
      },
      payload: JSON.stringify(fake.webhookBody(row.consignment_no ?? '')),
    });
    expect(response.statusCode).toBeLessThan(300);

    // And with the wrong secret, the same cookieless request is refused and stores nothing.
    const before = await count(sql`
      select count(*) as count from courier.webhook_deliveries where org_id = ${ORG_A}
    `);
    const forged = await harness.server.inject({
      method: 'POST',
      url: `/v1/courier/webhooks/${ORG_A}/fake`,
      headers: { 'content-type': 'application/json', 'x-fake-courier-secret': 'not-the-secret' },
      payload: JSON.stringify({
        ...fake.webhookBody(row.consignment_no ?? ''),
        state: 'handed_to_customer',
      }),
    });
    expect(forged.statusCode).toBe(401);
    expect(
      await count(sql`
        select count(*) as count from courier.webhook_deliveries where org_id = ${ORG_A}
      `),
    ).toBe(before);
  });
});

// --- ledger audit M3: one parcel, one courier -------------------------------------------------

describe('an order cannot move to another courier while a parcel is booked (audit M3)', () => {
  /*
   * The delivery journal debits `courier_receivable` against the order's courier; the
   * settlement credits it against the consignment's. Booking already refuses a courier
   * other than the order's, but the order itself could still be pointed somewhere else
   * afterwards — at `ship`, or by an edit — and then the debit and the credit land on
   * different parties while the org total still agrees. Both sides of the rule are here:
   * the refusal, and that cancelling the booking is what frees the order.
   */
  it('refuses the change at ship and in the guard, and allows it once the booking is cancelled', async () => {
    const orders = harness.app.get(OrdersService);
    const transitions = harness.app.get(TransitionsService);

    const order = await seedShippedOrder(ORG_A, { status: 'packed' });
    await onZone(order, zoneInside, courierA);
    const consignmentId = await book(order);

    // Through the real transition route: shipping it with courier B is refused before
    // anything is written, and the order still names courier A.
    await expect(
      orders.transition(context(), request(), order.orderId, 'ship', { courierId: courierB }),
    ).rejects.toThrow(/already has a parcel booked/);
    const after = await withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
      const rows = await tx.execute<{ courier_id: string; status: string }>(sql`
        select courier_id, status from sales.orders where id = ${order.orderId}
      `);
      return rows[0];
    });
    expect(after).toEqual({ courier_id: courierA, status: 'packed' });

    const guard = (next: string) =>
      withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
        transitions.assertCourierChangeAllowed(
          tx,
          ORG_A,
          { id: order.orderId, courier_id: courierA },
          next,
        ),
      );
    await expect(guard(courierB)).rejects.toThrow(/already has a parcel booked/);
    // Naming the courier it already has is not a change.
    await expect(guard(courierA)).resolves.toBeUndefined();

    // Cancel the booking and the order is free to go elsewhere.
    await booking.runCancel({
      orgId: ORG_A,
      payload: { consignmentId, actorUserId: ACTOR },
    });
    await expect(guard(courierB)).resolves.toBeUndefined();
  });
});
