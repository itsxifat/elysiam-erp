import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { findCostFields } from '@elysium/contracts';
import { SEED_ORGS, seedOrgId, withOrg, withSystem } from '@elysium/db';
import { businessDate, internalEan13, isInternalEan13, poisha } from '@elysium/domain';
import { sql } from 'drizzle-orm';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  ORG_B,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import { INVENTORY_API, type InventoryApi } from './inventory.api.js';
import { makeLocation, warehouseId } from './inventory.testing.js';

/**
 * M38a over HTTP against real PostgreSQL (D-602 to D-606): every SKU gets a valid, unique
 * internal EAN-13; a scan resolves to its variant; stock in hand posts one balanced journal
 * per entry (Dr Inventory / Cr Opening balance equity) with `opening_balance` movements, is
 * idempotent on its key, keeps cost from the warehouse role, posts only the draft its poster
 * read, and is refused once the brand's opening stock window is closed; a posted entry is
 * taken back out exactly, through a second admin's approval, or not at all; reopening needs
 * a second admin's approval for that close; a count is counted by scanning; and migration
 * 0114's backfill closes the window of a brand with history and numbers every SKU.
 *
 * The window tests run after the entry tests: closing it is the point of no return the owner
 * asked for, and everything before needs it open. The backfill runs last.
 */

let harness: HttpHarness;
let admin: RoleClient;
let secondAdmin: RoleClient;
let accounts: RoleClient;
let warehouse: RoleClient;
let sales: RoleClient;
let otherAdmin: RoleClient;

let mainWarehouse = '';
let size = { id: '', values: {} as Record<string, string> };
/** A posted entry the window tests try to reverse after the close. */
let postedEntryId = '';
/** When the first close happened, as a reopen request's payload names it. */
let firstClosedAt = '';

interface Product {
  readonly id: string;
  readonly skus: readonly {
    readonly id: string;
    readonly skuCode: string;
    readonly barcode: string | null;
    readonly attributes: readonly { readonly valueId: string; readonly valueLabel: string }[];
  }[];
}

function body<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

async function call<T>(
  who: RoleClient,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
  expected?: number,
): Promise<T> {
  const response = await who.client.request(
    method,
    url,
    payload === undefined ? {} : { body: payload },
  );
  if (expected !== undefined) expect(response.statusCode, response.body).toBe(expected);
  return body<T>(response);
}

async function product(name: string, slug: string): Promise<Product> {
  return call<Product>(
    admin,
    'POST',
    '/v1/catalog/products',
    {
      name,
      slug,
      status: 'active',
      pricePoisha: '199000',
      axes: [{ attributeId: size.id, valueIds: [size.values.M, size.values.L, size.values.XL] }],
    },
    201,
  );
}

async function journalOf(key: string) {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{
        id: string;
        subtype: string;
        debit: string;
        credit: string;
      }>(sql`
        select j.id, a.subtype::text as subtype, l.debit_poisha::text as debit,
               l.credit_poisha::text as credit
        from ledger.journals j
        join ledger.journal_lines l on l.org_id = j.org_id and l.journal_id = j.id
        join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
        where j.org_id = ${ORG_A} and j.idempotency_key = ${key}
        order by l.line_no
      `);
      return [...rows];
    },
    { orgId: ORG_A },
  );
}

async function journalById(id: string) {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{
        reverses_journal_id: string | null;
        subtype: string;
        debit: string;
        credit: string;
      }>(sql`
        select j.reverses_journal_id, a.subtype::text as subtype,
               l.debit_poisha::text as debit, l.credit_poisha::text as credit
        from ledger.journals j
        join ledger.journal_lines l on l.org_id = j.org_id and l.journal_id = j.id
        join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
        where j.org_id = ${ORG_A} and j.id = ${id}
        order by l.line_no
      `);
      return [...rows];
    },
    { orgId: ORG_A },
  );
}

async function movementsOf(entryId: string) {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{
        sku_id: string;
        kind: string;
        qty_delta: number;
        unit_cost_poisha: string;
      }>(sql`
        select sku_id, kind::text as kind, qty_delta, unit_cost_poisha::text as unit_cost_poisha
        from inventory.stock_movements
        where org_id = ${ORG_A} and ref_type = 'stock_in_hand' and ref_id = ${entryId}
      `);
      return [...rows];
    },
    { orgId: ORG_A },
  );
}

/** What PostgreSQL said, through the driver's wrapping: the message and every cause. */
async function databaseRefusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    const messages: string[] = [];
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
      messages.push(current.message);
    }
    return messages.join(' | ');
  }
  return 'no error';
}

/** This brand's audit rows for one action. */
async function auditRowsFor(
  orgId: string,
  action: string,
): Promise<{ entity_id: string; before: unknown; after: unknown }[]> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ entity_id: string; before: unknown; after: unknown }>(sql`
        select entity_id, before, after from audit.audit_log
        where org_id = ${orgId} and action = ${action}
        order by created_at
      `);
      return [...rows];
    },
    { orgId },
  );
}

async function enterStock(
  lines: readonly { skuId: string | undefined; qty: number; unitCostPoisha: string }[],
): Promise<{ id: string; journalId: string }> {
  const entryId = randomUUID();
  const posted = await call<{ journalId: string }>(
    admin,
    'POST',
    '/v1/inventory/stock-in-hand',
    { entryId, locationId: mainWarehouse, lines },
    201,
  );
  return { id: entryId, journalId: posted.journalId };
}

/**
 * 1300 Inventory in the trial balance less the stock valuation (Σ on hand × WAC). Not zero in
 * this file: blending stock at uneven costs rounds the average once per receipt (§8), and the
 * entries above do. What a reversal must never do is move it.
 */
async function booksDifference(): Promise<bigint> {
  const balance = await call<{ items: { code: string; balancePoisha: string }[] }>(
    admin,
    'GET',
    `/v1/ledger/trial-balance?asOf=${businessDate(new Date())}`,
    undefined,
    200,
  );
  const valuation = await call<{ stockValuePoisha: string }>(
    admin,
    'GET',
    '/v1/inventory/valuation',
    undefined,
    200,
  );
  const inventory = balance.items.find((row) => row.code === '1300')?.balancePoisha ?? '0';
  return BigInt(inventory) - BigInt(valuation.stockValuePoisha);
}

async function lookup(code: string | null | undefined) {
  return call<{ wacPoisha: string; stock: { onHand: number } }>(
    admin,
    'GET',
    `/v1/catalog/lookup?code=${code ?? ''}`,
    undefined,
    200,
  );
}

