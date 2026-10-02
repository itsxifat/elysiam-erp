import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toIsoDate, type IsoDate } from '../dates/index.js';
import { poisha } from '../money/index.js';
import {
  aggregateFacts,
  campaignMetrics,
  dailySeries,
  EMPTY_INPUTS,
  type OrderFact,
  type SpendFact,
} from './index.js';

/**
 * M18 acceptance check 1: "The metric functions reproduce hand-computed values on a
 * fixture dataset."
 *
 * The dataset is September 2026 for two campaigns and one organic order, with rows on both
 * sides of the period's edges so the period rule (D-255) is exercised, not assumed. Every
 * expected figure below was worked by hand from §11's definitions before the code ran;
 * the arithmetic is written next to each one.
 */

const d = (value: string): IsoDate => toIsoDate(value);
const SEPTEMBER = { from: d('2026-09-01'), to: d('2026-09-30') };
const EID = 'campaign-eid';
const PUJA = 'campaign-puja';

function order(
  orderId: string,
  campaignId: string | null,
  fields: {
    confirmedOn?: string;
    deliveredOn?: string;
    returnedOn?: string;
    delivered?: number;
    placed: number;
  },
): OrderFact {
  return {
    orderId,
    campaignId,
    confirmedOn: fields.confirmedOn === undefined ? null : d(fields.confirmedOn),
    deliveredOn: fields.deliveredOn === undefined ? null : d(fields.deliveredOn),
    returnedOn: fields.returnedOn === undefined ? null : d(fields.returnedOn),
    deliveredRevenuePoisha: poisha(fields.delivered ?? 0),
    placedRevenuePoisha: poisha(fields.placed),
  };
}

const SPEND: SpendFact[] = [
  { campaignId: EID, spendOn: d('2026-08-31'), amountPoisha: poisha(99_900) }, // before
  { campaignId: EID, spendOn: d('2026-09-01'), amountPoisha: poisha(100_000) },
  { campaignId: EID, spendOn: d('2026-09-02'), amountPoisha: poisha(150_000) },
  { campaignId: PUJA, spendOn: d('2026-09-10'), amountPoisha: poisha(200_000) },
  { campaignId: PUJA, spendOn: d('2026-10-01'), amountPoisha: poisha(50_000) }, // after
];

const ORDERS: OrderFact[] = [
  // Eid: delivered in full.
  order('o1', EID, {
    confirmedOn: '2026-09-01',
    deliveredOn: '2026-09-04',
    delivered: 300_000,
    placed: 300_000,
  }),
  // Eid: partly delivered, ৳1,200 of ৳2,000 kept.
  order('o2', EID, {
    confirmedOn: '2026-09-02',
    deliveredOn: '2026-09-05',
    delivered: 120_000,
    placed: 200_000,
  }),
  // Eid: refused and returned.
  order('o3', EID, { confirmedOn: '2026-09-02', returnedOn: '2026-09-08', placed: 150_000 }),
  // Eid: confirmed in August, delivered in September — a delivery here, not a confirmation.
  order('o4', EID, {
    confirmedOn: '2026-08-30',
    deliveredOn: '2026-09-01',
    delivered: 80_000,
    placed: 80_000,
  }),
  // Eid: confirmed at month end, still on its way.
  order('o5', EID, { confirmedOn: '2026-09-29', placed: 100_000 }),
  // Puja: delivered.
  order('o6', PUJA, {
    confirmedOn: '2026-09-10',
    deliveredOn: '2026-09-12',
    delivered: 250_000,
    placed: 250_000,
  }),
  // Puja: confirmed then cancelled. It still "reached confirmed".
  order('o7', PUJA, { confirmedOn: '2026-09-11', placed: 90_000 }),
  // Puja: confirmed on the last day, delivered in October.
  order('o9', PUJA, {
    confirmedOn: '2026-09-30',
    deliveredOn: '2026-10-02',
    delivered: 70_000,
    placed: 70_000,
  }),
  // Nobody's campaign.
  order('o8', null, {
    confirmedOn: '2026-09-15',
    deliveredOn: '2026-09-17',
    delivered: 50_000,
    placed: 50_000,
  }),
  // Pending and never confirmed: counts for nothing.
  order('o10', EID, { placed: 400_000 }),
];

