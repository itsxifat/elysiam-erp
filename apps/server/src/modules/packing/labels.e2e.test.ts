import { randomUUID } from 'node:crypto';

import { TERMINAL_DEVICE_HEADER } from '@elysium/contracts';
import { withGlobal, withOrg, withSystem } from '@elysium/db';
import { lotCode } from '@elysium/domain/packing';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '../../platform/audit/audit.service.js';
import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import {
  ORG_A,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { COURIER_QUEUE_DEFINITIONS } from '../courier/courier.queues.js';
import { applyCourierMigrations, makeCourier } from '../courier/courier.testing.js';
import { FILES_QUEUE_DEFINITIONS } from '../files/files.queues.js';
import type { GotenbergClient } from '../files/pdf/gotenberg.client.js';
import { IAM_API } from '../iam/iam.api.js';
import { seedProductWithSkus, warehouseId } from '../inventory/inventory.testing.js';
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

/** An order taken and confirmed through the real routes. */
async function confirmedOrder(qty = 1): Promise<{ id: string; orderNo: string }> {
  const created = await call(admin, 'POST', '/v1/orders', {
    channel: 'phone',
    customerId,
    locationId: location,
    courierId,
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

describe('auto-print (M46 check 1, D-817)', () => {
  it('prints a booked order’s label on its terminal’s printer without a click, and logs it', async () => {
    const settings = await call(admin, 'GET', '/v1/labels/settings');
    // ASSUMED default: on once the brand has a printer.
    expect(settings.body).toMatchObject({ autoPrint: true, autoPrintSetting: null, printers: 1 });

    const order = await confirmedOrder();
    const before = sent.length;
    const consignmentNo = await booked(order.id);
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

    // The same booking delivered again queues nothing new (the rule's key).
    await printing.autoPrint(ORG_A, { orderId: order.id, consignmentNo });
    expect(await jobsOf(order.id)).toHaveLength(1);

    // Printed, the order moved on at the hub: out of "Ready for label", into "To pack".
    const ready = await call(admin, 'GET', '/v1/labels/ready');
    expect((ready.body.items as { orderId: string }[]).map((item) => item.orderId)).not.toContain(
      order.id,
    );
    const toPack = await call(admin, 'GET', '/v1/orders?queue=hub_packing&limit=100');
    expect((toPack.body.items as { id: string }[]).map((item) => item.id)).toContain(order.id);
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
    // Warehouse works at terminals; only a supervisor binds a computer.
    const notTheirs = await call(packer, 'POST', `/v1/terminals/${terminalId}/bind`, {
      label: 'Desk PC',
    });
    expect(notTheirs.status).toBe(403);
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
    expect((card?.workingNow as { id: string }[]).map((person) => person.id)).toEqual([
      packer.userId,
    ]);
    expect((card?.cameras as unknown[]).length).toBe(2);
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
