/**
 * Money (architecture §7, invariant 1).
 *
 * Every amount in the system is an integer number of poisha (1 taka = 100
 * poisha). This module is the only place allowed to round, divide or parse
 * money; the `elysium/no-float-money` lint rule bans `toFixed` and
 * `parseFloat` everywhere else.
 *
 * `Poisha` is a branded `bigint`, not a `number` (D-079). §7 describes "a
 * branded integer, safe up to 9e15"; a `number` is exact only up to 2^53, and
 * a sum across five brands' trial balances is exactly where an inexact
 * integer would be silent. A bigint is exact at every size, so the limit
 * below is a sanity bound rather than a precision one — it matches §7's 9e15
 * and sits comfortably inside PostgreSQL's `bigint`.
 */

declare const POISHA_BRAND: unique symbol;

/** An integer amount of poisha. Construct with `poisha()`; never cast. */
export type Poisha = bigint & { readonly [POISHA_BRAND]: true };

/** ±9e15 poisha (90 trillion taka). Beyond this, something is wrong upstream. */
export const MAX_POISHA = 9_000_000_000_000_000n;

export const ZERO = 0n as Poisha;

/** Thrown for any amount that is not a safe integer number of poisha. */
export class MoneyError extends Error {
  constructor(
    message: string,
    readonly code: 'MONEY_INVALID' | 'MONEY_OVERFLOW' = 'MONEY_INVALID',
  ) {
    super(message);
    this.name = 'MoneyError';
  }
}

function checked(value: bigint): Poisha {
  if (value > MAX_POISHA || value < -MAX_POISHA) {
    throw new MoneyError(
      `${value.toString()} poisha is outside ±${MAX_POISHA.toString()}.`,
      'MONEY_OVERFLOW',
    );
  }
  return value as Poisha;
}

const INTEGER_STRING = /^-?\d{1,19}$/;

/**
 * An amount of poisha from a bigint, a safe-integer number, or an integer
 * string (which is how amounts cross the wire, D-078's schemas).
 *
 * A fractional number, `NaN`, or a number beyond 2^53 is refused rather than
 * rounded: whoever produced it has already lost precision, and rounding here
 * would hide where.
 */
export function poisha(value: bigint | number | string): Poisha {
  if (typeof value === 'bigint') return checked(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new MoneyError(`${String(value)} is not a whole, safe number of poisha.`);
    }
    return checked(BigInt(value));
  }
  if (!INTEGER_STRING.test(value)) {
    throw new MoneyError(`"${value}" is not an integer number of poisha.`);
  }
  return checked(BigInt(value));
}

export function isPoisha(value: unknown): value is Poisha {
  return typeof value === 'bigint' && value <= MAX_POISHA && value >= -MAX_POISHA;
}

export function add(a: Poisha, b: Poisha): Poisha {
  return checked(a + b);
}

export function sub(a: Poisha, b: Poisha): Poisha {
  return checked(a - b);
}

export function negate(a: Poisha): Poisha {
  return checked(0n - a);
}

export function abs(a: Poisha): Poisha {
  return a < 0n ? checked(0n - a) : a;
}

export function sum(values: Iterable<Poisha>): Poisha {
  let total = 0n;
  for (const value of values) {
    total += value;
    // Checked as it goes, so an intermediate overflow cannot be cancelled out
    // by a later negative and slip past.
    checked(total);
  }
  return total as Poisha;
}

export function compare(a: Poisha, b: Poisha): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toBigInt(value: bigint | number, what: string): bigint {
  if (typeof value === 'bigint') return value;
  if (!Number.isSafeInteger(value)) throw new MoneyError(`${what} must be a whole number.`);
  return BigInt(value);
}

/** Unit price × quantity. Quantities are whole units (§8). */
export function mulQty(unit: Poisha, quantity: bigint | number): Poisha {
  return checked(unit * toBigInt(quantity, 'A quantity'));
}

/**
 * `numerator / denominator`, rounded half away from zero.
 *
 * The single rounding primitive: `percentOf` and anything later that needs a
 * ratio goes through here, so there is exactly one rounding rule in the
 * system. Half away from zero means 2.5 → 3 and −2.5 → −3: a refund rounds
 * the same way as the charge it refunds.
 */
