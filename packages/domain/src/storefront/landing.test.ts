import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { poisha, ZERO, type Poisha } from '../money/index.js';
import { computeOrderTotals } from '../orders/totals.js';
import {
  applyOfferPricing,
  campaignBasePath,
  campaignFullPath,
  campaignLinkCodeFrom,
  isLandingCode,
  landingCodeFrom,
  landingDeliveryFee,
  landingOfferHeadline,
  normaliseLandingCode,
  priceLandingOrder,
  type LandingOffer,
  type LandingPromotions,
  type LandingShipping,
  type LandingSku,
} from './landing.js';
import type { ShippingRule } from './shipping.js';

/**
 * The landing page's price comes from the page (M35b, D-550; M35 acceptance check 3's pure
 * half). The HTTP half — a tampered request priced from the page, its stock held — is
 * `landing-pages.e2e.test.ts`.
 */

const t = (taka: number): Poisha => poisha(BigInt(taka) * 100n);

const RULE: ShippingRule = {
  freeShippingEnabled: false,
  freeShippingThresholdPoisha: null,
  zones: {
    inside_dhaka: { feePoisha: t(60), deliveryZoneIds: ['z-in'] },
    suburbs: { feePoisha: t(100), deliveryZoneIds: ['z-sub'] },
    outside_dhaka: { feePoisha: t(130), deliveryZoneIds: ['z-out'] },
  },
};

const NO_PROMOTIONS: LandingPromotions = {
  freeShipping: { enabled: false, minSubtotalPoisha: ZERO, minQuantity: 0 },
  discountRules: [],
};

const SETTINGS: LandingShipping = {
  mode: 'settings',
  flatPoisha: ZERO,
  zonesPoisha: { inside_dhaka: t(60), suburbs: t(100), outside_dhaka: t(130) },
  askZone: true,
};

function sku(id: string, productId: string, price: number, availableQty = 10): LandingSku {
  return { id, productId, pricePoisha: t(price), sellable: true, availableQty };
}

const SHIRT = [sku('s-m', 'shirt', 1290), sku('s-l', 'shirt', 1290), sku('s-xl', 'shirt', 1390)];
const CAP = [sku('cap-1', 'cap', 450)];
const SKUS = new Map<string, readonly LandingSku[]>([
  ['shirt', SHIRT],
  ['cap', CAP],
]);

function offer(overrides: Partial<LandingOffer> = {}): LandingOffer {
  return {
    key: 'o1',
    label: 'Buy one',
    kind: 'fixed',
    items: [
      { productId: 'shirt', quantity: 2, skuId: null },
      { productId: 'cap', quantity: 1, skuId: null },
    ],
    pricingMode: 'fixed',
    priceValuePoisha: t(2490),
    percentBps: 0,
    tiers: [],
    minQty: 0,
    maxQty: 0,
    compareAtPoisha: ZERO,
    isActive: true,
    ...overrides,
  };
}

