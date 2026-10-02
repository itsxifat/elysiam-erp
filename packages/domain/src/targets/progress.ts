import type { IsoDate } from '../dates/index.js';

import { TargetError } from './errors.js';

/**
 * Target progress from the order desk's results (architecture §12; M20).
 *
 * §12 names three metrics and no others. Two are counts and one is money, and the code
 * keeps them apart by unit rather than by name: a target's value and its achieved figure
 * are both `bigint`, in orders for the counts and in poisha for revenue, so a revenue
 * target compared against an order count is a type of mistake the metric decides, not one
 * a caller can make.
 */
export const TARGET_METRICS = [
  'confirmed_orders',
  'delivered_orders',
  'delivered_revenue',
] as const;

export type TargetMetric = (typeof TARGET_METRICS)[number];

export function isTargetMetric(value: string): value is TargetMetric {
  return (TARGET_METRICS as readonly string[]).includes(value);
}

/** Whether the metric counts orders (true) or sums poisha (false). */
export function isCountMetric(metric: TargetMetric): boolean {
  return metric !== 'delivered_revenue';
}

/**
 * One agent's results on one Asia/Dhaka business day.
 *
 * Who an order counts for is decided where the rows are read (D-272: the agent who
 * confirmed it); this function only adds them up.
 */
export interface AgentDayResult {
  readonly userId: string;
  readonly businessDate: IsoDate;
  readonly confirmedOrders: number;
  readonly deliveredOrders: number;
  /** Net goods revenue recognised, in poisha. Never a cost. */
  readonly deliveredRevenuePoisha: bigint;
}

export function metricValue(result: AgentDayResult, metric: TargetMetric): bigint {
  switch (metric) {
    case 'confirmed_orders':
      return BigInt(result.confirmedOrders);
    case 'delivered_orders':
      return BigInt(result.deliveredOrders);
    case 'delivered_revenue':
      return result.deliveredRevenuePoisha;
  }
}

export interface ProgressWeek {
  readonly weekNo: number;
  readonly startsOn: IsoDate;
  readonly endsOn: IsoDate;
}

export interface ProgressInput {
  readonly metric: TargetMetric;
  readonly targetValue: bigint;
  readonly weeks: readonly ProgressWeek[];
  /** The logins whose results count: one for an employee target, several for a team. */
  readonly memberUserIds: readonly string[];
  readonly results: readonly AgentDayResult[];
}

export interface Progress {
  readonly achieved: bigint;
  readonly weeks: readonly { readonly weekNo: number; readonly achieved: bigint }[];
  /**
   * Achieved over target in basis points, rounded down: 10,000 is 100%.
   *
   * An integer, so "has this employee reached 120%" is an integer comparison everywhere it
   * is asked — the bonus evaluator asks it exactly, from the raw figures, and this number
   * is for display.
   */
  readonly pctBps: number;
}

/**
 * Add up the members' results into the target's weeks.
 *
 * A result outside every week — the day before the month began, an order confirmed by
 * somebody who is not a member — counts for nothing. The month total is the sum of the
 * weeks, so the two can never disagree on a screen.
 */
export function rollupProgress(input: ProgressInput): Progress {
  if (input.targetValue <= 0n) {
    throw new TargetError('TARGET_INVALID', 'A target must be greater than zero.');
  }
  const members = new Set(input.memberUserIds);
  const perWeek = new Map<number, bigint>(input.weeks.map((week) => [week.weekNo, 0n]));

  for (const result of input.results) {
    if (!members.has(result.userId)) continue;
    const week = input.weeks.find(
      (candidate) =>
        result.businessDate >= candidate.startsOn && result.businessDate <= candidate.endsOn,
    );
    if (week === undefined) continue;
    perWeek.set(week.weekNo, (perWeek.get(week.weekNo) ?? 0n) + metricValue(result, input.metric));
  }

  const weeks = input.weeks.map((week) => ({
    weekNo: week.weekNo,
    achieved: perWeek.get(week.weekNo) ?? 0n,
  }));
  const achieved = weeks.reduce((total, week) => total + week.achieved, 0n);

  return { achieved, weeks, pctBps: pctBps(achieved, input.targetValue) };
}

/** Achieved over target in basis points, rounded down, for display. */
export function pctBps(achieved: bigint, targetValue: bigint): number {
  if (targetValue <= 0n) return 0;
  const bps = (achieved * 10_000n) / targetValue;
  // A display figure: bounded so a mistyped target of 1 cannot overflow a JSON number.
  return Number(bps > 10_000_000n ? 10_000_000n : bps < 0n ? 0n : bps);
}
