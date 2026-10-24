import { randomUUID } from 'node:crypto';

import { TERMINAL_DEVICE_HEADER } from '@elysium/contracts';
import { withGlobal, withOrg, withSystem } from '@elysium/db';
import { lotCode, lotScanCode, orderScanCode } from '@elysium/domain/packing';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '../../platform/audit/audit.service.js';
import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import {
  ORG_A,
  ORG_B,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { BookingService } from '../courier/booking.service.js';
import { COURIER_QUEUE_DEFINITIONS } from '../courier/courier.queues.js';
import { applyCourierMigrations, makeCourier } from '../courier/courier.testing.js';
import { FILES_QUEUE_DEFINITIONS } from '../files/files.queues.js';
import type { GotenbergClient } from '../files/pdf/gotenberg.client.js';
import { IAM_API } from '../iam/iam.api.js';
import { makeLocation, seedProductWithSkus, warehouseId } from '../inventory/inventory.testing.js';
import { ORDERS_API } from '../orders/orders.api.js';
import { applyOrderMigrations, seedCustomer, seedStockLevel } from '../orders/orders.testing.js';
import { ParcelObserverRegistry } from '../orders/ports/parcel-observer.port.js';
import { PACKING_QUEUE_DEFINITIONS } from './packing.queues.js';
import { registerPackingJobs } from './packing.worker.js';
import { encodePng } from './printers/png.js';
import type { PrinterTransport } from './printers/transport.js';
import { PrintingService } from './printing.service.js';
import { TerminalsService } from './terminals.service.js';
import { PackingVideoService } from './video.service.js';

/**
 * Labels and Packaging on real Postgres (M46 acceptance checks 1 to 5).
 *
 * The worker's print sender runs here for real (pg-boss, the queue's states, the log), with a
 * recording printer on the wire and a stand-in Gotenberg that answers a white page (the real
 * renders are `render.gotenberg.test.ts`'s). Orders are taken, confirmed, packed and shipped
 * through the real routes; a parcel's booking is the courier's observer call in a transaction,
 * as `BookingService.runBooking` makes it.
 *
 * 1. A booked parcel is queued and printed on its terminal's printer without a click, and logged.
 * 2. A reprint needs a reason; the log says how many times, when, by whom and where.
 * 3. An order in three lots prints three labels and slips; packing refuses Finish until every
 *    lot is closed, and the handover (and a person's Ship) until every lot is scanned.
 * 4. People are assigned to terminals; a bound computer opens the terminal's packing with every
 *    camera it has; the terminal says who is working there.
 * 5. Printers only on private LAN addresses, refused again at the moment of sending; no print is
 *    sent with a transaction open.
 */

let harness: HttpHarness;
let jobs: JobsRuntime | undefined;
let admin: RoleClient;
let packer: RoleClient;
let stranger: RoleClient;
let location = '';
let customerId = '';
let courierId = '';
let skuId = '';
let skuCode = '';
let labelTerminalId = '';
let labelPrinterId = '';

interface Sent {
  readonly host: string;
  readonly port: number;
  readonly bytes: Buffer;
  /** Other connections of this database idle inside a transaction while the bytes went. */
  readonly idleInTransaction: number;
}
const sent: Sent[] = [];

async function idleInTransaction(): Promise<number> {
  return withGlobal(async (tx) => {
    const [row] = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()
        and state like 'idle in transaction%'
    `);
    return row?.n ?? 0;
  });
}

const transport: PrinterTransport = {
  async sendRaw(host, port, bytes) {
    sent.push({
      host,
      port,
      bytes: Buffer.from(bytes),
      idleInTransaction: await idleInTransaction(),
    });
  },
  probeRaw: () => Promise.resolve(true),
  ipp: () => Promise.reject(new Error('no IPP printer in this suite')),
};

/** A white page of the asked size with one black square: what the threshold then prints. */
const gotenberg = {
  renderPdf: () => Promise.resolve(new TextEncoder().encode('%PDF-1.7 test page')),
  screenshotPng: (request: { width?: number; height?: number }) => {
    const width = request.width ?? 100;
    const height = request.height ?? 100;
    const data = new Uint8Array(width * height).fill(255);
    for (let y = 10; y < 40; y += 1) for (let x = 10; x < 40; x += 1) data[y * width + x] = 0;
    return Promise.resolve(encodePng({ width, height, channels: 1, data }));
  },
  isReady: () => Promise.resolve(true),
} as unknown as GotenbergClient;

let printing: PrintingService;

type Json = Record<string, unknown>;

async function call(
  actor: RoleClient,
  method: string,
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: Json; text: string }> {
  const response = await actor.client.request(method, url, {
    ...(body === undefined ? {} : { body }),
    ...(headers === undefined ? {} : { headers }),
  });
  let parsed: Json;
  try {
    parsed = response.body === '' ? {} : (JSON.parse(response.body) as Json);
  } catch {
    // A CSV or a PDF answers text, not JSON.
    parsed = {};
  }
  return { status: response.statusCode, body: parsed, text: response.body };
}

async function until(check: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out waiting');
}

/**
 * An order taken and confirmed through the real routes: at the hub's location with the suite's
 * courier, unless `options` names another courier or no location (`null`, as the desk leaves it).
 */
async function confirmedOrder(
  qty = 1,
  options: { readonly courier?: string; readonly location?: string | null } = {},
): Promise<{ id: string; orderNo: string }> {
  const placeAt = options.location === undefined ? location : options.location;
  const created = await call(admin, 'POST', '/v1/orders', {
    channel: 'phone',
    customerId,
    ...(placeAt === null ? {} : { locationId: placeAt }),
    courierId: options.courier ?? courierId,
    deliveryChargePoisha: '6000',
    lines: [{ skuId, qty, unitPricePoisha: '150000' }],
  });
  expect(created.status, created.text).toBe(201);
  const id = String(created.body.id);
  const confirmed = await call(admin, 'POST', `/v1/orders/${id}/confirm`);
  expect(confirmed.status, confirmed.text).toBe(201);
  return { id, orderNo: String(created.body.orderNumber ?? created.body.orderNo) };
}

/** The courier's booking transaction telling packing that the parcel has its consignment. */
async function booked(orderId: string): Promise<string> {
  const consignmentNo = `SF${randomUUID().slice(0, 8).toUpperCase()}`;
  const registry = harness.app.get(ParcelObserverRegistry, { strict: false });
  await withOrg({ orgId: ORG_A, userId: 'usr_courier_worker' }, (tx) =>
    registry.notify(tx, { orgId: ORG_A, orderId, consignmentNo, at: new Date() }),
  );
  return consignmentNo;
}

interface ReadyView {
  readonly orderId: string;
  readonly orderNo: string;
  readonly consignmentNo: string | null;
  readonly courier: string | null;
  readonly lotCount: number;
  readonly labelsPrinted: number;
}

/** The order's row in "Ready for label", or undefined when it is not listed. */
async function readyItem(orderId: string): Promise<ReadyView | undefined> {
  const ready = await call(admin, 'GET', '/v1/labels/ready');
  expect(ready.status, ready.text).toBe(200);
  return (ready.body.items as ReadyView[]).find((item) => item.orderId === orderId);
}

/** What packing keeps for the order (D-914): its consignment, or null while it has none. */
async function labelRow(orderId: string): Promise<{ consignment_no: string | null } | undefined> {
  const [row] = await withSystem(
    (tx) =>
      tx.execute<{ consignment_no: string | null }>(sql`
        select consignment_no from packing.label_orders
        where org_id = ${ORG_A} and order_id = ${orderId}
      `),
    { orgId: ORG_A },
  );
  return row;
}

/** Long enough for the worker (polling every half second) to have run anything queued. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 2_500));

/** The brand's automatic printing rule. */
async function autoPrinting(autoPrint: boolean): Promise<void> {
  const saved = await call(admin, 'PUT', '/v1/labels/settings', { autoPrint, autoSlip: false });
  expect(saved.status, saved.text).toBe(200);
}

/** When the courier is booked (Settings → Order workflow), for the length of `body`. */
async function bookingOn<T>(courierBooking: string, body: () => Promise<T>): Promise<T> {
  const workflow = await call(admin, 'GET', '/v1/orders/workflow-settings');
  const { autoAssign, offerSeconds, maxOpen } = workflow.body as {
    autoAssign: boolean;
    offerSeconds: number;
    maxOpen: number;
  };
  const choose = (policy: string) =>
    call(admin, 'PUT', '/v1/orders/workflow-settings', {
      autoAssign,
      offerSeconds,
      maxOpen,
      courierBooking: policy,
    });
  expect((await choose(courierBooking)).status).toBe(200);
  try {
    return await body();
  } finally {
    // Back to booking by hand, as the rest of the suite expects.
    expect((await choose('manual')).status).toBe(200);
  }
}

interface JobView {
  readonly id: string;
  readonly orderId: string | null;
  readonly document: string;
  readonly lot: number;
  readonly lotCount: number;
  readonly source: string;
  readonly reason: string | null;
  readonly requestedBy: { id: string; name: string | null } | null;
  readonly terminal: { id: string; name: string };
  readonly printer: { id: string; name: string };
  readonly state: string;
  readonly consignmentNo: string | null;
  readonly lastError: string | null;
}

async function jobsOf(orderId: string): Promise<JobView[]> {
  const page = await call(admin, 'GET', `/v1/labels/jobs?orderId=${orderId}&limit=200`);
  expect(page.status, page.text).toBe(200);
  return page.body.items as JobView[];
}

beforeAll(async () => {
  harness = await startHttpHarness('labels-packaging');
  await applyOrderMigrations();
  await applyCourierMigrations();
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues: [
      ...FILES_QUEUE_DEFINITIONS,
      ...PACKING_QUEUE_DEFINITIONS,
      ...COURIER_QUEUE_DEFINITIONS,
    ],
    logger: pino({ level: 'silent' }),
    pollingIntervalSeconds: 0.5,
  });
  printing = new PrintingService(
    harness.app.get(ORDERS_API, { strict: false }),
    harness.app.get(IAM_API, { strict: false }),
    transport,
    gotenberg,
    harness.app.get(TerminalsService, { strict: false }),
    harness.app.get(AuditService, { strict: false }),
  );
  await registerPackingJobs({
    jobs,
    videos: harness.app.get(PackingVideoService, { strict: false }),
    printing,
    report: () => Promise.resolve(),
  });

  admin = await harness.asRole('org_admin', ORG_A);
  packer = await harness.asRole('warehouse', ORG_A);
  stranger = await harness.asRole('warehouse', ORG_A);

  location = await warehouseId(ORG_A);
  customerId = await seedCustomer(ORG_A, { phoneE164: '+8801711987001', name: 'Rahima Akter' });
  const { skus } = await seedProductWithSkus(ORG_A, `lb${randomUUID().slice(0, 6)}`, 1);
  const [sku] = skus;
  if (sku === undefined) throw new Error('no SKU seeded');
  skuId = sku.id;
  skuCode = sku.code;
  await seedStockLevel(ORG_A, { skuId, locationId: location, qty: 200, unitCostPoisha: 40_000n });
  courierId = await makeCourier(ORG_A, 'fake', 'Fake Courier');
  await withSystem(
    (tx) =>
      tx.execute(sql`
        insert into courier.courier_accounts
          (org_id, courier_id, provider_code, label, supports_webhook, verified, is_active)
        values (${ORG_A}, ${courierId}, 'fake', 'Labels courier', true, true, true)
        on conflict (org_id, courier_id) do nothing
      `),
    { orgId: ORG_A },
  );

  // The label desk: one terminal, one thermal label printer on the shop's LAN.
  const terminal = await call(admin, 'POST', '/v1/terminals', { kind: 'label', name: 'Label 1' });
  expect(terminal.status, terminal.text).toBe(201);
  labelTerminalId = String(terminal.body.id);
  const printer = await call(admin, 'POST', '/v1/labels/printers', {
    terminalId: labelTerminalId,
    name: 'Label 1 · TSC',
    connection: 'raw',
    language: 'tspl',
    host: '192.168.250.10',
    port: 9100,
    medium: '4x6',
    documents: ['label', 'packing_slip'],
  });
  expect(printer.status, printer.text).toBe(201);
  labelPrinterId = String(printer.body.id);
  // The minute's probe, now: the printer answers on 9100, so it is online.
  await printing.probeAll();
}, 420_000);

afterAll(async () => {
  await jobs?.stop();
  await harness?.close();
}, 60_000);

describe('auto-print (M46 check 1, D-817, D-914)', () => {
  it('tells the Labels page when the courier is booked (D-908)', async () => {
    await bookingOn('on_confirm', async () => {
      const settings = await call(admin, 'GET', '/v1/labels/settings');
      expect(settings.body).toMatchObject({ courierBooking: 'on_confirm' });
    });
  });

  it('booked on Confirm: waits for the consignment, then prints once with it, without a click', async () => {
    const settings = await call(admin, 'GET', '/v1/labels/settings');
    // ASSUMED default: on once the brand has a printer.
    expect(settings.body).toMatchObject({
      autoPrint: true,
      autoPrintSetting: null,
      printers: 1,
      courierBooking: 'manual',
    });

    await bookingOn('on_confirm', async () => {
      // The suite's courier has an account: the Confirm queues its booking (D-901), so the label
      // waits for the consignment. The order is ready for its label already, not booked yet.
      const order = await confirmedOrder();
      expect(await readyItem(order.id)).toMatchObject({
        orderNo: order.orderNo,
        consignmentNo: null,
      });
      expect(await labelRow(order.id)).toEqual({ consignment_no: null });
      await settle();
      expect(await jobsOf(order.id)).toEqual([]);

      const before = sent.length;
      const consignmentNo = await booked(order.id);
      // The row gains its consignment in the booking's transaction.
      expect(await labelRow(order.id)).toEqual({ consignment_no: consignmentNo });
      await until(async () => (await jobsOf(order.id)).some((job) => job.state === 'printed'));

      const log = await jobsOf(order.id);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        document: 'label',
        lot: 1,
        lotCount: 1,
        source: 'auto',
        requestedBy: null,
        state: 'printed',
        consignmentNo,
        terminal: { id: labelTerminalId, name: 'Label 1' },
        printer: { id: labelPrinterId },
      });
      const wire = sent.slice(before);
      expect(wire).toHaveLength(1);
      expect(wire[0]?.host).toBe('192.168.250.10');
      expect(wire[0]?.port).toBe(9100);
      expect(wire[0]?.bytes.toString('latin1', 0, 40)).toMatch(/^SIZE 101\.6 mm,152\.4 mm\r\nGAP/);
      // Check 5's second half: nothing of this database waited in a transaction while it went.
      expect(wire[0]?.idleInTransaction).toBe(0);

      // The same booking delivered again, a confirm's run with no consignment and a later
      // booking of the same order each queue nothing new (the rule's key, then "printed").
      await printing.autoPrint(ORG_A, { orderId: order.id, consignmentNo });
      await printing.autoPrint(ORG_A, { orderId: order.id, consignmentNo: null });
      await booked(order.id);
      await settle();
      expect(await jobsOf(order.id)).toHaveLength(1);

      // Printed, the order moved on at the hub: out of "Ready for label", into "To pack".
      expect(await readyItem(order.id)).toBeUndefined();
      const toPack = await call(admin, 'GET', '/v1/orders?queue=hub_packing&limit=100');
      expect((toPack.body.items as { id: string }[]).map((item) => item.id)).toContain(order.id);
    });
  });

  it('an own rider’s order, booked by hand: ready on Confirm with no consignment, printed at once', async () => {
    // A courier party with no account here, under the brand's default of booking by hand: no
    // booking job ever brings a consignment back, which is what left these orders unprinted.
    const rider = await makeCourier(ORG_A, 'own_rider', 'Own rider');

    // With automatic printing off, the order waits in "Ready for label" from its Confirm.
    await autoPrinting(false);
    const waiting = await confirmedOrder(1, { courier: rider });
    expect(await readyItem(waiting.id)).toMatchObject({
      orderNo: waiting.orderNo,
      consignmentNo: null,
      courier: null,
      lotCount: 1,
      labelsPrinted: 0,
    });
    await settle();
    expect(await jobsOf(waiting.id)).toEqual([]);

    // With it on, the next one prints on the label terminal's printer without a click.
    await autoPrinting(true);
    const order = await confirmedOrder(1, { courier: rider });
    await until(async () => (await jobsOf(order.id)).some((job) => job.state === 'printed'));
    const log = await jobsOf(order.id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      document: 'label',
      lot: 1,
      source: 'auto',
      requestedBy: null,
      state: 'printed',
      consignmentNo: null,
      terminal: { id: labelTerminalId },
      printer: { id: labelPrinterId },
    });
    expect(await readyItem(order.id)).toBeUndefined();

    // Booked by hand afterwards: the row gains the consignment and nothing prints twice; a
    // second confirm's run does not either.
    const consignmentNo = await booked(order.id);
    expect(await labelRow(order.id)).toEqual({ consignment_no: consignmentNo });
    await printing.autoPrint(ORG_A, { orderId: order.id, consignmentNo: null });
    await settle();
    expect(await jobsOf(order.id)).toHaveLength(1);
  });

  it('booked by hand with a courier that has an account: ready on Confirm, printed once with the consignment after Book now', async () => {
    // The brands with a courier account that book by hand (D-914 review): a label printed on
    // Confirm would stop the one automatic print, so it waits for the consignment Book now brings.
    await autoPrinting(true);
    const order = await confirmedOrder();
    expect(await readyItem(order.id)).toMatchObject({
      orderNo: order.orderNo,
      consignmentNo: null,
    });
    expect(await labelRow(order.id)).toEqual({ consignment_no: null });
    await settle();
    expect(await jobsOf(order.id)).toEqual([]);

    // The desk's Book now queues the booking (the real route); nothing prints while it is out.
    const bookNow = await call(admin, 'POST', '/v1/courier/parcels', { orderId: order.id });
    expect(bookNow.status, bookNow.text).toBeLessThan(300);
    await settle();
    expect(await jobsOf(order.id)).toEqual([]);

    // The booking comes back: the row gains the consignment, and one automatic label carries it.
    const consignmentNo = await booked(order.id);
    expect(await labelRow(order.id)).toEqual({ consignment_no: consignmentNo });
    await until(async () => (await jobsOf(order.id)).some((job) => job.state === 'printed'));
    const log = await jobsOf(order.id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      document: 'label',
      source: 'auto',
      state: 'printed',
      consignmentNo,
      terminal: { id: labelTerminalId },
      printer: { id: labelPrinterId },
    });
    expect(await readyItem(order.id)).toBeUndefined();
  });

  it('an order with no location prints at a label terminal that stands at a location', async () => {
    // The brand's shape: the label terminal is at the hub, the desk's orders name no location and
    // go with an own rider (no account here), so the label prints on Confirm.
    const rider = await makeCourier(ORG_A, 'own_rider', 'Own rider');
    const moved = await call(admin, 'PUT', `/v1/terminals/${labelTerminalId}`, {
      name: 'Label 1',
      locationId: location,
      active: true,
    });
    expect(moved.status, moved.text).toBe(200);
    try {
      await autoPrinting(true);
      const order = await confirmedOrder(1, { courier: rider, location: null });
      const detail = await call(admin, 'GET', `/v1/orders/${order.id}`);
      expect(detail.body.locationId).toBeNull();
      await until(async () => (await jobsOf(order.id)).some((job) => job.state === 'printed'));
      const log = await jobsOf(order.id);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        source: 'auto',
        consignmentNo: null,
        terminal: { id: labelTerminalId },
        printer: { id: labelPrinterId },
      });
    } finally {
      const back = await call(admin, 'PUT', `/v1/terminals/${labelTerminalId}`, {
        name: 'Label 1',
        locationId: null,
        active: true,
      });
      expect(back.status, back.text).toBe(200);
    }
  });

  it('a cancelled order leaves "Ready for label"', async () => {
    await autoPrinting(false);
    try {
      const order = await confirmedOrder();
      expect(await readyItem(order.id)).toMatchObject({ consignmentNo: null });
      const cancelled = await call(admin, 'POST', `/v1/orders/${order.id}/cancel`, {
        reason: 'Buyer changed their mind',
      });
      expect(cancelled.status, cancelled.text).toBeLessThan(300);
      expect(await readyItem(order.id)).toBeUndefined();
    } finally {
      await autoPrinting(true);
    }
  });

  it('a booking that fails for good prints the label without a consignment', async () => {
    await bookingOn('on_confirm', async () => {
      const order = await confirmedOrder();
      await settle();
      expect(await jobsOf(order.id)).toEqual([]);
      const [parcel] = await withSystem(
        (tx) =>
          tx.execute<{ id: string }>(sql`
            select id from courier.consignments where org_id = ${ORG_A} and order_id = ${order.id}
          `),
        { orgId: ORG_A },
      );
      expect(parcel).toBeDefined();
      // What the dead-letter handler and a refusal no retry can change both call (D-914).
      await harness.app.get(BookingService, { strict: false }).reportBookingFailed({
        orgId: ORG_A,
        consignmentId: parcel?.id ?? '',
        code: 'COURIER_REJECTED',
      });
      await until(async () => (await jobsOf(order.id)).some((job) => job.state === 'printed'));
      const log = await jobsOf(order.id);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ source: 'auto', consignmentNo: null, state: 'printed' });
    });
  });
});

describe('reprints and the log (M46 check 2, D-818)', () => {
  it('asks for a reason, then logs how many times, when, by whom and where', async () => {
    const order = await confirmedOrder();
    await booked(order.id);
    await until(async () => (await jobsOf(order.id)).some((job) => job.state === 'printed'));

    const refused = await call(packer, 'POST', '/v1/labels/print', {
      orderIds: [order.id],
      documents: ['label'],
    });
    expect(refused.status, refused.text).toBe(400);
    expect(refused.body.code).toBe('PRINT_REASON_REQUIRED');

    const reprint = await call(packer, 'POST', '/v1/labels/print', {
      orderIds: [order.id],
      documents: ['label'],
      reason: 'Label torn at the table',
    });
    expect(reprint.status, reprint.text).toBe(200);
    await until(async () => (await jobsOf(order.id)).every((job) => job.state === 'printed'));

    const record = await call(admin, 'GET', `/v1/labels/orders/${order.id}`);
    expect(record.status, record.text).toBe(200);
    const lot = (record.body.lots as { label: Json }[])[0];
    expect(lot?.label).toMatchObject({
      count: 2,
      last: { by: 'warehouse', auto: false, terminal: 'Label 1' },
    });
    const log = await jobsOf(order.id);
    expect(log.map((job) => job.source).sort()).toEqual(['auto', 'reprint']);
    expect(log.find((job) => job.source === 'reprint')).toMatchObject({
      reason: 'Label torn at the table',
      requestedBy: { id: packer.userId },
    });

    const csv = await call(admin, 'GET', `/v1/labels/jobs/export?orderId=${order.id}`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Label torn at the table');
    expect(csv.text.split('\r\n')[0]).toContain('requested_by');
    expect(csv.text).toContain(',auto,');
  });
});

describe('lots (M46 check 3, D-805 to D-808)', () => {
  it('prints three slips and labels, and refuses packing and handover until every lot is done', async () => {
    const off = await call(admin, 'PUT', '/v1/labels/settings', {
      autoPrint: false,
      autoSlip: false,
    });
    expect(off.status, off.text).toBe(200);
    const order = await confirmedOrder(3);
    const lots = await call(packer, 'PUT', `/v1/packing/orders/${order.id}/lots`, { count: 3 });
    expect(lots.status, lots.text).toBe(200);
    await booked(order.id);
    // Auto-print is off: the order waits in "Ready for label", three lots unprinted.
    await until(async () => {
      const ready = await call(packer, 'GET', '/v1/labels/ready');
      return (ready.body.items as { orderId: string }[]).some((item) => item.orderId === order.id);
    });
    const ready = await call(packer, 'GET', '/v1/labels/ready');
    expect(
      (ready.body.items as { orderId: string; lotCount: number; labelsPrinted: number }[]).find(
        (item) => item.orderId === order.id,
      ),
    ).toMatchObject({ lotCount: 3, labelsPrinted: 0 });

    const before = sent.length;
    const printed = await call(packer, 'POST', '/v1/labels/print', {
      orderIds: [order.id],
      documents: ['label', 'packing_slip'],
    });
    expect(printed.status, printed.text).toBe(200);
    expect(printed.body.jobs as unknown[]).toHaveLength(6);
    await until(async () => (await jobsOf(order.id)).every((job) => job.state === 'printed'));
    const log = await jobsOf(order.id);
    expect(
      log.map((job) => `${job.document}:${String(job.lot)}/${String(job.lotCount)}`).sort(),
    ).toEqual([
      'label:1/3',
      'label:2/3',
      'label:3/3',
      'packing_slip:1/3',
      'packing_slip:2/3',
      'packing_slip:3/3',
    ]);
    // Six pages went to the printer (three labels, three slips), each its own job.
    expect(sent.length - before).toBe(6);

    // Packing: a lot's code opens the order; every scan goes into the open lot.
    const opened = await call(packer, 'POST', '/v1/packing/sessions', {
      code: lotCode(order.orderNo, 2),
    });
    expect(opened.status, opened.text).toBe(200);
    const sessionId = String((opened.body.session as Json).id);
    expect(opened.body.lots).toMatchObject({ count: 3, open: 1 });
    const scan = (code: string) =>
      call(packer, 'POST', `/v1/packing/sessions/${sessionId}/scans`, {
        scanId: randomUUID(),
        code,
      });
    expect((await scan(skuCode)).body.outcome).toBe('accepted');
    const early = await call(packer, 'POST', `/v1/packing/sessions/${sessionId}/complete`);
    expect(early.status, early.text).toBe(409);
    expect(early.body.code).toBe('PACKING_INCOMPLETE');
    const close = () => call(packer, 'POST', `/v1/packing/sessions/${sessionId}/lots/close`);
    expect((await close()).body.lots).toMatchObject({ open: 2 });
    const empty = await close();
    expect(empty.status).toBe(409);
    expect(empty.body.code).toBe('LOT_CLOSE_REFUSED');
    expect((await scan(skuCode)).body.outcome).toBe('accepted');
    expect((await close()).body.lots).toMatchObject({ open: 3 });
    const third = await scan(skuCode);
    expect((third.body.view as Json).lots).toMatchObject({
      pieces: [
        { lot: 1, pieces: 1 },
        { lot: 2, pieces: 1 },
        { lot: 3, pieces: 1 },
      ],
    });
    const done = await call(packer, 'POST', `/v1/packing/sessions/${sessionId}/complete`);
    expect(done.status, done.text).toBe(200);
    expect(done.body.order).toMatchObject({ status: 'packed' });
    expect((done.body.lots as { closed: unknown[] }).closed).toHaveLength(3);

    // The handover: every lot's label, each once.
    const tooSoon = await call(packer, 'POST', '/v1/packing/handover', { orderIds: [order.id] });
    expect(tooSoon.body).toMatchObject({
      moved: 0,
      results: [{ id: order.id, ok: false, code: 'ORDER_LOTS_NOT_HANDED' }],
    });
    const hand = (code: string) => call(packer, 'POST', '/v1/packing/handover/scans', { code });
    expect((await hand(lotCode(order.orderNo, 1))).body.outcome).toBe('accepted');
    expect((await hand(lotCode(order.orderNo, 1))).body.outcome).toBe('already');
    expect((await hand(lotCode(order.orderNo, 3))).body).toMatchObject({
      outcome: 'accepted',
      order: { missing: [2], complete: false },
    });
    const plain = await hand(order.orderNo);
    expect(plain.status).toBe(409);
    expect(plain.body.code).toBe('ORDER_LOTS_NOT_HANDED');
    // A person's Ship from the order page is refused the same way.
    const ship = await call(admin, 'POST', `/v1/orders/${order.id}/ship`, {});
    expect(ship.status, ship.text).toBe(409);
    expect(ship.body.code).toBe('ORDER_LOTS_NOT_HANDED');
    // The count is fixed once the handover started.
    const relot = await call(packer, 'PUT', `/v1/packing/orders/${order.id}/lots`, { count: 2 });
    expect(relot.status).toBe(409);
    expect(relot.body.code).toBe('LOTS_LOCKED');

    expect((await hand(lotCode(order.orderNo, 2))).body).toMatchObject({
      order: { missing: [], complete: true },
    });
    const shipped = await call(packer, 'POST', '/v1/packing/handover', { orderIds: [order.id] });
    expect(shipped.body).toMatchObject({ moved: 1, results: [{ id: order.id, ok: true }] });
    const after = await call(admin, 'GET', `/v1/orders/${order.id}`);
    expect(after.body.status).toBe('shipped');
  });
});

/** A parcel booked for the order under the codes a test chooses, as the booking worker leaves one. */
async function parcelWith(
  orderId: string,
  codes: { readonly consignmentNo: string; readonly trackingCode: string | null },
): Promise<void> {
  await withSystem(
    (tx) =>
      tx.execute(sql`
        insert into courier.consignments
          (org_id, order_id, courier_account_id, courier_id, branch_id, consignment_no,
           tracking_code, reference, booking_state, status, cod_amount_poisha, booked_at,
           created_by)
        select ${ORG_A}, o.id, a.id, ${courierId}, o.branch_id, ${codes.consignmentNo},
               ${codes.trackingCode}, o.order_no, 'booked', 'booked', o.cod_amount_poisha, now(),
               'usr_labels_test'
        from sales.orders o
        join courier.courier_accounts a on a.org_id = o.org_id and a.courier_id = ${courierId}
        where o.org_id = ${ORG_A} and o.id = ${orderId}
      `),
    { orgId: ORG_A },
  );
}

describe('the digits-only codes (D-912)', () => {
  /** Pack an order of `lots` pieces in `lots` bags at the station, opened from `code`. */
  async function packIn(order: { id: string }, lots: number, code: string): Promise<void> {
    if (lots > 1) {
      const set = await call(packer, 'PUT', `/v1/packing/orders/${order.id}/lots`, { count: lots });
      expect(set.status, set.text).toBe(200);
    }
    const opened = await call(packer, 'POST', '/v1/packing/sessions', { code });
    expect(opened.status, opened.text).toBe(200);
    expect((opened.body.session as Json).orderId).toBe(order.id);
    const sessionId = String((opened.body.session as Json).id);
    for (let lot = 1; lot <= lots; lot += 1) {
      const scanned = await call(packer, 'POST', `/v1/packing/sessions/${sessionId}/scans`, {
        scanId: randomUUID(),
        code: skuCode,
      });
      expect(scanned.body.outcome, scanned.text).toBe('accepted');
      if (lot < lots) {
        const closed = await call(packer, 'POST', `/v1/packing/sessions/${sessionId}/lots/close`);
        expect(closed.status, closed.text).toBe(200);
      }
    }
    const done = await call(packer, 'POST', `/v1/packing/sessions/${sessionId}/complete`);
    expect(done.status, done.text).toBe(200);
    expect(done.body.order).toMatchObject({ status: 'packed' });
  }

  const hand = (code: string) => call(packer, 'POST', '/v1/packing/handover/scans', { code });

  it('counts each lot from its twelve digits at the handover and ships when the last is scanned', async () => {
    const off = await call(admin, 'PUT', '/v1/labels/settings', {
      autoPrint: false,
      autoSlip: false,
    });
    expect(off.status, off.text).toBe(200);
    const order = await confirmedOrder(2);
    await booked(order.id);
    const digits = orderScanCode(order.orderNo) ?? '';
    const lot = (no: number) => lotScanCode(order.orderNo, no) ?? '';
    expect(digits).toMatch(/^\d{10}$/);
    expect(lot(2)).toBe(`${digits}02`);
    // The packing station opens the order from a lot's twelve digits.
    await packIn(order, 2, lot(2));

    expect((await hand(lot(1))).body).toMatchObject({
      outcome: 'accepted',
      order: { orderId: order.id, lotCount: 2, missing: [2], complete: false },
    });
    // The same lot's label from before (`…-L1`) is the same lot: scanned already.
    expect((await hand(lotCode(order.orderNo, 1))).body.outcome).toBe('already');
    // The order's ten digits name the order but not which of its two bags.
    const plain = await hand(digits);
    expect(plain.status, plain.text).toBe(409);
    expect(plain.body.code).toBe('ORDER_LOTS_NOT_HANDED');
    // A lot it does not have.
    const third = await hand(lot(3));
    expect(third.status, third.text).toBe(409);
    expect(third.body.code).toBe('ORDER_LOTS_NOT_HANDED');
    // The last lot, from a scanner that sends its symbology prefix first: complete.
    expect((await hand(`]C0${lot(2)}`)).body).toMatchObject({
      outcome: 'accepted',
      order: { orderId: order.id, missing: [], complete: true, courier: 'Fake Courier' },
    });
    // The courier portal ships an order once its last lot is scanned (D-904).
    const shipped = await call(packer, 'POST', '/v1/packing/handover', { orderIds: [order.id] });
    expect(shipped.body).toMatchObject({ moved: 1, results: [{ id: order.id, ok: true }] });
    expect((await call(admin, 'GET', `/v1/orders/${order.id}`)).body.status).toBe('shipped');
    const again = await hand(lot(2));
    expect(again.status, again.text).toBe(409);
    expect(again.body.code).toBe('ORDER_ALREADY_HANDED');
  });

  it('hands an order in one bag over by its ten digits, by its number, and refuses digits of no order', async () => {
    const byDigits = await confirmedOrder();
    const byNumber = await confirmedOrder();
    await booked(byDigits.id);
    await booked(byNumber.id);
    const digits = orderScanCode(byDigits.orderNo) ?? '';
    await packIn(byDigits, 1, digits);
    await packIn(byNumber, 1, byNumber.orderNo);
    expect((await hand(digits)).body).toMatchObject({
      outcome: 'accepted',
      order: { orderId: byDigits.id, lotCount: 1, missing: [], complete: true },
    });
    expect((await hand(byNumber.orderNo)).body).toMatchObject({
      outcome: 'accepted',
      order: { orderId: byNumber.id, complete: true },
    });
    // An order in one bag: its lot 1's twelve digits are its one label too.
    expect((await hand(lotScanCode(byDigits.orderNo, 1) ?? '')).body.outcome).toBe('already');
    const shipped = await call(packer, 'POST', '/v1/packing/handover', {
      orderIds: [byDigits.id, byNumber.id],
    });
    expect(shipped.body).toMatchObject({ moved: 2 });

    // Digits that name no order: a counter not reached, and a lot of it.
    for (const code of [`${digits.slice(0, 4)}999999`, `${digits.slice(0, 4)}99999902`]) {
      const refused = await hand(code);
      expect(refused.status, code).toBe(404);
      expect(refused.body.code, code).toBe('SHIPMENT_NOT_FOUND');
    }
  });

  it('reads ten digits as an order’s own code before a courier’s, and a courier’s digits that name no order as before', async () => {
    const ours = await confirmedOrder();
    const theirs = await confirmedOrder();
    const plain = await confirmedOrder();
    const digits = orderScanCode(ours.orderNo) ?? '';
    const period = digits.slice(0, 4);
    // Another order's parcel under a consignment number that is this order's code, and a
    // tracking code of twelve digits that reads as a lot of no order.
    await parcelWith(theirs.id, { consignmentNo: digits, trackingCode: `${period}99999702` });
    // A consignment number of ten digits that is no order's code.
    await parcelWith(plain.id, { consignmentNo: `${period}999998`, trackingCode: null });
    const opens = async (code: string) => {
      const opened = await call(packer, 'POST', '/v1/packing/sessions', { code });
      expect(opened.status, `${code}: ${opened.text}`).toBe(200);
      return (opened.body.session as Json).orderId;
    };
    // The order's own code wins: it is what this ERP prints in every slip's and label's bars.
    expect(await opens(digits)).toBe(ours.id);
    expect(await opens(`${digits}01`)).toBe(ours.id);
    // A courier's code is found as it always was when it names no order.
    expect(await opens(`${period}99999702`)).toBe(theirs.id);
    expect(await opens(`${period}999998`)).toBe(plain.id);
  });

  /*
   * A scanner types into whichever search box has focus. Each search finds the order from the
   * codes its labels and slips carry: its ten digits, a lot's twelve, a lot's code from before
   * (`…-L2`), and its number as it always did.
   */
  const scans = (orderNo: string): string[] => [
    orderScanCode(orderNo) ?? '',
    lotScanCode(orderNo, 1) ?? '',
    lotScanCode(orderNo, 2) ?? '',
    lotCode(orderNo, 2),
    orderNo,
  ];
  /** Ten digits in the order's month that name no order. */
  const noOrder = (orderNo: string): string =>
    `${(orderScanCode(orderNo) ?? '').slice(0, 4)}999999`;

  it('finds the order in the Orders search from the digits a scanner types', async () => {
    const order = await confirmedOrder();
    const other = await confirmedOrder();
    const found = async (q: string) => {
      const page = await call(admin, 'GET', `/v1/orders?q=${encodeURIComponent(q)}&limit=100`);
      expect(page.status, page.text).toBe(200);
      return (page.body.items as { id: string }[]).map((item) => item.id);
    };
    for (const q of scans(order.orderNo)) expect(await found(q), q).toEqual([order.id]);
    expect(await found(orderScanCode(other.orderNo) ?? '')).toEqual([other.id]);
    expect(await found(noOrder(order.orderNo))).toEqual([]);
  });

  it('finds the order’s prints in the Labels log from the digits a scanner types', async () => {
    const off = await call(admin, 'PUT', '/v1/labels/settings', {
      autoPrint: false,
      autoSlip: false,
    });
    expect(off.status, off.text).toBe(200);
    const order = await confirmedOrder();
    const other = await confirmedOrder();
    for (const each of [order, other]) {
      await booked(each.id);
      const printed = await call(packer, 'POST', '/v1/labels/print', {
        orderIds: [each.id],
        documents: ['label'],
      });
      expect(printed.status, printed.text).toBe(200);
      await until(async () => (await jobsOf(each.id)).every((job) => job.state === 'printed'));
    }
    const found = async (q: string) => {
      const page = await call(
        admin,
        'GET',
        `/v1/labels/jobs?view=log&q=${encodeURIComponent(q)}&limit=200`,
      );
      expect(page.status, page.text).toBe(200);
      return [...new Set((page.body.items as JobView[]).map((job) => job.orderId))];
    };
    for (const q of scans(order.orderNo)) expect(await found(q), q).toEqual([order.id]);
    expect(await found(orderScanCode(other.orderNo) ?? '')).toEqual([other.id]);
    expect(await found(noOrder(order.orderNo))).toEqual([]);
  });

  it('finds the order’s parcel in the Parcels search from the digits a scanner types', async () => {
    const order = await confirmedOrder();
    const other = await confirmedOrder();
    const consignmentNo = `SF${randomUUID().slice(0, 8).toUpperCase()}`;
    await parcelWith(order.id, { consignmentNo, trackingCode: null });
    await parcelWith(other.id, {
      consignmentNo: `SF${randomUUID().slice(0, 8).toUpperCase()}`,
      trackingCode: null,
    });
    const found = async (q: string) => {
      const page = await call(
        admin,
        'GET',
        `/v1/courier/parcels?q=${encodeURIComponent(q)}&pageSize=200`,
      );
      expect(page.status, page.text).toBe(200);
      return (page.body.items as { orderId: string }[]).map((item) => item.orderId);
    };
    // The courier's own number still finds its parcel.
    for (const q of [...scans(order.orderNo), consignmentNo]) {
      expect(await found(q), q).toEqual([order.id]);
    }
    expect(await found(orderScanCode(other.orderNo) ?? '')).toEqual([other.id]);
    expect(await found(noOrder(order.orderNo))).toEqual([]);
  });
});

describe('terminals (M46 check 4, D-801 to D-804)', () => {
  it('assigns people, binds a computer, films with every camera and shows who works there', async () => {
    const terminal = await call(admin, 'POST', '/v1/terminals', {
      kind: 'packing',
      name: 'Packing 1',
      locationId: location,
    });
    expect(terminal.status, terminal.text).toBe(201);
    const terminalId = String(terminal.body.id);
    const cameraIds: string[] = [];
    for (const name of ['Cam A', 'Cam B']) {
      const camera = await call(admin, 'POST', '/v1/packing/cameras', {
        name: `${name} ${randomUUID().slice(0, 4)}`,
        rtspUrl: `rtsp://192.0.2.${String(20 + cameraIds.length)}:554/stream1`,
        enabled: true,
      });
      expect(camera.status, camera.text).toBe(201);
      cameraIds.push(String(camera.body.id));
    }
    expect(
      (await call(admin, 'PUT', `/v1/terminals/${terminalId}/cameras`, { cameraIds })).status,
    ).toBe(200);
    expect(
      (
        await call(admin, 'PUT', `/v1/terminals/${terminalId}/members`, {
          userIds: [packer.userId],
        })
      ).status,
    ).toBe(200);
    // D-910: someone assigned to the terminal binds their own computer to it; nobody else does.
    const notTheirs = await call(stranger, 'POST', `/v1/terminals/${terminalId}/bind`, {
      label: 'Desk PC',
    });
    expect(notTheirs.status, notTheirs.text).toBe(403);
    expect(notTheirs.body.code).toBe('TERMINAL_NOT_ASSIGNED');
    const theirOwn = await call(packer, 'POST', `/v1/terminals/${terminalId}/bind`, {
      label: 'Packer PC',
    });
    expect(theirOwn.status, theirOwn.text).toBe(200);
    const ownDevice = { [TERMINAL_DEVICE_HEADER]: String(theirOwn.body.token) };
    expect(
      (await call(packer, 'POST', '/v1/terminals/check-in', undefined, ownDevice)).body,
    ).toMatchObject({ assigned: true, terminal: { name: 'Packing 1' } });
    const bound = await call(admin, 'POST', `/v1/terminals/${terminalId}/bind`, {
      label: 'Desk PC',
    });
    expect(bound.status, bound.text).toBe(200);
    const device = { [TERMINAL_DEVICE_HEADER]: String(bound.body.token) };

    // Someone not assigned there signs in at that computer: told, and refused its work.
    const strangerIn = await call(stranger, 'POST', '/v1/terminals/check-in', undefined, device);
    expect(strangerIn.body).toMatchObject({ assigned: false, terminal: { name: 'Packing 1' } });
    const order = await confirmedOrder();
    const refused = await call(
      stranger,
      'POST',
      '/v1/packing/sessions',
      { orderId: order.id },
      device,
    );
    expect(refused.status, refused.text).toBe(403);
    expect(refused.body.code).toBe('TERMINAL_NOT_ASSIGNED');

    const packerIn = await call(packer, 'POST', '/v1/terminals/check-in', undefined, device);
    expect(packerIn.body).toMatchObject({ assigned: true });
    const opened = await call(
      packer,
      'POST',
      '/v1/packing/sessions',
      { orderId: order.id },
      device,
    );
    expect(opened.status, opened.text).toBe(200);
    const sessionId = String((opened.body.session as Json).id);
    expect(opened.body.terminal).toMatchObject({ id: terminalId, name: 'Packing 1' });
    expect([...(opened.body.cameraIds as string[])].sort()).toEqual([...cameraIds].sort());
    const scanned = await call(
      packer,
      'POST',
      `/v1/packing/sessions/${sessionId}/scans`,
      { scanId: randomUUID(), code: skuCode },
      device,
    );
    expect(((scanned.body.view as Json).session as Json).recordingFrom).not.toBeNull();
    const done = await call(packer, 'POST', `/v1/packing/sessions/${sessionId}/complete`);
    expect(done.status, done.text).toBe(200);
    expect((done.body.session as Json).recordingTo).not.toBeNull();

    const live = await call(admin, 'GET', '/v1/terminals');
    const card = (live.body.terminals as Json[]).find((one) => one.id === terminalId);
    expect(card).toMatchObject({
      members: [{ id: packer.userId }],
      packedToday: 1,
    });
    // One row a computer: the packer is signed in at the supervisor's and at their own (D-910).
    const working = card?.workingNow as { id: string; deviceLabel: string }[];
    expect([...new Set(working.map((person) => person.id))]).toEqual([packer.userId]);
    expect(working.map((person) => person.deviceLabel).sort()).toEqual(['Desk PC', 'Packer PC']);
    expect((card?.cameras as unknown[]).length).toBe(2);
  });
});

