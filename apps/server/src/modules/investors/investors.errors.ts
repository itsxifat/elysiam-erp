import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  type HttpException as Http,
} from '@nestjs/common';
import type { ErrorCode } from '@elysium/contracts';
import { InvestorsError } from '@elysium/domain/investors';

import { toLedgerHttpError } from '../ledger/ledger.errors.js';

/**
 * What the investors module refuses, and with which status (architecture §23).
 *
 * The codes come from `packages/contracts/src/errors.ts` like every other
 * module's, so a client branches on the code and never on the wording. The
 * ledger's own failures pass through `toLedgerHttpError` unchanged — a closed
 * period or an unbalanced draft is the ledger's answer, and restating it here
 * would give one condition two codes.
 */

const STATUS: Readonly<Partial<Record<ErrorCode, number>>> = {
  INVESTOR_NOT_FOUND: 404,
  INVESTOR_INACTIVE: 409,
  INVESTOR_IMMUTABLE: 409,
  INVESTOR_WITHDRAWAL_FROZEN: 409,
  INVESTOR_DISTRIBUTION_FROZEN: 409,
  // Not 404: the investor exists and the caller may see them. What is wrong is
  // the amount, and a client shows it next to the field.
  INVESTOR_POSITION_INSUFFICIENT: 409,
  INVESTOR_CAPITAL_LOCKED: 409,
  INVESTOR_SPLIT_INVALID: 400,
  INVESTOR_DOCUMENT_INVALID: 400,
  LEDGER_ACCOUNT_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  APPROVAL_REQUIRED: 409,
  CONFLICT: 409,
  FORBIDDEN: 403,
};

export function investorsHttpError(code: ErrorCode, message: string): Http {
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
 * The database's own refusals start with a code (0060), e.g.
 * `INVESTOR_SPLIT_INVALID: distribution … allocates 9999 poisha of a declared 10000`.
 * Found through Drizzle's wrapper, which hangs the real error off `.cause`.
 *
 * The deferred split trigger is the one that needs this most: it fires at
 * **commit**, long after the service's own check passed, so without a translation
 * here a split that somehow got past the domain would reach a person as a 500 and
 * a constraint name.
 */
const DB_CODES: readonly ErrorCode[] = [
  'INVESTOR_SPLIT_INVALID',
  'INVESTOR_NOT_FOUND',
  'INVESTOR_INACTIVE',
  'INVESTOR_IMMUTABLE',
  'INVESTOR_WITHDRAWAL_FROZEN',
  'INVESTOR_DISTRIBUTION_FROZEN',
  'LEDGER_ACCOUNT_INVALID',
];

export function databaseInvestorsCode(error: unknown): { code: ErrorCode; message: string } | null {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const match = /^([A-Z_]+): (.*)$/s.exec(current.message);
    if (match !== null) {
      const code = DB_CODES.find((candidate) => candidate === match[1]);
      if (code !== undefined) return { code, message: match[2] ?? current.message };
    }
  }
  return null;
}

/** The PostgreSQL error a row failed with, found through Drizzle's wrapper. */
function pgCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** Run `work`, translating investor, ledger and database failures on the way out. */
export async function mapInvestorErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpException) throw error;
    if (error instanceof InvestorsError) throw investorsHttpError(error.code, error.message);
    const fromDatabase = databaseInvestorsCode(error);
    if (fromDatabase !== null) throw investorsHttpError(fromDatabase.code, fromDatabase.message);
    /*
     * A unique index this module relies on: one live distribution per period, one
     * document per file, one investor per code and per login. Each has a check in
     * front of it that says which; this is the backstop for the race between two
     * concurrent submits, and 409 is the honest answer rather than a 500.
     */
    if (pgCode(error) === '23505') {
      throw investorsHttpError('CONFLICT', 'That record already exists in this organization.');
    }
    // Anything left is the ledger's or a fault we did not anticipate; the ledger
    // has codes for its own refusals and everything else becomes a 500 and a log
    // line, which is the right outcome for a bug.
    throw toLedgerHttpError(error);
  }
}
