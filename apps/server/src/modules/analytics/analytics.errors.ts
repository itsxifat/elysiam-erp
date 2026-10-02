import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
  type HttpException,
} from '@nestjs/common';
import type { ErrorCode } from '@elysium/contracts';

/**
 * Analytics failures, as the API reports them (architecture §23, D-087): a stable code from
 * `packages/contracts/src/errors.ts` and a message.
 */
export class AnalyticsError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AnalyticsError';
  }
}

const STATUS: Readonly<Partial<Record<ErrorCode, number>>> = {
  FORBIDDEN: 403,
  ANALYTICS_NARRATIVE_FAILED: 503,
  ANALYTICS_INVALID: 400,
};

export function analyticsHttpError(error: AnalyticsError): HttpException {
  const body = { code: error.code, message: error.message };
  const status = STATUS[error.code] ?? 400;
  if (status === 403) return new ForbiddenException(body);
  if (status === 503) return new ServiceUnavailableException(body);
  return new BadRequestException(body);
}

/** Run `work`, turning this module's errors into problem+json and leaving others alone. */
export async function mapAnalyticsErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof AnalyticsError) throw analyticsHttpError(cause);
    throw cause;
  }
}