describe('a fixed offer', () => {
  it('charges the page’s bundle price, keeps the catalog’s prices on the lines and adds the zone fee', () => {
    const priced = priceLandingOrder({
      offer: offer(),
      choice: { kind: 'fixed', lineSkus: ['s-l', null] },
      skusByProduct: SKUS,
      shipping: SETTINGS,
      promotions: NO_PROMOTIONS,
      websiteRule: RULE,
      zone: 'outside_dhaka',
    });
    expect(priced.ok).toBe(true);
    if (!priced.ok) return;
    expect(priced.lines).toEqual([
      { skuId: 's-l', qty: 2, unitPricePoisha: t(1290) },
      { skuId: 'cap-1', qty: 1, unitPricePoisha: t(450) },
    ]);
    expect(priced.regularPoisha).toBe(t(3030));
    expect(priced.offerPoisha).toBe(t(2490));
    expect(priced.discountPoisha).toBe(t(540));
    expect(priced.deliveryPoisha).toBe(t(130));
    expect(priced.totalPoisha).toBe(t(2620));
  });

  it('asks for a size when a line has several and none is chosen, and picks the only one itself', () => {
    const refused = priceLandingOrder({
      offer: offer(),
      choice: { kind: 'fixed', lineSkus: [] },
      skusByProduct: SKUS,
      shipping: SETTINGS,
      promotions: NO_PROMOTIONS,
      websiteRule: RULE,
      zone: 'inside_dhaka',
    });
    expect(refused).toEqual({ ok: false, refusal: { code: 'choose_size', productId: 'shirt' } });
  });

  it('honours a pinned size whatever the request says', () => {
    const pinned = offer({ items: [{ productId: 'shirt', quantity: 1, skuId: 's-xl' }] });
    const priced = priceLandingOrder({
      offer: pinned,
      choice: { kind: 'fixed', lineSkus: ['s-m'] },
      skusByProduct: SKUS,
      shipping: { ...SETTINGS, mode: 'free' },
      promotions: NO_PROMOTIONS,
      websiteRule: RULE,
      zone: 'inside_dhaka',
    });
    expect(priced.ok && priced.lines).toEqual([
      { skuId: 's-xl', qty: 1, unitPricePoisha: t(1390) },
    ]);
  });

  it('refuses a size of another product, or one the website no longer sells', () => {
    const base = {
      offer: offer(),
      skusByProduct: SKUS,
      shipping: SETTINGS,
      promotions: NO_PROMOTIONS,
      websiteRule: RULE,
      zone: 'inside_dhaka' as const,
    };
    expect(
      priceLandingOrder({ ...base, choice: { kind: 'fixed', lineSkus: ['cap-1', null] } }),
    ).toEqual({ ok: false, refusal: { code: 'size_unavailable', productId: 'shirt' } });
    const hidden = new Map(SKUS);
    hidden.set('shirt', [
      { ...sku('s-m', 'shirt', 1290), sellable: false },
      sku('s-l', 'shirt', 1290),
    ]);
    expect(
      priceLandingOrder({
        ...base,
        skusByProduct: hidden,
        choice: { kind: 'fixed', lineSkus: ['s-m', null] },
      }),
    ).toEqual({ ok: false, refusal: { code: 'size_unavailable', productId: 'shirt' } });
  });

  it('checks stock against the folded quantity of two lines of one size', () => {
    const twice = offer({
      items: [
        { productId: 'shirt', quantity: 2, skuId: 's-m' },
        { productId: 'shirt', quantity: 2, skuId: 's-m' },
      ],
    });
    const thin = new Map(SKUS);
    thin.set('shirt', [sku('s-m', 'shirt', 1290, 3)]);
    expect(
      priceLandingOrder({
        offer: twice,
        choice: { kind: 'fixed', lineSkus: [] },
        skusByProduct: thin,
        shipping: SETTINGS,
        promotions: NO_PROMOTIONS,
        websiteRule: RULE,
        zone: 'inside_dhaka',
      }),
    ).toEqual({
      ok: false,
      refusal: { code: 'out_of_stock', skuId: 's-m', qty: 4, availableQty: 3 },
    });
  });

  it('refuses a switched-off offer', () => {
    expect(
      priceLandingOrder({
        offer: offer({ isActive: false }),
        choice: { kind: 'fixed', lineSkus: [] },
        skusByProduct: SKUS,
        shipping: SETTINGS,
        promotions: NO_PROMOTIONS,
        websiteRule: RULE,
      }),
    ).toEqual({ ok: false, refusal: { code: 'offer_unavailable' } });
  });
});