export function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new MoneyError('Division by zero.');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const remainder = n % d;
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** 10,000 basis points = 100%. */
export const BASIS_POINTS = 10_000n;

/**
 * `basisPoints` / 10,000 of an amount, half away from zero, in whole poisha.
 *
 * Basis points rather than a percentage so that 2.5% is the integer 250 and
 * no caller ever writes `0.025`.
 */
export function percentOf(amount: Poisha, basisPoints: bigint | number): Poisha {
  return checked(divideRounded(amount * toBigInt(basisPoints, 'Basis points'), BASIS_POINTS));
}

/**
 * `numerator / denominator` poisha, rounded half away from zero to **whole taka** (M35b,
 * D-550).
 *
 * The old website priced its landing-page offers in whole taka: a percentage off ৳1,290 was
 * rounded to the taka before the shopper saw it. The port keeps that, through the one rounding
 * rule: the exact ratio in poisha, divided by 100 and rounded once.
 */
export function roundedToTaka(numerator: bigint, denominator: bigint): Poisha {
  return checked(divideRounded(numerator, denominator * 100n) * 100n);
}

/**
 * Split `total` in proportion to `weights`, so the parts sum to `total`
 * exactly (largest-remainder method).
 *
 * Each part first gets the floor of its exact share. The poisha left over go,
 * one each, to the parts with the largest fractional remainders; ties go to
 * the earlier part, so the result is deterministic. A negative total is split
 * as its magnitude and negated, so a refund splits exactly like the charge.
 */
export function allocate(total: Poisha, weights: readonly (bigint | number)[]): Poisha[] {
  if (weights.length === 0) throw new MoneyError('Cannot allocate across zero parts.');
  const w = weights.map((weight) => {
    const value = toBigInt(weight, 'A weight');
    if (value < 0n) throw new MoneyError('Weights cannot be negative.');
    return value;
  });
  const weightSum = w.reduce((acc, value) => acc + value, 0n);
  if (weightSum === 0n) throw new MoneyError('Weights must not all be zero.');

  const negative = total < 0n;
  const magnitude = negative ? 0n - total : total;

  const parts = w.map((weight) => (magnitude * weight) / weightSum);
  const remainders = w.map((weight, index) => ({
    index,
    remainder: (magnitude * weight) % weightSum,
  }));

  let leftover = magnitude - parts.reduce((acc, value) => acc + value, 0n);
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const { index } of remainders) {
    if (leftover === 0n) break;
    parts[index] = (parts[index] ?? 0n) + 1n;
    leftover -= 1n;
  }

  return parts.map((part) => checked(negative ? -part : part));
}

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

/** Bangla digits to ASCII, so `৳১,২৩৪.৫০` parses like `৳1,234.50`. */
function asciiDigits(input: string): string {
  let result = '';
  for (const char of input) {
    const index = BANGLA_DIGITS.indexOf(char);
    result += index >= 0 ? String(index) : char;
  }
  return result;
}

/**
 * Optional minus, optional currency mark, then whole taka written plainly
 * (`123456`), in lakh/crore groups (`1,23,456`) or in thousands (`123,456`),
 * then up to two decimals.
 */
