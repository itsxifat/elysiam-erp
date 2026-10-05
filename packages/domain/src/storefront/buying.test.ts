import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { EMAIL_TEMPLATE_KEYS, maskEmail, renderEmail } from '../notify/emails.js';
import { add, poisha, sub, ZERO, type Poisha } from '../money/index.js';
import { ORDER_STATUSES } from '../orders/state.js';
import { computeOrderTotals } from '../orders/totals.js';
import {
  claimsGuestOrder,
  codeState,
  isBcryptHash,
  normaliseCode,
  normaliseEmail,
  passwordProblem,
} from './accounts.js';
import { attributedDiscount, CartError, quoteCart, repricedReasons, type CartSku } from './cart.js';
import type { ShippingRule } from './shipping.js';
import { shopperPaymentStatus, shopperStatusOf } from './shopper.js';
import {
  gatewayAmount,
  gatewayTakesPayments,
  judgeValidation,
  parseGatewayAmount,
  payableOnline,
  refusedButPaid,
  sessionDeadline,
} from './sslcommerz.js';

const ZONE_IN = 'zone-in';
const ZONE_SUB = 'zone-sub';
const ZONE_OUT = 'zone-out';
const ZONE_NONE = 'zone-unmapped';

function rule(overrides: Partial<ShippingRule> = {}): ShippingRule {
  return {
    freeShippingEnabled: false,
    freeShippingThresholdPoisha: null,
    zones: {
      inside_dhaka: { feePoisha: poisha(6_000n), deliveryZoneIds: [ZONE_IN] },
      suburbs: { feePoisha: poisha(10_000n), deliveryZoneIds: [ZONE_SUB] },
      outside_dhaka: { feePoisha: poisha(13_000n), deliveryZoneIds: [ZONE_OUT] },
    },
    ...overrides,
  };
}

const sku = (id: string, price: bigint, availableQty: number, sellable = true): CartSku => ({
  id,
  pricePoisha: poisha(price),
  availableQty,
  sellable,
});

