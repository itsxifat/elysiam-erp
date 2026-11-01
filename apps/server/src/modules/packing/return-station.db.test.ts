import { randomUUID } from 'node:crypto';

import { withGlobal, withOrg, withSystem } from '@elysium/db';
import { internalEan13 } from '@elysium/domain/barcode';
import { PACKING_LABEL_REREAD_MS, lotCode } from '@elysium/domain/packing';
import { sql, type SQL } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import type { AuditService } from '../../platform/audit/audit.service.js';
import { attachScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { ORG_A, ORG_B, startHttpHarness, type HttpHarness } from '../../testing/http-harness.js';
import { CourierAccountsService } from '../courier/accounts.service.js';
import {
  COURIER_ADAPTERS,
  type CourierAdapterRegistry,
} from '../courier/adapters/courier-adapter.js';
import { FakeCourierAdapter } from '../courier/adapters/fake.adapter.js';
import { BookingService } from '../courier/booking.service.js';
import { resetCourierEnv } from '../courier/courier.config.js';
import { COURIER_QUEUE_DEFINITIONS } from '../courier/courier.queues.js';
import {
  applyCourierMigrations,
  makeBankWallet,
  makeCourier,
  makeLocation,
  seedShippedOrder,
} from '../courier/courier.testing.js';
import { ReturnsService } from '../courier/returns.service.js';
import { CourierSyncService } from '../courier/sync.service.js';
import { seedProductWithSkus } from '../inventory/inventory.testing.js';
import { seedCustomer, seedOrder } from '../orders/orders.testing.js';
import { PACKING_QUEUE_DEFINITIONS } from './packing.queues.js';
import { ReturnStationService } from './return-station.service.js';

/**
 * The return station on a parcel really coming back, on real Postgres (M51, D-934 to D-939).
 *
 * The parcel is booked with the fake courier and brought back by its webhook, and the receipt runs
 * the real orders module: real stock movements and a real journal. So:
 *
 * 1. Receive books what was scanned: stock split between the shelf and the damaged shelf, one
 *    journal at the dispatch value, one receipt, the session closed, no cost in the answer.
 * 2. A failure after the session completed rolls every piece of it back, and it can be done again.
 * 3. An order that names no location (every order from the desk or the inbox) is received.
 * 4. A receipt short of what went out, or with a bag unopened, must be acknowledged: a parcel has
 *    one receipt, so what it leaves out can never be booked in later.
 * 5. A bag stopped by mistake, by the label or by its fifteen minutes, reopens, so nothing is
 *    stranded; the scanner's own repeat stops nothing.
 * 6. An order received from another page ends its inspection; both routes at once book it once.
 * 7. Another brand sees nothing.
 */

const ACTOR = `usr_m51r_${randomUUID().slice(0, 8)}`;
const WEBHOOK_SECRET = 'a-webhook-secret-of-sufficient-length';
const REASON = { returnReason: 'customer_refused', reason: 'Refused at the door.' };

let harness: HttpHarness;
let jobs: JobsRuntime | undefined;
let returns: ReturnStationService;
let courierReturns: ReturnsService;
let booking: BookingService;
let sync: CourierSyncService;
let fake: FakeCourierAdapter;
let courierId = '';
let accountId = '';
let damagedShelf = '';
let barcodeSeq = 82_000_000_000 + Math.floor(Math.random() * 1_000_000_000);

function context(orgId = ORG_A): ActiveContext {
  return {
    orgId,
    userId: ACTOR,
    isSuperAdmin: false,
    roles: ['org_admin', 'accounts'],
    branchIds: [],
    branchIdsByRole: {},
    requestId: randomUUID(),
  };
}

function request(): AuditableRequest {
  const value = { headers: {} } as unknown as AuditableRequest;
  attachScope(value, 'update', 'Order', { kind: 'all' });
  return value;
}

async function words(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    const found: string[] = [];
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
      found.push(current.message);
      const code = (current as { response?: { code?: string } }).response?.code;
      if (code !== undefined) found.push(code);
    }
    return found.join(' | ');
  }
  return 'not refused';
}

async function one<T extends Record<string, unknown>>(query: SQL): Promise<T> {
  const rows = await withSystem(async (tx) => [...(await tx.execute(query))], { orgId: ORG_A });
  const row = rows[0] as T | undefined;
  if (row === undefined) throw new Error('the query found nothing');
  return row;
}

