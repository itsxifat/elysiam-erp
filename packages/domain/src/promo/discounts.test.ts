import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toIsoDate } from '../dates/index.js';
import { allocate, poisha, type Poisha } from '../money/index.js';
import {
  computeDiscounts,
  evaluateDiscount,
  type Discount,
  type DiscountBasket,
  type DiscountKind,
  type DiscountLine,
} from './discounts.js';
import { oldTakaToPoisha } from './legacy.js';

/**
 * The discount engine's own rules (M35a, D-540), beside the differential test that holds it
 * to the old site's answers: what each kind gives, the window and the first-order rule, and
 * the properties every answer keeps whatever the basket.
 */

const NOW = new Date('2026-10-05T10:00:00+06:00');

const base: Discount = {
  id: 'd-1',
  method: 'automatic',
  code: null,
  kind: 'percent',
  valueBps: 1_000,
  valuePoisha: poisha(0),
  buyQuantity: 0,
  getQuantity: 0,
  getDiscountBps: 10_000,
  tiers: [],
  minOrderPoisha: null,
  minQuantity: null,
  firstOrderOnly: false,
  maxDiscountPoisha: null,
  totalLimit: null,
  perCustomerLimit: null,
  validFrom: null,
  validTo: null,
  startsAt: null,
  endsAt: null,
  channels: [],
  skuIds: [],
  productIds: [],
  categoryIds: [],
  customerId: null,
  allowStacking: false,
  priority: 0,
  status: 'active',
};

function line(skuId: string, unitTaka: number, qty: number, extra: Partial<DiscountLine> = {}) {
  return {
    skuId,
    productId: null,
    categoryIds: [],
    qty,
    netPoisha: poisha(BigInt(unitTaka) * 100n * BigInt(qty)),
    ...extra,
  } satisfies DiscountLine;
}

const basket: DiscountBasket = {
  lines: [line('shirt', 500, 2), line('saree', 2_000, 1)],
  deliveryChargePoisha: poisha(12_000),
  channel: 'website',
  customerId: 'buyer-1',
  isFirstOrder: false,
  on: toIsoDate('2026-10-05'),
  now: NOW,
};

const unused = { total: 0, byCustomer: 0 };

