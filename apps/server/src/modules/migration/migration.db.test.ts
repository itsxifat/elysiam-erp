import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { withAnalytics, withOrg, withSystem } from '@elysium/db';
import { seedDemoSetUp } from '@elysium/db/testing';
import {
  businessDate,
  idempotencyKey,
  parseCsv,
  parseTaka,
  poisha,
  toIsoDate,
  ZERO,
} from '@elysium/domain';
import type { MigrationKind } from '@elysium/domain/migration';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ORG_A, ORG_B, startHttpHarness, type HttpHarness } from '../../testing/http-harness.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import { NOTIFY_API, type NotifyApi } from '../notify/notify.api.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { WALLETS_API, type WalletsApi } from '../wallets/wallets.api.js';
import {
  consolidatedProfitAndLoss,
  consolidatedWalletTotals,
} from '../wallets/wallets.repository.js';
import { runDemo, SAMPLE_FILES, sampleDirectory } from './demo.js';
import { MigrationError } from './migration.errors.js';
import { MigrationModule } from './migration.module.js';
import { MigrationService, type MigrationActor } from './migration.service.js';

/**
 * M14a's acceptance checks 1 to 5, against a real database.
 *
 * The repository's sample files (`apps/server/migration-sample`) are imported into a seeded
 * brand given the demo's set-up — its warehouse and showroom, three wallets, two suppliers,
 * a courier and a size attribute — through the real importers, the real posting and every
 * other module's real interface. The suite runs in order, because a brand's migration does:
 *
 * 1. **Check 2 first**, while nothing is imported: a file with a bad last row, for each of
 *    the six importers, changes nothing; and a write that fails *inside* the transaction —
 *    the last product, the last buyer, the opening journal after its stock movements —
 *    leaves nothing behind either.
 * 2. **Check 1**: the files are imported, and the dry run of the last balance file shows the
 *    whole opening trial balance, balanced, with stock = Σ(qty × cost) computed here from
 *    the file's own text.
 * 3. **Check 3**: every file again, and edited files, create nothing twice.
 * 4. **Check 4**: the opening journal read back from the ledger balances, and its inventory
 *    line equals the inventory module's valuation to the poisha.
 * 5. **Check 5**: the reconciliation agrees on every line and records one sign-off.
 *
 * Then the training org, seeded from anonymised data through the same path (D-223).
 */

let harness: HttpHarness;
let service: MigrationService;
let ledger: LedgerApi;
let inventory: InventoryApi;
let catalog: CatalogApi;
let orders: OrdersApi;
let wallets: WalletsApi;
let notify: NotifyApi;

const actor: MigrationActor = { orgId: ORG_A, userId: 'usr_migration_test' };
const TODAY = businessDate(new Date());
const ACCOUNTANT = 'Test Accountant';

beforeAll(async () => {
  harness = await startHttpHarness('migration-db', { extraModules: [MigrationModule] });
  service = harness.app.get(MigrationService);
  ledger = harness.app.get<LedgerApi>(LEDGER_API);
  inventory = harness.app.get<InventoryApi>(INVENTORY_API);
  catalog = harness.app.get<CatalogApi>(CATALOG_API);
  orders = harness.app.get<OrdersApi>(ORDERS_API);
  wallets = harness.app.get<WalletsApi>(WALLETS_API);
  notify = harness.app.get<NotifyApi>(NOTIFY_API);
  await seedDemoSetUp(ORG_A);
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

// --- helpers ------------------------------------------------------------------------

function sample(file: string): string {
  return readFileSync(path.join(sampleDirectory(), file), 'utf8');
}

function fileOf(kind: MigrationKind): string {
  const entry = SAMPLE_FILES.find((candidate) => candidate.kind === kind);
  if (entry === undefined) throw new Error(`No sample for ${kind}`);
  return entry.file;
}

function input(kind: MigrationKind, csv = sample(fileOf(kind))) {
  return { kind, fileName: fileOf(kind), csv };
}

/** Everything an import could have written, counted as the owner sees it. */
async function footprint(orgId = ORG_A) {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<Record<string, string>>(sql`
        select
          (select count(*) from catalog.products)::text as products,
          (select count(*) from catalog.skus)::text as skus,
          (select count(*) from sales.customers)::text as customers,
          (select coalesce(sum(delivered_count), 0) from sales.customers)::text as delivered,
          (select count(*) from inventory.stock_movements)::text as movements,
          (select count(*) from inventory.sku_costs)::text as costs,
          (select count(*) from ledger.journals)::text as journals,
          (select count(*) from migration.batches)::text as batches,
          (select count(*) from migration.batches where status = 'staged')::text as staged,
          (select count(*) from migration.openings)::text as openings
      `);
      return rows[0];
    },
    { orgId },
  );
}

