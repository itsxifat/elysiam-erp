import { randomUUID } from 'node:crypto';

import { findCostFields } from '@elysium/contracts';
import { withOrg } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  ORG_B,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import {
  seedProductWithSkus,
  warehouseId,
  type SeededSku,
} from '../inventory/inventory.testing.js';
import { SupplyModule } from './supply.module.js';
import { applySupplyMigrations, seedSupplier, walletAccountId } from './supply.testing.js';

/**
 * Suppliers and purchasing over HTTP (M09 acceptance checks 1–6).
 *
 * Every check here is asserted through the real pipeline — the ability guard, the scope
 * interceptor, the serializer and the audit net, in the order `main.api.ts` mounts them —
 * against real PostgreSQL, because three of the five are about what the *database*
 * refuses and one is about what a rollback leaves behind.
 *
 * The two with the most teeth:
 *
 * * **Check 1, fault injection.** A closed period is used to make the journal step fail
 *   *after* the lines have been priced and the movements attempted, which is exactly the
 *   window a compensating-action design would leak through. The test then reads the
 *   stock level, the SKU's weighted average, the line's cost and the supplier's balance
 *   and asserts every one of them is untouched. It is not enough that the call returned
 *   an error.
 * * **Check 2, the statement.** Compared against `GET /v1/ledger/party-balances`, which
 *   is M03's own query in another module. Two pieces of code over the same rows; if they
 *   ever disagree the supplier statement is wrong, and nothing else would notice.
 */

let harness: HttpHarness;

let admin: RoleClient;
let secondAdmin: RoleClient;
let accounts: RoleClient;
let warehouse: RoleClient;
let sales: RoleClient;
let otherOrgAdmin: RoleClient;

let location = '';
let wallet = '';
let supplier = '';
let skus: SeededSku[] = [];

