import { BASIS_POINTS, divideRounded } from '../money/index.js';
import { deliverySuccessBps, pickupMeanSeconds, ratio, returnRateBps } from './kpis.js';

/**
 * The cross-brand leaderboard (architecture §18; M24, D-322 to D-324).
 *
 * Five brands of different sizes are compared on **normalized** metrics — rates, growth
 * and per-order figures — so a small brand that is improving can beat a large one that is
 * not. Each metric is ranked, each rank becomes a score, and a weighted mean of the scores
 * is the composite.
 *
 * - Ranking is competition ranking ("1224"): tied brands share a rank and the next rank
 *   skips. A brand with no value for a metric (nothing to divide by) is not ranked on it.
 * - A rank's score is `10,000 × (n − rank) ÷ (n − 1)` in basis points, where `n` is the
 *   number of brands ranked on that metric: the best is 10,000, the worst 0, and the scale
 *   does not depend on how far apart the raw values are — one outlier month cannot decide
 *   the board. A lone ranked brand scores 10,000. An unranked brand scores 0 on that metric.
 * - The composite is the weighted mean of the scores over the metrics **in play** (ranked
 *   for at least one brand, weight above zero), rounded half away from zero.
 *
 * Response time, which §18 also lists, was the Message Hub's figure and left with it
 * (D-290). Pickup time is the desk's mean pickup (D-322).
 */

export const LEADERBOARD_METRICS = [
  'revenueGrowth',
  'deliverySuccess',
  'returnRate',
  'roas',
  'cpdo',
  'aovGrowth',
  'pickupTime',
] as const;

export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number];

/** Which way is better. */
export const METRIC_DIRECTION: Readonly<Record<LeaderboardMetric, 'higher' | 'lower'>> = {
  revenueGrowth: 'higher',
  deliverySuccess: 'higher',
  returnRate: 'lower',
  roas: 'higher',
  cpdo: 'lower',
  aovGrowth: 'higher',
  pickupTime: 'lower',
};

/** What a brand's month is ranked from: the summed rollups (`analytics.daily_org`). */
export interface BrandMonth {
  readonly ordersDelivered: number;
  readonly ordersReturned: number;
  readonly ordersCancelled: number;
  readonly deliveredRevenuePoisha: bigint;
  readonly spendPoisha: bigint;
  readonly pickupCount: number;
  readonly pickupSeconds: number;
}

export const EMPTY_BRAND_MONTH: BrandMonth = {
  ordersDelivered: 0,
  ordersReturned: 0,
  ordersCancelled: 0,
  deliveredRevenuePoisha: 0n,
  spendPoisha: 0n,
  pickupCount: 0,
  pickupSeconds: 0,
};

/**
 * The normalized figures. Growth, rates and ROAS are basis points; CPDO is poisha per
 * delivered order; pickup time is seconds. Null where there is nothing to divide by.
 */
export type NormalizedMetrics = Readonly<Record<LeaderboardMetric, bigint | null>>;

/** (current − previous) ÷ previous, in basis points; null without a previous figure. */
function growthBps(current: bigint, previous: bigint): bigint | null {
  return ratio((current - previous) * BASIS_POINTS, previous);
}

export function normalizedMetrics(current: BrandMonth, previous: BrandMonth): NormalizedMetrics {
  const pickup = pickupMeanSeconds(current.pickupCount, current.pickupSeconds);

  // AOV growth from the exact fractions, so the two AOVs are not each rounded first:
  // (rc/dc − rp/dp) ÷ (rp/dp) = (rc·dp − rp·dc) ÷ (rp·dc).
  const rc = current.deliveredRevenuePoisha;
  const rp = previous.deliveredRevenuePoisha;
  const dc = BigInt(current.ordersDelivered);
  const dp = BigInt(previous.ordersDelivered);
  const aovGrowth =
    dc === 0n || dp === 0n ? null : ratio((rc * dp - rp * dc) * BASIS_POINTS, rp * dc);

  return {
    revenueGrowth: growthBps(rc, rp),
    deliverySuccess: deliverySuccessBps(
      current.ordersDelivered,
      current.ordersReturned,
      current.ordersCancelled,
    ),
    returnRate: returnRateBps(current.ordersDelivered, current.ordersReturned),
    roas: ratio(rc * BASIS_POINTS, current.spendPoisha),
    cpdo: ratio(current.spendPoisha, dc),
    aovGrowth,
    pickupTime: pickup === null ? null : BigInt(pickup),
  };
}