describe('moving a bound computer (D-910)', () => {
  it('only a supervisor, or someone assigned where it is bound now, moves it; the old binding stops', async () => {
    const make = async (name: string) => {
      const made = await call(admin, 'POST', '/v1/terminals', { kind: 'label', name });
      expect(made.status, made.text).toBe(201);
      return String(made.body.id);
    };
    const firstName = `Desk A ${randomUUID().slice(0, 4)}`;
    const first = await make(firstName);
    const second = await make(`Desk B ${randomUUID().slice(0, 4)}`);
    const assign = async (terminal: string, userIds: string[]) =>
      expect(
        (await call(admin, 'PUT', `/v1/terminals/${terminal}/members`, { userIds })).status,
      ).toBe(200);
    await assign(second, [packer.userId]);
    const bound = await call(admin, 'POST', `/v1/terminals/${first}/bind`, { label: 'Shared PC' });
    expect(bound.status, bound.text).toBe(200);
    const shared = { [TERMINAL_DEVICE_HEADER]: String(bound.body.token) };

    // Assigned to the second, not to the first it is bound to: refused, and it stays the first.
    const taken = await call(
      packer,
      'POST',
      `/v1/terminals/${second}/bind`,
      { label: 'Shared PC' },
      shared,
    );
    expect(taken.status, taken.text).toBe(403);
    expect(taken.body.code).toBe('TERMINAL_NOT_ASSIGNED');
    expect(
      (await call(admin, 'POST', '/v1/terminals/check-in', undefined, shared)).body,
    ).toMatchObject({ terminal: { name: firstName } });

    // Assigned to both: moved, and the old binding stops at once, leaving no dead computer.
    await assign(first, [packer.userId]);
    const moved = await call(
      packer,
      'POST',
      `/v1/terminals/${second}/bind`,
      { label: 'Shared PC' },
      shared,
    );
    expect(moved.status, moved.text).toBe(200);
    const old = await call(admin, 'POST', '/v1/terminals/check-in', undefined, shared);
    expect(old.status, old.text).toBe(404);
    expect(old.body.code).toBe('TERMINAL_DEVICE_INVALID');
    const cards = (await call(admin, 'GET', '/v1/terminals')).body.terminals as Json[];
    expect(cards.find((card) => card.id === first)?.devices).toEqual([]);
    expect(
      (cards.find((card) => card.id === second)?.devices as Json[]).map((device) => device.label),
    ).toEqual(['Shared PC']);
  });
});

