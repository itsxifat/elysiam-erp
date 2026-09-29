import { add, mulQty, percentOf, sub, sum, ZERO, type Poisha } from '../money/index.js';
import { PosError } from './errors.js';

/**
 * A showroom sale's arithmetic (architecture §14, invariant 1 and 11).
 *
 * The till works offline, so the client prices the cart itself and the server
 * prices it again when the sale arrives. Both sides must land on the same poisha,
 * and the only way two implementations agree to the poisha is if one of them is
 * this file and the other is checked against it. So the server never trusts a
 * total the client sent: it recomputes from the lines and refuses a payload whose
 * own totals disagree.
 *
 * **Discounts travel as poisha, never as percentages.** A percentage is a promise
 * to round later, and two roundings of the same percentage on two machines are
 * how a till ends up one poisha out every day. The cashier types a percentage; the
 * client turns it into poisha once, prints that on the receipt, and that figure is
 * what the customer paid and what the ledger records.
 */

export const TENDERS = ['cash', 'bkash', 'card'] as const;
/**
 * How the customer paid. §14: cash, bKash, and card — card settles to the bank,
 * so it posts to a `wallet_bank` account.
 */
export type Tender = (typeof TENDERS)[number];

export function isTender(value: string): value is Tender {
  return (TENDERS as readonly string[]).includes(value);
}

/**
 * The most units one line may carry. Far above any real basket; it exists so a
 * scanner that repeats a keystroke, or a tampered payload, cannot push a quantity
 * into the range where `qty × price` stops being a safe number of poisha.
 */
export const MAX_LINE_QTY = 9_999;

export interface SaleLineInput {
  readonly skuId: string;
  readonly qty: number;
  /** The selling price the till charged per unit, before any discount. */
  readonly unitPricePoisha: Poisha;
  /** The whole line's discount, in poisha. */
  readonly discountPoisha: Poisha;
}

export interface PricedLine extends SaleLineInput {
  readonly grossPoisha: Poisha;
  readonly netPoisha: Poisha;
}

export interface SaleTotals {
  readonly lines: readonly PricedLine[];
  readonly grossPoisha: Poisha;
  readonly discountPoisha: Poisha;
  readonly netPoisha: Poisha;
}

export function priceLines(lines: readonly SaleLineInput[]): SaleTotals {
  if (lines.length === 0) {
    throw new PosError('POS_SALE_INVALID', 'A sale has at least one line.');
  }
  const priced = lines.map((line): PricedLine => {
    if (!Number.isSafeInteger(line.qty) || line.qty <= 0 || line.qty > MAX_LINE_QTY) {
      throw new PosError('POS_SALE_INVALID', 'A line quantity is a whole number of units.');
    }
    if (line.unitPricePoisha < 0n) {
      throw new PosError('POS_SALE_INVALID', 'A unit price cannot be negative.');
    }
    const gross = mulQty(line.unitPricePoisha, line.qty);
    if (line.discountPoisha < 0n || line.discountPoisha > gross) {
      /*
       * A discount larger than the line would be a negative sale: the till paying
       * the customer to take the goods. A refund is a return, and returns have
       * their own document and their own journal.
       */
      throw new PosError('POS_SALE_INVALID', 'A line discount lies between zero and the line.');
    }
    return { ...line, grossPoisha: gross, netPoisha: sub(gross, line.discountPoisha) };
  });
  return {
    lines: priced,
    grossPoisha: sum(priced.map((line) => line.grossPoisha)),
    discountPoisha: sum(priced.map((line) => line.discountPoisha)),
    netPoisha: sum(priced.map((line) => line.netPoisha)),
  };
}

export interface TenderInput {
  readonly tender: Tender;
  /** What this tender pays towards the sale — never more than the sale. */
  readonly amountPoisha: Poisha;
}

export interface SettledTenders {
  readonly cashAppliedPoisha: Poisha;
  /** Cash handed over by the customer, which may exceed what the sale needed. */
  readonly cashReceivedPoisha: Poisha;
  readonly changePoisha: Poisha;
}

/**
 * Check that the tenders pay exactly the sale, and work out the change.
 *
 * Split payment is the reason this is a function (§14): ৳1,500 as ৳1,000 cash
 * and ৳500 bKash is two tenders summing to the net. Only cash gives change,
 * because change comes out of the drawer; a bKash transfer of more than the bill
 * is not "change", it is a refund, and the till has no business deciding that.
 *
 * Tenders are **amounts applied**, so they sum to the net exactly. The ledger
 * debits each wallet by what it actually kept — debiting hand cash with the
 * ৳1,000 note the customer offered, when ৳130 of it went straight back as change,
 * would make every till read ৳130 over at close.
 */
