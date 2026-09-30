import { describe, expect, it } from 'vitest';

import {
  percentOf as domainPercentOf,
  poisha,
} from '../../../../packages/domain/src/money/index.js';
import {
  maxDiscountFor as domainMaxDiscount,
  priceLines,
  settleTenders,
} from '../../../../packages/domain/src/pos/cart.js';
import { refundFor } from '../../../../packages/domain/src/pos/returns.js';
import { refundForUnits } from './money.js';
import {
  cartReducer,
  cartTotals,
  EMPTY_CART,
  lookup,
  receiptNumber,
  saleDocument,
  settle,
  withinCeiling,
  type Cart,
  type CartAction,
  type PriceListItem,
} from './cart.js';
import { maxDiscountFor, percentOf, percentToBps } from './money.js';

/**
 * The till's own arithmetic, and the proof that it is the server's.
 *
 * The PWA cannot import `@elysium/domain` yet, so it restates three small rules.
 * A restatement is only safe if it is checked against the original, so the second
 * half of this file runs both over the same inputs — the test reaches into the
 * domain package by path, which a test may do and the app may not.
 */

const SHIRT: PriceListItem = {
  id: 'a1b2c3d4-0000-4000-8000-00000000000a',
  code: 'ELY-SHRT-0001-RED-M',
  barcode: '8941234567890',
  name: 'Oxford shirt',
  pricePoisha: '150000',
  available: 4,
};
const SCARF: PriceListItem = {
  ...SHIRT,
  id: 'a1b2c3d4-0000-4000-8000-00000000000b',
  code: 'ELY-SCRF-0002',
  barcode: null,
  name: 'Scarf',
  pricePoisha: '45050',
};

function cartOf(...actions: CartAction[]): Cart {
  return actions.reduce(cartReducer, EMPTY_CART);
}

describe('the basket', () => {
  it('adds a scanned item, and a second scan of it adds a unit', () => {
    const cart = cartOf(
      { type: 'add', item: SHIRT },
      { type: 'add', item: SHIRT },
      { type: 'add', item: SCARF },
    );
    expect(cart.lines.map((line) => [line.code, line.qty])).toEqual([
      ['ELY-SHRT-0001-RED-M', 2],
      ['ELY-SCRF-0002', 1],
    ]);
    expect(cartTotals(cart)).toEqual({
      grossPoisha: 345_050n,
      discountPoisha: 0n,
      netPoisha: 345_050n,
      units: 3,
    });
  });

  it('keeps a discounted line to itself, and clamps its discount when the quantity drops', () => {
    let cart = cartOf({ type: 'add', item: SHIRT }, { type: 'add', item: SHIRT });
    cart = cartReducer(cart, { type: 'discount', index: 0, discountPoisha: 200_000n });
    cart = cartReducer(cart, { type: 'add', item: SHIRT });
    expect(cart.lines.map((line) => line.qty)).toEqual([2, 1]);
    cart = cartReducer(cart, { type: 'setQty', index: 0, qty: 1 });
    expect(cart.lines[0]?.discountPoisha).toBe(150_000n);
    expect(cartTotals(cart).netPoisha).toBe(150_000n);
  });

  it('finds an item by code in any case, or by its exact barcode', () => {
    expect(lookup([SHIRT, SCARF], 'ely-scrf-0002')?.name).toBe('Scarf');
    expect(lookup([SHIRT, SCARF], '8941234567890')?.name).toBe('Oxford shirt');
    expect(lookup([SHIRT, SCARF], '   ')).toBeUndefined();
  });

  it('numbers receipts by register, shift and sequence', () => {
    expect(receiptNumber('GUL1', 12, 7)).toBe('GUL1-12-0007');
  });
});

