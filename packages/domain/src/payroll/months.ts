import { isMonth, toIsoDate, type IsoDate } from '../dates/index.js';

import { PayrollError } from './errors.js';

/**
 * Payroll months, as `YYYY-MM` strings in the Asia/Dhaka calendar (invariant 8).
 *
 * A payroll month is a *label*, not an instant, and the difference matters here
 * more than anywhere else in the system: "March 2026 salary" is the same month
 * for an employee in Dhaka and for a server in Frankfurt, and deriving it from a
 * `Date` in the process timezone is how a run gets filed under February. So the
 * month crosses every boundary as this string, and only `monthDays` ever turns it
 * into dates — with no `Date` object involved, because `new Date('2026-03-01')`
 * is UTC midnight and is the previous day in Dhaka.
 */

/** A `YYYY-MM` month label. Branded so a random string cannot stand in for one. */
export type PayrollMonth = string & { readonly __payrollMonth: true };

export function toPayrollMonth(value: string): PayrollMonth {
  if (!isMonth(value)) {
    throw new PayrollError('PAYROLL_INPUT_INVALID', `"${value}" is not a YYYY-MM month.`);
  }
  return value as PayrollMonth;
}

function parts(month: PayrollMonth): { year: number; monthNo: number } {
  const year = Number(month.slice(0, 4));
  const monthNo = Number(month.slice(5, 7));
  return { year, monthNo };
}

/** `2026-03` + 1 → `2026-04`. Wraps the year, which `monthNo + 1` alone does not. */
export function addMonths(month: PayrollMonth, count: number): PayrollMonth {
  if (!Number.isInteger(count)) {
    throw new PayrollError('PAYROLL_INPUT_INVALID', 'A month offset is a whole number of months.');
  }
  const { year, monthNo } = parts(month);
  // Zero-based month arithmetic, so a negative offset wraps the same way a
  // positive one does. `(monthNo - 1) + count` can be negative, and `%` in
  // JavaScript keeps the sign of the dividend, so the floor is taken explicitly.
  const total = year * 12 + (monthNo - 1) + count;
  const nextYear = Math.floor(total / 12);
  const nextMonth = total - nextYear * 12 + 1;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}` as PayrollMonth;
}

/** Negative when `a` is earlier. Months sort lexicographically, but this says so. */
export function compareMonths(a: PayrollMonth, b: PayrollMonth): -1 | 0 | 1 {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** How many days the month has, without constructing a `Date`. */
export function daysInMonth(month: PayrollMonth): number {
  const { year, monthNo } = parts(month);
  if (monthNo === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(monthNo) ? 30 : 31;
}

/** Every calendar date in the month, in order, as Asia/Dhaka calendar dates. */
export function monthDays(month: PayrollMonth): IsoDate[] {
  const days: IsoDate[] = [];
  for (let day = 1; day <= daysInMonth(month); day += 1) {
    days.push(toIsoDate(`${month}-${String(day).padStart(2, '0')}`));
  }
  return days;
}

/** The month an Asia/Dhaka calendar date falls in. */
export function monthOf(date: IsoDate): PayrollMonth {
  return date.slice(0, 7) as PayrollMonth;
}

/**
 * The day of the week, 0 = Sunday, computed from the date string.
 *
 * `Date.getUTCDay()` on a `YYYY-MM-DD` parsed as UTC midnight is safe — the
 * weekday of a calendar date is a property of the date, not of a timezone — but
 * `getDay()` on the same value is not, because in a UTC−06:00 process it reports
 * the previous day. Spelled out here so no screen has to remember which.
 */
export function weekdayOf(date: IsoDate): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}
