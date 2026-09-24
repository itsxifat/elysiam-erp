import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { ErrorCode } from '@elysium/contracts';
import { LedgerError, MoneyError } from '@elysium/domain';

/**
 * Ledger failures, as the API reports them (architecture §23).
 *
 * Every one carries a stable `code` from `packages/contracts/src/errors.ts`,
 * so a client branches on the code and never on the wording. M04 reshapes the
 * body into problem+json; the codes stay (D-087).
 */

const STATUS: Readonly<Partial<Record<ErrorCode, number>>> = {
  PERIOD_CLOSED: 409,
  PERIOD_NOT_ENDED: 409,
  PERIOD_ALREADY_CLOSED: 409,
  PERIOD_NOT_CLOSED: 409,
  PERIOD_REOPEN_UNAUTHORISED: 403,
  IDEMPOTENCY_CONFLICT: 409,
  JOURNAL_NOT_FOUND: 404,
  LEDGER_ACCOUNT_NOT_FOUND: 404,
  LEDGER_IMMUTABLE: 409,
};

export function ledgerHttpError(code: ErrorCode, message: string): HttpException {
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
 * The database's own refusals start with a code (0014), e.g.
 * `PERIOD_CLOSED: 2026-05-31 falls in 2026-05, which is closed`. Found through
 * Drizzle's wrapper, which hangs the real error off `.cause`.
 */
const DB_CODES: readonly ErrorCode[] = [
  'PERIOD_CLOSED',
  'PERIOD_REOPEN_UNAUTHORISED',
  'JOURNAL_UNBALANCED',
  'JOURNAL_TOO_FEW_LINES',
  'JOURNAL_LINE_INVALID',
  'LEDGER_ACCOUNT_INVALID',
  'LEDGER_IMMUTABLE',
];

export function databaseLedgerCode(error: unknown): { code: ErrorCode; message: string } | null {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const match = /^([A-Z_]+): (.*)$/s.exec(current.message);
    if (match !== null) {
      const code = DB_CODES.find((candidate) => candidate === match[1]);
      if (code !== undefined) return { code, message: match[2] ?? current.message };
    }
  }
  return null;
}

/**
 * Turn anything the ledger throws into an HTTP error the caller can act on.
 * Unknown errors pass through untouched, to become a 500 and a log line.
 */
export function toLedgerHttpError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof LedgerError) return ledgerHttpError(error.code, error.message);
  if (error instanceof MoneyError) return ledgerHttpError(error.code, error.message);
  const fromDatabase = databaseLedgerCode(error);
  if (fromDatabase !== null) return ledgerHttpError(fromDatabase.code, fromDatabase.message);
  return error;
}

/** Run `work`, translating ledger failures on the way out. */
export async function mapLedgerErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toLedgerHttpError(error);
  }
}
