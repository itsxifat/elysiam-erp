import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { businessDate } from '../dates/index.js';
import { poisha } from '../money/index.js';
import {
  computeDiscounts,
  evaluateDiscount,
  type DiscountBasket,
  type DiscountReason,
  type DiscountsResult,
} from './discounts.js';
import { discountFromOldSite } from './legacy.js';
import {
  computeDiscounts as oldComputeDiscounts,
  type OracleDiscount,
  type OracleItem,
  type OracleResult,
} from './oracle/old-site-discounts.js';

/**
 * M35a acceptance check 2: the ported engine gives the old website's answer (D-540).
 *
 * The old engine (`oracle/old-site-discounts.js`, copied verbatim) and the port run on the
 * same carts and discounts, generated in whole taka. The old engine's answer is in float
 * taka rounded to two decimals; read as poisha it must equal the port's, with exactly three
 * documented exceptions and nothing looser:
 *
 * 1. **Free delivery on a cart with no delivery charge.** The old engine applied it at no
 *    value; the port refuses it as `nothing_to_discount` (M16's desk rule). The money is the
 *    same; only the report differs.
 * 2. **A stack the old engine valued wrongly.** It summed a stack's members, counting the
 *    delivery charge once per free-shipping member and counting goods discounts beyond the
 *    basket. Where that made it pick a stack, the port values the stack as what it gives
 *    and saves the buyer at least as much.
 * 3. **An exact half poisha** (fractional percents only). Float taka could round it either
 *    way; the port rounds half away from zero. At most one poisha per discount.
 *
 * And ties: between two choices worth exactly the same, the old engine's float sums could
 * tip one way; the port takes the stack on a tie, as the old rule meant. The money agrees.
 */

const NOW = new Date('2026-10-05T10:00:00+06:00');
const DAY = 86_400_000;
const PRODUCTS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] as const;
const CATEGORIES = ['c1', 'c2', 'c3', 'c4'] as const;

const OLD_REASONS: Readonly<Record<string, DiscountReason>> = {
  Inactive: 'inactive',
  'Not started yet': 'not_yet_valid',
  Expired: 'expired',
  'Usage limit reached': 'limit_reached',
  'Valid on first order only': 'first_order_only',
  'No eligible items in cart': 'out_of_scope',
  'No discount for this cart': 'nothing_to_discount',
};

function oldReason(text: string): DiscountReason {
  if (text.startsWith('Spend at least')) return 'min_order_not_met';
  if (text.startsWith('Add at least')) return 'min_quantity_not_met';
  const reason = OLD_REASONS[text];
  if (reason === undefined) throw new Error(`An old reason this test does not know: ${text}`);
  return reason;
}

/** Float taka, already rounded to two decimals by the old engine, as poisha. */
function takaToPoisha(taka: number): bigint {
  return BigInt(Math.round(taka * 100));
}

interface Case {
  readonly discounts: OracleDiscount[];
  readonly items: OracleItem[];
  readonly shippingFee: number;
  readonly codes: string[];
  readonly isFirstOrder: boolean;
}

/** The old site's candidate order: the caller loaded them, here by priority then id. */
function sorted(discounts: readonly OracleDiscount[]): OracleDiscount[] {
  return [...discounts].sort((a, b) =>
    a.priority !== b.priority ? b.priority - a.priority : a._id < b._id ? -1 : 1,
  );
}

function basketOf(input: Case): DiscountBasket {
  return {
    lines: input.items.map((item, index) => ({
      skuId: `sku-${String(index)}`,
      productId: item.productId,
      categoryIds: item.categoryIds,
      qty: item.quantity,
      netPoisha: poisha(BigInt(item.price) * 100n * BigInt(item.quantity)),
    })),
    deliveryChargePoisha: poisha(BigInt(input.shippingFee) * 100n),
    channel: 'website',
    customerId: null,
    isFirstOrder: input.isFirstOrder,
    on: businessDate(NOW),
    now: NOW,
  };
}