describe('one discount (D-540)', () => {
  it('buy two get one: the cheapest unit in each group of three is free', () => {
    const verdict = evaluateDiscount(
      { ...base, kind: 'buy_x_get_y', buyQuantity: 2, getQuantity: 1 },
      { ...basket, lines: [line('a', 300, 2), line('b', 900, 4)] },
      unused,
    );
    // Six units, two groups: the two cheapest (300, 300) are free.
    expect(verdict).toEqual({ ok: true, discountPoisha: 60_000n, deliveryDiscountPoisha: 0n });
  });

  it('buy-X-get-Y splits a discounted line across its units exactly', () => {
    const verdict = evaluateDiscount(
      { ...base, kind: 'buy_x_get_y', buyQuantity: 1, getQuantity: 1, getDiscountBps: 5_000 },
      // A line of three the agent brought to ৳1,000.01: units of 333.34, 333.34, 333.33.
      { ...basket, lines: [{ ...line('a', 0, 3), netPoisha: poisha(100_001) }] },
      unused,
    );
    // One group of two: the cheapest unit (33,333) at half, rounded once.
    expect(verdict).toEqual({ ok: true, discountPoisha: 16_667n, deliveryDiscountPoisha: 0n });
  });

  it('tiered: the highest tier the whole basket reaches, on the lines in scope', () => {
    const tiered: Discount = {
      ...base,
      kind: 'tiered',
      skuIds: ['saree'],
      tiers: [
        {
          minSubtotalPoisha: poisha(100_000),
          kind: 'percent',
          valueBps: 500,
          valuePoisha: poisha(0),
        },
        {
          minSubtotalPoisha: poisha(300_000),
          kind: 'percent',
          valueBps: 1_000,
          valuePoisha: poisha(0),
        },
        {
          minSubtotalPoisha: poisha(900_000),
          kind: 'flat',
          valueBps: 0,
          valuePoisha: poisha(50_000),
        },
      ],
    };
    // The basket is ৳3,000, so 10% — of the saree alone, ৳2,000.
    expect(evaluateDiscount(tiered, basket, unused)).toMatchObject({ discountPoisha: 20_000n });
    expect(evaluateDiscount(tiered, { ...basket, lines: [line('shirt', 400, 1)] }, unused)).toEqual(
      { ok: false, reason: 'out_of_scope' },
    );
    expect(
      evaluateDiscount(
        { ...tiered, skuIds: [] },
        { ...basket, lines: [line('x', 900, 1)] },
        unused,
      ),
    ).toEqual({ ok: false, reason: 'nothing_to_discount' });
  });

  it('a category discount covers the sub-categories the line carries', () => {
    const lines = [
      line('saree', 2_000, 1, { categoryIds: ['silk', 'sarees'] }),
      line('shirt', 500, 1, { categoryIds: ['tops'] }),
    ];
    expect(
      evaluateDiscount({ ...base, categoryIds: ['sarees'] }, { ...basket, lines }, unused),
    ).toMatchObject({ discountPoisha: 20_000n });
  });

  it('a product discount covers every size of the product', () => {
    const lines = [
      line('panjabi-m', 1_000, 1, { productId: 'panjabi' }),
      line('panjabi-l', 1_000, 2, { productId: 'panjabi' }),
      line('shirt', 500, 1, { productId: 'shirt' }),
    ];
    expect(
      evaluateDiscount({ ...base, productIds: ['panjabi'] }, { ...basket, lines }, unused),
    ).toMatchObject({ discountPoisha: 30_000n });
  });

  const refusals: readonly {
    name: string;
    discount: Partial<Discount>;
    basket?: Partial<DiscountBasket>;
    reason: string;
  }[] = [
    {
      name: 'not started',
      discount: { startsAt: new Date(NOW.getTime() + 1) },
      reason: 'not_yet_valid',
    },
    { name: 'ended', discount: { endsAt: new Date(NOW.getTime() - 1) }, reason: 'expired' },
    { name: 'a returning buyer', discount: { firstOrderOnly: true }, reason: 'first_order_only' },
    { name: 'too few units', discount: { minQuantity: 4 }, reason: 'min_quantity_not_met' },
    {
      name: 'a minimum not reached',
      discount: { minOrderPoisha: poisha(300_001) },
      reason: 'min_order_not_met',
    },
    {
      name: 'buy-X-get-Y without a full group',
      discount: { kind: 'buy_x_get_y', buyQuantity: 3, getQuantity: 1 },
      reason: 'nothing_to_discount',
    },
    {
      name: 'free delivery scoped to something not in the basket',
      discount: { kind: 'free_delivery', skuIds: ['other'] },
      reason: 'out_of_scope',
    },
  ];
  for (const row of refusals) {
    it(`refuses: ${row.name}`, () => {
      expect(
        evaluateDiscount({ ...base, ...row.discount }, { ...basket, ...row.basket }, unused),
      ).toEqual({
        ok: false,
        reason: row.reason,
      });
    });
  }

  it('is live at both ends of an instant window', () => {
    const window = { startsAt: NOW, endsAt: NOW };
    expect(evaluateDiscount({ ...base, ...window }, basket, unused).ok).toBe(true);
  });

  it('a first-order discount applies to a first order', () => {
    expect(
      evaluateDiscount({ ...base, firstOrderOnly: true }, { ...basket, isFirstOrder: true }, unused)
        .ok,
    ).toBe(true);
  });

  it('caps any kind at its maximum, and free delivery at its maximum off the charge', () => {
    expect(
      evaluateDiscount(
        {
          ...base,
          kind: 'buy_x_get_y',
          buyQuantity: 1,
          getQuantity: 1,
          maxDiscountPoisha: poisha(10_000),
        },
        basket,
        unused,
      ),
    ).toMatchObject({ discountPoisha: 10_000n });
    expect(
      evaluateDiscount(
        { ...base, kind: 'free_delivery', maxDiscountPoisha: poisha(5_000) },
        basket,
        unused,
      ),
    ).toEqual({ ok: true, discountPoisha: 0n, deliveryDiscountPoisha: 5_000n });
  });
});