describe('a terminal’s location (D-621)', () => {
  it('is in use while a terminal stands at it: the delete answers why, not a foreign-key error', async () => {
    const place = await makeLocation(ORG_A, {
      code: `HUB-${randomUUID().slice(0, 4).toUpperCase()}`,
      name: 'Second hub',
      kind: 'warehouse',
    });
    const terminal = await call(admin, 'POST', '/v1/terminals', {
      kind: 'label',
      name: `Label at ${place.slice(0, 4)}`,
      locationId: place,
    });
    expect(terminal.status, terminal.text).toBe(201);
    const usage = await call(admin, 'GET', `/v1/inventory/locations/${place}/usage`);
    expect(usage.status, usage.text).toBe(200);
    expect(usage.body.canDelete).toBe(false);
    expect(usage.body.uses).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'packing_terminals', count: 1 })]),
    );
    const refused = await call(admin, 'DELETE', `/v1/inventory/locations/${place}`);
    expect(refused.status, refused.text).toBe(409);
  });
});

describe('where prints go (M46 check 5, D-812, D-813)', () => {
  it('takes only private LAN addresses, and refuses the server’s own networks when sending', async () => {
    for (const host of ['8.8.8.8', '127.0.0.1', 'printer.lan', '169.254.169.254']) {
      const refused = await call(admin, 'POST', '/v1/labels/printers', {
        terminalId: labelTerminalId,
        name: `Bad ${host}`,
        connection: 'raw',
        language: 'zpl',
        host,
        medium: '4x6',
        documents: ['label'],
      });
      expect(refused.status, host).toBe(400);
    }
    // 172.17.0.0/16 is a private range the form takes, and Docker's default bridge the worker
    // refuses: the job fails at once, with that reason, and the label team is told.
    const terminal = await call(admin, 'POST', '/v1/terminals', { kind: 'label', name: 'Label 9' });
    const bridge = await call(admin, 'POST', '/v1/labels/printers', {
      terminalId: String(terminal.body.id),
      name: 'On the bridge',
      connection: 'raw',
      language: 'zpl',
      host: '172.17.0.5',
      medium: '4x6',
      documents: ['label'],
    });
    expect(bridge.status, bridge.text).toBe(201);
    const order = await confirmedOrder();
    const before = sent.length;
    const printed = await call(admin, 'POST', '/v1/labels/print', {
      orderIds: [order.id],
      documents: ['label'],
      printerId: String(bridge.body.id),
    });
    expect(printed.status, printed.text).toBe(200);
    await until(async () => (await jobsOf(order.id)).some((job) => job.state === 'failed'));
    const [job] = await jobsOf(order.id);
    expect(job?.lastError).toMatch(/server’s own network/);
    expect(sent.length).toBe(before);
    const events = await withSystem(
      (tx) =>
        tx.execute<{ n: number }>(sql`
          select count(*)::int as n from events.outbox
          where org_id = ${ORG_A} and name = 'labels.job_changed'
            and payload->>'jobId' = ${job?.id ?? ''} and payload->>'state' = 'failed'
        `),
      { orgId: ORG_A },
    );
    expect(events[0]?.n).toBe(1);
  });
});

