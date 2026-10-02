import type { IsoDate } from '../dates/index.js';
import { allocate, poisha } from '../money/index.js';
import {
  isWorkingDay,
  monthDays,
  weekdayOf,
  type PayrollMonth,
  type WorkCalendar,
} from '../payroll/index.js';

import { TargetError } from './errors.js';

/**
 * A monthly target, split into weeks (architecture §12; M20 check 1).
 *
 * §12: "split into weeks by the working days in each week, using largest remainder so the
 * weeks sum exactly". Both halves are load-bearing. Weighting by working days means the
 * week with Eid in it asks for less, and the week after it does not have to make up for a
 * target the calendar made impossible. Largest remainder means 100 orders over weeks of 6,
 * 6, 5, 6 and 4 working days is 22 + 22 + 19 + 22 + 15 = 100, not 22 + 22 + 18 + 22 + 15 = 99
 * with an order that belongs to no week — the error an agent notices on the last Thursday
 * of the month and HR cannot explain.
 *
 * The split is `allocate`'s, not a second implementation of it: the money module already
 * has the one largest-remainder function in the system, with ties to the earlier part, and
 * a target in orders is split by exactly the same arithmetic as a target in poisha.
 */

/**
 * Saturday, the day after Bangladesh's Friday weekend (D-271).
 *
 * A week that started on Sunday or Monday would cut the working week in two — Saturday on
 * one side, Sunday to Thursday on the other — and every week's working-day count would be
 * off by one in a way nobody on the desk recognises.
 */
export const WEEK_STARTS_ON = 6;

export interface MonthWeek {
  /** 1-based, in calendar order. */
  readonly weekNo: number;
  readonly startsOn: IsoDate;
  readonly endsOn: IsoDate;
  readonly days: readonly IsoDate[];
}

/**
 * The month's weeks, clipped to the month.
 *
 * The first and the last week are usually partial — a month that starts on a Wednesday
 * has a four-day first week — and that is the point: a target is a month's target, and a
 * week that borrowed days from the next month would count orders the month's target does
 * not cover.
 */
export function monthWeeks(
  month: PayrollMonth,
  weekStartsOn: number = WEEK_STARTS_ON,
): MonthWeek[] {
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6) {
    throw new TargetError('TARGET_INVALID', 'A week starts on a weekday, 0 (Sunday) to 6.');
  }
  const weeks: IsoDate[][] = [];
  let current: IsoDate[] = [];
  for (const day of monthDays(month)) {
    if (current.length > 0 && weekdayOf(day) === weekStartsOn) {
      weeks.push(current);
      current = [];
    }
    current.push(day);
  }
  if (current.length > 0) weeks.push(current);

  return weeks.map((days, index) => {
    const first = days[0];
    const last = days[days.length - 1];
    // Every week holds at least one day by construction; said rather than asserted.
    if (first === undefined || last === undefined) {
      throw new TargetError('TARGET_INVALID', 'A week with no days cannot be planned.');
    }
    return { weekNo: index + 1, startsOn: first, endsOn: last, days };
  });
}

export interface WeekPlan {
  readonly weekNo: number;
  readonly startsOn: IsoDate;
  readonly endsOn: IsoDate;
  readonly calendarDays: number;
  readonly workingDays: number;
  /** This week's share of the month's target, in the target's own unit. */
  readonly planned: bigint;
}

/**
 * Split `total` across the month's weeks in proportion to their working days.
 *
 * A month with no working days at all — possible on a calendar that marks a whole short
 * month as holidays — is split by calendar days instead (D-271). Refusing it would leave HR
 * unable to record a target the calendar happens to make unusual, and an all-zero split
 * would lose the whole target, which is the one thing this function exists to prevent.
 */
export function splitTarget(
  total: bigint,
  month: PayrollMonth,
  calendar: WorkCalendar,
  weekStartsOn: number = WEEK_STARTS_ON,
): WeekPlan[] {
  if (total < 0n) {
    throw new TargetError('TARGET_INVALID', 'A target cannot be negative.');
  }
  const weeks = monthWeeks(month, weekStartsOn);
  const working = weeks.map(
    (week) => week.days.filter((day) => isWorkingDay(calendar, day)).length,
  );
  const anyWorking = working.some((count) => count > 0);
  const weights = anyWorking ? working : weeks.map((week) => week.days.length);

  // `allocate` is typed for money and bounded at ±9e15, comfortably above any target.
  const parts = allocate(poisha(total), weights);

  return weeks.map((week, index) => ({
    weekNo: week.weekNo,
    startsOn: week.startsOn,
    endsOn: week.endsOn,
    calendarDays: week.days.length,
    workingDays: working[index] ?? 0,
    planned: BigInt(parts[index] ?? 0n),
  }));
}