describe('the till agrees with the server, to the poisha', () => {
  it('prices a basket exactly as the domain does', () => {
    let cart = cartOf(
      { type: 'add', item: SHIRT },
      { type: 'add', item: SHIRT },
      { type: 'add', item: SCARF },
    );
    cart = cartReducer(cart, { type: 'discount', index: 0, discountPoisha: 10_000n });
    const mine = cartTotals(cart);
    const theirs = priceLines(
      cart.lines.map((line) => ({
        skuId: line.skuId,
        qty: line.qty,
        unitPricePoisha: poisha(line.unitPricePoisha),
        discountPoisha: poisha(line.discountPoisha),
      })),
    );
    expect([mine.grossPoisha, mine.discountPoisha, mine.netPoisha]).toEqual([
      theirs.grossPoisha,
      theirs.discountPoisha,
      theirs.netPoisha,
    ]);

    // …and the document it builds is one the server's own tender check accepts.
    const tenders = {
      cashPoisha: 235_050n,
      bkashPoisha: 100_000n,
      cardPoisha: 0n,
      cashReceivedPoisha: 240_000n,
    };
    const document = saleDocument({
      id: '0b7e9d0c-3f1a-4c55-9a53-6f0f4d1a2b01',
      registerId: 'r',
      shiftId: 's',
      receiptNo: 'GUL1-1-0001',
      occurredAt: new Date('2026-09-29T06:00:00Z'),
      cart,
      tenders,
      references: { bkash: 'TRX9' },
    });
    expect(document.totals.netPoisha).toBe('335050');
    const settled = settleTenders(
      theirs.netPoisha,
      document.tenders.map((tender) => ({
        tender: tender.tender,
        amountPoisha: poisha(tender.amountPoisha),
      })),
      poisha(document.cashReceivedPoisha ?? '0'),
    );
    expect(settled.changePoisha).toBe(4_950n);
    expect(settle(mine.netPoisha, tenders)).toEqual({ problem: null, changePoisha: 4_950n });
  });

  it('rounds a percentage and a ceiling exactly as the domain does, for thousands of amounts', () => {
    // Deterministic rather than random: the pairs that matter are the ones whose
    // product lands on or beside a half, and a stride through a prime finds them.
    for (let gross = 1n; gross < 2_000_000n; gross += 9_973n) {
      for (const bps of [0, 1, 250, 500, 1_250, 2_000, 3_333, 9_999, 10_000]) {
        expect(percentOf(gross, bps), `${String(gross)} @ ${String(bps)}`).toBe(
          domainPercentOf(poisha(gross), bps),
        );
        expect(maxDiscountFor(gross, bps)).toBe(domainMaxDiscount(poisha(gross), bps));
      }
    }
  });

  it('flags a line above the ceiling the same way the server will', () => {
    const cart = cartReducer(cartOf({ type: 'add', item: { ...SHIRT, pricePoisha: '1003' } }), {
      type: 'discount',
      index: 0,
      discountPoisha: 201n,
    });
    const line = cart.lines[0];
    if (line === undefined) throw new Error('the basket lost its line');
    expect(withinCeiling(line, 2_000)).toBe(true);
    expect(withinCeiling({ ...line, discountPoisha: 202n }, 2_000)).toBe(false);
  });

  it('computes a partial refund exactly as the domain does', () => {
    const cases: readonly (readonly [bigint, number])[] = [
      [100_000n, 3],
      [440_000n, 3],
      [99_999n, 7],
      [1n, 2],
    ];
    for (const [net, qty] of cases) {
      let returned = 0;
      while (returned < qty) {
        const take = Math.min(2, qty - returned);
        expect(refundForUnits(net, qty, returned, take)).toBe(
          refundFor({ qty, netPoisha: poisha(net), returnedQty: returned }, take),
        );
        returned += take;
      }
    }
  });

  it('reads a typed percentage without a float', () => {
    expect(percentToBps('12.5')).toBe(1_250);
    expect(percentToBps('100')).toBe(10_000);
    expect(percentToBps('100.01')).toBeNull();
    expect(percentToBps('abc')).toBeNull();
  });
});

describe('split payment', () => {
  it('names what is wrong with tenders that do not add up', () => {
    const draft = { cashPoisha: 100n, bkashPoisha: 0n, cardPoisha: 0n, cashReceivedPoisha: 100n };
    expect(settle(150n, draft).problem).toBe('short');
    expect(settle(50n, draft).problem).toBe('over');
    expect(settle(100n, { ...draft, cashReceivedPoisha: 90n }).problem).toBe('cashShort');
  });
});
