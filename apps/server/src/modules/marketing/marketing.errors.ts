import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  type HttpException,
} from '@nestjs/common';
import type { ErrorCode } from '@elysium/contracts';

import { isStillReferenced } from '../../platform/references/references.js';

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
  // M39a (D-632): a campaign with spend, leads or discounts.
  MARKETING_IN_USE: 409,
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
    if (isStillReferenced(cause)) {
      // The backstop behind a campaign delete's own count (D-621, D-632).
      throw marketingHttpError(
        new MarketingError(
          'MARKETING_IN_USE',
          'Something still uses this campaign, so it was not deleted. Archive it instead.',
        ),
      );
    }
    const code = triggerCode(cause);
    if (code !== null) {
      throw marketingHttpError(new MarketingError(code, 'That change is not allowed.'));
    }
    throw cause;
  }
}
