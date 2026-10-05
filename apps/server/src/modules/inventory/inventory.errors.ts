import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { ErrorCode } from '@elysium/contracts';
import { InventoryError, LedgerError, MoneyError } from '@elysium/domain';

/**
 * Inventory failures, as the API reports them (architecture §23, D-087).
 *
 * Same shape as the ledger's and the catalog's: a stable `code` from
 * `packages/contracts/src/errors.ts` plus a message, so a client branches on the
 * code and never on the wording.
 *
 * `databaseStockCode` is the part worth reading. Migrations 0033 and 0034 raise
 * six of these codes from triggers, and the `stock_levels` CHECKs raise 23514 for
 * exactly the condition invariant 3 exists to produce — an oversell. Both have to
 * become the same codes the service raises, because **which layer notices depends
 * on concurrency**: a single request is refused by the service's own check, and
 * two simultaneous requests for the last unit are refused by the database. A
 * client that saw `STOCK_INSUFFICIENT` in testing and a 500 under load would be
 * debugging the wrong thing.
 */

const STATUS: Readonly<Partial<Record<ErrorCode, number>>> = {
  STOCK_NOT_FOUND: 404,
  // 409, not 400: the request was well-formed and the shelf disagreed. A client
  // retries a 409 after refreshing availability; a 400 tells it to change the body.
  STOCK_INSUFFICIENT: 409,
  STOCK_MOVEMENT_IMMUTABLE: 409,
  STOCK_MOVEMENT_REQUIRED: 409,
  STOCK_COUNT_INVALID: 409,
  STOCK_TRANSFER_INVALID: 409,
  STOCK_ADJUSTMENT_FROZEN: 409,
  STOCK_ADJUSTMENT_APPROVAL_INVALID: 409,
  APPROVAL_REQUIRED: 409,
  // M38a (D-602): the window said no, or the entry is already posted.
  OPENING_STOCK_CLOSED: 409,
  OPENING_STOCK_INVALID: 409,
  OPENING_STOCK_REOPEN_UNAPPROVED: 409,
  OPENING_STOCK_REOPEN_PENDING: 409,
  STOCK_IN_HAND_NOT_FOUND: 404,
  STOCK_IN_HAND_IMMUTABLE: 409,
  STOCK_IN_HAND_CHANGED: 409,
  STOCK_IN_HAND_REVERSAL_BLOCKED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_IN_FLIGHT: 409,
  FORBIDDEN: 403,
};

export class StockError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StockError';
  }
}

export function stockHttpError(code: ErrorCode, message: string): HttpException {
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

/** Codes migrations 0033 and 0034 raise with a `CODE: message` prefix. */
const TRIGGER_CODES: readonly ErrorCode[] = [
  'STOCK_MOVEMENT_IMMUTABLE',
  'STOCK_MOVEMENT_REQUIRED',
  'STOCK_MOVEMENT_INVALID',
  'STOCK_LOCATION_INVALID',
  'STOCK_COUNT_INVALID',
  'STOCK_TRANSFER_INVALID',
  'STOCK_ADJUSTMENT_FROZEN',
  'STOCK_ADJUSTMENT_APPROVAL_INVALID',
  // The M38a policies migration's triggers (D-602).
  'OPENING_STOCK_CLOSED',
  'OPENING_STOCK_INVALID',
  'OPENING_STOCK_REOPEN_UNAPPROVED',
  'STOCK_IN_HAND_INVALID',
  'STOCK_IN_HAND_IMMUTABLE',
  'STOCK_IN_HAND_COST_REQUIRED',
];

/**
 * The CHECKs that mean "not enough stock", and what to say instead of their names.
 *
 * `stock_levels_reserved_within_on_hand` is the interesting one: it fires when a
 * write-off or a dispatch would leave fewer units on hand than are already
 * reserved for confirmed orders. That is not an oversell of the shelf, it is an
 * oversell of a promise, and the message says so — otherwise a warehouse clerk is
 * told "not enough stock" while looking at a full shelf.
 */
const CHECK_MESSAGES: Readonly<Record<string, string>> = {
  stock_levels_on_hand_not_negative: 'There is not enough stock at that location.',
  stock_levels_reserved_within_on_hand:
    'Those units are reserved for confirmed orders; release the reservations first.',
  stock_levels_reserved_not_negative: 'More units were released than were ever reserved.',
};

/** Primary keys that are a client's idempotency key (M38a). */
const IN_FLIGHT_KEYS: ReadonlySet<string> = new Set([
  'stock_in_hand_entries_pkey',
  'count_scans_pkey',
]);

const UNIQUE_MESSAGES: Readonly<Record<string, string>> = {
  stock_movements_org_dedupe_idx: 'That stock movement has already been recorded.',
  reservations_org_active_ref_idx: 'That reference already holds a reservation for this SKU.',
  count_sessions_org_open_location_idx: 'A stock count is already open at that location.',
  locations_org_code_idx: 'A location with that code already exists in this brand.',
};

export function databaseStockCode(error: unknown): { code: ErrorCode; message: string } | null {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const prefixed = /^([A-Z_]+): (.*)$/s.exec(current.message);
    if (prefixed !== null) {
      const code = TRIGGER_CODES.find((candidate) => candidate === prefixed[1]);
      if (code !== undefined) return { code, message: prefixed[2] ?? current.message };
    }

    const sqlstate = (current as { code?: unknown }).code;
    const constraint = (current as { constraint_name?: unknown }).constraint_name;
    const name = typeof constraint === 'string' ? constraint : '';

    if (sqlstate === '23514' && Object.hasOwn(CHECK_MESSAGES, name)) {
      return { code: 'STOCK_INSUFFICIENT', message: CHECK_MESSAGES[name] ?? '' };
    }
    if (sqlstate === '23505' && IN_FLIGHT_KEYS.has(name)) {
      // Two saves of one entry (or one scan) at once, with the same client key: the second
      // lost the race to the first, which is still committing. Retrying answers it.
      return {
        code: 'IDEMPOTENCY_IN_FLIGHT',
        message: 'That save is already in progress; try again in a moment.',
      };
    }
    if (sqlstate === '23505') {
      return {
        code: 'STOCK_NOT_FOUND',
        // Never the index name: it tells a caller the shape of our schema and
        // tells the user nothing.
        message: UNIQUE_MESSAGES[name] ?? 'That value is already taken in this brand.',
      };
    }
  }
  return null;
}

export function toStockHttpError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof StockError) return stockHttpError(error.code, error.message);
  if (error instanceof InventoryError) return stockHttpError(error.code, error.message);
  if (error instanceof LedgerError) return stockHttpError(error.code, error.message);
  if (error instanceof MoneyError) return stockHttpError('MONEY_INVALID', error.message);
  const fromDatabase = databaseStockCode(error);
  if (fromDatabase !== null) return stockHttpError(fromDatabase.code, fromDatabase.message);
  return error;
}

export async function mapStockErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toStockHttpError(error);
  }
}