describe('a collection and an à la carte pool', () => {
  const ladder = offer({
    kind: 'collection',
    items: [
      { productId: 'shirt', quantity: 1, skuId: null },
      { productId: 'cap', quantity: 1, skuId: null },
    ],
    pricingMode: 'auto',
    tiers: [
      { quantity: 3, pricePoisha: t(2500) },
      { quantity: 1, pricePoisha: t(1000) },
    ],
  });

  it('prices the rung at or below the total pieces, and refuses outside the ladder', () => {
    const base = {
      offer: ladder,
      skusByProduct: SKUS,
      shipping: { ...SETTINGS, mode: 'flat' as const, flatPoisha: t(80) },
      promotions: NO_PROMOTIONS,
      websiteRule: RULE,
      zone: 'inside_dhaka' as const,
    };
    const two = priceLandingOrder({
      ...base,
      choice: {
        kind: 'pool',
        selections: [
          { skuId: 's-m', qty: 1 },
          { skuId: 'cap-1', qty: 1 },
        ],
      },
    });
    // Two pieces: the gap floors to the one-piece rung.
    expect(two.ok && [two.offerPoisha, two.totalPoisha]).toEqual([t(1000), t(1080)]);
    const four = priceLandingOrder({
      ...base,
      choice: { kind: 'pool', selections: [{ skuId: 's-m', qty: 4 }] },
    });
    expect(four).toEqual({ ok: false, refusal: { code: 'too_many', max: 3 } });
  });

  it('never charges more than the regular total for a rung typed above it', () => {
    const steep = offer({ ...ladder, tiers: [{ quantity: 1, pricePoisha: t(5000) }] });
    const priced = priceLandingOrder({
      offer: steep,
      choice: { kind: 'pool', selections: [{ skuId: 'cap-1', qty: 1 }] },
      skusByProduct: SKUS,
      shipping: { ...SETTINGS, mode: 'free' },
      promotions: NO_PROMOTIONS,
      websiteRule: RULE,
    });
    expect(priced.ok && [priced.offerPoisha, priced.discountPoisha]).toEqual([t(450), ZERO]);
  });

  it('refuses a pick from outside the pool', () => {
    const capOnly = offer({ ...ladder, items: [{ productId: 'cap', quantity: 1, skuId: null }] });
    expect(
      priceLandingOrder({
        offer: capOnly,
        choice: { kind: 'pool', selections: [{ skuId: 's-m', qty: 1 }] },
        skusByProduct: SKUS,
        shipping: SETTINGS,
        promotions: NO_PROMOTIONS,
        websiteRule: RULE,
      }),
    ).toEqual({ ok: false, refusal: { code: 'not_in_offer', skuId: 's-m' } });
  });

  it('bounds an à la carte order by its minimum and maximum and takes the percentage off', () => {
    const pool = offer({
      kind: 'alacarte',
      items: [{ productId: 'shirt', quantity: 1, skuId: null }],
      pricingMode: 'percent',
      percentBps: 1500,
      minQty: 2,
      maxQty: 3,
    });
    const base = {
      offer: pool,
      skusByProduct: SKUS,
      shipping: { ...SETTINGS, mode: 'free' as const },
      promotions: NO_PROMOTIONS,
      websiteRule: RULE,
    };
    expect(
      priceLandingOrder({
        ...base,
        choice: { kind: 'pool', selections: [{ skuId: 's-m', qty: 1 }] },
      }),
    ).toEqual({ ok: false, refusal: { code: 'too_few', min: 2 } });
    const two = priceLandingOrder({
      ...base,
      choice: {
        kind: 'pool',
        selections: [
          { skuId: 's-m', qty: 1 },
          { skuId: 's-xl', qty: 1 },
        ],
      },
    });
    // 2,680 less 15% = 2,278: whole taka.
    expect(two.ok && two.offerPoisha).toBe(t(2278));
  });
});

describe('delivery and promotions', () => {
  it('charges the page’s own zones, or inside Dhaka everywhere when it does not ask', () => {
    const zones: LandingShipping = { ...SETTINGS, mode: 'zones' };
    expect(
      landingDeliveryFee({
        shipping: zones,
        websiteRule: RULE,
        zone: 'suburbs',
        goodsPoisha: t(1),
      }),
    ).toEqual({ feePoisha: t(100), deliverable: true });
    expect(
      landingDeliveryFee({ shipping: zones, websiteRule: RULE, zone: null, goodsPoisha: t(1) }),
    ).toEqual({ feePoisha: ZERO, deliverable: false });
    expect(
      landingDeliveryFee({
        shipping: { ...zones, askZone: false },
        websiteRule: RULE,
        zone: null,
        goodsPoisha: t(1),
      }),
    ).toEqual({ feePoisha: t(60), deliverable: true });
  });

  it('follows the website’s own free shipping in settings mode', () => {
    const free: ShippingRule = {
      ...RULE,
      freeShippingEnabled: true,
      freeShippingThresholdPoisha: t(2000),
    };
    expect(
      landingDeliveryFee({
        shipping: SETTINGS,
        websiteRule: free,
        zone: 'outside_dhaka',
        goodsPoisha: t(1999),
      }),
    ).toEqual({ feePoisha: t(130), deliverable: true });
    expect(
      landingDeliveryFee({
        shipping: SETTINGS,
        websiteRule: free,
        zone: 'outside_dhaka',
        goodsPoisha: t(2000),
      }),
    ).toEqual({ feePoisha: ZERO, deliverable: true });
  });

  it('applies the single best rule and free delivery together', () => {
    const promotions: LandingPromotions = {
      freeShipping: { enabled: true, minSubtotalPoisha: ZERO, minQuantity: 3 },
      discountRules: [
        {
          basis: 'amount',
          thresholdPoisha: t(2000),
          thresholdQty: 0,
          rewardType: 'amount',
          valuePoisha: t(100),
          percentBps: 0,
          maxDiscountPoisha: ZERO,
          label: '৳100 off',
        },
        {
          basis: 'quantity',
          thresholdPoisha: ZERO,
          thresholdQty: 3,
          rewardType: 'percent',
          valuePoisha: ZERO,
          percentBps: 1000,
          maxDiscountPoisha: t(200),
          label: '10% off three',
        },
      ],
    };
    const priced = priceLandingOrder({
      offer: offer({ pricingMode: 'auto' }),
      choice: { kind: 'fixed', lineSkus: ['s-m', null] },
      skusByProduct: SKUS,
      shipping: SETTINGS,
      promotions,
      websiteRule: RULE,
      zone: 'outside_dhaka',
    });
    expect(priced.ok).toBe(true);
    if (!priced.ok) return;
    // 3,030 goods: 10% is 303, capped at 200, beats 100. Three pieces: delivery is free.
    expect([priced.promoDiscountPoisha, priced.promoLabel, priced.freeShipping]).toEqual([
      t(200),
      '10% off three',
      true,
    ]);
    expect([priced.deliveryPoisha, priced.totalPoisha]).toEqual([ZERO, t(2830)]);
  });
});

