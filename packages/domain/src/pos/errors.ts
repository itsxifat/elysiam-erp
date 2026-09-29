/**
 * What the showroom POS refuses, and why (architecture §14, M23).
 *
 * The codes are proposed for `packages/contracts/src/errors.ts` and kept in step
 * with it at integration. Until then `problemFor` replaces an unknown code with the
 * status's own, so a client sees `CONFLICT` rather than `POS_SHIFT_NOT_OPEN` — the
 * status is right either way, which is why nothing here depends on the code
 * reaching the wire.
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
