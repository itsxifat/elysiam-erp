/**
 * Business-date arithmetic for the money screens (invariant 8).
 *
 * Every date here is an Asia/Dhaka calendar date as `YYYY-MM-DD`, and every
 * calculation is on the calendar, never on instants: a month is its first to its
 * last day, whatever the laptop's time zone or the daylight rules of the city it
 * happens to be in. `Date.UTC` is used only as a calendar, never as a clock.
 */

export type IsoDate = string;

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  // Round-trip, so 2026-02-30 is refused rather than silently rolled into March.
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isMonth(value: unknown): value is string {
  return typeof value === 'string' && MONTH.test(value);
}

function iso(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

/** The first and last calendar day of a `YYYY-MM` month. */
export function monthRange(month: string): { from: IsoDate; to: IsoDate } {
  if (!MONTH.test(month)) throw new RangeError(`Not a month: ${month}`);
  const [year, index] = month.split('-').map(Number) as [number, number];
  return {
    from: iso(new Date(Date.UTC(year, index - 1, 1))),
    to: iso(new Date(Date.UTC(year, index, 0))),
  };
}

export function monthOf(date: IsoDate): string {
  return date.slice(0, 7);
}

export function previousMonth(month: string): string {
  const [year, index] = month.split('-').map(Number) as [number, number];
  return iso(new Date(Date.UTC(year, index - 2, 1))).slice(0, 7);
}

export type RangePreset = 'today' | 'thisMonth' | 'lastMonth' | 'thisYear';

/** A named range, ending no later than `today`. */
export function presetRange(preset: RangePreset, today: IsoDate): { from: IsoDate; to: IsoDate } {
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'thisMonth':
      return { from: `${monthOf(today)}-01`, to: today };
    case 'lastMonth':
      return monthRange(previousMonth(monthOf(today)));
    case 'thisYear':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

/**
 * A `from`/`to` pair out of a URL, falling back to this month when either is
 * missing, malformed or reversed. A link somebody edited by hand opens a sensible
 * report rather than an error page.
 */
export function rangeFrom(
  search: { readonly from?: unknown; readonly to?: unknown },
  today: IsoDate,
): { from: IsoDate; to: IsoDate } {
  const { from, to } = search;
  if (isIsoDate(from) && isIsoDate(to) && from <= to) return { from, to };
  return presetRange('thisMonth', today);
}

/** An as-of date out of a URL, falling back to today. */
export function asOfFrom(search: { readonly asOf?: unknown }, today: IsoDate): IsoDate {
  return isIsoDate(search.asOf) ? search.asOf : today;
}
