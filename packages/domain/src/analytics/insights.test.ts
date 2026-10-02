import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INSIGHT_THRESHOLDS,
  INSIGHT_CODES,
  insights,
  type InsightInput,
  type InsightMonth,
} from './insights.js';

/**
 * M24 acceptance check 3: the insight rules, each one fired, held back by too small a
 * sample, and tested at its threshold. The rules are pure functions of a month's figures
 * (D-326), so every case is a table row of numbers with the answer worked by hand.
 */

const quiet: InsightMonth = {
  ordersConfirmed: 0,
  ordersDelivered: 0,
  ordersReturned: 0,
  ordersCancelled: 0,
  deliveredRevenuePoisha: 0n,
  spendPoisha: 0n,
  pickupCount: 0,
  pickupSeconds: 0,
  deliveredOutsideDhaka: 0,
  returnedOutsideDhaka: 0,
};

const month = (overrides: Partial<InsightMonth>): InsightMonth => ({ ...quiet, ...overrides });

function input(overrides: Partial<InsightInput> = {}): InsightInput {
  return {
    current: quiet,
    previous: quiet,
    group: { outsideDhakaReturnRateBps: [], deliverySuccessBps: [] },
    channels: [],
    campaigns: [],
    ...overrides,
  };
}

const codes = (value: InsightInput) => insights(value).map((insight) => insight.code);

describe('a quiet month says nothing', () => {
  it('fires no rule on an empty brand', () => {
    expect(insights(input())).toEqual([]);
  });

  it('names every rule it can fire', () => {
    expect(INSIGHT_CODES).toHaveLength(7);
  });
});

describe('outside_dhaka_returns: §18’s example, without the trust score (D-291)', () => {
  const group = {
    outsideDhakaReturnRateBps: [1_000n, 1_200n, null, 3_000n],
    deliverySuccessBps: [],
  };

  it('fires when outside-Dhaka returns run 5 pp or more above the group median', () => {
    // 21 / (49 + 21) = 30.00%; the median of 10%, 12% and 30% is 12%; the gap is 18 pp.
    const result = insights(
      input({ current: month({ deliveredOutsideDhaka: 49, returnedOutsideDhaka: 21 }), group }),
    );
    expect(result).toEqual([
      {
        code: 'outside_dhaka_returns',
        severity: 'warning',
        params: { rateBps: '3000', medianBps: '1200', gapBps: '1800' },
      },
    ]);
  });

  it('fires at exactly the threshold and not one basis point under it', () => {
    // 17 / 100 = 17.00% against a median of 12.00%: exactly 5 pp.
    const at = input({
      current: month({ deliveredOutsideDhaka: 83, returnedOutsideDhaka: 17 }),
      group: { outsideDhakaReturnRateBps: [1_200n], deliverySuccessBps: [] },
    });
    expect(codes(at)).toEqual(['outside_dhaka_returns']);
    const under = input({
      current: month({ deliveredOutsideDhaka: 83, returnedOutsideDhaka: 17 }),
      group: { outsideDhakaReturnRateBps: [1_201n], deliverySuccessBps: [] },
    });
    expect(codes(under)).toEqual([]);
  });

  it('stays quiet on fewer than 20 outside-Dhaka parcels', () => {
    const small = input({
      current: month({ deliveredOutsideDhaka: 9, returnedOutsideDhaka: 10 }),
      group,
    });
    expect(codes(small)).toEqual([]);
  });

  it('stays quiet with no group to compare against', () => {
    const alone = input({
      current: month({ deliveredOutsideDhaka: 20, returnedOutsideDhaka: 20 }),
    });
    expect(codes(alone)).toEqual([]);
  });
});