/** Σ(qty × cost) straight from the opening stock file's text, with no importer involved. */
function stockValueOfSample(): bigint {
  const table = parseCsv(sample('opening-stock.csv'));
  return table.rows.reduce(
    (total, row) =>
      total + BigInt(row.values.qty ?? '0') * BigInt(parseTaka(row.values.unit_cost_taka ?? '0')),
    0n,
  );
}

function withLine(csv: string, line: string): string {
  return `${csv.trimEnd()}\n${line}\n`;
}

/** A bad last row for each importer, after rows that are all valid. */
const BAD_LAST_ROW: Readonly<Record<MigrationKind, string>> = {
  skus: 'Demo Bad,DEMO-BAD-001,0,',
  customers: '12345,Not A Number,1,0,0,',
  // A second cost for a SKU the file already costed (D-216).
  opening_stock: 'DEMO-SCF-003,SR-01,5,999.00',
  supplier_balances: 'NO-SUCH-SUPPLIER,payable,100',
  wallet_balances: '9999,100',
  courier_cod: 'steadfast,SF-100201,100',
};

// --- check 2 ------------------------------------------------------------------------

describe('check 2: a bad row anywhere leaves no partial state', () => {
  it.each(['skus', 'customers'] as const)(
    'refuses a %s file with a bad last row, and writes nothing',
    async (kind) => {
      const before = await footprint();
      const csv = withLine(sample(fileOf(kind)), BAD_LAST_ROW[kind]);

      const report = await service.dryRun(actor, input(kind, csv));
      expect(report.canCommit).toBe(false);
      expect(report.problems.map((problem) => problem.line)).toEqual([
        csv.trimEnd().split('\n').length,
      ]);

      await expect(service.commit(actor, input(kind, csv))).rejects.toMatchObject({
        code: 'MIGRATION_IMPORT_REJECTED',
      });
      expect(await footprint()).toEqual(before);
    },
  );

  it('rolls back every product when the last one fails inside the transaction', async () => {
    const before = await footprint();
    const original = catalog.importProducts.bind(catalog);
    const spy = vi
      .spyOn(catalog, 'importProducts')
      .mockImplementationOnce(async (tx, who, products) => {
        await original(tx, who, products.slice(0, -1));
        throw new Error('the last product failed');
      });
    try {
      await expect(service.commit(actor, input('skus'))).rejects.toThrow('the last product failed');
    } finally {
      spy.mockRestore();
    }
    expect(await footprint()).toEqual(before);
  });

  it('rolls back every buyer when the last one fails inside the transaction', async () => {
    const before = await footprint();
    const original = orders.importBuyers.bind(orders);
    const spy = vi.spyOn(orders, 'importBuyers').mockImplementationOnce(async (tx, who, buyers) => {
      await original(tx, who, buyers.slice(0, -1));
      throw new Error('the last buyer failed');
    });
    try {
      await expect(service.commit(actor, input('customers'))).rejects.toThrow(
        'the last buyer failed',
      );
    } finally {
      spy.mockRestore();
    }
    expect(await footprint()).toEqual(before);
  });

  it('imports the SKUs and buyers the balance files need', async () => {
    const skus = await service.commit(actor, input('skus'));
    expect(skus).toMatchObject({ created: true, status: 'applied', rows: 6 });
    const buyers = await service.commit(actor, input('customers'));
    expect(buyers).toMatchObject({ created: true, status: 'applied', rows: 4 });

    const imported = await withOrg(actor, async (tx) =>
      tx.execute<{ delivered: number; returned: number; ltv: string; total: number }>(sql`
        select delivered_count as delivered, returned_count as returned,
               ltv_poisha::text as ltv, orders_total as total
        from sales.customers where phone_e164 = '+8801990000004'
      `),
    );
    expect(imported[0]).toEqual({ delivered: 7, returned: 0, ltv: '1743050', total: 7 });
  });

  it.each(['opening_stock', 'supplier_balances', 'wallet_balances', 'courier_cod'] as const)(
    'refuses a %s file with a bad last row, and stages nothing',
    async (kind) => {
      const before = await footprint();
      const csv = withLine(sample(fileOf(kind)), BAD_LAST_ROW[kind]);
      const lines = csv.trimEnd().split('\n').length;

      const report = await service.dryRun(actor, input(kind, csv));
      expect(report.canCommit).toBe(false);
      expect(report.problems.map((problem) => problem.line)).toEqual([lines]);

      await expect(service.commit(actor, input(kind, csv))).rejects.toMatchObject({
        code: 'MIGRATION_IMPORT_REJECTED',
      });
      expect(await footprint()).toEqual(before);
    },
  );
});