beforeAll(async () => {
  harness = await startHttpHarness('supply-e2e', { extraModules: [SupplyModule] });
  await applySupplyMigrations();

  location = await warehouseId(ORG_A);
  wallet = await walletAccountId(ORG_A);
  supplier = await seedSupplier(ORG_A, { code: 'SUP-E2E', name: 'Pahartoli Textile Mills' });
  ({ skus } = await seedProductWithSkus(ORG_A, 'supplye2e', 6));

  admin = await harness.asRole('org_admin', ORG_A);
  secondAdmin = await harness.asRole('org_admin', ORG_A);
  accounts = await harness.asRole('accounts', ORG_A);
  warehouse = await harness.asRole('warehouse', ORG_A);
  sales = await harness.asRole('sales', ORG_A);
  otherOrgAdmin = await harness.asRole('org_admin', ORG_B);

  /*
   * A high threshold, so the ordinary payments below post straight away.
   *
   * With **no** threshold configured for a type, D-068 holds every request pending —
   * which is the safe default and is not what check 5's scenario is about. The
   * maker-checker suite further down lowers it to 100,000 and drives the held path.
   */
  await setThreshold('supplier_payment', '100000000');
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

// --- helpers ------------------------------------------------------------------

function body<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

function sku(index: number): string {
  const found = skus[index];
  if (found === undefined) throw new Error('the fixture seeded fewer SKUs than this test expects');
  return found.id;
}

interface ReceiveResult {
  readonly id: string;
  readonly status: string;
  readonly journalId: string | null;
  readonly businessDate: string;
  readonly totalCostPoisha?: string;
}

/** Enter and receive a priced supply in one call, the way accounts does (§6). */
async function enterSupply(
  lines: readonly { skuId: string; qty: number; unitCostPoisha: string }[],
  overrides: { occurredAt?: string; invoiceNumber?: string; supplierId?: string } = {},
): Promise<{ statusCode: number; result: ReceiveResult; raw: string }> {
  const response = await accounts.client.request('POST', '/v1/supply/entries', {
    body: {
      supplyId: randomUUID(),
      supplierId: overrides.supplierId ?? supplier,
      locationId: location,
      lines,
      ...(overrides.occurredAt === undefined ? {} : { occurredAt: overrides.occurredAt }),
      ...(overrides.invoiceNumber === undefined ? {} : { invoiceNumber: overrides.invoiceNumber }),
    },
  });
  return {
    statusCode: response.statusCode,
    result: body<ReceiveResult>(response),
    raw: response.body,
  };
}

async function onHand(skuId: string): Promise<number> {
  return withOrg({ orgId: ORG_A, userId: 'usr_supply_e2e' }, async (tx) => {
    const rows = await tx.execute<{ on_hand: number }>(sql`
      select on_hand from inventory.stock_levels
      where org_id = ${ORG_A} and sku_id = ${skuId} and location_id = ${location}
    `);
    return rows[0]?.on_hand ?? 0;
  });
}

async function wac(skuId: string): Promise<string> {
  return withOrg({ orgId: ORG_A, userId: 'usr_supply_e2e' }, async (tx) => {
    const rows = await tx.execute<{ wac_poisha: string }>(sql`
      select wac_poisha::text as wac_poisha from inventory.sku_costs
      where org_id = ${ORG_A} and sku_id = ${skuId}
    `);
    return rows[0]?.wac_poisha ?? '0';
  });
}

/** Every line of one journal, by the account subtype it landed on. */
async function journalLines(
  journalId: string,
): Promise<{ subtype: string; debit: string; credit: string }[]> {
  return withOrg({ orgId: ORG_A, userId: 'usr_supply_e2e' }, async (tx) => {
    const rows = await tx.execute<{ subtype: string; debit: string; credit: string }>(sql`
      select a.subtype::text as subtype, l.debit_poisha::text as debit,
             l.credit_poisha::text as credit
      from ledger.journal_lines l
      join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
      where l.org_id = ${ORG_A} and l.journal_id = ${journalId}
      order by l.line_no
    `);
    return [...rows];
  });
}

interface SupplierListRow {
  readonly id: string;
  readonly duePoisha?: string;
  readonly advancePoisha?: string;
}

async function balances(
  client: RoleClient = accounts,
  supplierId: string = supplier,
): Promise<SupplierListRow> {
  const response = await client.client.request('GET', '/v1/supply/suppliers');
  expect(response.statusCode, response.body).toBe(200);
  const { items } = body<{ items: SupplierListRow[] }>(response);
  const found = items.find((row) => row.id === supplierId);
  if (found === undefined) throw new Error('the supplier is missing from its own list');
  return found;
}

/** Configure one org threshold through the real flow (a first one needs a second admin). */
async function setThreshold(type: string, thresholdPoisha: string): Promise<void> {
  const set = await admin.client.request('PUT', '/v1/approvals/thresholds', {
    body: { type, thresholdPoisha },
  });
  expect(set.statusCode, set.body).toBe(200);
  const { approvalId } = body<{ approvalId?: string | null }>(set);
  // Absent as well as null: lowering a threshold applies at once (D-073), and only
  // raising one — or setting the first — needs a second org admin.
  if (approvalId == null) return;
  const decided = await secondAdmin.client.request('POST', `/v1/approvals/${approvalId}/decide`, {
    body: { decision: 'approved' },
  });
  expect(decided.statusCode, decided.body).toBe(201);
}

// --- check 6 (the API half) ---------------------------------------------------

describe('check 6: accounts enters a 3-line supply, and stock and supplier due update', () => {
  it('moves three SKUs onto the shelf and credits the supplier the invoice total', async () => {
    const lines = [
      { skuId: sku(0), qty: 10, unitCostPoisha: '50000' },
      { skuId: sku(1), qty: 4, unitCostPoisha: '25000' },
      { skuId: sku(2), qty: 6, unitCostPoisha: '12500' },
    ];
    const before = await balances();

    const { statusCode, result, raw } = await enterSupply(lines, { invoiceNumber: 'INV-1001' });
    expect(statusCode, raw).toBe(201);
    expect(result.status).toBe('received');
    expect(result.journalId).not.toBeNull();
    // 10×50,000 + 4×25,000 + 6×12,500 = 675,000 poisha.
    expect(result.totalCostPoisha).toBe('675000');

    expect(await onHand(sku(0))).toBe(10);
    expect(await onHand(sku(1))).toBe(4);
    expect(await onHand(sku(2))).toBe(6);

    const after = await balances();
    expect(BigInt(after.duePoisha ?? '0') - BigInt(before.duePoisha ?? '0')).toBe(675_000n);

    const lines_ = await journalLines(result.journalId ?? '');
    expect(lines_).toEqual([
      { subtype: 'inventory', debit: '675000', credit: '0' },
      { subtype: 'supplier_payable', debit: '0', credit: '675000' },
    ]);
  });

  it('refuses the same invoice number from the same supplier twice', async () => {
    const duplicate = await enterSupply([{ skuId: sku(0), qty: 1, unitCostPoisha: '50000' }], {
      invoiceNumber: 'INV-1001',
    });
    // The partial unique index in migration 0035, surfaced as a 409 rather than a 500:
    // paying one invoice twice is the expensive mistake in purchasing, and the person
    // making it has to be told which invoice.
    expect(duplicate.statusCode, duplicate.raw).toBe(409);
    expect((JSON.parse(duplicate.raw) as { code: string }).code).toBe('CONFLICT');
  });
});

// --- check 4 ------------------------------------------------------------------

describe('check 4: cost visibility and the qty-only draft', () => {
  it('never shows warehouse or sales a unit cost, from any endpoint', async () => {
    for (const client of [warehouse, sales]) {
      for (const url of [
        '/v1/supply/suppliers',
        '/v1/supply/entries',
        '/v1/supply/returns',
        '/v1/supply/payments',
        `/v1/supply/suppliers/${supplier}/statement?to=2030-12-31`,
      ]) {
        const response = await client.client.request('GET', url);
        // §6 gives warehouse `create`/`update` on Supply and no `read`; sales holds no
        // Supply rule at all. Both are a 403 at the guard, before a handler runs — and
        // the body is checked anyway, because a future grant must not leak cost.
        expect(response.statusCode, `${url} as this role`).toBe(403);
        expect(findCostFields(body<unknown>(response))).toEqual([]);
      }
    }
  });

  it('lets warehouse create a qty-only draft, and refuses it a priced entry', async () => {
    const draftId = randomUUID();
    const created = await warehouse.client.request('POST', '/v1/supply/drafts', {
      body: {
        draftId,
        supplierId: supplier,
        locationId: location,
        lines: [{ skuId: sku(3), qty: 12 }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(body<{ status: string; lineCount: number }>(created)).toMatchObject({
      status: 'draft',
      lineCount: 1,
    });
    expect(findCostFields(body<unknown>(created))).toEqual([]);

    // The same draft id again is the same draft, not a second one.
    const retried = await warehouse.client.request('POST', '/v1/supply/drafts', {
      body: {
        draftId,
        supplierId: supplier,
        locationId: location,
        lines: [{ skuId: sku(3), qty: 12 }],
      },
    });
    expect(retried.statusCode, retried.body).toBe(201);
    expect(body<{ id: string }>(retried).id).toBe(draftId);

    // Pricing is `read Cost`, which warehouse does not hold: refused at the guard.
    const priced = await warehouse.client.request('POST', `/v1/supply/entries/${draftId}/receive`, {
      body: { lines: [{ skuId: sku(3), unitCostPoisha: '1' }] },
    });
    expect(priced.statusCode, priced.body).toBe(403);

    // Nothing moved: a refused receipt leaves the shelf where it was.
    expect(await onHand(sku(3))).toBe(0);

    // And accounts completes it, which is D-005's whole flow.
    const received = await accounts.client.request(
      'POST',
      `/v1/supply/entries/${draftId}/receive`,
      { body: { lines: [{ skuId: sku(3), unitCostPoisha: '30000' }], invoiceNumber: 'INV-1002' } },
    );
    expect(received.statusCode, received.body).toBe(201);
    expect(body<ReceiveResult>(received).totalCostPoisha).toBe('360000');
    expect(await onHand(sku(3))).toBe(12);
  });

  it('refuses to receive a draft with a line nobody priced', async () => {
    const draftId = randomUUID();
    const created = await warehouse.client.request('POST', '/v1/supply/drafts', {
      body: {
        draftId,
        supplierId: supplier,
        locationId: location,
        lines: [
          { skuId: sku(4), qty: 5 },
          { skuId: sku(5), qty: 7 },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);

    const partial = await accounts.client.request('POST', `/v1/supply/entries/${draftId}/receive`, {
      body: { lines: [{ skuId: sku(4), unitCostPoisha: '10000' }] },
    });
    expect(partial.statusCode, partial.body).toBe(400);
    expect(body<{ code: string }>(partial).code).toBe('SUPPLY_COST_REQUIRED');
    expect(await onHand(sku(4))).toBe(0);
  });

  it("keeps one org out of another org's suppliers", async () => {
    const response = await otherOrgAdmin.client.request('GET', `/v1/supply/suppliers/${supplier}`);
    expect(response.statusCode).toBe(404);
  });
});

// --- check 3 ------------------------------------------------------------------

describe("check 3: §8's supplier return posts the variance", () => {
  it('credits the supplier at the original cost and relieves inventory at WAC', async () => {
    const target = sku(5);
    // §8's worked example: 10 @ ৳500.00, then 30 @ ৳540.00, so WAC = 53,000 poisha.
    const first = await enterSupply([{ skuId: target, qty: 10, unitCostPoisha: '50000' }]);
    expect(first.statusCode, first.raw).toBe(201);
    const second = await enterSupply([{ skuId: target, qty: 30, unitCostPoisha: '54000' }]);
    expect(second.statusCode, second.raw).toBe(201);
    expect(await wac(target)).toBe('53000');

    const returned = await accounts.client.request('POST', '/v1/supply/returns', {
      body: {
        returnId: randomUUID(),
        supplierId: supplier,
        locationId: location,
        reason: 'Shade mismatch across the second lot',
        lines: [{ skuId: target, qty: 3, originalUnitCostPoisha: '54000' }],
      },
    });
    expect(returned.statusCode, returned.body).toBe(201);
    const { journalId, creditPoisha } = body<{ journalId: string; creditPoisha: string }>(returned);
    expect(creditPoisha).toBe('162000');

    /*
     * The three-way posting, exactly as §8's example computes it:
     *   Dr Supplier payable  3 × 54,000 = 162,000
     *   Cr Inventory         3 × 53,000 = 159,000
     *   Cr Purchase price variance          3,000
     * The variance is on the **credit** side: the return recovers more than the units
     * were carried at, which is a gain.
     */
    expect(await journalLines(journalId)).toEqual([
      { subtype: 'supplier_payable', debit: '162000', credit: '0' },
      { subtype: 'inventory', debit: '0', credit: '159000' },
      { subtype: 'purchase_price_variance', debit: '0', credit: '3000' },
    ]);

    expect(await onHand(target)).toBe(37);
    // Removing units at the average does not move the average (§8).
    expect(await wac(target)).toBe('53000');
  });
});

// --- check 5 ------------------------------------------------------------------

describe('check 5: advance → supply → apply advance → payment', () => {
  it('leaves the correct due and advance at every step', async () => {
    const only = await seedSupplier(ORG_A, { code: 'SUP-ADV', name: 'Rahman Accessories' });

    const advanceId = randomUUID();
    const advance = await accounts.client.request('POST', '/v1/supply/payments', {
      body: {
        paymentId: advanceId,
        supplierId: only,
        walletAccountId: wallet,
        kind: 'advance',
        amountPoisha: '100000',
        memo: 'Advance against March order',
      },
    });
    expect(advance.statusCode, advance.body).toBe(201);
    expect(body<{ status: string }>(advance).status).toBe('posted');

    let state = await balances(accounts, only);
    expect(state.duePoisha).toBe('0');
    expect(state.advancePoisha).toBe('100000');

    const entry = await enterSupply([{ skuId: sku(0), qty: 3, unitCostPoisha: '50000' }], {
      supplierId: only,
    });
    expect(entry.statusCode, entry.raw).toBe(201);
    state = await balances(accounts, only);
    expect(state.duePoisha, 'the invoice is credited in full, whatever was paid ahead').toBe(
      '150000',
    );
    expect(state.advancePoisha).toBe('100000');

    const applied = await accounts.client.request('POST', '/v1/supply/advance-applications', {
      body: {
        applicationId: randomUUID(),
        paymentId: advanceId,
        supplyId: entry.result.id,
        amountPoisha: '100000',
      },
    });
    expect(applied.statusCode, applied.body).toBe(201);
    state = await balances(accounts, only);
    expect(state.duePoisha).toBe('50000');
    expect(state.advancePoisha).toBe('0');

    const settle = await accounts.client.request('POST', '/v1/supply/payments', {
      body: {
        paymentId: randomUUID(),
        supplierId: only,
        walletAccountId: wallet,
        kind: 'payment',
        amountPoisha: '50000',
      },
    });
    expect(settle.statusCode, settle.body).toBe(201);
    state = await balances(accounts, only);
    expect(state.duePoisha).toBe('0');
    expect(state.advancePoisha).toBe('0');
  });

  it('refuses to apply more of an advance than is left', async () => {
    const only = await seedSupplier(ORG_A, { code: 'SUP-OVER', name: 'Chittagong Trims' });
    const advanceId = randomUUID();
    const advance = await accounts.client.request('POST', '/v1/supply/payments', {
      body: {
        paymentId: advanceId,
        supplierId: only,
        walletAccountId: wallet,
        kind: 'advance',
        amountPoisha: '40000',
      },
    });
    expect(advance.statusCode, advance.body).toBe(201);

    const entry = await enterSupply([{ skuId: sku(1), qty: 2, unitCostPoisha: '25000' }], {
      supplierId: only,
    });
    expect(entry.statusCode, entry.raw).toBe(201);

    const over = await accounts.client.request('POST', '/v1/supply/advance-applications', {
      body: {
        applicationId: randomUUID(),
        paymentId: advanceId,
        supplyId: entry.result.id,
        amountPoisha: '40001',
      },
    });
    // `supplier_advance` is an asset; an over-application would leave it credit-balanced.
    expect(over.statusCode, over.body).toBe(409);
    expect(body<{ code: string }>(over).code).toBe('SUPPLY_ADVANCE_INVALID');
    expect((await balances(accounts, only)).advancePoisha).toBe('40000');
  });
});

// --- the maker-checker half of §6 --------------------------------------------

describe('a supplier payment above the threshold waits for a checker', () => {
  it('posts nothing until it is approved, then posts inside that transaction', async () => {
    await setThreshold('supplier_payment', '100000');
    const only = await seedSupplier(ORG_A, { code: 'SUP-APPR', name: 'Narayanganj Dyeing' });

    const raised = await accounts.client.request('POST', '/v1/supply/payments', {
      body: {
        paymentId: randomUUID(),
        supplierId: only,
        walletAccountId: wallet,
        kind: 'advance',
        amountPoisha: '250000',
      },
    });
    expect(raised.statusCode, raised.body).toBe(201);
    const held = body<{ status: string; journalId: string | null; approvalId: string }>(raised);
    expect(held.status).toBe('pending_approval');
    expect(held.journalId).toBeNull();

    // Nothing is in any balance yet, which is the half a test usually forgets.
    expect((await balances(accounts, only)).advancePoisha).toBe('0');

    const decided = await admin.client.request('POST', `/v1/approvals/${held.approvalId}/decide`, {
      body: { decision: 'approved' },
    });
    expect(decided.statusCode, decided.body).toBe(201);

    expect((await balances(accounts, only)).advancePoisha).toBe('250000');
  });
});

// --- check 1 ------------------------------------------------------------------

describe('check 1: a failing journal step leaves nothing behind', () => {
  it('leaves no stock, no cost and no supplier change when the period is closed', async () => {
    const target = sku(2);
    const only = await seedSupplier(ORG_A, { code: 'SUP-FAULT', name: 'Tongi Knitwear' });

    /*
     * The fault is injected through a **closed period**, not a stub.
     *
     * Migration 0014's period lock refuses the journal, and it refuses it inside
     * `ledger.post` — which this module calls *after* it has priced the lines and
     * created the movements. That is precisely the window a design with compensating
     * actions would leak through, and it is not reachable by mocking the ledger.
     */
    const closed = await accounts.client.request('POST', '/v1/ledger/periods/close', {
      body: { month: '2026-01' },
    });
    expect(closed.statusCode, closed.body).toBe(201);

    const before = {
      onHand: await onHand(target),
      wac: await wac(target),
      due: (await balances(accounts, only)).duePoisha,
      movements: await movementCount(target),
    };

    const attempt = await enterSupply([{ skuId: target, qty: 99, unitCostPoisha: '77000' }], {
      supplierId: only,
      occurredAt: '2026-01-15T04:00:00.000Z',
    });
    expect(attempt.statusCode, attempt.raw).toBe(409);
    expect((JSON.parse(attempt.raw) as { code: string }).code).toBe('PERIOD_CLOSED');

    expect(await onHand(target), 'no stock').toBe(before.onHand);
    expect(await wac(target), 'no change to the weighted average').toBe(before.wac);
    expect(await movementCount(target), 'no movement').toBe(before.movements);
    expect((await balances(accounts, only)).duePoisha, 'no supplier change').toBe(before.due);

    // The draft the call created before it failed is still a draft with no cost on it:
    // `createAndReceive` commits the draft first on purpose, so a retry lands on the
    // receive path instead of a duplicate-key error.
    const drafts = await accounts.client.request(
      'GET',
      `/v1/supply/entries?supplierId=${only}&status=received`,
    );
    expect(drafts.statusCode, drafts.body).toBe(200);
    expect(body<{ items: unknown[] }>(drafts).items).toEqual([]);
  });
});

async function movementCount(skuId: string): Promise<number> {
  return withOrg({ orgId: ORG_A, userId: 'usr_supply_e2e' }, async (tx) => {
    const rows = await tx.execute<{ total: string }>(sql`
      select count(*)::text as total from inventory.stock_movements
      where org_id = ${ORG_A} and sku_id = ${skuId}
    `);
    return Number(rows[0]?.total ?? '0');
  });
}

// --- check 2 ------------------------------------------------------------------

describe("check 2: the statement's closing balances equal the ledger's party balances", () => {
  it('agrees with GET /v1/ledger/party-balances to the poisha', async () => {
    const asOf = '2030-12-31';
    const statement = await accounts.client.request(
      'GET',
      `/v1/supply/suppliers/${supplier}/statement?to=${asOf}`,
    );
    expect(statement.statusCode, statement.body).toBe(200);
    const closing = body<{
      closingDuePoisha: string;
      closingAdvancePoisha: string;
      items: { runningDuePoisha: string }[];
    }>(statement);

    const ledger = await accounts.client.request(
      'GET',
      `/v1/ledger/party-balances?asOf=${asOf}&partyType=supplier&partyId=${supplier}`,
    );
    expect(ledger.statusCode, ledger.body).toBe(200);
    const { items } = body<{
      items: { subtype: string; balancePoisha: string }[];
    }>(ledger);

    const fromLedger = (subtype: string): string =>
      items.find((row) => row.subtype === subtype)?.balancePoisha ?? '0';

    expect(closing.closingDuePoisha).toBe(fromLedger('supplier_payable'));
    expect(closing.closingAdvancePoisha).toBe(fromLedger('supplier_advance'));

    // And the running total a person reads down the page arrives at the same place.
    const last = closing.items.at(-1);
    expect(last?.runningDuePoisha).toBe(closing.closingDuePoisha);
  });

  /*
   * The comparison above is nearly a tautology, and an audit said so. The statement's
   * closing figure comes from `supplierBalances`, which is the same grouped SUM over the
   * same `journal_lines` as the party-balance endpoint it is compared with. A journal
   * posted with the wrong amount, to the wrong party, on the wrong side — or a filter
   * both queries share — moves both numbers together, and they still agree.
   *
   * So this builds a supplier's history whose every posting is known, works the closing
   * balances out by hand, and holds the statement to those figures. Every event a supplier
   * account can see is in it: an advance, two supplies (one in an earlier month, so a
   * ranged statement has an opening balance), a return at the original cost, an advance
   * applied to a supply, and a payment.
   *
   *   event                        due (supplier_payable)   advance (supplier_advance)
   *   supply 1, 2026-03-10         + 4 × 25,000 = 100,000
   *   advance paid                                            + 100,000
   *   supply 2                     + 2 × 60,000 = 120,000
   *   return 1 of supply 2         −     60,000  (the price paid, not today's average)
   *   advance applied to supply 1  −     30,000               −  30,000
   *   payment                      −     50,000
   *   closing                             80,000                  70,000
   *
   * From 2026-04-01 the opening due is supply 1's 100,000 and the opening advance is
   * nothing, and the same closing figures must come out of the bottom.
   *
   * Both supplies are of the same SKU on purpose. Its average after them is
   * (4 × 25,000 + 2 × 60,000) / 6 = 36,667, so a return that credited the supplier at the
   * average instead of at the 60,000 they charged would close the due at 103,333 — and
   * would still agree with the party-balance endpoint, because both read the same
   * wrongly-posted journal.
   */
  it('closes at the balances worked out by hand, not merely at the ledger’s copy of them', async () => {
    // A threshold far above these amounts, so every payment posts without a checker:
    // the maker-checker suite above lowered it.
    await setThreshold('supplier_payment', '100000000');
    const only = await seedSupplier(ORG_A, { code: 'SUP-STMT', name: 'Savar Buttons & Zips' });

    const first = await enterSupply([{ skuId: sku(4), qty: 4, unitCostPoisha: '25000' }], {
      supplierId: only,
      occurredAt: '2026-03-10T05:00:00.000Z',
    });
    expect(first.statusCode, first.raw).toBe(201);

    const advanceId = randomUUID();
    const advance = await accounts.client.request('POST', '/v1/supply/payments', {
      body: {
        paymentId: advanceId,
        supplierId: only,
        walletAccountId: wallet,
        kind: 'advance',
        amountPoisha: '100000',
      },
    });
    expect(advance.statusCode, advance.body).toBe(201);
    expect(body<{ status: string }>(advance).status).toBe('posted');

    const second = await enterSupply([{ skuId: sku(4), qty: 2, unitCostPoisha: '60000' }], {
      supplierId: only,
    });
    expect(second.statusCode, second.raw).toBe(201);

    const returned = await accounts.client.request('POST', '/v1/supply/returns', {
      body: {
        returnId: randomUUID(),
        supplierId: only,
        locationId: location,
        reason: 'One zip pull snapped in QC',
        lines: [{ skuId: sku(4), qty: 1, originalUnitCostPoisha: '60000' }],
      },
    });
    expect(returned.statusCode, returned.body).toBe(201);

    const applied = await accounts.client.request('POST', '/v1/supply/advance-applications', {
      body: {
        applicationId: randomUUID(),
        paymentId: advanceId,
        supplyId: first.result.id,
        amountPoisha: '30000',
      },
    });
    expect(applied.statusCode, applied.body).toBe(201);

    const paid = await accounts.client.request('POST', '/v1/supply/payments', {
      body: {
        paymentId: randomUUID(),
        supplierId: only,
        walletAccountId: wallet,
        kind: 'payment',
        amountPoisha: '50000',
      },
    });
    expect(paid.statusCode, paid.body).toBe(201);
    expect(body<{ status: string }>(paid).status).toBe('posted');

    interface Statement {
      openingDuePoisha: string;
      openingAdvancePoisha: string;
      totalDebitPoisha: string;
      totalCreditPoisha: string;
      closingDuePoisha: string;
      closingAdvancePoisha: string;
      items: { account: string; runningDuePoisha: string; runningAdvancePoisha: string }[];
    }
    const statementOf = async (query: string): Promise<Statement> => {
      const response = await accounts.client.request(
        'GET',
        `/v1/supply/suppliers/${only}/statement?${query}`,
      );
      expect(response.statusCode, response.body).toBe(200);
      return body<Statement>(response);
    };

    const whole = await statementOf('to=2030-12-31');
    expect(whole.openingDuePoisha).toBe('0');
    expect(whole.openingAdvancePoisha).toBe('0');
    expect(whole.closingDuePoisha).toBe('80000');
    expect(whole.closingAdvancePoisha).toBe('70000');
    // Seven lines: the application is one journal touching both supplier accounts.
    // Debits 100,000 + 60,000 + 30,000 + 50,000; credits 100,000 + 120,000 + 30,000.
    expect(whole.items).toHaveLength(7);
    expect(whole.totalDebitPoisha).toBe('240000');
    expect(whole.totalCreditPoisha).toBe('250000');
    // The running columns, line by line, in date order: the March supply first.
    expect(
      whole.items.map((line) => [line.account, line.runningDuePoisha, line.runningAdvancePoisha]),
    ).toEqual([
      ['supplier_payable', '100000', '0'],
      ['supplier_advance', '100000', '100000'],
      ['supplier_payable', '220000', '100000'],
      ['supplier_payable', '160000', '100000'],
      ['supplier_payable', '130000', '100000'],
      ['supplier_advance', '130000', '70000'],
      ['supplier_payable', '80000', '70000'],
    ]);

    const ranged = await statementOf('from=2026-04-01&to=2030-12-31');
    expect(ranged.openingDuePoisha).toBe('100000');
    expect(ranged.openingAdvancePoisha).toBe('0');
    expect(ranged.items).toHaveLength(6);
    expect(ranged.closingDuePoisha).toBe('80000');
    expect(ranged.closingAdvancePoisha).toBe('70000');
    expect(ranged.items.at(-1)?.runningDuePoisha).toBe('80000');

    // The supplier list reads the same two figures, which is the screen accounts works from.
    const listed = await balances(accounts, only);
    expect(listed.duePoisha).toBe('80000');
    expect(listed.advancePoisha).toBe('70000');
  });
});