describe('the headline a page shows', () => {
  it('prices a fixed offer at its first sizes that hold its quantities', () => {
    expect(landingOfferHeadline(offer(), SKUS)).toEqual({
      pricePoisha: t(2490),
      compareAtPoisha: t(3030),
      savingsPoisha: t(540),
    });
    const soldOut = new Map(SKUS);
    soldOut.set('cap', [sku('cap-1', 'cap', 450, 0)]);
    expect(landingOfferHeadline(offer(), soldOut)).toBeNull();
  });
});

describe('codes', () => {
  it('normalises a typed code and refuses the reserved ones', () => {
    expect(normaliseLandingCode('  Eid Offer!! 2026 ')).toBe('eid-offer-2026');
    expect(isLandingCode('eid-offer-2026')).toBe(true);
    expect(isLandingCode('admin')).toBe(false);
    expect(isLandingCode('-x')).toBe(false);
  });

  it('draws a six-character code from the unambiguous alphabet', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 6, maxLength: 6 }), (bytes) => {
        const code = landingCodeFrom(bytes);
        expect(code).toMatch(/^[a-hj-km-np-z2-9]{6}$/);
      }),
    );
  });

  it('builds campaign links the old way', () => {
    fc.assert(
      fc.property(fc.integer(), (random) => {
        expect(campaignLinkCodeFrom(random)).toMatch(/^[1-9]\d{4}$/);
      }),
    );
    const base = campaignBasePath({
      baseType: 'category',
      categorySlug: 'shirts',
      customPath: null,
    });
    expect(campaignFullPath(base, '12345')).toBe('/shop?category=shirts&cu=12345');
    expect(
      campaignFullPath(
        campaignBasePath({ baseType: 'custom', categorySlug: null, customPath: 'eid' }),
        '54321',
      ),
    ).toBe('/eid?cu=54321');
  });
});

// --- properties -----------------------------------------------------------------------------

const money = fc.integer({ min: 0, max: 20_000 }).map(t);

const skuArb = (id: string, productId: string) =>
  fc
    .record({
      price: fc.integer({ min: 1, max: 5_000 }),
      availableQty: fc.integer({ min: 0, max: 8 }),
      sellable: fc.boolean(),
    })
    .map(({ price, availableQty, sellable }) => ({
      id,
      productId,
      pricePoisha: t(price),
      availableQty,
      sellable,
    }));

const catalogArb = fc
  .tuple(skuArb('a1', 'A'), skuArb('a2', 'A'), skuArb('b1', 'B'), skuArb('c1', 'C'))
  .map(
    ([a1, a2, b1, c1]) =>
      new Map<string, readonly LandingSku[]>([
        ['A', [a1, a2]],
        ['B', [b1]],
        ['C', [c1]],
      ]),
  );

const offerArb: fc.Arbitrary<LandingOffer> = fc
  .record({
    kind: fc.constantFrom('fixed', 'collection', 'alacarte'),
    pricingMode: fc.constantFrom('auto', 'fixed', 'percent', 'amount'),
    priceValuePoisha: money,
    percentBps: fc.integer({ min: 0, max: 10_000 }),
    tiers: fc.array(fc.record({ quantity: fc.integer({ min: 1, max: 6 }), pricePoisha: money }), {
      maxLength: 4,
    }),
    minQty: fc.integer({ min: 0, max: 3 }),
    maxQty: fc.integer({ min: 0, max: 6 }),
    items: fc.subarray(
      [
        { productId: 'A', quantity: 1, skuId: null },
        { productId: 'B', quantity: 2, skuId: 'b1' },
        { productId: 'C', quantity: 1, skuId: null },
      ],
      { minLength: 1 },
    ),
  })
  .map((value) => ({
    key: 'k',
    label: 'L',
    compareAtPoisha: ZERO,
    isActive: true,
    ...value,
  }));

