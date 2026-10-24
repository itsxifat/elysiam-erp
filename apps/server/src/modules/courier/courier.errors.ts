import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  type HttpException,
} from '@nestjs/common';
import type { ErrorCode } from '@elysium/contracts';

import { toLedgerHttpError } from '../ledger/ledger.errors.js';

/**
 * What the courier module refuses, and with which status (architecture §23).
 *
 * Codes come from `packages/contracts/src/errors.ts`, so a client branches on the code
 * and never on the wording. The ledger's own failures pass through
 * `toLedgerHttpError` unchanged — a closed period, an unbalanced draft or an
 * idempotency conflict is the ledger's answer, and restating it here would give one
 * condition two codes.
 *
 * Two statuses are worth their comment:
 *
 * - `COURIER_UNAVAILABLE` is **503**, not 502 or 500, because it is the honest answer
 *   to "this did not work and it is not your fault": the courier did not answer. The
 *   booking is a job, so the caller is usually a retry rather than a person, and a 503
 *   is what tells the job to come back.
 * - `WEBHOOK_SIGNATURE_INVALID` is **401**. A webhook that presents the wrong secret is
 *   an unauthenticated caller, and answering 400 would invite whoever sent it to try
 *   again with a different body.
 */
const STATUS: Readonly<Partial<Record<ErrorCode, number>>> = {
  // A courier account, consignment or settlement outside the caller's scope answers
  // exactly as one that does not exist. Any other answer enumerates other orgs' rows.
  COURIER_ACCOUNT_NOT_FOUND: 404,
  CONSIGNMENT_NOT_FOUND: 404,
  SETTLEMENT_NOT_FOUND: 404,
  ORDER_NOT_FOUND: 404,

  COURIER_ACCOUNT_INVALID: 400,
  COURIER_CREDENTIALS_MISSING: 409,
  // Keys a person just typed that the courier refused: their input, so a 400 (D-913).
  COURIER_CREDENTIALS_REJECTED: 400,
  COURIER_UNAVAILABLE: 503,
  COURIER_BOOKING_FAILED: 409,

  CONSIGNMENT_INVALID: 400,
  CONSIGNMENT_ALREADY_BOOKED: 409,
  CONSIGNMENT_IMMUTABLE: 409,
  CONSIGNMENT_EVENT_INVALID: 400,
  CONSIGNMENT_EVENT_IMMUTABLE: 409,

  WEBHOOK_SIGNATURE_INVALID: 401,
  WEBHOOK_DELIVERY_IMMUTABLE: 409,

  SETTLEMENT_FILE_INVALID: 400,
  SETTLEMENT_FROZEN: 409,
  SETTLEMENT_NOT_APPROVED: 409,
  SETTLEMENT_ALREADY_POSTED: 409,
  SETTLEMENT_TRANSITION_INVALID: 409,
  SETTLEMENT_OWES_COURIER: 409,

  RETURN_RECEIPT_INVALID: 400,
  COURIER_RECORD_IMMUTABLE: 409,

  APPROVAL_REQUIRED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  FORBIDDEN: 403,
};

export function courierHttpError(code: ErrorCode, message: string): HttpException {
  const body = { code, message };
  switch (STATUS[code] ?? 400) {
    case 401:
      return new UnauthorizedException(body);
    case 403:
      return new ForbiddenException(body);
    case 404:
      return new NotFoundException(body);
    case 409:
      return new ConflictException(body);
    case 503:
      return new ServiceUnavailableException(body);
    default:
      return new BadRequestException(body);
  }
}

/**
 * Errors this module's own code raises, for the paths that are not HTTP.
 *
 * A job handler has no response to shape, so it throws one of these and the retry
 * policy in §20 does the rest. It carries a code so the dead-letter alert can name one
 * (`delivery.booking_failed`), and `retryable` so a handler can tell a courier's bad
 * afternoon — worth five attempts — from a parcel the courier will always refuse, which
 * is worth none.
 */
export class CourierError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'CourierError';
  }
}

/**
 * The codes migrations 0050 and 0051 raise, as `CODE: message`.
 *
 * A list of its own rather than an addition to the ledger's `DB_CODES`, because that
 * list is a shared file three milestones are writing to at once — and because the
 * consequence of a missing entry is specific and bad: the trigger refuses correctly,
 * the service turns it into a 500, and the operator reading the log sees an internal
 * error where the database had a perfectly clear sentence.
 *
 * Kept in step with the migrations by `courier.db.test.ts`, which drives each trigger
 * and asserts the status it produces.
 */
const DB_CODES: readonly ErrorCode[] = [
  'COURIER_ACCOUNT_NOT_FOUND',
  'COURIER_ACCOUNT_INVALID',
  'CONSIGNMENT_NOT_FOUND',
  'CONSIGNMENT_INVALID',
  'CONSIGNMENT_ALREADY_BOOKED',
  'CONSIGNMENT_IMMUTABLE',
  'CONSIGNMENT_EVENT_INVALID',
  'CONSIGNMENT_EVENT_IMMUTABLE',
  'WEBHOOK_DELIVERY_IMMUTABLE',
  'SETTLEMENT_NOT_FOUND',
  'SETTLEMENT_FROZEN',
  'SETTLEMENT_NOT_APPROVED',
  'SETTLEMENT_ALREADY_POSTED',
  'SETTLEMENT_TRANSITION_INVALID',
  'RETURN_RECEIPT_INVALID',
  'COURIER_RECORD_IMMUTABLE',
  'APPROVAL_REQUIRED',
  'ORDER_NOT_FOUND',
];

/** A trigger's refusal, found through Drizzle's wrapper, which hangs it off `.cause`. */
export function databaseCourierCode(error: unknown): { code: ErrorCode; message: string } | null {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const match = /^([A-Z_]+): (.*)$/s.exec(current.message);
    if (match !== null) {
      const code = DB_CODES.find((candidate) => candidate === match[1]);
      if (code !== undefined) return { code, message: match[2] ?? current.message };
    }
  }
  return null;
}

/** Run `work`, translating courier and ledger failures on the way out. */
export async function mapCourierErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CourierError) throw courierHttpError(error.code, error.message);
    const fromDatabase = databaseCourierCode(error);
    if (fromDatabase !== null) throw courierHttpError(fromDatabase.code, fromDatabase.message);
    // The ledger's own failures — a closed period, an unbalanced draft, an idempotency
    // conflict — keep the ledger's codes. Restating them here would give one condition
    // two codes depending on which module's route reached it.
    throw toLedgerHttpError(error);
  }
}
