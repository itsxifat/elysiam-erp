import type { Locale } from './locale.js';

/**
 * Digits and grouping, in one place.
 *
 * Money, dates, quantities and invoice numbers all have to render the same
 * digits, and they used to have their own copies: `formatMoney` carried a
 * Bangla digit table and the date helpers would have carried a second one. Two
 * tables is one table that can be wrong — a customer reading `৳১,২০০.০০` next
 * to `17 সেপ্টেম্বর 2026` sees a document that looks half-translated, and
 * nothing in the build would have complained.
 *
 * `Intl` is deliberately not used for this. Its Bangla numbering system comes
 * from whatever ICU the runtime shipped, so the same invoice could render Latin
 * digits on one Node version and Bangla on the next. A document that changes
 * shape on a runtime upgrade is not a document.
 */

const BANGLA_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'] as const;

/** Latin `0-9` → Bangla digits, for `bn` only. Anything else is returned as is. */
export function localiseDigits(text: string, locale: Locale): string {
  if (locale !== 'bn') return text;
  return text.replace(/\d/g, (digit) => BANGLA_DIGITS[Number(digit)] ?? digit);
}

/**
 * South Asian grouping of a string of digits: last three, then pairs.
 *
 * `10000000` → `1,00,00,000` — one crore, the way every Bangladeshi ledger,
 * bank statement and price tag writes it. Western thousands grouping here would
 * be read wrong at a glance by the people who use this system all day.
 *
 * Takes and returns digit strings rather than numbers so a `bigint` poisha
 * total passes through without ever becoming a float (invariant 1).
 */
export function groupSouthAsian(digits: string): string {
  if (digits.length <= 3) return digits;
  const lastThree = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const pairs: string[] = [];
  while (rest.length > 2) {
    pairs.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length > 0) pairs.unshift(rest);
  return `${pairs.join(',')},${lastThree}`;
}

/**
 * A whole count for people to read: `formatCount(1200)` → `1,200`.
 *
 * Quantities, not money — money goes through `formatMoney`, which knows about
 * poisha. Refuses a fractional value because every count in this system is a
 * whole thing (pieces, orders, days), and a fraction means a division happened
 * upstream that nobody meant.
 */
export function formatCount(value: bigint | number, locale: Locale = 'en'): string {
  if (typeof value === 'number' && !Number.isInteger(value)) {
    throw new RangeError(`formatCount needs a whole number, received ${String(value)}.`);
  }
  const negative = value < 0;
  const magnitude = (negative ? -value : value).toString();
  return localiseDigits(`${negative ? '-' : ''}${groupSouthAsian(magnitude)}`, locale);
}
