import { poisha, takaText } from '@elysium/domain';

import { groupSouthAsian } from './digits.js';
import type { Locale } from './locale.js';

/**
 * Money on a staff screen (architecture §7, §24).
 *
 * Amounts are integer poisha everywhere (invariant 1), so this takes poisha
 * and never a taka float. It works in `bigint` digits end to end — no
 * division, no `toFixed` — so a 9e15-poisha consolidated total renders
 * exactly, which a `number` could not promise.
 *
 * Grouping is South Asian: the last three digits, then pairs, so ten million
 * poisha is `৳1,00,000.00` (one lakh taka) and a crore is `৳1,00,00,000.00`.
 *
 * Screens only (D-751). Everything printed or sent — invoices, slips, labels,
 * receipts, payslips, SMS, email — reads `Tk 1,250.00` through `takaText` in
 * `@elysium/domain`, so no Bangla-block character ever reaches paper or a phone.
 */

export interface FormatMoneyOptions {
  /** The one locale (D-750); accepted so a screen can pass its own. */
  readonly locale?: Locale;
  /** Omit the ৳ sign, for table cells whose header already names the currency. */
  readonly symbol?: boolean;
  /**
   * Drop ".00" from a whole-taka amount (৳8,440, not ৳8,440.00) for a KPI or a summary
   * figure (D-455). An amount with paisa keeps both digits, so nothing is ever rounded;
   * tables, ledgers and forms keep the default, full precision.
   */
  readonly trimWholePaisa?: boolean;
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
  const paisa = options.trimWholePaisa === true && fraction === '00' ? '' : `.${fraction}`;
  return `${negative ? '-' : ''}${symbol}${whole}${paisa}`;
}

/**
 * `formatMoneyText(125000)` → `Tk 1,250.00`: money on paper or in a message (D-751).
 *
 * The till's receipt and any other printed or sent amount in an app that renders it itself.
 * It is `takaText` from `@elysium/domain/money`, the one formatter every document, SMS and
 * email uses, reached from here so an app need not depend on the domain package for it.
 */
export function formatMoneyText(value: bigint | number | string): string {
  return takaText(poisha(toPoisha(value)));
}
