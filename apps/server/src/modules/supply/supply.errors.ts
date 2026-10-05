import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { ErrorCode } from '@elysium/contracts';

import { toStockHttpError } from '../inventory/inventory.errors.js';

/**
 * What the supply module refuses, and with which status (architecture §23).
 *
 * The codes come from `packages/contracts/src/errors.ts` like every other module's,
 * so a client branches on the code and never on the wording. The ledger's own
 * failures and the inventory module's pass through unchanged — a closed period or an
 * insufficient stock level is their answer, and restating it here would give one
 * condition two codes.
 *
 * `DB_CODES` is the other half. Migration 0037's triggers raise
 * `SUPPLY_IMMUTABLE: …` and friends, and without this list a trigger's refusal
 * arrives as a 500 and a PostgreSQL message — which is the wrong answer twice over:
 * the caller can act on "that advance holds only 40,000 poisha unapplied" and cannot
 * act on "internal server error", and an alert fires for a fault that is really a
 * user mistake.
 */

const STATUS: Readonly<Partial<Record<ErrorCode, number>>> = {
  SUPPLY_NOT_FOUND: 404,
  SUPPLY_IMMUTABLE: 409,
  SUPPLY_COST_REQUIRED: 400,
  SUPPLIER_INACTIVE: 409,
  SUPPLY_ADVANCE_INVALID: 409,
  SUPPLY_PAYMENT_FROZEN: 409,
  APPROVAL_REQUIRED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  STOCK_LOCATION_INVALID: 400,
  // A wallet outside the caller's branch scope answers exactly as one that does not
  // exist, the way M08 answers it: any other answer enumerates other branches' tills.
  LEDGER_ACCOUNT_NOT_FOUND: 404,
  LEDGER_ACCOUNT_INVALID: 400,
  FORBIDDEN: 403,
  CONFLICT: 409,
  NOT_FOUND: 404,
  PERIOD_CLOSED: 409,
  // M39b (D-638): a standard buying price file that does not import; the body names why.
  SUPPLY_IMPORT_REJECTED: 422,
};

/** The trigger-raised codes in migration 0037, in the order that file declares them. */
const DB_CODES: readonly ErrorCode[] = [
  'STOCK_LOCATION_INVALID',
  'SUPPLY_NOT_FOUND',
  'SUPPLIER_INACTIVE',
  'SUPPLY_IMMUTABLE',
  'SUPPLY_ADVANCE_INVALID',
  'SUPPLY_PAYMENT_FROZEN',
  'LEDGER_ACCOUNT_INVALID',
  // Raised by migration 0014's period lock rather than by anything here: a supply
  // back-dated into a closed month is refused at the journal, and the caller has to
  // be told which month rather than shown a 500.
  'PERIOD_CLOSED',
];

/**
 * The unique indexes a person can actually collide with, and what to say instead of
 * their names.
 *
 * Never the index name in the message: it tells a caller the shape of the schema and
 * tells the user nothing. `supplies_org_supplier_invoice_idx` is the one that matters —
 * it is the partial index that stops one supplier invoice being received twice, which is
 * the expensive mistake in purchasing, and the person making it has to be told *which*
 * invoice rather than shown a 500.
 */
const UNIQUE_MESSAGES: Readonly<Record<string, string>> = {
  supplies_org_supplier_invoice_idx:
    'That invoice number is already recorded as received for this supplier.',
  suppliers_org_code_idx: 'A supplier with that code already exists in this brand.',
  supply_lines_org_supply_sku_idx:
    'That SKU is already on this entry; change its quantity instead of adding it twice.',
  advance_applications_org_payment_supply_idx:
    'That advance has already been applied to this supply entry.',
  supplier_documents_org_file_idx: 'That file is already attached to this supplier.',
};

/** The CHECKs a caller can reach, and the code each one really means. */
const CHECK_CODES: Readonly<Record<string, { code: ErrorCode; message: string }>> = {
  supply_lines_costed_when_received: {
    code: 'SUPPLY_COST_REQUIRED',
    message: 'Every line is priced before an entry is received (D-005).',
  },
  supplies_status_journal: {
    code: 'SUPPLY_IMMUTABLE',
    message: 'A received supply carries a date, a journal and whoever received it.',
  },
};

export class SupplyError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SupplyError';
  }
}

export function supplyHttpError(code: ErrorCode, message: string): HttpException {
  const body = { code, message };
  switch (STATUS[code] ?? 400) {
    case 403:
      return new ForbiddenException(body);
    case 404:
      return new NotFoundException(body);
    case 409:
      return new ConflictException(body);
    case 422:
      return new HttpException(body, 422);
    default:
      return new BadRequestException(body);
  }
}

/**
 * A trigger's refusal, recognised by its code prefix.
 *
 * Walks `.cause`, because Drizzle wraps the driver error and the message with the
 * code on it is one or two levels down.
 */
function databaseSupplyCode(error: unknown): { code: ErrorCode; message: string } | null {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const match = /^([A-Z_]+): (.*)$/s.exec(current.message);
    if (match !== null) {
      const code = DB_CODES.find((candidate) => candidate === match[1]);
      if (code !== undefined) return { code, message: match[2] ?? current.message };
    }

    const sqlstate = (current as { code?: unknown }).code;
    const constraint = (current as { constraint_name?: unknown }).constraint_name;
    const name = typeof constraint === 'string' ? constraint : '';

    if (sqlstate === '23505' && Object.hasOwn(UNIQUE_MESSAGES, name)) {
      return { code: 'CONFLICT', message: UNIQUE_MESSAGES[name] ?? '' };
    }
    if (sqlstate === '23514' && Object.hasOwn(CHECK_CODES, name)) {
      const mapped = CHECK_CODES[name];
      if (mapped !== undefined) return mapped;
    }
  }
  return null;
}

/** Run `work`, translating supply, inventory and ledger failures on the way out. */
export async function mapSupplyErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SupplyError) throw supplyHttpError(error.code, error.message);
    const fromDatabase = databaseSupplyCode(error);
    if (fromDatabase !== null) throw supplyHttpError(fromDatabase.code, fromDatabase.message);
    /*
     * Already an HTTP error, or a failure inventory or the ledger has a code for.
     * `toStockHttpError` handles `StockError`, `InventoryError`, `LedgerError`,
     * `MoneyError` and both modules' trigger codes, which is every failure a supply
     * receipt can inherit — it calls M07's and M03's translators in turn. Anything
     * else becomes a 500 and a log line, which is the right outcome for a fault we
     * did not anticipate.
     */
    throw toStockHttpError(error);
  }
}
