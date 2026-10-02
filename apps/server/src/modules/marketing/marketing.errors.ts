import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  type HttpException,
} from '@nestjs/common';
import type { ErrorCode } from '@elysium/contracts';

/**
 * Marketing failures, as the API reports them (architecture §23, D-087): a stable code
 * from `packages/contracts/src/errors.ts` plus a message. Never a token, never a phone.
 */
export class MarketingError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MarketingError';
  }
}

const STATUS: Readonly<Partial<Record<ErrorCode, number>>> = {
  MARKETING_CAMPAIGN_NOT_FOUND: 404,
  MARKETING_LEAD_NOT_FOUND: 404,
  MARKETING_REF_TAKEN: 409,
  MARKETING_SPEND_IMMUTABLE: 409,
  MARKETING_CAPI_IMMUTABLE: 409,
  MARKETING_META_NOT_CONNECTED: 409,
  MARKETING_CREDENTIALS_MISSING: 409,
  MARKETING_INVALID: 400,
};

export function marketingHttpError(error: MarketingError): HttpException {
  const body = { code: error.code, message: error.message };
  switch (STATUS[error.code] ?? 400) {
    case 404:
      return new NotFoundException(body);
    case 409:
      return new ConflictException(body);
    default:
      return new BadRequestException(body);
  }
}

/** A database refusal this module's triggers raise, as the code it starts with. */
function triggerCode(cause: unknown): ErrorCode | null {
  const message = cause instanceof Error ? cause.message : '';
  const match = /\b(MARKETING_[A-Z_]+):/.exec(message);
  return match === null ? null : (match[1] as ErrorCode);
}

/** Run `work`, turning this module's errors into problem+json and leaving others alone. */
export async function mapMarketingErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof MarketingError) throw marketingHttpError(cause);
    const code = triggerCode(cause);
    if (code !== null) {
      throw marketingHttpError(new MarketingError(code, 'That change is not allowed.'));
    }
    throw cause;
  }
}