describe('several discounts (D-540)', () => {
  const code = (id: string, word: string, fields: Partial<Discount>): Discount => ({
    ...base,
    id,
    method: 'code',
    code: word,
    ...fields,
  });

  it('applies a code only when it was typed, and reports one that does not apply', () => {
    const result = computeDiscounts({
      discounts: [
        code('c1', 'EID', { valueBps: 2_000 }),
        code('c2', 'PUJA', { minOrderPoisha: poisha(1_000_000) }),
      ],
      basket,
      codes: [' puja '],
      usage: new Map(),
    });
    expect(result.applied).toEqual([]);
    expect(result.refused).toEqual([{ code: 'PUJA', reason: 'min_order_not_met' }]);
  });

  it('two free deliveries in a stack waive the charge once', () => {
    const result = computeDiscounts({
      discounts: [
        { ...base, id: 'a', kind: 'free_delivery', allowStacking: true },
        { ...base, id: 'b', kind: 'free_delivery', allowStacking: true },
        { ...base, id: 'c', kind: 'flat', valuePoisha: poisha(5_000), allowStacking: true },
      ],
      basket,
      codes: [],
      usage: new Map(),
    });
    expect(result.deliveryDiscountPoisha).toBe(12_000n);
    expect(result.discountPoisha).toBe(5_000n);
    expect(result.applied.map((entry) => entry.discount.id)).toEqual(['a', 'c']);
  });

  it('a stack never takes more than the basket, highest priority first', () => {
    const result = computeDiscounts({
      discounts: [
        { ...base, id: 'low', valueBps: 9_000, allowStacking: true, priority: 1 },
        {
          ...base,
          id: 'high',
          kind: 'flat',
          valuePoisha: poisha(250_000),
          allowStacking: true,
          priority: 5,
        },
      ],
      basket,
      codes: [],
      usage: new Map(),
    });
    expect(result.discountPoisha).toBe(300_000n);
    expect(result.applied.map((entry) => [entry.discount.id, entry.discountPoisha])).toEqual([
      ['high', 250_000n],
      ['low', 50_000n],
    ]);
  });

  it('ignores a code’s usage it has not been told about, and counts what it has', () => {
    const limited = code('c1', 'ONCE', { totalLimit: 1 });
    const result = computeDiscounts({
      discounts: [limited],
      basket,
      codes: ['ONCE'],
      usage: new Map([['c1', { total: 1, byCustomer: 0 }]]),
    });
    expect(result.refused).toEqual([{ code: 'ONCE', reason: 'limit_reached' }]);
  });
});

// --- properties --------------------------------------------------------------------------

const KINDS: readonly DiscountKind[] = [
  'percent',
  'flat',
  'free_delivery',
  'buy_x_get_y',
  'tiered',
];

