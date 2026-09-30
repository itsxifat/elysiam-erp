import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { LedgerError, MoneyError } from '@elysium/domain';
import { PosError, type PosErrorCode } from '@elysium/domain/pos';

/**
 * What the POS refuses over HTTP, and with which status (architecture §23).
 *
 * The body is `{ code, message }` like every module's; `problemFor` turns it into
 * problem+json. The POS codes are in `packages/contracts/src/errors.ts`, so a
 * client branches on the code. Ledger and money codes pass through unchanged.
 */

type Code =
  PosErrorCode | 'LEDGER_ACCOUNT_NOT_FOUND' | 'PERIOD_CLOSED' | 'CLOSING_ALREADY_RECORDED';

const STATUS: Readonly<Partial<Record<Code, number>>> = {
  POS_REGISTER_NOT_FOUND: 404,
  POS_SALE_NOT_FOUND: 404,
  POS_REVIEW_NOT_FOUND: 404,
  LEDGER_ACCOUNT_NOT_FOUND: 404,
  POS_SHIFT_NOT_OPEN: 409,
  POS_SHIFT_ALREADY_OPEN: 409,
  POS_SHIFT_MISMATCH: 409,
  POS_REVIEW_RESOLVED: 409,
  POS_BRANCH_DAY_NOT_READY: 409,
  POS_RECORD_IMMUTABLE: 409,
  IDEMPOTENCY_CONFLICT: 409,
  CLOSING_ALREADY_RECORDED: 409,
  PERIOD_CLOSED: 409,
  // The rule, not the request's shape: 403 says "you may not", which is what a
  // ceiling is. The seller-may-not-resolve rule is the same kind of refusal.
  POS_DISCOUNT_ABOVE_CEILING: 403,
  POS_REVIEW_SELF_RESOLVE: 403,
};

export function posHttpError(code: Code, message: string): HttpException {
  const body = { code, message };
  switch (STATUS[code] ?? 400) {
    case 403:
      return new ForbiddenException(body);
    case 404:
      return new NotFoundException(body);
    case 409:
      return new ConflictException(body);
    default:
      return new BadRequestException(body);
  }
}

/**
 * A trigger in migration 0070 refused the write. Found through Drizzle's wrapper,
 * which hangs the database error off `.cause`.
 */
function databaseCode(error: unknown): { code: Code; message: string } | null {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const match = /^(POS_[A-Z_]+): (.*)$/s.exec(current.message);
    if (match !== null) return { code: match[1] as Code, message: match[2] ?? current.message };
    // Two opens racing on one register: the second waits on the first's index entry
    // and then collides with it. The partial unique index is the guarantee; this is
    // only its wording.
    const constraint = (current as { constraint_name?: unknown }).constraint_name;
    if (
      (current as { code?: unknown }).code === '23505' &&
      constraint === 'pos_shifts_org_register_open_idx'
    ) {
      return {
        code: 'POS_SHIFT_ALREADY_OPEN',
        message: 'A shift is already open on this register.',
      };
    }
  }
  return null;
}

/** Anything the POS or the ledger throws, as an HTTP error; the rest passes through. */
export function toPosHttpError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof PosError) return posHttpError(error.code, error.message);
  if (error instanceof LedgerError || error instanceof MoneyError) {
    return new BadRequestException({ code: error.code, message: error.message });
  }
  const fromDatabase = databaseCode(error);
  if (fromDatabase !== null) return posHttpError(fromDatabase.code, fromDatabase.message);
  return error;
}

export async function mapPosErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toPosHttpError(error);
  }
}
