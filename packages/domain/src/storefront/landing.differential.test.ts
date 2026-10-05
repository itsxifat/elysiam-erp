import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { poisha, ZERO, type Poisha } from '../money/index.js';
import {
  applyOfferPricing,
  applyPromotions,
  discountRuleAmount,
  maxTierQuantity,
  minTierQuantity,
  priceLandingOrder,
  qualifiesFreeShipping,
  tierPriceFor,
  type LandingDiscountRule,
  type LandingPromotions,
  type LandingSku,
} from './landing.js';
import * as old from './oracle/old-site-landing.js';
import type { ShippingRule } from './shipping.js';

/**
 * The port against the old website's own code (M35b, D-550).
 *
 * The old pricing (`oracle/old-site-landing.js`, copied verbatim) and the port run on the
 * same generated pages in whole taka and whole percentages, as the old admin typed them. They
 * must agree to the taka, with one documented exception and nothing looser:
 *
 * - **An exact half taka.** The old site multiplied float taka by a float fraction
 *   (`1290 * (1 - 15/100)` is 1096.4999… in binary) and rounded, so a true half could fall
 *   either way; the port computes the exact figure and rounds half away from zero. Where the
 *   exact figure is a half, the two may differ by one taka and no more.
 *
 * The order route's own arithmetic (offer total, the promotion capped at it, delivery, the
 * total never below zero) is composed here from the oracle's functions exactly as
 * `app/api/landing/order/route.js` composed them.
 */

const t = (taka: number): Poisha => poisha(BigInt(taka) * 100n);
const taka = (amount: Poisha): number => Number(amount / 100n);

const takaArb = fc.integer({ min: 0, max: 50_000 });
const percentArb = fc.integer({ min: 0, max: 100 });

/** Whether `amount × percent / 100` (or its complement) lands on an exact half taka. */
const halfTaka = (amount: number, percent: number): boolean => (amount * percent) % 100 === 50;

function agreesToTheTaka(port: number, oracle: number, tie: boolean): void {
  if (tie) expect(Math.abs(port - oracle)).toBeLessThanOrEqual(1);
  else expect(port).toBe(oracle);
}

describe('the offer pricing rule', () => {
  it('gives the old site’s offer total', () => {
    fc.assert(
      fc.property(
        takaArb,
        fc.constantFrom('auto', 'fixed', 'percent', 'amount'),
        takaArb,
        percentArb,
        (regular, mode, value, percent) => {
          const port = applyOfferPricing(
            {
              pricingMode: mode,
              priceValuePoisha: t(value),
              percentBps: percent * 100,
            },
            t(regular),
          );
          const oracle = old.applyOfferPricing(
            { pricingMode: mode, priceValue: mode === 'percent' ? percent : value },
            regular,
          );
          agreesToTheTaka(taka(port), oracle, mode === 'percent' && halfTaka(regular, percent));
        },
      ),
      { numRuns: 5_000 },
    );
  });

  it('gives the old ladder’s rung, floor and ceiling', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ quantity: fc.integer({ min: 0, max: 12 }), price: takaArb }), {
          maxLength: 6,
        }),
        fc.integer({ min: 0, max: 14 }),
        (tiers, qty) => {
          const portTiers = tiers.map((tier) => ({
            quantity: tier.quantity,
            pricePoisha: t(tier.price),
          }));
          const rung = tierPriceFor(portTiers, qty);
          const oracleRung = old.tierPriceFor(tiers, qty);
          expect(rung === null ? null : taka(rung)).toBe(oracleRung);
          expect(maxTierQuantity(portTiers)).toBe(old.maxTierQuantity(tiers));
          expect(minTierQuantity(portTiers)).toBe(old.minTierQuantity(tiers));
        },
      ),
      { numRuns: 3_000 },
    );
  });
});