// --- check 1 ------------------------------------------------------------------------

describe('check 1: the dry run shows a balanced opening trial balance', () => {
  it('stages the balance files, and the last dry run shows the whole position', async () => {
    for (const kind of ['opening_stock', 'supplier_balances', 'wallet_balances'] as const) {
      const result = await service.commit(actor, input(kind));
      expect(result).toMatchObject({ created: true, status: 'staged' });
    }
    const before = await footprint();

    const report = await service.dryRun(actor, input('courier_cod'));
    expect(report.canCommit).toBe(true);
    expect(report.problems).toEqual([]);
    const position = report.position;
    if (position === null) throw new Error('A balance file reports its position.');

    expect(position.balanced).toBe(true);
    expect(position.totalDebitPoisha).toBe(position.totalCreditPoisha);
    // Stock value = Σ(qty × cost), from the file's own text.
    expect(position.stockValuePoisha).toBe(stockValueOfSample());
    expect(position.stockValuePoisha).toBe(15_130_875n);
    expect(position.units).toBe(186);
    // Dr stock 151,308.75 + wallets 296,100.75 + advance 10,000 + COD 7,440
    // Cr payables 108,500.50 → opening equity credited 356,349.00.
    expect(position.totalDebitPoisha).toBe(46_484_950n);
    expect(position.equityPoisha).toBe(35_634_900n);
    expect(position.lines.map((line) => line.section)).toEqual([
      'inventory',
      'wallet',
      'wallet',
      'wallet',
      'supplier_advance',
      'courier_receivable',
      'supplier_payable',
      'supplier_payable',
      'opening_equity',
    ]);

    // A dry run is a dry run.
    expect(await footprint()).toEqual(before);
    await service.commit(actor, input('courier_cod'));
  });
});

// --- check 3 ------------------------------------------------------------------------

