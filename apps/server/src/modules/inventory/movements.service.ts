import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';
import {
  acceptsCallerUnitCost,
  assertMovementDelta,
  blendWac,
  businessDate,
  isBelowReorderLevel,
  isMovementKind,
  MOVEMENT_DIRECTION,
  poisha,
  reduceBasis,
  requiresCallerUnitCost,
  TRANSFER_KINDS,
  type MovementKind,
  type Poisha,
} from '@elysium/domain';

import { emit } from '../../platform/events/outbox.js';
import * as repo from './inventory.repository.js';
import { StockError } from './inventory.errors.js';

/**
 * The one place stock moves (architecture §8, invariant 3).
 *
 * Every stock change in the system — a supply receipt, a dispatch, a POS sale, a
 * transfer leg, a count correction, a write-off — comes through `apply`. Nothing
 * else writes `stock_movements` and nothing else writes `stock_levels.on_hand`.
 * That is not tidiness: the movement, the level and the weighted average have to
 * change together or not at all, and three call sites each doing two of the three
 * is how a system ends up with stock it cannot explain.
 *
 * What `apply` guarantees, in one transaction:
 *
 * 1. the movement row exists, with the sign its kind demands and the value the
 *    units moved at;
 * 2. the level is updated, and the database refuses the update unless this same
 *    transaction wrote that movement (migration 0033);
 * 3. the weighted average is blended or its basis reduced, under a row lock so two
 *    simultaneous receipts cannot each discard the other's blend;
 * 4. `stock.low` is emitted through the outbox if availability crossed the reorder
 *    point — through the outbox, so it fires only if the transaction commits.
 *
 * It does **not** post to the ledger. A movement and its journal are two facts
 * about one event, and which journal a movement needs depends on the event, not on
 * the movement: a dispatch posts a handover, a write-off posts against a different
 * account and only after an approval. So the callers post, through `LEDGER_API`,
 * in the same transaction.
 */

export interface MovementRequest {
  readonly skuId: string;
  readonly locationId: string;
  readonly kind: MovementKind;
  /** Magnitude, always positive. The sign comes from the kind (§8). */
  readonly qty: number;
  /**
   * Required for a receipt, an opening balance or a customer return — the kinds
   * whose cost is an outside fact. Refused for anything else, where the cost is
   * the current weighted average and accepting a caller's number would let a
   * dispatch re-price the stock it removes.
   */
  readonly unitCostPoisha?: Poisha | null;
  readonly refType: string;
  readonly refId: string | null;
  /** Makes the movement idempotent for a retried job (§20 is at-least-once). */
  readonly dedupeKey?: string | null;
  readonly occurredAt: Date;
  readonly memo?: string | null;
  /**
   * True when these units were reserved and are now shipping.
   *
   * It matters because releasing the reservation and removing the stock have to be
   * one statement: between a release and a separate dispatch the units read as
   * available, and an order confirmed in that window reserves stock that is already
   * in a courier's van.
   */
  readonly fromReservation?: boolean;
}

export interface AppliedMovement {
  readonly movementId: string;
  readonly skuId: string;
  readonly locationId: string;
  readonly qtyDelta: number;
  /** What the units moved at. Null only for a transfer leg, which has no value. */
  readonly unitCostPoisha: Poisha | null;
  readonly onHand: number;
  readonly reserved: number;
  readonly available: number;
  /** False when a dedupe key matched and this call wrote nothing. */
  readonly created: boolean;
}

@Injectable()
export class MovementsService {
  async apply(
    tx: Tx,
    actor: { readonly orgId: string; readonly userId: string },
    request: MovementRequest,
  ): Promise<AppliedMovement> {
    // Widened deliberately: the type says `MovementKind`, and this is the check that
    // makes the type true for a kind that reached here from untyped input — a job
    // payload, a migration, a future HTTP body.
    const kind: string = request.kind;
    if (!isMovementKind(kind)) {
      throw new StockError('STOCK_MOVEMENT_INVALID', `Unknown movement kind ${kind}.`);
    }
    if (!Number.isSafeInteger(request.qty) || request.qty <= 0) {
      throw new StockError('STOCK_MOVEMENT_INVALID', 'A movement needs a positive quantity.');
    }

    const direction = MOVEMENT_DIRECTION[request.kind];
    if (direction === 'either') {
      // `count_correction` is the one kind whose direction is discovered rather
      // than chosen, so it cannot be built from a magnitude. `applyCorrection`
      // below takes the signed delta instead.
      throw new StockError(
        'STOCK_MOVEMENT_INVALID',
        'A count correction carries a signed quantity; use applyCorrection.',
      );
    }
    const qtyDelta = direction === 'in' ? request.qty : -request.qty;
    return this.write(tx, actor, request, qtyDelta);
  }