const ruleArb = fc.record({
  basis: fc.constantFrom<'amount' | 'quantity'>('amount', 'quantity'),
  threshold: fc.integer({ min: 0, max: 5_000 }),
  rewardType: fc.constantFrom<'amount' | 'percent'>('amount', 'percent'),
  value: fc.integer({ min: 0, max: 3_000 }),
  percent: percentArb,
  maxDiscount: fc.integer({ min: 0, max: 2_000 }),
  label: fc.string({ minLength: 1, maxLength: 8 }),
});
type RuleShape = typeof ruleArb extends fc.Arbitrary<infer T> ? T : never;

function portRule(rule: RuleShape): LandingDiscountRule {
  return {
    basis: rule.basis,
    thresholdPoisha: rule.basis === 'amount' ? t(rule.threshold) : ZERO,
    thresholdQty: rule.basis === 'quantity' ? rule.threshold : 0,
    rewardType: rule.rewardType,
    valuePoisha: rule.rewardType === 'amount' ? t(rule.value) : ZERO,
    percentBps: rule.rewardType === 'percent' ? rule.percent * 100 : 0,
    maxDiscountPoisha: t(rule.maxDiscount),
    label: rule.label,
  };
}

function oracleRule(rule: RuleShape): old.OracleDiscountRule {
  return {
    basis: rule.basis,
    threshold: rule.threshold,
    rewardType: rule.rewardType,
    value: rule.rewardType === 'percent' ? rule.percent : rule.value,
    maxDiscount: rule.maxDiscount,
    label: rule.label,
  };
}

const freeArb = fc.record({
  enabled: fc.boolean(),
  minSubtotal: fc.integer({ min: 0, max: 5_000 }),
  minQuantity: fc.integer({ min: 0, max: 6 }),
});

describe('the promotions', () => {
  it('give the old rule amount, free delivery and best rule', () => {
    fc.assert(
      fc.property(
        fc.array(ruleArb, { maxLength: 4 }),
        freeArb,
        takaArb,
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 300 }),
        (rules, free, goods, qty, shippingFee) => {
          for (const rule of rules) {
            agreesToTheTaka(
              taka(discountRuleAmount(portRule(rule), t(goods))),
              old.discountRuleAmount(oracleRule(rule), goods),
              rule.rewardType === 'percent' && halfTaka(goods, rule.percent),
            );
          }
          const portPromotions: LandingPromotions = {
            freeShipping: {
              enabled: free.enabled,
              minSubtotalPoisha: t(free.minSubtotal),
              minQuantity: free.minQuantity,
            },
            discountRules: rules.map(portRule),
          };
          const oraclePromotions = {
            freeShipping: free,
            discountRules: rules.map(oracleRule),
          };
          expect(qualifiesFreeShipping(portPromotions.freeShipping, t(goods), qty)).toBe(
            old.qualifiesFreeShipping(free, goods, qty),
          );
          const port = applyPromotions({
            goodsPoisha: t(goods),
            qty,
            deliveryPoisha: t(shippingFee),
            promotions: portPromotions,
          });
          const oracle = old.applyPromotions({
            goodsTotal: goods,
            quantity: qty,
            shippingFee,
            promotions: oraclePromotions,
          });
          const tie = rules.some(
            (rule) => rule.rewardType === 'percent' && halfTaka(goods, rule.percent),
          );
          agreesToTheTaka(taka(port.promoDiscountPoisha), oracle.promoDiscount, tie);
          expect(port.freeShipping).toBe(oracle.freeShipping);
          expect(taka(port.deliveryPoisha)).toBe(oracle.shippingFee);
          if (!tie && oracle.promoDiscount > 0) expect(port.promoLabel).toBe(oracle.promoLabel);
        },
      ),
      { numRuns: 4_000 },
    );
  });
});

const RULE: ShippingRule = {
  freeShippingEnabled: false,
  freeShippingThresholdPoisha: null,
  zones: {
    inside_dhaka: { feePoisha: t(60), deliveryZoneIds: [] },
    suburbs: { feePoisha: t(100), deliveryZoneIds: [] },
    outside_dhaka: { feePoisha: t(130), deliveryZoneIds: [] },
  },
};

