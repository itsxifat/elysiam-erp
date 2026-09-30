import { randomUUID } from 'node:crypto';

import { withOrg, withSystem } from '@elysium/db';
import { poisha } from '@elysium/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import {
  makeLocation,
  seedProductWithSkus,
  type SeededSku,
} from '../inventory/inventory.testing.js';
import { seedWallet, type SeededWallet } from '../wallets/wallets.testing.js';
import { NoPromoCodes, PROMO_CODES } from './ports/promo-code.port.js';

/**
 * M23 against real PostgreSQL, over the real HTTP pipeline (checks 1, 2 and 3; the
 * browser half of check 1 and check 4 are the Playwright spec in `apps/pos/e2e`).
 *
 * This is the application as it ships: the stock port is inventory's own API and
 * the closing port is M08's own `ClosingsService`. Every figure below is read back
 * from `inventory.stock_levels` and `ledger.journal_lines` — never from the POS's
 * own rows, which would only prove the POS agrees with itself.
 */

let harness: HttpHarness;
let inventory: InventoryApi;
let cashier: RoleClient;
let manager: RoleClient;
let branchId = '';
let showroomId = '';
let skus: SeededSku[] = [];
let handCash: SeededWallet;
let bkash: SeededWallet;
let bank: SeededWallet;
let registerId = '';
let shiftId = '';

/** Every unit enters at ৳900.00, so COGS is 90,000 poisha a unit. */
const UNIT_COST = 90_000;
/** `seedProductWithSkus` prices every SKU at ৳1,500.00. */
const PRICE = 150_000;