async function barcodeFor(skuId: string): Promise<string> {
  barcodeSeq += 1;
  const barcode = internalEan13(barcodeSeq);
  await withSystem(
    (tx) => tx.execute(sql`update catalog.skus set barcode = ${barcode} where id = ${skuId}`),
    { orgId: ORG_A },
  );
  return barcode;
}

/** A shipped order, booked with the fake courier and brought back by its webhook. */
async function comingBack(qty: number) {
  const order = await seedShippedOrder(ORG_A, { qty });
  await withSystem(
    (tx) =>
      tx.execute(
        sql`update sales.orders set courier_id = ${courierId} where id = ${order.orderId}`,
      ),
    { orgId: ORG_A },
  );
  const reserved = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
    booking.reserveConsignment(tx, { orgId: ORG_A, userId: ACTOR }, { orderId: order.orderId }),
  );
  await booking.runBooking({
    orgId: ORG_A,
    payload: { consignmentId: reserved.consignmentId, orderId: order.orderId, actorUserId: ACTOR },
  });
  const { consignment_no: consignmentNo } = await one<{ consignment_no: string }>(sql`
    select consignment_no from courier.consignments where id = ${reserved.consignmentId}
  `);
  fake.advance(consignmentNo, 'coming_back');
  const accepted = await sync.acceptWebhook({
    orgId: ORG_A,
    providerCode: 'fake',
    headers: { 'x-fake-courier-secret': WEBHOOK_SECRET, 'content-type': 'application/json' },
    raw: Buffer.from(JSON.stringify(fake.webhookBody(consignmentNo)), 'utf8'),
  });
  if (accepted.deliveryId === null) throw new Error('the webhook was not accepted');
  await sync.runWebhook({
    orgId: ORG_A,
    payload: { deliveryId: accepted.deliveryId, courierAccountId: accountId },
  });
  expect(await orderStatus(order.orderId)).toBe('return_in_transit');
  return {
    ...order,
    consignmentId: reserved.consignmentId,
    barcode: await barcodeFor(order.skuId),
  };
}

const orderStatus = async (orderId: string) =>
  (
    await one<{ status: string }>(
      sql`select status::text as status from sales.orders where id = ${orderId}`,
    )
  ).status;

const scan = (sessionId: string, code: string) =>
  returns.scan(context(), request(), sessionId, { scanId: randomUUID(), code });

/** Past the scanner's repeat: a person's second scan of the same label. */
const pastReread = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, PACKING_LABEL_REREAD_MS + 100);
  });

const onHand = async (skuId: string, locationId: string) =>
  (
    await one<{ n: number }>(sql`
      select coalesce((select on_hand from inventory.stock_levels
                        where sku_id = ${skuId} and location_id = ${locationId}), 0)::int as n
    `)
  ).n;

const totalOnHand = async (skuId: string) =>
  (
    await one<{ n: number }>(sql`
      select coalesce(sum(on_hand), 0)::int as n from inventory.stock_levels
       where sku_id = ${skuId}
    `)
  ).n;

const receipts = async (consignmentId: string) =>
  (
    await one<{ n: number }>(sql`
      select count(*)::int as n from courier.return_receipts where consignment_id = ${consignmentId}
    `)
  ).n;

/** The order's return journals: how many, and what they debited to Inventory. */
const returnJournals = (orderId: string) =>
  one<{ journals: number; inventory: string; debit: string; credit: string }>(sql`
    select count(distinct j.id)::int as journals,
           coalesce(sum(l.debit_poisha) filter (where a.subtype = 'inventory'), 0)::text as inventory,
           coalesce(sum(l.debit_poisha), 0)::text as debit,
           coalesce(sum(l.credit_poisha), 0)::text as credit
    from ledger.journals j
    join ledger.journal_lines l on l.org_id = j.org_id and l.journal_id = j.id
    join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
    where j.source_type = 'order' and j.source_id = ${orderId}
      and j.idempotency_key like '%return%'
  `);

const sessionRow = (sessionId: string) =>
  one<{ status: string; completed_at: string | null }>(sql`
    select status, completed_at::text from packing.sessions where id = ${sessionId}
  `);

