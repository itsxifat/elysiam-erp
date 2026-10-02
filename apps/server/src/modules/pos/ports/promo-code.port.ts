import type { Tx } from '@elysium/db';

/**
 * Promo codes at the till (architecture §10 "Promotions", §14).
 *
 * Codes belong to M16's `promo` module, which prices and redeems them at the order
 * desk. The till still has the field, and the server still has the question, but this
 * port stays on its default until a sale can carry a code and its sync can redeem one
 * (D-209). Until then **no code is ever valid** — the permissive-refusal default, the
 * mirror image of `AllowAllFraudGate`. Accepting codes before anything can say
 * what a code is worth would make every typed string a discount the ceiling in
 * `discount-policy.ts` never saw.
 *
 * Validation happens online only. A code's usage limits are shared across every
 * till and landing page in the brand, so an offline till cannot know whether the
 * code it is holding has already been used up; a sale that arrives carrying one
 * would have to be held anyway. The PWA therefore disables the field offline.
 */

export interface PromoCodeCheck {
  readonly orgId: string;
  readonly branchId: string;
  readonly code: string;
  /** Integer poisha, before any promotion. */
  readonly basketPoisha: bigint;
}

export type PromoCodeVerdict =
  | { readonly valid: true; readonly discountPoisha: bigint; readonly promotionId: string }
  | { readonly valid: false; readonly reason: 'promo_unavailable' | 'invalid' | 'expired' };

export interface PromoCodePort {
  validate(tx: Tx, check: PromoCodeCheck): Promise<PromoCodeVerdict>;
}

export const PROMO_CODES = Symbol('PromoCodePort');

/** Named and exported so a test can assert which gate is installed. */
export class NoPromoCodes implements PromoCodePort {
  validate(): Promise<PromoCodeVerdict> {
    return Promise.resolve({ valid: false, reason: 'promo_unavailable' });
  }
}
