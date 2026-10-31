import { allocate, poisha } from '@elysium/domain/money';

import type { AppliedOffer, EditLine, OfferRow } from './edit-api.js';

/**
 * The order editor's rules, pure so they are tested without a browser (M50, D-921 to D-924).
 */

/** An order line as the editor holds it. */
export interface EditRow {
  readonly skuId: string;
  readonly skuCode: string;
  readonly name: string;
  readonly variantLabel: string;
  readonly imageFileId: string | null;
  readonly qty: number;
  readonly unitPricePoisha: string;
  /** The line's own discount as the order had it, for its original quantity. */
  readonly lineDiscountPoisha: string;
  /** The quantity the line discount was given for; null for a line added in the editor. */
  readonly originalQty: number | null;
  /** Units in hand where the order ships from, when known. */
  readonly available: number | null;
}

/**
 * Choosing an offer. One that does not combine replaces every other choice; one that combines
 * replaces any choice that does not. Choosing a chosen offer again takes it off.
 */
export function toggleOffer(
  selected: readonly string[],
  offer: Pick<OfferRow, 'discountId' | 'allowStacking'>,
  offers: readonly Pick<OfferRow, 'discountId' | 'allowStacking'>[],
): string[] {
  if (selected.includes(offer.discountId)) {
    return selected.filter((id) => id !== offer.discountId);
  }
  if (!offer.allowStacking) return [offer.discountId];
  const stackable = new Set(
    offers.filter((entry) => entry.allowStacking).map((entry) => entry.discountId),
  );
  return [...selected.filter((id) => stackable.has(id)), offer.discountId];
}

/** What an order's discount and charge were before its offers: the editor's starting values. */
export function startingTerms(order: {
  readonly amounts: { readonly discountPoisha: string; readonly deliveryChargePoisha: string };
  readonly lines: readonly { readonly discountPoisha: string }[];
  readonly appliedOffers?: readonly AppliedOffer[] | undefined;
}): { typedDiscountPoisha: bigint; baseDeliveryPoisha: bigint; offerIds: string[] } {
  const offers = order.appliedOffers ?? [];
  const lineDiscounts = order.lines.reduce(
    (total, line) => total + BigInt(line.discountPoisha),
    0n,
  );
  const offerGoods = offers.reduce((total, offer) => total + BigInt(offer.discountPoisha), 0n);
  const offerDelivery = offers.reduce(
    (total, offer) => total + BigInt(offer.deliveryDiscountPoisha),
    0n,
  );
  const typed = BigInt(order.amounts.discountPoisha) - lineDiscounts - offerGoods;
  return {
    typedDiscountPoisha: typed > 0n ? typed : 0n,
    baseDeliveryPoisha: BigInt(order.amounts.deliveryChargePoisha) + offerDelivery,
    offerIds: offers.map((offer) => offer.discountId),
  };
}

/**
 * The lines as the server prices them. A line the order already had keeps its price and its own
 * discount (scaled down with its quantity, never up); a line added here is priced by the server.
 */
export function editLines(rows: readonly EditRow[]): EditLine[] {
  return rows.map((row) => {
    if (row.originalQty === null) return { skuId: row.skuId, qty: row.qty };
    const discount = BigInt(row.lineDiscountPoisha);
    // Fewer units keep their share of the line's discount, split by the money module.
    const scaled =
      row.qty >= row.originalQty
        ? discount
        : BigInt(allocate(poisha(discount), [row.qty, row.originalQty - row.qty])[0] ?? poisha(0n));
    return {
      skuId: row.skuId,
      qty: row.qty,
      unitPricePoisha: row.unitPricePoisha,
      ...(scaled > 0n ? { discountPoisha: scaled.toString() } : {}),
    };
  });
}

/** One more of a SKU: a new line, or one more unit on the line that has it. */
export function addRow(rows: readonly EditRow[], next: EditRow): EditRow[] {
  const index = rows.findIndex((row) => row.skuId === next.skuId);
  if (index < 0) return [...rows, next];
  return rows.map((row, at) => (at === index ? { ...row, qty: Math.min(row.qty + 1, 999) } : row));
}

export function setRowQty(rows: readonly EditRow[], skuId: string, qty: number): EditRow[] {
  const bounded = Math.max(1, Math.min(Math.trunc(qty), 999));
  return rows.map((row) => (row.skuId === skuId ? { ...row, qty: bounded } : row));
}

/** A line's total as shown: its price times its units, less its share of its own discount. */
export function rowTotal(row: EditRow): bigint {
  const line = editLines([row])[0];
  return BigInt(row.unitPricePoisha) * BigInt(row.qty) - BigInt(line?.discountPoisha ?? '0');
}

/** The note a re-priced partial delivery carries into the journal's memo (D-924). */
export function differenceNote(
  template: string,
  offers: readonly string[],
  noOffer: string,
  fee: string,
  note: string,
): string {
  const text = template
    .replace('{offers}', offers.length === 0 ? noOffer : offers.join(', '))
    .replace('{fee}', fee);
  const full = note.trim() === '' ? text : `${text} ${note.trim()}`;
  return full.slice(0, 500);
}

/** Pieces returned per SKU, bounded by what was sent. */
export function returnOne(
  returned: Readonly<Record<string, number>>,
  skuId: string,
  sent: number,
  delta: number,
): Record<string, number> {
  const next = Math.max(0, Math.min((returned[skuId] ?? 0) + delta, sent));
  return { ...returned, [skuId]: next };
}
