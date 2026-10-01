import type { PosTender, ReturnDocument, SaleDocument } from '@elysium/contracts';

import { maxDiscountFor } from './money.js';

/**
 * The basket, as pure data and pure functions (architecture §14, invariant 11).
 *
 * Everything that computes a figure the customer pays is here and tested
 * (`cart.test.ts`), so the React screens only render and dispatch. The server
 * re-prices the sale from its lines and refuses a document whose totals disagree,
 * so this file and `packages/domain/src/pos/cart.ts` must agree to the poisha —
 * the test checks exactly that.
 */

export interface PriceListItem {
  readonly id: string;
  readonly code: string;
  readonly barcode: string | null;
  readonly name: string;
  /** Integer poisha as a decimal string, as the wire carries it. */
  readonly pricePoisha: string;
  readonly available: number;
}

export interface CartLine {
  readonly skuId: string;
  readonly code: string;
  readonly name: string;
  readonly qty: number;
  readonly unitPricePoisha: bigint;
  readonly discountPoisha: bigint;
}

export interface Cart {
  readonly lines: readonly CartLine[];
  /** Set when this basket is an exchange's replacement sale. */
  readonly exchangeReturnId: string | null;
}

export const EMPTY_CART: Cart = { lines: [], exchangeReturnId: null };

export const MAX_QTY = 9_999;

export type CartAction =
  | { readonly type: 'add'; readonly item: PriceListItem }
  | { readonly type: 'setQty'; readonly index: number; readonly qty: number }
  | { readonly type: 'remove'; readonly index: number }
  | { readonly type: 'discount'; readonly index: number; readonly discountPoisha: bigint }
  | { readonly type: 'clear' }
  | { readonly type: 'exchange'; readonly returnId: string };

export function lineGross(line: CartLine): bigint {
  return line.unitPricePoisha * BigInt(line.qty);
}

export function lineNet(line: CartLine): bigint {
  return lineGross(line) - line.discountPoisha;
}

/**
 * A discount is clamped to the line when the quantity drops below it, rather than
 * left larger than the line: a line whose discount exceeds its gross is a negative
 * sale, and the server refuses the whole receipt for it.
 */
function clampDiscount(line: CartLine): CartLine {
  const gross = lineGross(line);
  return line.discountPoisha > gross ? { ...line, discountPoisha: gross } : line;
}

export function cartReducer(cart: Cart, action: CartAction): Cart {
  switch (action.type) {
    case 'add': {
      // Scanning the same item again adds a unit to its undiscounted line, the way
      // a cashier expects; a discounted line keeps its discount to itself.
      const index = cart.lines.findIndex(
        (line) => line.skuId === action.item.id && line.discountPoisha === 0n && line.qty < MAX_QTY,
      );
      if (index >= 0) {
        return {
          ...cart,
          lines: cart.lines.map((line, i) => (i === index ? { ...line, qty: line.qty + 1 } : line)),
        };
      }
      return {
        ...cart,
        lines: [
          ...cart.lines,
          {
            skuId: action.item.id,
            code: action.item.code,
            name: action.item.name,
            qty: 1,
            unitPricePoisha: BigInt(action.item.pricePoisha),
            discountPoisha: 0n,
          },
        ],
      };
    }
    case 'setQty': {
      if (!Number.isSafeInteger(action.qty) || action.qty < 1 || action.qty > MAX_QTY) return cart;
      return {
        ...cart,
        lines: cart.lines.map((line, i) =>
          i === action.index ? clampDiscount({ ...line, qty: action.qty }) : line,
        ),
      };
    }
    case 'remove':
      return { ...cart, lines: cart.lines.filter((_, i) => i !== action.index) };
    case 'discount':
      return {
        ...cart,
        lines: cart.lines.map((line, i) =>
          i === action.index
            ? clampDiscount({
                ...line,
                discountPoisha: action.discountPoisha < 0n ? 0n : action.discountPoisha,
              })
            : line,
        ),
      };
    case 'clear':
      return EMPTY_CART;
    case 'exchange':
      return { ...cart, exchangeReturnId: action.returnId };
  }
}

export interface CartTotals {
  readonly grossPoisha: bigint;
  readonly discountPoisha: bigint;
  readonly netPoisha: bigint;
  readonly units: number;
}

export function cartTotals(cart: Cart): CartTotals {
  let gross = 0n;
  let discount = 0n;
  let units = 0;
  for (const line of cart.lines) {
    gross += lineGross(line);
    discount += line.discountPoisha;
    units += line.qty;
  }
  return { grossPoisha: gross, discountPoisha: discount, netPoisha: gross - discount, units };
}

/** Whether a line's discount is within the cashier's ceiling (the server re-checks). */
export function withinCeiling(line: CartLine, ceilingBps: number): boolean {
  return line.discountPoisha <= maxDiscountFor(lineGross(line), ceilingBps);
}

/** Find a scanned code: the SKU code (case-insensitive) or the exact barcode. */
export function lookup(
  items: readonly PriceListItem[],
  scanned: string,
): PriceListItem | undefined {
  const code = scanned.trim();
  if (code === '') return undefined;
  const upper = code.toUpperCase();
  return items.find((item) => item.code === upper || item.barcode === code);
}

export interface TenderDraft {
  readonly cashPoisha: bigint;
  readonly bkashPoisha: bigint;
  readonly cardPoisha: bigint;
  readonly cashReceivedPoisha: bigint;
}