beforeAll(async () => {
  harness = await startHttpHarness('pos-db');
  inventory = harness.app.get<InventoryApi>(INVENTORY_API, { strict: false });

  branchId = await withSystem(
    async (tx) =>
      (
        await tx.execute<{ id: string }>(
          sql`select id from org.branches where org_id = ${ORG_A} and code = 'HQ'`,
        )
      )[0]?.id ?? '',
    { orgId: ORG_A },
  );
  showroomId = await makeLocation(ORG_A, {
    code: 'POS-SHR',
    name: 'Gulshan showroom',
    kind: 'showroom',
    branchId,
  });
  ({ skus } = await seedProductWithSkus(ORG_A, 'posdb', 4));
  handCash = await seedWallet(ORG_A, '1010-HQ', { provider: 'Till' });
  bkash = await seedWallet(ORG_A, '1110', { provider: 'bKash' });
  bank = await seedWallet(ORG_A, '1100', { provider: 'Bank' });

  // Stock: 20 of the first two SKUs, 1 of the third, none of the fourth.
  await receive(skus[0]!.id, 20);
  await receive(skus[1]!.id, 20);
  await receive(skus[2]!.id, 1);

  cashier = await harness.asRole('branch_manager', ORG_A, { branchIds: [branchId] });
  manager = await harness.asRole('branch_manager', ORG_A, { branchIds: [branchId] });

  const created = await cashier.client.request('POST', '/v1/pos/registers', {
    body: {
      branchId,
      locationId: showroomId,
      code: 'GUL1',
      name: 'Gulshan till 1',
      cashWalletId: handCash.id,
      bkashWalletId: bkash.id,
      cardWalletId: bank.id,
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  registerId = (JSON.parse(created.body) as { id: string }).id;

  shiftId = randomUUID();
  const opened = await cashier.client.request('POST', '/v1/pos/shifts', {
    body: { shiftId, registerId, openingFloatPoisha: '500000' },
  });
  expect(opened.statusCode, opened.body).toBe(201);
}, 600_000);

afterAll(async () => {
  await harness?.close();
}, 120_000);

// --- helpers ------------------------------------------------------------------

async function receive(skuId: string, qty: number): Promise<void> {
  const actor = { orgId: ORG_A, userId: 'usr_pos_test' };
  await withOrg(actor, (tx) =>
    inventory.receiveSupply(tx, actor, {
      supplyId: randomUUID(),
      supplierId: randomUUID(),
      locationId: showroomId,
      branchId,
      occurredAt: new Date(),
      lines: [{ skuId, qty, unitCostPoisha: poisha(UNIT_COST) }],
    }),
  );
}

let receiptSeq = 0;
function sale(
  lines: { sku: SeededSku; qty: number; discount?: number; price?: number }[],
  tenders: { tender: 'cash' | 'bkash' | 'card'; amount: number }[],
  overrides: Record<string, unknown> = {},
) {
  receiptSeq += 1;
  const priced = lines.map((line, index) => ({
    lineNo: index + 1,
    skuId: line.sku.id,
    qty: line.qty,
    unitPricePoisha: String(line.price ?? PRICE),
    discountPoisha: String(line.discount ?? 0),
  }));
  const gross = lines.reduce((total, line) => total + (line.price ?? PRICE) * line.qty, 0);
  const discount = lines.reduce((total, line) => total + (line.discount ?? 0), 0);
  return {
    kind: 'sale' as const,
    id: randomUUID(),
    registerId,
    shiftId,
    receiptNo: `GUL1-1-${String(receiptSeq).padStart(4, '0')}`,
    occurredAt: new Date().toISOString(),
    lines: priced,
    tenders: tenders.map((tender) => ({
      tender: tender.tender,
      amountPoisha: String(tender.amount),
    })),
    totals: {
      grossPoisha: String(gross),
      discountPoisha: String(discount),
      netPoisha: String(gross - discount),
    },
    ...overrides,
  };
}

interface Result {
  id: string;
  outcome: string;
  replayed: boolean;
  reviewItemId: string | null;
  reasons: string[];
  journalId: string | null;
  error: { code: string } | null;
}

async function sync(client: RoleClient, documents: unknown[]): Promise<Result[]> {
  const response = await client.client.request('POST', '/v1/pos/sync', { body: { documents } });
  expect(response.statusCode, response.body).toBe(200);
  return (JSON.parse(response.body) as { results: Result[] }).results;
}

async function onHand(skuId: string): Promise<number> {
  return withSystem(
    async (tx) =>
      (
        await tx.execute<{ on_hand: number }>(sql`
          select on_hand from inventory.stock_levels
          where org_id = ${ORG_A} and sku_id = ${skuId} and location_id = ${showroomId}
        `)
      )[0]?.on_hand ?? 0,
    { orgId: ORG_A },
  );
}

/** Σ debit − Σ credit on one ledger account, from the journal lines themselves. */
async function balance(accountId: string): Promise<bigint> {
  return withSystem(
    async (tx) =>
      BigInt(
        (
          await tx.execute<{ balance: string }>(sql`
            select coalesce(sum(debit_poisha - credit_poisha), 0)::text as balance
            from ledger.journal_lines where org_id = ${ORG_A} and account_id = ${accountId}
          `)
        )[0]?.balance ?? '0',
      ),
    { orgId: ORG_A },
  );
}

async function accountOf(subtype: string): Promise<string> {
  return withSystem(
    async (tx) =>
      (
        await tx.execute<{ id: string }>(sql`
          select id from ledger.accounts where org_id = ${ORG_A} and subtype::text = ${subtype}
          order by code limit 1
        `)
      )[0]?.id ?? '',
    { orgId: ORG_A },
  );
}

async function journalsFor(sourceId: string): Promise<number> {
  return withSystem(
    async (tx) =>
      (
        await tx.execute<{ n: number }>(sql`
          select count(*)::int as n from ledger.journals where org_id = ${ORG_A} and source_id = ${sourceId}
        `)
      )[0]?.n ?? 0,
    { orgId: ORG_A },
  );
}

async function movementsFor(refId: string): Promise<number> {
  return withSystem(
    async (tx) =>
      (
        await tx.execute<{ n: number }>(sql`
          select count(*)::int as n from inventory.stock_movements where org_id = ${ORG_A} and ref_id = ${refId}
        `)
      )[0]?.n ?? 0,
    { orgId: ORG_A },
  );
}

// --- check 1: sales queued offline sync once, and the books agree -------------------

describe('three sales made offline, synced on reconnect', () => {
  it('post once each, and stock and wallets are right afterwards', async () => {
    const [a, b] = [skus[0]!, skus[1]!];
    const before = {
      a: await onHand(a.id),
      b: await onHand(b.id),
      cash: await balance(handCash.ledgerAccountId),
      bkash: await balance(bkash.ledgerAccountId),
      bank: await balance(bank.ledgerAccountId),
      revenue: await balance(await accountOf('sales_revenue')),
      cogs: await balance(await accountOf('cogs')),
    };

    // Rung up while the till was offline: all cash; split cash + bKash with a
    // discount; card for two units.
    const queued = [
      sale([{ sku: a, qty: 1 }], [{ tender: 'cash', amount: 150_000 }], {
        cashReceivedPoisha: '200000',
      }),
      sale(
        [
          { sku: a, qty: 1, discount: 10_000 },
          { sku: b, qty: 1 },
        ],
        [
          { tender: 'cash', amount: 190_000 },
          { tender: 'bkash', amount: 100_000 },
        ],
      ),
      sale([{ sku: b, qty: 2 }], [{ tender: 'card', amount: 300_000 }]),
    ];

    const results = await sync(cashier, queued);
    expect(results.map((r) => [r.outcome, r.replayed])).toEqual([
      ['posted', false],
      ['posted', false],
      ['posted', false],
    ]);
    for (const document of queued) expect(await journalsFor(document.id)).toBe(1);

    expect(await onHand(a.id)).toBe(before.a - 2);
    expect(await onHand(b.id)).toBe(before.b - 3);
    // Cash is what the drawer kept: the ৳2,000 note on the first sale gave ৳500 change.
    expect((await balance(handCash.ledgerAccountId)) - before.cash).toBe(340_000n);
    expect((await balance(bkash.ledgerAccountId)) - before.bkash).toBe(100_000n);
    expect((await balance(bank.ledgerAccountId)) - before.bank).toBe(300_000n);
    // Revenue is credit-normal: net of the ৳100 discount, 7,40,000 poisha.
    expect(before.revenue - (await balance(await accountOf('sales_revenue')))).toBe(740_000n);
    expect((await balance(await accountOf('cogs'))) - before.cogs).toBe(5n * BigInt(UNIT_COST));
  });
});

// --- check 2: re-syncs never double-post --------------------------------------------

describe('a re-sync', () => {
  it('delivered again answers with the first result and writes nothing', async () => {
    const batch = [
      sale([{ sku: skus[0]!, qty: 1 }], [{ tender: 'cash', amount: 150_000 }]),
      sale([{ sku: skus[1]!, qty: 1 }], [{ tender: 'bkash', amount: 150_000 }]),
    ];
    const first = await sync(cashier, batch);
    const stock = await onHand(skus[0]!.id);
    const cash = await balance(handCash.ledgerAccountId);

    const second = await sync(cashier, batch);
    expect(second.map((r) => [r.outcome, r.replayed])).toEqual([
      ['posted', true],
      ['posted', true],
    ]);
    expect(second.map((r) => r.journalId)).toEqual(first.map((r) => r.journalId));
    expect(await onHand(skus[0]!.id)).toBe(stock);
    expect(await balance(handCash.ledgerAccountId)).toBe(cash);
    for (const document of batch) {
      expect(await journalsFor(document.id)).toBe(1);
      expect(await movementsFor(document.id)).toBe(1);
    }
  });

  it('delivered concurrently posts each sale exactly once', async () => {
    const batch = [
      sale([{ sku: skus[0]!, qty: 1 }], [{ tender: 'cash', amount: 150_000 }]),
      sale([{ sku: skus[1]!, qty: 2 }], [{ tender: 'cash', amount: 300_000 }]),
      sale([{ sku: skus[0]!, qty: 1 }], [{ tender: 'card', amount: 150_000 }]),
    ];
    const stock = { a: await onHand(skus[0]!.id), b: await onHand(skus[1]!.id) };
    const cash = await balance(handCash.ledgerAccountId);

    // Five tabs, one flaky link: the same queue delivered five times at once.
    const deliveries = await Promise.all(Array.from({ length: 5 }, () => sync(cashier, batch)));

    for (const [index, document] of batch.entries()) {
      const outcomes = deliveries.map((results) => results[index]!);
      expect(outcomes.every((r) => r.outcome === 'posted')).toBe(true);
      expect(outcomes.filter((r) => !r.replayed)).toHaveLength(1);
      expect(new Set(outcomes.map((r) => r.journalId)).size).toBe(1);
      expect(await journalsFor(document.id)).toBe(1);
      expect(await movementsFor(document.id)).toBe(1);
    }
    expect(await onHand(skus[0]!.id)).toBe(stock.a - 2);
    expect(await onHand(skus[1]!.id)).toBe(stock.b - 2);
    expect((await balance(handCash.ledgerAccountId)) - cash).toBe(450_000n);
  });

  it('refuses a different sale under an id already used, and posts nothing for it', async () => {
    const original = sale([{ sku: skus[0]!, qty: 1 }], [{ tender: 'cash', amount: 150_000 }]);
    await sync(cashier, [original]);
    const forged = { ...original, cashReceivedPoisha: '500000' };
    const [result] = await sync(cashier, [forged]);
    expect(result?.outcome).toBe('conflict');
    expect(await journalsFor(original.id)).toBe(1);
  });
});

// --- check 3: a shortfall at sync is a review item, never a negative level ---------

describe('a stock shortfall discovered at sync', () => {
  it('holds the sale as a review item and leaves stock at zero', async () => {
    const empty = skus[3]!; // never stocked at the showroom
    const one = skus[2]!; // one unit on the shelf
    const document = sale(
      [
        { sku: one, qty: 1 },
        { sku: empty, qty: 1 },
      ],
      [{ tender: 'cash', amount: 300_000 }],
    );
    const cash = await balance(handCash.ledgerAccountId);

    const [result] = await sync(cashier, [document]);
    expect(result?.outcome).toBe('held');
    expect(result?.reasons).toEqual(['stock_shortfall']);
    expect(result?.reviewItemId).not.toBeNull();

    // All or nothing: the unit that *was* there is still there.
    expect(await onHand(one.id)).toBe(1);
    expect(await onHand(empty.id)).toBe(0);
    expect(await journalsFor(document.id)).toBe(0);
    expect(await movementsFor(document.id)).toBe(0);
    expect(await balance(handCash.ledgerAccountId)).toBe(cash);

    const negative = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ n: number }>(sql`
            select count(*)::int as n from inventory.stock_levels
            where org_id = ${ORG_A} and (on_hand < 0 or reserved < 0)
          `)
        )[0]?.n ?? -1,
      { orgId: ORG_A },
    );
    expect(negative).toBe(0);

    const reviews = await manager.client.request('GET', '/v1/pos/reviews?status=open');
    const items = (
      JSON.parse(reviews.body) as {
        items: { id: string; saleId: string; detail: { short: unknown[] } }[];
      }
    ).items;
    const item = items.find((candidate) => candidate.saleId === document.id);
    expect(item?.detail.short).toEqual([{ skuId: empty.id, wanted: 1, available: 0 }]);

    // A re-sync of the held sale is a replay, not a second review item.
    const [again] = await sync(cashier, [document]);
    expect(again).toMatchObject({
      outcome: 'held',
      replayed: true,
      reviewItemId: result?.reviewItemId,
    });
  });

  it('is resolved by another manager once stock arrives, and posts exactly once', async () => {
    const empty = skus[3]!;
    const document = sale([{ sku: empty, qty: 1 }], [{ tender: 'cash', amount: 150_000 }]);
    const [held] = await sync(cashier, [document]);
    expect(held?.outcome).toBe('held');

    // The seller may not resolve their own held sale.
    const own = await cashier.client.request(
      'POST',
      `/v1/pos/reviews/${held!.reviewItemId!}/resolve`,
      {
        body: { action: 'post', note: 'mine' },
      },
    );
    expect(own.statusCode).toBe(403);

    // Not fixed yet: still held, evidence refreshed, nothing posted.
    const early = await manager.client.request(
      'POST',
      `/v1/pos/reviews/${held!.reviewItemId!}/resolve`,
      {
        body: { action: 'post', note: 'trying' },
      },
    );
    expect(JSON.parse(early.body)).toMatchObject({ outcome: 'held', reasons: ['stock_shortfall'] });
    expect(await journalsFor(document.id)).toBe(0);

    await receive(empty.id, 3);
    const fixed = await manager.client.request(
      'POST',
      `/v1/pos/reviews/${held!.reviewItemId!}/resolve`,
      {
        body: { action: 'post', note: 'transfer received' },
      },
    );
    expect(fixed.statusCode, fixed.body).toBe(200);
    expect(JSON.parse(fixed.body)).toMatchObject({ outcome: 'posted' });
    expect(await journalsFor(document.id)).toBe(1);
    expect(await onHand(empty.id)).toBe(2);

    // And the till's next re-sync sees it posted.
    const [replay] = await sync(cashier, [document]);
    expect(replay).toMatchObject({ outcome: 'posted', replayed: true });
  });
});

