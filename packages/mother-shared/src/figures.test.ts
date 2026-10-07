import { toIsoDate, type IsoDate } from '@elysium/domain';
import { DEFAULT_LEADERBOARD_WEIGHTS } from '@elysium/domain/analytics';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  addFigures,
  daysOf,
  EMPTY_SNAPSHOT,
  figureKpis,
  presetRange,
  previousRange,
  profitAndLossFrom,
  rankBrands,
  snapshotMoneyFrom,
  sumFigures,
  sumSnapshots,
  WALLET_KINDS,
  ZERO_FIGURES,
  type Figures,
  type LedgerFlowRow,
  type SnapshotFigures,
} from './figures.js';
import { brandCreateSchema, rangeQuerySchema, readConnectionSchema } from './schemas.js';

const count = fc.integer({ min: 0, max: 50_000 });
const money = fc.bigInt({ min: 0n, max: 9_000_000_000_000n });

const figures: fc.Arbitrary<Figures> = fc.record({
  ordersPlaced: count,
  ordersConfirmed: count,
  ordersDelivered: count,
  ordersReturned: count,
  ordersCancelled: count,
  deliveredRevenuePoisha: money,
  grossProfitPoisha: fc.bigInt({ min: -9_000_000_000_000n, max: 9_000_000_000_000n }),
  spendPoisha: money,
  pickupCount: count,
  pickupSeconds: fc.bigInt({ min: 0n, max: 10_000_000n }),
  deliveredOutsideDhaka: count,
  returnedOutsideDhaka: count,
});

describe('sumFigures (D-484)', () => {
  it('adds brands exactly, in any order and any grouping', () => {
    fc.assert(
      fc.property(
        fc.array(figures, { maxLength: 8 }),
        fc.integer({ min: 0, max: 8 }),
        (rows, cut) => {
          const whole = sumFigures(rows);
          const split = addFigures(sumFigures(rows.slice(0, cut)), sumFigures(rows.slice(cut)));
          expect(split).toEqual(whole);
          expect(sumFigures([...rows].reverse())).toEqual(whole);
        },
      ),
    );
  });

  it('is zero for no brands', () => {
    expect(sumFigures([])).toEqual(ZERO_FIGURES);
  });

  it("computes the group's ratios from the group's sums, never as a mean of ratios", () => {
    const big: Figures = { ...ZERO_FIGURES, ordersDelivered: 900, ordersReturned: 100 };
    const small: Figures = { ...ZERO_FIGURES, ordersDelivered: 5, ordersReturned: 5 };
    // 10% and 50%: a mean would say 30%. The group returned 105 of 1,010 parcels.
    expect(figureKpis(big).returnRateBps).toBe(1000n);
    expect(figureKpis(small).returnRateBps).toBe(5000n);
    expect(figureKpis(sumFigures([big, small])).returnRateBps).toBe(1040n);
  });
});

describe('snapshotMoneyFrom (D-485)', () => {
  it('reads every position on its normal side', () => {
    const money = snapshotMoneyFrom([
      {
        subtype: 'wallet_cash',
        normalBalance: 'debit',
        debitPoisha: 50_000n,
        creditPoisha: 20_000n,
      },
      { subtype: 'wallet_bank', normalBalance: 'debit', debitPoisha: 1_000n, creditPoisha: 0n },
      { subtype: 'inventory', normalBalance: 'debit', debitPoisha: 90_000n, creditPoisha: 10_000n },
      {
        subtype: 'courier_receivable',
        normalBalance: 'debit',
        debitPoisha: 7_000n,
        creditPoisha: 2_000n,
      },
      {
        subtype: 'supplier_payable',
        normalBalance: 'credit',
        debitPoisha: 4_000n,
        creditPoisha: 64_000n,
      },
      { subtype: 'other_receivable', normalBalance: 'debit', debitPoisha: 300n, creditPoisha: 0n },
      {
        subtype: 'employee_loan_receivable',
        normalBalance: 'debit',
        debitPoisha: 200n,
        creditPoisha: 0n,
      },
    ]);
    expect(money.cashByKind.wallet_cash).toBe(30_000n);
    expect(money.cashByKind.wallet_bank).toBe(1_000n);
    expect(money.cashByKind.wallet_bkash).toBe(0n);
    expect(money.cashPoisha).toBe(31_000n);
    expect(money.stockValuePoisha).toBe(80_000n);
    expect(money.codHeldPoisha).toBe(5_000n);
    expect(money.supplierPayablesPoisha).toBe(60_000n);
    expect(money.receivablesPoisha).toBe(500n);
  });

  it('keeps an overdrawn wallet negative rather than hiding it', () => {
    const money = snapshotMoneyFrom([
      { subtype: 'wallet_bkash', normalBalance: 'debit', debitPoisha: 0n, creditPoisha: 700n },
    ]);
    expect(money.cashPoisha).toBe(-700n);
  });
});

