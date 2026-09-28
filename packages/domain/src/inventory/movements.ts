import { poisha, type Poisha } from '../money/index.js';

/**
 * Stock movement kinds and what each one is allowed to do (architecture §8).
 *
 * The list is closed, and adding to it needs an architecture §8 edit and a row in
 * decisions.md (`.claude/rules/inventory.md`). The reason the enum is not just
 * documentation is `MOVEMENT_DIRECTION`: every kind names the sign its
 * `qty_delta` must carry, and both the database CHECK in migration 0031 and this
 * table encode the same rule. A `dispatch` recorded with a positive delta would
 * not fail anywhere obvious — it would quietly create stock, and the nightly
 * reconciliation would agree with it because levels are rebuilt from movements.
 */

export const MOVEMENT_KINDS = [
  'opening_balance',
  'supply_receipt',
  'supplier_return',
  'dispatch',
  'customer_return',
  'pos_sale',
  'pos_return',
  'transfer_out',
  'transfer_in',
  'adjustment_gain',
  'adjustment_loss',
  'count_correction',
] as const;

export type MovementKind = (typeof MOVEMENT_KINDS)[number];

/** Which way a kind may move stock. `either` is only for a count correction. */
export type MovementDirection = 'in' | 'out' | 'either';

export const MOVEMENT_DIRECTION: Readonly<Record<MovementKind, MovementDirection>> = {
  opening_balance: 'in',
  supply_receipt: 'in',
  supplier_return: 'out',
  dispatch: 'out',
  customer_return: 'in',
  pos_sale: 'out',
  pos_return: 'in',
  transfer_out: 'out',
  transfer_in: 'in',
  adjustment_gain: 'in',
  adjustment_loss: 'out',
  /**
   * A count is the one movement whose direction is discovered rather than
   * chosen: the shelf holds either more or less than the system thought, and
   * splitting it into two kinds would make "what did the December count find"
   * two queries whose union a reader has to trust.
   */
  count_correction: 'either',
};

/**
 * Kinds that blend into weighted average cost (§8 "WAC").
 *
 * Only two: a supply receipt, which brings in units at a purchase price, and a
 * customer return, which brings back units at the cost they were dispatched at.
 * Everything else either takes stock out — which leaves the average alone — or
 * moves it between locations, and §8 is explicit that transfers never change
 * cost. A transfer that blended would make cost depend on where stock sits,
 * so moving a carton between two warehouses would change the brand's COGS.
 */
export const WAC_BLENDING_KINDS: readonly MovementKind[] = [
  /*
   * An opening balance is the first receipt.
   *
   * §8 lists supply receipts and customer returns, and taken literally that
   * leaves stock migrated in at M14a carried at nothing — every COGS line and
   * every valuation for those units would read zero, which is worse than an
   * approximate cost. So an opening balance is a receipt for costing purposes and
   * carries the unit cost it is entered at (D-142).
   */
  'opening_balance',
  'supply_receipt',
  'customer_return',
  /* A showroom return is a customer return that happened at a till. */
  'pos_return',
];

/**
 * Kinds whose movement must carry a unit cost.
 *
 * The blending kinds need one to blend. `dispatch`, `pos_sale` and
 * `supplier_return` need one because §7 records the value the units left at on
 * the movement itself — the handover journal is `Dr goods in transit / Cr
 * inventory at WAC **at handover**`, and the delivery journal posted days later
 * has to use that same number rather than whatever the average has drifted to
 * since. Without the value on the row, a delivery after a price rise would
 * credit goods in transit more than the handover debited it, and the account
 * would never come back to zero.
 */
export const COSTED_MOVEMENT_KINDS: readonly MovementKind[] = [
  'opening_balance',
  'supply_receipt',
  'customer_return',
  'supplier_return',
  'dispatch',
  'pos_sale',
  'pos_return',
  'adjustment_gain',
  'adjustment_loss',
  'count_correction',
];

export class InventoryError extends Error {
  constructor(
    readonly code: InventoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'InventoryError';
  }
}