describe('quoteCart (M34, D-520)', () => {
  it('prices the lines, charges the zone’s fee and adds it up', () => {
    const quote = quoteCart({
      lines: [
        { key: 'a', skuId: 'a', qty: 2 },
        { key: 'b', skuId: 'b', qty: 1 },
      ],
      skus: new Map([
        ['a', sku('a', 250_000n, 5)],
        ['b', sku('b', 120_000n, 1)],
      ]),
      rule: rule(),
      deliveryZoneId: ZONE_OUT,
    });
    expect(quote.itemsPoisha).toBe(620_000n);
    expect(quote.zone).toBe('outside_dhaka');
    expect(quote.deliverable).toBe(true);
    expect(quote.deliveryPoisha).toBe(13_000n);
    expect(quote.totalPoisha).toBe(633_000n);
    expect(quote.unavailable).toEqual([]);
  });

  it('reports what cannot be bought and leaves it out of the totals', () => {
    const quote = quoteCart({
      lines: [
        { key: 'gone', skuId: null, qty: 1 },
        { key: 'hidden', skuId: 'h', qty: 1 },
        { key: 'out', skuId: 'o', qty: 1 },
        { key: 'short', skuId: 's', qty: 3 },
        { key: 'ok', skuId: 'k', qty: 1 },
      ],
      skus: new Map([
        ['h', sku('h', 100_000n, 9, false)],
        ['o', sku('o', 100_000n, 0)],
        ['s', sku('s', 100_000n, 2)],
        ['k', sku('k', 100_000n, 1)],
      ]),
      rule: rule(),
    });
    expect(quote.unavailable.map((line) => [line.key, line.reason, line.availableQty])).toEqual([
      ['gone', 'not_found', 0],
      ['hidden', 'not_on_website', 0],
      ['out', 'sold_out', 0],
      ['short', 'not_enough_stock', 2],
    ]);
    expect(quote.itemsPoisha).toBe(100_000n);
    // No address: no zone, no fee, not yet deliverable.
    expect(quote.deliverable).toBeNull();
    expect(quote.totalPoisha).toBe(100_000n);
  });

  it('folds two lines of one SKU into one, and checks stock against the sum', () => {
    const quote = quoteCart({
      lines: [
        { key: 'x1', skuId: 'x', qty: 2 },
        { key: 'x2', skuId: 'x', qty: 2 },
      ],
      skus: new Map([['x', sku('x', 1_000n, 3)]]),
      rule: rule(),
    });
    expect(quote.lines).toHaveLength(0);
    expect(quote.unavailable).toEqual([
      { key: 'x1', skuId: 'x', qty: 4, reason: 'not_enough_stock', availableQty: 3 },
    ]);
  });

  it('says an address the website does not ship to is not deliverable', () => {
    const quote = quoteCart({
      lines: [{ key: 'a', skuId: 'a', qty: 1 }],
      skus: new Map([['a', sku('a', 1_000n, 1)]]),
      rule: rule(),
      deliveryZoneId: ZONE_NONE,
    });
    expect(quote.deliverable).toBe(false);
    expect(quote.deliveryPoisha).toBe(0n);
    expect(repricedReasons({ totalPoisha: quote.totalPoisha }, quote)).toEqual(['not_deliverable']);
  });

  it('ships free at the threshold, and a threshold of zero means always free', () => {
    const lines = [{ key: 'a', skuId: 'a', qty: 1 }];
    const skus = new Map([['a', sku('a', 150_000n, 1)]]);
    const at = (threshold: bigint | null, enabled = true) =>
      quoteCart({
        lines,
        skus,
        rule: rule({
          freeShippingEnabled: enabled,
          freeShippingThresholdPoisha: threshold === null ? null : poisha(threshold),
        }),
        deliveryZoneId: ZONE_IN,
      });
    expect(at(150_000n).deliveryPoisha).toBe(0n);
    expect(at(150_001n).deliveryPoisha).toBe(6_000n);
    expect(at(0n).freeShipping).toBe(true);
    expect(at(null).deliveryPoisha).toBe(0n);
    expect(at(0n, false).deliveryPoisha).toBe(6_000n);
  });

  it('takes a discount off the goods and a free-delivery code off the fee', () => {
    const quote = quoteCart({
      lines: [{ key: 'a', skuId: 'a', qty: 1 }],
      skus: new Map([['a', sku('a', 100_000n, 1)]]),
      rule: rule(),
      deliveryZoneId: ZONE_IN,
      discounts: [
        { code: 'EID', discountPoisha: poisha(10_000n), deliveryDiscountPoisha: poisha(6_000n) },
      ],
    });
    expect(quote.totalPoisha).toBe(90_000n);
    expect(() =>
      quoteCart({
        lines: [{ key: 'a', skuId: 'a', qty: 1 }],
        skus: new Map([['a', sku('a', 100n, 1)]]),
        rule: rule(),
        discounts: [{ code: 'X', discountPoisha: poisha(101n), deliveryDiscountPoisha: ZERO }],
      }),
    ).toThrow(CartError);
  });

  it('uses a planned flash price below the shelf price, with the shelf price as compare-at', () => {
    const quote = quoteCart({
      lines: [
        { key: 'a', skuId: 'a', qty: 2 },
        { key: 'b', skuId: 'b', qty: 1 },
      ],
      skus: new Map([
        ['a', sku('a', 100_000n, 5)],
        ['b', sku('b', 50_000n, 5)],
      ]),
      flashPrices: new Map([
        ['a', poisha(80_000n)],
        // Not below the shelf price: ignored.
        ['b', poisha(60_000n)],
      ]),
      rule: rule(),
    });
    expect(quote.lines[0]?.unitPricePoisha).toBe(80_000n);
    expect(quote.lines[0]?.compareAtPoisha).toBe(100_000n);
    expect(quote.lines[1]?.unitPricePoisha).toBe(50_000n);
    expect(quote.lines[1]?.compareAtPoisha).toBeNull();
    expect(quote.itemsPoisha).toBe(210_000n);
  });

  const arbitraryCart = fc
    .record({
      skus: fc.array(
        fc.record({
          price: fc.bigInt({ min: 0n, max: 5_000_000n }),
          available: fc.integer({ min: 0, max: 30 }),
          sellable: fc.boolean(),
        }),
        { minLength: 1, maxLength: 6 },
      ),
      lines: fc.array(
        fc.record({ index: fc.integer({ min: 0, max: 7 }), qty: fc.integer({ min: 1, max: 20 }) }),
        { minLength: 1, maxLength: 8 },
      ),
      zone: fc.constantFrom<string | null | undefined>(
        ZONE_IN,
        ZONE_SUB,
        ZONE_OUT,
        ZONE_NONE,
        null,
        undefined,
      ),
      freeOn: fc.boolean(),
      threshold: fc.option(fc.bigInt({ min: 0n, max: 10_000_000n })),
      discountShare: fc.integer({ min: 0, max: 100 }),
      freeDelivery: fc.boolean(),
    })
    .map((spec) => {
      const skus = new Map(
        spec.skus.map((entry, index) => [
          `s${String(index)}`,
          sku(`s${String(index)}`, entry.price, entry.available, entry.sellable),
        ]),
      );
      const lines = spec.lines.map((line, position) => ({
        key: `k${String(position)}`,
        skuId: line.index < spec.skus.length ? `s${String(line.index)}` : null,
        qty: line.qty,
      }));
      return { spec, skus, lines };
    });

  it('property: total = items − discount + delivery − delivery discount, never negative', () => {
    fc.assert(
      fc.property(arbitraryCart, ({ spec, skus, lines }) => {
        const shipping = rule({
          freeShippingEnabled: spec.freeOn,
          freeShippingThresholdPoisha: spec.threshold === null ? null : poisha(spec.threshold),
        });
        const first = quoteCart({ lines, skus, rule: shipping, deliveryZoneId: spec.zone });
        const discount = poisha((first.itemsPoisha * BigInt(spec.discountShare)) / 100n);
        const quote = quoteCart({
          lines,
          skus,
          rule: shipping,
          deliveryZoneId: spec.zone,
          discounts: [
            {
              code: 'P',
              discountPoisha: discount,
              deliveryDiscountPoisha: spec.freeDelivery ? first.deliveryPoisha : ZERO,
            },
          ],
        });
        // Items are the available lines only, each qty × unit price.
        const items = quote.lines.reduce(
          (total, line) => total + line.unitPricePoisha * BigInt(line.qty),
          0n,
        );
        expect(quote.itemsPoisha).toBe(items);
        expect(quote.totalPoisha).toBe(
          add(
            sub(quote.itemsPoisha, quote.discountPoisha),
            sub(quote.deliveryPoisha, quote.deliveryDiscountPoisha),
          ),
        );
        expect(quote.totalPoisha >= 0n).toBe(true);
        // Every input line is accounted for once: bought or reported.
        const keys = new Set(lines.map((line) => line.skuId ?? line.key));
        expect(quote.lines.length + quote.unavailable.length).toBe(keys.size);
        // An available line never asks for more than the web locations hold.
        for (const line of quote.lines) expect(line.qty).toBeLessThanOrEqual(line.availableQty);
        // A fee is charged only where the website ships, and never when it ships free.
        if (quote.deliverable !== true || quote.freeShipping) expect(quote.deliveryPoisha).toBe(0n);
        // The same figures through §9's totals give the same COD: the order agrees with the quote.
        if (quote.lines.length > 0) {
          const totals = computeOrderTotals({
            lines: quote.lines.map((line) => ({
              qty: line.qty,
              unitPricePoisha: line.unitPricePoisha,
            })),
            orderDiscountPoisha: quote.discountPoisha,
            deliveryChargePoisha: sub(quote.deliveryPoisha, quote.deliveryDiscountPoisha),
          });
          expect(totals.codAmountPoisha).toBe(quote.totalPoisha);
        }
        // The quote the shopper saw is never "repriced" against itself.
        expect(
          repricedReasons(
            {
              totalPoisha: quote.totalPoisha,
              lines: quote.lines.map((line) => ({
                skuId: line.skuId,
                unitPricePoisha: line.unitPricePoisha,
              })),
            },
            quote,
          ).filter((reason) => reason === 'total' || reason === 'unit_price'),
        ).toEqual([]);
      }),
    );
  });

  it('property: any moved price or total is caught as repriced', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        fc.bigInt({ min: 1n, max: 1_000n }),
        (price, bump) => {
          const skus = new Map([['a', sku('a', price, 5)]]);
          const seen = quoteCart({
            lines: [{ key: 'a', skuId: 'a', qty: 1 }],
            skus,
            rule: rule(),
            deliveryZoneId: ZONE_IN,
          });
          const moved = quoteCart({
            lines: [{ key: 'a', skuId: 'a', qty: 1 }],
            skus: new Map([['a', sku('a', price + bump, 5)]]),
            rule: rule(),
            deliveryZoneId: ZONE_IN,
          });
          const reasons = repricedReasons(
            {
              totalPoisha: seen.totalPoisha,
              lines: [{ skuId: 'a', unitPricePoisha: seen.lines[0]?.unitPricePoisha ?? ZERO }],
            },
            moved,
          );
          expect(reasons).toContain('total');
          expect(reasons).toContain('unit_price');
        },
      ),
    );
  });
});

