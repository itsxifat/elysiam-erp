import { randomUUID } from 'node:crypto';

import { withGlobal, withSystem } from '@elysium/db';
import { internalEan13 } from '@elysium/domain/barcode';
import { lotCode } from '@elysium/domain/packing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { attachScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ORG_A, startHttpHarness, type HttpHarness } from '../../testing/http-harness.js';
import { seedProductWithSkus } from '../inventory/inventory.testing.js';
import { applyOrderMigrations, seedCustomer, seedOrder } from '../orders/orders.testing.js';
import { ReturnStationService } from './return-station.service.js';
import { PackStationService } from './station.service.js';

/**
 * Label to label on real Postgres (M51, D-930 to D-934).
 *
 * 1. A piece before the label is refused; the order's label starts lot 1's recording at the
 *    label scan's own instant; the label again stops it and finishes the order (packed).
 * 2. An order in two lots: lot 2's label is refused while lot 1 is open; lot 1's label again
 *    closes it and stops its recording; lot 2 starts at its own label; the last label finishes.
 * 3. The database holds the recording: none without its lot's label scan, a stop set once, a
 *    video part only of its own lot's recording.
 * 4. The return station: the returned parcel's label starts a bag's recording, a piece that did
 *    not go out is refused, the label again stops it.
 */

const PACKER = `usr_m51_${randomUUID().slice(0, 8)}`;
const suffix = randomUUID().slice(0, 6);

let harness: HttpHarness;
let station: PackStationService;
let returns: ReturnStationService;
let customerId = '';
let shirt: { id: string; code: string; barcode: string };
let cap: { id: string; code: string; barcode: string };
let stranger: { id: string; code: string; barcode: string };

function request(): AuditableRequest {
  const value = {} as AuditableRequest;
  attachScope(value, 'update', 'Order', { kind: 'all' });
  return value;
}

function context(): ActiveContext {
  return {
    orgId: ORG_A,
    userId: PACKER,
    isSuperAdmin: false,
    roles: ['org_admin'],
    branchIds: [],
    branchIdsByRole: {},
    requestId: 'm51-label-recording',
  };
}

async function withBarcode(sku: { id: string; code: string }, seq: number) {
  const barcode = internalEan13(80_000_000_000 + seq);
  await withSystem(
    (tx) =>
      tx.execute(
        sql`update catalog.skus set barcode = ${barcode} where org_id = ${ORG_A} and id = ${sku.id}`,
      ),
    { orgId: ORG_A },
  );
  return { ...sku, barcode };
}

async function order(
  status: string,
  lines: readonly { sku: { id: string; code: string }; qty: number }[],
) {
  return seedOrder(ORG_A, {
    status: status as 'confirmed',
    customerId,
    createdBy: PACKER,
    lines: lines.map((line) => ({
      skuId: line.sku.id,
      skuCode: line.sku.code,
      productName: `Product ${line.sku.code}`,
      qty: line.qty,
      unitPricePoisha: 150_000n,
    })),
  });
}

/** A packing session opened as the station does, without the label-print gate of D-928. */
async function packSession(orderId: string, orderNo: string): Promise<string> {
  return withSystem(
    async (tx) =>
      (
        await tx.execute<{ id: string }>(sql`
          insert into packing.sessions (org_id, order_id, order_no, video_required, started_by)
          values (${ORG_A}, ${orderId}, ${orderNo}, true, ${PACKER})
          returning id
        `)
      )[0]?.id ?? '',
    { orgId: ORG_A },
  );
}

/** Each lot's label printed with its consignment, as Pack requires (D-928). */
async function labelsPrinted(order: { id: string; orderNo: string }, lots = 1): Promise<void> {
  await withSystem(
    async (tx) => {
      const terminal = (
        await tx.execute<{ id: string }>(sql`
          insert into packing.terminals (org_id, kind, name, created_by, updated_by)
          values (${ORG_A}, 'label', ${`M51 ${randomUUID().slice(0, 8)}`}, ${PACKER}, ${PACKER})
          returning id
        `)
      )[0]?.id;
      const printer = (
        await tx.execute<{ id: string }>(sql`
          insert into packing.printers
            (org_id, terminal_id, name, connection, language, medium, width_um, height_um,
             documents, created_by, updated_by)
          values (${ORG_A}, ${terminal}, ${`M51 printer ${randomUUID().slice(0, 8)}`}, 'browser', 'pdf', '4x6', 101600, 152400,
                  array['label']::text[], ${PACKER}, ${PACKER})
          returning id
        `)
      )[0]?.id;
      for (let lot = 1; lot <= lots; lot += 1) {
        await tx.execute(sql`
          insert into packing.print_jobs
            (org_id, order_id, order_no, document, lot_no, lot_count, printer_id, terminal_id,
             source, requested_by, consignment_no, state, printed_at)
          values (${ORG_A}, ${order.id}, ${order.orderNo}, 'label', ${lot}, ${lots}, ${printer},
                  ${terminal}, 'manual', ${PACKER}, ${`CN-${order.orderNo}`}, 'printed', now())
        `);
      }
    },
    { orgId: ORG_A },
  );
}