// --- permission-bound discounts ----------------------------------------------------

describe('the discount ceiling', () => {
  it('holds a sale above the seller’s ceiling instead of posting it', async () => {
    // 30% off: above a branch manager's 20%.
    const document = sale(
      [{ sku: skus[0]!, qty: 1, discount: 45_000 }],
      [{ tender: 'cash', amount: 105_000 }],
    );
    const [result] = await sync(cashier, [document]);
    expect(result).toMatchObject({ outcome: 'held', reasons: ['discount_above_ceiling'] });
    expect(await journalsFor(document.id)).toBe(0);

    // Another branch manager's ceiling does not cover it either.
    const refused = await manager.client.request(
      'POST',
      `/v1/pos/reviews/${result!.reviewItemId!}/resolve`,
      { body: { action: 'post', note: 'looks fine' } },
    );
    expect(refused.statusCode).toBe(403);

    // An org admin's does.
    const admin = await harness.asRole('org_admin', ORG_A);
    const posted = await admin.client.request(
      'POST',
      `/v1/pos/reviews/${result!.reviewItemId!}/resolve`,
      {
        body: { action: 'post', note: 'approved for a regular' },
      },
    );
    expect(JSON.parse(posted.body)).toMatchObject({ outcome: 'posted' });
    expect(await journalsFor(document.id)).toBe(1);
  });

  it('counts a price below the catalog as discount', async () => {
    const document = sale(
      [{ sku: skus[1]!, qty: 1, price: 50_000 }],
      [{ tender: 'cash', amount: 50_000 }],
    );
    const [result] = await sync(cashier, [document]);
    expect(result?.reasons).toEqual(['price_mismatch', 'discount_above_ceiling']);
  });

  it('posts a discount at exactly the ceiling', async () => {
    const document = sale(
      [{ sku: skus[1]!, qty: 1, discount: 30_000 }],
      [{ tender: 'cash', amount: 120_000 }],
    );
    const [result] = await sync(cashier, [document]);
    expect(result?.outcome).toBe('posted');
  });
});