beforeAll(async () => {
  process.env.COURIER_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString('base64');
  resetCourierEnv();
  harness = await startHttpHarness('m51-return-station');
  await applyCourierMigrations();
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues: [...COURIER_QUEUE_DEFINITIONS, ...PACKING_QUEUE_DEFINITIONS],
    logger: pino({ level: 'silent' }),
    pollingIntervalSeconds: 0.5,
  });
  await withGlobal(async (tx) => {
    await tx.execute(sql`
      insert into iam.users (id, email, name, email_verified)
      values (${ACTOR}, ${`${ACTOR}@example.invalid`}, 'M51 receiver', true)
      on conflict (id) do nothing
    `);
  });
  returns = harness.app.get(ReturnStationService);
  courierReturns = harness.app.get(ReturnsService);
  booking = harness.app.get(BookingService);
  sync = harness.app.get(CourierSyncService);
  const registered = harness.app.get<CourierAdapterRegistry>(COURIER_ADAPTERS).get('fake');
  if (!(registered instanceof FakeCourierAdapter)) throw new Error('no fake courier');
  fake = registered;
  courierId = await makeCourier(ORG_A, 'fake', 'Fake Courier');
  const walletId = await makeBankWallet(ORG_A);
  damagedShelf = await makeLocation(ORG_A, {
    code: 'DAMAGED',
    name: 'Damaged shelf',
    kind: 'damaged',
  });
  const account = await harness.app.get(CourierAccountsService).upsert(context(), request(), {
    courierId,
    providerCode: 'fake',
    label: 'Fake Courier (sandbox)',
    mode: 'sandbox',
    webhookSecret: WEBHOOK_SECRET,
    pollAfterHours: 1,
    settlementWalletId: walletId,
    isActive: true,
  });
  accountId = account.id;
}, 420_000);

afterAll(async () => {
  await jobs?.stop();
  await harness?.close();
}, 60_000);

beforeEach(() => {
  fake.reset();
});