// --- weights -----------------------------------------------------------------------

export type LeaderboardWeights = Readonly<Record<LeaderboardMetric, number>>;

/** ASSUMED defaults (D-323): growth weighs most, then the delivery and money ratios. */
export const DEFAULT_LEADERBOARD_WEIGHTS: LeaderboardWeights = {
  revenueGrowth: 3,
  deliverySuccess: 2,
  returnRate: 2,
  roas: 2,
  cpdo: 1,
  aovGrowth: 1,
  pickupTime: 1,
};

export class LeaderboardWeightsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaderboardWeightsError';
  }
}

/**
 * Weights from configuration: an object of known metric names to whole numbers 0–100.
 * A metric left out keeps its default; an unknown name, a fraction or a negative is
 * refused rather than ignored, and so is a set that weighs nothing at all.
 */
export function parseWeights(input: unknown): LeaderboardWeights {
  if (input === undefined || input === null) return DEFAULT_LEADERBOARD_WEIGHTS;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new LeaderboardWeightsError('Leaderboard weights must be an object of metric: weight.');
  }
  const weights: Record<LeaderboardMetric, number> = { ...DEFAULT_LEADERBOARD_WEIGHTS };
  for (const [key, value] of Object.entries(input)) {
    if (!(LEADERBOARD_METRICS as readonly string[]).includes(key)) {
      throw new LeaderboardWeightsError(`"${key}" is not a leaderboard metric.`);
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
      throw new LeaderboardWeightsError(`The weight for ${key} must be a whole number 0–100.`);
    }
    weights[key as LeaderboardMetric] = value;
  }
  if (LEADERBOARD_METRICS.every((metric) => weights[metric] === 0)) {
    throw new LeaderboardWeightsError('At least one leaderboard weight must be above zero.');
  }
  return weights;
}

// --- ranking -----------------------------------------------------------------------

export interface BoardEntry {
  readonly orgId: string;
  readonly metrics: NormalizedMetrics;
}

export interface RankedEntry extends BoardEntry {
  /** 1 is best; null where the brand has no value for the metric. */
  readonly ranks: Readonly<Record<LeaderboardMetric, number | null>>;
  /** Basis points, 0–10,000. */
  readonly scores: Readonly<Record<LeaderboardMetric, number>>;
  /** The weighted mean of `scores` over the metrics in play, 0–10,000. */
  readonly compositeBps: number;
  /** Overall rank by composite, competition ranking. */
  readonly rank: number;
}

function better(metric: LeaderboardMetric, a: bigint, b: bigint): boolean {
  return METRIC_DIRECTION[metric] === 'higher' ? a > b : a < b;
}

/** Competition ranks for one metric: 1 + how many brands are strictly better. */
function ranksFor(
  entries: readonly BoardEntry[],
  metric: LeaderboardMetric,
): Map<string, number | null> {
  const ranks = new Map<string, number | null>();
  for (const entry of entries) {
    const value = entry.metrics[metric];
    if (value === null) {
      ranks.set(entry.orgId, null);
      continue;
    }
    let ahead = 0;
    for (const other of entries) {
      const theirs = other.metrics[metric];
      if (theirs !== null && better(metric, theirs, value)) ahead += 1;
    }
    ranks.set(entry.orgId, ahead + 1);
  }
  return ranks;
}

function scoreOf(rank: number | null, ranked: number): number {
  if (rank === null) return 0;
  if (ranked <= 1) return 10_000;
  return Number(divideRounded(BigInt(ranked - rank) * BASIS_POINTS, BigInt(ranked - 1)));
}

