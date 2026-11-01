import { randomUUID } from 'node:crypto';

import { withGlobal, withSystem } from '@elysium/db';
import { grantMembership } from '@elysium/db/testing';
import { internalEan13 } from '@elysium/domain/barcode';
import {
  LOT_ASK_ABOVE_PIECES_DEFAULT,
  PACKING_LABEL_REREAD_MS,
  lotScanCode,
  orderScanCode,
  soleLotScanCode,
} from '@elysium/domain/packing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { attachScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ORG_A, startHttpHarness, type HttpHarness } from '../../testing/http-harness.js';
import { seedProductWithSkus } from '../inventory/inventory.testing.js';
import { applyOrderMigrations, seedCustomer, seedOrder } from '../orders/orders.testing.js';
import { LotsService } from './lots.service.js';
import { PrintingService } from './printing.service.js';
import { PackStationService } from './station.service.js';

/**
 * Lot by lot, on real Postgres (M53, D-946 to D-949).
 *
 * 1. Every label's code says which bag it is: `00` for an order in one lot, `01` to `20` for each
 *    of several. A code printed for another count is refused, at the table and at the handover,
 *    and a label printed before this still scans.
 * 2. Lots go to the courier on different days: one left behind stays on the handover's list, and
 *    a courier's own status shipping the order does not stop the rest being handed and recorded.
 * 3. The order page keeps each lot's record: what went in it, when it was handed, what came back.
 * 4. A brand that chose nothing is asked above five pieces.
 */

const PERSON = `usr_m53_${randomUUID().slice(0, 8)}`;
const suffix = randomUUID().slice(0, 6);

let harness: HttpHarness;
let station: PackStationService;
let lots: LotsService;
let printing: PrintingService;
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
    requestId: 'm53-lot-wise',
  };
}

function seed(status: string, qty: number) {
  return seedOrder(ORG_A, {
    status,
    customerId,
    createdBy: PERSON,
    lines: [
      {
        skuId: shirt.id,
        skuCode: shirt.code,
        productName: 'A linen shirt',
        qty,
        unitPricePoisha: 150_000n,
      },
    ],
  });
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

const scan = (sessionId: string, code: string) =>
  station.scan(context(), request(), sessionId, { scanId: randomUUID(), code });

const handOver = (code: string) => lots.scan(context(), request(), { code }, null);

const pastReread = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, PACKING_LABEL_REREAD_MS + 100);
  });

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

function digits(code: string | null): string {
  if (code === null) throw new Error('this order number has no digits-only code');
  return code;
}

