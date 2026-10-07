import { randomBytes } from 'node:crypto';

import { SEED_ORG_IDS, seedTrainingOrg } from '@elysium/db';
import {
  seedDemoSetUp,
  startTestDatabase,
  stopSharedContainer,
  type TestDatabase,
} from '@elysium/db/testing';
import { addDays, businessDate, periodForMonth } from '@elysium/domain';
import { DEFAULT_LEADERBOARD_WEIGHTS } from '@elysium/domain/analytics';
import {
  figuresWire,
  presetRange,
  profitAndLossFrom,
  rankBrands,
  snapshotMoneyFrom,
  sumFigures,
  type DateRange,
  type Figures,
} from '@elysium/mother-shared';
import { pino } from 'pino';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Actor } from './audit/audit.js';
import { brandLive } from './brands/live.js';
import { BrandPools } from './brands/pools.js';
import { expectedBrandSchema } from './brands/reader.js';
import { createBrand, findBrand, updateBrand, type BrandRow } from './brands/registry.js';
import { secretsKeyFrom } from './crypto/secrets.js';
import { motherSql } from './db/client.js';
import { PullService } from './pull/pull.js';
import { leaderboard, overview, profitAndLoss, wallets } from './reports/reports.js';
import { seedBrandFixture } from './testing/brand-fixture.js';
import { startMotherDatabase, type MotherTestDatabase } from './testing/harness.js';

/**
 * M32's acceptance checks 1, 3 and 4 against real databases: two brand databases, each
 * bootstrapped and migrated by `@elysium/db` and seeded by its own seed and a fixture of
 * working data, and a mother database bootstrapped and migrated by the mother's own
 * migrations. The mother reads the brands only through each brand's `erp_analytics` role.
 */

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const ORG_B = SEED_ORG_IDS['oura-lifestyle'] ?? '';
const TODAY = businessDate(new Date());

const actor: Actor = {
  userId: 'own_test',
  email: 'owner@example.com',
  name: 'Test Owner',
  ipAddress: '127.0.0.1',
  requestId: null,
};

const silent = pino({ level: 'silent' });
const secrets = secretsKeyFrom(randomBytes(32).toString('base64'), 'k1');
const pools = new BrandPools(() => secrets, {
  connectTimeoutSeconds: 5,
  statementTimeoutMs: 20_000,
});
const puller = new PullService(pools, 100, silent);

let brandA: TestDatabase;
let brandB: TestDatabase;
let mother: MotherTestDatabase;
let rowA: BrandRow;
let rowB: BrandRow;

