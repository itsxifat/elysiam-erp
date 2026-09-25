import { groupSouthAsian, localiseDigits } from './digits.js';
import type { Locale } from './locale.js';

/**
 * Money for people to read (architecture §7, §24).
 *
 * Amounts are integer poisha everywhere (invariant 1), so this takes poisha
 * and never a taka float. It works in `bigint` digits end to end — no
 * division, no `toFixed` — so a 9e15-poisha consolidated total renders
 * exactly, which a `number` could not promise.
 *
 * Grouping is South Asian: the last three digits, then pairs, so ten million
 * poisha is `৳1,00,000.00` (one lakh taka) and a crore is `৳1,00,00,000.00`.
 */

export interface FormatMoneyOptions {
  /** `bn` renders Bangla digits. Defaults to Latin digits, as the console does (D-036). */
  readonly locale?: Locale;
  /** Omit the ৳ sign, for table cells whose header already names the currency. */
  readonly symbol?: boolean;
}

function toPoisha(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`formatMoney needs whole poisha, received ${String(value)}.`);
    }
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value)) {
    throw new RangeError(`formatMoney needs whole poisha, received "${value}".`);
  }
  return BigInt(value);
}

/**
 * `formatMoney(12345678)` → `৳1,23,456.78`.
 *
 * Accepts poisha as a `bigint` (a `Poisha` is one), a safe-integer `number`,
 * or an integer string straight off the wire. Anything fractional is refused:
 * a fraction of a poisha means a float got in upstream, and printing it
 * rounded would hide where.
 */
export function formatMoney(
  value: bigint | number | string,
  options: FormatMoneyOptions = {},
): string {
  const amount = toPoisha(value);
  const negative = amount < 0n;
  const magnitude = negative ? 0n - amount : amount;

  const whole = groupSouthAsian((magnitude / 100n).toString());
  const fraction = (magnitude % 100n).toString().padStart(2, '0');
  const symbol = options.symbol === false ? '' : '৳';
  const text = `${negative ? '-' : ''}${symbol}${whole}.${fraction}`;

  return localiseDigits(text, options.locale ?? 'en');
}
