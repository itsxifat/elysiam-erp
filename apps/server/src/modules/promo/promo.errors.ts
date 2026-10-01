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
};

export function promoHttpError(error: PromoError): HttpException {
  const body = {
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

/** Run `work`, turning this module's errors into problem+json and leaving others alone. */
export async function mapPromoErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof PromoError) throw promoHttpError(cause);
    throw cause;
  }
}
