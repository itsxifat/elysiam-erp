import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toIsoDate } from '../dates/index.js';
import { poisha } from '../money/index.js';
import {
  normaliseCode,
  validatePromo,
  type PromoBasket,
  type PromoCode,
  type PromoReason,
} from './index.js';

const SHIRT = 'sku-shirt';
const SAREE = 'sku-saree';
const TOPS = 'cat-tops';

const base: PromoCode = {
  id: 'promo-1',
  code: 'EID20',
  kind: 'percent',
  valueBps: 2_000,
  valuePoisha: poisha(0),
  minOrderPoisha: null,
  maxDiscountPoisha: null,
  totalLimit: null,
  perCustomerLimit: null,
  validFrom: toIsoDate('2026-10-01'),
  validTo: toIsoDate('2026-10-31'),
  channels: [],
  skuIds: [],
  categoryIds: [],
  customerId: null,
  status: 'active',
};

const basket: PromoBasket = {
  lines: [
    { skuId: SHIRT, categoryId: TOPS, netPoisha: poisha(150_000) },
    { skuId: SAREE, categoryId: null, netPoisha: poisha(350_000) },
  ],
  deliveryChargePoisha: poisha(12_000),
  channel: 'facebook',
  customerId: 'buyer-1',
  on: toIsoDate('2026-10-15'),
};

const unused = { total: 0, byCustomer: 0 };

describe('promo validation (M16 check 3)', () => {
  const refusals: readonly {
    name: string;
    code?: Partial<PromoCode>;
    basket?: Partial<PromoBasket>;
    usage?: { total: number; byCustomer: number };
    reason: PromoReason;
  }[] = [
    { name: 'expired', basket: { on: toIsoDate('2026-11-01') }, reason: 'expired' },
    { name: 'not yet valid', basket: { on: toIsoDate('2026-09-30') }, reason: 'not_yet_valid' },
    { name: 'paused', code: { status: 'paused' }, reason: 'inactive' },
    {
      name: 'limit reached',
      code: { totalLimit: 100 },
      usage: { total: 100, byCustomer: 0 },
      reason: 'limit_reached',
    },
    {
      name: 'this buyer has used it up',
      code: { perCustomerLimit: 1 },
      usage: { total: 5, byCustomer: 1 },
      reason: 'customer_limit_reached',
    },
    {
      name: 'minimum order not met',
      code: { minOrderPoisha: poisha(600_000) },
      reason: 'min_order_not_met',
    },
    {
      name: 'wrong channel',
      code: { channels: ['whatsapp', 'landing_page'] },
      reason: 'wrong_channel',
    },
    { name: 'nothing in scope', code: { skuIds: ['sku-other'] }, reason: 'out_of_scope' },
    {
      name: 'someone else’s personal code',
      code: { customerId: 'buyer-2' },
      reason: 'personal_code',
    },
    {
      name: 'free delivery on an order with no charge',
      code: { kind: 'free_delivery' },
      basket: { deliveryChargePoisha: poisha(0) },
      reason: 'nothing_to_discount',
    },
    // The order the checks run in: a paused, expired code is "inactive", the thing
    // that matters most to the person reading it.
    {
      name: 'paused and expired says paused',
      code: { status: 'paused' },
      basket: { on: toIsoDate('2026-12-01') },
      reason: 'inactive',
    },
  ];

  for (const row of refusals) {
    it(`refuses: ${row.name}`, () => {
      expect(
        validatePromo({ ...base, ...row.code }, { ...basket, ...row.basket }, row.usage ?? unused),
      ).toEqual({ ok: false, reason: row.reason });
    });
  }

  it('takes 20% off the whole basket', () => {
    expect(validatePromo(base, basket, unused)).toEqual({
      ok: true,
      discountPoisha: 100_000n,
      deliveryDiscountPoisha: 0n,
    });
  });

  it('takes a percentage only off the lines in scope, by SKU or by category', () => {
    expect(validatePromo({ ...base, categoryIds: [TOPS] }, basket, unused)).toMatchObject({
      ok: true,
      discountPoisha: 30_000n,
    });
    expect(validatePromo({ ...base, skuIds: [SAREE] }, basket, unused)).toMatchObject({
      ok: true,
      discountPoisha: 70_000n,
    });
  });

  it('caps a percentage at the maximum discount', () => {
    expect(
      validatePromo({ ...base, maxDiscountPoisha: poisha(50_000) }, basket, unused),
    ).toMatchObject({ ok: true, discountPoisha: 50_000n });
  });

  it('never takes a flat amount beyond what the eligible lines cost', () => {
    const flat = { ...base, kind: 'flat' as const, valuePoisha: poisha(200_000), skuIds: [SHIRT] };
    expect(validatePromo(flat, basket, unused)).toMatchObject({
      ok: true,
      discountPoisha: 150_000n,
    });
  });

  it('takes free delivery off the delivery charge, not the goods', () => {
    expect(validatePromo({ ...base, kind: 'free_delivery' }, basket, unused)).toEqual({
      ok: true,
      discountPoisha: 0n,
      deliveryDiscountPoisha: 12_000n,
    });
  });

  it('accepts a personal code for its own buyer, and a limit not yet reached', () => {
    expect(
      validatePromo(
        { ...base, customerId: 'buyer-1', totalLimit: 10, perCustomerLimit: 1 },
        basket,
        { total: 9, byCustomer: 0 },
      ).ok,
    ).toBe(true);
  });

  it('is valid on the first and last day of its window', () => {
    expect(validatePromo(base, { ...basket, on: toIsoDate('2026-10-01') }, unused).ok).toBe(true);
    expect(validatePromo(base, { ...basket, on: toIsoDate('2026-10-31') }, unused).ok).toBe(true);
  });

  it('never discounts more than the basket, the cap or the eligible lines', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 0n, max: 5_000_000n }), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.option(fc.bigInt({ min: 1n, max: 2_000_000n }), { nil: null }),
        fc.constantFrom('percent' as const, 'flat' as const),
        (nets, bps, flat, cap, kind) => {
          const lines = nets.map((net, index) => ({
            skuId: `sku-${String(index)}`,
            categoryId: null,
            netPoisha: poisha(net),
          }));
          const verdict = validatePromo(
            {
              ...base,
              kind,
              valueBps: bps,
              valuePoisha: poisha(flat),
              maxDiscountPoisha: cap === null ? null : poisha(cap),
            },
            { ...basket, lines },
            unused,
          );
          if (!verdict.ok) return;
          const total = nets.reduce((a, b) => a + b, 0n);
          expect(verdict.discountPoisha <= total).toBe(true);
          expect(verdict.discountPoisha > 0n).toBe(true);
          if (cap !== null) expect(verdict.discountPoisha <= cap).toBe(true);
          expect(verdict.deliveryDiscountPoisha).toBe(0n);
        },
      ),
    );
  });

  it('matches a code however it was typed', () => {
    expect(normaliseCode('  eid20 ')).toBe('EID20');
  });
});
