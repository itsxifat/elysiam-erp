/**
 * What the showroom POS refuses, and why (architecture §14, M23).
 *
 * Every code here is also in `packages/contracts/src/errors.ts`, which is what
 * lets it reach the wire: `problemFor` replaces a code the contract does not know
 * with the status's own. A code added here is added there in the same change.
 */
export type PosErrorCode =
  | 'POS_REGISTER_NOT_FOUND'
  | 'POS_REGISTER_INVALID'
  | 'POS_SHIFT_NOT_OPEN'
  | 'POS_SHIFT_ALREADY_OPEN'
  | 'POS_SHIFT_MISMATCH'
  | 'POS_SALE_INVALID'
  | 'POS_SALE_NOT_FOUND'
  | 'POS_RETURN_INVALID'
  | 'POS_REVIEW_NOT_FOUND'
  | 'POS_REVIEW_RESOLVED'
  | 'POS_REVIEW_SELF_RESOLVE'
  | 'POS_DISCOUNT_ABOVE_CEILING'
  | 'POS_BRANCH_DAY_NOT_READY'
  | 'POS_PROMO_UNAVAILABLE'
  | 'POS_RECORD_IMMUTABLE'
  | 'IDEMPOTENCY_CONFLICT';

export class PosError extends Error {
  constructor(
    readonly code: PosErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PosError';
  }
}