beforeAll(async () => {
  // Each brand database seeded as a brand's own server is (`db:seed --brand`, D-470): its
  // one brand, plus the training org a brand keeps beside itself (D-223).
  brandA = await startTestDatabase('mbrand_a', { brands: ['elysium-lifestyle-bd'] });
  await seedDemoSetUp(ORG_A);
  const trainingOrg = await seedTrainingOrg();
  // The second brand on the same server: its own database, its own seed (D-469).
  const provided = process.env.TEST_DATABASE_URL;
  process.env.TEST_DATABASE_URL = brandA.adminUrl;
  try {
    brandB = await startTestDatabase('mbrand_b', { brands: ['oura-lifestyle'] });
  } finally {
    if (provided === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = provided;
  }
  await seedDemoSetUp(ORG_B);

  await seedBrandFixture({
    ownerUrl: brandA.ownerUrl,
    orgId: ORG_A,
    scale: 1,
    today: TODAY,
    orderSeries: 1,
  });
  await seedBrandFixture({
    ownerUrl: brandB.ownerUrl,
    orgId: ORG_B,
    scale: 3,
    today: TODAY,
    orderSeries: 2,
  });

  // Another org's rows inside brand A's database, which the mother must never count: the
  // training org's figures (D-223).
  const owner = postgres(brandA.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await owner.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${trainingOrg}, true)`;
      await tx`
        insert into analytics.daily_org (org_id, business_date, orders_placed, orders_delivered,
                                         delivered_revenue_poisha, gross_profit_poisha)
        values (${trainingOrg}, ${TODAY}::date, 99999, 99999, 999999999999, 1)
      `;
    });
  } finally {
    await owner.end();
  }

  mother = await startMotherDatabase(brandA.adminUrl);
  rowA = await createBrand(
    secrets,
    {
      slug: 'elysium-lifestyle-bd',
      displayName: 'Elysium Lifestyle BD',
      adminUrl: 'https://admin.elysium.example',
      readConnection: brandA.analyticsUrl,
    },
    actor,
  );
  rowB = await createBrand(
    secrets,
    {
      slug: 'oura-lifestyle',
      displayName: 'Oura Lifestyle',
      adminUrl: 'https://admin.oura.example',
      readConnection: brandB.analyticsUrl,
    },
    actor,
  );
  expect((await puller.pull(rowA.id, { trigger: 'first', full: true })).status).toBe('ok');
  expect((await puller.pull(rowB.id, { trigger: 'first', full: true })).status).toBe('ok');
}, 300_000);

afterAll(async () => {
  await pools.closeAll();
  await mother?.stop();
  await brandB?.stop();
  await brandA?.stop();
  await stopSharedContainer();
}, 120_000);

// --- the brands' own figures, read the way each brand's own screens read them ---------------

/** The brand dashboard's totals (`orgDays` + `sumTotals`, M24): erp_app, inside its org. */
async function brandOwnFigures(
  database: TestDatabase,
  orgId: string,
  range: DateRange,
): Promise<Figures> {
  const sql = postgres(database.appUrl, { max: 1, onnotice: () => undefined });
  try {
    return await sql.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${orgId}, true)`;
      const [row] = await tx<Record<string, string>[]>`
        select coalesce(sum(orders_placed), 0)::text as placed,
               coalesce(sum(orders_confirmed), 0)::text as confirmed,
               coalesce(sum(orders_delivered), 0)::text as delivered,
               coalesce(sum(orders_returned), 0)::text as returned,
               coalesce(sum(orders_cancelled), 0)::text as cancelled,
               coalesce(sum(delivered_revenue_poisha), 0)::text as revenue,
               coalesce(sum(gross_profit_poisha), 0)::text as gross,
               coalesce(sum(spend_poisha), 0)::text as spend,
               coalesce(sum(pickup_count), 0)::text as pickups,
               coalesce(sum(pickup_seconds), 0)::text as pickup_seconds,
               coalesce(sum(delivered_outside_dhaka), 0)::text as outside_delivered,
               coalesce(sum(returned_outside_dhaka), 0)::text as outside_returned
        from analytics.daily_org
        where org_id = ${orgId} and business_date between ${range.from}::date and ${range.to}::date
      `;
      const n = (key: string) => Number(row?.[key] ?? '0');
      return {
        ordersPlaced: n('placed'),
        ordersConfirmed: n('confirmed'),
        ordersDelivered: n('delivered'),
        ordersReturned: n('returned'),
        ordersCancelled: n('cancelled'),
        deliveredRevenuePoisha: BigInt(row?.revenue ?? '0'),
        grossProfitPoisha: BigInt(row?.gross ?? '0'),
        spendPoisha: BigInt(row?.spend ?? '0'),
        pickupCount: n('pickups'),
        pickupSeconds: BigInt(row?.pickup_seconds ?? '0'),
        deliveredOutsideDhaka: n('outside_delivered'),
        returnedOutsideDhaka: n('outside_returned'),
      };
    });
  } finally {
    await sql.end();
  }
}