describe('check 3: the same file twice is one import', () => {
  it('writes nothing when any of the six files is committed again', async () => {
    const before = await footprint();
    for (const { kind } of SAMPLE_FILES) {
      const report = await service.dryRun(actor, input(kind));
      expect(report.alreadyImported).not.toBeNull();
      const again = await service.commit(actor, input(kind));
      expect(again.created).toBe(false);
    }
    expect(await footprint()).toEqual(before);
  });

  it('adds only what is new from an edited SKU or customers file', async () => {
    const before = await footprint();
    const skus = await service.commit(
      actor,
      input('skus', withLine(sample('skus.csv'), 'Demo Shawl,DEMO-SHW-004,900,')),
    );
    expect(skus).toMatchObject({ created: true, rows: 1, skipped: 6 });
    const buyers = await service.commit(
      actor,
      input(
        'customers',
        withLine(sample('customers.csv'), '+8801990000005,Sample Buyer Five,1,0,0,500'),
      ),
    );
    expect(buyers).toMatchObject({ created: true, rows: 1, skipped: 4 });

    const after = await footprint();
    expect(Number(after?.skus)).toBe(Number(before?.skus) + 1);
    expect(Number(after?.customers)).toBe(Number(before?.customers) + 1);
    // The buyers already imported kept their history: added once, never twice.
    expect(Number(after?.delivered)).toBe(Number(before?.delivered) + 1);
  });

  it('refuses an edited balance file that repeats a staged row', async () => {
    const edited = withLine(sample('wallet-balances.csv'), '');
    const report = await service.dryRun(actor, input('wallet_balances', `${edited}\n`));
    expect(report.alreadyImported).toBeNull();
    expect(report.canCommit).toBe(false);
    expect(report.problems.every((problem) => problem.message.includes('staged'))).toBe(true);
  });
});

// --- the opening, and check 4 --------------------------------------------------------

describe('posting the opening', () => {
  it('leaves no movement and no journal when the journal fails after the stock', async () => {
    const before = await footprint();
    const spy = vi.spyOn(ledger, 'post').mockRejectedValueOnce(new Error('the journal failed'));
    try {
      await expect(
        service.postOpening(actor, { asOf: TODAY, approvedBy: ACCOUNTANT }),
      ).rejects.toThrow('the journal failed');
    } finally {
      spy.mockRestore();
    }
    expect(await footprint()).toEqual(before);
    expect(Number(before?.staged)).toBe(4);
  });

  it('refuses an opening dated in the future or before yesterday', async () => {
    for (const asOf of ['2999-01-01', '2020-01-01', 'yesterday']) {
      await expect(
        service.postOpening(actor, { asOf, approvedBy: ACCOUNTANT }),
      ).rejects.toMatchObject({
        code: 'MIGRATION_IMPORT_REJECTED',
      });
    }
  });

  it('check 4: posts one journal whose trial balance is zero and whose stock is the valuation', async () => {
    const before = await footprint();
    await expect(
      service.postOpening(actor, { asOf: TODAY, approvedBy: ' ' }),
    ).rejects.toMatchObject({ code: 'MIGRATION_IMPORT_REJECTED' });
    const opening = await service.postOpening(actor, { asOf: TODAY, approvedBy: ACCOUNTANT });
    expect(opening).toMatchObject({ created: true, asOf: TODAY, movements: 7 });

    const after = await footprint();
    expect(Number(after?.journals)).toBe(Number(before?.journals) + 1);
    expect(Number(after?.movements)).toBe(Number(before?.movements) + 7);
    expect(after).toMatchObject({ staged: '0', openings: '1' });

    const lines = await withOrg(actor, (tx) => ledger.journalLines(tx, ORG_A, opening.journalId));
    const debit = lines.reduce((total, line) => total + line.debitPoisha, 0n);
    const credit = lines.reduce((total, line) => total + line.creditPoisha, 0n);
    expect(debit).toBe(credit);
    expect(debit).toBe(46_484_950n);

    const inventoryLine = lines
      .filter((line) => line.subtype === 'inventory')
      .reduce((total, line) => total + line.debitPoisha - line.creditPoisha, 0n);
    const valuation = await withOrg(actor, (tx) => inventory.valuation(tx, ORG_A));
    expect(inventoryLine).toBe(valuation.stockValuePoisha);
    expect(inventoryLine).toBe(stockValueOfSample());
    expect(valuation.units).toBe(186);

    const plug = lines.filter((line) => line.subtype === 'opening_equity');
    expect(plug.map((line) => line.creditPoisha)).toEqual([35_634_900n]);
  });

  it('opens the books once: a second post and a new balance file change nothing', async () => {
    const before = await footprint();
    const again = await service.postOpening(actor, { asOf: TODAY, approvedBy: ACCOUNTANT });
    expect(again.created).toBe(false);

    const late = withLine('wallet,amount_taka', '1100,1');
    const report = await service.dryRun(actor, input('wallet_balances', late));
    expect(report.canCommit).toBe(false);
    await expect(service.commit(actor, input('wallet_balances', late))).rejects.toMatchObject({
      code: 'MIGRATION_ALREADY_OPENED',
    });
    expect(await footprint()).toEqual(before);
  });
});