beforeAll(async () => {
  harness = await startHttpHarness('stock-in-hand');
  admin = await harness.asRole('org_admin', ORG_A);
  secondAdmin = await harness.asRole('org_admin', ORG_A);
  accounts = await harness.asRole('accounts', ORG_A);
  warehouse = await harness.asRole('warehouse', ORG_A);
  sales = await harness.asRole('sales', ORG_A);
  otherAdmin = await harness.asRole('org_admin', ORG_B);
  mainWarehouse = await warehouseId(ORG_A);

  const attribute = await call<{ id: string }>(
    admin,
    'POST',
    '/v1/catalog/attributes',
    { code: 'SIZE_SIH', name: 'Size', kind: 'size', isVariant: true },
    201,
  );
  const values: Record<string, string> = {};
  for (const [index, code] of ['M', 'L', 'XL'].entries()) {
    const value = await call<{ id: string }>(
      admin,
      'POST',
      `/v1/catalog/attributes/${attribute.id}/values`,
      { code, label: code, position: index },
      201,
    );
    values[code] = value.id;
  }
  size = { id: attribute.id, values };
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

describe('an EAN-13 for every SKU (D-603)', () => {
  it('gives each new SKU a valid internal EAN-13, unique under concurrent creates', async () => {
    const made = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        product(`Concurrent ${String(index)}`, `concurrent-sih-${String(index)}`),
      ),
    );
    const barcodes = made.flatMap((entry) => entry.skus.map((sku) => sku.barcode));
    expect(barcodes).toHaveLength(18);
    for (const code of barcodes) expect(code !== null && isInternalEan13(code)).toBe(true);
    expect(new Set(barcodes).size).toBe(18);

    // The counter moved past every number handed out: the next product continues after it.
    const next = await product('After the burst', 'after-burst-sih');
    const sequences = barcodes.map((code) => Number(code?.slice(1, 12)));
    for (const sku of next.skus) {
      expect(Number(sku.barcode?.slice(1, 12))).toBeGreaterThan(Math.max(...sequences));
    }
  });

  it('computes the same numbers in SQL as in the domain', async () => {
    const samples = fc.sample(fc.integer({ min: 1, max: 99_999_999_999 }), 40);
    const fromSql = await withSystem(
      async (tx) => {
        const rows = await tx.execute<{ n: string; code: string }>(sql`
          select n::text, catalog.internal_ean13(n) as code
          from unnest(${sql.param(samples.map(String))}::bigint[]) as n
        `);
        return [...rows];
      },
      { orgId: ORG_A },
    );
    for (const row of fromSql) expect(row.code).toBe(internalEan13(Number(row.n)));
  });

  it('refuses a hand-typed barcode in the ERP’s own range, and takes a supplier’s', async () => {
    const made = await product('Barcode rules', 'barcode-rules-sih');
    const [first, second] = made.skus;
    if (first === undefined || second === undefined) throw new Error('no SKUs');
    const refused = await admin.client.request('PUT', `/v1/catalog/skus/${first.id}/barcode`, {
      body: { barcode: second.barcode },
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(body<{ code: string }>(refused).code).toBe('CATALOG_BARCODE_INVALID');

    await call(
      admin,
      'PUT',
      `/v1/catalog/skus/${first.id}/barcode`,
      { barcode: '5901234123457' },
      200,
    );
    // Keeping its own internal number is not "typing one in".
    await call(
      admin,
      'PUT',
      `/v1/catalog/skus/${second.id}/barcode`,
      { barcode: second.barcode },
      200,
    );
  });
});

describe('scanning a code (D-605)', () => {
  let made: Product;

  beforeAll(async () => {
    made = await product('Scan me', 'scan-me-sih');
  });

  it('resolves a barcode and a SKU code to the product at that variant', async () => {
    const sku = made.skus[1];
    if (sku === undefined) throw new Error('no SKU');
    const byBarcode = await call<{
      product: { id: string };
      sku: { id: string; variantLabel: string; pricePoisha: string };
    }>(sales, 'GET', `/v1/catalog/lookup?code=${sku.barcode ?? ''}`, undefined, 200);
    expect(byBarcode.product.id).toBe(made.id);
    expect(byBarcode.sku).toMatchObject({ id: sku.id, pricePoisha: '199000' });
    expect(byBarcode.sku.variantLabel).toBe(sku.attributes[0]?.valueLabel);

    const byCode = await call<{ sku: { id: string } }>(
      sales,
      'GET',
      `/v1/catalog/lookup?code=${sku.skuCode.toLowerCase()}`,
      undefined,
      200,
    );
    expect(byCode.sku.id).toBe(sku.id);
  });

  it('answers 404 for a code nobody has, and for another brand’s', async () => {
    const missing = await sales.client.request('GET', '/v1/catalog/lookup?code=2999999999990');
    expect(missing.statusCode).toBe(404);
    const sku = made.skus[0];
    const otherBrand = await otherAdmin.client.request(
      'GET',
      `/v1/catalog/lookup?code=${sku?.barcode ?? ''}`,
    );
    expect(otherBrand.statusCode).toBe(404);
  });
});

describe('stock in hand at the start (D-602)', () => {
  let made: Product;

  beforeAll(async () => {
    made = await product('Counted in', 'counted-in-sih');
  });

  it('posts one balanced journal, Dr Inventory / Cr Opening balance equity, and moves stock', async () => {
    const entryId = randomUUID();
    const lines = made.skus.map((sku, index) => ({
      skuId: sku.id,
      qty: 4 + index,
      unitCostPoisha: String(80_000 + index * 5_000),
    }));
    const posted = await call<{ status: string; journalId: string; stockValuePoisha: string }>(
      admin,
      'POST',
      '/v1/inventory/stock-in-hand',
      { entryId, locationId: mainWarehouse, memo: 'Shelf A', lines },
      201,
    );
    // 4 × 80,000 + 5 × 85,000 + 6 × 90,000 = 320,000 + 425,000 + 540,000 = 1,285,000.
    expect(posted.status).toBe('posted');
    expect(posted.stockValuePoisha).toBe('1285000');
    postedEntryId = entryId;

    const journal = await journalOf(`stock_in_hand:${entryId}:posted`);
    expect(new Set(journal.map((line) => line.id)).size).toBe(1);
    expect(journal).toEqual([
      expect.objectContaining({ subtype: 'inventory', debit: '1285000', credit: '0' }),
      expect.objectContaining({ subtype: 'opening_equity', debit: '0', credit: '1285000' }),
    ]);

    const movements = await movementsOf(entryId);
    expect(movements).toHaveLength(3);
    for (const movement of movements) expect(movement.kind).toBe('opening_balance');
    expect(movements.reduce((sum, movement) => sum + movement.qty_delta, 0)).toBe(15);

    // The average blends exactly as a receipt: first stock, so WAC = the cost per piece.
    const found = await lookup(made.skus[2]?.barcode);
    expect(found.wacPoisha).toBe('90000');
    expect(found.stock.onHand).toBe(6);

    // On the product's stock history, as opening stock.
    const history = await call<{ items: { kind: string }[] }>(
      sales,
      'GET',
      `/v1/inventory/movements?productId=${made.id}`,
      undefined,
      200,
    );
    expect(history.items.filter((row) => row.kind === 'opening_balance')).toHaveLength(3);

    const audit = await auditRowsFor(ORG_A, 'inventory.stock_in_hand.posted');
    expect(audit.some((row) => row.entity_id === entryId)).toBe(true);
  });

  it('blends into the weighted average onto stock already there, like a receipt (§8)', async () => {
    const blended = await product('Blended in', 'blended-in-sih');
    const sku = blended.skus[0];
    await enterStock([{ skuId: sku?.id, qty: 4, unitCostPoisha: '80000' }]);
    await enterStock([{ skuId: sku?.id, qty: 2, unitCostPoisha: '110000' }]);
    // (4 × 80,000 + 2 × 110,000) / 6 = 540,000 / 6 = 90,000.
    const found = await lookup(sku?.barcode);
    expect(found).toMatchObject({ wacPoisha: '90000', stock: { onHand: 6 } });
  });

  it('replays a retried entry instead of posting it twice, and refuses other stock under its key', async () => {
    const entryId = randomUUID();
    const sku = made.skus[0];
    if (sku === undefined) throw new Error('no SKU');
    const payload = {
      entryId,
      locationId: mainWarehouse,
      lines: [{ skuId: sku.id, qty: 2, unitCostPoisha: '81000' }],
    };
    const first = await call<{ journalId: string }>(
      admin,
      'POST',
      '/v1/inventory/stock-in-hand',
      payload,
      201,
    );
    const again = await call<{ journalId: string; created: boolean }>(
      admin,
      'POST',
      '/v1/inventory/stock-in-hand',
      payload,
      201,
    );
    expect(again.journalId).toBe(first.journalId);
    expect(again.created).toBe(false);
    expect(await movementsOf(entryId)).toHaveLength(1);

    const other = await admin.client.request('POST', '/v1/inventory/stock-in-hand', {
      body: { ...payload, lines: [{ skuId: sku.id, qty: 3, unitCostPoisha: '81000' }] },
    });
    expect(other.statusCode, other.body).toBe(409);
    expect(body<{ code: string }>(other).code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('refuses a cost of zero and a SKU from another brand', async () => {
    const sku = made.skus[0];
    const zero = await admin.client.request('POST', '/v1/inventory/stock-in-hand', {
      body: {
        entryId: randomUUID(),
        locationId: mainWarehouse,
        lines: [{ skuId: sku?.id, qty: 1, unitCostPoisha: '0' }],
      },
    });
    expect(zero.statusCode).toBe(400);
    const foreign = await otherAdmin.client.request('POST', '/v1/inventory/stock-in-hand', {
      body: {
        entryId: randomUUID(),
        locationId: mainWarehouse,
        lines: [{ skuId: sku?.id, qty: 1, unitCostPoisha: '1000' }],
      },
    });
    expect([400, 404]).toContain(foreign.statusCode);
  });

  it('lets the warehouse count a draft without cost, and accounts price and post it', async () => {
    const entryId = randomUUID();
    const lines = made.skus.slice(0, 2).map((sku) => ({ skuId: sku.id, qty: 3 }));
    await call(
      warehouse,
      'POST',
      '/v1/inventory/stock-in-hand/drafts',
      {
        entryId,
        locationId: mainWarehouse,
        lines,
      },
      201,
    );
    const priced = {
      locationId: mainWarehouse,
      lines: lines.map((line) => ({ ...line, unitCostPoisha: '77700' })),
    };

    // The warehouse cannot post, nor send a cost through the draft route.
    const posting = await warehouse.client.request(
      'POST',
      `/v1/inventory/stock-in-hand/${entryId}/post`,
      { body: priced },
    );
    expect(posting.statusCode).toBe(403);
    const sneaky = await warehouse.client.request('POST', '/v1/inventory/stock-in-hand/drafts', {
      body: {
        entryId: randomUUID(),
        locationId: mainWarehouse,
        lines: [{ ...lines[0], unitCostPoisha: '1000' }],
      },
    });
    expect(sneaky.statusCode).toBe(400);
    for (const who of [sales]) {
      const refused = await who.client.request('POST', '/v1/inventory/stock-in-hand/drafts', {
        body: { entryId: randomUUID(), locationId: mainWarehouse, lines },
      });
      expect(refused.statusCode).toBe(403);
    }

    const posted = await call<{ status: string }>(
      accounts,
      'POST',
      `/v1/inventory/stock-in-hand/${entryId}/post`,
      priced,
      201,
    );
    expect(posted.status).toBe('posted');

    // The warehouse reads it back with quantities and no cost; accounts sees the cost.
    const seen = await call<Record<string, unknown>>(
      warehouse,
      'GET',
      `/v1/inventory/stock-in-hand/${entryId}`,
      undefined,
      200,
    );
    expect(findCostFields(seen)).toEqual([]);
    expect(seen).toMatchObject({ status: 'posted', costWithheld: true });
    const list = await call<Record<string, unknown>>(
      warehouse,
      'GET',
      '/v1/inventory/stock-in-hand',
      undefined,
      200,
    );
    expect(findCostFields(list)).toEqual([]);
    const withCost = await call<{ lines: { unitCostPoisha: string }[] }>(
      accounts,
      'GET',
      `/v1/inventory/stock-in-hand/${entryId}`,
      undefined,
      200,
    );
    expect(withCost.lines.map((line) => line.unitCostPoisha)).toEqual(['77700', '77700']);

    // A draft retried after it was posted is the same count, and says what it became.
    const retried = await call<{ status: string }>(
      warehouse,
      'POST',
      '/v1/inventory/stock-in-hand/drafts',
      { entryId, locationId: mainWarehouse, lines },
      201,
    );
    expect(retried.status).toBe('posted');

    // A posted entry is never edited or deleted.
    const edit = await warehouse.client.request(
      'PATCH',
      `/v1/inventory/stock-in-hand/drafts/${entryId}`,
      {
        body: { lines },
      },
    );
    expect(edit.statusCode).toBe(409);
    const remove = await warehouse.client.request(
      'DELETE',
      `/v1/inventory/stock-in-hand/drafts/${entryId}`,
    );
    expect(remove.statusCode).toBe(404);
  });

  it('posts only the draft its poster read, and audits what a change to it was', async () => {
    const entryId = randomUUID();
    const [first, second] = made.skus;
    if (first === undefined || second === undefined) throw new Error('no SKUs');
    await call(
      warehouse,
      'POST',
      '/v1/inventory/stock-in-hand/drafts',
      { entryId, locationId: mainWarehouse, lines: [{ skuId: first.id, qty: 2 }] },
      201,
    );
    // Accounts reads two pieces; the warehouse, on another phone, makes it twelve and adds a line.
    const read = await call<{ lines: { skuId: string; qty: number }[] }>(
      accounts,
      'GET',
      `/v1/inventory/stock-in-hand/${entryId}`,
      undefined,
      200,
    );
    await call(
      warehouse,
      'PATCH',
      `/v1/inventory/stock-in-hand/drafts/${entryId}`,
      {
        lines: [
          { skuId: first.id, qty: 12 },
          { skuId: second.id, qty: 1 },
        ],
      },
      200,
    );

    const stale = await accounts.client.request(
      'POST',
      `/v1/inventory/stock-in-hand/${entryId}/post`,
      {
        body: {
          locationId: mainWarehouse,
          lines: read.lines.map((line) => ({
            skuId: line.skuId,
            qty: line.qty,
            unitCostPoisha: '50000',
          })),
        },
      },
    );
    expect(stale.statusCode, stale.body).toBe(409);
    expect(body<{ code: string }>(stale).code).toBe('STOCK_IN_HAND_CHANGED');
    expect(await movementsOf(entryId)).toHaveLength(0);

    const updated = (await auditRowsFor(ORG_A, 'inventory.stock_in_hand.draft_updated')).find(
      (row) => row.entity_id === entryId,
    );
    expect(updated?.before).toMatchObject({ lines: [{ skuId: first.id, qty: 2 }] });
    expect(updated?.after).toMatchObject({
      lines: [
        { skuId: first.id, qty: 12 },
        { skuId: second.id, qty: 1 },
      ],
    });

    // Read again, posted as read.
    await call(
      accounts,
      'POST',
      `/v1/inventory/stock-in-hand/${entryId}/post`,
      {
        locationId: mainWarehouse,
        lines: [
          { skuId: first.id, qty: 12, unitCostPoisha: '50000' },
          { skuId: second.id, qty: 1, unitCostPoisha: '50000' },
        ],
      },
      201,
    );
  });

  it('withholds cost from the lookup for a role without read:cost', async () => {
    const response = await call<Record<string, unknown>>(
      warehouse,
      'GET',
      `/v1/catalog/lookup?code=${made.skus[0]?.barcode ?? ''}`,
      undefined,
      200,
    );
    expect(findCostFields(response)).toEqual([]);
    expect(response).not.toHaveProperty('wacPoisha');
  });

  it('refuses a posted entry changed behind the service’s back', async () => {
    const entryId = randomUUID();
    const sku = made.skus[1];
    await call(
      admin,
      'POST',
      '/v1/inventory/stock-in-hand',
      {
        entryId,
        locationId: mainWarehouse,
        lines: [{ skuId: sku?.id, qty: 1, unitCostPoisha: '90000' }],
      },
      201,
    );
    expect(
      await databaseRefusal(
        withOrg({ orgId: ORG_A, userId: 'usr_test' }, (tx) =>
          tx.execute(sql`
            update inventory.stock_in_hand_lines set qty = 50
            where org_id = ${ORG_A} and entry_id = ${entryId}
          `),
        ),
      ),
    ).toMatch(/STOCK_IN_HAND_IMMUTABLE/);
    // Nor flipped to reversed without the ledger's reversal and an approval.
    expect(
      await databaseRefusal(
        withOrg({ orgId: ORG_A, userId: 'usr_test' }, (tx) =>
          tx.execute(sql`
            update inventory.stock_in_hand_entries
            set status = 'reversed', reversal_journal_id = journal_id,
                reversal_approval_id = gen_random_uuid(), reversed_by = 'usr_test',
                reversed_at = now()
            where org_id = ${ORG_A} and id = ${entryId}
          `),
        ),
      ),
    ).toMatch(/STOCK_IN_HAND_INVALID/);
  });
});

describe('reversing a posted entry (D-602)', () => {
  it('takes a shelf counted in twice back out, exactly, through a second admin', async () => {
    const twice = await product('Counted twice', 'counted-twice-sih');
    const [first, second] = twice.skus;
    if (first === undefined || second === undefined) throw new Error('no SKUs');
    const lines = [
      { skuId: first.id, qty: 3, unitCostPoisha: '50000' },
      { skuId: second.id, qty: 2, unitCostPoisha: '50000' },
    ];
    await enterStock(lines);
    const duplicate = await enterStock(lines);

    // Whoever may not price may not ask; the generic route never raises one.
    const refused = await warehouse.client.request(
      'POST',
      `/v1/inventory/stock-in-hand/${duplicate.id}/reverse`,
      { body: { reason: 'Counted twice' } },
    );
    expect(refused.statusCode).toBe(403);
    const generic = await accounts.client.request('POST', '/v1/approvals', {
      body: {
        type: 'stock_in_hand_reversal',
        amountPoisha: '250000',
        payload: { entryId: duplicate.id },
      },
    });
    expect(generic.statusCode).toBeGreaterThanOrEqual(400);

    const raised = await call<{ approvalId: string; status: string }>(
      accounts,
      'POST',
      `/v1/inventory/stock-in-hand/${duplicate.id}/reverse`,
      { reason: 'Shelf B counted in twice' },
      201,
    );
    expect(raised.status).toBe('pending');
    const again = await accounts.client.request(
      'POST',
      `/v1/inventory/stock-in-hand/${duplicate.id}/reverse`,
      { body: { reason: 'Again' } },
    );
    expect(body<{ code: string }>(again).code).toBe('STOCK_IN_HAND_REVERSAL_BLOCKED');
    const waiting = await call<{ status: string; reversalPending: boolean }>(
      accounts,
      'GET',
      `/v1/inventory/stock-in-hand/${duplicate.id}`,
      undefined,
      200,
    );
    expect(waiting).toMatchObject({ status: 'posted', reversalPending: true });
    // Nothing moved while it waits.
    expect((await lookup(first.barcode)).stock.onHand).toBe(6);
    const before = await booksDifference();

    await call(
      admin,
      'POST',
      `/v1/approvals/${raised.approvalId}/decide`,
      { decision: 'approved' },
      201,
    );

    const reversed = await call<{ status: string; reversalJournalId: string }>(
      accounts,
      'GET',
      `/v1/inventory/stock-in-hand/${duplicate.id}`,
      undefined,
      200,
    );
    expect(reversed.status).toBe('reversed');

    // The ledger's own reversal of the entry's journal: Dr equity, Cr inventory, 250,000.
    const journal = await journalById(reversed.reversalJournalId);
    expect(journal.every((line) => line.reverses_journal_id === duplicate.journalId)).toBe(true);
    expect(journal.map(({ subtype, debit, credit }) => ({ subtype, debit, credit }))).toEqual(
      expect.arrayContaining([
        { subtype: 'inventory', debit: '0', credit: '250000' },
        { subtype: 'opening_equity', debit: '250000', credit: '0' },
      ]),
    );

    // The same pieces out at the cost they came in at; the average untouched.
    const movements = await movementsOf(duplicate.id);
    expect(movements.filter((row) => row.kind === 'adjustment_loss')).toHaveLength(2);
    expect(movements.reduce((sum, row) => sum + row.qty_delta, 0)).toBe(0);
    for (const row of movements) expect(row.unit_cost_poisha).toBe('50000');
    expect(await lookup(first.barcode)).toMatchObject({
      wacPoisha: '50000',
      stock: { onHand: 3 },
    });
    expect((await lookup(second.barcode)).stock.onHand).toBe(2);
    // 1300 and the stock valuation came down by the same 250,000.
    expect(await booksDifference()).toBe(before);
    const audit = await auditRowsFor(ORG_A, 'inventory.stock_in_hand.reversed');
    expect(audit.some((row) => row.entity_id === duplicate.id)).toBe(true);

    // Once reversed, never again, and never edited or removed.
    const twiceMore = await accounts.client.request(
      'POST',
      `/v1/inventory/stock-in-hand/${duplicate.id}/reverse`,
      { body: { reason: 'Again' } },
    );
    expect(body<{ code: string }>(twiceMore).code).toBe('STOCK_IN_HAND_IMMUTABLE');
    expect(
      await databaseRefusal(
        withOrg({ orgId: ORG_A, userId: 'usr_test' }, (tx) =>
          tx.execute(sql`
            update inventory.stock_in_hand_entries set memo = 'edited'
            where org_id = ${ORG_A} and id = ${duplicate.id}
          `),
        ),
      ),
    ).toMatch(/STOCK_IN_HAND_IMMUTABLE/);
    expect(
      await databaseRefusal(
        withOrg({ orgId: ORG_A, userId: 'usr_test' }, (tx) =>
          tx.execute(sql`
            delete from inventory.stock_in_hand_entries
            where org_id = ${ORG_A} and id = ${duplicate.id}
          `),
        ),
      ),
    ).toMatch(/STOCK_IN_HAND_IMMUTABLE/);
  });

  it('refuses once the pieces were averaged with stock at another cost, and a draft', async () => {
    const averaged = await product('Averaged', 'averaged-sih');
    const sku = averaged.skus[0];
    const cheap = await enterStock([{ skuId: sku?.id, qty: 2, unitCostPoisha: '40000' }]);
    const dear = await enterStock([{ skuId: sku?.id, qty: 2, unitCostPoisha: '60000' }]);
    for (const entry of [cheap, dear]) {
      const refused = await accounts.client.request(
        'POST',
        `/v1/inventory/stock-in-hand/${entry.id}/reverse`,
        { body: { reason: 'Wrong cost typed' } },
      );
      expect(refused.statusCode, refused.body).toBe(409);
      expect(body<{ code: string }>(refused).code).toBe('STOCK_IN_HAND_REVERSAL_BLOCKED');
    }

    const draftId = randomUUID();
    await call(
      warehouse,
      'POST',
      '/v1/inventory/stock-in-hand/drafts',
      { entryId: draftId, locationId: mainWarehouse, lines: [{ skuId: sku?.id, qty: 1 }] },
      201,
    );
    const draft = await accounts.client.request(
      'POST',
      `/v1/inventory/stock-in-hand/${draftId}/reverse`,
      { body: { reason: 'Not posted' } },
    );
    expect(draft.statusCode).toBe(400);
    expect(body<{ code: string }>(draft).code).toBe('STOCK_IN_HAND_INVALID');
  });

  it('checks again when it is decided: the checker, an average that moved, pieces that left', async () => {
    const later = await product('Decided later', 'decided-later-sih');
    const [first, second] = later.skus;
    if (first === undefined || second === undefined) throw new Error('no SKUs');
    const before = await booksDifference();

    // Raised by an org admin, who cannot decide it; nor can accounts, which is no checker.
    const entry = await enterStock([{ skuId: first.id, qty: 2, unitCostPoisha: '50000' }]);
    const raised = await call<{ approvalId: string }>(
      admin,
      'POST',
      `/v1/inventory/stock-in-hand/${entry.id}/reverse`,
      { reason: 'Counted twice' },
      201,
    );
    const decide = (who: RoleClient, id: string, decision: 'approved' | 'rejected') =>
      who.client.request('POST', `/v1/approvals/${id}/decide`, { body: { decision } });
    expect((await decide(admin, raised.approvalId, 'approved')).statusCode).toBe(403);
    expect((await decide(accounts, raised.approvalId, 'approved')).statusCode).toBe(403);

    // The average moves while it waits: the approval is refused and nothing moves.
    await enterStock([{ skuId: first.id, qty: 2, unitCostPoisha: '70000' }]);
    const moved = await decide(secondAdmin, raised.approvalId, 'approved');
    expect(moved.statusCode, moved.body).toBe(409);
    expect(body<{ code: string }>(moved).code).toBe('STOCK_IN_HAND_REVERSAL_BLOCKED');
    expect((await movementsOf(entry.id)).filter((row) => row.kind === 'adjustment_loss')).toEqual(
      [],
    );
    expect(
      await call<{ status: string; reversalPending: boolean }>(
        admin,
        'GET',
        `/v1/inventory/stock-in-hand/${entry.id}`,
        undefined,
        200,
      ),
    ).toMatchObject({ status: 'posted', reversalPending: true });
    expect((await decide(secondAdmin, raised.approvalId, 'rejected')).statusCode).toBe(201);

    // The pieces leave the location while it waits: refused by the movement, nothing moves.
    const leaving = await enterStock([{ skuId: second.id, qty: 1, unitCostPoisha: '50000' }]);
    const asked = await call<{ approvalId: string }>(
      accounts,
      'POST',
      `/v1/inventory/stock-in-hand/${leaving.id}/reverse`,
      { reason: 'Counted twice' },
      201,
    );
    const elsewhere = await makeLocation(ORG_A, {
      code: 'WH-SIH-2',
      name: 'Second warehouse',
      kind: 'warehouse',
    });
    await call(
      warehouse,
      'POST',
      '/v1/inventory/transfers',
      {
        fromLocationId: mainWarehouse,
        toLocationId: elsewhere,
        lines: [{ skuId: second.id, qty: 1 }],
      },
      201,
    );
    const gone = await decide(admin, asked.approvalId, 'approved');
    expect(gone.statusCode, gone.body).toBe(409);
    expect(body<{ code: string }>(gone).code).toBe('STOCK_INSUFFICIENT');
    expect((await movementsOf(leaving.id)).filter((row) => row.kind === 'adjustment_loss')).toEqual(
      [],
    );
    expect((await decide(admin, asked.approvalId, 'rejected')).statusCode).toBe(201);

    // Entries at round costs and refused reversals leave the books and the stock as they were.
    expect(await booksDifference()).toBe(before);
  });
});

describe('counting by scanning (D-606)', () => {
  it('counts one piece per scan, once per scan key, only for SKUs on the count', async () => {
    const made = await product('Scan count', 'scan-count-sih');
    const [counted, absent] = made.skus;
    if (counted === undefined || absent === undefined) throw new Error('no SKUs');
    await enterStock([{ skuId: counted.id, qty: 5, unitCostPoisha: '60000' }]);

    // Any open count at the warehouse is closed out of the way first.
    await withSystem(
      (tx) =>
        tx.execute(sql`
          update inventory.count_sessions set status = 'cancelled', closed_at = now()
          where org_id = ${ORG_A} and location_id = ${mainWarehouse} and status in ('open', 'submitted')
        `),
      { orgId: ORG_A },
    );
    const count = await call<{ id: string }>(
      warehouse,
      'POST',
      '/v1/inventory/counts',
      {
        locationId: mainWarehouse,
      },
      201,
    );

    const scanId = randomUUID();
    const first = await call<{ countedQty: number; duplicate: boolean }>(
      warehouse,
      'POST',
      `/v1/inventory/counts/${count.id}/scans`,
      { scanId, code: counted.barcode },
      201,
    );
    expect(first).toMatchObject({ countedQty: 1, duplicate: false });
    const replay = await call<{ countedQty: number; duplicate: boolean }>(
      warehouse,
      'POST',
      `/v1/inventory/counts/${count.id}/scans`,
      { scanId, code: counted.barcode },
      201,
    );
    expect(replay).toMatchObject({ countedQty: 1, duplicate: true });
    const second = await call<{ countedQty: number }>(
      warehouse,
      'POST',
      `/v1/inventory/counts/${count.id}/scans`,
      { scanId: randomUUID(), code: counted.skuCode },
      201,
    );
    expect(second.countedQty).toBe(2);

    const notOnCount = await warehouse.client.request(
      'POST',
      `/v1/inventory/counts/${count.id}/scans`,
      {
        body: { scanId: randomUUID(), code: absent.barcode },
      },
    );
    expect(notOnCount.statusCode).toBe(409);
    const unknown = await warehouse.client.request(
      'POST',
      `/v1/inventory/counts/${count.id}/scans`,
      {
        body: { scanId: randomUUID(), code: '2999999999990' },
      },
    );
    expect(unknown.statusCode).toBe(404);

    // Typing over a counted figure needs a note, on the server as on the screen.
    const unexplained = await warehouse.client.request(
      'PUT',
      `/v1/inventory/counts/${count.id}/lines`,
      { body: { lines: [{ skuId: counted.id, countedQty: 5 }] } },
    );
    expect(unexplained.statusCode, unexplained.body).toBe(409);
    expect(body<{ code: string }>(unexplained).code).toBe('STOCK_COUNT_INVALID');

    // A manual correction with a note keeps the note in the audit log.
    await call(
      warehouse,
      'PUT',
      `/v1/inventory/counts/${count.id}/lines`,
      {
        lines: [{ skuId: counted.id, countedQty: 5 }],
        note: 'Three behind the rack',
      },
      200,
    );
    const audit = await auditRowsFor(ORG_A, 'inventory.count.recorded');
    expect(JSON.stringify(audit.map((row) => row.after))).toContain('Three behind the rack');

    // Two phones scanning one shelf at once: every scan counts, none twice.
    const scans = await Promise.all(
      Array.from({ length: 8 }, () =>
        warehouse.client.request('POST', `/v1/inventory/counts/${count.id}/scans`, {
          body: { scanId: randomUUID(), code: counted.barcode },
        }),
      ),
    );
    for (const response of scans) expect(response.statusCode, response.body).toBe(201);
    const after = await call<{ lines: { skuId: string; countedQty: number | null }[] }>(
      warehouse,
      'GET',
      `/v1/inventory/counts/${count.id}`,
      undefined,
      200,
    );
    expect(after.lines.find((line) => line.skuId === counted.id)?.countedQty).toBe(13);
    // Repeating the figure already there is not a correction.
    await call(
      warehouse,
      'PUT',
      `/v1/inventory/counts/${count.id}/lines`,
      { lines: [{ skuId: counted.id, countedQty: 13 }] },
      200,
    );
  });
});

describe('the opening stock window (D-602)', () => {
  it('is open on a new brand, and only an org admin closes it', async () => {
    const window = await call<{ open: boolean }>(
      sales,
      'GET',
      '/v1/inventory/stock-in-hand/window',
      undefined,
      200,
    );
    expect(window.open).toBe(true);
    for (const who of [warehouse, accounts, sales]) {
      const refused = await who.client.request('POST', '/v1/inventory/stock-in-hand/window/close', {
        body: {},
      });
      expect(refused.statusCode).toBe(403);
    }
  });

  it('refuses stock in hand once closed, from every path', async () => {
    const made = await product('Too late', 'too-late-sih');
    const sku = made.skus[0];
    if (sku === undefined) throw new Error('no SKU');
    const draftId = randomUUID();
    await call(
      warehouse,
      'POST',
      '/v1/inventory/stock-in-hand/drafts',
      {
        entryId: draftId,
        locationId: mainWarehouse,
        lines: [{ skuId: sku.id, qty: 1 }],
      },
      201,
    );

    // A reversal still waiting would be undecidable after the close, so it is decided first.
    const waiting = await enterStock([{ skuId: made.skus[1]?.id, qty: 1, unitCostPoisha: '1000' }]);
    const pending = await call<{ approvalId: string }>(
      accounts,
      'POST',
      `/v1/inventory/stock-in-hand/${waiting.id}/reverse`,
      { reason: 'Counted twice' },
      201,
    );
    const early = await admin.client.request('POST', '/v1/inventory/stock-in-hand/window/close', {
      body: {},
    });
    expect(early.statusCode, early.body).toBe(409);
    expect(body<{ code: string }>(early).code).toBe('STOCK_IN_HAND_REVERSAL_BLOCKED');
    await call(
      secondAdmin,
      'POST',
      `/v1/approvals/${pending.approvalId}/decide`,
      { decision: 'rejected', note: 'Close first' },
      201,
    );

    const closed = await call<{ open: boolean; closedAt: string; closedBy?: string }>(
      admin,
      'POST',
      '/v1/inventory/stock-in-hand/window/close',
      { note: 'Everything is counted in' },
      201,
    );
    expect(closed.open).toBe(false);
    expect(closed.closedBy).toBe(admin.userId);
    firstClosedAt = closed.closedAt;
    expect((await auditRowsFor(ORG_A, 'inventory.opening_stock.closed')).length).toBe(1);
    // Who closed it is for the people who decide the window.
    const seenBySales = await call<Record<string, unknown>>(
      sales,
      'GET',
      '/v1/inventory/stock-in-hand/window',
      undefined,
      200,
    );
    expect(seenBySales).toMatchObject({ open: false });
    expect(seenBySales).not.toHaveProperty('closedBy');

    const direct = await admin.client.request('POST', '/v1/inventory/stock-in-hand', {
      body: {
        entryId: randomUUID(),
        locationId: mainWarehouse,
        lines: [{ skuId: sku.id, qty: 1, unitCostPoisha: '1000' }],
      },
    });
    expect(direct.statusCode, direct.body).toBe(409);
    expect(body<{ code: string }>(direct).code).toBe('OPENING_STOCK_CLOSED');

    const drafted = await warehouse.client.request('POST', '/v1/inventory/stock-in-hand/drafts', {
      body: {
        entryId: randomUUID(),
        locationId: mainWarehouse,
        lines: [{ skuId: sku.id, qty: 1 }],
      },
    });
    expect(body<{ code: string }>(drafted).code).toBe('OPENING_STOCK_CLOSED');

    // The draft written before the close can be neither changed nor posted after it.
    const edited = await warehouse.client.request(
      'PATCH',
      `/v1/inventory/stock-in-hand/drafts/${draftId}`,
      { body: { lines: [{ skuId: sku.id, qty: 4 }] } },
    );
    expect(body<{ code: string }>(edited).code).toBe('OPENING_STOCK_CLOSED');
    const late = await accounts.client.request(
      'POST',
      `/v1/inventory/stock-in-hand/${draftId}/post`,
      {
        body: {
          locationId: mainWarehouse,
          lines: [{ skuId: sku.id, qty: 1, unitCostPoisha: '1000' }],
        },
      },
    );
    expect(body<{ code: string }>(late).code).toBe('OPENING_STOCK_CLOSED');

    // A posted entry is no longer reversed against equity either.
    const reversal = await accounts.client.request(
      'POST',
      `/v1/inventory/stock-in-hand/${postedEntryId}/reverse`,
      { body: { reason: 'Too late' } },
    );
    expect(body<{ code: string }>(reversal).code).toBe('OPENING_STOCK_CLOSED');

    // Nor through inventory's interface by another module: stock in hand, or M14a's opening.
    const inventory = harness.app.get<InventoryApi>(INVENTORY_API, { strict: false });
    const actor = { orgId: ORG_A, userId: admin.userId };
    const line = { skuId: sku.id, qty: 1, unitCostPoisha: poisha(1000n) };
    expect(
      await databaseRefusal(
        withOrg(actor, (tx) =>
          inventory.receiveStockInHand(tx, actor, {
            entryId: randomUUID(),
            locationId: mainWarehouse,
            branchId: null,
            occurredAt: new Date(),
            lines: [line],
          }),
        ),
      ),
    ).toMatch(/opening stock window is closed/);
    expect(
      await databaseRefusal(
        withOrg(actor, (tx) =>
          inventory.receiveOpening(tx, actor, {
            openingId: randomUUID(),
            occurredAt: new Date(),
            lines: [{ ...line, locationId: mainWarehouse }],
          }),
        ),
      ),
    ).toMatch(/opening stock window is closed/);

    // And the database refuses it too, for a path that skipped the service.
    expect(
      await databaseRefusal(
        withOrg({ orgId: ORG_A, userId: 'usr_test' }, (tx) =>
          tx.execute(sql`
            insert into inventory.stock_in_hand_entries
              (id, org_id, location_id, branch_id, status, created_by)
            select ${randomUUID()}, ${ORG_A}, l.id, l.branch_id, 'draft', 'usr_test'
            from org.locations l where l.org_id = ${ORG_A} and l.id = ${mainWarehouse}
          `),
        ),
      ),
    ).toMatch(/OPENING_STOCK_CLOSED/);
    expect(
      await databaseRefusal(
        withOrg({ orgId: ORG_A, userId: 'usr_test' }, (tx) =>
          tx.execute(sql`
            update inventory.stock_in_hand_lines set qty = 9
            where org_id = ${ORG_A} and entry_id = ${draftId}
          `),
        ),
      ),
    ).toMatch(/OPENING_STOCK_CLOSED/);
    // Nor can anyone reopen it, or move its close, by writing the row.
    expect(
      await databaseRefusal(
        withOrg({ orgId: ORG_A, userId: 'usr_test' }, (tx) =>
          tx.execute(sql`
            update inventory.opening_stock_windows set status = 'open' where org_id = ${ORG_A}
          `),
        ),
      ),
    ).toMatch(/OPENING_STOCK_REOPEN_UNAPPROVED/);
    expect(
      await databaseRefusal(
        withOrg({ orgId: ORG_A, userId: 'usr_test' }, (tx) =>
          tx.execute(sql`
            update inventory.opening_stock_windows
            set closed_at = closed_at - interval '30 days', closed_by = 'usr_test'
            where org_id = ${ORG_A}
          `),
        ),
      ),
    ).toMatch(/OPENING_STOCK_INVALID/);

    // Another brand's window is its own.
    const otherWindow = await call<{ open: boolean }>(
      otherAdmin,
      'GET',
      '/v1/inventory/stock-in-hand/window',
      undefined,
      200,
    );
    expect(otherWindow.open).toBe(true);
  });

  it('reopens only through an approval decided by a second admin', async () => {
    const raised = await call<{ approvalId: string; status: string }>(
      admin,
      'POST',
      '/v1/inventory/stock-in-hand/window/reopen',
      { reason: 'A carton was found in the back store' },
      201,
    );
    expect(raised.status).toBe('pending');
    const twice = await admin.client.request('POST', '/v1/inventory/stock-in-hand/window/reopen', {
      body: { reason: 'Again' },
    });
    expect(body<{ code: string }>(twice).code).toBe('OPENING_STOCK_REOPEN_PENDING');
    // Not through the generic route.
    const generic = await admin.client.request('POST', '/v1/approvals', {
      body: {
        type: 'opening_stock_reopen',
        amountPoisha: null,
        payload: { window: 'opening_stock' },
      },
    });
    expect(generic.statusCode).toBe(400);

    const self = await admin.client.request('POST', `/v1/approvals/${raised.approvalId}/decide`, {
      body: { decision: 'approved' },
    });
    expect(self.statusCode).toBeGreaterThanOrEqual(400);
    const stillClosed = await call<{ open: boolean; reopenPending: boolean }>(
      admin,
      'GET',
      '/v1/inventory/stock-in-hand/window',
      undefined,
      200,
    );
    expect(stillClosed).toMatchObject({ open: false, reopenPending: true });

    await call(
      secondAdmin,
      'POST',
      `/v1/approvals/${raised.approvalId}/decide`,
      {
        decision: 'approved',
      },
      201,
    );
    const reopened = await call<{ open: boolean }>(
      admin,
      'GET',
      '/v1/inventory/stock-in-hand/window',
      undefined,
      200,
    );
    expect(reopened.open).toBe(true);
    expect((await auditRowsFor(ORG_A, 'inventory.opening_stock.reopened')).length).toBe(1);

    const made = await product('After reopening', 'after-reopen-sih');
    await enterStock([{ skuId: made.skus[0]?.id, qty: 1, unitCostPoisha: '1000' }]);
  });

  it('closes only after an entry being written commits, and refuses the next one', async () => {
    const draftId = randomUUID();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      holding = resolve;
    });

    // An entry mid-write: it holds the window `for share`, as every post and draft does.
    const inFlight = withOrg({ orgId: ORG_A, userId: admin.userId }, async (tx) => {
      await tx.execute(sql`
        select status from inventory.opening_stock_windows where org_id = ${ORG_A} for share
      `);
      holding();
      await gate;
      await tx.execute(sql`
        insert into inventory.stock_in_hand_entries
          (id, org_id, location_id, branch_id, status, created_by)
        select ${draftId}, ${ORG_A}, l.id, l.branch_id, 'draft', ${admin.userId}
        from org.locations l where l.org_id = ${ORG_A} and l.id = ${mainWarehouse}
      `);
    });
    await held;

    let settled = false;
    const closing = admin.client
      .request('POST', '/v1/inventory/stock-in-hand/window/close', { body: {} })
      .then((response) => {
        settled = true;
        return response;
      });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(settled).toBe(false);

    release();
    await inFlight;
    const closed = await closing;
    expect(closed.statusCode, closed.body).toBe(201);
    expect(body<{ open: boolean }>(closed).open).toBe(false);

    // The entry written under the open window is there; the next one is refused.
    const written = await call<{ status: string }>(
      warehouse,
      'GET',
      `/v1/inventory/stock-in-hand/${draftId}`,
      undefined,
      200,
    );
    expect(written.status).toBe('draft');
    const next = await warehouse.client.request('POST', '/v1/inventory/stock-in-hand/drafts', {
      body: {
        entryId: randomUUID(),
        locationId: mainWarehouse,
        lines: [{ skuId: (await product('Next', 'next-sih')).skus[0]?.id, qty: 1 }],
      },
    });
    expect(body<{ code: string }>(next).code).toBe('OPENING_STOCK_CLOSED');
  });

  it('refuses a reopen request raised for an earlier close', async () => {
    // A request left over from the first close (two raised at once before the lock existed):
    // approving it now must not reopen the second close.
    const staleId = await withSystem(
      async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`
          insert into approvals.approval_requests
            (org_id, type, status, requested_by, payload, reason)
          values (${ORG_A}, 'opening_stock_reopen', 'pending', ${admin.userId},
                  ${JSON.stringify({ window: 'opening_stock', closedAt: firstClosedAt })}::jsonb,
                  'Left over from the first close')
          returning id
        `);
        return rows[0]?.id ?? '';
      },
      { orgId: ORG_A },
    );

    const decided = await secondAdmin.client.request('POST', `/v1/approvals/${staleId}/decide`, {
      body: { decision: 'approved' },
    });
    expect(decided.statusCode, decided.body).toBe(409);
    expect(body<{ code: string }>(decided).code).toBe('OPENING_STOCK_REOPEN_UNAPPROVED');
    const window = await call<{ open: boolean }>(
      admin,
      'GET',
      '/v1/inventory/stock-in-hand/window',
      undefined,
      200,
    );
    expect(window.open).toBe(false);

    // The database says the same for a hand-written reopen naming an approved one.
    expect(
      await databaseRefusal(
        withSystem(
          async (tx) => {
            await tx.execute(sql`
              update approvals.approval_requests
              set status = 'approved', decided_by = ${secondAdmin.userId}, decided_at = now()
              where org_id = ${ORG_A} and id = ${staleId}
            `);
            await tx.execute(sql`
              update inventory.opening_stock_windows
              set status = 'open', reopen_approval_id = ${staleId}, reopened_by = 'usr_test'
              where org_id = ${ORG_A}
            `);
          },
          { orgId: ORG_A },
        ),
      ),
    ).toMatch(/raised for an earlier close/);

    await call(
      secondAdmin,
      'POST',
      `/v1/approvals/${staleId}/decide`,
      { decision: 'rejected', note: 'Raised for an earlier close' },
      201,
    );
  });
});

describe('the migration’s backfill (0114)', () => {
  /** Migration 0114's per-brand block, run as the migration runs it: as the owner, no org. */
  async function runBackfill(): Promise<void> {
    const directory = new URL('../../../../../packages/db/migrations/', import.meta.url);
    const file = readdirSync(directory).find((name) => name.endsWith('_m38a_policies.sql'));
    if (file === undefined) throw new Error('no M38a policies migration');
    const migration = readFileSync(new URL(file, directory), 'utf8');
    const block = migration.slice(
      migration.indexOf('-- m38a:backfill:start'),
      migration.indexOf('-- m38a:backfill:end'),
    );
    await withSystem(async (tx) => {
      await tx.execute(sql.raw(block));
    });
  }

  async function brandState(orgId: string) {
    return withSystem(
      async (tx) => {
        const window = await tx.execute<{ status: string; closed_by: string; closed_at: string }>(
          sql`select status, closed_by, closed_at::text from inventory.opening_stock_windows
              where org_id = ${orgId}`,
        );
        const settings = await tx.execute<{ last_sequence: number; last_barcode_sequence: string }>(
          sql`select last_sequence, last_barcode_sequence::text from catalog.sku_settings
              where org_id = ${orgId}`,
        );
        const skus = await tx.execute<{ id: string; barcode: string | null }>(
          sql`select id, barcode from catalog.skus where org_id = ${orgId} order by created_at`,
        );
        return { window: window[0], settings: settings[0], skus: [...skus] };
      },
      { orgId },
    );
  }

  it('numbers every SKU above the codes the brand holds, and closes only a brand with history', async () => {
    // A brand whose SKUs predate barcodes, with no counter row, holding two supplier codes in
    // the ERP's range: one low (a floor), one near the top (ignored, or nothing would fit).
    const made: string[] = [];
    for (const index of [1, 2, 3, 4]) {
      const created = await call<{ skus: { id: string }[] }>(
        otherAdmin,
        'POST',
        '/v1/catalog/products',
        {
          name: `Old stock ${String(index)}`,
          slug: `old-stock-backfill-${String(index)}`,
          status: 'active',
          pricePoisha: '99000',
        },
        201,
      );
      made.push(created.skus[0]?.id ?? '');
    }
    const low = internalEan13(500);
    await withSystem(
      async (tx) => {
        await tx.execute(sql`update catalog.skus set barcode = null where org_id = ${ORG_B}`);
        await tx.execute(sql`update catalog.skus set barcode = ${low} where id = ${made[0]}`);
        await tx.execute(
          sql`update catalog.skus set barcode = '2999999999990' where id = ${made[1]}`,
        );
        await tx.execute(sql`delete from catalog.sku_settings where org_id = ${ORG_B}`);
      },
      { orgId: ORG_B },
    );

    await runBackfill();
    const once = await brandState(ORG_B);
    // No history yet: the window stays open (no row).
    expect(once.window).toBeUndefined();
    const numbered = once.skus.filter((sku) => sku.id === made[2] || sku.id === made[3]);
    expect(numbered).toHaveLength(2);
    for (const sku of numbered) {
      expect(sku.barcode !== null && isInternalEan13(sku.barcode)).toBe(true);
      const sequence = Number(sku.barcode?.slice(1, 12));
      expect(sequence).toBeGreaterThan(500);
      expect(sequence).toBeLessThan(1000);
    }
    expect(new Set(once.skus.map((sku) => sku.barcode)).size).toBe(once.skus.length);
    // The counter row, made the way the SKU counter makes it: past every product sequence.
    expect(once.settings?.last_sequence).toBeGreaterThanOrEqual(4);
    expect(Number(once.settings?.last_barcode_sequence)).toBe(
      Math.max(...numbered.map((sku) => Number(sku.barcode?.slice(1, 12)))),
    );
    // So the next product neither repeats a sequence nor a barcode.
    const next = await call<{ skus: { barcode: string }[] }>(
      otherAdmin,
      'POST',
      '/v1/catalog/products',
      {
        name: 'After the backfill',
        slug: 'after-backfill',
        status: 'active',
        pricePoisha: '99000',
      },
      201,
    );
    expect(once.skus.map((sku) => sku.barcode)).not.toContain(next.skus[0]?.barcode);

    // History: a movement other than opening stock. Run again: closed by the system, and the
    // numbers already given are left alone.
    const location = await warehouseId(ORG_B);
    await withSystem(
      (tx) =>
        tx.execute(sql`
          insert into inventory.stock_movements
            (org_id, sku_id, location_id, kind, qty_delta, unit_cost_poisha, ref_type,
             business_date, created_by)
          values (${ORG_B}, ${made[2]}, ${location}, 'adjustment_gain', 1, 0, 'test',
                  current_date, 'usr_test')
        `),
      { orgId: ORG_B },
    );
    await runBackfill();
    const twice = await brandState(ORG_B);
    expect(twice.window).toMatchObject({ status: 'closed', closed_by: 'system' });
    expect(twice.window?.closed_at).toBeTruthy();
    expect(twice.skus.find((sku) => sku.id === made[2])?.barcode).toBe(
      once.skus.find((sku) => sku.id === made[2])?.barcode,
    );

    // A brand whose window an admin already closed keeps that close.
    const brandA = await brandState(ORG_A);
    expect(brandA.window).toMatchObject({ status: 'closed', closed_by: admin.userId });

    // A brand that opened its books through M14a's one opening journal, and moved no stock:
    // closed too.
    const third = SEED_ORGS.map((org) => seedOrgId(org.slug)).find(
      (id) => id !== ORG_A && id !== ORG_B,
    );
    if (third === undefined) throw new Error('the seed has no third brand');
    expect((await brandState(third)).window).toBeUndefined();
    const ledger = harness.app.get<LedgerApi>(LEDGER_API, { strict: false });
    const actor = { orgId: third, userId: 'usr_test' };
    await withOrg(actor, async (tx) => {
      const inventoryAccount = await ledger.accountBySubtype(tx, third, 'inventory');
      const equity = await ledger.accountBySubtype(tx, third, 'opening_equity');
      if (inventoryAccount === null || equity === null) throw new Error('no chart');
      const line = { partyType: null, partyId: null, memo: null };
      await ledger.post(tx, actor, {
        businessDate: businessDate(new Date()),
        sourceType: 'opening_balance',
        sourceId: third,
        event: 'posted',
        idempotencyKey: `opening_balance:${third}:posted`,
        memo: 'An opening posted before M38a',
        reversesJournalId: null,
        lines: [
          {
            ...line,
            accountId: inventoryAccount.accountId,
            branchId: inventoryAccount.branchId,
            debitPoisha: poisha(100n),
            creditPoisha: poisha(0n),
          },
          {
            ...line,
            accountId: equity.accountId,
            branchId: equity.branchId,
            debitPoisha: poisha(0n),
            creditPoisha: poisha(100n),
          },
        ],
      });
    });
    await runBackfill();
    expect((await brandState(third)).window).toMatchObject({
      status: 'closed',
      closed_by: 'system',
    });
  });
});