/** Kept in step with `packages/contracts/src/errors.ts` by a test. */
export type InventoryErrorCode =
  | 'STOCK_INSUFFICIENT'
  | 'STOCK_MOVEMENT_INVALID'
  | 'STOCK_LOCATION_INVALID'
  | 'STOCK_COUNT_INVALID'
  | 'STOCK_TRANSFER_INVALID';

/**
 * Whether the caller must supply the unit cost, or the service derives it.
 *
 * The blending kinds are the ones where the cost is an outside fact: an invoice
 * price, or what a returned unit was dispatched at. Everything else is valued at
 * the current weighted average — stock leaving is worth what it was carried at
 * (§7 records that figure on the movement), and stock appearing from a count or
 * an adjustment is worth the same as its neighbours, which is also what keeps the
 * average unmoved by a gain.
 */
export function requiresCallerUnitCost(kind: MovementKind): boolean {
  return WAC_BLENDING_KINDS.includes(kind);
}

/** Transfers never change cost (§8), so their movements carry no value at all. */
export const TRANSFER_KINDS: readonly MovementKind[] = ['transfer_out', 'transfer_in'];

/**
 * Kinds whose value may be supplied by the caller although it is not an outside
 * fact: the adjustments and the count correction.
 *
 * They are the kinds an approval stands behind. The value was computed from the
 * weighted average **when the request was raised**, and that is the figure a
 * checker judged and the figure the journal posts (D-078). The average can move
 * between the request and the decision, so a movement that re-derived it would
 * record a value the approved journal does not have — and then the stock ledger and
 * the general ledger would describe the same write-off with two numbers.
 *
 * Optional rather than required: an adjustment raised and executed with no approval
 * in between (a migration, a repair) still values itself at the current average.
 */
export const FROZEN_VALUE_KINDS: readonly MovementKind[] = [
  'adjustment_gain',
  'adjustment_loss',
  'count_correction',
];

export function acceptsCallerUnitCost(kind: MovementKind): boolean {
  return WAC_BLENDING_KINDS.includes(kind) || FROZEN_VALUE_KINDS.includes(kind);
}

export function isMovementKind(value: string): value is MovementKind {
  return (MOVEMENT_KINDS as readonly string[]).includes(value);
}

/**
 * Refuse a quantity delta that contradicts its kind, or is zero.
 *
 * Zero is refused rather than ignored because a zero-delta movement is a row
 * that claims something happened and changes nothing: it makes every "how did
 * this SKU get here" reconstruction longer without adding a fact.
 */
export function assertMovementDelta(kind: MovementKind, qtyDelta: number): void {
  if (!Number.isSafeInteger(qtyDelta)) {
    throw new InventoryError('STOCK_MOVEMENT_INVALID', 'A quantity must be a whole number.');
  }
  if (qtyDelta === 0) {
    throw new InventoryError('STOCK_MOVEMENT_INVALID', 'A movement of zero units is not an event.');
  }
  const direction = MOVEMENT_DIRECTION[kind];
  if (direction === 'in' && qtyDelta < 0) {
    throw new InventoryError(
      'STOCK_MOVEMENT_INVALID',
      `A ${kind} adds stock, so its quantity cannot be negative.`,
    );
  }
  if (direction === 'out' && qtyDelta > 0) {
    throw new InventoryError(
      'STOCK_MOVEMENT_INVALID',
      `A ${kind} removes stock, so its quantity must be negative.`,
    );
  }
}

/** A unit cost as a movement may carry it: absent, or a non-negative amount. */
export function normalizeUnitCost(
  kind: MovementKind,
  unitCostPoisha: bigint | null,
): Poisha | null {
  if (unitCostPoisha === null) {
    if (WAC_BLENDING_KINDS.includes(kind)) {
      throw new InventoryError(
        'STOCK_MOVEMENT_INVALID',
        `A ${kind} carries the unit cost it enters stock at.`,
      );
    }
    return null;
  }
  if (unitCostPoisha < 0n) {
    throw new InventoryError('STOCK_MOVEMENT_INVALID', 'A unit cost cannot be negative.');
  }
  return poisha(unitCostPoisha);
}