// --- returns ---------------------------------------------------------------------------

describe('a return by receipt', () => {
  it('refunds what was paid, puts the unit back at its sale cost, and posts once', async () => {
    const sold = sale(
      [{ sku: skus[0]!, qty: 3, discount: 10_000 }],
      [{ tender: 'cash', amount: 440_000 }],
    );
    await sync(cashier, [sold]);
    const stock = await onHand(skus[0]!.id);
    const cash = await balance(handCash.ledgerAccountId);

    const lookup = await cashier.client.request('GET', `/v1/pos/receipts/${sold.receiptNo}`);
    const receipt = (
      JSON.parse(lookup.body) as {
        items: { lines: { nextUnitRefundPoisha: string; unitCostPoisha?: string }[] }[];
      }
    ).items[0]!;
    // 4,40,000 over three units: 1,46,667 for the first back.
    expect(receipt.lines[0]?.nextUnitRefundPoisha).toBe('146667');
    expect(receipt.lines[0]).not.toHaveProperty('unitCostPoisha');

    const ret = {
      kind: 'return' as const,
      id: randomUUID(),
      registerId,
      shiftId,
      saleId: sold.id,
      receiptNo: `R-${sold.receiptNo}`,
      occurredAt: new Date().toISOString(),
      lines: [{ lineNo: 1, saleLineNo: 1, qty: 1, refundPoisha: '146667' }],
      tenders: [{ tender: 'cash' as const, amountPoisha: '146667' }],
      refundPoisha: '146667',
    };
    const [first] = await sync(cashier, [ret]);
    expect(first?.outcome).toBe('posted');
    const [again] = await sync(cashier, [ret]);
    expect(again).toMatchObject({ outcome: 'posted', replayed: true });

    expect(await onHand(skus[0]!.id)).toBe(stock + 1);
    expect(cash - (await balance(handCash.ledgerAccountId))).toBe(146_667n);
    expect(await journalsFor(ret.id)).toBe(1);

    // Two more units back: the refunds sum to the line exactly.
    const rest = {
      ...ret,
      id: randomUUID(),
      receiptNo: `R2-${sold.receiptNo}`,
      lines: [{ lineNo: 1, saleLineNo: 1, qty: 2, refundPoisha: '293333' }],
      tenders: [{ tender: 'cash' as const, amountPoisha: '293333' }],
      refundPoisha: '293333',
    };
    const [second] = await sync(cashier, [rest]);
    expect(second?.outcome).toBe('posted');
    // A fourth unit would be more than the receipt sold: held, refund already paid.
    const extra = {
      ...rest,
      id: randomUUID(),
      receiptNo: `R3-${sold.receiptNo}`,
      lines: [{ lineNo: 1, saleLineNo: 1, qty: 1, refundPoisha: '146667' }],
      tenders: [{ tender: 'cash' as const, amountPoisha: '146667' }],
      refundPoisha: '146667',
    };
    const [third] = await sync(cashier, [extra]);
    expect(third).toMatchObject({ outcome: 'held', reasons: ['return_mismatch'] });
  });
});

