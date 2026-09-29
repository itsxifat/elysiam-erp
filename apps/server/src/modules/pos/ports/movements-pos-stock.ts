import type { Tx } from '@elysium/db';
import { poisha, type Poisha } from '@elysium/domain';

import type { PosSoldLine, PosStockLine, PosStockPort } from './pos-stock.port.js';

/**
 * `PosStockPort` over inventory's own movement writer — the exact body proposed for
 * `InventoryApiService.sellAtPos` and `receivePosReturn` at integration.
 *
 * Written against a structural `MovementApplier` rather than importing
 * `MovementsService`, so this module does not reach into inventory's internals
 * (invariant 12). Inventory's `MovementsService.apply` satisfies it as it stands;
 * the suites construct this with the application's own instance, which is why the
 * acceptance tests read back real `inventory.stock_levels` rather than a double's
 * bookkeeping. At integration the two methods move into `inventory.api.ts` with
 * `this.movements` in place of the constructor argument, and `PosModule` binds
 * `POS_STOCK` to `INVENTORY_API`.
 */

export interface MovementApplier {
  apply(
    tx: Tx,
    actor: { readonly orgId: string; readonly userId: string },
    request: {
      readonly skuId: string;
      readonly locationId: string;
      readonly kind: 'pos_sale' | 'pos_return';
      readonly qty: number;
      readonly unitCostPoisha?: Poisha | null;
      readonly refType: string;
      readonly refId: string | null;
      readonly dedupeKey?: string | null;
      readonly occurredAt: Date;
      readonly memo?: string | null;
    },
  ): Promise<{ readonly unitCostPoisha: Poisha | null }>;
}

export interface AvailabilityReader {
  availability(
    tx: Tx,
    orgId: string,
    locationId: string,
    skuIds: readonly string[],
  ): Promise<Map<string, number>>;
}

export class MovementsPosStock implements PosStockPort {
  constructor(
    private readonly movements: () => MovementApplier,
    private readonly inventory: () => AvailabilityReader,
  ) {}

  async sellAtPos(
    tx: Tx,
    actor: { readonly orgId: string; readonly userId: string },
    input: {
      readonly saleId: string;
      readonly locationId: string;
      readonly occurredAt: Date;
      readonly lines: readonly PosStockLine[];
    },
  ): Promise<{ readonly lines: readonly PosSoldLine[] }> {
    const sold: PosSoldLine[] = [];
    for (const line of input.lines) {
      /*
       * `pos_sale` without a reservation: the till's customer is standing at the
       * counter, so there is no gap between promising and taking a unit. The level
       * update is still guarded by `stock_levels`' CHECKs — on hand never negative,
       * reserved never above on hand — so a till cannot take a unit a confirmed
       * online order is holding, and a shortfall is the database's refusal rather
       * than a read-then-write race (invariant 3).
       */
      const applied = await this.movements().apply(tx, actor, {
        skuId: line.skuId,
        locationId: input.locationId,
        kind: 'pos_sale',
        qty: line.qty,
        refType: 'pos_sale',
        refId: input.saleId,
        dedupeKey: `pos_sale:${input.saleId}:${line.skuId}`,
        occurredAt: input.occurredAt,
        memo: null,
      });
      sold.push({ ...line, unitCostPoisha: poisha(applied.unitCostPoisha ?? 0n) });
    }
    return { lines: sold };
  }

  async receivePosReturn(
    tx: Tx,
    actor: { readonly orgId: string; readonly userId: string },
    input: {
      readonly returnId: string;
      readonly locationId: string;
      readonly occurredAt: Date;
      readonly lines: readonly (PosSoldLine & { readonly lineNo: number })[];
    },
  ): Promise<void> {
    for (const line of input.lines) {
      await this.movements().apply(tx, actor, {
        skuId: line.skuId,
        locationId: input.locationId,
        kind: 'pos_return',
        qty: line.qty,
        // §8: back in at the cost it left at, which the sale's movement recorded.
        unitCostPoisha: line.unitCostPoisha,
        refType: 'pos_return',
        refId: input.returnId,
        dedupeKey: `pos_return:${input.returnId}:${String(line.lineNo)}`,
        occurredAt: input.occurredAt,
        memo: null,
      });
    }
  }

  availability(
    tx: Tx,
    orgId: string,
    locationId: string,
    skuIds: readonly string[],
  ): Promise<Map<string, number>> {
    return this.inventory().availability(tx, orgId, locationId, skuIds);
  }
}