export function settleTenders(
  netPoisha: Poisha,
  tenders: readonly TenderInput[],
  cashReceivedPoisha: Poisha | null,
): SettledTenders {
  const seen = new Set<Tender>();
  for (const tender of tenders) {
    if (seen.has(tender.tender)) {
      throw new PosError('POS_SALE_INVALID', 'Each tender appears once on a sale.');
    }
    seen.add(tender.tender);
    if (tender.amountPoisha <= 0n) {
      throw new PosError('POS_SALE_INVALID', 'A tender pays a positive amount.');
    }
  }
  const paid = sum(tenders.map((tender) => tender.amountPoisha));
  if (paid !== netPoisha) {
    throw new PosError(
      'POS_SALE_INVALID',
      'The tenders must pay exactly the sale total — no more, no less.',
    );
  }

  const cashApplied = tenders.find((tender) => tender.tender === 'cash')?.amountPoisha ?? ZERO;
  const received = cashReceivedPoisha ?? cashApplied;
  if (cashApplied === 0n && received !== 0n) {
    throw new PosError('POS_SALE_INVALID', 'Cash was handed over on a sale not paid in cash.');
  }
  if (received < cashApplied) {
    throw new PosError('POS_SALE_INVALID', 'Less cash was handed over than the cash tender.');
  }
  return {
    cashAppliedPoisha: cashApplied,
    cashReceivedPoisha: received,
    changePoisha: sub(received, cashApplied),
  };
}

/**
 * The largest discount a ceiling allows on an amount.
 *
 * Rounded exactly as `percentOf` rounds, half away from zero, so a cashier who
 * types their own ceiling as a percentage lands on precisely the figure this
 * permits. An exact `discount × 10,000 ≤ gross × bps` comparison would refuse
 * that same entry whenever the rounding went up by a poisha — a ceiling nobody
 * could actually reach.
 */
export function maxDiscountFor(grossPoisha: Poisha, ceilingBps: number): Poisha {
  if (!Number.isSafeInteger(ceilingBps) || ceilingBps < 0 || ceilingBps > 10_000) {
    throw new PosError('POS_SALE_INVALID', 'A discount ceiling lies between 0 and 10,000 bps.');
  }
  return percentOf(grossPoisha, ceilingBps);
}

/**
 * Discount the customer actually got on a line, against the catalog price.
 *
 * Two ways to give a discount: type one, or charge less than the list price. The
 * second is the one a ceiling that only read the discount column would never
 * see — ring a ৳2,000 shirt up at ৳200 with "no discount" — so a price below the
 * catalog's counts towards the ceiling exactly like a typed discount. A price
 * above the catalog's is not a negative discount; it earns nothing back.
 */
export function effectiveLineDiscount(
  line: PricedLine,
  catalogUnitPricePoisha: Poisha | null,
): { readonly grossAtListPoisha: Poisha; readonly discountPoisha: Poisha } {
  if (catalogUnitPricePoisha === null || catalogUnitPricePoisha <= line.unitPricePoisha) {
    return { grossAtListPoisha: line.grossPoisha, discountPoisha: line.discountPoisha };
  }
  const atList = mulQty(catalogUnitPricePoisha, line.qty);
  return {
    grossAtListPoisha: atList,
    discountPoisha: add(sub(atList, line.grossPoisha), line.discountPoisha),
  };
}

/** Indexes of the lines whose effective discount exceeds the ceiling. */
export function linesAboveCeiling(
  lines: readonly PricedLine[],
  catalogPrices: readonly (Poisha | null)[],
  ceilingBps: number,
): number[] {
  const above: number[] = [];
  lines.forEach((line, index) => {
    const effective = effectiveLineDiscount(line, catalogPrices[index] ?? null);
    if (effective.discountPoisha > maxDiscountFor(effective.grossAtListPoisha, ceilingBps)) {
      above.push(index);
    }
  });
  return above;
}

/**
 * Quantities per SKU, for the stock side.
 *
 * A basket may carry the same SKU on two lines — one discounted, one not — but a
 * stock movement is per SKU and location, and its dedupe key is too. Two
 * movements for one SKU on one sale would collide on that key and the second
 * would silently read as a replay of the first.
 */
export function qtyBySku(
  lines: readonly { readonly skuId: string; readonly qty: number }[],
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of lines) totals.set(line.skuId, (totals.get(line.skuId) ?? 0) + line.qty);
  return totals;
}