describe('Receive (D-934)', () => {
  it('books what was scanned: stock split, one journal at the dispatch value, no cost shown', async () => {
    const parcel = await comingBack(3);
    const before = await onHand(parcel.skuId, parcel.locationId);
    const opened = await returns.open(context(), request(), { code: parcel.orderNo });
    expect(opened.recordings).toHaveLength(1);
    expect(opened.lines[0]).toMatchObject({ skuId: parcel.skuId, expected: 3, back: 0 });
    const id = opened.session.id;

    for (let piece = 0; piece < 3; piece += 1) {
      expect((await scan(id, parcel.barcode)).outcome).toBe('accepted');
    }
    expect((await scan(id, parcel.barcode)).outcome).toBe('over');

    const done = await returns.receive(context(), request(), id, {
      ...REASON,
      damaged: [{ skuId: parcel.skuId, qty: 1 }],
      damagedLocationId: damagedShelf,
    });

    expect(done.session.status).toBe('completed');
    expect(done.recordings[0]).toMatchObject({ state: 'stopped', stopReason: 'received' });
    expect(await orderStatus(parcel.orderId)).toBe('returned');
    expect(await onHand(parcel.skuId, parcel.locationId)).toBe(before + 2);
    expect(await onHand(parcel.skuId, damagedShelf)).toBeGreaterThanOrEqual(1);
    expect(await receipts(parcel.consignmentId)).toBe(1);

    // §7: Dr Inventory / Cr Goods in transit, at the dispatch value of all three.
    const money = await returnJournals(parcel.orderId);
    expect(money.journals).toBe(1);
    expect(BigInt(money.inventory)).toBe(3n * parcel.dispatchUnitCostPoisha);
    expect(money.debit).toBe(money.credit);

    // Invariant 5: the dispatch cost the receipt moved never reaches the station.
    expect(JSON.stringify(done).toLowerCase()).not.toMatch(/cost|poisha/);

    // Once: the station is told, the courier's page is told, and nothing moved again.
    expect(
      await words(returns.receive(context(), request(), id, { ...REASON, damaged: [] })),
    ).toMatch(/already received/);
    expect(
      await words(
        courierReturns.receive(context(), request(), parcel.consignmentId, {
          reason: REASON.reason,
          returnReason: 'customer_refused',
          lines: [{ skuId: parcel.skuId, sellableQty: 1, damagedQty: 0 }],
        }),
      ),
    ).toMatch(/already been received/);
    expect((await returnJournals(parcel.orderId)).journals).toBe(1);
    expect(await onHand(parcel.skuId, parcel.locationId)).toBe(before + 2);
  });

  it('rolls everything back when a step fails after the session completed', async () => {
    const parcel = await comingBack(1);
    const before = await onHand(parcel.skuId, parcel.locationId);
    const { session } = await returns.open(context(), request(), { code: parcel.orderNo });
    await scan(session.id, parcel.barcode);

    // The station's own instance: the audit service is provided per module.
    const { audit } = returns as unknown as { audit: AuditService };
    const real = audit.record.bind(audit);
    const failing = vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => {
      if (entry.action === 'packing.return_received') throw new Error('boom after completion');
      return real(tx, entry);
    });
    expect(
      await words(returns.receive(context(), request(), session.id, { ...REASON, damaged: [] })),
    ).toContain('boom');
    failing.mockRestore();

    expect(await receipts(parcel.consignmentId)).toBe(0);
    expect(await onHand(parcel.skuId, parcel.locationId)).toBe(before);
    expect((await returnJournals(parcel.orderId)).journals).toBe(0);
    expect((await sessionRow(session.id)).status).toBe('open');
    expect(await orderStatus(parcel.orderId)).toBe('return_in_transit');
    const { stopped_at: stoppedAt } = await one<{ stopped_at: string | null }>(sql`
      select stopped_at::text from packing.recordings where session_id = ${session.id}
    `);
    expect(stoppedAt).toBeNull();

    const again = await returns.receive(context(), request(), session.id, {
      ...REASON,
      damaged: [],
    });
    expect(again.session.status).toBe('completed');
    expect(await onHand(parcel.skuId, parcel.locationId)).toBe(before + 1);
    expect((await returnJournals(parcel.orderId)).journals).toBe(1);
  });

  it('receives an order that names no location, as every desk and inbox order does', async () => {
    const parcel = await comingBack(1);
    await withSystem(
      (tx) =>
        tx.execute(sql`update sales.orders set location_id = null where id = ${parcel.orderId}`),
      { orgId: ORG_A },
    );
    const before = await totalOnHand(parcel.skuId);
    const { session } = await returns.open(context(), request(), { code: parcel.orderNo });
    await scan(session.id, parcel.barcode);
    const done = await returns.receive(context(), request(), session.id, {
      ...REASON,
      damaged: [],
    });
    expect(done.session.status).toBe('completed');
    expect(await receipts(parcel.consignmentId)).toBe(1);
    expect(await totalOnHand(parcel.skuId)).toBe(before + 1);
    expect((await returnJournals(parcel.orderId)).journals).toBe(1);
  });

  it('refuses a marked-damaged count past what came back, and damage with no shelf', async () => {
    const parcel = await comingBack(2);
    const { session } = await returns.open(context(), request(), { code: parcel.orderNo });
    await scan(session.id, parcel.barcode);
    await scan(session.id, parcel.barcode);
    expect(
      await words(
        returns.receive(context(), request(), session.id, {
          ...REASON,
          damaged: [{ skuId: parcel.skuId, qty: 3 }],
          damagedLocationId: damagedShelf,
        }),
      ),
    ).toMatch(/More pieces are marked damaged/);
    expect(
      await words(
        returns.receive(context(), request(), session.id, {
          ...REASON,
          damaged: [{ skuId: parcel.skuId, qty: 1 }],
        }),
      ),
    ).toMatch(/damaged location/);
    expect(await receipts(parcel.consignmentId)).toBe(0);
    expect((await sessionRow(session.id)).status).toBe('open');
  });
});

