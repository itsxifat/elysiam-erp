import { randomUUID } from 'node:crypto';

import { withGlobal, withOrg, withSystem } from '@elysium/db';
import { grantMembership } from '@elysium/db/testing';
import { poisha } from '@elysium/domain';
import { internalEan13 } from '@elysium/domain/barcode';
import { PACKING_LABEL_REREAD_MS, lotCode } from '@elysium/domain/packing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { attachScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ORG_A, startHttpHarness, type HttpHarness } from '../../testing/http-harness.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import { seedProductWithSkus, warehouseId } from '../inventory/inventory.testing.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { DeskService } from '../orders/desk.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { applyOrderMigrations, seedCustomer, seedOrder } from '../orders/orders.testing.js';
import { LotsService } from './lots.service.js';
import { PrintingService } from './printing.service.js';
import { PackStationService } from './station.service.js';

/**
 * Who says how many lots, on real Postgres (M52, D-941 to D-943).
 *
 * 1. No limit asks nobody. Above the brand's limit a person's Confirm is refused until it says how
 *    many, the answer is saved with the confirm, and an answer that could not be packed is refused.
 * 2. Only the Confirm route asks: the orders module's own transition, and so a replacement, does
 *    not; bulk confirm reports the refusal against that order and confirms the others.
 * 3. A packer who revises the count sends the order back to Ready for label, listed first and
 *    marked; the old label starts and closes nothing; Finish is refused; once the new labels are
 *    printed the same table carries on and the order is packed lot by lot.
 * 4. Changing back to the printed count makes the old labels good again, unless other labels
 *    printed since, when the old were thrown away and the order is listed again.
 * 5. A count is fixed once packed, never more than the pieces left can fill; pages queued for the
 *    old count are cancelled; the new count's labels print through the real route, with no reason.
 */

const PERSON = `usr_m52_${randomUUID().slice(0, 8)}`;
const suffix = randomUUID().slice(0, 6);

let harness: HttpHarness;
let station: PackStationService;
let lots: LotsService;
let orders: OrdersService;
let printing: PrintingService;
let location = '';
let customerId = '';
let shirt: { id: string; code: string; barcode: string };
let terminalId = '';
let printerId = '';

function request(): AuditableRequest {
  const value = {} as AuditableRequest;
  attachScope(value, 'update', 'Order', { kind: 'all' });
  return value;
}

function context(): ActiveContext {
  return {
    orgId: ORG_A,
    userId: PERSON,
    isSuperAdmin: false,
    roles: ['org_admin'],
    branchIds: [],
    branchIdsByRole: {},
    requestId: 'm52-lot-rule',
  };
}

/** A person's new order, pending, of real stock, so its confirm really reserves. */
async function takeOrder(qty: number): Promise<{ id: string; orderNo: string }> {
  return orders.create(context(), request(), {
    channel: 'phone',
    customerId,
    locationId: location,
    deliveryChargePoisha: '6000',
    lines: [{ skuId: shirt.id, qty, unitPricePoisha: '150000' }],
  });
}

function seedPieces(status: string, qty: number) {
  return seedOrder(ORG_A, {
    status,
    customerId,
    createdBy: PERSON,
    lines: [
      {
        skuId: shirt.id,
        skuCode: shirt.code,
        productName: `Product ${shirt.code}`,
        qty,
        unitPricePoisha: 150_000n,
      },
    ],
  });
}

async function setLimit(lotAskAbovePieces: number | null): Promise<void> {
  await station.saveSettings(context(), request(), { videoEnabled: true, lotAskAbovePieces });
}

/** Each lot's label printed at this count, as the label desk's printers record it. */
async function printLabels(order: { id: string; orderNo: string }, count: number): Promise<void> {
  await withSystem(
    async (tx) => {
      for (let lot = 1; lot <= count; lot += 1) {
        await tx.execute(sql`
          insert into packing.print_jobs
            (org_id, order_id, order_no, document, lot_no, lot_count, printer_id, terminal_id,
             source, requested_by, consignment_no, state, printed_at)
          values (${ORG_A}, ${order.id}, ${order.orderNo}, 'label', ${lot}, ${count}, ${printerId},
                  ${terminalId}, 'manual', ${PERSON}, ${`CN-${order.orderNo}`}, 'printed', now())
        `);
      }
    },
    { orgId: ORG_A },
  );
}