// --- what the M23 ledger audit found (2026-09-30) ---------------------------------------

async function receiveAt(skuId: string, qty: number, unitCost: number): Promise<void> {
  const actor = { orgId: ORG_A, userId: 'usr_pos_test' };
  await withOrg(actor, (tx) =>
    inventory.receiveSupply(tx, actor, {
      supplyId: randomUUID(),
      supplierId: randomUUID(),
      locationId: showroomId,
      branchId,
      occurredAt: new Date(),
      lines: [{ skuId, qty, unitCostPoisha: poisha(unitCost) }],
    }),
  );
}

/** Each journal line of the one journal a POS document posted, by account. */
async function journalLines(sourceId: string) {
  return withSystem(
    async (tx) =>
      tx.execute<{ account_id: string; debit: string; credit: string; business_date: string }>(sql`
        select l.account_id, l.debit_poisha::text as debit, l.credit_poisha::text as credit,
               j.business_date::text as business_date
        from ledger.journal_lines l
        join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
        where j.org_id = ${ORG_A} and j.source_id = ${sourceId}
      `),
    { orgId: ORG_A },
  );
}

async function resolve(client: RoleClient, reviewItemId: string) {
  return client.client.request('POST', `/v1/pos/reviews/${reviewItemId}/resolve`, {
    body: { action: 'post', note: 'reviewed' },
  });
}