function runBoth(input: Case): { old: OracleResult; port: DiscountsResult } {
  const discounts = sorted(input.discounts);
  const old = oldComputeDiscounts({
    discounts,
    items: input.items,
    shippingFee: input.shippingFee,
    codes: input.codes,
    isFirstOrder: input.isFirstOrder,
    now: NOW,
  });
  const port = computeDiscounts({
    discounts: discounts.map((doc) => discountFromOldSite(doc)),
    basket: basketOf(input),
    codes: input.codes,
    usage: new Map(discounts.map((doc) => [doc._id, { total: doc.usedCount, byCustomer: 0 }])),
  });
  return { old, port };
}

/** What the old answer actually saved: the capped goods total, and the fee if waived. */
function oldSaving(old: OracleResult, shippingFee: number): bigint {
  return takaToPoisha(old.discountTotal) + (old.freeShipping ? BigInt(shippingFee) * 100n : 0n);
}

function portSaving(port: DiscountsResult): bigint {
  return port.discountPoisha + port.deliveryDiscountPoisha;
}

/** Exception 2: the old engine chose a stack whose sum overstated what it gave. */
function oldStackMisvalued(old: OracleResult, input: Case): boolean {
  if (old.applied.length < 2) return false;
  const subtotal = input.items.reduce((total, item) => total + item.price * item.quantity, 0);
  const goods = old.applied.reduce((total, entry) => total + entry.amount, 0);
  const waivers = old.applied.filter((entry) => entry.freeShipping).length;
  return goods > subtotal || (input.shippingFee > 0 && waivers >= 2);
}

/** Exception 1: a free-shipping discount was a candidate on a cart with no delivery charge. */
function freeShippingAtNoCharge(input: Case): boolean {
  if (input.shippingFee !== 0) return false;
  const typed = new Set(input.codes.map((code) => code.trim().toUpperCase()));
  return input.discounts.some(
    (doc) =>
      doc.type === 'free_shipping' &&
      (doc.method === 'automatic' || (doc.code != null && typed.has(doc.code.toUpperCase()))),
  );
}

/** The best single candidate's value and the stack's true value, by the port's own rules. */
function choiceValues(input: Case): { single: bigint; stack: bigint; stackables: number } {
  const basket = basketOf(input);
  const typed = new Set(input.codes.map((code) => code.trim().toUpperCase()));
  let single = 0n;
  let goods = 0n;
  let waiver = 0n;
  let stackables = 0;
  for (const doc of input.discounts) {
    const discount = discountFromOldSite(doc);
    if (discount.method === 'code' && (discount.code === null || !typed.has(discount.code))) {
      continue;
    }
    const verdict = evaluateDiscount(discount, basket, { total: doc.usedCount, byCustomer: 0 });
    if (!verdict.ok) continue;
    const value = verdict.discountPoisha + verdict.deliveryDiscountPoisha;
    if (value > single) single = value;
    if (discount.allowStacking) {
      stackables += 1;
      goods += verdict.discountPoisha;
      if (verdict.deliveryDiscountPoisha > waiver) waiver = verdict.deliveryDiscountPoisha;
    }
  }
  const subtotal = basket.lines.reduce((total, line) => total + line.netPoisha, 0n);
  return { single, stack: (goods > subtotal ? subtotal : goods) + waiver, stackables };
}

function refusedOf(port: DiscountsResult, input: Case): string[] {
  const waivers = new Set(
    input.discounts.filter((doc) => doc.type === 'free_shipping').map((doc) => doc.code),
  );
  return port.refused
    .filter(
      // Exception 1's report: the old engine applied these at no value instead.
      (entry) =>
        !(
          input.shippingFee === 0 &&
          entry.reason === 'nothing_to_discount' &&
          waivers.has(entry.code)
        ),
    )
    .map((entry) => `${entry.code}:${entry.reason}`)
    .sort();
}

function oldRefusedOf(old: OracleResult): string[] {
  return old.rejected.map((entry) => `${entry.code}:${oldReason(entry.reason)}`).sort();
}