// --- check 5 ------------------------------------------------------------------------

describe('check 5: the reconciliation report', () => {
  it('agrees on every line: the files, the journal and the modules', async () => {
    const report = await service.reconciliation(actor);
    expect(report.journalBalanced).toBe(true);
    expect(report.rows).toHaveLength(9);
    expect(report.rows.filter((row) => !row.agrees)).toEqual([]);
    expect(report.agrees).toBe(true);
    expect(report.signedOffBy).toBeNull();
  });

  it('flags a line a module disagrees on', async () => {
    // Money into the bank on the opening date, from outside the import.
    const drift = randomUUID();
    const journalId = await withOrg(actor, async (tx) => {
      const bank = (await wallets.walletsByAccountCodes(tx, ORG_A, ['1100'])).get('1100');
      const income = await ledger.accountBySubtype(tx, ORG_A, 'other_income');
      if (bank === undefined || income === null) throw new Error('The demo set-up is missing.');
      const line = { branchId: null, partyType: null, partyId: null, memo: null };
      const posted = await ledger.post(tx, actor, {
        businessDate: toIsoDate(TODAY),
        sourceType: 'reconciliation_test',
        sourceId: drift,
        event: 'posted',
        idempotencyKey: idempotencyKey('reconciliation_test', drift, 'posted'),
        memo: 'Drift for the reconciliation test',
        reversesJournalId: null,
        lines: [
          {
            ...line,
            accountId: bank.account.accountId,
            debitPoisha: poisha(100),
            creditPoisha: ZERO,
          },
          { ...line, accountId: income.accountId, debitPoisha: ZERO, creditPoisha: poisha(100) },
        ],
      });
      return posted.journalId;
    });

    const report = await service.reconciliation(actor);
    const drifted = report.rows.filter((row) => !row.agrees);
    expect(drifted.map((row) => [row.section, row.label])).toEqual([['wallet', '1100']]);
    expect(drifted[0]?.modulePoisha).toBe((drifted[0]?.journalPoisha ?? 0n) + 100n);
    expect(report.agrees).toBe(false);
    await expect(service.signOff(actor, { by: 'Test Accountant' })).rejects.toMatchObject({
      code: 'MIGRATION_NOT_RECONCILED',
    });

    // Undone the only way the ledger allows: a reversal, dated today.
    await withOrg(actor, (tx) => ledger.reverse(tx, actor, journalId, 'Reconciliation test'));
    expect((await service.reconciliation(actor)).agrees).toBe(true);
  });

  it('records the accountant’s sign-off once', async () => {
    const signed = await service.signOff(actor, { by: 'Test Accountant', note: 'Agreed.' });
    expect(signed.signedOffBy).toBe('Test Accountant');
    await expect(service.signOff(actor, { by: 'Someone Else' })).rejects.toMatchObject({
      code: 'MIGRATION_OPENING_IMMUTABLE',
    });
  });
});

// --- the database's own refusals -----------------------------------------------------