describe('sumSnapshots', () => {
  const snapshot: fc.Arbitrary<SnapshotFigures> = fc
    .record({
      cashByKind: fc.record({
        wallet_cash: money,
        wallet_bank: money,
        wallet_bkash: money,
        wallet_mfs_other: money,
      }),
      stockValuePoisha: money,
      goodsInTransitPoisha: money,
      codHeldPoisha: money,
      supplierPayablesPoisha: money,
      receivablesPoisha: money,
      openOrders: fc.dictionary(fc.constantFrom('pending', 'confirmed', 'shipped'), count),
      staffHeadcount: count,
      activeSkus: count,
      lowStockSkus: count,
    })
    .map((value) => ({
      ...value,
      cashPoisha: WALLET_KINDS.reduce((total, kind) => total + value.cashByKind[kind], 0n),
    }));

  it('is the field-by-field sum of every brand', () => {
    fc.assert(
      fc.property(fc.array(snapshot, { maxLength: 6 }), (list) => {
        const total = sumSnapshots(list);
        const field = (pick: (s: SnapshotFigures) => bigint) =>
          list.reduce((sum, item) => sum + pick(item), 0n);
        expect(total.cashPoisha).toBe(field((s) => s.cashPoisha));
        expect(total.stockValuePoisha).toBe(field((s) => s.stockValuePoisha));
        expect(total.codHeldPoisha).toBe(field((s) => s.codHeldPoisha));
        expect(total.supplierPayablesPoisha).toBe(field((s) => s.supplierPayablesPoisha));
        for (const kind of WALLET_KINDS) {
          expect(total.cashByKind[kind]).toBe(field((s) => s.cashByKind[kind]));
        }
        expect(total.staffHeadcount).toBe(list.reduce((sum, s) => sum + s.staffHeadcount, 0));
        const pending = list.reduce((sum, s) => sum + (s.openOrders.pending ?? 0), 0);
        expect(total.openOrders.pending ?? 0).toBe(pending);
      }),
    );
  });

  it('is empty for no brands', () => {
    expect(sumSnapshots([])).toEqual(EMPTY_SNAPSHOT);
  });
});

describe('profitAndLossFrom (D-493)', () => {
  it('nets sales discounts off income, like the brand ledger', () => {
    const rows: LedgerFlowRow[] = [
      { subtype: 'sales_revenue', accountClass: 'income', debitPoisha: 0n, creditPoisha: 100_000n },
      { subtype: 'sales_discounts', accountClass: 'income', debitPoisha: 5_000n, creditPoisha: 0n },
      { subtype: 'cogs', accountClass: 'expense', debitPoisha: 60_000n, creditPoisha: 0n },
      { subtype: 'ad_spend', accountClass: 'expense', debitPoisha: 8_000n, creditPoisha: 1_000n },
    ];
    const result = profitAndLossFrom(rows);
    expect(result.incomePoisha).toBe(95_000n);
    expect(result.expensePoisha).toBe(67_000n);
    expect(result.netPoisha).toBe(28_000n);
  });

  it("adds every flow, and each class's lines add up to its total", () => {
    const flow: fc.Arbitrary<LedgerFlowRow> = fc.record({
      subtype: fc.constantFrom('sales_revenue', 'sales_discounts', 'cogs', 'ad_spend'),
      accountClass: fc.constantFrom('income' as const, 'expense' as const),
      debitPoisha: money,
      creditPoisha: money,
    });
    fc.assert(
      fc.property(fc.array(flow, { maxLength: 30 }), (rows) => {
        const result = profitAndLossFrom(rows);
        const expectedIncome = rows
          .filter((row) => row.accountClass === 'income')
          .reduce((sum, row) => sum + row.creditPoisha - row.debitPoisha, 0n);
        const expectedExpense = rows
          .filter((row) => row.accountClass === 'expense')
          .reduce((sum, row) => sum + row.debitPoisha - row.creditPoisha, 0n);
        expect(result.incomePoisha).toBe(expectedIncome);
        expect(result.expensePoisha).toBe(expectedExpense);
        expect(result.netPoisha).toBe(expectedIncome - expectedExpense);
        const lineSum = (cls: 'income' | 'expense') =>
          result.lines
            .filter((line) => line.accountClass === cls)
            .reduce((sum, line) => sum + line.amountPoisha, 0n);
        expect(lineSum('income')).toBe(expectedIncome);
        expect(lineSum('expense')).toBe(expectedExpense);
      }),
    );
  });
});

