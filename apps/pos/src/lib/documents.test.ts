import {
  posSyncSchema,
  returnDocumentSchema,
  saleDocumentSchema,
  type PosTender,
} from '@elysium/contracts';
import { describe, expect, it } from 'vitest';

import {
  cartTotals,
  receiptNumber,
  returnDocument,
  returnSlipNumber,
  saleDocument,
  type Cart,
  type CartLine,
} from './cart.js';

/**
 * Every document the till builds is one the server's sync endpoint accepts.
 *
 * Parsed with the same schemas `POST /v1/pos/sync` uses (`@elysium/contracts`,
 * `pos.ts`). A document the server refused would sit in the till's queue and be
 * retried forever, while the customer has already left with the goods — so this
 * runs the builders over a few hundred generated baskets and returns rather than
 * one hand-picked example.
 *
 * Deterministic, like the rest of the till's tests: a seeded generator, so a
 * failure names the same basket on every run.
 */

function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    // xorshift32: small, fast and good enough to spread test inputs.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const big = (min: bigint, max: bigint) =>
    min + BigInt(Math.floor(next() * Number(max - min + 1n)));
  const hex = (length: number) => Array.from({ length }, () => int(0, 15).toString(16)).join('');
  const uuid = () =>
    `${hex(8)}-${hex(4)}-4${hex(3)}-${['8', '9', 'a', 'b'][int(0, 3)]}${hex(3)}-${hex(12)}`;
  const code = () =>
    Array.from(
      { length: int(2, 8) },
      () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[int(0, 35)],
    ).join('');
  return {
    int,
    big,
    uuid,
    code,
    pick: <T>(items: readonly T[]) => items[int(0, items.length - 1)] as T,
  };
}

const TENDERS: readonly PosTender[] = ['cash', 'bkash', 'card'];

describe('the documents the till sends', () => {
  it('builds sales the server accepts, for hundreds of baskets', () => {
    const g = generator(20_260_929);

    for (let round = 0; round < 300; round += 1) {
      const lines: CartLine[] = Array.from({ length: g.int(1, 12) }, () => {
        const qty = g.int(1, round % 25 === 0 ? 9_999 : 20);
        const unitPricePoisha = g.big(0n, 5_000_000n);
        return {
          skuId: g.uuid(),
          code: 'SKU',
          name: 'Item',
          qty,
          unitPricePoisha,
          discountPoisha: g.big(0n, unitPricePoisha * BigInt(qty)),
        };
      });
      const cart: Cart = { lines, exchangeReturnId: round % 7 === 0 ? g.uuid() : null };
      const net = cartTotals(cart).netPoisha;

      // Split the net across one to three tenders, cash always last so change is
      // possible, the way the pay screen does.
      const bkash = round % 3 === 1 ? net / 3n : 0n;
      const card = round % 4 === 2 ? net / 5n : 0n;
      const cash = net - bkash - card;

      const document = saleDocument({
        id: g.uuid(),
        registerId: g.uuid(),
        shiftId: g.uuid(),
        receiptNo: receiptNumber(g.code(), g.int(1, 9_999), g.int(1, 9_999)),
        occurredAt: new Date(Date.UTC(2026, 8, 29, g.int(0, 23), g.int(0, 59))),
        cart,
        tenders: {
          cashPoisha: cash,
          bkashPoisha: bkash,
          cardPoisha: card,
          cashReceivedPoisha: cash + g.big(0n, 100_000n),
        },
        references: round % 2 === 0 ? { bkash: `TRX${String(round)}` } : {},
      });

      const parsed = saleDocumentSchema.safeParse(document);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });

  it('builds returns the server accepts, refunding nothing included', () => {
    const g = generator(7_001);

    for (let round = 0; round < 300; round += 1) {
      const document = returnDocument({
        id: g.uuid(),
        registerId: g.uuid(),
        shiftId: g.uuid(),
        saleId: g.uuid(),
        receiptNo: returnSlipNumber(g.code(), g.int(1, 9_999), g.int(1, 9_999)),
        occurredAt: new Date(Date.UTC(2026, 8, 29, g.int(0, 23))),
        reason: round % 3 === 0 ? '' : round % 3 === 1 ? '  wrong size  ' : 'x'.repeat(200),
        lines: Array.from({ length: g.int(1, 8) }, (_, index) => ({
          saleLineNo: index + 1,
          qty: g.int(1, 50),
          refundPoisha: round % 11 === 0 ? 0n : g.big(0n, 3_000_000n),
        })),
        tender: g.pick(TENDERS),
      });

      const parsed = returnDocumentSchema.safeParse(document);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      // A return that refunds nothing carries no tender: the schema only takes
      // positive tender amounts.
      if (document.refundPoisha === '0') expect(document.tenders).toEqual([]);
    }
  });

  it('sends a queue the sync endpoint accepts as one body, return before its exchange sale', () => {
    const returned = returnDocument({
      id: '7d1f0c2e-5b1a-4c3d-9e8f-0a1b2c3d4e5f',
      registerId: '1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b',
      shiftId: '2f3e4d5c-6b7a-4899-8a1b-2c3d4e5f6a7b',
      saleId: '3a4b5c6d-7e8f-4091-8a2b-3c4d5e6f7a8b',
      receiptNo: returnSlipNumber('GUL1', 3, 1),
      occurredAt: new Date('2026-09-29T08:00:00Z'),
      reason: 'Exchange for a larger size',
      lines: [{ saleLineNo: 1, qty: 1, refundPoisha: 150_000n }],
      tender: 'cash',
    });
    const replacement = saleDocument({
      id: '4b5c6d7e-8f90-4a1b-9c2d-4e5f6a7b8c9d',
      registerId: '1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b',
      shiftId: '2f3e4d5c-6b7a-4899-8a1b-2c3d4e5f6a7b',
      receiptNo: receiptNumber('GUL1', 3, 2),
      occurredAt: new Date('2026-09-29T08:01:00Z'),
      cart: {
        lines: [
          {
            skuId: '5c6d7e8f-9a0b-4c1d-8e2f-5a6b7c8d9e0f',
            code: 'ELY-SHRT-0001-RED-L',
            name: 'Shirt',
            qty: 1,
            unitPricePoisha: 150_000n,
            discountPoisha: 0n,
          },
        ],
        exchangeReturnId: '7d1f0c2e-5b1a-4c3d-9e8f-0a1b2c3d4e5f',
      },
      tenders: {
        cashPoisha: 150_000n,
        bkashPoisha: 0n,
        cardPoisha: 0n,
        cashReceivedPoisha: 150_000n,
      },
      references: {},
    });

    const parsed = posSyncSchema.safeParse({ documents: [returned, replacement] });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('is caught when it drifts: a lower-case register code makes a receipt the server refuses', () => {
    // The guard this file exists for, shown working: register codes are capitals
    // (the server's register schema), and a receipt built from anything else fails.
    expect(saleDocumentSchema.shape.receiptNo.safeParse(receiptNumber('gul1', 1, 1)).success).toBe(
      false,
    );
  });
});
