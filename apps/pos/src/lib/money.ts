/**
 * The till's money arithmetic, in integer poisha (invariant 1).
 *
 * The PWA does not depend on `@elysium/domain` at runtime (D-167), so the two
 * operations the till needs are restated here, bigint-only, and `cart.test.ts`
 * proves them equal to the domain's own `percentOf` and `maxDiscountFor` over
 * thousands of inputs. The
 * server recomputes everything anyway; what this must get right is that the figure
 * the customer sees on the receipt is the figure the server will accept.
 */

/** `numerator / denominator`, rounded half away from zero — the domain's one rule. */
export function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('Division by zero.');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const rounded = (n % d) * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** `bps` / 10,000 of an amount, as the server's `percentOf` computes it. */
export function percentOf(amountPoisha: bigint, bps: number): bigint {
  if (!Number.isSafeInteger(bps)) throw new RangeError('Basis points are a whole number.');
  return divideRounded(amountPoisha * BigInt(bps), 10_000n);
}

/** The largest discount a ceiling allows on a line (the server's `maxDiscountFor`). */
export function maxDiscountFor(grossPoisha: bigint, ceilingBps: number): bigint {
  return percentOf(grossPoisha, Math.max(0, Math.min(10_000, ceilingBps)));
}

/** "12.5" typed as a percentage, to basis points — never through a float. */
export function percentToBps(input: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (match === null) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bps > 10_000 ? null : bps;
}

/** Integer poisha to the decimal string the wire carries. */
export function wire(poisha: bigint): string {
  return poisha.toString();
}

/**
 * What returning `qty` more units of a line refunds, when `returned` have already
 * come back: `share(returned + qty) − share(returned)` of the line's net.
 *
 * The server's `refundFor` (`packages/domain/src/pos/returns.ts`), restated: the
 * difference of two cumulative rounded shares, so partial returns sum to the line
 * exactly whatever order the units come back in.
 */
export function refundForUnits(
  netPoisha: bigint,
  lineQty: number,
  returned: number,
  qty: number,
): bigint {
  const share = (units: number) => divideRounded(netPoisha * BigInt(units), BigInt(lineQty));
  return share(returned + qty) - share(returned);
}