const TAKA_PATTERN =
  /^(-)?(?:৳|tk\.?|bdt)?\s*(\d{1,2}(?:,\d{2})*,\d{3}|\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/i;

/**
 * Parse a taka amount a person typed: `1234.5`, `1,23,456.78`, `৳500`,
 * `Tk 20`, `-৳3.25`, Bangla digits too. Returns poisha.
 *
 * Refuses more than two decimals rather than rounding — `12.345` taka is a
 * typo or a computation that already went through a float, and either way the
 * right answer is to ask, not to guess.
 */
export function parseTaka(input: string): Poisha {
  const trimmed = asciiDigits(input.trim()).replace(/\s+/g, ' ');
  const match = TAKA_PATTERN.exec(trimmed);
  if (match === null) throw new MoneyError(`"${input}" is not a taka amount.`);

  const [, sign, whole = '0', fraction = ''] = match;
  const wholeDigits = whole.replace(/,/g, '');
  const poishaDigits = `${wholeDigits}${fraction.padEnd(2, '0')}`;
  const value = BigInt(poishaDigits);
  return checked(sign === '-' ? -value : value);
}

/** Parse an integer poisha string from the API (`"12345678"`). */
export function parsePoisha(input: string): Poisha {
  return poisha(input);
}

/** Split into sign, whole taka and poisha, for formatters. */
export function takaParts(amount: Poisha): {
  readonly negative: boolean;
  readonly taka: bigint;
  readonly poisha: bigint;
} {
  const negative = amount < 0n;
  const magnitude = negative ? 0n - amount : amount;
  return { negative, taka: magnitude / 100n, poisha: magnitude % 100n };
}

/**
 * `Tk 1,100.00`: an amount for a sentence a person reads, such as an approval's reason
 * (m30-followups). Thousands grouped in threes and always two decimals, so it cannot be
 * misread by a factor of a hundred the way a bare poisha figure can. Screens use `<Money>`.
 */
export function takaText(amount: Poisha): string {
  const { negative, taka, poisha: paisa } = takaParts(amount);
  const grouped = taka.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}Tk ${grouped}.${paisa.toString().padStart(2, '0')}`;
}

/**
 * A plain decimal amount in major units — `"5339.5"`, `"12.345"` — as poisha, rounded half
 * away from zero to the poisha (M18).
 *
 * For figures another system computed, never for what a person typed (`parseTaka` refuses
 * a third decimal, because a person who typed one made a mistake). Meta's Insights API
 * reports `spend` as a "numeric string" with whatever precision its estimate has, and the
 * only honest thing to do with a third decimal there is to round it once, here, by the
 * system's one rounding rule. Signs, exponents, grouping and currency marks are refused:
 * none of them is a numeric string an API should send.
 */
export function decimalToPoisha(input: string): Poisha {
  const match = /^(\d{1,16})(?:\.(\d{1,12}))?$/.exec(input.trim());
  if (match === null) throw new MoneyError(`"${input}" is not a plain decimal amount.`);
  const [, whole = '0', fraction = ''] = match;
  const scale = 10n ** BigInt(fraction.length);
  const scaled = BigInt(`${whole}${fraction}`);
  // `scaled / scale` is the amount in major units; ×100 for poisha, then round once.
  return checked(divideRounded(scaled * 100n, scale));
}

/**
 * Poisha as a JSON number of major units, for an API that types money as a float (M18).
 *
 * Meta's Conversions API takes `custom_data.value` as a number, so the amount has to
 * leave as one. It is built from the exact decimal text (`"1234.50"` → 1234.5), never by
 * dividing a float, and refused at 10^15 poisha (ten trillion taka) or more. Below that the
 * amount has at most 15 significant digits, and every such decimal has a double whose
 * shortest decimal form is exactly that amount (15 is the digits a double always keeps),
 * which is what `JSON.stringify` writes. Nothing inside the system reads the result back
 * as money.
 */
const MAJOR_NUMBER_LIMIT = 1_000_000_000_000_000n;

export function poishaToMajorNumber(amount: Poisha): number {
  if (amount >= MAJOR_NUMBER_LIMIT || amount <= -MAJOR_NUMBER_LIMIT) {
    throw new MoneyError('That amount is too large to send as a number.', 'MONEY_OVERFLOW');
  }
  const { negative, taka, poisha: rest } = takaParts(amount);
  return Number(`${negative ? '-' : ''}${taka.toString()}.${rest.toString().padStart(2, '0')}`);
}

/**
 * The sum of several plain decimal amounts, as poisha, rounded once (M18).
 *
 * Summed exactly before rounding, so twenty ad-level spend figures for one campaign's day
 * round to the same poisha as the campaign's own total would — rounding each and adding
 * could drift by up to half a poisha per row.
 */
export function sumDecimalsToPoisha(inputs: readonly string[]): Poisha {
  const SCALE_DIGITS = 12;
  let total = 0n;
  for (const input of inputs) {
    const match = /^(\d{1,16})(?:\.(\d{1,12}))?$/.exec(input.trim());
    if (match === null) throw new MoneyError(`"${input}" is not a plain decimal amount.`);
    const [, whole = '0', fraction = ''] = match;
    total += BigInt(`${whole}${fraction.padEnd(SCALE_DIGITS, '0')}`);
  }
  return checked(divideRounded(total * 100n, 10n ** BigInt(SCALE_DIGITS)));
}