/** An order taken, confirmed, put in `lots` lots, packed lot by lot and every lot scanned out. */
async function packedAndScanned(lots: number): Promise<{ id: string; orderNo: string }> {
  const order = await confirmedOrder(lots);
  expect(
    (await call(packer, 'PUT', `/v1/packing/orders/${order.id}/lots`, { count: lots })).status,
  ).toBe(200);
  const opened = await call(packer, 'POST', '/v1/packing/sessions', { orderId: order.id });
  const sessionId = String((opened.body.session as Json).id);
  for (let lot = 1; lot <= lots; lot += 1) {
    const scanned = await call(packer, 'POST', `/v1/packing/sessions/${sessionId}/scans`, {
      scanId: randomUUID(),
      code: skuCode,
    });
    expect(scanned.body.outcome).toBe('accepted');
    if (lot < lots) {
      expect(
        (await call(packer, 'POST', `/v1/packing/sessions/${sessionId}/lots/close`)).status,
      ).toBe(200);
    }
  }
  const done = await call(packer, 'POST', `/v1/packing/sessions/${sessionId}/complete`);
  expect(done.status, done.text).toBe(200);
  for (let lot = 1; lot <= lots; lot += 1) {
    const scan = await call(packer, 'POST', '/v1/packing/handover/scans', {
      code: lotCode(order.orderNo, lot),
    });
    expect(scan.status, scan.text).toBe(200);
  }
  return order;
}