  /** A count correction, which may go either way. */
  async applyCorrection(
    tx: Tx,
    actor: { readonly orgId: string; readonly userId: string },
    request: Omit<MovementRequest, 'kind' | 'qty'> & { readonly qtyDelta: number },
  ): Promise<AppliedMovement> {
    return this.write(
      tx,
      actor,
      { ...request, kind: 'count_correction', qty: Math.abs(request.qtyDelta) },
      request.qtyDelta,
    );
  }

  private async write(
    tx: Tx,
    actor: { readonly orgId: string; readonly userId: string },
    request: MovementRequest,
    qtyDelta: number,
  ): Promise<AppliedMovement> {
    assertMovementDelta(request.kind, qtyDelta);

    /*
     * The dedupe check comes first, before anything is locked or blended.
     *
     * A retried job that got as far as the cost row last time would otherwise
     * blend the same receipt twice and then fail on the unique index — leaving the
     * average wrong for a movement that was refused. Checking first makes the
     * retry a read.
     */
    if (request.dedupeKey != null) {
      const existing = await repo.movementByDedupeKey(tx, actor.orgId, request.dedupeKey);
      if (existing !== undefined) {
        const level = await repo.levelFor(tx, actor.orgId, request.skuId, request.locationId);
        return {
          movementId: existing.id,
          skuId: request.skuId,
          locationId: request.locationId,
          qtyDelta,
          // The value the first attempt recorded, not null: a caller aggregating a
          // journal across lines must see the same total on a replay, or the post it
          // builds disagrees with the one already keyed to this event.
          unitCostPoisha:
            existing.unit_cost_poisha === null ? null : poisha(BigInt(existing.unit_cost_poisha)),
          onHand: level?.on_hand ?? 0,
          reserved: level?.reserved ?? 0,
          available: (level?.on_hand ?? 0) - (level?.reserved ?? 0),
          created: false,
        };
      }
    }

    if (!(await repo.skuExists(tx, actor.orgId, request.skuId))) {
      // The same answer for another org's SKU as for one that does not exist: RLS
      // has already made them the same thing.
      throw new StockError('STOCK_NOT_FOUND', 'No such SKU in this brand.');
    }

    const unitCostPoisha = await this.resolveCost(tx, actor.orgId, request, qtyDelta);

    const movementId = await repo.insertMovement(tx, {
      orgId: actor.orgId,
      skuId: request.skuId,
      locationId: request.locationId,
      kind: request.kind,
      qtyDelta,
      unitCostPoisha,
      refType: request.refType,
      refId: request.refId,
      dedupeKey: request.dedupeKey ?? null,
      businessDate: businessDate(request.occurredAt),
      occurredAt: request.occurredAt,
      memo: request.memo ?? null,
      createdBy: actor.userId,
    });

    const level =
      request.fromReservation === true
        ? await this.consume(tx, actor.orgId, request, qtyDelta)
        : await this.adjustLevel(tx, actor.orgId, request, qtyDelta);

    await this.announceLow(tx, actor.orgId, request.skuId, level);

    return {
      movementId,
      skuId: request.skuId,
      locationId: request.locationId,
      qtyDelta,
      unitCostPoisha,
      onHand: level.on_hand,
      reserved: level.reserved,
      available: level.on_hand - level.reserved,
      created: true,
    };
  }

  /**
   * The level after this movement, or a refusal naming the reason.
   *
   * `applyLevelDelta` returns nothing when an outbound movement matched no level row
   * at all — the SKU has never been at this location. That is the same answer as an
   * empty shelf as far as the caller is concerned, so it becomes the same error; the
   * *other* shortfall, where a row exists and holds too little, is refused by the
   * CHECK and arrives here as a thrown 23514 that `databaseStockCode` maps with a
   * more specific message.
   */
  private async adjustLevel(
    tx: Tx,
    orgId: string,
    request: MovementRequest,
    qtyDelta: number,
  ): Promise<repo.LevelRow> {
    const level = await repo.applyLevelDelta(tx, {
      orgId,
      skuId: request.skuId,
      locationId: request.locationId,
      delta: qtyDelta,
    });
    if (level === undefined) {
      throw new StockError('STOCK_INSUFFICIENT', 'That SKU holds no stock at that location.');
    }
    return level;
  }