describe('the COD after an online payment (M34 check 3, D-526)', () => {
  /**
   * §9: cod = items − discount + delivery − advance, after every payment event. A gateway
   * payment is accepted only for exactly what is left to collect, so after it the COD is zero;
   * any earlier advances (an agent's bKash claim) lowered the figure first.
   */
  it('property: cod = items − discount + delivery − advance holds after every payment', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            qty: fc.integer({ min: 1, max: 5 }),
            price: fc.bigInt({ min: 0n, max: 2_000_000n }),
          }),
          {
            minLength: 1,
            maxLength: 5,
          },
        ),
        fc.integer({ min: 0, max: 100 }),
        fc.bigInt({ min: 0n, max: 15_000n }),
        fc.array(fc.integer({ min: 1, max: 100 }), { maxLength: 4 }),
        (lines, discountShare, delivery, payments) => {
          const items = lines.reduce((total, line) => total + line.price * BigInt(line.qty), 0n);
          const discount = (items * BigInt(discountShare)) / 100n;
          let advance: Poisha = ZERO;
          const codOf = (paid: Poisha) =>
            computeOrderTotals({
              lines: lines.map((line) => ({ qty: line.qty, unitPricePoisha: poisha(line.price) })),
              orderDiscountPoisha: poisha(discount),
              deliveryChargePoisha: poisha(delivery),
              advancePaidPoisha: paid,
            }).codAmountPoisha;
          for (const [index, share] of payments.entries()) {
            const remaining = codOf(advance);
            // The last payment is the gateway's: the whole remainder. Earlier ones are shares.
            const amount =
              index === payments.length - 1
                ? remaining
                : poisha((remaining * BigInt(share)) / 100n);
            const verdict = judgeValidation(
              { tranId: 'T1', amountPoisha: amount },
              { status: 'VALID', tran_id: 'T1', currency: 'BDT', amount: gatewayAmount(amount) },
            );
            expect(verdict.ok).toBe(true);
            advance = add(advance, amount);
            const cod = codOf(advance);
            expect(cod).toBe(BigInt(items) - discount + delivery - advance);
            expect(cod >= 0n).toBe(true);
          }
          if (payments.length > 0) expect(codOf(advance)).toBe(0n);
        },
      ),
    );
  });
});