/** The order as "Ready for label" keeps it once its courier booked it. */
async function readyForLabel(order: { id: string; orderNo: string }, at: string): Promise<void> {
  await withSystem(
    (tx) =>
      tx.execute(sql`
        insert into packing.label_orders (org_id, order_id, order_no, consignment_no, booked_at)
        values (${ORG_A}, ${order.id}, ${order.orderNo}, ${`CN-${order.orderNo}`},
                ${at}::timestamptz)
      `),
    { orgId: ORG_A },
  );
}

const pastReread = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, PACKING_LABEL_REREAD_MS + 100);
  });

const scan = (sessionId: string, code: string) =>
  station.scan(context(), request(), sessionId, { scanId: randomUUID(), code });

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    const words: string[] = [];
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
      words.push(current.message);
      const response = (current as { response?: { code?: string } }).response;
      if (response?.code !== undefined) words.push(response.code);
    }
    return words.join(' | ');
  }
  return 'not refused';
}

async function storedLots(orderId: string): Promise<number | null> {
  return withSystem(
    async (tx) =>
      (
        await tx.execute<{ lot_count: number }>(
          sql`select lot_count from packing.order_lots where org_id = ${ORG_A} and order_id = ${orderId}`,
        )
      )[0]?.lot_count ?? null,
    { orgId: ORG_A },
  );
}

async function setStoredLots(orderId: string, count: number): Promise<void> {
  await withSystem(
    (tx) =>
      tx.execute(sql`
        insert into packing.order_lots (org_id, order_id, lot_count, set_by)
        values (${ORG_A}, ${orderId}, ${count}, ${PERSON})
      `),
    { orgId: ORG_A },
  );
}

async function jobsOf(orderId: string, state: string) {
  return withSystem(
    async (tx) => [
      ...(await tx.execute<{ lot_no: number; lot_count: number; source: string }>(sql`
        select lot_no, lot_count, source from packing.print_jobs
        where org_id = ${ORG_A} and order_id = ${orderId} and state = ${state}
        order by lot_no, created_at
      `)),
    ],
    { orgId: ORG_A },
  );
}

async function orderStatus(orderId: string): Promise<string> {
  return withSystem(
    async (tx) =>
      (
        await tx.execute<{ status: string }>(
          sql`select status::text as status from sales.orders where id = ${orderId}`,
        )
      )[0]?.status ?? '',
    { orgId: ORG_A },
  );
}