export type TenderProblem = 'short' | 'over' | 'cashShort' | null;

/**
 * Whether the tenders pay the sale exactly, and the change.
 *
 * Mirrors `settleTenders` on the server: tenders are amounts **applied**, so they
 * sum to the net; only cash gives change, from what the customer handed over.
 */
export function settle(
  netPoisha: bigint,
  draft: TenderDraft,
): { readonly problem: TenderProblem; readonly changePoisha: bigint } {
  const paid = draft.cashPoisha + draft.bkashPoisha + draft.cardPoisha;
  if (paid < netPoisha) return { problem: 'short', changePoisha: 0n };
  if (paid > netPoisha) return { problem: 'over', changePoisha: 0n };
  if (draft.cashReceivedPoisha < draft.cashPoisha)
    return { problem: 'cashShort', changePoisha: 0n };
  return { problem: null, changePoisha: draft.cashReceivedPoisha - draft.cashPoisha };
}

/**
 * The documents the queue carries are the ones `POST /v1/pos/sync` validates:
 * one definition in `@elysium/contracts`, imported for its types only, so a field
 * the server stops accepting is a compile error here rather than a sale that
 * retries forever.
 */
export type { ReturnDocument, SaleDocument };

export function saleDocument(input: {
  readonly id: string;
  readonly registerId: string;
  readonly shiftId: string;
  readonly receiptNo: string;
  readonly occurredAt: Date;
  readonly cart: Cart;
  readonly tenders: TenderDraft;
  readonly references: { readonly bkash?: string; readonly card?: string };
}): SaleDocument {
  const totals = cartTotals(input.cart);
  const tenders: SaleDocument['tenders'][number][] = [];
  if (input.tenders.cashPoisha > 0n) {
    tenders.push({ tender: 'cash', amountPoisha: input.tenders.cashPoisha.toString() });
  }
  if (input.tenders.bkashPoisha > 0n) {
    tenders.push({
      tender: 'bkash',
      amountPoisha: input.tenders.bkashPoisha.toString(),
      ...(input.references.bkash ? { reference: input.references.bkash } : {}),
    });
  }
  if (input.tenders.cardPoisha > 0n) {
    tenders.push({
      tender: 'card',
      amountPoisha: input.tenders.cardPoisha.toString(),
      ...(input.references.card ? { reference: input.references.card } : {}),
    });
  }
  return {
    kind: 'sale',
    id: input.id,
    registerId: input.registerId,
    shiftId: input.shiftId,
    receiptNo: input.receiptNo,
    occurredAt: input.occurredAt.toISOString(),
    lines: input.cart.lines.map((line, index) => ({
      lineNo: index + 1,
      skuId: line.skuId,
      qty: line.qty,
      unitPricePoisha: line.unitPricePoisha.toString(),
      discountPoisha: line.discountPoisha.toString(),
    })),
    tenders,
    ...(input.tenders.cashPoisha > 0n
      ? { cashReceivedPoisha: input.tenders.cashReceivedPoisha.toString() }
      : {}),
    totals: {
      grossPoisha: totals.grossPoisha.toString(),
      discountPoisha: totals.discountPoisha.toString(),
      netPoisha: totals.netPoisha.toString(),
    },
    ...(input.cart.exchangeReturnId === null
      ? {}
      : { exchangeReturnId: input.cart.exchangeReturnId }),
  };
}

/** `GUL1-12-0007`: register, shift number, sequence within the shift. */
export function receiptNumber(registerCode: string, shiftNo: number, seq: number): string {
  return `${registerCode}-${String(shiftNo)}-${String(seq).padStart(4, '0')}`;
}

/** `GUL1-12-R0007`: a return slip's number, in its own sequence beside the sales'. */
export function returnSlipNumber(registerCode: string, shiftNo: number, seq: number): string {
  return `${registerCode}-${String(shiftNo)}-R${String(seq).padStart(4, '0')}`;
}

/**
 * The return document the queue carries (§14), against one earlier sale.
 *
 * The refund goes back in one tender, and a return that refunds nothing — an
 * exchange of a gift with no money changing hands — sends no tender at all.
 */
export function returnDocument(input: {
  readonly id: string;
  readonly registerId: string;
  readonly shiftId: string;
  readonly saleId: string;
  readonly receiptNo: string;
  readonly occurredAt: Date;
  readonly reason: string;
  readonly lines: readonly {
    readonly saleLineNo: number;
    readonly qty: number;
    readonly refundPoisha: bigint;
  }[];
  readonly tender: PosTender;
}): ReturnDocument {
  const total = input.lines.reduce((sum, line) => sum + line.refundPoisha, 0n);
  const reason = input.reason.trim();
  return {
    kind: 'return',
    id: input.id,
    registerId: input.registerId,
    shiftId: input.shiftId,
    saleId: input.saleId,
    receiptNo: input.receiptNo,
    occurredAt: input.occurredAt.toISOString(),
    ...(reason === '' ? {} : { reason }),
    lines: input.lines.map((line, index) => ({
      lineNo: index + 1,
      saleLineNo: line.saleLineNo,
      qty: line.qty,
      refundPoisha: line.refundPoisha.toString(),
    })),
    tenders: total > 0n ? [{ tender: input.tender, amountPoisha: total.toString() }] : [],
    refundPoisha: total.toString(),
  };
}