/** Rank every metric, score the ranks, and order the brands by their weighted composite. */
export function rankBoard(
  entries: readonly BoardEntry[],
  weights: LeaderboardWeights = DEFAULT_LEADERBOARD_WEIGHTS,
): RankedEntry[] {
  const perMetric = new Map(
    LEADERBOARD_METRICS.map((metric) => [metric, ranksFor(entries, metric)] as const),
  );
  const rankedCount = new Map(
    LEADERBOARD_METRICS.map(
      (metric) =>
        [metric, entries.filter((entry) => entry.metrics[metric] !== null).length] as const,
    ),
  );
  const inPlay = LEADERBOARD_METRICS.filter(
    (metric) => weights[metric] > 0 && (rankedCount.get(metric) ?? 0) > 0,
  );
  const weightTotal = inPlay.reduce((total, metric) => total + weights[metric], 0);

  const scored = entries.map((entry) => {
    const ranks = {} as Record<LeaderboardMetric, number | null>;
    const scores = {} as Record<LeaderboardMetric, number>;
    for (const metric of LEADERBOARD_METRICS) {
      const rank = perMetric.get(metric)?.get(entry.orgId) ?? null;
      ranks[metric] = rank;
      scores[metric] = scoreOf(rank, rankedCount.get(metric) ?? 0);
    }
    const weighted = inPlay.reduce(
      (total, metric) => total + BigInt(weights[metric]) * BigInt(scores[metric]),
      0n,
    );
    const compositeBps =
      weightTotal === 0 ? 0 : Number(divideRounded(weighted, BigInt(weightTotal)));
    return { ...entry, ranks, scores, compositeBps };
  });

  return scored
    .map((entry) => ({
      ...entry,
      rank: 1 + scored.filter((other) => other.compositeBps > entry.compositeBps).length,
    }))
    .sort((a, b) => a.rank - b.rank || (a.orgId < b.orgId ? -1 : a.orgId > b.orgId ? 1 : 0));
}

// --- D-023: who sees what ----------------------------------------------------------

/** A brand's row as the server holds it: raw figures, normalized metrics and ranks. */
export interface BoardRow extends RankedEntry {
  readonly orgName: string;
  readonly current: BrandMonth;
  readonly previous: BrandMonth;
}

/** A row with the brand's raw figures: the viewer's own brand, or any brand for Super Admin. */
export interface OwnBoardRow extends BoardRow {
  readonly visibility: 'full';
}

/** Another brand, as an org admin may see it: normalized metrics and ranks only (D-023). */
export interface PeerBoardRow {
  readonly visibility: 'normalized';
  readonly orgId: string;
  readonly orgName: string;
  readonly metrics: NormalizedMetrics;
  readonly ranks: RankedEntry['ranks'];
  readonly scores: RankedEntry['scores'];
  readonly compositeBps: number;
  readonly rank: number;
}

export type VisibleBoardRow = OwnBoardRow | PeerBoardRow;

export interface BoardViewer {
  readonly orgId: string;
  /** The platform flag (§5 exception 3), not a membership role. */
  readonly isSuperAdmin: boolean;
}

/**
 * D-023 as a function: an org admin sees every brand's normalized metrics and ranks, and
 * raw revenue, spend, orders and profit for their own brand only. Super Admin sees all.
 *
 * Another brand's row is **rebuilt** from an allow-list rather than copied and pruned, so
 * a raw field added to `BoardRow` later stays hidden until somebody adds it here on
 * purpose.
 */
export function leaderboardView(rows: readonly BoardRow[], viewer: BoardViewer): VisibleBoardRow[] {
  return rows.map((row): VisibleBoardRow => {
    if (viewer.isSuperAdmin || row.orgId === viewer.orgId) {
      return { ...row, visibility: 'full' };
    }
    return {
      visibility: 'normalized',
      orgId: row.orgId,
      orgName: row.orgName,
      metrics: row.metrics,
      ranks: row.ranks,
      scores: row.scores,
      compositeBps: row.compositeBps,
      rank: row.rank,
    };
  });
}
