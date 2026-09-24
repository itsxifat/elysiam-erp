/**
 * Business dates (architecture §7 "Periods and dates", invariant 8).
 *
 * A business date is the Asia/Dhaka calendar date of the moment the business
 * event happened — not the server's date, not UTC's date, and not the date
 * the code happens to run. A cash sale rung up at 05:30 on the 2nd in Dhaka
 * is 23:30 UTC on the 1st, and it belongs to the 2nd's day book and, on the
 * last day of a month, to the next month's period.
 *
 * Computed with the platform's IANA zone data rather than a fixed +06:00, so
 * that if Bangladesh ever reintroduces daylight saving (it did in 2009) the
 * zone database is what changes, not this code.
 */

export const BUSINESS_TIME_ZONE = 'Asia/Dhaka';

/** `YYYY-MM-DD`. A calendar date with no time and no zone. */
export type IsoDate = string & { readonly __isoDate: true };

/** Years 2000-2999 only: `Date.UTC` silently maps 0000-0099 into the 1900s. */
const ISO_DATE = /^(2\d{3})-(\d{2})-(\d{2})$/;

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Asia/Dhaka calendar date of an instant. */
export function businessDate(instant: Date): IsoDate {
  if (Number.isNaN(instant.getTime())) throw new RangeError('Not a valid instant.');
  const parts = formatter.formatToParts(instant);
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}` as IsoDate;
}

/** Is this a real `YYYY-MM-DD` calendar date (no 2026-02-30)? */
export function isIsoDate(value: string): value is IsoDate {
  const match = ISO_DATE.exec(value);
  if (match === null) return false;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d)
  );
}

export function toIsoDate(value: string): IsoDate {
  if (!isIsoDate(value)) throw new RangeError(`"${value}" is not a YYYY-MM-DD date.`);
  return value;
}

/** Calendar arithmetic on a date, independent of any time zone. */
export function addDays(date: IsoDate, days: number): IsoDate {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days));
  return next.toISOString().slice(0, 10) as IsoDate;
}

/** A monthly accounting period (§7: periods close monthly). */
export interface Period {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly startsOn: IsoDate;
  readonly endsOn: IsoDate;
}

const MONTH = /^(2\d{3})-(0[1-9]|1[0-2])$/;

/** The period `YYYY-MM`. */
export function periodForMonth(month: string): Period {
  const match = MONTH.exec(month);
  if (match === null) throw new RangeError(`"${month}" is not a YYYY-MM month.`);
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  const startsOn = new Date(Date.UTC(year, index, 1)).toISOString().slice(0, 10) as IsoDate;
  const endsOn = new Date(Date.UTC(year, index + 1, 0)).toISOString().slice(0, 10) as IsoDate;
  return { month, startsOn, endsOn };
}

/** The period a business date falls in. */
export function periodOf(date: IsoDate): Period {
  return periodForMonth(date.slice(0, 7));
}

export function isMonth(value: string): boolean {
  return MONTH.test(value);
}