describe('which discount an order is attributed to (D-539)', () => {
  const discount = (
    discountId: string,
    method: 'code' | 'automatic',
    goods: bigint,
    delivery = 0n,
  ) => ({
    discountId,
    method,
    discountPoisha: poisha(goods),
    deliveryDiscountPoisha: poisha(delivery),
  });

  it('names a typed code over a bigger automatic discount, and the code that gave most', () => {
    expect(attributedDiscount([])).toBeNull();
    expect(
      attributedDiscount([
        discount('auto', 'automatic', 50_000n),
        discount('typed', 'code', 1_000n),
      ]),
    ).toBe('typed');
    expect(
      attributedDiscount([
        discount('small', 'code', 1_000n),
        discount('free-delivery', 'code', 0n, 6_000n),
      ]),
    ).toBe('free-delivery');
    expect(
      attributedDiscount([discount('a', 'automatic', 2_000n), discount('b', 'automatic', 3_000n)]),
    ).toBe('b');
    // A tie goes to the first the engine listed.
    expect(attributedDiscount([discount('x', 'code', 1_000n), discount('y', 'code', 1_000n)])).toBe(
      'x',
    );
  });

  it('always names one of the applied discounts, and a code whenever one applied', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            method: fc.constantFrom<'code' | 'automatic'>('code', 'automatic'),
            goods: fc.bigInt({ min: 0n, max: 1_000_000n }),
            delivery: fc.bigInt({ min: 0n, max: 20_000n }),
          }),
          { maxLength: 6 },
        ),
        (rows) => {
          const applied = rows.map((row, index) =>
            discount(`d${String(index)}`, row.method, row.goods, row.delivery),
          );
          const chosen = attributedDiscount(applied);
          if (applied.length === 0) return chosen === null;
          const picked = applied.find((entry) => entry.discountId === chosen);
          if (picked === undefined) return false;
          return applied.some((entry) => entry.method === 'code')
            ? picked.method === 'code'
            : picked.method === 'automatic';
        },
      ),
    );
  });

  it('pays online only inside SSLCommerz’s range', () => {
    expect(payableOnline(poisha(999n))).toBe(false);
    expect(payableOnline(poisha(1_000n))).toBe(true);
    expect(payableOnline(poisha(50_000_000n))).toBe(true);
    expect(payableOnline(poisha(50_000_001n))).toBe(false);
  });
});