const shippingArb: fc.Arbitrary<LandingShipping> = fc.record({
  mode: fc.constantFrom('settings', 'free', 'flat', 'zones'),
  flatPoisha: money,
  zonesPoisha: fc.record({ inside_dhaka: money, suburbs: money, outside_dhaka: money }),
  askZone: fc.boolean(),
});

const promotionsArb: fc.Arbitrary<LandingPromotions> = fc.record({
  freeShipping: fc.record({
    enabled: fc.boolean(),
    minSubtotalPoisha: money,
    minQuantity: fc.integer({ min: 0, max: 5 }),
  }),
  discountRules: fc.array(
    fc.record({
      basis: fc.constantFrom('amount', 'quantity'),
      thresholdPoisha: money,
      thresholdQty: fc.integer({ min: 0, max: 5 }),
      rewardType: fc.constantFrom('amount', 'percent'),
      valuePoisha: money,
      percentBps: fc.integer({ min: 0, max: 10_000 }),
      maxDiscountPoisha: money,
      label: fc.constant('rule'),
    }),
    { maxLength: 3 },
  ),
});

const choiceArb = fc.oneof(
  fc
    .array(fc.constantFrom<string | null>('a1', 'a2', 'b1', 'c1', null), { maxLength: 3 })
    .map((lineSkus) => ({ kind: 'fixed' as const, lineSkus })),
  fc
    .array(
      fc.record({
        skuId: fc.constantFrom('a1', 'a2', 'b1', 'c1', 'zz'),
        qty: fc.integer({ min: 1, max: 4 }),
      }),
      {
        maxLength: 4,
      },
    )
    .map((selections) => ({ kind: 'pool' as const, selections })),
);

describe('whatever the page and the choice, a priced order', () => {
  it('is §9’s COD for its lines, discount and delivery, and never charges more than the regular total', () => {
    fc.assert(
      fc.property(
        offerArb,
        catalogArb,
        choiceArb,
        shippingArb,
        promotionsArb,
        fc.constantFrom('inside_dhaka', 'suburbs', 'outside_dhaka', null),
        (landingOffer, skus, choice, shipping, promotions, zone) => {
          const priced = priceLandingOrder({
            offer: landingOffer,
            choice,
            skusByProduct: skus,
            shipping,
            promotions,
            websiteRule: RULE,
            zone,
          });
          if (!priced.ok) return;
          const totals = computeOrderTotals({
            lines: priced.lines.map((line) => ({
              qty: line.qty,
              unitPricePoisha: line.unitPricePoisha,
            })),
            orderDiscountPoisha: priced.discountPoisha,
            deliveryChargePoisha: priced.deliveryPoisha,
          });
          expect(totals.codAmountPoisha).toBe(priced.totalPoisha);
          expect(totals.itemsPoisha).toBe(priced.regularPoisha);
          expect(priced.offerPoisha <= priced.regularPoisha).toBe(true);
          expect(priced.offerPoisha >= 0n && priced.promoDiscountPoisha >= 0n).toBe(true);
          expect(priced.promoDiscountPoisha <= priced.offerPoisha).toBe(true);
          // Every line is a sellable size the website can fill, of a product the offer names.
          for (const line of priced.lines) {
            const all = [...skus.values()].flat();
            const found = all.find((entry) => entry.id === line.skuId);
            expect(found?.sellable).toBe(true);
            expect((found?.availableQty ?? 0) >= line.qty).toBe(true);
            expect(landingOffer.items.some((item) => item.productId === found?.productId)).toBe(
              true,
            );
            expect(line.unitPricePoisha).toBe(found?.pricePoisha);
          }
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it('is the same order whatever else the request carries: only the choice moves it', () => {
    fc.assert(
      fc.property(offerArb, catalogArb, choiceArb, (landingOffer, skus, choice) => {
        const input = {
          offer: landingOffer,
          choice,
          skusByProduct: skus,
          shipping: { ...SETTINGS, mode: 'free' as const },
          promotions: NO_PROMOTIONS,
          websiteRule: RULE,
        };
        expect(priceLandingOrder(input)).toEqual(priceLandingOrder(structuredClone(input)));
      }),
    );
  });

  it('applies a pricing mode within zero and the regular total', () => {
    fc.assert(
      fc.property(
        money,
        fc.constantFrom('auto', 'fixed', 'percent', 'amount'),
        money,
        fc.integer({ min: -100, max: 20_000 }),
        (regular, pricingMode, priceValuePoisha, percentBps) => {
          const total = applyOfferPricing({ pricingMode, priceValuePoisha, percentBps }, regular);
          expect(total >= 0n && total <= regular).toBe(true);
        },
      ),
    );
  });
});