describe('ranges', () => {
  const day = (value: string): IsoDate => toIsoDate(value);

  it('starts the week on Sunday and the month on the 1st (D-459)', () => {
    // 2026-10-07 is a Wednesday.
    expect(presetRange('week', day('2026-10-07'))).toEqual({
      from: '2026-10-04',
      to: '2026-10-07',
    });
    expect(presetRange('week', day('2026-10-04'))).toEqual({
      from: '2026-10-04',
      to: '2026-10-04',
    });
    expect(presetRange('month', day('2026-10-07'))).toEqual({
      from: '2026-10-01',
      to: '2026-10-07',
    });
    expect(presetRange('today', day('2026-10-07'))).toEqual({
      from: '2026-10-07',
      to: '2026-10-07',
    });
  });

  it('compares with the same number of days just before', () => {
    expect(previousRange({ from: day('2026-10-01'), to: day('2026-10-07') })).toEqual({
      from: '2026-09-24',
      to: '2026-09-30',
    });
    expect(daysOf({ from: day('2026-02-27'), to: day('2026-03-02') })).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
  });

  it('refuses a backwards or an over-long range', () => {
    expect(rangeQuerySchema.safeParse({ from: '2026-10-02', to: '2026-10-01' }).success).toBe(
      false,
    );
    expect(rangeQuerySchema.safeParse({ from: '2024-01-01', to: '2026-01-01' }).success).toBe(
      false,
    );
    expect(rangeQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-31' }).success).toBe(true);
  });
});

describe('the brand registry input (D-481)', () => {
  it('accepts only the read-only reporting role', () => {
    expect(
      readConnectionSchema.safeParse('postgres://erp_analytics:secret@127.0.0.1:6543/erp_oura')
        .success,
    ).toBe(true);
    for (const user of ['erp_owner', 'erp_app', 'postgres']) {
      expect(
        readConnectionSchema.safeParse(`postgres://${user}:secret@127.0.0.1:6543/erp_oura`).success,
      ).toBe(false);
    }
    expect(readConnectionSchema.safeParse('mysql://erp_analytics:x@h/db').success).toBe(false);
  });

  it('refuses query parameters that would sign in as another role or database', () => {
    const base = 'postgres://erp_analytics:secret@127.0.0.1:6543/erp';
    for (const query of ['?user=erp_owner', '?database=postgres', '?options=-c%20role%3Dx']) {
      expect(readConnectionSchema.safeParse(base + query).success, query).toBe(false);
    }
    expect(readConnectionSchema.safeParse(`${base}?sslmode=require`).success).toBe(true);
  });

  it('wants an https admin address and a slug', () => {
    const base = {
      slug: 'oura-lifestyle',
      displayName: 'Oura Lifestyle',
      adminUrl: 'https://admin.oura.example',
      readConnection: 'postgres://erp_analytics:secret@127.0.0.1:6543/erp_oura',
    };
    expect(brandCreateSchema.safeParse(base).success).toBe(true);
    expect(
      brandCreateSchema.safeParse({ ...base, adminUrl: 'http://admin.oura.example' }).success,
    ).toBe(false);
    expect(brandCreateSchema.safeParse({ ...base, slug: 'Oura Lifestyle' }).success).toBe(false);
  });
});

describe('rankBrands (D-492)', () => {
  it("ranks by the domain's board, growth against the month before", () => {
    const month = (revenue: bigint, delivered: number, returned: number): Figures => ({
      ...ZERO_FIGURES,
      deliveredRevenuePoisha: revenue,
      ordersDelivered: delivered,
      ordersReturned: returned,
      spendPoisha: 10_000n,
    });
    const ranked = rankBrands(
      [
        { brandId: 'a', current: month(200_000n, 20, 2), previous: month(100_000n, 10, 1) },
        { brandId: 'b', current: month(100_000n, 10, 5), previous: month(100_000n, 10, 1) },
      ],
      DEFAULT_LEADERBOARD_WEIGHTS,
    );
    expect(ranked[0]?.orgId).toBe('a');
    expect(ranked[0]?.rank).toBe(1);
    expect(ranked[1]?.rank).toBe(2);
  });
});