describe('return_rate_rising', () => {
  it('fires on a rise of 3 pp or more over last month', () => {
    // 15 / 100 = 15% now, 10 / 100 = 10% before: +5 pp.
    const result = insights(
      input({
        current: month({ ordersDelivered: 85, ordersReturned: 15 }),
        previous: month({ ordersDelivered: 90, ordersReturned: 10 }),
      }),
    );
    expect(result).toEqual([
      {
        code: 'return_rate_rising',
        severity: 'warning',
        params: { rateBps: '1500', previousBps: '1000', riseBps: '500' },
      },
    ]);
  });

  it('does not fire on a rise of 2.9 pp, or when last month was too small to compare', () => {
    expect(
      codes(
        input({
          current: month({ ordersDelivered: 871, ordersReturned: 129 }), // 12.90%
          previous: month({ ordersDelivered: 90, ordersReturned: 10 }), // 10.00%
        }),
      ),
    ).toEqual([]);
    expect(
      codes(
        input({
          current: month({ ordersDelivered: 50, ordersReturned: 50 }),
          previous: month({ ordersDelivered: 10, ordersReturned: 0 }),
        }),
      ),
    ).toEqual([]);
  });
});

describe('delivery_success_below_group', () => {
  it('fires when delivery success sits 5 pp or more under the group median', () => {
    // 70 / (70 + 20 + 10) = 70%; the group median is 80%.
    const result = insights(
      input({
        current: month({ ordersDelivered: 70, ordersReturned: 20, ordersCancelled: 10 }),
        group: { outsideDhakaReturnRateBps: [], deliverySuccessBps: [7_000n, 8_000n, 9_000n] },
      }),
    );
    expect(result.map((insight) => insight.code)).toContain('delivery_success_below_group');
    expect(
      result.find((insight) => insight.code === 'delivery_success_below_group')?.params,
    ).toEqual({
      successBps: '7000',
      medianBps: '8000',
      gapBps: '1000',
    });
  });

  it('stays quiet at 4.99 pp under the median', () => {
    const result = insights(
      input({
        current: month({ ordersDelivered: 7_501, ordersReturned: 2_499 }), // 75.01%
        group: { outsideDhakaReturnRateBps: [], deliverySuccessBps: [8_000n] },
      }),
    );
    expect(result.map((insight) => insight.code)).not.toContain('delivery_success_below_group');
  });
});

describe('campaign_below_break_even', () => {
  it('names each campaign that spent ৳5,000 or more and returned less than 1× in goods', () => {
    const result = insights(
      input({
        campaigns: [
          // ৳6,000 spent, ৳4,500 delivered: 0.75×.
          { campaignId: 'c-2', spendPoisha: 600_000n, deliveredRevenuePoisha: 450_000n },
          // Exactly break-even is not below it.
          { campaignId: 'c-3', spendPoisha: 500_000n, deliveredRevenuePoisha: 500_000n },
          // Below break-even but under the spend threshold: too early to judge.
          { campaignId: 'c-4', spendPoisha: 499_999n, deliveredRevenuePoisha: 0n },
          { campaignId: 'c-1', spendPoisha: 1_000_000n, deliveredRevenuePoisha: 0n },
        ],
      }),
    );
    expect(result).toEqual([
      {
        code: 'campaign_below_break_even',
        severity: 'warning',
        params: { campaignId: 'c-1', roasBps: '0', spendPoisha: '1000000' },
      },
      {
        code: 'campaign_below_break_even',
        severity: 'warning',
        params: { campaignId: 'c-2', roasBps: '7500', spendPoisha: '600000' },
      },
    ]);
  });
});

