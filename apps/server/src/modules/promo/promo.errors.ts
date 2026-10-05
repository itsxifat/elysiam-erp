import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  type HttpException,
} from '@nestjs/common';
import type { ErrorCode } from '@elysium/contracts';
import type { PromoReason } from '@elysium/domain/promo';

/**
 * Promo failures, as the API reports them (architecture §23, D-087).
 *
 * The shape every other module uses: a stable `code` from
 * `packages/contracts/src/errors.ts` plus a message, so a client branches on the code and
 * never on the wording.
 *
 * `PROMO_NOT_APPLICABLE` carries the domain's `reason` as well, because the order desk
 * has to say *why* a code did not work — "that code ran out" and "this basket is below
 * its minimum" send the agent to different places — and the reasons are a closed list in
 * `packages/domain/src/promo`, not free text. 409 rather than 400: the request was
 * well-formed and the answer is about the code's state.
 */
export class PromoError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly reason: PromoReason | null = null,
    /** Facts a caller acts on, such as the SKUs a flash claim could not have (M35a). */
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'PromoError';
  }
}

const STATUS: Readonly<Partial<Record<ErrorCode, number>>> = {
  PROMO_NOT_FOUND: 404,
  PROMO_NOT_APPLICABLE: 409,
  PROMO_CODE_TAKEN: 409,
  PROMO_INVALID: 400,
  PROMO_REDEMPTION_IMMUTABLE: 409,
  FLASH_SALE_NOT_FOUND: 404,
  FLASH_SALE_UNAVAILABLE: 409,
  FLASH_SALE_SLUG_TAKEN: 409,
  FLASH_SALE_INVALID: 400,
  FLASH_CLAIM_IMMUTABLE: 409,
};

export function promoHttpError(error: PromoError): HttpException {
  const body = {
    ...error.detail,
    code: error.code,
    message: error.message,
    ...(error.reason === null ? {} : { reason: error.reason }),
  };
  switch (STATUS[error.code] ?? 400) {
    case 404:
      return new NotFoundException(body);
    case 409:
      return new ConflictException(body);
    default:
      return new BadRequestException(body);
  }
}

/**
 * A row naming another brand's (or no) campaign, buyer, SKU or file: the composite foreign
 * keys refuse it (D-047), and that refusal is the caller's mistake, not a 500 (M18; M16 N8).
 * The constraints below are the other refusals a caller can cause: a slug taken in a race,
 * a flash limit below what already sold (M35a).
 */
const CONSTRAINTS: Readonly<Record<string, { code: ErrorCode; message: string }>> = {
  promo_codes_org_id_campaign_id_fk: {
    code: 'PROMO_INVALID',
    message: 'No such campaign in this brand.',
  },
  promo_codes_org_id_customer_id_fk: {
    code: 'PROMO_INVALID',
    message: 'No such buyer in this brand.',
  },
  flash_sales_org_id_banner_file_id_fk: {
    code: 'FLASH_SALE_INVALID',
    message: 'No such banner file in this brand.',
  },
  flash_sale_items_org_id_sku_id_fk: {
    code: 'FLASH_SALE_INVALID',
    message: 'No such SKU in this brand.',
  },
  flash_sales_org_slug_idx: {
    code: 'FLASH_SALE_SLUG_TAKEN',
    message: 'Another sale already uses that slug.',
  },
  flash_sale_items_sold_within_limit: {
    code: 'FLASH_SALE_INVALID',
    message: 'A limit cannot be below what has already sold.',
  },
  // A claim names a whole line of its own order, of its own SKU (ledger re-audit W2).
  flash_claims_order_line_fk: {
    code: 'FLASH_SALE_INVALID',
    message:
      'A flash claim has to name a whole line of its own order, of the same SKU, charged at the sale price.',
  },
};

export function constraintRefusal(error: unknown): PromoError | null {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const fields = current as { code?: unknown; constraint_name?: unknown };
    if (
      (fields.code === '23503' || fields.code === '23505' || fields.code === '23514') &&
      typeof fields.constraint_name === 'string'
    ) {
      const known = CONSTRAINTS[fields.constraint_name];
      return known === undefined ? null : new PromoError(known.code, known.message);
    }
  }
  return null;
}

/** Run `work`, turning this module's errors into problem+json and leaving others alone. */
export async function mapPromoErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof PromoError) throw promoHttpError(cause);
    const refusal = constraintRefusal(cause);
    if (refusal !== null) throw promoHttpError(refusal);
    throw cause;
  }
}
