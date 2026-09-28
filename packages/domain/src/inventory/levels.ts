import { InventoryError, MOVEMENT_DIRECTION, type MovementKind } from './movements.js';

/**
 * Stock levels as a function of the movements behind them (architecture §8).
 *
 * `inventory.stock_levels` is a cache. The truth is the append-only movement
 * log, and §8 requires a nightly job that rebuilds the levels from it and alerts
 * on any drift. That rebuild is *this* function: pure, so the nightly job, the
 * property test and any future repair script all agree about what the level
 * should be, rather than each re-deriving it from the same SQL with a different
 * `where` clause.
 *
 * It is also what makes M07 check 2 a real check — "levels always equal Σ
 * movements" is only meaningful if Σ is computed by something other than the
 * code that maintained the level.
 */

/** A movement, reduced to the three fields a level depends on. */
export interface LevelMovement {
  readonly skuId: string;
  readonly locationId: string;
  readonly kind: MovementKind;
  readonly qtyDelta: number;
}

export interface LevelKey {
  readonly skuId: string;
  readonly locationId: string;
}

export interface Level {
  readonly onHand: number;
  readonly reserved: number;
}

/** `sku_id|location_id`, the key both this fold and the repository group by. */
export function levelKey(key: LevelKey): string {
  return `${key.skuId}|${key.locationId}`;
}

/**
 * Σ movements, per SKU and location.
 *
 * Refuses a movement whose delta contradicts its kind, because a fold that
 * silently accepts `dispatch: +5` would reproduce whatever mistake put the row
 * there and then report "no drift" — the reconciliation would confirm the
 * corruption rather than find it.
 */
export function foldMovements(movements: Iterable<LevelMovement>): Map<string, number> {
  const totals = new Map<string, number>();
  for (const movement of movements) {
    const direction = MOVEMENT_DIRECTION[movement.kind];
    if (direction === 'in' && movement.qtyDelta < 0) {
      throw new InventoryError(
        'STOCK_MOVEMENT_INVALID',
        `A ${movement.kind} movement carries a negative quantity.`,
      );
    }
    if (direction === 'out' && movement.qtyDelta > 0) {
      throw new InventoryError(
        'STOCK_MOVEMENT_INVALID',
        `A ${movement.kind} movement carries a positive quantity.`,
      );
    }
    const key = levelKey(movement);
    totals.set(key, (totals.get(key) ?? 0) + movement.qtyDelta);
  }
  return totals;
}

/**
 * Whether a movement may be applied to a level, and what the level becomes.
 *
 * The two refusals are invariant 3 restated as arithmetic: on-hand can never go
 * negative, and stock that is reserved for an order cannot be shipped out from
 * under it. The second is the one that is easy to miss — a write-off of the last
 * five units while five are reserved leaves `reserved > on_hand`, which the
 * database CHECK refuses, so a service that only guarded `on_hand >= 0` would
 * turn a legitimate business refusal into a 500.
 */
export function applyMovement(level: Level, qtyDelta: number): Level {
  const onHand = level.onHand + qtyDelta;
  if (onHand < 0) {
    throw new InventoryError(
      'STOCK_INSUFFICIENT',
      `That would leave ${String(onHand)} units on hand, and stock cannot go negative.`,
    );
  }
  if (onHand < level.reserved) {
    throw new InventoryError(
      'STOCK_INSUFFICIENT',
      `${String(level.reserved)} units are reserved, so only ${String(
        level.onHand - level.reserved,
      )} can leave.`,
    );
  }
  return { onHand, reserved: level.reserved };
}

/** What may still be reserved or picked: on-hand minus what is already held. */
export function availableQty(level: Level): number {
  return level.onHand - level.reserved;
}

/** True when the level has crossed its reorder point and `stock.low` is due (§8). */
export function isBelowReorderLevel(level: Level, reorderLevel: number): boolean {
  return reorderLevel > 0 && availableQty(level) <= reorderLevel;
}