beforeAll(async () => {
  harness = await startHttpHarness('m53-lot-wise');
  await applyOrderMigrations();
  station = harness.app.get(PackStationService);
  lots = harness.app.get(LotsService);
  printing = harness.app.get(PrintingService);
  await withGlobal(async (tx) => {
    await tx.execute(sql`
      insert into iam.users (id, email, name, email_verified)
      values (${PERSON}, ${`${PERSON}@example.invalid`}, 'M53 packer', true)
      on conflict (id) do nothing
    `);
  });
  await grantMembership({ userId: PERSON, orgId: ORG_A, role: 'org_admin' });
  const shirts = await seedProductWithSkus(ORG_A, `m53s${suffix}`, 1);
  const sku = shirts.skus[0] as { id: string; code: string };
  const barcode = internalEan13(82_000_000_000 + Math.floor(Math.random() * 1_000_000));
  await withSystem(
    async (tx) => {
      await tx.execute(
        sql`update catalog.skus set barcode = ${barcode} where org_id = ${ORG_A} and id = ${sku.id}`,
      );
      terminalId =
        (
          await tx.execute<{ id: string }>(sql`
            insert into packing.terminals (org_id, kind, name, created_by, updated_by)
            values (${ORG_A}, 'label', ${`M53 ${suffix}`}, ${PERSON}, ${PERSON})
            returning id
          `)
        )[0]?.id ?? '';
      printerId =
        (
          await tx.execute<{ id: string }>(sql`
            insert into packing.printers
              (org_id, terminal_id, name, connection, language, medium, width_um, height_um,
               documents, created_by, updated_by)
            values (${ORG_A}, ${terminalId}, ${`M53 printer ${suffix}`}, 'browser', 'pdf', '4x6',
                    101600, 152400, array['label']::text[], ${PERSON}, ${PERSON})
            returning id
          `)
        )[0]?.id ?? '';
    },
    { orgId: ORG_A },
  );
  shirt = { ...sku, barcode };
  customerId = await seedCustomer(ORG_A, { phoneE164: '+8801711000953', name: 'M53 buyer' });
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

describe('the two digits on every label (D-946)', () => {
  it('packs an order in one lot from its 00 label, start to finish', async () => {
    const placed = await seed('confirmed', 1);
    await printLabels(placed, 1);
    const label = digits(soleLotScanCode(placed.orderNo));
    expect(label).toHaveLength(12);
    expect(label.endsWith('00')).toBe(true);

    const opened = await station.open(context(), request(), { code: label });
    expect(opened.labelNeeded).toBe(false);
    const sessionId = opened.session.id;
    expect((await scan(sessionId, shirt.barcode)).accepted).toBe(true);
    await pastReread();
    expect((await scan(sessionId, label)).label?.action).toBe('finished');
  });

  it('still takes a one-lot label printed before this, with its ten digits', async () => {
    const placed = await seed('confirmed', 1);
    await printLabels(placed, 1);
    const old = digits(orderScanCode(placed.orderNo));
    const opened = await station.open(context(), request(), { code: old });
    expect(opened.labelNeeded).toBe(false);
    expect((await scan(opened.session.id, shirt.barcode)).accepted).toBe(true);
    await pastReread();
    expect((await scan(opened.session.id, old)).label?.action).toBe('finished');
  });

  it('refuses the 00 of an old sticker on an order now in two lots', async () => {
    const placed = await seed('confirmed', 2);
    await setStoredLots(placed.id, 2);
    await printLabels(placed, 2);
    const opened = await station.open(context(), request(), {
      code: digits(lotScanCode(placed.orderNo, 1)),
    });
    await pastReread();
    const old = await scan(opened.session.id, digits(soleLotScanCode(placed.orderNo)));
    expect(old.label?.action).toBe('refused');
    expect(old.label?.message).toContain('scan lot 1’s own label');
  });

  it('refuses a lot’s own code on an order now in one lot, at the table and the handover', async () => {
    const atTable = await seed('confirmed', 1);
    await printLabels(atTable, 1);
    const opened = await station.open(context(), request(), {
      code: digits(soleLotScanCode(atTable.orderNo)),
    });
    await pastReread();
    const stale = await scan(opened.session.id, digits(lotScanCode(atTable.orderNo, 1)));
    expect(stale.label?.action).toBe('refused');
    expect(stale.label?.message).toContain('from when this order had more lots');

    const packed = await seed('packed', 1);
    expect(await refusal(handOver(digits(lotScanCode(packed.orderNo, 1))))).toContain(
      'from when order',
    );
    const handed = await handOver(digits(soleLotScanCode(packed.orderNo)));
    expect(handed.outcome).toBe('accepted');
    expect(handed.order.complete).toBe(true);
  });
});

describe('lots going to the courier on different days (D-947)', () => {
  it('keeps an order with a lot left behind on the list, however long ago the first went', async () => {
    const placed = await seed('packed', 2);
    await setStoredLots(placed.id, 2);
    await handOver(digits(lotScanCode(placed.orderNo, 1)));
    await withSystem(
      (tx) =>
        tx.execute(sql`
          update packing.handover_scans set scanned_at = now() - interval '5 days'
          where org_id = ${ORG_A} and order_id = ${placed.id}
        `),
      { orgId: ORG_A },
    );
    const pending = await lots.pending(context(), request());
    const row = pending.items.find((item) => item.orderId === placed.id);
    expect(row?.missing).toEqual([2]);
    expect(row?.complete).toBe(false);
  });

  it('records a lot still at the hub after a courier’s own status shipped the order', async () => {
    const placed = await seed('shipped', 2);
    await setStoredLots(placed.id, 2);
    const first = await handOver(digits(lotScanCode(placed.orderNo, 1)));
    expect(first.outcome).toBe('accepted');
    expect(first.order.missing).toEqual([2]);
    const second = await handOver(digits(lotScanCode(placed.orderNo, 2)));
    expect(second.outcome).toBe('accepted');
    expect(second.order.complete).toBe(true);
    // Both are in now, so a third scan is a repeat, not a new fact.
    expect(await refusal(handOver(digits(lotScanCode(placed.orderNo, 2))))).toContain(
      'ORDER_ALREADY_HANDED',
    );
  });

  it('takes no lot of a delivered order, nor a one-lot order already with the courier', async () => {
    const delivered = await seed('delivered', 2);
    await setStoredLots(delivered.id, 2);
    expect(await refusal(handOver(digits(lotScanCode(delivered.orderNo, 1))))).toContain(
      'ORDER_ALREADY_HANDED',
    );
    const shipped = await seed('shipped', 1);
    expect(await refusal(handOver(digits(soleLotScanCode(shipped.orderNo))))).toContain(
      'ORDER_ALREADY_HANDED',
    );
  });

  it('still refuses a lot of an order that is not packed', async () => {
    const placed = await seed('confirmed', 2);
    await setStoredLots(placed.id, 2);
    expect(await refusal(handOver(digits(lotScanCode(placed.orderNo, 1))))).toContain(
      'not packed yet',
    );
  });
});

describe('each lot’s record on the order page (D-948)', () => {
  it('says what went in each lot, when it was packed and handed, and what came back', async () => {
    const placed = await seed('confirmed', 3);
    await setStoredLots(placed.id, 2);
    await printLabels(placed, 2);
    const lot1 = digits(lotScanCode(placed.orderNo, 1));
    const lot2 = digits(lotScanCode(placed.orderNo, 2));
    const opened = await station.open(context(), request(), { code: lot1 });
    const sessionId = opened.session.id;
    await scan(sessionId, shirt.barcode);
    await scan(sessionId, shirt.barcode);
    await pastReread();
    await scan(sessionId, lot1);
    await scan(sessionId, lot2);
    await scan(sessionId, shirt.barcode);
    await pastReread();
    expect((await scan(sessionId, lot2)).label?.action).toBe('finished');
    await handOver(lot2);

    const record = await printing.orderPrints(context(), request(), placed.id);
    expect(record.lotCount).toBe(2);
    expect(record.lots[0]?.items).toEqual([
      { skuId: shirt.id, skuCode: shirt.code, name: 'A linen shirt', qty: 2 },
    ]);
    expect(record.lots[1]?.items).toEqual([
      { skuId: shirt.id, skuCode: shirt.code, name: 'A linen shirt', qty: 1 },
    ]);
    expect(record.lots[0]?.packedAt).not.toBeNull();
    expect(record.lots[1]?.packedAt).not.toBeNull();
    // Only lot 2 has gone: the record says which, and who.
    expect(record.lots[0]?.handedAt).toBeNull();
    expect(record.lots[1]?.handedAt).not.toBeNull();
    expect(record.lots[1]?.handedBy).toBe('M53 packer');
    expect(record.lots[0]?.back).toBeNull();
  });

  it('reads an order packed at the desk, with nothing to say about its lots', async () => {
    const placed = await seed('packed', 2);
    const record = await printing.orderPrints(context(), request(), placed.id);
    expect(record.lots).toHaveLength(1);
    expect(record.lots[0]?.items).toEqual([]);
    expect(record.lots[0]?.packedAt).toBeNull();
  });
});

describe('the brand’s limit (D-949)', () => {
  it('asks above five pieces until the brand chooses', async () => {
    expect(LOT_ASK_ABOVE_PIECES_DEFAULT).toBe(5);
    await withSystem(
      (tx) => tx.execute(sql`delete from packing.settings where org_id = ${ORG_A}`),
      {
        orgId: ORG_A,
      },
    );
    expect((await station.settings(context(), true)).lotAskAbovePieces).toBe(5);
    // Saving only the video setting keeps the five.
    await station.saveSettings(context(), request(), { videoEnabled: true });
    expect((await station.settings(context(), true)).lotAskAbovePieces).toBe(5);
    await station.saveSettings(context(), request(), {
      videoEnabled: true,
      lotAskAbovePieces: null,
    });
    expect((await station.settings(context(), true)).lotAskAbovePieces).toBeNull();
  });
});