beforeAll(async () => {
  harness = await startHttpHarness('m52-lot-rule');
  await applyOrderMigrations();
  station = harness.app.get(PackStationService);
  lots = harness.app.get(LotsService);
  orders = harness.app.get(OrdersService);
  printing = harness.app.get(PrintingService);
  await withGlobal(async (tx) => {
    await tx.execute(sql`
      insert into iam.users (id, email, name, email_verified)
      values (${PERSON}, ${`${PERSON}@example.invalid`}, 'M52 packer', true)
      on conflict (id) do nothing
    `);
  });
  // A member of the brand, so the name book names who revised the lots.
  await grantMembership({ userId: PERSON, orgId: ORG_A, role: 'org_admin' });
  const shirts = await seedProductWithSkus(ORG_A, `m52s${suffix}`, 1);
  const sku = shirts.skus[0] as { id: string; code: string };
  const barcode = internalEan13(81_000_000_000 + Math.floor(Math.random() * 1_000_000));
  await withSystem(
    async (tx) => {
      await tx.execute(
        sql`update catalog.skus set barcode = ${barcode} where org_id = ${ORG_A} and id = ${sku.id}`,
      );
      terminalId =
        (
          await tx.execute<{ id: string }>(sql`
            insert into packing.terminals (org_id, kind, name, created_by, updated_by)
            values (${ORG_A}, 'label', ${`M52 ${suffix}`}, ${PERSON}, ${PERSON})
            returning id
          `)
        )[0]?.id ?? '';
      printerId =
        (
          await tx.execute<{ id: string }>(sql`
            insert into packing.printers
              (org_id, terminal_id, name, connection, language, medium, width_um, height_um,
               documents, created_by, updated_by)
            values (${ORG_A}, ${terminalId}, ${`M52 printer ${suffix}`}, 'browser', 'pdf', '4x6',
                    101600, 152400, array['label']::text[], ${PERSON}, ${PERSON})
            returning id
          `)
        )[0]?.id ?? '';
    },
    { orgId: ORG_A },
  );
  shirt = { ...sku, barcode };
  customerId = await seedCustomer(ORG_A, { phoneE164: '+8801711000952', name: 'M52 buyer' });
  location = await warehouseId(ORG_A);
  const actor = { orgId: ORG_A, userId: PERSON };
  await withOrg(actor, (tx) =>
    harness.app.get<InventoryApi>(INVENTORY_API).receiveSupply(tx, actor, {
      supplyId: randomUUID(),
      supplierId: randomUUID(),
      locationId: location,
      branchId: null,
      occurredAt: new Date(),
      lines: [{ skuId: sku.id, qty: 200, unitCostPoisha: poisha(40_000n) }],
    }),
  );
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

describe('the question at Confirm (D-941)', () => {
  it('asks nobody with no limit, and the order stays one lot', async () => {
    await setLimit(null);
    const placed = await takeOrder(9);
    const confirmed = await orders.confirm(context(), request(), placed.id);
    expect(confirmed.status).toBe('confirmed');
    expect(await storedLots(placed.id)).toBeNull();
  });

  it('refuses a person above the limit until they say how many, and saves the answer', async () => {
    await setLimit(5);
    const placed = await takeOrder(6);

    expect(await refusal(orders.confirm(context(), request(), placed.id))).toContain(
      'ORDER_LOTS_REQUIRED',
    );
    expect(await orderStatus(placed.id)).toBe('pending');

    // More lots than pieces could never be packed: every lot holds a piece (D-943).
    expect(await refusal(orders.confirm(context(), request(), placed.id, 7))).toContain(
      'LOT_COUNT_INVALID',
    );
    expect(await orderStatus(placed.id)).toBe('pending');

    const confirmed = await orders.confirm(context(), request(), placed.id, 2);
    expect(confirmed.status).toBe('confirmed');
    expect(await storedLots(placed.id)).toBe(2);
  });

  it('takes an answer of one without writing a row, and does not ask at the limit itself', async () => {
    await setLimit(5);
    const big = await takeOrder(6);
    await orders.confirm(context(), request(), big.id, 1);
    expect(await orderStatus(big.id)).toBe('confirmed');
    expect(await storedLots(big.id)).toBeNull();

    const atLimit = await takeOrder(5);
    await orders.confirm(context(), request(), atLimit.id);
    expect(await orderStatus(atLimit.id)).toBe('confirmed');
    expect(await storedLots(atLimit.id)).toBeNull();
  });

  it('rolls the answer back with a confirm that fails', async () => {
    await setLimit(1);
    const placed = await takeOrder(5_000);
    // No such stock: the machine refuses, and the lots answered go with it.
    expect(await refusal(orders.confirm(context(), request(), placed.id, 3))).toContain(
      'STOCK_INSUFFICIENT',
    );
    expect(await storedLots(placed.id)).toBeNull();
  });

  it('asks only on the Confirm route, not in the orders module’s own transition', async () => {
    await setLimit(1);
    const placed = await takeOrder(4);
    const actor = { orgId: ORG_A, userId: PERSON };
    await withOrg(actor, (tx) =>
      harness.app.get<OrdersApi>(ORDERS_API).transition(tx, actor, placed.id, 'confirm'),
    );
    expect(await orderStatus(placed.id)).toBe('confirmed');
    expect(await storedLots(placed.id)).toBeNull();
  });

  it('reports the refusal against that order in a bulk confirm, and confirms the others', async () => {
    await setLimit(5);
    const big = await takeOrder(6);
    const small = await takeOrder(2);
    const bulk = await harness.app
      .get(DeskService)
      .bulkConfirm(context(), request(), [big.id, small.id]);
    expect(bulk.confirmed).toBe(1);
    const refused = bulk.results.find((result) => result.id === big.id);
    expect(refused).toMatchObject({ ok: false, code: 'ORDER_LOTS_REQUIRED' });
    expect(JSON.stringify(refused)).toContain(big.orderNo);
    expect(await orderStatus(big.id)).toBe('pending');
    expect(await orderStatus(small.id)).toBe('confirmed');
  });

  it('asks and answers over HTTP, with the answer audited', async () => {
    await setLimit(5);
    const admin = await harness.asRole('org_admin', ORG_A);
    const placed = await takeOrder(6);
    const path = `/v1/orders/${placed.id}/confirm`;

    const asked = await admin.client.request('POST', path);
    expect(asked.statusCode).toBe(409);
    expect(asked.body).toContain('ORDER_LOTS_REQUIRED');
    expect((await admin.client.request('POST', path, { body: { lots: 7 } })).statusCode).toBe(400);
    expect((await admin.client.request('POST', path, { body: { lots: 0 } })).statusCode).toBe(400);

    const answered = await admin.client.request('POST', path, { body: { lots: 2 } });
    expect(answered.statusCode, answered.body).toBeLessThan(300);
    expect(await storedLots(placed.id)).toBe(2);

    const audited = await withSystem(
      (tx) =>
        tx.execute<{ actor_user_id: string; after: { lotCount: number } }>(sql`
          select actor_user_id, after from audit.audit_log
          where org_id = ${ORG_A} and action = 'packing.lot_count_set' and entity_id = ${placed.id}
        `),
      { orgId: ORG_A },
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]?.actor_user_id).toBe(admin.userId);
    expect(audited[0]?.after.lotCount).toBe(2);
  });

  it('keeps the limit when only the video setting is saved, and clears it when told to', async () => {
    await setLimit(7);
    await station.saveSettings(context(), request(), { videoEnabled: true });
    expect((await station.settings(context(), true)).lotAskAbovePieces).toBe(7);
    await setLimit(null);
    expect((await station.settings(context(), true)).lotAskAbovePieces).toBeNull();
  });
});

describe('the packer revises the count (D-942, D-943)', () => {
  it('never takes more lots than pieces', async () => {
    const placed = await seedPieces('confirmed', 2);
    expect(
      await refusal(lots.setLotCount(context(), request(), placed.id, { count: 3 })),
    ).toContain('LOT_COUNT_INVALID');
  });

  it('sends the order back to Labels, first and marked, and the table waits for the new labels', async () => {
    const waitingLonger = await seedPieces('confirmed', 1);
    await readyForLabel(waitingLonger, '2020-01-01T00:00:00Z');
    const placed = await seedPieces('confirmed', 3);
    await readyForLabel(placed, '2021-01-01T00:00:00Z');
    await printLabels(placed, 1);

    const opened = await station.open(context(), request(), { code: placed.orderNo });
    const sessionId = opened.session.id;
    expect(opened.labelsAwaited).toEqual([]);
    expect(opened.labelNeeded).toBe(false);
    await pastReread();
    await scan(sessionId, shirt.barcode);

    // Not listed while its label stands.
    const before = await printing.ready(context(), request(), { limit: 100 });
    expect(before.items.some((item) => item.orderId === placed.id)).toBe(false);

    // The bag is full: the packer sends the revised count.
    const revised = await lots.setLotCount(context(), request(), placed.id, { count: 2 });
    expect(revised.changed).toBe(true);

    const ready = await printing.ready(context(), request(), { limit: 100 });
    const first = ready.items[0];
    expect(first?.orderId).toBe(placed.id);
    expect(first?.revised?.fromLots).toBe(1);
    expect(first?.revised?.by).toBe('M52 packer');
    expect(first?.lotCount).toBe(2);
    expect(first?.labelsPrinted).toBe(0);
    // The order that has simply waited longer is not marked, and comes after.
    const longer = ready.items.find((item) => item.orderId === waitingLonger.id);
    expect(longer?.revised).toBeNull();

    const waiting = await station.get(context(), request(), sessionId);
    expect(waiting.labelsAwaited).toEqual([1, 2]);

    // The old label starts and closes nothing, and the answer says what to wait for.
    await pastReread();
    const old = await scan(sessionId, placed.orderNo);
    expect(old.label?.action).toBe('refused');
    expect(old.label?.message).toContain('the labels of lots 1 and 2 are not printed yet');
    expect(old.view.lots?.closed).toEqual([]);

    // The button waits too, and a piece still goes in the bag being filled.
    expect(await refusal(station.closeLot(context(), request(), sessionId))).toContain(
      'ORDER_LABEL_NOT_PRINTED',
    );
    const piece = await scan(sessionId, shirt.barcode);
    expect(piece.accepted).toBe(true);

    // The label desk prints them: the order leaves the list and the same table carries on.
    await printLabels(placed, 2);
    const after = await printing.ready(context(), request(), { limit: 100 });
    expect(after.items.some((item) => item.orderId === placed.id)).toBe(false);
    expect((await station.get(context(), request(), sessionId)).labelsAwaited).toEqual([]);

    // The old sticker names no bag now: only the new labels work (D-945).
    await pastReread();
    const sticker = await scan(sessionId, placed.orderNo);
    expect(sticker.label?.action).toBe('refused');
    expect(sticker.label?.message).toContain('scan lot 1’s own label');
    expect(sticker.view.lots?.closed).toEqual([]);

    const closed = await scan(sessionId, lotCode(placed.orderNo, 1));
    expect(closed.label?.action).toBe('lot_closed');
    await pastReread();
    expect((await scan(sessionId, lotCode(placed.orderNo, 2))).label?.action).toBe('started');
    expect((await scan(sessionId, shirt.barcode)).accepted).toBe(true);
    await pastReread();
    expect((await scan(sessionId, lotCode(placed.orderNo, 2))).label?.action).toBe('finished');
    expect(await orderStatus(placed.id)).toBe('packed');
  });

  it('makes the old labels good again when the count goes back', async () => {
    const placed = await seedPieces('confirmed', 2);
    await readyForLabel(placed, '2021-01-01T00:00:00Z');
    await printLabels(placed, 1);
    await lots.setLotCount(context(), request(), placed.id, { count: 2 });
    const marked = await printing.ready(context(), request(), { limit: 100 });
    expect(marked.items.find((item) => item.orderId === placed.id)?.revised?.fromLots).toBe(1);

    await lots.setLotCount(context(), request(), placed.id, { count: 1 });
    const back = await printing.ready(context(), request(), { limit: 100 });
    expect(back.items.some((item) => item.orderId === placed.id)).toBe(false);
  });

  it('does not bring back labels thrown away once others printed (D-945)', async () => {
    const placed = await seedPieces('confirmed', 2);
    await readyForLabel(placed, '2021-01-01T00:00:00Z');
    await printLabels(placed, 1);
    await lots.setLotCount(context(), request(), placed.id, { count: 2 });
    await printLabels(placed, 2);
    const printed = await printing.ready(context(), request(), { limit: 100 });
    expect(printed.items.some((item) => item.orderId === placed.id)).toBe(false);

    await lots.setLotCount(context(), request(), placed.id, { count: 1 });
    const again = await printing.ready(context(), request(), { limit: 100 });
    const row = again.items.find((item) => item.orderId === placed.id);
    expect(row?.revised?.fromLots).toBe(2);
    expect(row?.labelsPrinted).toBe(0);
    expect(await refusal(station.open(context(), request(), { code: placed.orderNo }))).toContain(
      'ORDER_LABEL_NOT_PRINTED',
    );

    // Its new label is a page at the count of today, not a reprint, and it stands.
    await printLabels(placed, 1);
    const done = await printing.ready(context(), request(), { limit: 100 });
    expect(done.items.some((item) => item.orderId === placed.id)).toBe(false);
  });

  it('fixes the count once packed, up or down (D-944)', async () => {
    const placed = await seedPieces('packed', 3);
    for (const count of [1, 2, 3]) {
      expect(await refusal(lots.setLotCount(context(), request(), placed.id, { count }))).toContain(
        'LOTS_LOCKED',
      );
    }
    expect(await storedLots(placed.id)).toBeNull();
  });

  it('counts only the pieces left once a bag is sealed', async () => {
    const placed = await seedPieces('confirmed', 4);
    await setStoredLots(placed.id, 2);
    await printLabels(placed, 2);
    const opened = await station.open(context(), request(), {
      code: lotCode(placed.orderNo, 1),
    });
    const sessionId = opened.session.id;
    for (let piece = 0; piece < 3; piece += 1) await scan(sessionId, shirt.barcode);
    await pastReread();
    expect((await scan(sessionId, lotCode(placed.orderNo, 1))).label?.action).toBe('lot_closed');

    // One piece is left, so lot 2 is all there can be.
    expect(
      await refusal(lots.setLotCount(context(), request(), placed.id, { count: 3 })),
    ).toContain('LOT_COUNT_INVALID');
    expect(await storedLots(placed.id)).toBe(2);
  });

  it('cancels pages still queued for the old count, and prints the new ones with no reason', async () => {
    const placed = await seedPieces('confirmed', 2);
    await readyForLabel(placed, '2021-01-01T00:00:00Z');
    await printLabels(placed, 1);
    await withSystem(
      (tx) =>
        tx.execute(sql`
          insert into packing.print_jobs
            (org_id, order_id, order_no, document, lot_no, lot_count, printer_id, terminal_id,
             source, reason, requested_by, consignment_no, state)
          values (${ORG_A}, ${placed.id}, ${placed.orderNo}, 'label', 1, 1, ${printerId},
                  ${terminalId}, 'reprint', 'Torn', ${PERSON}, ${`CN-${placed.orderNo}`}, 'queued')
        `),
      { orgId: ORG_A },
    );
    await withSystem(
      (tx) =>
        tx.execute(sql`
          insert into packing.print_jobs
            (org_id, order_id, order_no, document, lot_no, lot_count, printer_id, terminal_id,
             source, reason, requested_by, consignment_no, state, failed_at, last_error)
          values (${ORG_A}, ${placed.id}, ${placed.orderNo}, 'label', 1, 1, ${printerId},
                  ${terminalId}, 'reprint', 'Jammed', ${PERSON}, ${`CN-${placed.orderNo}`},
                  'failed', now(), 'Out of paper')
        `),
      { orgId: ORG_A },
    );
    await lots.setLotCount(context(), request(), placed.id, { count: 2 });
    expect(await jobsOf(placed.id, 'queued')).toEqual([]);
    expect(await jobsOf(placed.id, 'failed')).toEqual([]);
    expect(await jobsOf(placed.id, 'cancelled')).toEqual([
      { lot_no: 1, lot_count: 1, source: 'reprint' },
      { lot_no: 1, lot_count: 1, source: 'reprint' },
    ]);

    // Through the real route: a page at the new count is new, so no reason is asked (D-818).
    await printing.print(
      context(),
      request(),
      { orderIds: [placed.id], documents: ['label'], printerId },
      null,
    );
    expect(await jobsOf(placed.id, 'queued')).toEqual([
      { lot_no: 1, lot_count: 2, source: 'manual' },
      { lot_no: 2, lot_count: 2, source: 'manual' },
    ]);
  });

  it('marks nothing on an order whose answer at Confirm is simply still to print', async () => {
    const placed = await seedPieces('confirmed', 3);
    await readyForLabel(placed, '2021-01-01T00:00:00Z');
    await lots.setLotCount(context(), request(), placed.id, { count: 3 });
    const ready = await printing.ready(context(), request(), { limit: 100 });
    const row = ready.items.find((item) => item.orderId === placed.id);
    expect(row?.lotCount).toBe(3);
    expect(row?.revised).toBeNull();
  });
});