describe('a short receipt is said out loud (D-939)', () => {
  it('needs the acknowledgement when pieces did not come back, and records them', async () => {
    const parcel = await comingBack(3);
    const { session } = await returns.open(context(), request(), { code: parcel.orderNo });
    await scan(session.id, parcel.barcode);

    const refused = await words(
      returns.receive(context(), request(), session.id, { ...REASON, damaged: [] }),
    );
    expect(refused).toContain('RETURN_RECEIPT_INVALID');
    expect(refused).toContain('Not in the parcel: 2');
    expect(await receipts(parcel.consignmentId)).toBe(0);

    const done = await returns.receive(context(), request(), session.id, {
      ...REASON,
      damaged: [],
      acknowledgeShort: true,
      inspectionNote: 'x'.repeat(600),
    });
    expect(done.session.status).toBe('completed');
    // What did not come back leads the note, so the person's own words cannot push it off.
    const { inspection_note: note } = await one<{ inspection_note: string }>(sql`
      select inspection_note from courier.return_receipts
       where consignment_id = ${parcel.consignmentId}
    `);
    expect(note.startsWith('Not in the parcel: 2 × ')).toBe(true);
  });

  it('needs it when a bag was never opened, and names the bag', async () => {
    const parcel = await comingBack(2);
    await withSystem(
      (tx) =>
        tx.execute(sql`
          insert into packing.order_lots (org_id, order_id, lot_count, set_by)
          values (${ORG_A}, ${parcel.orderId}, 2, ${ACTOR})
        `),
      { orgId: ORG_A },
    );
    const { session } = await returns.open(context(), request(), {
      code: lotCode(parcel.orderNo, 1),
    });
    await scan(session.id, parcel.barcode);
    await scan(session.id, parcel.barcode);
    await pastReread();
    await scan(session.id, lotCode(parcel.orderNo, 1));

    // Every piece is back, and the second bag still has to be spoken for.
    expect(
      await words(returns.receive(context(), request(), session.id, { ...REASON, damaged: [] })),
    ).toContain('Bags not opened: 2');
    const done = await returns.receive(context(), request(), session.id, {
      ...REASON,
      damaged: [],
      acknowledgeShort: true,
    });
    expect(done.session.status).toBe('completed');
  });
});

describe('nothing is stranded (D-937)', () => {
  it('reopens a bag stopped by mistake, each stretch its own recording', async () => {
    const parcel = await comingBack(2);
    const before = await onHand(parcel.skuId, parcel.locationId);
    const { session } = await returns.open(context(), request(), { code: parcel.orderNo });
    // The scanner's repeat straight after the label stops nothing.
    expect((await scan(session.id, parcel.orderNo)).label?.action).toBe('ignored');
    expect((await scan(session.id, parcel.barcode)).outcome).toBe('accepted');
    await pastReread();
    const stopped = await scan(session.id, parcel.orderNo);
    expect(stopped.label?.action).toBe('stopped');
    expect(stopped.view.lots).toMatchObject({ recording: null, done: [1] });
    expect(stopped.view.labelNeeded).toBe(false);

    // A bag that is shut takes no piece until it is reopened.
    expect(await words(scan(session.id, parcel.barcode))).toContain('PACKING_LABEL_FIRST');
    await pastReread();
    const reopened = await scan(session.id, parcel.orderNo);
    expect(reopened.label).toMatchObject({ action: 'started', lot: 1 });
    expect(reopened.view.lots).toMatchObject({ recording: 1, done: [] });

    const last = await scan(session.id, parcel.barcode);
    expect(last.outcome).toBe('accepted');
    expect(last.view.progress).toMatchObject({ unitsBack: 2, missing: 0 });

    const done = await returns.receive(context(), request(), session.id, {
      ...REASON,
      damaged: [],
    });
    expect(done.session.status).toBe('completed');
    expect(await onHand(parcel.skuId, parcel.locationId)).toBe(before + 2);
    const takes = await withSystem(
      async (tx) => [
        ...(await tx.execute<{ lot_no: number; take: number; stop_reason: string }>(sql`
          select lot_no, take, stop_reason from packing.recordings
           where session_id = ${session.id} order by take
        `)),
      ],
      { orgId: ORG_A },
    );
    expect(takes).toEqual([
      { lot_no: 1, take: 1, stop_reason: 'label' },
      { lot_no: 1, take: 2, stop_reason: 'received' },
    ]);
  });

  it('reopens a bag whose recording ran out at fifteen minutes (D-933)', async () => {
    const parcel = await comingBack(2);
    const { session } = await returns.open(context(), request(), { code: parcel.orderNo });
    await scan(session.id, parcel.barcode);
    await withSystem(
      (tx) =>
        tx.execute(sql`
          update packing.recordings
             set stopped_at = started_at + interval '15 minutes', stop_reason = 'timed_out'
           where session_id = ${session.id}
        `),
      { orgId: ORG_A },
    );
    expect(await words(scan(session.id, parcel.barcode))).toContain('PACKING_LABEL_FIRST');
    await pastReread();
    expect((await scan(session.id, parcel.orderNo)).label?.action).toBe('started');
    expect((await scan(session.id, parcel.barcode)).view.progress).toMatchObject({ missing: 0 });
  });
});

