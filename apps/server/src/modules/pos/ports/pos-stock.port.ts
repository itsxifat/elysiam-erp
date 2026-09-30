import type { Tx } from '@elysium/db';
import type { Poisha } from '@elysium/domain';

/**
 * What the till needs from inventory (architecture §8, invariant 3 and 12).
 *
 * This module may not touch `inventory.*`. So the POS declares the narrow shape it
 * needs and inventory implements it — the same arrangement
 * `orders/ports/fraud-gate.port.ts` uses with M13.
 *
 * `InventoryApiService` has `sellAtPos`, `receivePosReturn` and `availability`
 * with these signatures, so it satisfies this interface structurally and
 * `PosModule` binds `{ provide: POS_STOCK, useExisting: INVENTORY_API }`.
 *
 * ## Why the port moves stock but does not post
 *
 * §7's POS sale is **one** journal holding both the till's money and the cost of
 * the units, for the reason `orderDeliveredDraft` gives: gross profit on a sale is
 * one fact, and two journals let a retry post half of it. The module that knows
 * the tenders therefore posts, using the cost each movement **recorded** — the
 * same arrangement as `receiveCustomerReturn` and M12's delivery journal. Both
 * happen in the caller's transaction, so they commit together or not at all.
 */

export interface PosStockLine {
  readonly skuId: string;
  readonly qty: number;
}

export interface PosSoldLine extends PosStockLine {
  /** The weighted average the units left at, as the movement recorded it. */
  readonly unitCostPoisha: Poisha;
}

export interface PosStockPort {
  /**
   * `pos_sale` movements out of the register's location, one per SKU.
   *
   * Idempotent per `(saleId, skuId)` through the movement's dedupe key
   * (`pos_sale:<saleId>:<skuId>`): a replay returns the cost the first attempt
   * recorded and moves nothing.
   *
   * **Never takes a unit it does not have.** The level update is refused by
   * `stock_levels`' own CHECKs — on hand never negative, reserved never above on
   * hand — so a till cannot sell a unit already promised to a confirmed order.
   * A shortfall throws an error whose `code` is `STOCK_INSUFFICIENT` (or the
   * database's 23514 on a `stock_levels_*` constraint). The caller runs this inside
   * a savepoint, so the refusal rolls back only the attempt, not the sale record.
   */
  sellAtPos(
    tx: Tx,
    actor: { readonly orgId: string; readonly userId: string },
    input: {
      readonly saleId: string;
      readonly locationId: string;
      readonly occurredAt: Date;
      readonly lines: readonly PosStockLine[];
    },
  ): Promise<{ readonly lines: readonly PosSoldLine[] }>;

  /**
   * `pos_return` movements back into the location, at the cost each unit was sold
   * at (§8: returns re-enter at the cost they left at, and blend into the average).
   * Idempotent per `(returnId, lineNo)`.
   */
  receivePosReturn(
    tx: Tx,
    actor: { readonly orgId: string; readonly userId: string },
    input: {
      readonly returnId: string;
      readonly locationId: string;
      readonly occurredAt: Date;
      readonly lines: readonly (PosSoldLine & { readonly lineNo: number })[];
    },
  ): Promise<void>;

  /** On hand minus reserved, per SKU, at one location. `InventoryApi` already has it. */
  availability(
    tx: Tx,
    orgId: string,
    locationId: string,
    skuIds: readonly string[],
  ): Promise<Map<string, number>>;
}

export const POS_STOCK = Symbol('PosStockPort');

/**
 * Whether an error is the shelf saying no.
 *
 * Two spellings reach here: the inventory service's own `STOCK_INSUFFICIENT` (an
 * outbound movement that matched no level row) and PostgreSQL's 23514 on a
 * `stock_levels_*` CHECK (a row that held too little). Both mean the same thing to
 * a till — this sale cannot take these units right now — and both become a review
 * item rather than an error.
 */
export function isStockShortfall(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (code === 'STOCK_INSUFFICIENT') return true;
    const constraint = (current as { constraint_name?: unknown }).constraint_name;
    if (
      code === '23514' &&
      typeof constraint === 'string' &&
      constraint.startsWith('stock_levels_')
    ) {
      return true;
    }
  }
  return false;
}