describe('after the ledger audit (W1 to W4, N7)', () => {
  it('W1: the order page’s Ship and the handover racing on one order never deadlock', async () => {
    const order = await packedAndScanned(2);
    const [page, desk] = await Promise.all([
      call(admin, 'POST', `/v1/orders/${order.id}/ship`, {}),
      call(packer, 'POST', '/v1/packing/handover', { orderIds: [order.id] }),
    ]);
    expect(page.status, page.text).toBeLessThan(500);
    expect(desk.status, desk.text).toBe(200);
    const shippedByPage = page.status < 300;
    const shippedByDesk = (desk.body.results as { ok: boolean }[])[0]?.ok === true;
    // Exactly one of them moved it; the other was told it already moved.
    expect(Number(shippedByPage) + Number(shippedByDesk)).toBe(1);
    expect((await call(admin, 'GET', `/v1/orders/${order.id}`)).body.status).toBe('shipped');
  });

  it('W3: a second press of Print before the first prints is a reprint and needs a reason', async () => {
    await call(admin, 'PUT', '/v1/labels/settings', { autoPrint: false, autoSlip: false });
    const order = await confirmedOrder();
    const first = await call(packer, 'POST', '/v1/labels/print', {
      orderIds: [order.id],
      documents: ['label'],
    });
    expect(first.status, first.text).toBe(200);
    const second = await call(packer, 'POST', '/v1/labels/print', {
      orderIds: [order.id],
      documents: ['label'],
    });
    expect(second.status, second.text).toBe(400);
    expect(second.body.code).toBe('PRINT_REASON_REQUIRED');
  });

  it('W4: a packed order never goes in fewer lots than it was packed in', async () => {
    const order = await confirmedOrder(3);
    await call(packer, 'PUT', `/v1/packing/orders/${order.id}/lots`, { count: 3 });
    const opened = await call(packer, 'POST', '/v1/packing/sessions', { orderId: order.id });
    const sessionId = String((opened.body.session as Json).id);
    for (let lot = 1; lot <= 3; lot += 1) {
      await call(packer, 'POST', `/v1/packing/sessions/${sessionId}/scans`, {
        scanId: randomUUID(),
        code: skuCode,
      });
      // N1: while packing, the count must leave a lot open after the closed ones.
      if (lot === 2) {
        const closeAll = await call(packer, 'PUT', `/v1/packing/orders/${order.id}/lots`, {
          count: 1,
        });
        expect(closeAll.status).toBe(409);
        expect(closeAll.body.code).toBe('LOTS_LOCKED');
      }
      if (lot < 3) await call(packer, 'POST', `/v1/packing/sessions/${sessionId}/lots/close`);
    }
    expect((await call(packer, 'POST', `/v1/packing/sessions/${sessionId}/complete`)).status).toBe(
      200,
    );
    const fewer = await call(packer, 'PUT', `/v1/packing/orders/${order.id}/lots`, { count: 1 });
    expect(fewer.status, fewer.text).toBe(409);
    expect(fewer.body.code).toBe('LOTS_LOCKED');
    // Splitting a packed order into one bag more is still allowed (it then needs four scans).
    const more = await call(packer, 'PUT', `/v1/packing/orders/${order.id}/lots`, { count: 4 });
    expect(more.status, more.text).toBe(200);
  });

  it('W2: a print station finishes only a browser job it claimed itself', async () => {
    const terminal = await call(admin, 'POST', '/v1/terminals', {
      kind: 'label',
      name: `Station ${randomUUID().slice(0, 4)}`,
    });
    const terminalId = String(terminal.body.id);
    const browser = await call(admin, 'POST', '/v1/labels/printers', {
      terminalId,
      name: `Browser ${randomUUID().slice(0, 4)}`,
      connection: 'browser',
      language: 'pdf',
      medium: '4x6',
      documents: ['label'],
    });
    expect(browser.status, browser.text).toBe(201);
    const raw = await call(admin, 'POST', '/v1/labels/printers', {
      terminalId,
      name: `Raw ${randomUUID().slice(0, 4)}`,
      connection: 'raw',
      language: 'zpl',
      host: '172.17.0.9',
      medium: '4x6',
      documents: ['label'],
    });
    const bound = await call(admin, 'POST', `/v1/terminals/${terminalId}/bind`, {
      label: 'Station PC',
    });
    const device = { [TERMINAL_DEVICE_HEADER]: String(bound.body.token) };
    const order = await confirmedOrder();
    const onBrowser = await call(admin, 'POST', '/v1/labels/print', {
      orderIds: [order.id],
      documents: ['label'],
      printerId: String(browser.body.id),
    });
    const browserJob = String((onBrowser.body.jobs as { id: string }[])[0]?.id);
    const listed = await call(admin, 'GET', '/v1/labels/station/jobs', undefined, device);
    expect((listed.body.items as { id: string }[]).map((job) => job.id)).toContain(browserJob);
    // Not claimed (its page never fetched): no result is taken for it.
    const unclaimed = await call(
      admin,
      'POST',
      `/v1/labels/station/jobs/${browserJob}/result`,
      { result: 'printed' },
      device,
    );
    expect(unclaimed.status, unclaimed.text).toBe(409);
    expect(unclaimed.body.code).toBe('PRINT_JOB_STATE');
    // A network printer's job is never the station's to finish.
    const other = await confirmedOrder();
    const onRaw = await call(admin, 'POST', '/v1/labels/print', {
      orderIds: [other.id],
      documents: ['label'],
      printerId: String(raw.body.id),
    });
    const rawJob = String((onRaw.body.jobs as { id: string }[])[0]?.id);
    const refused = await call(
      admin,
      'POST',
      `/v1/labels/station/jobs/${rawJob}/result`,
      { result: 'printed' },
      device,
    );
    expect(refused.status, refused.text).toBe(404);
  });

  it('N7: a sales agent reaches no other agent’s order’s prints or lots; a token of another brand is no binding', async () => {
    const sales = await harness.asRole('sales', ORG_A);
    const order = await confirmedOrder();
    for (const [method, url, body] of [
      ['POST', '/v1/labels/print', { orderIds: [order.id], documents: ['label'] }],
      ['PUT', `/v1/packing/orders/${order.id}/lots`, { count: 2 }],
      ['POST', '/v1/packing/handover', { orderIds: [order.id] }],
    ] as const) {
      const answer = await call(sales, method, url, body);
      if (url === '/v1/packing/handover') {
        expect(answer.body).toMatchObject({
          moved: 0,
          results: [{ ok: false, code: 'NOT_FOUND' }],
        });
      } else {
        expect(answer.status, `${method} ${url}`).toBe(404);
      }
    }
    // The order page's print record follows the order's own visibility (an unassigned order is
    // in the sales queue, D-725): the same answer as the order itself.
    const record = await call(sales, 'GET', `/v1/labels/orders/${order.id}`);
    const itself = await call(sales, 'GET', `/v1/orders/${order.id}`);
    expect(record.status).toBe(itself.status);
    const log = await call(sales, 'GET', `/v1/labels/jobs?orderId=${order.id}`);
    expect(log.body.items).toEqual([]);

    const otherAdmin = await harness.asRole('org_admin', ORG_B);
    const theirs = await call(otherAdmin, 'POST', '/v1/terminals', {
      kind: 'label',
      name: 'Their label desk',
    });
    expect(theirs.status, theirs.text).toBe(201);
    const theirToken = await call(
      otherAdmin,
      'POST',
      `/v1/terminals/${String(theirs.body.id)}/bind`,
      {
        label: 'Their PC',
      },
    );
    const crossed = await call(admin, 'POST', '/v1/terminals/check-in', undefined, {
      [TERMINAL_DEVICE_HEADER]: String(theirToken.body.token),
    });
    expect(crossed.status).toBe(404);
    expect(crossed.body.code).toBe('TERMINAL_DEVICE_INVALID');
  });
});