describe('scanning and opening', () => {
  it('refuses a piece that did not go out, in other words than a packing', async () => {
    const parcel = await comingBack(1);
    const others = await seedProductWithSkus(ORG_A, `m51r${randomUUID().slice(0, 6)}`, 1);
    const stranger = await barcodeFor((others.skus[0] as { id: string }).id);
    const { session } = await returns.open(context(), request(), { code: parcel.orderNo });
    const wrong = await scan(session.id, stranger);
    expect(wrong.outcome).toBe('wrong_item');
    expect(wrong.message).toContain('did not go out');
  });

  it('refuses an order not on its way back, and one with no parcel to receive', async () => {
    const shipped = await seedShippedOrder(ORG_A, { qty: 1 });
    expect(await words(returns.open(context(), request(), { orderId: shipped.orderId }))).toContain(
      'not received as a return',
    );

    const products = await seedProductWithSkus(ORG_A, `m51n${randomUUID().slice(0, 6)}`, 1);
    const sku = products.skus[0] as { id: string; code: string };
    const noParcel = await seedOrder(ORG_A, {
      status: 'return_in_transit',
      customerId: await seedCustomer(ORG_A, { phoneE164: '+8801711000952', name: 'M51 buyer' }),
      createdBy: ACTOR,
      lines: [
        {
          skuId: sku.id,
          skuCode: sku.code,
          productName: 'A shirt',
          qty: 1,
          unitPricePoisha: 150_000n,
        },
      ],
    });
    expect(await words(returns.open(context(), request(), { orderId: noParcel.id }))).toContain(
      'no courier parcel',
    );
  });
});

describe('received from another page (D-938)', () => {
  it('ends the open inspection in the receipt’s own transaction', async () => {
    const parcel = await comingBack(1);
    const { session } = await returns.open(context(), request(), { code: parcel.orderNo });
    await scan(session.id, parcel.barcode);

    await courierReturns.receive(context(), request(), parcel.consignmentId, {
      reason: REASON.reason,
      returnReason: 'customer_refused',
      lines: [{ skuId: parcel.skuId, sellableQty: 1, damagedQty: 0 }],
    });

    const row = await sessionRow(session.id);
    expect(row.status).toBe('completed');
    expect(row.completed_at).not.toBeNull();
    const view = await returns.get(context(), request(), session.id);
    expect(view.recordings[0]).toMatchObject({ state: 'stopped', stopReason: 'received' });
    expect(await words(scan(session.id, parcel.barcode))).toMatch(/already received/);
    expect((await returnJournals(parcel.orderId)).journals).toBe(1);
  });

  it('books once when both routes receive at once, and never deadlocks', async () => {
    for (let round = 0; round < 6; round += 1) {
      const parcel = await comingBack(1);
      const before = await onHand(parcel.skuId, parcel.locationId);
      const { session } = await returns.open(context(), request(), { code: parcel.orderNo });
      await scan(session.id, parcel.barcode);

      const settled = await Promise.allSettled([
        returns.receive(context(), request(), session.id, { ...REASON, damaged: [] }),
        courierReturns.receive(context(), request(), parcel.consignmentId, {
          reason: REASON.reason,
          returnReason: 'customer_refused',
          lines: [{ skuId: parcel.skuId, sellableQty: 1, damagedQty: 0 }],
        }),
      ]);

      expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
      for (const entry of settled) {
        if (entry.status === 'rejected') {
          expect(await words(Promise.reject(entry.reason as Error))).not.toMatch(/deadlock/i);
        }
      }
      expect(await receipts(parcel.consignmentId)).toBe(1);
      expect((await returnJournals(parcel.orderId)).journals).toBe(1);
      expect(await onHand(parcel.skuId, parcel.locationId)).toBe(before + 1);
      expect((await sessionRow(session.id)).status).toBe('completed');
    }
  }, 120_000);
});

describe('another brand', () => {
  it('sees nothing of a return, and cannot delete a recording', async () => {
    const parcel = await comingBack(1);
    const { session } = await returns.open(context(), request(), { code: parcel.orderNo });
    expect(await words(returns.get(context(ORG_B), request(), session.id))).toContain(
      'No such return',
    );
    const seen = await withOrg({ orgId: ORG_B, userId: ACTOR }, (tx) =>
      tx.execute(sql`select id from packing.recordings where session_id = ${session.id}`),
    );
    expect([...seen]).toEqual([]);
    expect(
      await words(
        withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
          tx.execute(sql`delete from packing.recordings where session_id = ${session.id}`),
        ),
      ),
    ).toMatch(/permission denied/);
  });
});
