import type { IsoDate } from '../dates/index.js';

/**
 * Birthdays and anniversaries (architecture §10, M16 check 2): who has one today.
 *
 * Month and day only; the year a buyer was born is not ours to keep acting on. A
 * 29 February falls on 28 February in a year without one, so a leap-day buyer is
 * greeted every year rather than one year in four.
 *
 * "At most once per customer per occasion per year" is not decided here: the job
 * records each issue under a unique (customer, occasion, year), so a second run of
 * the same day finds the row and does nothing.
 */

export type Occasion = 'birthday' | 'anniversary';

/**
 * A buyer's dates as stored, `YYYY-MM-DD`. Plain strings, not `IsoDate`: that type
 * is for business dates and starts in 2000, and people were born before it.
 */
export interface OccasionDates {
  readonly customerId: string;
  readonly birthday: string | null;
  readonly anniversary: string | null;
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Whether a stored date's month and day fall on `today`. */
export function fallsOn(date: string, today: IsoDate): boolean {
  if (!CALENDAR_DATE.test(date)) return false;
  const monthDay = date.slice(5);
  const todayMonthDay = today.slice(5);
  if (monthDay === todayMonthDay) return true;
  const year = Number(today.slice(0, 4));
  return monthDay === '02-29' && todayMonthDay === '02-28' && !isLeapYear(year);
}

export interface DueOccasion {
  readonly customerId: string;
  readonly occasion: Occasion;
  readonly year: number;
}

export function dueOccasions(buyers: readonly OccasionDates[], today: IsoDate): DueOccasion[] {
  const year = Number(today.slice(0, 4));
  const due: DueOccasion[] = [];
  for (const buyer of buyers) {
    if (buyer.birthday !== null && fallsOn(buyer.birthday, today)) {
      due.push({ customerId: buyer.customerId, occasion: 'birthday', year });
    }
    if (buyer.anniversary !== null && fallsOn(buyer.anniversary, today)) {
      due.push({ customerId: buyer.customerId, occasion: 'anniversary', year });
    }
  }
  return due;
}