describe('SSLCommerz after the ledger audit (C1, W1, W3)', () => {
  it('takes money from a live store always, from a sandbox store only where allowed', () => {
    expect(gatewayTakesPayments('live', false)).toBe(true);
    expect(gatewayTakesPayments('live', true)).toBe(true);
    expect(gatewayTakesPayments('sandbox', false)).toBe(false);
    expect(gatewayTakesPayments('sandbox', true)).toBe(true);
  });

  it('never lets a page outlive its order, and opens none with under a minute left', () => {
    const placed = new Date('2026-10-05T10:00:00Z');
    expect(sessionDeadline(placed, new Date('2026-10-05T10:10:00Z'), 60)).toEqual(
      new Date('2026-10-05T11:00:00Z'),
    );
    expect(sessionDeadline(placed, new Date('2026-10-05T10:59:00Z'), 60)).toEqual(
      new Date('2026-10-05T11:00:00Z'),
    );
    expect(sessionDeadline(placed, new Date('2026-10-05T10:59:30Z'), 60)).toBeNull();
    expect(sessionDeadline(placed, new Date('2026-10-05T12:00:00Z'), 60)).toBeNull();
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200 * 60 }),
        fc.integer({ min: 5, max: 1440 }),
        (seconds, minutes) => {
          const now = new Date(placed.getTime() + seconds * 1000);
          const deadline = sessionDeadline(placed, now, minutes);
          if (deadline === null) return true;
          return (
            deadline.getTime() === placed.getTime() + minutes * 60_000 &&
            deadline.getTime() - now.getTime() >= 60_000
          );
        },
      ),
    );
  });

  it('books refused money only when it is a valid BDT payment of this transaction', () => {
    const session = { tranId: 'TRAN0000000000000000001' };
    const valid = { status: 'VALID', tran_id: session.tranId, currency: 'BDT', amount: '10.00' };
    expect(refusedButPaid(session, valid)).toBe(poisha(1_000n));
    expect(refusedButPaid(session, { ...valid, status: 'VALIDATED', amount: '1250.5' })).toBe(
      poisha(125_050n),
    );
    expect(refusedButPaid(session, { ...valid, status: 'INVALID_TRANSACTION' })).toBeNull();
    expect(refusedButPaid(session, { ...valid, tran_id: 'OTHER000000000000000001' })).toBeNull();
    expect(refusedButPaid(session, { ...valid, currency: 'USD' })).toBeNull();
    expect(refusedButPaid(session, { ...valid, currency_type: 'USD' })).toBeNull();
    expect(refusedButPaid(session, { ...valid, amount: '10.005' })).toBeNull();
    expect(refusedButPaid(session, { ...valid, amount: '0.00' })).toBeNull();
  });
});