describe('the migration tables', () => {
  it('are invisible to another brand', async () => {
    const seen = await withOrg({ orgId: ORG_B, userId: 'usr_b' }, async (tx) =>
      tx.execute<{ batches: string; openings: string }>(sql`
        select (select count(*) from migration.batches)::text as batches,
               (select count(*) from migration.openings)::text as openings
      `),
    );
    expect(seen[0]).toEqual({ batches: '0', openings: '0' });
  });

  it('refuse to change or remove an imported file or the opening', async () => {
    const attempts = [
      sql`update migration.batches set file_name = 'renamed.csv'`,
      sql`update migration.batches set status = 'staged' where status = 'posted'`,
      sql`delete from migration.batches`,
      sql`update migration.openings set as_of = as_of - 1`,
      sql`delete from migration.openings`,
    ];
    for (const attempt of attempts) {
      await expect(withOrg(actor, (tx) => tx.execute(attempt))).rejects.toThrow();
    }
    const error = await withOrg(actor, (tx) =>
      tx.execute(sql`update migration.batches set status = 'discarded' where status = 'posted'`),
    ).catch((caught: unknown) => caught);
    expect(
      String((error as Error).message) + String((error as { cause?: Error }).cause?.message),
    ).toContain('MIGRATION_BATCH_IMMUTABLE');
  });
});

// --- the training org ----------------------------------------------------------------

describe('the training org, seeded from anonymised data (D-223)', () => {
  it('imports the sample through the real importers, opens its books and reconciles', async () => {
    const demo = await runDemo(service, { asOf: TODAY });
    expect(demo.imported.every((file) => file.created)).toBe(true);
    expect(demo.opening.created).toBe(true);
    expect(demo.reconciliation.agrees).toBe(true);
    expect(demo.reconciliation.journalBalanced).toBe(true);

    // Money is scaled, so the demo is not the source's figures — but stock still values
    // at Σ(qty × cost) of what was imported, to the poisha.
    const stock = demo.reconciliation.rows.find((row) => row.section === 'inventory');
    expect(stock?.importedPoisha).not.toBe(stockValueOfSample());
    expect(stock?.agrees).toBe(true);

    // No phone or name from the source reaches the training org.
    const sourcePhones = parseCsv(sample('customers.csv')).rows.map((row) => row.values.phone);
    const sourceNames = parseCsv(sample('customers.csv')).rows.map((row) => row.values.name);
    const buyers = await withSystem(
      (tx) =>
        tx.execute<{ phone_e164: string; name: string }>(
          sql`select phone_e164, name from sales.customers`,
        ),
      { orgId: demo.orgId },
    );
    expect(buyers).toHaveLength(sourcePhones.length);
    for (const buyer of buyers) {
      expect(sourcePhones).not.toContain(buyer.phone_e164);
      expect(sourceNames).not.toContain(buyer.name);
    }
  });

  it('is idempotent, and stays out of the consolidated totals', async () => {
    const again = await runDemo(service, { asOf: TODAY });
    expect(again.imported.every((file) => !file.created)).toBe(true);
    expect(again.opening.created).toBe(false);

    // Practice income in the training org, so the P&L read has something to leave out.
    const trainee = { orgId: again.orgId, userId: 'usr_trainee' };
    const sale = randomUUID();
    await withOrg(trainee, async (tx) => {
      const bank = (await wallets.walletsByAccountCodes(tx, again.orgId, ['1100'])).get('1100');
      const income = await ledger.accountBySubtype(tx, again.orgId, 'other_income');
      if (bank === undefined || income === null) throw new Error('The training set-up is missing.');
      const line = { branchId: null, partyType: null, partyId: null, memo: null };
      await ledger.post(tx, trainee, {
        businessDate: toIsoDate(TODAY),
        sourceType: 'training_test',
        sourceId: sale,
        event: 'posted',
        idempotencyKey: idempotencyKey('training_test', sale, 'posted'),
        memo: 'Practice income',
        reversesJournalId: null,
        lines: [
          {
            ...line,
            accountId: bank.account.accountId,
            debitPoisha: poisha(500),
            creditPoisha: ZERO,
          },
          { ...line, accountId: income.accountId, debitPoisha: ZERO, creditPoisha: poisha(500) },
        ],
      });
    });

    const totals = await withAnalytics((tx) => consolidatedWalletTotals(tx));
    expect(totals.map((row) => row.org_id)).not.toContain(again.orgId);
    expect(totals.map((row) => row.org_id)).toContain(ORG_A);
    const pnl = await withAnalytics((tx) =>
      consolidatedProfitAndLoss(tx, { from: TODAY, to: TODAY }),
    );
    expect(pnl.map((row) => row.org_id)).not.toContain(again.orgId);
  });

  it('sends no SMS, whatever a trainee sets up', async () => {
    const orgId = (await runDemo(service, { asOf: TODAY })).orgId;
    await withSystem(
      (tx) =>
        tx.execute(sql`
          insert into notify.templates
            (org_id, key, channel, category, body_bn, body_en, is_active, updated_by)
          values (${orgId}, 'practice', 'sms', 'transactional', 'অনুশীলন', 'Practice', true,
                  'usr_trainee')
        `),
      { orgId },
    );
    const queued = await withOrg({ orgId, userId: 'usr_trainee' }, async (tx) => {
      const buyer = await tx.execute<{ phone_e164: string }>(
        sql`select phone_e164 from sales.customers limit 1`,
      );
      return notify.queue(tx, orgId, {
        templateKey: 'practice',
        phone: buyer[0]?.phone_e164 ?? '',
        locale: 'en',
        values: {},
      });
    });
    expect(queued.state).toBe('suppressed');
  });
});

