import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { ErrorCode } from '@elysium/contracts';
import { LoansError } from '@elysium/domain/loans';

import { toLedgerHttpError } from '../ledger/ledger.errors.js';

/**
 * What the loans module refuses, and with which status (architecture §23; M26).
 *
 * Codes from `packages/contracts/src/errors.ts`, so a client branches on the code. The
 * ledger's own refusals (a closed period, an inactive account) pass through
 * `toLedgerHttpError` unchanged.
 */

const STATUS: Readonly<Partial<Record<ErrorCode, number>>> = {
  LOAN_NOT_FOUND: 404,
  LOAN_LENDER_NOT_FOUND: 404,
  LEDGER_ACCOUNT_NOT_FOUND: 404,
  LOAN_TERMS_INVALID: 400,
  LOAN_SCHEDULE_INVALID: 400,
  LOAN_PAYMENT_INVALID: 409,
  LOAN_IMMUTABLE: 409,
  LOAN_SELF_VOID: 403,
  IDEMPOTENCY_CONFLICT: 409,
  CONFLICT: 409,
  FORBIDDEN: 403,
};

export class LoansHttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LoansHttpError';
  }
}

export function loansHttpError(code: ErrorCode, message: string): HttpException {
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

/** The database's own refusals start with a code (0095), found through Drizzle's wrapper. */
const DB_CODES: readonly ErrorCode[] = [
  'LOAN_SCHEDULE_INVALID',
  'LOAN_PAYMENT_INVALID',
  'LOAN_IMMUTABLE',
  'LOAN_SELF_VOID',
];

function databaseCode(error: unknown): { code: ErrorCode; message: string } | null {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const match = /^([A-Z_]+): (.*)$/s.exec(current.message);
    if (match !== null) {
      const code = DB_CODES.find((candidate) => candidate === match[1]);
      if (code !== undefined) return { code, message: match[2] ?? current.message };
    }
  }
  return null;
}

export function pgCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** Run `work`, translating loan, ledger and database failures on the way out. */
export async function mapLoanErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpException) throw error;
    if (error instanceof LoansHttpError) throw loansHttpError(error.code, error.message);
    if (error instanceof LoansError) throw loansHttpError(error.code, error.message);
    const fromDatabase = databaseCode(error);
    if (fromDatabase !== null) throw loansHttpError(fromDatabase.code, fromDatabase.message);
    // A unique index: the backstop for two concurrent submits, each of which passed its own
    // check first. The payment path names its own (one live payment per instalment).
    if (pgCode(error) === '23505') {
      throw loansHttpError('CONFLICT', 'That was already recorded.');
    }
    throw toLedgerHttpError(error);
  }
}
