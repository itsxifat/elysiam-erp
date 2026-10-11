import type { Locale } from './locale.js';

/**
 * Digits and grouping, in one place.
 *
 * Money, dates, quantities and invoice numbers all render the same Latin digits
 * with the same grouping, so the grouping lives here once: two copies is one
 * copy that can be wrong.
 *
 * `Intl` is deliberately not used for this. Its grouping comes from whatever ICU
 * the runtime shipped, so the same figure could group differently on one Node
 * version and the next. A screen that changes shape on a runtime upgrade is a
 * screen nobody can write a test for.
 */

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
 * upstream that nobody meant. The locale argument is the one locale (D-750),
 * kept so call sites that pass the screen's locale need not change.
 */
export function formatCount(value: bigint | number, _locale?: Locale): string {
  if (typeof value === 'number' && !Number.isInteger(value)) {
    throw new RangeError(`formatCount needs a whole number, received ${String(value)}.`);
  }
  const negative = value < 0;
  const magnitude = (negative ? -value : value).toString();
  return `${negative ? '-' : ''}${groupSouthAsian(magnitude)}`;
}