describe('a whole landing order', () => {
  it('costs what the old order route charged', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3_000 }),
        fc.integer({ min: 1, max: 3_000 }),
        fc.integer({ min: 1, max: 3 }),
        fc.constantFrom('auto', 'fixed', 'percent', 'amount'),
        takaArb,
        percentArb,
        fc.array(ruleArb, { maxLength: 3 }),
        freeArb,
        fc.integer({ min: 0, max: 200 }),
        (priceA, priceB, qtyA, mode, value, percent, rules, free, flat) => {
          const skus = new Map<string, readonly LandingSku[]>([
            [
              'A',
              [
                {
                  id: 'a',
                  productId: 'A',
                  pricePoisha: t(priceA),
                  sellable: true,
                  availableQty: 9,
                },
              ],
            ],
            [
              'B',
              [
                {
                  id: 'b',
                  productId: 'B',
                  pricePoisha: t(priceB),
                  sellable: true,
                  availableQty: 9,
                },
              ],
            ],
          ]);
          const port = priceLandingOrder({
            offer: {
              key: 'k',
              label: 'L',
              kind: 'fixed',
              items: [
                { productId: 'A', quantity: qtyA, skuId: null },
                { productId: 'B', quantity: 1, skuId: null },
              ],
              pricingMode: mode,
              priceValuePoisha: t(value),
              percentBps: percent * 100,
              tiers: [],
              minQty: 0,
              maxQty: 0,
              compareAtPoisha: ZERO,
              isActive: true,
            },
            choice: { kind: 'fixed', lineSkus: [] },
            skusByProduct: skus,
            shipping: {
              mode: 'flat',
              flatPoisha: t(flat),
              zonesPoisha: { inside_dhaka: ZERO, suburbs: ZERO, outside_dhaka: ZERO },
              askZone: true,
            },
            promotions: {
              freeShipping: {
                enabled: free.enabled,
                minSubtotalPoisha: t(free.minSubtotal),
                minQuantity: free.minQuantity,
              },
              discountRules: rules.map(portRule),
            },
            websiteRule: RULE,
            zone: 'inside_dhaka',
          });
          expect(port.ok).toBe(true);
          if (!port.ok) return;

          // The old route, step by step.
          const regular = priceA * qtyA + priceB;
          const offerTotal = old.applyOfferPricing(
            { pricingMode: mode, priceValue: mode === 'percent' ? percent : value },
            regular,
          );
          const promo = old.applyPromotions({
            goodsTotal: offerTotal,
            quantity: qtyA + 1,
            shippingFee: flat,
            promotions: { freeShipping: free, discountRules: rules.map(oracleRule) },
          });
          const promoDiscount = Math.min(promo.promoDiscount, offerTotal);
          const total = Math.max(0, offerTotal - promoDiscount + promo.shippingFee);

          const portOffer = taka(port.offerPoisha);
          const tie =
            (mode === 'percent' && halfTaka(regular, percent)) ||
            rules.some(
              (rule) =>
                rule.rewardType === 'percent' &&
                (halfTaka(offerTotal, rule.percent) || halfTaka(portOffer, rule.percent)),
            );
          if (tie) {
            // A percentage anywhere in the chain may sit on a half taka somewhere: the totals
            // agree within a taka per percentage applied.
            expect(Math.abs(taka(port.totalPoisha) - total)).toBeLessThanOrEqual(2);
          } else {
            expect(taka(port.totalPoisha)).toBe(total);
            expect(taka(port.offerPoisha)).toBe(offerTotal);
            expect(taka(port.discountPoisha)).toBe(regular - offerTotal + promoDiscount);
          }
          expect(taka(port.regularPoisha)).toBe(regular);
        },
      ),
      { numRuns: 4_000 },
    );
  });
});