const discountArb: fc.Arbitrary<Discount> = fc
  .record({
    id: fc.uuid(),
    automatic: fc.boolean(),
    kind: fc.constantFrom(...KINDS),
    valueBps: fc.integer({ min: 1, max: 10_000 }),
    valuePoisha: fc.bigInt({ min: 1n, max: 5_000_000n }),
    buy: fc.integer({ min: 0, max: 3 }),
    get: fc.integer({ min: 0, max: 3 }),
    getBps: fc.integer({ min: 1, max: 10_000 }),
    tiers: fc.array(
      fc.record({
        min: fc.bigInt({ min: 0n, max: 3_000_000n }),
        percent: fc.boolean(),
        bps: fc.integer({ min: 1, max: 10_000 }),
        flat: fc.bigInt({ min: 1n, max: 2_000_000n }),
      }),
      { maxLength: 3 },
    ),
    cap: fc.option(fc.bigInt({ min: 1n, max: 1_000_000n }), { nil: null }),
    skuScope: fc.subarray(['s0', 's1', 's2', 's3'], { maxLength: 2 }),
    stack: fc.boolean(),
    priority: fc.integer({ min: -3, max: 3 }),
  })
  .map((raw): Discount => ({
    ...base,
    id: raw.id,
    method: raw.automatic ? 'automatic' : 'code',
    code: raw.automatic ? null : `C${raw.id.slice(0, 6).toUpperCase()}`,
    kind: raw.kind,
    valueBps: raw.valueBps,
    valuePoisha: poisha(raw.valuePoisha),
    buyQuantity: raw.buy,
    getQuantity: raw.get,
    getDiscountBps: raw.getBps,
    tiers: raw.tiers.map((tier) => ({
      minSubtotalPoisha: poisha(tier.min),
      kind: tier.percent ? ('percent' as const) : ('flat' as const),
      valueBps: tier.bps,
      valuePoisha: poisha(tier.flat),
    })),
    maxDiscountPoisha: raw.cap === null ? null : poisha(raw.cap),
    skuIds: raw.skuScope,
    allowStacking: raw.stack,
    priority: raw.priority,
  }));

const basketArb: fc.Arbitrary<DiscountBasket> = fc
  .record({
    lines: fc.array(
      fc.record({
        sku: fc.constantFrom('s0', 's1', 's2', 's3'),
        qty: fc.integer({ min: 1, max: 6 }),
        net: fc.bigInt({ min: 0n, max: 2_000_000n }),
      }),
      { minLength: 1, maxLength: 5 },
    ),
    delivery: fc.bigInt({ min: 0n, max: 20_000n }),
  })
  .map((raw) => ({
    ...basket,
    lines: raw.lines.map((entry) => ({
      skuId: entry.sku,
      productId: null,
      categoryIds: [],
      qty: entry.qty,
      netPoisha: poisha(entry.net),
    })),
    deliveryChargePoisha: poisha(raw.delivery),
  }));

function everyCode(discounts: readonly Discount[]): string[] {
  return discounts.flatMap((discount) => (discount.code === null ? [] : [discount.code]));
}