describe('what the M23 ledger audit found', () => {
  let audited: SeededSku[] = [];

  beforeAll(async () => {
    ({ skus: audited } = await seedProductWithSkus(ORG_A, 'posaudit', 4));
    for (const sku of audited) await receive(sku.id, 10);
  });

  it('W1: an archived SKU sold far below list is a discount, measured against the ceiling', async () => {
    const archived = audited[0]!;
    await withSystem(
      (tx) =>
        tx.execute(sql`
          update catalog.skus set status = 'archived' where org_id = ${ORG_A} and id = ${archived.id}
        `),
      { orgId: ORG_A },
    );
    // Listed at ৳1,500, rung up at ৳150 with nothing typed as discount: 90% off.
    const document = sale(
      [{ sku: archived, qty: 1, price: 15_000 }],
      [{ tender: 'cash', amount: 15_000 }],
    );
    const [held] = await sync(cashier, [document]);
    expect(held?.reasons).toEqual(['sku_unavailable', 'price_mismatch', 'discount_above_ceiling']);

    // A branch manager's 20% does not cover it, and accounts gives no discount at all.
    expect((await resolve(manager, held!.reviewItemId!)).statusCode).toBe(403);
    const accounts = await harness.asRole('accounts', ORG_A);
    expect((await resolve(accounts, held!.reviewItemId!)).statusCode).toBe(403);
    expect(await journalsFor(document.id)).toBe(0);

    const admin = await harness.asRole('org_admin', ORG_A);
    const posted = await resolve(admin, held!.reviewItemId!);
    expect(JSON.parse(posted.body)).toMatchObject({ outcome: 'posted' });
  });

  it('W3: a sale dated before its shift opened is held, not posted into a counted day', async () => {
    const document = sale([{ sku: audited[1]!, qty: 1 }], [{ tender: 'cash', amount: PRICE }], {
      occurredAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    });
    const [result] = await sync(cashier, [document]);
    expect(result).toMatchObject({ outcome: 'held', reasons: ['outside_shift'] });
    expect(await journalsFor(document.id)).toBe(0);
  });

  it('W3: a sale for a day the branch already closed posts today when it is resolved', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());
    const yesterdayAt = new Date(Date.now() - 24 * 60 * 60_000);
    const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(
      yesterdayAt,
    );
    // Nothing reached hand cash yesterday, so the till counts zero and balances.
    const closed = await manager.client.request('POST', `/v1/pos/branches/${branchId}/closings`, {
      body: {
        closingId: randomUUID(),
        businessDate: yesterday,
        counts: [{ walletId: handCash.id, countedPoisha: '0' }],
      },
    });
    expect(closed.statusCode, closed.body).toBe(201);

    const document = sale([{ sku: audited[1]!, qty: 1 }], [{ tender: 'cash', amount: PRICE }], {
      occurredAt: yesterdayAt.toISOString(),
    });
    const [held] = await sync(cashier, [document]);
    expect(held?.outcome).toBe('held');
    const posted = await resolve(manager, held!.reviewItemId!);
    expect(JSON.parse(posted.body)).toMatchObject({ outcome: 'posted' });
    // Yesterday was counted and signed off; the sale lands in today's books instead.
    const lines = await journalLines(document.id);
    expect(lines.length).toBeGreaterThan(0);
    expect(new Set(lines.map((line) => line.business_date))).toEqual(new Set([today]));
  });

  it('W2: a closing id cannot be reused for another day, and a recount is not silently kept', async () => {
    const day = (daysAgo: number) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(
        new Date(Date.now() - daysAgo * 24 * 60 * 60_000),
      );
    const closingId = randomUUID();
    const first = await manager.client.request('POST', `/v1/pos/branches/${branchId}/closings`, {
      body: {
        closingId,
        businessDate: day(3),
        counts: [{ walletId: handCash.id, countedPoisha: '0' }],
      },
    });
    expect(first.statusCode, first.body).toBe(201);

    // The same id for another day was recorded as closed while nothing was counted.
    const reused = await manager.client.request('POST', `/v1/pos/branches/${branchId}/closings`, {
      body: {
        closingId,
        businessDate: day(4),
        counts: [{ walletId: handCash.id, countedPoisha: '0' }],
      },
    });
    expect(reused.statusCode).toBe(409);
    expect(JSON.parse(reused.body)).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    // The same close with a different count is a recount, which M08 must correct.
    const recount = await manager.client.request('POST', `/v1/pos/branches/${branchId}/closings`, {
      body: {
        closingId,
        businessDate: day(3),
        counts: [{ walletId: handCash.id, countedPoisha: '5000' }],
      },
    });
    expect(recount.statusCode).toBe(409);

    // And the honest retry is still the same closing.
    const replay = await manager.client.request('POST', `/v1/pos/branches/${branchId}/closings`, {
      body: {
        closingId,
        businessDate: day(3),
        counts: [{ walletId: handCash.id, countedPoisha: '0' }],
      },
    });
    expect(replay.statusCode, replay.body).toBe(201);
  });

  it('W6: a till cannot sell a unit reserved for an online order', async () => {
    const sku = audited[2]!;
    const actor = { orgId: ORG_A, userId: 'usr_pos_test' };
    // Every unit on the shelf is promised to a confirmed online order.
    await withOrg(actor, (tx) =>
      inventory.reserve(tx, actor, {
        refType: 'order',
        refId: randomUUID(),
        lines: [{ skuId: sku.id, locationId: showroomId, qty: 10 }],
      }),
    );
    const document = sale([{ sku, qty: 1 }], [{ tender: 'cash', amount: PRICE }]);
    const [result] = await sync(cashier, [document]);
    expect(result).toMatchObject({ outcome: 'held', reasons: ['stock_shortfall'] });
    expect(await onHand(sku.id)).toBe(10);
    expect(await journalsFor(document.id)).toBe(0);
  });

  it('W4 and W6: two tills refund a poisha apart, and each unit re-enters at its sale cost', async () => {
    const sku = audited[3]!;
    // Three units for ৳4,000 net: ৳1,333.33 each, a poisha short of a third.
    const sold = sale([{ sku, qty: 3, discount: 50_000 }], [{ tender: 'cash', amount: 400_000 }]);
    expect((await sync(cashier, [sold]))[0]?.outcome).toBe('posted');

    // The average moves after the sale: new units at ৳1,200. A return must still
    // come back at the ৳900 the sold units left at (§8), not at the new average.
    await receiveAt(sku.id, 10, 120_000);

    // Both tills looked the receipt up before either synced: 1,33,333 each.
    const returnOf = (suffix: string) => ({
      kind: 'return' as const,
      id: randomUUID(),
      registerId,
      shiftId,
      saleId: sold.id,
      receiptNo: `R${suffix}-${sold.receiptNo}`,
      occurredAt: new Date().toISOString(),
      lines: [{ lineNo: 1, saleLineNo: 1, qty: 1, refundPoisha: '133333' }],
      tenders: [{ tender: 'cash' as const, amountPoisha: '133333' }],
      refundPoisha: '133333',
    });
    const first = returnOf('A');
    const second = returnOf('B');
    const results = await sync(cashier, [first, second]);
    expect(results.map((result) => result.outcome)).toEqual(['posted', 'posted']);

    const inventoryAccount = await accountOf('inventory');
    const cogsAccount = await accountOf('cogs');
    for (const ret of [first, second]) {
      const lines = await journalLines(ret.id);
      const debitInventory = lines
        .filter((line) => line.account_id === inventoryAccount)
        .reduce((total, line) => total + BigInt(line.debit) - BigInt(line.credit), 0n);
      const creditCogs = lines
        .filter((line) => line.account_id === cogsAccount)
        .reduce((total, line) => total + BigInt(line.credit) - BigInt(line.debit), 0n);
      expect(debitInventory).toBe(BigInt(UNIT_COST));
      expect(creditCogs).toBe(BigInt(UNIT_COST));

      // The stock movement agrees with the journal: the unit came back at ৳900,
      // not at the ৳1,200 average the shelf holds now. A journal at sale cost over
      // a movement at today's average would leave inventory and the ledger apart.
      const movementCost = await withSystem(
        async (tx) =>
          (
            await tx.execute<{ unit_cost_poisha: string }>(sql`
              select unit_cost_poisha::text as unit_cost_poisha from inventory.stock_movements
              where org_id = ${ORG_A} and ref_id = ${ret.id} and kind = 'pos_return'
            `)
          ).map((row) => row.unit_cost_poisha),
        { orgId: ORG_A },
      );
      expect(movementCost).toEqual([String(UNIT_COST)]);
    }
  });
});

