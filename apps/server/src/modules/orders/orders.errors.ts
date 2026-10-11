import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { isErrorCode, type ErrorCode } from '@elysium/contracts';
import { InventoryError, LedgerError, MoneyError, OrderError } from '@elysium/domain';

/**
 * Order failures, as the API reports them (architecture §23, D-087).
 *
 * Same shape as the ledger's, the catalog's and inventory's: a stable `code` from
 * `packages/contracts/src/errors.ts` plus a message, so a client branches on the code
 * and never on the wording.
 *
 * `databaseOrderCode` is the part worth reading, and it exists because **which layer
 * refuses depends on concurrency**. The domain state machine refuses an illegal
 * transition for a single request. Two agents pressing "confirm" and "cancel" on the
 * same order at the same time are refused by migration 0041's trigger instead, because
 * the second one's `where status = 'pending'` matched a row that had already moved. A
 * client that saw `ORDER_TRANSITION_INVALID` in testing and a 500 under load would be
 * debugging the wrong thing — so both paths produce the same code.
 *
 * The same reasoning covers stock: a confirm that cannot reserve is `STOCK_INSUFFICIENT`
 * whether inventory's conditional UPDATE matched nothing or the `stock_levels` CHECK
 * fired, and check 2 ("concurrent confirms on scarce stock never oversell") depends on
 * both answers being the same one.
 */

const STATUS: Readonly<Partial<Record<ErrorCode, number>>> = {
  ORDER_NOT_FOUND: 404,
  CUSTOMER_NOT_FOUND: 404,
  DELIVERY_ZONE_NOT_FOUND: 404,
  // 409, not 400: the request was well-formed and the order had moved. A client
  // reloads and tries again; a 400 would tell it to change the body instead.
  ORDER_TRANSITION_INVALID: 409,
  ORDER_ALREADY_CLAIMED: 409,
  ORDER_IMMUTABLE: 409,
  ORDER_LINES_FROZEN: 409,
  ORDER_EVENT_IMMUTABLE: 409,
  ORDER_COST_MOVED: 409,
  STOCK_INSUFFICIENT: 409,
  PERIOD_CLOSED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  APPROVAL_REQUIRED: 409,
  // M17: advances (D-230, D-231).
  ADVANCE_NOT_FOUND: 404,
  ADVANCE_DUPLICATE: 409,
  // Retryable once the order ends or the booking is cancelled.
  ADVANCE_PARCEL_IN_FLIGHT: 409,
  ADVANCE_IMMUTABLE: 409,
  // About who, not what: a second person verifies, the body is fine.
  ADVANCE_SELF_VERIFY: 403,
  // M30 (D-364): about who is asking, not the body. An org admin may enter the same price.
  ORDER_DISCOUNT_ABOVE_CEILING: 403,
  // M41 (D-710 to D-718). Somebody else has the order: send it again acknowledging them.
  ORDER_HANDLED_BY_OTHER: 409,
  // About who is asking: the owner or a supervisor moves an order on.
  ORDER_ASSIGN_NOT_ALLOWED: 403,
  ORDER_ASSIGNEE_INVALID: 400,
  // The offer ended before the answer arrived; the queue shows what is left.
  ORDER_OFFER_GONE: 409,
  ORDER_CALL_INVALID: 400,
};

export class OrdersError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OrdersError';
  }
}

export function ordersHttpError(code: ErrorCode, message: string): HttpException {
  const body = { code, message };
  switch (STATUS[code] ?? 400) {
    case 404:
      return new NotFoundException(body);
    case 409:
      return new ConflictException(body);
    case 403:
      // A blocked buyer is a 403 and not a 409: §10 says the fix is an org_admin's
      // override, not a reload. Returning a conflict here sent the desk round the retry
      // loop the status code is supposed to tell it to skip.
      return new ForbiddenException(body);
    default:
      return new BadRequestException(body);
  }
}

/** Codes migration 0041 raises with a `CODE: message` prefix. */
const TRIGGER_CODES: readonly ErrorCode[] = [
  'ORDER_TRANSITION_INVALID',
  'ORDER_IMMUTABLE',
  'ORDER_LINES_FROZEN',
  'ORDER_EVENT_IMMUTABLE',
  // M17, migration 0088.
  'ADVANCE_IMMUTABLE',
  'ORDER_RETURN_REASON_REQUIRED',
];

/**
 * The CHECKs that mean something specific, and what to say instead of their names.
 *
 * A constraint name is never returned: it tells a caller the shape of our schema and
 * tells the user nothing. `orders_cod_matches_formula` is the one worth a sentence of
 * its own — it fires only when something wrote the amount columns without going through
 * the domain, so the message names the fix rather than the arithmetic.
 */