/** The whole comparison, for integer percents (no half poisha can arise). */
function assertSameAnswer(input: Case): void {
  const { old, port } = runBoth(input);
  const misvalued = oldStackMisvalued(old, input);
  if (misvalued) {
    expect(portSaving(port)).toBeGreaterThanOrEqual(oldSaving(old, input.shippingFee));
  } else {
    expect(portSaving(port)).toBe(oldSaving(old, input.shippingFee));
  }

  expect(refusedOf(port, input)).toEqual(oldRefusedOf(old));
  if (misvalued || freeShippingAtNoCharge(input)) return;

  const oldApplied = old.applied.map((entry) => ({
    id: entry.discountId,
    goods: takaToPoisha(entry.amount),
    waives: entry.freeShipping,
  }));
  const portApplied = port.applied.map((entry) => ({
    id: entry.discount.id,
    goods: BigInt(entry.discountPoisha),
    waives: entry.deliveryDiscountPoisha > 0n,
  }));
  if (JSON.stringify(oldApplied, bigintText) !== JSON.stringify(portApplied, bigintText)) {
    // Only a tie may choose differently: the stack worth exactly the best single.
    const values = choiceValues(input);
    expect(values.stackables).toBeGreaterThanOrEqual(2);
    expect(values.stack).toBe(values.single);
  }
}

function bigintText(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

// --- generators ------------------------------------------------------------------------

const item = fc.record({
  productId: fc.constantFrom(...PRODUCTS),
  categoryIds: fc.subarray([...CATEGORIES], { minLength: 0, maxLength: 2 }),
  price: fc.integer({ min: 1, max: 5_000 }),
  quantity: fc.integer({ min: 1, max: 5 }),
});

function discountArb(percent: fc.Arbitrary<number>) {
  return fc
    .record({
      method: fc.constantFrom('code' as const, 'automatic' as const),
      type: fc.constantFrom(
        'percentage' as const,
        'fixed' as const,
        'free_shipping' as const,
        'buy_x_get_y' as const,
        'tiered' as const,
      ),
      percent,
      fixed: fc.integer({ min: 0, max: 3_000 }),
      maxDiscount: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 2_000 })),
      buyQuantity: fc.integer({ min: 0, max: 3 }),
      getQuantity: fc.integer({ min: 0, max: 3 }),
      getDiscountPercent: fc.oneof(fc.constant(0), percent),
      tiers: fc.array(
        fc.record({
          minSubtotal: fc.integer({ min: 0, max: 20_000 }),
          type: fc.constantFrom('percentage' as const, 'fixed' as const),
          percent,
          fixed: fc.integer({ min: 1, max: 3_000 }),
        }),
        { maxLength: 3 },
      ),
      appliesTo: fc.constantFrom('all' as const, 'products' as const, 'categories' as const),
      products: fc.subarray([...PRODUCTS], { maxLength: 3 }),
      categories: fc.subarray([...CATEGORIES], { maxLength: 2 }),
      minSubtotal: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 20_000 })),
      minQuantity: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 10 })),
      firstOrderOnly: fc.boolean(),
      usageLimit: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 5 })),
      usedCount: fc.integer({ min: 0, max: 6 }),
      startsInDays: fc.option(fc.integer({ min: -10, max: 3 }), { nil: null }),
      endsInDays: fc.option(fc.integer({ min: -3, max: 10 }), { nil: null }),
      allowStacking: fc.boolean(),
      priority: fc.integer({ min: -2, max: 2 }),
      // Mostly switched on: an inactive discount only ever says so.
      active: fc.integer({ min: 0, max: 9 }).map((roll) => roll > 1),
    })
    .map((raw): Omit<OracleDiscount, '_id' | 'code' | 'title'> => ({
      method: raw.method,
      type: raw.type,
      value: raw.type === 'fixed' ? raw.fixed : raw.percent,
      maxDiscount: raw.maxDiscount,
      buyQuantity: raw.buyQuantity,
      getQuantity: raw.getQuantity,
      getDiscountPercent: raw.getDiscountPercent,
      tiers: raw.tiers.map((tier) => ({
        minSubtotal: tier.minSubtotal,
        type: tier.type,
        value: tier.type === 'fixed' ? tier.fixed : tier.percent,
      })),
      appliesTo: raw.appliesTo,
      products: raw.products,
      categories: raw.categories,
      minSubtotal: raw.minSubtotal,
      minQuantity: raw.minQuantity,
      firstOrderOnly: raw.firstOrderOnly,
      usageLimit: raw.usageLimit,
      usedCount: raw.usedCount,
      startsAt: raw.startsInDays === null ? null : new Date(NOW.getTime() + raw.startsInDays * DAY),
      endsAt: raw.endsInDays === null ? null : new Date(NOW.getTime() + raw.endsInDays * DAY),
      allowStacking: raw.allowStacking,
      priority: raw.priority,
      active: raw.active,
    }));
}