// --- shift close, branch close ----------------------------------------------------------

describe('closing', () => {
  it('refuses the branch day while a shift is open or a sale is held', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const response = await manager.client.request('POST', `/v1/pos/branches/${branchId}/closings`, {
      body: {
        closingId: randomUUID(),
        businessDate: today,
        counts: [{ walletId: handCash.id, countedPoisha: '0' }],
      },
    });
    expect(response.statusCode).toBe(409);
  });

  it('closes a shift against the drawer its documents imply', async () => {
    const shift = await cashier.client.request('GET', `/v1/pos/shifts/${shiftId}`);
    const { drawer } = JSON.parse(shift.body) as { drawer: { expectedCashPoisha: string } };
    const closed = await cashier.client.request('POST', `/v1/pos/shifts/${shiftId}/close`, {
      body: { countedCashPoisha: drawer.expectedCashPoisha },
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(JSON.parse(closed.body)).toMatchObject({ status: 'closed', variancePoisha: '0' });

    // A sale that arrives after the count is held, not lost.
    const late = sale([{ sku: skus[1]!, qty: 1 }], [{ tender: 'cash', amount: 150_000 }]);
    const [result] = await sync(cashier, [late]);
    expect(result).toMatchObject({ outcome: 'held', reasons: ['shift_closed'] });
  });
});

describe('the promo code port', () => {
  it('is the refusing default until M16 binds it', async () => {
    expect(harness.app.get(PROMO_CODES, { strict: false })).toBeInstanceOf(NoPromoCodes);
    const response = await cashier.client.request('POST', '/v1/pos/promo-codes/check', {
      body: { registerId, code: 'EID50', basketPoisha: '150000' },
    });
    expect(JSON.parse(response.body)).toEqual({ valid: false, reason: 'promo_unavailable' });
  });
});

describe('signing out at a shared till', () => {
  it('ends the session, so the next cashier does not inherit it', async () => {
    const other = await harness.asRole('branch_manager', ORG_A, { branchIds: [branchId] });
    expect((await other.client.request('GET', '/v1/pos/registers')).statusCode).toBe(200);
    const out = await other.client.request('POST', '/api/auth/sign-out');
    expect(out.statusCode, out.body).toBeLessThan(400);
    expect((await other.client.request('GET', '/v1/pos/registers')).statusCode).toBe(401);
  });
});