it('reports a malformed file as a problem rather than failing', async () => {
  const report = await service.dryRun(
    actor,
    input('skus', 'product,sku,price_taka\n"unclosed,X,1\n'),
  );
  expect(report.canCommit).toBe(false);
  expect(report.problems.length).toBeGreaterThan(0);
  await expect(service.commit(actor, input('skus', ''))).rejects.toBeInstanceOf(MigrationError);
});

describe('concurrent steps on one brand', () => {
  const other: MigrationActor = { orgId: ORG_B, userId: 'usr_migration_test_b' };

  it('stages only one of two files racing to give a SKU two costs (D-216)', async () => {
    await seedDemoSetUp(ORG_B);
    await service.commit(other, input('skus'));

    const atCost = (cost: string) => ({
      kind: 'opening_stock' as const,
      fileName: `race-${cost}.csv`,
      csv: `sku,location,qty,unit_cost_taka\nDEMO-SCF-003,WH-01,5,${cost}\n`,
    });
    const results = await Promise.allSettled([
      service.commit(other, atCost('100.00')),
      service.commit(other, atCost('101.00')),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(refused?.reason).toMatchObject({
      code: 'MIGRATION_IMPORT_REJECTED',
    });

    const staged = await withOrg(other, (tx) =>
      tx.execute<{ n: string }>(
        sql`select count(*)::text as n from migration.batches where status = 'staged'`,
      ),
    );
    expect(staged[0]?.n).toBe('1');
  });

  it('never leaves a file staged beside an open book when a commit races the post', async () => {
    const results = await Promise.allSettled([
      service.postOpening(other, { asOf: TODAY, approvedBy: ACCOUNTANT }),
      service.commit(other, input('wallet_balances')),
    ]);
    expect(results[0]?.status).toBe('fulfilled');

    const state = await withOrg(other, (tx) =>
      tx.execute<{ staged: string; openings: string }>(sql`
        select (select count(*) from migration.batches where status = 'staged')::text as staged,
               (select count(*) from migration.openings)::text as openings
      `),
    );
    expect(state[0]).toEqual({ staged: '0', openings: '1' });
    if (results[1]?.status === 'rejected') {
      expect(results[1].reason).toMatchObject({ code: 'MIGRATION_ALREADY_OPENED' });
    }
  });
});
