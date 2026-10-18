import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  type HttpException,
} from '@nestjs/common';
import type { ErrorCode } from '@elysium/contracts';

import { SealedBoxUnavailable } from '../../platform/crypto/sealed-box.js';

/**
 * Telephony's failures as the API reports them (architecture §23): a stable code from
 * `packages/contracts/src/errors.ts` and a sentence a person can act on. Never an API key, a
 * webhook secret or a whole phone number (invariant 10).
 */
export class TelephonyError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TelephonyError';
  }
}

const STATUS: Readonly<Partial<Record<ErrorCode, number>>> = {
  TELEPHONY_NOT_FOUND: 404,
  TELEPHONY_INVALID: 400,
  TELEPHONY_NO_EXTENSION: 409,
  TELEPHONY_NOT_READY: 409,
  TELEPHONY_ENVO_REFUSED: 502,
  TELEPHONY_ENVO_UNREACHABLE: 502,
  TELEPHONY_EXTENSION_TAKEN: 409,
  TELEPHONY_NUMBER_INVALID: 400,
  TELEPHONY_RECORDING_UNAVAILABLE: 404,
  TELEPHONY_OUTCOME_INVALID: 409,
  TELEPHONY_CREDENTIALS_MISSING: 409,
};

export function telephonyHttpError(error: TelephonyError): HttpException {
  const body = { code: error.code, message: error.message };
  switch (STATUS[error.code] ?? 400) {
    case 404:
      return new NotFoundException(body);
    case 403:
      return new ForbiddenException(body);
    case 409:
      return new ConflictException(body);
    case 502:
      return new BadGatewayException(body);
    default:
      return new BadRequestException(body);
  }
}

/** Run `work`, turning this module's errors into problem+json and leaving others alone. */
export async function mapTelephonyErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof TelephonyError) throw telephonyHttpError(cause);
    if (cause instanceof SealedBoxUnavailable) {
      throw telephonyHttpError(
        new TelephonyError(
          'TELEPHONY_CREDENTIALS_MISSING',
          'This installation has no credentials key, so an Envo key or secret cannot be kept.',
        ),
      );
    }
    throw cause;
  }
}