describe('properties (D-540)', () => {
  it('a discount is never negative and never more than the lines it covers', () => {
    fc.assert(
      fc.property(discountArb, basketArb, (discount, cart) => {
        const verdict = evaluateDiscount(discount, cart, unused);
        if (!verdict.ok) return;
        const scope = discount.skuIds;
        const covered = cart.lines
          .filter((entry) => scope.length === 0 || scope.includes(entry.skuId))
          .reduce((total, entry) => total + entry.netPoisha, 0n);
        expect(verdict.discountPoisha >= 0n && verdict.deliveryDiscountPoisha >= 0n).toBe(true);
        expect(verdict.discountPoisha <= covered).toBe(true);
        expect(verdict.discountPoisha + verdict.deliveryDiscountPoisha > 0n).toBe(true);
        if (discount.maxDiscountPoisha !== null) {
          expect(
            verdict.discountPoisha + verdict.deliveryDiscountPoisha <= discount.maxDiscountPoisha,
          ).toBe(true);
        }
      }),
      { numRuns: 2_000 },
    );
  });

  it('free delivery only ever comes off the delivery charge, and nothing else touches it', () => {
    fc.assert(
      fc.property(fc.array(discountArb, { maxLength: 6 }), basketArb, (discounts, cart) => {
        const result = computeDiscounts({
          discounts,
          basket: cart,
          codes: everyCode(discounts),
          usage: new Map(),
        });
        expect(result.deliveryDiscountPoisha <= cart.deliveryChargePoisha).toBe(true);
        for (const entry of result.applied) {
          if (entry.discount.kind === 'free_delivery') expect(entry.discountPoisha).toBe(0n);
          else expect(entry.deliveryDiscountPoisha).toBe(0n);
        }
      }),
      { numRuns: 2_000 },
    );
  });

  it('the result never takes more than the basket, and every part gives something', () => {
    fc.assert(
      fc.property(fc.array(discountArb, { maxLength: 6 }), basketArb, (discounts, cart) => {
        const result = computeDiscounts({
          discounts,
          basket: cart,
          codes: everyCode(discounts),
          usage: new Map(),
        });
        const subtotal = cart.lines.reduce((total, entry) => total + entry.netPoisha, 0n);
        expect(result.discountPoisha >= 0n && result.discountPoisha <= subtotal).toBe(true);
        for (const entry of result.applied) {
          expect(entry.discountPoisha + entry.deliveryDiscountPoisha > 0n).toBe(true);
        }
        const parts = result.applied.reduce((total, entry) => total + entry.discountPoisha, 0n);
        expect(parts).toBe(result.discountPoisha);
      }),
      { numRuns: 2_000 },
    );
  });

  it('stacking is never worse than the best single discount', () => {
    fc.assert(
      fc.property(fc.array(discountArb, { maxLength: 6 }), basketArb, (discounts, cart) => {
        const result = computeDiscounts({
          discounts,
          basket: cart,
          codes: everyCode(discounts),
          usage: new Map(),
        });
        let best: Poisha = poisha(0);
        for (const discount of discounts) {
          const verdict = evaluateDiscount(discount, cart, unused);
          if (verdict.ok) {
            const value = poisha(verdict.discountPoisha + verdict.deliveryDiscountPoisha);
            if (value > best) best = value;
          }
        }
        expect(result.discountPoisha + result.deliveryDiscountPoisha >= best).toBe(true);
      }),
      { numRuns: 2_000 },
    );
  });

  it('is deterministic, whatever order the discounts arrive in', () => {
    fc.assert(
      fc.property(
        fc
          .array(discountArb, { maxLength: 6 })
          .chain((discounts) =>
            fc.tuple(
              fc.constant(discounts),
              fc.shuffledSubarray(discounts, { minLength: discounts.length }),
            ),
          ),
        basketArb,
        ([discounts, shuffled], cart) => {
          const codes = everyCode(discounts);
          const first = computeDiscounts({ discounts, basket: cart, codes, usage: new Map() });
          const again = computeDiscounts({ discounts, basket: cart, codes, usage: new Map() });
          const reordered = computeDiscounts({
            discounts: shuffled,
            basket: cart,
            codes,
            usage: new Map(),
          });
          const view = (result: typeof first) =>
            result.applied.map((entry) => [
              entry.discount.id,
              entry.discountPoisha,
              entry.deliveryDiscountPoisha,
            ]);
          expect(view(again)).toEqual(view(first));
          expect(view(reordered)).toEqual(view(first));
          expect(reordered.discountPoisha).toBe(first.discountPoisha);
        },
      ),
      { numRuns: 1_000 },
    );
  });
});