async function setLots(orderId: string, count: number): Promise<void> {
  await withSystem(
    (tx) =>
      tx.execute(sql`
        insert into packing.order_lots (org_id, order_id, lot_count, set_by)
        values (${ORG_A}, ${orderId}, ${count}, ${PACKER})
        on conflict (org_id, order_id) do update set lot_count = excluded.lot_count
      `),
    { orgId: ORG_A },
  );
}

async function recordingsOf(sessionId: string) {
  return withSystem(
    async (tx) => [
      ...(await tx.execute<{
        id: string;
        lot_no: number;
        started_at: string;
        stopped_at: string | null;
        stop_reason: string | null;
      }>(sql`
        select id, lot_no, started_at::text, stopped_at::text, stop_reason
        from packing.recordings where session_id = ${sessionId} order by lot_no
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

const scan = (sessionId: string, code: string) =>
  station.scan(context(), request(), sessionId, { scanId: randomUUID(), code });

beforeAll(async () => {
  harness = await startHttpHarness('m51-label-recording');
  await applyOrderMigrations();
  station = harness.app.get(PackStationService);
  returns = harness.app.get(ReturnStationService);
  await withGlobal(async (tx) => {
    await tx.execute(sql`
      insert into iam.users (id, email, name, email_verified)
      values (${PACKER}, ${`${PACKER}@example.invalid`}, 'M51 packer', true)
      on conflict (id) do nothing
    `);
  });
  const shirts = await seedProductWithSkus(ORG_A, `m51s${suffix}`, 1);
  const caps = await seedProductWithSkus(ORG_A, `m51c${suffix}`, 1);
  const others = await seedProductWithSkus(ORG_A, `m51o${suffix}`, 1);
  const base = Math.floor(Math.random() * 1_000_000);
  shirt = await withBarcode(shirts.skus[0] as { id: string; code: string }, base + 1);
  cap = await withBarcode(caps.skus[0] as { id: string; code: string }, base + 2);
  stranger = await withBarcode(others.skus[0] as { id: string; code: string }, base + 3);
  customerId = await seedCustomer(ORG_A, { phoneE164: '+8801711000951', name: 'M51 buyer' });
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

describe('the packing station, label to label (D-930)', () => {
  it('refuses a piece before the label, records from the label and finishes at the label again', async () => {
    const placed = await order('confirmed', [{ sku: shirt, qty: 1 }]);
    await labelsPrinted(placed);
    const sessionId = await packSession(placed.id, placed.orderNo);

    expect(await refusal(scan(sessionId, shirt.barcode))).toContain('PACKING_LABEL_FIRST');

    const started = await scan(sessionId, placed.orderNo);
    expect(started.label).toMatchObject({ action: 'started', lot: 1 });
    const [recording] = await recordingsOf(sessionId);
    expect(recording).toMatchObject({ lot_no: 1, stopped_at: null });

    expect((await scan(sessionId, shirt.barcode)).outcome).toBe('accepted');

    const finished = await scan(sessionId, placed.orderNo);
    expect(finished.label).toMatchObject({ action: 'finished', lot: 1 });
    expect(await orderStatus(placed.id)).toBe('packed');
    const [stopped] = await recordingsOf(sessionId);
    expect(stopped?.stop_reason).toBe('label');
    expect(stopped?.stopped_at).not.toBeNull();
    expect(finished.view.recordings[0]).toMatchObject({ state: 'stopped', lot: 1 });
  });

  it('refuses the label while pieces are still to scan, and keeps recording', async () => {
    const placed = await order('confirmed', [{ sku: shirt, qty: 2 }]);
    const sessionId = await packSession(placed.id, placed.orderNo);
    await scan(sessionId, placed.orderNo);
    await scan(sessionId, shirt.barcode);
    const early = await scan(sessionId, placed.orderNo);
    expect(early.label).toMatchObject({ action: 'refused' });
    expect(early.label?.message).toContain('1 of 2 pieces');
    expect((await recordingsOf(sessionId))[0]?.stopped_at).toBeNull();
    expect(await orderStatus(placed.id)).toBe('confirmed');
  });

  it('films each lot of a two-lot order on its own, in order', async () => {
    const placed = await order('confirmed', [
      { sku: shirt, qty: 1 },
      { sku: cap, qty: 1 },
    ]);
    await setLots(placed.id, 2);
    await labelsPrinted(placed, 2);
    const sessionId = await packSession(placed.id, placed.orderNo);
    const lot1 = lotCode(placed.orderNo, 1);
    const lot2 = lotCode(placed.orderNo, 2);

    expect((await scan(sessionId, lot1)).label).toMatchObject({ action: 'started', lot: 1 });
    expect((await scan(sessionId, shirt.barcode)).outcome).toBe('accepted');
    const early = await scan(sessionId, lot2);
    expect(early.label).toMatchObject({ action: 'refused', lot: 2 });
    expect(early.label?.message).toContain('Lot 1 is open');

    expect((await scan(sessionId, lot1)).label).toMatchObject({ action: 'lot_closed', lot: 1 });
    expect(await refusal(scan(sessionId, cap.barcode))).toContain('PACKING_LABEL_FIRST');
    expect((await scan(sessionId, lot2)).label).toMatchObject({ action: 'started', lot: 2 });
    expect((await scan(sessionId, cap.barcode)).outcome).toBe('accepted');
    expect((await scan(sessionId, lot2)).label).toMatchObject({ action: 'finished', lot: 2 });

    const rows = await recordingsOf(sessionId);
    expect(rows.map((row) => [row.lot_no, row.stop_reason])).toEqual([
      [1, 'label'],
      [2, 'label'],
    ]);
    expect(await orderStatus(placed.id)).toBe('packed');
  });

  it('starts the recording from the scan that opens the order', async () => {
    const placed = await order('confirmed', [{ sku: cap, qty: 1 }]);
    const sessionId = await packSession(placed.id, placed.orderNo);
    const opened = await station.open(context(), request(), { code: placed.orderNo });
    expect(opened.session.id).toBe(sessionId);
    expect(opened.recordings).toHaveLength(1);
    expect(opened.labelNeeded).toBe(false);
    // Opening again (a reload's scan) only resumes the box: nothing stops.
    const again = await station.open(context(), request(), { code: placed.orderNo });
    expect(again.recordings[0]?.state).toBe('recording');
  });
});

describe('the database holds the recording (0166)', () => {
  it('refuses a recording with no label scan, a second stop and another lot’s video', async () => {
    const placed = await order('confirmed', [{ sku: shirt, qty: 1 }]);
    const sessionId = await packSession(placed.id, placed.orderNo);
    expect(
      await refusal(
        withSystem(
          (tx) =>
            tx.execute(sql`
              insert into packing.recordings
                (org_id, session_id, lot_no, video_required, idle_ms, started_at, started_by)
              values (${ORG_A}, ${sessionId}, 1, true, 10000, now(), ${PACKER})
            `),
          { orgId: ORG_A },
        ),
      ),
    ).toContain('starts with its lot');

    await scan(sessionId, placed.orderNo);
    const [recording] = await recordingsOf(sessionId);
    const id = recording?.id ?? '';
    await withSystem(
      (tx) =>
        tx.execute(sql`
          update packing.recordings set stopped_at = started_at + interval '5 seconds',
                 stopped_by = ${PACKER}, stop_reason = 'closed'
           where id = ${id}
        `),
      { orgId: ORG_A },
    );
    expect(
      await refusal(
        withSystem(
          (tx) =>
            tx.execute(sql`
              update packing.recordings set stopped_at = started_at + interval '9 seconds'
               where id = ${id}
            `),
          { orgId: ORG_A },
        ),
      ),
    ).toContain('stop is set once');
    expect(
      await refusal(
        withSystem(
          (tx) =>
            tx.execute(sql`
              insert into packing.videos
                (id, org_id, session_id, part, recorded_by, started_at, mime, recording_id, lot_no)
              values (${randomUUID()}, ${ORG_A}, ${sessionId}, 1, ${PACKER}, now(), 'video/webm',
                      ${id}, 2)
            `),
          { orgId: ORG_A },
        ),
      ),
    ).toContain('its own lot');
  });
});

describe('the return station (D-934)', () => {
  it('opens a returning parcel by its label, refuses what did not go out, and stops at the label', async () => {
    const placed = await order('return_in_transit', [{ sku: shirt, qty: 2 }]);
    const view = await returns.open(context(), request(), { code: placed.orderNo });
    expect(view.recordings).toHaveLength(1);
    expect(view.lines[0]).toMatchObject({ skuId: shirt.id, expected: 2, back: 0 });

    const sessionId = view.session.id;
    const back = await returns.scan(context(), request(), sessionId, {
      scanId: randomUUID(),
      code: shirt.barcode,
    });
    expect(back.outcome).toBe('accepted');
    const wrong = await returns.scan(context(), request(), sessionId, {
      scanId: randomUUID(),
      code: stranger.barcode,
    });
    expect(wrong.outcome).toBe('wrong_item');

    const stopped = await returns.scan(context(), request(), sessionId, {
      scanId: randomUUID(),
      code: placed.orderNo,
    });
    expect(stopped.label).toMatchObject({ action: 'stopped', lot: 1 });
    expect(stopped.view.progress).toMatchObject({ unitsExpected: 2, unitsBack: 1, missing: 1 });
    expect(stopped.view.labelNeeded).toBe(true);

    // A packing session id is not the return station's, nor the other way round.
    expect(
      await refusal(
        station.scan(context(), request(), sessionId, { scanId: randomUUID(), code: 'x' }),
      ),
    ).toContain('No such packing session');
  });

  it('refuses an order that is not on its way back', async () => {
    const placed = await order('confirmed', [{ sku: cap, qty: 1 }]);
    expect(await refusal(returns.open(context(), request(), { orderId: placed.id }))).toContain(
      'not received as a return',
    );
  });
});