/** The brand's own ledger positions as of today and its income and expense over a range. */
async function brandLedger(database: TestDatabase, orgId: string, range: DateRange) {
  const sql = postgres(database.appUrl, { max: 1, onnotice: () => undefined });
  try {
    return await sql.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${orgId}, true)`;
      const positions = await tx<
        { subtype: string; normal_balance: 'debit' | 'credit'; debit: string; credit: string }[]
      >`
        select a.subtype::text as subtype, a.normal_balance::text as normal_balance,
               sum(l.debit_poisha)::text as debit, sum(l.credit_poisha)::text as credit
        from ledger.journal_lines l
        join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
        join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
        where l.org_id = ${orgId} and j.business_date <= ${TODAY}::date
        group by a.subtype, a.normal_balance
      `;
      const flows = await tx<
        { subtype: string; class: 'income' | 'expense'; debit: string; credit: string }[]
      >`
        select a.subtype::text as subtype, a.class::text as class,
               sum(l.debit_poisha)::text as debit, sum(l.credit_poisha)::text as credit
        from ledger.journal_lines l
        join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
        join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
        where l.org_id = ${orgId}
          and j.business_date between ${range.from}::date and ${range.to}::date
          and a.class::text in ('income', 'expense')
        group by a.subtype, a.class
      `;
      return {
        money: snapshotMoneyFrom(
          positions.map((row) => ({
            subtype: row.subtype,
            normalBalance: row.normal_balance,
            debitPoisha: BigInt(row.debit),
            creditPoisha: BigInt(row.credit),
          })),
        ),
        pnl: profitAndLossFrom(
          flows.map((row) => ({
            subtype: row.subtype,
            accountClass: row.class,
            debitPoisha: BigInt(row.debit),
            creditPoisha: BigInt(row.credit),
          })),
        ),
      };
    });
  } finally {
    await sql.end();
  }
}

const RANGES: readonly [string, DateRange][] = [
  ['today', presetRange('today', TODAY)],
  ['this week', presetRange('week', TODAY)],
  ['this month', presetRange('month', TODAY)],
  ['the last 30 days', { from: addDays(TODAY, -29), to: TODAY }],
];

describe('check 1: the overview is the sum of each brand’s own figures', () => {
  it.each(RANGES)('for %s', async (_label, range) => {
    const a = await brandOwnFigures(brandA, ORG_A, range);
    const b = await brandOwnFigures(brandB, ORG_B, range);
    const result = await overview(range);

    expect(result.totals).toEqual(figuresWire(sumFigures([a, b])));
    const byId = new Map(result.brands.map((row) => [row.brand.id, row]));
    expect(byId.get(rowA.id)?.figures).toEqual(figuresWire(a));
    expect(byId.get(rowB.id)?.figures).toEqual(figuresWire(b));
    // Spelled out once, so a reader sees the claim without the helpers.
    expect(BigInt(result.totals.deliveredRevenuePoisha)).toBe(
      a.deliveredRevenuePoisha + b.deliveredRevenuePoisha,
    );
    expect(result.totals.ordersDelivered).toBe(a.ordersDelivered + b.ordersDelivered);
  });

  it('never counts another org that shares a brand’s database', async () => {
    const range = presetRange('today', TODAY);
    const result = await overview(range);
    const a = result.brands.find((row) => row.brand.id === rowA.id);
    expect(a?.figures.ordersPlaced).toBeLessThan(99_999);
    expect(a?.figures).toEqual(figuresWire(await brandOwnFigures(brandA, ORG_A, range)));
  });

  it('adds every brand’s cash, stock, COD, payables and receivables from its own ledger', async () => {
    const range = presetRange('month', TODAY);
    const a = (await brandLedger(brandA, ORG_A, range)).money;
    const b = (await brandLedger(brandB, ORG_B, range)).money;
    const totals = (await overview(range)).snapshotTotals;
    expect(BigInt(totals.cashPoisha)).toBe(a.cashPoisha + b.cashPoisha);
    expect(BigInt(totals.stockValuePoisha)).toBe(a.stockValuePoisha + b.stockValuePoisha);
    expect(BigInt(totals.codHeldPoisha)).toBe(a.codHeldPoisha + b.codHeldPoisha);
    expect(BigInt(totals.supplierPayablesPoisha)).toBe(
      a.supplierPayablesPoisha + b.supplierPayablesPoisha,
    );
    expect(BigInt(totals.receivablesPoisha)).toBe(a.receivablesPoisha + b.receivablesPoisha);
    // The fixture's own numbers, so the test is not only comparing a function with itself.
    expect(a.cashPoisha).toBe(5_000_000n + 250_075n + 1_200_050n - 200_000n - 30_000n - 12_345n);
    expect(b.cashPoisha).toBe(3n * a.cashPoisha);
    // Pending, confirmed and shipped are open; delivered is not. Two staff are active.
    expect(totals.openOrdersTotal).toBe(6);
    expect(totals.staffHeadcount).toBe(4);
    expect(totals.activeSkus).toBe(6);
    expect(totals.lowStockSkus).toBe(4);
  });

  it('gives the accounts across brands from the same books (D-493)', async () => {
    const range = { from: addDays(TODAY, -29), to: TODAY };
    const a = await brandLedger(brandA, ORG_A, range);
    const b = await brandLedger(brandB, ORG_B, range);
    const pnl = await profitAndLoss(range);
    expect(BigInt(pnl.incomePoisha)).toBe(a.pnl.incomePoisha + b.pnl.incomePoisha);
    expect(BigInt(pnl.expensePoisha)).toBe(a.pnl.expensePoisha + b.pnl.expensePoisha);
    expect(BigInt(pnl.netPoisha)).toBe(a.pnl.netPoisha + b.pnl.netPoisha);
    // Income is revenue and delivery charges less the discounts given (4110 is contra).
    expect(a.pnl.incomePoisha).toBe(1_200_050n + 800_000n + 50_000n - 30_000n);
    const cash = await wallets();
    expect(BigInt(cash.totalPoisha)).toBe(a.money.cashPoisha + b.money.cashPoisha);
  });

  it('ranks the brands on the leaderboard from the pulled months (D-492)', async () => {
    const month = TODAY.slice(0, 7);
    const board = await leaderboard(month, DEFAULT_LEADERBOARD_WEIGHTS);
    expect(board.rows.map((row) => row.brandId).sort()).toEqual([rowA.id, rowB.id].sort());
    const current = periodForMonth(month);
    const previous = periodForMonth(addDays(current.startsOn, -1).slice(0, 7));
    const months = async (database: TestDatabase, orgId: string) => ({
      current: await brandOwnFigures(database, orgId, {
        from: current.startsOn,
        to: current.endsOn,
      }),
      previous: await brandOwnFigures(database, orgId, {
        from: previous.startsOn,
        to: previous.endsOn,
      }),
    });
    const expected = rankBrands(
      [
        { brandId: rowA.id, ...(await months(brandA, ORG_A)) },
        { brandId: rowB.id, ...(await months(brandB, ORG_B)) },
      ],
      DEFAULT_LEADERBOARD_WEIGHTS,
    );
    expect(board.rows.map((row) => [row.brandId, row.rank, row.compositeBps])).toEqual(
      expected.map((row) => [row.orgId, row.rank, row.compositeBps]),
    );
  });
});

describe('check 3: the mother’s read role cannot write to a brand database', () => {
  const statements = [
    `insert into analytics.daily_org (org_id, business_date) values ('${ORG_A}', '2001-01-01')`,
    `update sales.orders set status = 'cancelled'`,
    `delete from ledger.journal_lines`,
    `update org.organizations set display_name = 'x'`,
    `insert into hr.employees (org_id, code, full_name, join_date, created_by) values ('${ORG_A}', 'X', 'X', '2026-01-01', 'x')`,
    `create table public.mother_probe (id int)`,
  ];

  it.each(statements)('refuses, even outside a read-only transaction: %s', async (statement) => {
    const brand = await findBrand(rowA.id);
    if (brand === undefined) throw new Error('brand A is missing');
    const sql = pools.for(brand);
    let message = '';
    try {
      await sql.begin(async (tx) => {
        // The connection is read-only by default; lift that, so the grant alone is tested.
        await tx`set transaction read write`;
        await tx.unsafe(statement);
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/permission denied|must be owner/i);
  });

  it('refuses a write in the default read-only transaction too', async () => {
    const brand = await findBrand(rowA.id);
    if (brand === undefined) throw new Error('brand A is missing');
    await expect(
      pools.for(brand).unsafe(`update org.organizations set display_name = 'x'`),
    ).rejects.toThrow(/read-only transaction|permission denied/i);
  });

  it('reads no buyer, no cost and no salary detail', async () => {
    const brand = await findBrand(rowA.id);
    if (brand === undefined) throw new Error('brand A is missing');
    for (const column of [
      'select ship_phone_e164 from sales.orders',
      'select ship_name from sales.orders',
      'select dispatch_unit_cost_poisha from sales.order_lines',
      'select phone_cipher from hr.employees',
      'select * from inventory.sku_costs',
      'select * from iam.users',
    ]) {
      await expect(pools.for(brand).unsafe(column), column).rejects.toThrow(/permission denied/i);
    }
  });
});

describe('check 4: a brand that cannot be reached keeps its last figures, and the others load', () => {
  it('records the error and its age, keeps the figures, and still pulls the other brand', async () => {
    const range = presetRange('month', TODAY);
    const before = (await overview(range)).brands.find((row) => row.brand.id === rowB.id);
    const figuresAt = (await findBrand(rowB.id))?.figures_at;
    expect(figuresAt).not.toBeNull();

    await updateBrand(
      secrets,
      rowB.id,
      { readConnection: 'postgres://erp_analytics:nothing@127.0.0.1:9/nowhere' },
      actor,
    );
    try {
      const outcome = await puller.pull(rowB.id, { trigger: 'schedule', full: false });
      expect(outcome).toEqual({ status: 'failed', code: 'unreachable' });
      expect((await puller.pull(rowA.id, { trigger: 'schedule', full: false })).status).toBe('ok');

      const after = (await overview(range)).brands.find((row) => row.brand.id === rowB.id);
      expect(after?.figures).toEqual(before?.figures);
      expect(after?.snapshot?.cashPoisha).toBe(before?.snapshot?.cashPoisha);
      expect(after?.brand.figuresAt).toBe(figuresAt?.toISOString());
      expect(after?.brand.lastError?.code).toBe('unreachable');
      // The error is a code; the connection string is nowhere in the answer.
      expect(JSON.stringify(after)).not.toContain('nothing@');
    } finally {
      await updateBrand(secrets, rowB.id, { readConnection: brandB.analyticsUrl }, actor);
    }
    expect((await puller.pull(rowB.id, { trigger: 'owner', full: false })).status).toBe('ok');
    const healed = (await overview(range)).brands.find((row) => row.brand.id === rowB.id);
    expect(healed?.brand.lastError).toBeNull();
  });

  it('refuses to read a brand whose schema version is not this build’s', async () => {
    const owner = postgres(brandB.ownerUrl, { max: 1, onnotice: () => undefined });
    try {
      await owner`
        insert into drizzle.__drizzle_migrations (hash, created_at)
        values ('not-this-build', (select max(created_at) + 1 from drizzle.__drizzle_migrations))
      `;
      const outcome = await puller.pull(rowB.id, { trigger: 'schedule', full: false });
      expect(outcome.status).toBe('version_mismatch');
      const brand = await findBrand(rowB.id);
      expect(brand?.schema_status).toBe('version_mismatch');
      expect(brand?.brand_migrations).toBe(expectedBrandSchema().count + 1);
      expect(brand?.figures_at).not.toBeNull();
      const live = await brandLive(pools, rowB.id);
      expect(live).toEqual({ ok: false, error: { code: 'version_mismatch' } });
    } finally {
      await owner`delete from drizzle.__drizzle_migrations where hash = 'not-this-build'`;
      await owner.end();
    }
    expect((await puller.pull(rowB.id, { trigger: 'owner', full: false })).status).toBe('ok');
    expect((await findBrand(rowB.id))?.schema_status).toBe('ok');
  });
});

describe('pulling (D-484)', () => {
  it('replaces the recent window, and only a full pull reaches older days', async () => {
    const old = addDays(TODAY, -35);
    const owner = postgres(brandA.ownerUrl, { max: 1, onnotice: () => undefined });
    const short = new PullService(pools, 7, silent);
    const read = async (date: string) => {
      const [row] = await motherSql()<{ revenue: string }[]>`
        select delivered_revenue_poisha::text as revenue from mother.brand_daily
        where brand_id = ${rowA.id} and business_date = ${date}::date
      `;
      return row?.revenue;
    };
    const original = await read(old);
    try {
      await owner.begin(async (tx) => {
        await tx`select set_config('app.org_id', ${ORG_A}, true)`;
        await tx`
          update analytics.daily_org set delivered_revenue_poisha = delivered_revenue_poisha + 7
          where org_id = ${ORG_A} and business_date in (${TODAY}::date, ${old}::date)
        `;
      });
      const todayBefore = await read(TODAY);
      expect((await short.pull(rowA.id, { trigger: 'schedule', full: false })).status).toBe('ok');
      expect(BigInt((await read(TODAY)) ?? '0')).toBe(BigInt(todayBefore ?? '0') + 7n);
      expect(await read(old)).toBe(original);
      expect((await short.pull(rowA.id, { trigger: 'owner', full: true })).status).toBe('ok');
      expect(BigInt((await read(old)) ?? '0')).toBe(BigInt(original ?? '0') + 7n);
    } finally {
      await owner.begin(async (tx) => {
        await tx`select set_config('app.org_id', ${ORG_A}, true)`;
        await tx`
          update analytics.daily_org set delivered_revenue_poisha = delivered_revenue_poisha - 7
          where org_id = ${ORG_A} and business_date in (${TODAY}::date, ${old}::date)
        `;
      });
      await owner.end();
      await puller.pull(rowA.id, { trigger: 'owner', full: true });
    }
  });

  it('a tick and a full pull of one brand at once both land, one after the other', async () => {
    const count = async () => {
      const [row] = await motherSql()<{ days: number; total: string }[]>`
        select count(*)::int as days, coalesce(sum(delivered_revenue_poisha), 0)::text as total
        from mother.brand_daily where brand_id = ${rowA.id}
      `;
      return row;
    };
    const before = await count();
    const outcomes = await Promise.all([
      puller.pull(rowA.id, { trigger: 'schedule', full: false }),
      puller.pull(rowA.id, { trigger: 'nightly', full: true }),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['ok', 'ok']);
    // The same figures, each day once: the writes did not interleave.
    expect(await count()).toEqual(before);
  });

  it('keeps a history of attempts', async () => {
    const [counts] = await motherSql()<{ ok: number; failed: number; mismatch: number }[]>`
      select count(*) filter (where status = 'ok')::int as ok,
             count(*) filter (where status = 'failed')::int as failed,
             count(*) filter (where status = 'version_mismatch')::int as mismatch
      from mother.pull_runs
    `;
    expect(counts?.ok).toBeGreaterThan(3);
    expect(counts?.failed).toBeGreaterThanOrEqual(1);
    expect(counts?.mismatch).toBeGreaterThanOrEqual(1);
  });
});

describe('a brand’s page reads its live lists (D-481)', () => {
  it('lists orders, top products, low stock, wallets, courier COD and staff, and no buyer', async () => {
    const result = await brandLive(pools, rowA.id);
    if (!result.ok) throw new Error(`live read failed: ${result.error.code}`);
    const live = result.live;
    expect(live.latestOrders.map((order) => order.status)).toEqual([
      'delivered',
      'shipped',
      'confirmed',
      'pending',
    ]);
    expect(live.latestOrders[0]?.totalPoisha).toBe((4n * 250_000n + 6_000n).toString());
    expect(JSON.stringify(live)).not.toContain('+8801');
    expect(JSON.stringify(live)).not.toContain('Fixture Buyer');
    expect(live.topProducts).toEqual([
      { skuCode: 'LP1-S', productName: 'Linen panjabi', units: 4 },
    ]);
    expect(live.lowStock.map((row) => row.skuCode).sort()).toEqual(['LP1-L', 'LP1-S']);
    expect(live.wallets.map((wallet) => wallet.code)).toEqual(
      expect.arrayContaining(['1010-HQ', '1100', '1110']),
    );
    expect(live.courierCod).toEqual([{ courier: 'Steadfast', heldPoisha: '850000' }]);
    expect(live.staff.headcount).toBe(2);
    expect(live.staff.people.map((person) => person.code)).toEqual(['E-002', 'E-001', 'E-003']);
  });
});
