import { BASIS_POINTS } from '../money/index.js';
import { median, ratio, returnRateBps } from './kpis.js';
import { normalizedMetrics, type BrandMonth } from './leaderboard.js';

/**
 * Rule-based insights (architecture §18; M24 check 3, D-326).
 *
 * Each rule is a plain comparison against a threshold, so the reason for a suggestion is
 * always one sentence anybody can check against the dashboard. Every rule needs a minimum
 * sample before it speaks: a 50% return rate on four parcels is noise, and a suggestion to
 * change the brand's COD policy on the strength of it would be worse than none.
 *
 * §18's example named a trust score; the fraud check is gone (D-291), so the
 * outside-Dhaka rule suggests an advance delivery charge for outside-Dhaka COD on its own.
 *
 * Insights carry a code and their numbers, never a sentence: the console words them in the
 * viewer's language, and the LLM narrative (if on) receives the same codes and numbers.
 */

export const INSIGHT_CODES = [
  'outside_dhaka_returns',
  'return_rate_rising',
  'campaign_below_break_even',
  'cpdo_rising',
  'slow_pickup',
  'channel_returns',
  'delivery_success_below_group',
] as const;

export type InsightCode = (typeof INSIGHT_CODES)[number];

export interface Insight {
  readonly code: InsightCode;
  readonly severity: 'warning' | 'info';
  /** Numbers as decimal strings (bps, poisha, seconds) and, for two rules, an id or code. */
  readonly params: Readonly<Record<string, string>>;
}

/** A brand's month, with the outside-Dhaka split the first rule needs. */
export interface InsightMonth extends BrandMonth {
  readonly ordersConfirmed: number;
  readonly deliveredOutsideDhaka: number;
  readonly returnedOutsideDhaka: number;
}

export interface InsightInput {
  readonly current: InsightMonth;
  readonly previous: InsightMonth;
  /** Every brand's figure this month, this brand's included; null where it has none. */
  readonly group: {
    readonly outsideDhakaReturnRateBps: readonly (bigint | null)[];
    readonly deliverySuccessBps: readonly (bigint | null)[];
  };
  readonly channels: readonly {
    readonly channel: string;
    readonly ordersDelivered: number;
    readonly ordersReturned: number;
  }[];
  readonly campaigns: readonly {
    readonly campaignId: string;
    readonly spendPoisha: bigint;
    readonly deliveredRevenuePoisha: bigint;
  }[];
}

/** ASSUMED defaults (D-326); a brand's own values would replace these without code. */
export interface InsightThresholds {
  /** Orders (or pickups) a rule needs before it says anything. */
  readonly minSample: number;
  /** Outside-Dhaka return rate this far above the group median, in basis points. */
  readonly outsideDhakaGapBps: bigint;
  /** Return rate up this much on last month, in basis points (percentage points × 100). */
  readonly returnRateRiseBps: bigint;
  /** CPDO up this much on last month, as a share of last month's, in basis points. */
  readonly cpdoRiseBps: bigint;
  /** A campaign is judged once it has spent this much in the month. */
  readonly campaignMinSpendPoisha: bigint;
  /** Delivered ROAS below this is below break-even on goods value. */
  readonly campaignRoasFloorBps: bigint;
  /** Mean desk pickup at or above this many seconds. */
  readonly slowPickupSeconds: number;
  /** A channel's return rate this far above the brand's own, in basis points. */
  readonly channelGapBps: bigint;
  /** Delivery success this far below the group median, in basis points. */
  readonly successGapBps: bigint;
}

export const DEFAULT_INSIGHT_THRESHOLDS: InsightThresholds = {
  minSample: 20,
  outsideDhakaGapBps: 500n,
  returnRateRiseBps: 300n,
  cpdoRiseBps: 2_500n,
  campaignMinSpendPoisha: 500_000n,
  campaignRoasFloorBps: 10_000n,
  slowPickupSeconds: 900,
  channelGapBps: 1_000n,
  successGapBps: 500n,
};

const text = (value: bigint | number): string => value.toString();

function outsideDhakaReturns(input: InsightInput, t: InsightThresholds): Insight[] {
  const { deliveredOutsideDhaka: delivered, returnedOutsideDhaka: returned } = input.current;
  if (delivered + returned < t.minSample) return [];
  const rate = returnRateBps(delivered, returned);
  const groupMedian = median(input.group.outsideDhakaReturnRateBps);
  if (rate === null || groupMedian === null) return [];
  const gap = rate - groupMedian;
  if (gap < t.outsideDhakaGapBps) return [];
  return [
    {
      code: 'outside_dhaka_returns',
      severity: 'warning',
      params: { rateBps: text(rate), medianBps: text(groupMedian), gapBps: text(gap) },
    },
  ];
}

