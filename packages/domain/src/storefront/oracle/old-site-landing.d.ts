/**
 * Types for the old website's landing-page pricing, kept only as a test oracle (M35b, D-550).
 *
 * The code is plain JavaScript copied verbatim; these declarations describe the shapes the
 * differential test passes it, no more. Never import it from production code.
 */

export interface OracleOfferPricing {
  pricingMode: 'auto' | 'fixed' | 'percent' | 'amount';
  priceValue: number;
}

export interface OracleTier {
  quantity: number;
  price: number;
}

export interface OracleDiscountRule {
  basis: 'amount' | 'quantity';
  threshold: number;
  rewardType: 'amount' | 'percent';
  value: number;
  maxDiscount: number;
  label: string;
}

export interface OraclePromotions {
  freeShipping: { enabled: boolean; minSubtotal: number; minQuantity: number };
  discountRules: OracleDiscountRule[];
}

export function applyOfferPricing(pricing: OracleOfferPricing, regularTotal: number): number;
export function tierPriceFor(tiers: OracleTier[], qty: number): number | null;
export function maxTierQuantity(tiers: OracleTier[]): number;
export function minTierQuantity(tiers: OracleTier[]): number;
export function discountRuleAmount(rule: OracleDiscountRule, goodsTotal: number): number;
export function qualifiesFreeShipping(
  freeShipping: OraclePromotions['freeShipping'],
  goodsTotal: number,
  quantity: number,
): boolean;
export function applyPromotions(input: {
  goodsTotal: number;
  quantity: number;
  shippingFee: number;
  promotions: OraclePromotions;
}): { promoDiscount: number; promoLabel: string; freeShipping: boolean; shippingFee: number };