describe('SSLCommerz rules (D-525)', () => {
  it('writes and reads amounts exactly', () => {
    expect(gatewayAmount(poisha(125_050n))).toBe('1250.50');
    expect(parseGatewayAmount('1250.50')).toBe(125_050n);
    expect(parseGatewayAmount('1250.5')).toBe(125_050n);
    expect(parseGatewayAmount('1250')).toBe(125_000n);
    expect(parseGatewayAmount('1250.5000')).toBe(125_050n);
    expect(parseGatewayAmount('1250.505')).toBeNull();
    expect(parseGatewayAmount('-1')).toBeNull();
    expect(parseGatewayAmount('1e3')).toBeNull();
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 9_000_000_000_000n }), (amount) => {
        expect(parseGatewayAmount(gatewayAmount(poisha(amount)))).toBe(amount);
      }),
    );
  });

  const session = { tranId: 'WEB1A2B3C', amountPoisha: poisha(250_000n) };
  const valid = { status: 'VALID', tran_id: 'WEB1A2B3C', currency: 'BDT', amount: '2500.00' };

  it('accepts exactly the session’s amount in BDT for its transaction', () => {
    expect(judgeValidation(session, valid)).toEqual({
      ok: true,
      amountPoisha: 250_000n,
      risky: false,
    });
    expect(judgeValidation(session, { ...valid, status: 'VALIDATED', risk_level: '1' })).toEqual({
      ok: true,
      amountPoisha: 250_000n,
      risky: true,
    });
  });

  it('refuses a different amount, currency, transaction or status', () => {
    expect(judgeValidation(session, { ...valid, amount: '25.00' })).toEqual({
      ok: false,
      reason: 'amount_mismatch',
    });
    expect(judgeValidation(session, { ...valid, amount: '2500.01' })).toEqual({
      ok: false,
      reason: 'amount_mismatch',
    });
    expect(judgeValidation(session, { ...valid, currency: 'USD' })).toEqual({
      ok: false,
      reason: 'currency_not_bdt',
    });
    expect(
      judgeValidation(session, { ...valid, currency_type: 'USD', currency_amount: '2500.00' }),
    ).toEqual({
      ok: false,
      reason: 'currency_not_bdt',
    });
    expect(
      judgeValidation(session, { ...valid, currency_type: 'BDT', currency_amount: '10.00' }),
    ).toEqual({
      ok: false,
      reason: 'amount_mismatch',
    });
    expect(judgeValidation(session, { ...valid, tran_id: 'OTHER' })).toEqual({
      ok: false,
      reason: 'transaction_mismatch',
    });
    expect(judgeValidation(session, { ...valid, status: 'INVALID_TRANSACTION' })).toEqual({
      ok: false,
      reason: 'not_valid',
    });
    expect(judgeValidation(session, { ...valid, amount: 'lots' })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('property: nothing but the exact amount is ever accepted', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1_000n, max: 50_000_000n }),
        fc.bigInt({ min: 0n, max: 50_000_000n }),
        (want, got) => {
          const verdict = judgeValidation(
            { tranId: 'T', amountPoisha: poisha(want) },
            { status: 'VALID', tran_id: 'T', currency: 'BDT', amount: gatewayAmount(poisha(got)) },
          );
          expect(verdict.ok).toBe(want === got);
        },
      ),
    );
  });
});

describe('shopper accounts (D-522, D-523)', () => {
  it('normalises email addresses and refuses what is not one', () => {
    expect(normaliseEmail('  Rahim@Example.COM ')).toBe('rahim@example.com');
    for (const bad of [
      '',
      'rahim',
      'a@b',
      'a b@c.com',
      'a@@b.com',
      '<a@b.com>',
      'a@b.com\nBcc: x@y.z',
    ]) {
      expect(normaliseEmail(bad)).toBeNull();
    }
  });

  it('asks for at least eight characters and at most bcrypt’s 72 bytes', () => {
    expect(passwordProblem('short')).toBe('too_short');
    expect(passwordProblem('long enough')).toBeNull();
    expect(passwordProblem('ক'.repeat(25))).toBe('too_long');
  });

  it('knows a bcrypt hash', () => {
    expect(isBcryptHash('$2a$12$' + 'a'.repeat(53))).toBe(true);
    expect(isBcryptHash('$2b$10$' + 'A./'.repeat(17) + 'aa')).toBe(true);
    expect(isBcryptHash('plain')).toBe(false);
    expect(isBcryptHash('$2a$12$' + 'a'.repeat(52))).toBe(false);
  });

  it('burns a code after five wrong tries, and expires it', () => {
    const now = new Date('2026-10-05T10:00:00Z');
    const later = new Date('2026-10-05T10:10:00Z');
    expect(codeState({ expiresAt: later, attempts: 4, consumedAt: null }, now)).toBe('usable');
    expect(codeState({ expiresAt: later, attempts: 5, consumedAt: null }, now)).toBe('locked');
    expect(codeState({ expiresAt: now, attempts: 0, consumedAt: null }, now)).toBe('expired');
    expect(codeState({ expiresAt: later, attempts: 0, consumedAt: now }, now)).toBe('used');
    expect(normaliseCode(' ১২৩ ৪৫৬ ')).toBe('123456');
    expect(normaliseCode('12345')).toBeNull();
  });

  it('claims a guest order by verified email only, never by an unverified phone', () => {
    const account = { email: 'r@example.com', emailVerified: true, phoneE164: '+8801711000001' };
    expect(
      claimsGuestOrder(account, {
        email: 'r@example.com',
        phoneE164: '+8801999999999',
        accountId: null,
      }),
    ).toBe(true);
    expect(
      claimsGuestOrder(account, { email: null, phoneE164: '+8801711000001', accountId: null }),
    ).toBe(false);
    expect(
      claimsGuestOrder(account, {
        email: 'other@example.com',
        phoneE164: '+8801711000001',
        accountId: null,
      }),
    ).toBe(false);
    expect(
      claimsGuestOrder(account, {
        email: 'r@example.com',
        phoneE164: '+8801711000001',
        accountId: 'acc',
      }),
    ).toBe(false);
    expect(
      claimsGuestOrder(
        { ...account, emailVerified: false },
        { email: 'r@example.com', phoneE164: '+880', accountId: null },
      ),
    ).toBe(false);
  });
});