function returnRateRising(input: InsightInput, t: InsightThresholds): Insight[] {
  const now = input.current;
  const before = input.previous;
  if (now.ordersDelivered + now.ordersReturned < t.minSample) return [];
  if (before.ordersDelivered + before.ordersReturned < t.minSample) return [];
  const rate = returnRateBps(now.ordersDelivered, now.ordersReturned);
  const previous = returnRateBps(before.ordersDelivered, before.ordersReturned);
  if (rate === null || previous === null || rate - previous < t.returnRateRiseBps) return [];
  return [
    {
      code: 'return_rate_rising',
      severity: 'warning',
      params: { rateBps: text(rate), previousBps: text(previous), riseBps: text(rate - previous) },
    },
  ];
}

function campaignsBelowBreakEven(input: InsightInput, t: InsightThresholds): Insight[] {
  return [...input.campaigns]
    .filter((campaign) => campaign.spendPoisha >= t.campaignMinSpendPoisha)
    .map((campaign) => ({
      campaign,
      roas: ratio(campaign.deliveredRevenuePoisha * BASIS_POINTS, campaign.spendPoisha),
    }))
    .filter(({ roas }) => roas !== null && roas < t.campaignRoasFloorBps)
    .sort((a, b) =>
      a.campaign.campaignId < b.campaign.campaignId
        ? -1
        : a.campaign.campaignId > b.campaign.campaignId
          ? 1
          : 0,
    )
    .map(({ campaign, roas }) => ({
      code: 'campaign_below_break_even' as const,
      severity: 'warning' as const,
      params: {
        campaignId: campaign.campaignId,
        roasBps: text(roas ?? 0n),
        spendPoisha: text(campaign.spendPoisha),
      },
    }));
}

function cpdoRising(input: InsightInput, t: InsightThresholds): Insight[] {
  if (input.current.ordersDelivered < t.minSample) return [];
  if (input.previous.ordersDelivered < t.minSample) return [];
  const now = ratio(input.current.spendPoisha, BigInt(input.current.ordersDelivered));
  const before = ratio(input.previous.spendPoisha, BigInt(input.previous.ordersDelivered));
  if (now === null || before === null || before === 0n) return [];
  const rise = ratio((now - before) * BASIS_POINTS, before);
  if (rise === null || rise < t.cpdoRiseBps) return [];
  return [
    {
      code: 'cpdo_rising',
      severity: 'info',
      params: { cpdoPoisha: text(now), previousPoisha: text(before), riseBps: text(rise) },
    },
  ];
}

function slowPickup(input: InsightInput, t: InsightThresholds): Insight[] {
  const { pickupCount, pickupSeconds } = input.current;
  if (pickupCount < t.minSample) return [];
  const mean = normalizedMetrics(input.current, input.previous).pickupTime;
  if (mean === null || mean < BigInt(t.slowPickupSeconds)) return [];
  return [
    {
      code: 'slow_pickup',
      severity: 'warning',
      params: {
        meanSeconds: text(mean),
        thresholdSeconds: text(t.slowPickupSeconds),
        pickups: text(pickupCount),
        totalSeconds: text(pickupSeconds),
      },
    },
  ];
}

function channelReturns(input: InsightInput, t: InsightThresholds): Insight[] {
  const brandRate = returnRateBps(input.current.ordersDelivered, input.current.ordersReturned);
  if (brandRate === null) return [];
  return [...input.channels]
    .filter((row) => row.ordersDelivered + row.ordersReturned >= t.minSample)
    .map((row) => ({ row, rate: returnRateBps(row.ordersDelivered, row.ordersReturned) }))
    .filter(({ rate }) => rate !== null && rate - brandRate >= t.channelGapBps)
    .sort((a, b) => (a.row.channel < b.row.channel ? -1 : a.row.channel > b.row.channel ? 1 : 0))
    .map(({ row, rate }) => ({
      code: 'channel_returns' as const,
      severity: 'info' as const,
      params: { channel: row.channel, rateBps: text(rate ?? 0n), brandRateBps: text(brandRate) },
    }));
}

function deliverySuccessBelowGroup(input: InsightInput, t: InsightThresholds): Insight[] {
  const now = input.current;
  if (now.ordersDelivered + now.ordersReturned + now.ordersCancelled < t.minSample) return [];
  const own = normalizedMetrics(now, input.previous).deliverySuccess;
  const groupMedian = median(input.group.deliverySuccessBps);
  if (own === null || groupMedian === null || groupMedian - own < t.successGapBps) return [];
  return [
    {
      code: 'delivery_success_below_group',
      severity: 'warning',
      params: {
        successBps: text(own),
        medianBps: text(groupMedian),
        gapBps: text(groupMedian - own),
      },
    },
  ];
}

/** Every rule, in a fixed order, so the same month always reads the same way. */
export function insights(
  input: InsightInput,
  thresholds: InsightThresholds = DEFAULT_INSIGHT_THRESHOLDS,
): Insight[] {
  return [
    ...outsideDhakaReturns(input, thresholds),
    ...returnRateRising(input, thresholds),
    ...deliverySuccessBelowGroup(input, thresholds),
    ...campaignsBelowBreakEven(input, thresholds),
    ...cpdoRising(input, thresholds),
    ...slowPickup(input, thresholds),
    ...channelReturns(input, thresholds),
  ];
}
