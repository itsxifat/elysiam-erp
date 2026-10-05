import { randomUUID } from 'node:crypto';

import { findCostFields } from '@elysium/contracts';
import { withOrg, withSystem } from '@elysium/db';
import { internalEan13, isInternalEan13 } from '@elysium/domain';
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
import { warehouseId } from './inventory.testing.js';

/**
 * M38a over HTTP against real PostgreSQL (D-602 to D-606): every SKU gets a valid, unique
 * internal EAN-13; a scan resolves to its variant; stock in hand posts one balanced journal
 * per entry (Dr Inventory / Cr Opening balance equity) with `opening_balance` movements, is
 * idempotent on its key, keeps cost from the warehouse role, and is refused once the brand's
 * opening stock window is closed; reopening needs a second admin's approval; a count is
 * counted by scanning.
 *
 * The window tests run last in this file: closing it is the point of no return the owner
 * asked for, and everything before needs it open.
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
): Promise<{ entity_id: string; after: unknown }[]> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ entity_id: string; after: unknown }>(sql`
        select entity_id, after from audit.audit_log
        where org_id = ${orgId} and action = ${action}
        order by created_at
      `);
      return [...rows];
    },
    { orgId },
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
    const lookup = await call<{ wacPoisha: string; stock: { onHand: number } }>(
      admin,
      'GET',
      `/v1/catalog/lookup?code=${made.skus[2]?.barcode ?? ''}`,
      undefined,
      200,
    );
    expect(lookup.wacPoisha).toBe('90000');
    expect(lookup.stock.onHand).toBe(6);

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

    // The warehouse cannot post, nor send a cost through the draft route.
    const posting = await warehouse.client.request(
      'POST',
      `/v1/inventory/stock-in-hand/${entryId}/post`,
      {
        body: { lines: lines.map((line) => ({ skuId: line.skuId, unitCostPoisha: '1000' })) },
      },
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

    const priced = lines.map((line) => ({ skuId: line.skuId, unitCostPoisha: '77700' }));
    const posted = await call<{ status: string }>(
      accounts,
      'POST',
      `/v1/inventory/stock-in-hand/${entryId}/post`,
      { lines: priced },
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
  });
});

describe('counting by scanning (D-606)', () => {
  it('counts one piece per scan, once per scan key, only for SKUs on the count', async () => {
    const made = await product('Scan count', 'scan-count-sih');
    const [counted, absent] = made.skus;
    if (counted === undefined || absent === undefined) throw new Error('no SKUs');
    await call(
      admin,
      'POST',
      '/v1/inventory/stock-in-hand',
      {
        entryId: randomUUID(),
        locationId: mainWarehouse,
        lines: [{ skuId: counted.id, qty: 5, unitCostPoisha: '60000' }],
      },
      201,
    );

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

    const closed = await call<{ open: boolean; closedAt: string }>(
      admin,
      'POST',
      '/v1/inventory/stock-in-hand/window/close',
      { note: 'Everything is counted in' },
      201,
    );
    expect(closed.open).toBe(false);
    expect((await auditRowsFor(ORG_A, 'inventory.opening_stock.closed')).length).toBe(1);

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

    // The draft written before the close cannot be posted after it.
    const late = await accounts.client.request(
      'POST',
      `/v1/inventory/stock-in-hand/${draftId}/post`,
      {
        body: { lines: [{ skuId: sku.id, unitCostPoisha: '1000' }] },
      },
    );
    expect(body<{ code: string }>(late).code).toBe('OPENING_STOCK_CLOSED');

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
    // Nor can anyone reopen it by writing the row.
    expect(
      await databaseRefusal(
        withOrg({ orgId: ORG_A, userId: 'usr_test' }, (tx) =>
          tx.execute(sql`
            update inventory.opening_stock_windows set status = 'open' where org_id = ${ORG_A}
          `),
        ),
      ),
    ).toMatch(/OPENING_STOCK_REOPEN_UNAPPROVED/);

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
    await call(
      admin,
      'POST',
      '/v1/inventory/stock-in-hand',
      {
        entryId: randomUUID(),
        locationId: mainWarehouse,
        lines: [{ skuId: made.skus[0]?.id, qty: 1, unitCostPoisha: '1000' }],
      },
      201,
    );
  });
});