describe('check 1: §11 metrics on the September fixture', () => {
  const aggregated = aggregateFacts(ORDERS, SPEND, SEPTEMBER);
  const metricsOf = (key: string | null) =>
    campaignMetrics(aggregated.byCampaign.get(key) ?? EMPTY_INPUTS);

  it('Eid: CPO, CPDO, ROAS, placed ROAS and return rate', () => {
    expect(metricsOf(EID)).toEqual({
      spendPoisha: 250_000n, // 1,000 + 1,500 taka; the 31 August row is outside
      confirmedOrders: 4, // o1, o2, o3, o5 (o4 confirmed in August, o10 never)
      deliveredOrders: 3, // o1, o2 (partial), o4
      deliveredRevenuePoisha: 500_000n, // 3,000 + 1,200 + 800
      placedRevenuePoisha: 750_000n, // 3,000 + 2,000 + 1,500 + 1,000
      returnedOrders: 1, // o3
      cpoPoisha: 62_500n, // 250,000 / 4
      cpdoPoisha: 83_333n, // 250,000 / 3 = 83,333.33…
      roasBps: 20_000n, // 500,000 / 250,000 = 2.00×
      placedRoasBps: 30_000n, // 750,000 / 250,000 = 3.00×
      returnRateBps: 2_500n, // 1 / (3 + 1) = 25%
    });
  });

  it('Puja: a third rounds up, and a campaign with no return has a 0% rate', () => {
    expect(metricsOf(PUJA)).toEqual({
      spendPoisha: 200_000n,
      confirmedOrders: 3, // o6, o7, o9
      deliveredOrders: 1, // o6; o9 delivered in October
      deliveredRevenuePoisha: 250_000n,
      placedRevenuePoisha: 410_000n, // 2,500 + 900 + 700
      returnedOrders: 0,
      cpoPoisha: 66_667n, // 200,000 / 3 = 66,666.67, half away from zero
      cpdoPoisha: 200_000n,
      roasBps: 12_500n, // 1.25×
      placedRoasBps: 20_500n, // 2.05×
      returnRateBps: 0n, // 0 / (1 + 0)
    });
  });

  it('unattributed orders carry no spend, so their ROAS is undefined, not zero', () => {
    const organic = metricsOf(null);
    expect(organic.spendPoisha).toBe(0n);
    expect(organic.confirmedOrders).toBe(1);
    expect(organic.deliveredRevenuePoisha).toBe(50_000n);
    expect(organic.roasBps).toBeNull();
    expect(organic.placedRoasBps).toBeNull();
    expect(organic.cpoPoisha).toBe(0n); // ৳0 of spend over one order
  });

  it('the blended total counts every order and every taka', () => {
    expect(campaignMetrics(aggregated.total)).toEqual({
      spendPoisha: 450_000n,
      confirmedOrders: 8,
      deliveredOrders: 5,
      deliveredRevenuePoisha: 800_000n,
      placedRevenuePoisha: 1_210_000n,
      returnedOrders: 1,
      cpoPoisha: 56_250n, // 450,000 / 8
      cpdoPoisha: 90_000n, // 450,000 / 5
      roasBps: 17_778n, // 800,000 / 450,000 = 1.7777…×
      placedRoasBps: 26_889n, // 1,210,000 / 450,000 = 2.6888…×
      returnRateBps: 1_667n, // 1 / 6 = 16.666…%
    });
  });

  it('the daily series puts spend and delivered revenue on the day they happened', () => {
    const series = dailySeries(ORDERS, SPEND, SEPTEMBER);
    expect(series).toHaveLength(30);
    const on = (date: string) => series.find((point) => point.date === date);
    expect(on('2026-09-01')).toEqual({
      date: '2026-09-01',
      spendPoisha: 100_000n,
      deliveredRevenuePoisha: 80_000n,
    });
    expect(on('2026-09-04')?.deliveredRevenuePoisha).toBe(300_000n);
    expect(on('2026-09-10')?.spendPoisha).toBe(200_000n);
    expect(on('2026-09-30')).toEqual({
      date: '2026-09-30',
      spendPoisha: 0n,
      deliveredRevenuePoisha: 0n,
    });
    const spent = series.reduce((total, point) => total + point.spendPoisha, 0n);
    expect(spent).toBe(450_000n);
  });
});

describe('ratios', () => {
  it('every ratio with a zero denominator is null', () => {
    expect(campaignMetrics(EMPTY_INPUTS)).toMatchObject({
      cpoPoisha: null,
      cpdoPoisha: null,
      roasBps: null,
      placedRoasBps: null,
      returnRateBps: null,
    });
  });

  it('CPO times orders is within half an order of the spend', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        fc.integer({ min: 1, max: 100_000 }),
        (spend, orders) => {
          const metrics = campaignMetrics({
            ...EMPTY_INPUTS,
            spendPoisha: poisha(spend),
            confirmedOrders: orders,
          });
          const cpo = metrics.cpoPoisha ?? 0n;
          const error = cpo * BigInt(orders) - spend;
          const magnitude = error < 0n ? -error : error;
          return magnitude * 2n <= BigInt(orders);
        },
      ),
    );
  });

  it('return rate never exceeds 100%', () => {
    fc.assert(
      fc.property(fc.nat(10_000), fc.nat(10_000), (delivered, returned) => {
        const rate = campaignMetrics({
          ...EMPTY_INPUTS,
          deliveredOrders: delivered,
          returnedOrders: returned,
        }).returnRateBps;
        return delivered + returned === 0 ? rate === null : rate !== null && rate <= 10_000n;
      }),
    );
  });
});
