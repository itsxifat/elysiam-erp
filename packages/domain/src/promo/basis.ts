import { allocate, poisha, type Poisha } from '../money/index.js';

/**
 * What a code is priced on: each line's net, after the agent's own order discount.
 *
 * A code's percentage, its minimum order and its scope are all about what the buyer is
 * paying for. An order discount the agent typed is part of that — leave it out and a 10%
 * code on a ৳10,000 basket the agent has already brought down to ৳1,500 gives ৳1,000 off
 * instead of ৳150, and clears a minimum the buyer never reached (ledger audit W3).
 *
 * The order discount is spread across the lines in proportion to their nets, through
 * `allocate`, so the parts add up to it exactly and a line scoped out of the code carries
 * its own share rather than leaving it on the lines the code covers. A discount larger
 * than the basket is clamped to the basket here; the order's own totals refuse it later,
 * with their own error.
 */
export interface BasisLine {
  readonly skuId: string;
  readonly netPoisha: Poisha;
}

export function promoBasis(lines: readonly BasisLine[], orderDiscountPoisha: Poisha): BasisLine[] {
  if (orderDiscountPoisha < 0n) throw new RangeError('An order discount is never negative.');
  const total = lines.reduce((sum, line) => sum + line.netPoisha, 0n);
  if (orderDiscountPoisha === 0n || total === 0n) return lines.map((line) => ({ ...line }));

  const discount = orderDiscountPoisha > total ? total : orderDiscountPoisha;
  const shares = allocate(
    poisha(discount),
    lines.map((line) => line.netPoisha),
  );
  return lines.map((line, index) => ({
    skuId: line.skuId,
    netPoisha: poisha(line.netPoisha - (shares[index] ?? 0n)),
  }));
}
