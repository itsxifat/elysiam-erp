import { BUSINESS_TIME_ZONE, businessDate, isIsoDate, type IsoDate } from '@elysium/domain';

import { localiseDigits } from './digits.js';
import { DEFAULT_LOCALE, type Locale } from './locale.js';

/**
 * Dates for people to read, in the Asia/Dhaka business calendar (invariant 8).
 *
 * The *definition* of a business date lives in `@elysium/domain/dates` and is
 * not duplicated here: `businessDate` is re-exported below rather than
 * reimplemented, because two implementations of "which day is it in Dhaka"
 * would eventually disagree at 23:30 UTC, and the one that disagreed would be
 * whichever one the invoice used. What this module adds is presentation —
 * month names, digit script, field order — which is an i18n concern and has no
 * business being in the domain.
 *
 * The arithmetic (`addDays`, `periodForMonth`) is deliberately *not*
 * re-exported. Code that needs to reason about dates should depend on the
 * domain directly; code that needs to print one depends on this. Re-exporting
 * both would make this package a second front door to the domain, and the next
 * person would not know which one is canonical.
 *
 * ## Why not `Intl.DateTimeFormat` for the whole job
 *
 * Two reasons, both bugs we would rather not ship:
 *
 * 1. A calendar date is zoneless. `new Date('2026-09-17')` is UTC midnight, so
 *    handing it to a formatter in a negative-offset zone prints the 16th. An
 *    invoice dated a day early is the kind of error a customer notices and an
 *    accountant cannot explain. The `YYYY-MM-DD` path below never constructs a
 *    `Date` at all — it splits the string.
 * 2. Bangla output from ICU depends on which CLDR the runtime shipped: month
 *    spelling and the default numbering system have both changed between
 *    versions. A document whose shape depends on a Node upgrade is not a
 *    document, so the month names are a table here and the digits come from
 *    `localiseDigits`.
 *
 * `Intl` is still used for the one thing it is irreplaceable for: converting an
 * instant to Dhaka wall-clock parts, which needs the zone database.
 */

export { BUSINESS_TIME_ZONE, businessDate, type IsoDate };

/** `long` for documents, `short` for tables, `numeric` for dense operator UI. */
export type DateStyle = 'long' | 'short' | 'numeric';

export interface FormatDateOptions {
  readonly locale?: Locale;
  readonly style?: DateStyle;
}

const MONTHS: Record<Locale, Record<'long' | 'short', readonly string[]>> = {
  en: {
    long: [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ],
    short: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  },
  bn: {
    long: [
      'জানুয়ারি',
      'ফেব্রুয়ারি',
      'মার্চ',
      'এপ্রিল',
      'মে',
      'জুন',
      'জুলাই',
      'আগস্ট',
      'সেপ্টেম্বর',
      'অক্টোবর',
      'নভেম্বর',
      'ডিসেম্বর',
    ],
    // Bangladeshi Bangla abbreviates these in print; the console's tables need
    // the width and the invoice uses the long form regardless.
    short: [
      'জানু',
      'ফেব্রু',
      'মার্চ',
      'এপ্রিল',
      'মে',
      'জুন',
      'জুলাই',
      'আগস্ট',
      'সেপ্টে',
      'অক্টো',
      'নভে',
      'ডিসে',
    ],
  },
};

/**
 * Dhaka wall-clock parts of an instant.
 *
 * `hourCycle: 'h23'` rather than `hour12: false`, which is not the same thing:
 * with `hour12: false` several ICU versions render midnight as `24:00`, so a
 * 00:10 order looks like it was placed at the end of the previous day. `h23`
 * pins it to `00`.
 */
const wallClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const ISO_MONTH = /^(2\d{3})-(0[1-9]|1[0-2])$/;

/** Today's business date — the Asia/Dhaka calendar date right now. */
export function today(now: Date = new Date()): IsoDate {
  return businessDate(now);
}

/**
 * A calendar date for a human: `formatDate('2026-09-17')` → `17 Sep 2026`.
 *
 * Bangladesh writes day before month, in both languages and in every style, so
 * there is no per-locale field order to get wrong. `numeric` gives
 * `17/09/2026`.
 */
export function formatDate(date: string, options: FormatDateOptions = {}): string {
  if (!isIsoDate(date)) throw new RangeError(`"${date}" is not a YYYY-MM-DD date.`);
  const locale = options.locale ?? DEFAULT_LOCALE;
  const style = options.style ?? 'short';
  const [year = '', month = '', day = ''] = date.split('-');

  if (style === 'numeric') return localiseDigits(`${day}/${month}/${year}`, locale);

  const name = MONTHS[locale][style][Number(month) - 1] ?? month;
  // The day is unpadded in prose — "7 Sep 2026", not "07 Sep 2026" — because
  // the leading zero reads as a form field rather than a sentence.
  return localiseDigits(`${String(Number(day))} ${name} ${year}`, locale);
}

/**
 * A month for a human: `formatMonth('2026-09')` → `Sep 2026`.
 *
 * Takes the `YYYY-MM` that `Period.month` carries, so a period heading and a
 * ledger filter cannot disagree about which month they are showing.
 */
export function formatMonth(month: string, options: FormatDateOptions = {}): string {
  if (!ISO_MONTH.test(month)) throw new RangeError(`"${month}" is not a YYYY-MM month.`);
  const locale = options.locale ?? DEFAULT_LOCALE;
  const style = options.style ?? 'short';
  const [year = '', index = ''] = month.split('-');

  if (style === 'numeric') return localiseDigits(`${index}/${year}`, locale);
  return localiseDigits(`${MONTHS[locale][style][Number(index) - 1] ?? index} ${year}`, locale);
}

/**
 * The Dhaka wall-clock time of an instant, 24-hour: `17:30`.
 *
 * 24-hour in both locales on purpose. Bangla has no single am/pm pair — the
 * time of day picks the word (সকাল, দুপুর, বিকাল, রাত) — so a naive
 * `am`/`pm` mapping produces text that reads wrong to a native speaker, and a
 * correct mapping needs rules that belong nowhere near a formatter. Operators
 * also read these in columns, where a fixed five characters beats a variable
 * seven.
 */
export function formatTime(instant: Date, locale: Locale = DEFAULT_LOCALE): string {
  if (Number.isNaN(instant.getTime())) throw new RangeError('Not a valid instant.');
  return localiseDigits(wallClock.format(instant), locale);
}

/**
 * An instant as a Dhaka date and time: `17 Sep 2026, 17:30`.
 *
 * The date part is the *business* date of the instant, not its UTC date, so an
 * order placed at 23:30 UTC on the 1st shows as the 2nd — the same day the day
 * book, the period and the courier manifest will put it in.
 */
export function formatDateTime(instant: Date, options: FormatDateOptions = {}): string {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const date = formatDate(businessDate(instant), options);
  return `${date}, ${formatTime(instant, locale)}`;
}
