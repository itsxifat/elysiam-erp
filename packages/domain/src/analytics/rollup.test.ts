import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toIsoDate, type IsoDate } from '../dates/index.js';
import { poisha } from '../money/index.js';
import { kpis, median } from './kpis.js';
import {
  DEFAULT_LEADERBOARD_WEIGHTS,
  EMPTY_BRAND_MONTH,
  LeaderboardWeightsError,
  leaderboardView,
  normalizedMetrics,
  parseWeights,
  rankBoard,
  type BoardRow,
  type BrandMonth,
  type NormalizedMetrics,
} from './leaderboard.js';
import { rollupOrders, sumOrderMetrics, type OrderDayFact } from './rollup.js';

const d = (value: string): IsoDate => toIsoDate(value);

function fact(overrides: Partial<OrderDayFact> & { orderId: string }): OrderDayFact {
  return {
    channel: 'facebook',
    branchId: null,
    createdOn: d('2026-09-01'),
    confirmedOn: null,
    deliveredOn: null,
    returnedOn: null,
    cancelledOn: null,
    outsideDhaka: false,
    deliveredRevenuePoisha: poisha(0n),
    deliveredCostPoisha: poisha(0n),
    ...overrides,
  };
}

describe('rollupOrders: each event on its own Dhaka day (D-321)', () => {
  const facts = [
    fact({
      orderId: 'a',
      createdOn: d('2026-09-01'),
      confirmedOn: d('2026-09-01'),
      deliveredOn: d('2026-09-03'),
      deliveredRevenuePoisha: poisha(150_000n),
      deliveredCostPoisha: poisha(90_000n),
      outsideDhaka: true,
      branchId: 'branch-1',
    }),
    fact({
      orderId: 'b',
      channel: 'whatsapp',
      createdOn: d('2026-09-01'),
      confirmedOn: d('2026-09-02'),
      cancelledOn: d('2026-09-02'),
    }),
    fact({
      orderId: 'c',
      createdOn: d('2026-08-31'),
      confirmedOn: d('2026-08-31'),
      returnedOn: d('2026-09-03'),
      outsideDhaka: true,
    }),
  ];
  const days = [d('2026-09-01'), d('2026-09-02'), d('2026-09-03'), d('2026-09-04')];
  const [first, second, third, fourth] = rollupOrders(facts, days);

  it('counts placing and confirming on their own days', () => {
    expect(first?.org.ordersPlaced).toBe(2);
    expect(first?.org.ordersConfirmed).toBe(1);
    expect(second?.org.ordersConfirmed).toBe(1);
    expect(second?.org.ordersCancelled).toBe(1);
  });

  it('puts revenue, gross profit and outside-Dhaka counts on the delivery day', () => {
    expect(third?.org).toMatchObject({
      ordersDelivered: 1,
      ordersReturned: 1,
      deliveredRevenuePoisha: 150_000n,
      grossProfitPoisha: 60_000n,
      deliveredOutsideDhaka: 1,
      returnedOutsideDhaka: 1,
    });
  });

  it('keeps a branch row only for orders a branch took, and a row per channel', () => {
    expect([...(third?.byBranch.keys() ?? [])]).toEqual(['branch-1']);
    expect([...(first?.byChannel.keys() ?? [])].sort()).toEqual(['facebook', 'whatsapp']);
    expect(second?.byChannel.get('whatsapp')?.ordersCancelled).toBe(1);
  });

  it('still answers a quiet day, with zeros', () => {
    expect(fourth?.org).toEqual(sumOrderMetrics([]));
    expect(fourth?.byChannel.size).toBe(0);
  });

  it('makes the org row the sum of its channel rows, for any orders', () => {
    const day = fc.constantFrom(...days, d('2026-08-31'));
    const arbitraryFact = fc.record({
      orderId: fc.uuid(),
      channel: fc.constantFrom('facebook', 'phone', 'walk_in'),
      branchId: fc.option(fc.constantFrom('b1', 'b2'), { nil: null }),
      createdOn: day,
      confirmedOn: fc.option(day, { nil: null }),
      deliveredOn: fc.option(day, { nil: null }),
      returnedOn: fc.option(day, { nil: null }),
      cancelledOn: fc.option(day, { nil: null }),
      outsideDhaka: fc.boolean(),
      deliveredRevenuePoisha: fc.bigInt({ min: 0n, max: 10_000_000n }).map((v) => poisha(v)),
      deliveredCostPoisha: fc.bigInt({ min: 0n, max: 10_000_000n }).map((v) => poisha(v)),
    });
    fc.assert(
      fc.property(fc.array(arbitraryFact, { maxLength: 30 }), (orders) => {
        for (const row of rollupOrders(orders, days)) {
          expect(sumOrderMetrics(row.byChannel.values())).toEqual(row.org);
          const branched = sumOrderMetrics(row.byBranch.values());
          expect(branched.ordersPlaced).toBeLessThanOrEqual(row.org.ordersPlaced);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('kpis: ratios from sums, null with nothing to divide by', () => {
  it('computes §11 and §18 ratios in poisha and basis points', () => {
    expect(
      kpis({
        ordersConfirmed: 40,
        ordersDelivered: 30,
        ordersReturned: 10,
        ordersCancelled: 0,
        deliveredRevenuePoisha: 4_500_000n,
        spendPoisha: 900_000n,
        pickupCount: 3,
        pickupSeconds: 100,
      }),
    ).toEqual({
      aovPoisha: 150_000n,
      returnRateBps: 2_500n,
      deliverySuccessBps: 7_500n,
      cpoPoisha: 22_500n,
      cpdoPoisha: 30_000n,
      roasBps: 50_000n,
      pickupMeanSeconds: 33,
    });
  });

  it('answers null rather than zero or infinity', () => {
    const empty = kpis({
      ordersConfirmed: 0,
      ordersDelivered: 0,
      ordersReturned: 0,
      ordersCancelled: 0,
      deliveredRevenuePoisha: 0n,
      spendPoisha: 0n,
      pickupCount: 0,
      pickupSeconds: 0,
    });
    expect(Object.values(empty).every((value) => value === null)).toBe(true);
  });

  it('takes the median of what is there', () => {
    expect(median([])).toBeNull();
    expect(median([null, 5n, 1n, 3n])).toBe(3n);
    expect(median([4n, 1n, 2n, 9n])).toBe(3n);
  });
});

const month = (overrides: Partial<BrandMonth>): BrandMonth => ({
  ...EMPTY_BRAND_MONTH,
  ...overrides,
});

describe('normalizedMetrics (D-322)', () => {
  it('turns two months into growth, rates, ROAS, CPDO and pickup', () => {
    const now = month({
      ordersDelivered: 50,
      ordersReturned: 10,
      ordersCancelled: 5,
      deliveredRevenuePoisha: 6_000_000n,
      spendPoisha: 1_000_000n,
      pickupCount: 4,
      pickupSeconds: 1_000,
    });
    const before = month({ ordersDelivered: 40, deliveredRevenuePoisha: 4_000_000n });
    expect(normalizedMetrics(now, before)).toEqual({
      revenueGrowth: 5_000n, // +50%
      deliverySuccess: 7_692n, // 50 / 65
      returnRate: 1_667n, // 10 / 60
      roas: 60_000n, // 6×
      cpdo: 20_000n, // ৳200 per delivered order
      aovGrowth: 2_000n, // 1,200 vs 1,000
      pickupTime: 250n,
    });
  });

  it('has no growth without a previous month to grow from', () => {
    const metrics = normalizedMetrics(month({ deliveredRevenuePoisha: 10n }), EMPTY_BRAND_MONTH);
    expect(metrics.revenueGrowth).toBeNull();
    expect(metrics.aovGrowth).toBeNull();
  });
});

const metrics = (values: Partial<Record<keyof NormalizedMetrics, bigint | null>>) =>
  ({
    revenueGrowth: null,
    deliverySuccess: null,
    returnRate: null,
    roas: null,
    cpdo: null,
    aovGrowth: null,
    pickupTime: null,
    ...values,
  }) as NormalizedMetrics;

describe('rankBoard: competition ranks, rank scores, a weighted composite', () => {
  it('ranks each metric in its own direction and shares tied ranks', () => {
    const board = rankBoard([
      { orgId: 'a', metrics: metrics({ returnRate: 1_000n, roas: 30_000n }) },
      { orgId: 'b', metrics: metrics({ returnRate: 500n, roas: 30_000n }) },
      { orgId: 'c', metrics: metrics({ returnRate: 2_000n, roas: 10_000n }) },
    ]);
    const byOrg = new Map(board.map((entry) => [entry.orgId, entry]));
    expect(byOrg.get('b')?.ranks.returnRate).toBe(1);
    expect(byOrg.get('a')?.ranks.returnRate).toBe(2);
    expect(byOrg.get('c')?.ranks.returnRate).toBe(3);
    expect(byOrg.get('a')?.ranks.roas).toBe(1);
    expect(byOrg.get('b')?.ranks.roas).toBe(1);
    expect(byOrg.get('c')?.ranks.roas).toBe(3);
    expect(byOrg.get('c')?.scores.roas).toBe(0);
  });

  it('weights the scores over the metrics in play', () => {
    const board = rankBoard(
      [
        { orgId: 'a', metrics: metrics({ returnRate: 1_000n, roas: 10_000n }) },
        { orgId: 'b', metrics: metrics({ returnRate: 2_000n, roas: 20_000n }) },
      ],
      { ...DEFAULT_LEADERBOARD_WEIGHTS, returnRate: 3, roas: 1 },
    );
    // a: returnRate 10,000 ×3 + roas 0 ×1 = 30,000 / 4; b: 0 ×3 + 10,000 ×1 = 10,000 / 4.
    expect(board.map((entry) => [entry.orgId, entry.compositeBps, entry.rank])).toEqual([
      ['a', 7_500, 1],
      ['b', 2_500, 2],
    ]);
  });

  it('scores an unranked brand zero on that metric, and leaves out a metric nobody has', () => {
    const board = rankBoard([
      { orgId: 'a', metrics: metrics({ roas: 10_000n }) },
      { orgId: 'b', metrics: metrics({}) },
    ]);
    expect(board[0]).toMatchObject({ orgId: 'a', compositeBps: 10_000, rank: 1 });
    expect(board[1]).toMatchObject({ orgId: 'b', compositeBps: 0, rank: 2 });
    expect(board[1]?.ranks.roas).toBeNull();
  });

  it('keeps every composite within 0–10,000 and ranks by it, for any board', () => {
    const value = fc.option(fc.bigInt({ min: -50_000n, max: 50_000n }), { nil: null });
    const entry = fc.record({
      revenueGrowth: value,
      deliverySuccess: value,
      returnRate: value,
      roas: value,
      cpdo: value,
      aovGrowth: value,
      pickupTime: value,
    });
    fc.assert(
      fc.property(fc.array(entry, { minLength: 1, maxLength: 5 }), (rows) => {
        const board = rankBoard(
          rows.map((m, index) => ({ orgId: `o${String(index)}`, metrics: m })),
        );
        for (const ranked of board) {
          expect(ranked.compositeBps).toBeGreaterThanOrEqual(0);
          expect(ranked.compositeBps).toBeLessThanOrEqual(10_000);
          const ahead = board.filter((other) => other.compositeBps > ranked.compositeBps).length;
          expect(ranked.rank).toBe(ahead + 1);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('parseWeights (D-323)', () => {
  it('fills what is left out with the defaults', () => {
    expect(parseWeights({ roas: 5 })).toEqual({ ...DEFAULT_LEADERBOARD_WEIGHTS, roas: 5 });
    expect(parseWeights(undefined)).toEqual(DEFAULT_LEADERBOARD_WEIGHTS);
  });

  it('refuses unknown metrics, fractions, negatives and a board that weighs nothing', () => {
    expect(() => parseWeights({ responseTime: 1 })).toThrow(LeaderboardWeightsError);
    expect(() => parseWeights({ roas: 1.5 })).toThrow(LeaderboardWeightsError);
    expect(() => parseWeights({ roas: -1 })).toThrow(LeaderboardWeightsError);
    expect(() => parseWeights([1, 2])).toThrow(LeaderboardWeightsError);
    const zero = Object.fromEntries(Object.keys(DEFAULT_LEADERBOARD_WEIGHTS).map((k) => [k, 0]));
    expect(() => parseWeights(zero)).toThrow(LeaderboardWeightsError);
  });
});

describe('leaderboardView: D-023 as a function', () => {
  const ranked = rankBoard([
    { orgId: 'own', metrics: metrics({ roas: 20_000n }) },
    { orgId: 'peer', metrics: metrics({ roas: 30_000n }) },
  ]);
  const rows: BoardRow[] = ranked.map((entry) => ({
    ...entry,
    orgName: entry.orgId === 'own' ? 'Own brand' : 'Peer brand',
    current: month({ deliveredRevenuePoisha: 9_999_999n, spendPoisha: 123_456n }),
    previous: month({ deliveredRevenuePoisha: 1_111_111n }),
  }));

  it('shows an org admin their own raw figures and only normalized metrics for a peer', () => {
    const view = leaderboardView(rows, { orgId: 'own', isSuperAdmin: false });
    const own = view.find((row) => row.orgId === 'own');
    const peer = view.find((row) => row.orgId === 'peer');
    expect(own?.visibility).toBe('full');
    expect(peer?.visibility).toBe('normalized');
    expect(Object.keys(peer ?? {}).sort()).toEqual(
      [
        'compositeBps',
        'metrics',
        'orgId',
        'orgName',
        'rank',
        'ranks',
        'scores',
        'visibility',
      ].sort(),
    );
    expect(
      JSON.stringify(peer, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    ).not.toContain('9999999');
  });

  it('shows Super Admin everything', () => {
    const view = leaderboardView(rows, { orgId: 'own', isSuperAdmin: true });
    expect(view.every((row) => row.visibility === 'full')).toBe(true);
  });
});