  private async consume(
    tx: Tx,
    orgId: string,
    request: MovementRequest,
    qtyDelta: number,
  ): Promise<repo.LevelRow> {
    const level = await repo.consumeReservedStock(tx, {
      orgId,
      skuId: request.skuId,
      locationId: request.locationId,
      qty: -qtyDelta,
    });
    if (level === undefined) {
      throw new StockError(
        'STOCK_INSUFFICIENT',
        'Those units are not reserved at that location, or are no longer on hand.',
      );
    }
    return level;
  }

  /**
   * What one unit is worth in this movement, and the cost row updated to match.
   *
   * Three cases, and the middle one is the one §7 depends on:
   *
   * * **A transfer** carries no value at all. §8: transfers never change cost, and
   *   a cost on the movement would invite a later reader to treat a van journey as
   *   a purchase.
   * * **Stock arriving** blends. The caller supplies the cost for a receipt, an
   *   opening balance or a customer return; for a gain or a positive count
   *   correction the service uses the current average, which blends to the same
   *   number and leaves the average where it was while correcting the basis.
   * * **Stock leaving** is valued at the current average, and that figure is
   *   recorded on the movement. §7's delivery journal has to credit goods in
   *   transit exactly what the handover debited it, and the average will have moved
   *   by then.
   */
  private async resolveCost(
    tx: Tx,
    orgId: string,
    request: MovementRequest,
    qtyDelta: number,
  ): Promise<Poisha | null> {
    if (TRANSFER_KINDS.includes(request.kind)) {
      if (request.unitCostPoisha != null) {
        throw new StockError(
          'STOCK_MOVEMENT_INVALID',
          'A transfer carries no cost: moving stock never changes what it is worth (§8).',
        );
      }
      return null;
    }

    const current = await repo.lockCost(tx, orgId, request.skuId);

    if (qtyDelta > 0) {
      if (requiresCallerUnitCost(request.kind)) {
        if (request.unitCostPoisha == null) {
          throw new StockError(
            'STOCK_MOVEMENT_INVALID',
            `A ${request.kind} carries the unit cost the stock enters at.`,
          );
        }
      } else if (request.unitCostPoisha != null && !acceptsCallerUnitCost(request.kind)) {
        throw new StockError(
          'STOCK_MOVEMENT_INVALID',
          `A ${request.kind} is valued at the current weighted average; it cannot set one.`,
        );
      }
      const unitCostPoisha = request.unitCostPoisha ?? poisha(current.wacPoisha);
      const blended = blendWac({
        current: { wacPoisha: poisha(current.wacPoisha), qtyBasis: current.qtyBasis },
        receivedQty: qtyDelta,
        unitCostPoisha,
      });
      await repo.writeCost(tx, {
        orgId,
        skuId: request.skuId,
        wacPoisha: blended.wacPoisha,
        qtyBasis: blended.qtyBasis,
      });
      return unitCostPoisha;
    }

    if (request.unitCostPoisha != null && !acceptsCallerUnitCost(request.kind)) {
      throw new StockError(
        'STOCK_MOVEMENT_INVALID',
        'Stock leaving is valued at the weighted average it was carried at (§7).',
      );
    }
    const reduced = reduceBasis(
      { wacPoisha: poisha(current.wacPoisha), qtyBasis: current.qtyBasis },
      -qtyDelta,
    );
    await repo.writeCost(tx, {
      orgId,
      skuId: request.skuId,
      wacPoisha: reduced.wacPoisha,
      qtyBasis: reduced.qtyBasis,
    });
    // The frozen value an approval judged, where there is one; otherwise the
    // average the units were carried at.
    return request.unitCostPoisha ?? poisha(current.wacPoisha);
  }

  /**
   * `stock.low` when availability reached the reorder point (§8, §19).
   *
   * Emitted through the outbox, so it is announced only if the movement commits —
   * a rolled-back dispatch must not tell the warehouse to reorder. The payload is
   * quantities and a SKU code: it goes to `warehouse`, which holds no `read:cost`,
   * and a socket has no `serializeFor` in front of it.
   */
  private async announceLow(
    tx: Tx,
    orgId: string,
    skuId: string,
    level: repo.LevelRow,
  ): Promise<void> {
    if (
      !isBelowReorderLevel({ onHand: level.on_hand, reserved: level.reserved }, level.reorder_level)
    ) {
      return;
    }
    const codes = await repo.skuCodes(tx, orgId, [skuId]);
    await emit(
      tx,
      'stock.low',
      {
        skuId,
        skuCode: codes.get(skuId) ?? '',
        locationId: level.location_id,
        available: level.on_hand - level.reserved,
        reorderLevel: level.reorder_level,
      },
      { orgId },
    );
  }
}