describe('cpdo_rising', () => {
  it('fires when the cost per delivered order rises 25% or more', () => {
    // ৳250 now against ৳200 before: +25%.
    const result = insights(
      input({
        current: month({ ordersDelivered: 40, spendPoisha: 1_000_000n }),
        previous: month({ ordersDelivered: 50, spendPoisha: 1_000_000n }),
      }),
    );
    expect(result).toEqual([
      {
        code: 'cpdo_rising',
        severity: 'info',
        params: { cpdoPoisha: '25000', previousPoisha: '20000', riseBps: '2500' },
      },
    ]);
  });

  it('stays quiet on a 24% rise, on a month without spend before, and on a small month', () => {
    expect(
      codes(
        input({
          current: month({ ordersDelivered: 40, spendPoisha: 992_000n }), // ৳248
          previous: month({ ordersDelivered: 50, spendPoisha: 1_000_000n }),
        }),
      ),
    ).toEqual([]);
    expect(
      codes(
        input({
          current: month({ ordersDelivered: 40, spendPoisha: 1_000_000n }),
          previous: month({ ordersDelivered: 50 }),
        }),
      ),
    ).toEqual([]);
    expect(
      codes(
        input({
          current: month({ ordersDelivered: 19, spendPoisha: 9_000_000n }),
          previous: month({ ordersDelivered: 50, spendPoisha: 1_000_000n }),
        }),
      ),
    ).toEqual([]);
  });
});

describe('slow_pickup', () => {
  it('fires when the mean desk pickup is 15 minutes or more', () => {
    const result = insights(input({ current: month({ pickupCount: 20, pickupSeconds: 18_000 }) }));
    expect(result).toEqual([
      {
        code: 'slow_pickup',
        severity: 'warning',
        params: {
          meanSeconds: '900',
          thresholdSeconds: '900',
          pickups: '20',
          totalSeconds: '18000',
        },
      },
    ]);
  });

  it('stays quiet at 899 seconds and on fewer than 20 pickups', () => {
    expect(codes(input({ current: month({ pickupCount: 20, pickupSeconds: 17_980 }) }))).toEqual(
      [],
    );
    expect(codes(input({ current: month({ pickupCount: 19, pickupSeconds: 99_999 }) }))).toEqual(
      [],
    );
  });
});

describe('channel_returns', () => {
  it('names a channel whose return rate is 10 pp or more above the brand’s', () => {
    // Brand: 20 / 100 = 20%. WhatsApp: 15 / 50 = 30%. Facebook: 5 / 50 = 10%.
    const result = insights(
      input({
        current: month({ ordersDelivered: 80, ordersReturned: 20 }),
        channels: [
          { channel: 'whatsapp', ordersDelivered: 35, ordersReturned: 15 },
          { channel: 'facebook', ordersDelivered: 45, ordersReturned: 5 },
          // 50% but only 4 parcels: noise.
          { channel: 'phone', ordersDelivered: 2, ordersReturned: 2 },
        ],
      }),
    );
    expect(result).toEqual([
      {
        code: 'channel_returns',
        severity: 'info',
        params: { channel: 'whatsapp', rateBps: '3000', brandRateBps: '2000' },
      },
    ]);
  });
});

describe('the rules together', () => {
  it('report in a fixed order, whatever order the inputs came in', () => {
    const busy = input({
      current: month({
        ordersDelivered: 85,
        ordersReturned: 15,
        deliveredOutsideDhaka: 49,
        returnedOutsideDhaka: 21,
        pickupCount: 30,
        pickupSeconds: 30_000,
      }),
      previous: month({ ordersDelivered: 90, ordersReturned: 10 }),
      group: { outsideDhakaReturnRateBps: [1_000n], deliverySuccessBps: [] },
      campaigns: [{ campaignId: 'x', spendPoisha: 900_000n, deliveredRevenuePoisha: 1n }],
    });
    expect(codes(busy)).toEqual([
      'outside_dhaka_returns',
      'return_rate_rising',
      'campaign_below_break_even',
      'slow_pickup',
    ]);
  });

  it('take their thresholds as an argument, so a brand’s own would apply without code', () => {
    const lenient = { ...DEFAULT_INSIGHT_THRESHOLDS, slowPickupSeconds: 3_600 };
    const value = input({ current: month({ pickupCount: 20, pickupSeconds: 20_000 }) });
    expect(insights(value).map((insight) => insight.code)).toEqual(['slow_pickup']);
    expect(insights(value, lenient)).toEqual([]);
  });
});