const CHECK_MESSAGES: Readonly<Record<string, { code: ErrorCode; message: string }>> = {
  orders_cod_matches_formula: {
    code: 'ORDER_TOTAL_INVALID',
    message:
      'The collectable amount does not match the order’s items, discount, delivery and advance.',
  },
  orders_discount_within_items: {
    code: 'ORDER_TOTAL_INVALID',
    message: 'The discount is more than the items are worth.',
  },
  orders_amounts_not_negative: {
    code: 'ORDER_TOTAL_INVALID',
    message: 'An order amount cannot be negative.',
  },
  order_lines_fulfilled_within_qty: {
    code: 'ORDER_LINES_INVALID',
    message: 'More units were delivered or returned than were ordered.',
  },
  order_lines_discount_within_line: {
    code: 'ORDER_TOTAL_INVALID',
    message: 'A line discount cannot be more than the line is worth.',
  },
  customers_phone_e164: {
    code: 'ORDER_PHONE_INVALID',
    message: 'That is not a Bangladeshi mobile number.',
  },
  orders_ship_phone_e164: {
    code: 'ORDER_PHONE_INVALID',
    message: 'That is not a Bangladeshi mobile number.',
  },
  order_advances_four_eyes: {
    code: 'ADVANCE_SELF_VERIFY',
    message: 'The person who recorded an advance cannot also decide it.',
  },
  order_advances_voided: {
    code: 'ADVANCE_SELF_VERIFY',
    message: 'The person who verified an advance cannot also undo it.',
  },
  stock_levels_on_hand_not_negative: {
    code: 'STOCK_INSUFFICIENT',
    message: 'There is not enough stock at that location.',
  },
  stock_levels_reserved_within_on_hand: {
    code: 'STOCK_INSUFFICIENT',
    message: 'Those units are reserved for confirmed orders; release the reservations first.',
  },
};

const UNIQUE_MESSAGES: Readonly<Record<string, { code: ErrorCode; message: string }>> = {
  orders_org_no_idx: {
    // Two agents got the same number from the counter, which the counter's atomic
    // UPDATE is designed to prevent. Reported as retryable rather than as a conflict
    // the caller can fix, because there is nothing in the request to change.
    code: 'ORDER_TRANSITION_INVALID',
    message: 'That order number was just taken; try again.',
  },
  customers_org_phone_idx: {
    code: 'ORDER_PHONE_INVALID',
    message: 'A buyer with that phone number already exists in this brand.',
  },
  order_lines_org_order_sku_idx: {
    code: 'ORDER_LINES_INVALID',
    message: 'That SKU is already on this order; change its quantity instead.',
  },
  order_advances_org_live_ref_idx: {
    code: 'ADVANCE_DUPLICATE',
    message: 'That transaction id already backs an advance in this brand.',
  },
  delivery_zone_areas_org_area_idx: {
    code: 'DELIVERY_ZONE_NOT_FOUND',
    message: 'That district or thana is already mapped to a zone.',
  },
};

export function databaseOrderCode(error: unknown): { code: ErrorCode; message: string } | null {
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
      return CHECK_MESSAGES[name] ?? null;
    }
    if (sqlstate === '23505') {
      return (
        UNIQUE_MESSAGES[name] ?? {
          code: 'CONFLICT',
          message: 'That value is already taken in this brand.',
        }
      );
    }
  }
  return null;
}

/**
 * An error from another module that already carries a contract code.
 *
 * `INVENTORY_API.reserve` throws inventory's own `StockError`, which is not a domain error
 * and not an `HttpException` — so without this a confirm that ran out of stock answered 500,
 * and acceptance check 2 would have been asserting "the reservation failed somehow". Matched
 * structurally rather than by importing `StockError`: this module talks to inventory through
 * one interface (invariant 12), and importing its error class to re-throw it would make the
 * coupling wider than the interface it is supposed to be.
 */
function codedError(error: unknown): { code: ErrorCode; message: string } | null {
  if (!(error instanceof Error)) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string' || !isErrorCode(code)) return null;
  return { code, message: error.message };
}

export function toOrdersHttpError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof OrdersError) return ordersHttpError(error.code, error.message);
  // The domain's own errors already carry contract codes, so they pass through with
  // their message intact — the state machine's refusals are the most useful messages in
  // this module and rewording them here would lose the status and trigger it names.
  if (error instanceof OrderError) return ordersHttpError(error.code, error.message);
  if (error instanceof InventoryError) return ordersHttpError(error.code, error.message);
  if (error instanceof LedgerError) return ordersHttpError(error.code, error.message);
  if (error instanceof MoneyError) return ordersHttpError('MONEY_INVALID', error.message);
  // The database's own refusals first: a SQLSTATE is a more specific answer than a `code`
  // property that happens to look like a contract code.
  const fromDatabase = databaseOrderCode(error);
  if (fromDatabase !== null) return ordersHttpError(fromDatabase.code, fromDatabase.message);
  const coded = codedError(error);
  if (coded !== null) return ordersHttpError(coded.code, coded.message);
  return error;
}

export async function mapOrderErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toOrdersHttpError(error);
  }
}