function caseArb(percent: fc.Arbitrary<number>): fc.Arbitrary<Case> {
  return fc
    .record({
      items: fc.array(item, { minLength: 1, maxLength: 6 }),
      discounts: fc.array(discountArb(percent), { minLength: 1, maxLength: 6 }),
      shippingFee: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 200 })),
      isFirstOrder: fc.boolean(),
      typed: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
      sloppy: fc.boolean(),
      unknown: fc.boolean(),
    })
    .map((raw) => {
      const discounts: OracleDiscount[] = raw.discounts.map((doc, index) => ({
        ...doc,
        _id: `d${String(index)}`,
        title: `Discount ${String(index)}`,
        code: doc.method === 'code' ? `CODE${String(index)}` : null,
      }));
      const codes = discounts
        .filter((doc, index) => doc.code != null && raw.typed[index] === true)
        .map((doc) => (raw.sloppy ? ` ${(doc.code ?? '').toLowerCase()} ` : (doc.code ?? '')));
      if (raw.unknown) codes.push('NOSUCHCODE');
      return {
        items: raw.items.map((entry) => ({ ...entry, categoryIds: [...entry.categoryIds] })),
        discounts,
        shippingFee: raw.shippingFee,
        codes,
        isFirstOrder: raw.isFirstOrder,
      };
    });
}

// --- the checks --------------------------------------------------------------------------