describe('what a shopper is told (D-524)', () => {
  it('maps every status to the plan’s words', () => {
    expect(ORDER_STATUSES.map((status) => [status, shopperStatusOf(status)])).toEqual([
      ['pending', 'placed'],
      ['confirmed', 'processing'],
      ['on_hold', 'processing'],
      ['packed', 'processing'],
      ['shipped', 'shipped'],
      ['delivered', 'delivered'],
      ['partially_delivered', 'partly_delivered'],
      ['return_in_transit', 'returned'],
      ['returned', 'returned'],
      ['cancelled', 'cancelled'],
      ['exchange', 'exchanged'],
    ]);
  });

  it('says how it was paid', () => {
    expect(
      shopperPaymentStatus({
        method: 'cod',
        paidPoisha: 0n,
        codPoisha: 10n,
        orderStatus: 'pending',
      }),
    ).toBe('cash_on_delivery');
    expect(
      shopperPaymentStatus({
        method: 'sslcommerz',
        paidPoisha: 0n,
        codPoisha: 10n,
        orderStatus: 'pending',
      }),
    ).toBe('awaiting_payment');
    expect(
      shopperPaymentStatus({
        method: 'sslcommerz',
        paidPoisha: 10n,
        codPoisha: 0n,
        orderStatus: 'confirmed',
      }),
    ).toBe('paid');
    expect(
      shopperPaymentStatus({
        method: 'sslcommerz',
        paidPoisha: 10n,
        codPoisha: 0n,
        orderStatus: 'cancelled',
      }),
    ).toBe('refund_due');
  });
});

describe('the website’s emails (D-529)', () => {
  const values = {
    brand: 'Brand & Co',
    name: '<Rahim>',
    code: '123456',
    resetUrl: 'https://shop.example/reset?token=abc',
    orderNo: 'ABC-2610-00001',
    total: '৳1,250.00',
    orderUrl: 'https://shop.example/order-confirmation/ABC-2610-00001?token=t',
    courier: 'Steadfast',
    trackingCode: 'TRK1',
  };

  it('renders every template in both languages, escaped, naming no brand of its own', () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      for (const locale of ['bn', 'en'] as const) {
        const email = renderEmail(key, locale, values);
        expect(email.subject.length).toBeGreaterThan(0);
        expect(email.html).not.toContain('<Rahim>');
        expect(email.text).toContain('Brand & Co');
        expect(email.html.toLowerCase()).not.toContain('elysium');
      }
    }
    expect(renderEmail('account.email_code', 'en', values).text).toContain('123456');
    expect(renderEmail('order.shipped', 'bn', values).text).toContain('TRK1');
  });

  it('refuses a missing value and keeps a header on one line', () => {
    expect(() => renderEmail('account.email_code', 'en', { brand: 'B', name: 'N' })).toThrow(
      /code/,
    );
    const email = renderEmail('order.confirmed', 'en', { ...values, orderNo: 'A\r\nBcc: x@y.z' });
    expect(email.subject).not.toMatch(/[\r\n]/);
  });

  it('leaves a non-https link out of the button', () => {
    const email = renderEmail('account.password_reset', 'en', {
      ...values,
      resetUrl: 'javascript:alert(1)',
    });
    expect(email.html).not.toContain('javascript:');
  });

  it('masks an address for a log line', () => {
    expect(maskEmail('rahim@gmail.com')).toBe('r***@g***.com');
    expect(maskEmail('nope')).toBe('***');
  });
});