describe('a stack takes each discount off its own lines (ledger audit W1)', () => {
  it('two ৳500 discounts on a ৳600 line give ৳600, and nothing off the shirt they skip', () => {
    const result = computeDiscounts({
      discounts: [
        {
          ...base,
          id: 'a',
          kind: 'flat',
          valuePoisha: poisha(50_000),
          skuIds: ['panjabi'],
          allowStacking: true,
        },
        {
          ...base,
          id: 'b',
          kind: 'flat',
          valuePoisha: poisha(50_000),
          skuIds: ['panjabi'],
          allowStacking: true,
        },
      ],
      basket: { ...basket, lines: [line('panjabi', 600, 1), line('shirt', 2_000, 1)] },
      codes: [],
      usage: new Map(),
    });
    expect(result.discountPoisha).toBe(60_000n);
    expect(result.applied.map((entry) => [entry.discount.id, entry.discountPoisha])).toEqual([
      ['a', 50_000n],
      ['b', 10_000n],
    ]);
  });

  it('never takes more off any set of lines than those lines cost', () => {
    fc.assert(
      fc.property(fc.array(discountArb, { maxLength: 6 }), basketArb, (discounts, cart) => {
        const stackable = discounts.map((discount) => ({ ...discount, allowStacking: true }));
        const result = computeDiscounts({
          discounts: stackable,
          basket: cart,
          codes: everyCode(stackable),
          usage: new Map(),
        });
        const scopeOf = (discount: Discount) =>
          cart.lines
            .map((entry, index) => ({ entry, index }))
            .filter(
              ({ entry }) => discount.skuIds.length === 0 || discount.skuIds.includes(entry.skuId),
            )
            .map(({ index }) => index);
        // Every subset of the lines (there are at most five): what the discounts limited to
        // it took is no more than it costs.
        for (let mask = 1; mask < 1 << cart.lines.length; mask += 1) {
          const inSet = (index: number) => (mask & (1 << index)) !== 0;
          const cost = cart.lines.reduce(
            (total, entry, index) => (inSet(index) ? total + entry.netPoisha : total),
            0n,
          );
          const taken = result.applied
            .filter((entry) => scopeOf(entry.discount).every(inSet))
            .reduce((total, entry) => total + entry.discountPoisha, 0n);
          expect(taken <= cost).toBe(true);
        }
      }),
      { numRuns: 1_000 },
    );
  });
});

describe('buy X get Y counts units without listing them (ledger audit W13)', () => {
  /** The plain way: every unit, split with `allocate`, sorted, the cheapest taken. */
  function byExpansion(lines: readonly DiscountLine[], buy: number, get: number): bigint {
    const units = lines
      .flatMap((entry) =>
        allocate(
          entry.netPoisha,
          Array.from({ length: entry.qty }, () => 1),
        ),
      )
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const sets = Math.floor(units.length / (buy + get));
    return units.slice(0, sets * get).reduce((total, unit) => total + unit, 0n);
  }

  it('gives what listing every unit would', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            qty: fc.integer({ min: 1, max: 25 }),
            net: fc.bigInt({ min: 0n, max: 3_000_000n }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 4 }),
        (raw, buy, get) => {
          const lines = raw.map((entry, index) => ({
            ...line(`s${String(index)}`, 0, entry.qty),
            netPoisha: poisha(entry.net),
          }));
          const verdict = evaluateDiscount(
            { ...base, kind: 'buy_x_get_y', buyQuantity: buy, getQuantity: get },
            { ...basket, lines },
            unused,
          );
          const expected = byExpansion(lines, buy, get);
          if (expected === 0n) expect(verdict.ok).toBe(false);
          else expect(verdict).toMatchObject({ ok: true, discountPoisha: expected });
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it('prices a line of ten thousand units at once', () => {
    const verdict = evaluateDiscount(
      { ...base, kind: 'buy_x_get_y', buyQuantity: 1, getQuantity: 1 },
      { ...basket, lines: [{ ...line('bulk', 0, 10_000), netPoisha: poisha(1_000_000_003) }] },
      unused,
    );
    // 10,000 units of ৳1,000.00, three of them a poisha dearer: the 5,000 cheapest are free.
    expect(verdict).toMatchObject({ ok: true, discountPoisha: 500_000_000n });
  });
});

describe('the old site’s float amounts', () => {
  it('reads float noise as the amount it meant (ledger audit W9)', () => {
    expect(oldTakaToPoisha(0.1 + 0.2)).toBe(30n);
    expect(oldTakaToPoisha(99.99)).toBe(9_999n);
    expect(oldTakaToPoisha(1e21)).toBe(0n);
    expect(oldTakaToPoisha(-5)).toBe(0n);
  });
});