describe('the ported engine against the old site’s (M35a check 2, D-540)', () => {
  it('agrees to the poisha on generated carts with whole percents', () => {
    fc.assert(
      fc.property(caseArb(fc.integer({ min: 1, max: 100 })), (input) => {
        assertSameAnswer(input);
      }),
      { numRuns: 5_000 },
    );
  });

  it('agrees within a poisha per discount where a fractional percent meets a half poisha', () => {
    const fractional = fc
      .tuple(fc.integer({ min: 0, max: 99 }), fc.constantFrom(25, 50, 75))
      .map(([whole, hundredths]) => whole + hundredths / 100);
    fc.assert(
      fc.property(caseArb(fractional), (input) => {
        const { old, port } = runBoth(input);
        const slack = BigInt(input.discounts.length);
        const before = oldSaving(old, input.shippingFee);
        const after = portSaving(port);
        expect(after).toBeGreaterThanOrEqual(before - slack);
        if (!oldStackMisvalued(old, input)) {
          expect(after).toBeLessThanOrEqual(before + slack);
        }
      }),
      { numRuns: 2_000 },
    );
  });

  /*
   * Named cases: what the old admin offered and what a shopper saw. Each runs through both
   * engines; the expected figure is the old site's own answer, written down.
   */
  const base: Omit<OracleDiscount, '_id' | 'title' | 'type' | 'method'> = {
    code: null,
    value: 0,
    maxDiscount: 0,
    buyQuantity: 0,
    getQuantity: 0,
    getDiscountPercent: 100,
    tiers: [],
    appliesTo: 'all',
    products: [],
    categories: [],
    minSubtotal: 0,
    minQuantity: 0,
    firstOrderOnly: false,
    usageLimit: 0,
    usedCount: 0,
    startsAt: null,
    endsAt: null,
    allowStacking: false,
    priority: 0,
    active: true,
  };
  const shirt = (price: number, quantity = 1): OracleItem => ({
    productId: 'p1',
    categoryIds: ['c1'],
    price,
    quantity,
  });
  const saree = (price: number, quantity = 1): OracleItem => ({
    productId: 'p2',
    categoryIds: ['c2', 'c-parent'],
    price,
    quantity,
  });

  const named: readonly { name: string; input: Case; saving: bigint; applied: string[] }[] = [
    {
      name: 'EID20: 20% off with a ৳500 cap, on ৳4,000',
      input: {
        discounts: [
          {
            ...base,
            _id: 'eid',
            title: 'Eid',
            method: 'code',
            code: 'EID20',
            type: 'percentage',
            value: 20,
            maxDiscount: 500,
          },
        ],
        items: [shirt(2_000, 2)],
        shippingFee: 60,
        codes: ['eid20'],
        isFirstOrder: false,
      },
      saving: 50_000n,
      applied: ['eid'],
    },
    {
      name: 'buy 2 get 1 free: the cheapest of three is free',
      input: {
        discounts: [
          {
            ...base,
            _id: 'b2g1',
            title: 'Buy 2 get 1',
            method: 'automatic',
            type: 'buy_x_get_y',
            buyQuantity: 2,
            getQuantity: 1,
          },
        ],
        items: [shirt(800), shirt(500), saree(1_200)],
        shippingFee: 60,
        codes: [],
        isFirstOrder: false,
      },
      saving: 50_000n,
      applied: ['b2g1'],
    },
    {
      name: 'buy 1 get 1 at half price, on four units',
      input: {
        discounts: [
          {
            ...base,
            _id: 'bogo',
            title: 'BOGO 50',
            method: 'automatic',
            type: 'buy_x_get_y',
            buyQuantity: 1,
            getQuantity: 1,
            getDiscountPercent: 50,
          },
        ],
        items: [shirt(700, 3), saree(1_000)],
        shippingFee: 0,
        codes: [],
        isFirstOrder: false,
      },
      // Two sets; the two cheapest units (700, 700) at half price.
      saving: 70_000n,
      applied: ['bogo'],
    },
    {
      name: 'spend more save more: the highest tier reached',
      input: {
        discounts: [
          {
            ...base,
            _id: 'tier',
            title: 'Tiers',
            method: 'automatic',
            type: 'tiered',
            tiers: [
              { minSubtotal: 2_000, type: 'percentage', value: 5 },
              { minSubtotal: 5_000, type: 'percentage', value: 10 },
              { minSubtotal: 10_000, type: 'fixed', value: 1_500 },
            ],
          },
        ],
        items: [saree(3_000, 2)],
        shippingFee: 100,
        codes: [],
        isFirstOrder: false,
      },
      saving: 60_000n,
      applied: ['tier'],
    },
    {
      name: 'free shipping over ৳1,500, automatic',
      input: {
        discounts: [
          {
            ...base,
            _id: 'ship',
            title: 'Free shipping',
            method: 'automatic',
            type: 'free_shipping',
            minSubtotal: 1_500,
          },
        ],
        items: [shirt(900, 2)],
        shippingFee: 130,
        codes: [],
        isFirstOrder: false,
      },
      saving: 13_000n,
      applied: ['ship'],
    },
    {
      name: 'first order only, for a returning buyer: refused, the automatic one applies',
      input: {
        discounts: [
          {
            ...base,
            _id: 'first',
            title: 'Welcome',
            method: 'code',
            code: 'WELCOME',
            type: 'fixed',
            value: 300,
            firstOrderOnly: true,
          },
          {
            ...base,
            _id: 'auto5',
            title: 'Five off',
            method: 'automatic',
            type: 'percentage',
            value: 5,
          },
        ],
        items: [shirt(2_000)],
        shippingFee: 60,
        codes: ['WELCOME'],
        isFirstOrder: false,
      },
      saving: 10_000n,
      applied: ['auto5'],
    },
    {
      name: 'a code and an automatic discount that stack, together beating either',
      input: {
        discounts: [
          {
            ...base,
            _id: 'auto10',
            title: 'Ten off',
            method: 'automatic',
            type: 'percentage',
            value: 10,
            allowStacking: true,
          },
          {
            ...base,
            _id: 'flat200',
            title: 'Flat 200',
            method: 'code',
            code: 'FLAT200',
            type: 'fixed',
            value: 200,
            allowStacking: true,
          },
          {
            ...base,
            _id: 'big',
            title: 'Fifteen off, alone',
            method: 'automatic',
            type: 'percentage',
            value: 15,
          },
        ],
        items: [saree(2_500)],
        shippingFee: 60,
        codes: ['FLAT200'],
        isFirstOrder: false,
      },
      // 10% (250) + 200 = 450 beats 15% (375).
      saving: 45_000n,
      applied: ['auto10', 'flat200'],
    },
    {
      name: 'a stack worth exactly the best single discount: the stack applies',
      input: {
        discounts: [
          {
            ...base,
            _id: 'a100',
            title: 'A',
            method: 'automatic',
            type: 'fixed',
            value: 100,
            allowStacking: true,
          },
          {
            ...base,
            _id: 'b100',
            title: 'B',
            method: 'code',
            code: 'B100',
            type: 'fixed',
            value: 100,
            allowStacking: true,
          },
          {
            ...base,
            _id: 'c200',
            title: 'C',
            method: 'automatic',
            type: 'fixed',
            value: 200,
          },
        ],
        items: [shirt(1_000)],
        shippingFee: 60,
        codes: ['B100'],
        isFirstOrder: false,
      },
      saving: 20_000n,
      applied: ['a100', 'b100'],
    },
    {
      name: 'a category discount reaches a sub-category’s products through their ancestry',
      input: {
        discounts: [
          {
            ...base,
            _id: 'cat',
            title: 'Sarees',
            method: 'automatic',
            type: 'percentage',
            value: 10,
            appliesTo: 'categories',
            categories: ['c-parent'],
          },
        ],
        items: [shirt(1_000), saree(3_000)],
        shippingFee: 60,
        codes: [],
        isFirstOrder: false,
      },
      saving: 30_000n,
      applied: ['cat'],
    },
    {
      name: 'a code past its end date is refused as expired',
      input: {
        discounts: [
          {
            ...base,
            _id: 'old',
            title: 'Puja',
            method: 'code',
            code: 'PUJA',
            type: 'percentage',
            value: 10,
            endsAt: new Date(NOW.getTime() - DAY),
          },
        ],
        items: [shirt(1_000)],
        shippingFee: 60,
        codes: ['PUJA'],
        isFirstOrder: true,
      },
      saving: 0n,
      applied: [],
    },
    {
      name: 'minimum quantity not reached',
      input: {
        discounts: [
          {
            ...base,
            _id: 'qty',
            title: 'Three or more',
            method: 'code',
            code: 'THREE',
            type: 'fixed',
            value: 150,
            minQuantity: 3,
          },
        ],
        items: [shirt(1_000, 2)],
        shippingFee: 60,
        codes: ['THREE'],
        isFirstOrder: true,
      },
      saving: 0n,
      applied: [],
    },
  ];

  for (const row of named) {
    it(`named case: ${row.name}`, () => {
      const { old, port } = runBoth(row.input);
      expect(oldSaving(old, row.input.shippingFee)).toBe(row.saving);
      expect(portSaving(port)).toBe(row.saving);
      expect(old.applied.map((entry) => entry.discountId)).toEqual(row.applied);
      expect(port.applied.map((entry) => entry.discount.id)).toEqual(row.applied);
      expect(refusedOf(port, row.input)).toEqual(oldRefusedOf(old));
      assertSameAnswer(row.input);
    });
  }

  it('reads a percent as basis points and a taka amount as poisha, exactly', () => {
    const doc: OracleDiscount = {
      ...base,
      _id: 'x',
      title: 'x',
      method: 'code',
      code: ' half ',
      type: 'percentage',
      value: 12.5,
      maxDiscount: 99.99,
    };
    const discount = discountFromOldSite(doc);
    expect(discount.valueBps).toBe(1_250);
    expect(discount.maxDiscountPoisha).toBe(9_999n);
    expect(discount.code).toBe('HALF');
  });
});
