import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';
import {
  handoverDraft,
  mulQty,
  poisha,
  sum,
  stockInHandDraft,
  supplyReceivedDraft,
  supplierReturnDraft,
  type AccountSubtype,
  type Poisha,
} from '@elysium/domain';

import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import { MovementsService } from './movements.service.js';
import * as repo from './inventory.repository.js';
import { StockError } from './inventory.errors.js';
import { lockWindow } from './stock-in-hand.repository.js';

/**
 * Inventory's service interface for other modules (invariant 12).
 *
 * The modules that need it are M09 (supply receipts and supplier returns), M10 and
 * M11 (reserve on confirm, dispatch on handover), M12 (returns coming back), M21
 * (reseller orders out of the Beownz location) and M23 (POS). None of them touch
 * `inventory.*` tables, and none of them post the inventory side of a journal
 * themselves.
 *
 * That last point is the reason this interface takes the shapes it does. §7 pairs
 * every stock event with a journal — a receipt debits inventory, a handover moves
 * value to goods in transit at the average **at handover** — and the pairing only
 * holds if one function does both in one transaction. If M09 recorded the movements
 * and then posted its own journal, the two would agree until the day one of them
 * threw.
 *
 * Every method joins the **caller's** `withOrg()` transaction, so the business
 * change, the stock movements and the journal commit together or not at all.
 */

export interface ReservationLine {
  readonly skuId: string;
  readonly locationId: string;
  readonly qty: number;
}

export interface ReservedLine extends ReservationLine {
  readonly reservationId: string;
  readonly available: number;
}

export interface DispatchLine {
  readonly skuId: string;
  readonly qty: number;
}

export interface SupplyLine {
  readonly skuId: string;
  readonly qty: number;
  readonly unitCostPoisha: Poisha;
}

export interface SupplierReturnLineInput {
  readonly skuId: string;
  readonly qty: number;
  /** What the supplier charged on the original line. */
  readonly originalUnitCostPoisha: Poisha;
}

export interface PostedStockEvent {
  readonly movementIds: readonly string[];
  /** Null when the event had no value to post — units carried at nothing. */
  readonly journalId: string | null;
  readonly valuePoisha: string;
}

export interface InventoryApi {
  /**
   * Hold stock for a reference, atomically (§8).
   *
   * All or nothing across the lines: an order that can only be half reserved is not
   * a confirmed order, and leaving the first two lines held while the third failed
   * would quietly take units off the shelf for an order nobody will ship. Throws
   * `STOCK_INSUFFICIENT` naming the line that ran out.
   *
   * Idempotent per `(refType, refId, skuId, locationId)`: confirming the same order
   * twice reserves once.
   */
  reserve(
    tx: Tx,
    actor: { orgId: string; userId: string },
    input: { refType: string; refId: string; lines: readonly ReservationLine[] },
  ): Promise<ReservedLine[]>;

  /** Give back everything this reference holds. Safe to call twice. */
  release(
    tx: Tx,
    actor: { orgId: string; userId: string },
    input: { refType: string; refId: string },
  ): Promise<number>;

  /**
   * Ship reserved stock and post §7's handover journal.
   *
   * The units leave the shelf and stop being reserved in one statement, the
   * weighted average at this moment is recorded on each movement, and the journal
   * moves that value from inventory to goods in transit. The recorded figure is what
   * M12's delivery journal must credit goods in transit with — not the average as it
   * stands then, or the account never returns to zero.
   */
  dispatch(
    tx: Tx,
    actor: { orgId: string; userId: string },
    input: {
      orderId: string;
      locationId: string;
      branchId: string | null;
      occurredAt: Date;
      lines: readonly DispatchLine[];
      /** Set when the units were reserved first, which an order's always are. */
      fromReservation?: boolean;
      memo?: string | null;
    },
  ): Promise<PostedStockEvent>;

  /**
   * Receive a supply: movements, weighted average, and Dr Inventory / Cr Supplier
   * payable (§7, §8).
   *
   * The only place purchase cost enters the system (invariant 5).
   */
  receiveSupply(
    tx: Tx,
    actor: { orgId: string; userId: string },
    input: {
      supplyId: string;
      supplierId: string;
      locationId: string;
      branchId: string | null;
      occurredAt: Date;
      lines: readonly SupplyLine[];
      memo?: string | null;
    },
  ): Promise<PostedStockEvent>;

  /**
   * Stock a brand already holds when it starts (M38a, D-602): `opening_balance` movements
   * at each line's cost, blended into the weighted average exactly as a receipt is, and
   * one journal for the entry, Dr Inventory / Cr Opening balance equity, keyed
   * `stock_in_hand:<entryId>:posted`.
   *
   * Movements and journal in the caller's transaction, by this one function, for the same
   * reason as `receiveSupply`. Refused with `OPENING_STOCK_CLOSED` once the brand's window
   * is closed: checked here too, under the window's share lock, so no caller can credit
   * equity after the close by forgetting to ask (the database's triggers check the entry).
   */
  receiveStockInHand(
    tx: Tx,
    actor: { orgId: string; userId: string },
    input: {
      entryId: string;
      locationId: string;
      branchId: string | null;
      occurredAt: Date;
      lines: readonly SupplyLine[];
      memo?: string | null;
    },
  ): Promise<PostedStockEvent>;

  /**
   * Take a posted stock-in-hand entry back out (M38a, D-602), after its approval: the
   * same pieces leave the same location at the cost they came in at (`adjustment_loss`
   * movements, keyed per entry, SKU and location), and the ledger reverses the entry's
   * journal (Dr Opening balance equity / Cr Inventory, invariant 2).
   *
   * Exact or refused: the journal relieves inventory at the entry's cost, so each SKU's
   * weighted average must still be that cost. Once the pieces have been averaged with
   * stock at another cost, taking them out at the entry's cost would leave the stock
   * ledger and 1300 Inventory describing different stock, so it is refused with
   * `STOCK_IN_HAND_REVERSAL_BLOCKED` and corrected by a count instead. Pieces no longer
   * at the location, or promised to orders, are refused by the movement as any removal is.
   * Refused too once the window is closed.
   */
  reverseStockInHand(
    tx: Tx,
    actor: { orgId: string; userId: string },
    input: {
      entryId: string;
      locationId: string;
      journalId: string;
      occurredAt: Date;
      lines: readonly SupplyLine[];
      reason: string;
    },
  ): Promise<PostedStockEvent>;

  /**
   * Return stock to a supplier: out at the current average, credited at the
   * original cost, difference to purchase price variance (§7, §8).
   */
  returnToSupplier(
    tx: Tx,
    actor: { orgId: string; userId: string },
    input: {
      returnId: string;
      supplierId: string;
      locationId: string;
      branchId: string | null;
      occurredAt: Date;
      lines: readonly SupplierReturnLineInput[];
      memo?: string | null;
    },
  ): Promise<PostedStockEvent>;

  /**
   * Bring a customer return back into stock at the cost it was dispatched at (§8).
   *
   * Movements and costing only. §7's return journal is `Dr Inventory / Cr Goods in
   * transit` and belongs to the module that knows whether the parcel was delivered,
   * partially delivered or refused — which is M12, not this one.
   */
  receiveCustomerReturn(
    tx: Tx,
    actor: { orgId: string; userId: string },
    input: {
      orderId: string;
      locationId: string;
      occurredAt: Date;
      lines: readonly (DispatchLine & { dispatchUnitCostPoisha: Poisha })[];
      memo?: string | null;
    },
  ): Promise<{ movementIds: readonly string[]; valuePoisha: string }>;

  /** The weighted average per SKU, for a module that needs to value something. */
  costFor(tx: Tx, orgId: string, skuIds: readonly string[]): Promise<Map<string, Poisha>>;

  /** Available units per SKU at one location: on hand minus reserved. */
  availability(
    tx: Tx,
    orgId: string,
    locationId: string,
    skuIds: readonly string[],
  ): Promise<Map<string, number>>;

  /**
   * `pos_sale` movements out of a register's location, one per SKU (M23, §8).
   *
   * No reservation: the till's customer is standing at the counter, so there is no
   * gap between promising a unit and taking it. The level update is still guarded
   * by `stock_levels`' CHECKs, so a till cannot take a unit a confirmed online
   * order is holding, and a shortfall is the database's refusal rather than a
   * read-then-write race (invariant 3).
   *
   * Idempotent per `(saleId, skuId)`: a replay returns the cost the first attempt
   * recorded and moves nothing.
   *
   * Movements and costing only. §7's POS sale is one journal holding the till's
   * money and the cost of the units, and the module that knows the tenders posts
   * it, in this same transaction, from the cost returned here.
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
   * at (§8: a return re-enters at the cost it left at). Idempotent per
   * `(returnId, lineNo)`.
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

  /**
   * A brand's opening stock (M14a): `opening_balance` movements at the cost each was
   * imported at, which §8 blends into the weighted average as a first receipt (D-142).
   *
   * Movements and costing only. The value is debited to inventory by the one opening
   * journal (D-213), posted by the caller in this same transaction — a journal per
   * movement would open the books thousands of times. Idempotent per opening, SKU and
   * location; `movementIds` and `valuePoisha` count only the movements this call wrote.
   */
  receiveOpening(
    tx: Tx,
    actor: { readonly orgId: string; readonly userId: string },
    input: {
      readonly openingId: string;
      readonly occurredAt: Date;
      readonly lines: readonly OpeningStockLine[];
    },
  ): Promise<{ readonly movementIds: readonly string[]; readonly valuePoisha: Poisha }>;

  /**
   * The stock valuation, Σ(WAC × on hand) over every location (§8): the same figure the
   * valuation report shows, for M14a's reconciliation. Purchase cost (invariant 5).
   */
  valuation(
    tx: Tx,
    orgId: string,
  ): Promise<{ readonly units: number; readonly stockValuePoisha: Poisha }>;

  /** The SKUs, of those given, that already have a movement or a cost basis. */
  heldSkus(tx: Tx, orgId: string, skuIds: readonly string[]): Promise<ReadonlySet<string>>;

  /**
   * On hand and reserved for these SKUs at these locations (M33): what the website's
   * availability is computed from (`availableForWeb`). Quantities only, never a cost; a
   * SKU with no row at a location is simply absent.
   */
  levelsAt(
    tx: Tx,
    orgId: string,
    skuIds: readonly string[],
    locationIds: readonly string[],
  ): Promise<readonly StockLevelAt[]>;
}

/** One `stock_levels` row's quantities. */
export interface StockLevelAt {
  readonly skuId: string;
  readonly locationId: string;
  readonly onHand: number;
  readonly reserved: number;
}

/** One SKU's opening stock at one location, at the brand's one cost for it (D-216). */
export interface OpeningStockLine {
  readonly skuId: string;
  readonly locationId: string;
  readonly qty: number;
  readonly unitCostPoisha: Poisha;
}

/** One SKU and a quantity at a till. */
export interface PosStockLine {
  readonly skuId: string;
  readonly qty: number;
}

/** The same line, with the weighted average the units left at. */
export interface PosSoldLine extends PosStockLine {
  readonly unitCostPoisha: Poisha;
}

export const INVENTORY_API = Symbol('InventoryApi');

@Injectable()
export class InventoryApiService implements InventoryApi {
  constructor(
    private readonly movements: MovementsService,
    @Inject(LEDGER_API) private readonly ledger: LedgerApi,
  ) {}

  async reserve(
    tx: Tx,
    actor: { orgId: string; userId: string },
    input: { refType: string; refId: string; lines: readonly ReservationLine[] },
  ): Promise<ReservedLine[]> {
    if (input.lines.length === 0) {
      throw new StockError('STOCK_MOVEMENT_INVALID', 'A reservation needs at least one line.');
    }

    // Already held? Confirming an order twice must not double the hold. Returned
    // as-is rather than topped up: a second reserve for the same reference with a
    // different quantity is a changed order, and changing an order's lines goes
    // through release-and-reserve so the difference is visible.
    const existing = await repo.activeReservations(tx, actor.orgId, input.refType, input.refId);
    if (existing.length > 0) {
      return existing.map((row) => ({
        reservationId: row.id,
        skuId: row.sku_id,
        locationId: row.location_id,
        qty: row.qty,
        available: 0,
      }));
    }

    const held: ReservedLine[] = [];
    for (const line of input.lines) {
      if (!Number.isSafeInteger(line.qty) || line.qty <= 0) {
        throw new StockError('STOCK_MOVEMENT_INVALID', 'A reserved quantity must be positive.');
      }
      const level = await repo.reserveStock(tx, {
        orgId: actor.orgId,
        skuId: line.skuId,
        locationId: line.locationId,
        qty: line.qty,
      });
      if (level === undefined) {
        /*
         * Zero rows updated. §8: that is `STOCK_INSUFFICIENT`, and it is the only
         * thing it can be — a missing level row and an exhausted one are the same
         * answer to "can I promise this unit", and distinguishing them would leak
         * whether a SKU has ever been stocked at a location.
         *
         * Throwing rolls the caller's transaction back, which is what releases the
         * lines already held in this loop. All-or-nothing is not implemented here;
         * it is inherited from the transaction.
         */
        throw new StockError(
          'STOCK_INSUFFICIENT',
          `Not enough stock to reserve ${String(line.qty)} of that SKU at that location.`,
        );
      }
      const reservationId = await repo.insertReservation(tx, {
        orgId: actor.orgId,
        skuId: line.skuId,
        locationId: line.locationId,
        qty: line.qty,
        refType: input.refType,
        refId: input.refId,
        createdBy: actor.userId,
      });
      held.push({ ...line, reservationId, available: level.on_hand - level.reserved });
    }
    return held;
  }

  async release(
    tx: Tx,
    actor: { orgId: string; userId: string },
    input: { refType: string; refId: string },
  ): Promise<number> {
    const active = await repo.activeReservations(tx, actor.orgId, input.refType, input.refId);
    for (const row of active) {
      const level = await repo.releaseStock(tx, {
        orgId: actor.orgId,
        skuId: row.sku_id,
        locationId: row.location_id,
        qty: row.qty,
      });
      if (level === undefined) {
        // The level holds fewer reserved units than this row claims, which means
        // something else already released them. Refusing loudly rather than
        // clamping: `reserved` going negative is the symptom of a double release,
        // and silently absorbing it here is what would make it permanent.
        throw new StockError(
          'STOCK_INSUFFICIENT',
          'That reservation is no longer held at its location.',
        );
      }
      await repo.settleReservation(tx, actor.orgId, row.id, 'released');
    }
    return active.length;
  }

  async dispatch(
    tx: Tx,
    actor: { orgId: string; userId: string },
    input: {
      orderId: string;
      locationId: string;
      branchId: string | null;
      occurredAt: Date;
      lines: readonly DispatchLine[];
      fromReservation?: boolean;
      memo?: string | null;
    },
  ): Promise<PostedStockEvent> {
    const movementIds: string[] = [];
    const costed: { qty: number; unitCostPoisha: Poisha }[] = [];

    for (const line of input.lines) {
      const applied = await this.movements.apply(tx, actor, {
        skuId: line.skuId,
        locationId: input.locationId,
        kind: 'dispatch',
        qty: line.qty,
        refType: 'order',
        refId: input.orderId,
        dedupeKey: `order:${input.orderId}:dispatch:${line.skuId}:${input.locationId}`,
        occurredAt: input.occurredAt,
        memo: input.memo ?? null,
        ...(input.fromReservation === true ? { fromReservation: true } : {}),
      });
      if (applied.created) movementIds.push(applied.movementId);
      costed.push({
        qty: line.qty,
        unitCostPoisha: poisha(applied.unitCostPoisha ?? 0n),
      });
    }

    if (movementIds.length === 0) {
      // Every line was a replay. The journal is idempotent too, so posting again
      // would be harmless — but reading the existing value back to report it would
      // be a query for a number nobody asked for.
      return { movementIds, journalId: null, valuePoisha: '0' };
    }

    for (const row of await repo.activeReservations(tx, actor.orgId, 'order', input.orderId)) {
      await repo.settleReservation(tx, actor.orgId, row.id, 'consumed');
    }

    const total = costed.reduce((sum, line) => sum + line.unitCostPoisha * BigInt(line.qty), 0n);
    if (total === 0n) {
      // Units carried at nothing — migrated opening stock with no cost, or samples.
      // There is no journal for a value of zero (§7's balance trigger needs two
      // positive sides), and the movements are still the record of the dispatch.
      return { movementIds, journalId: null, valuePoisha: '0' };
    }

    const [goodsInTransit, inventory] = await Promise.all([
      this.account(tx, actor.orgId, 'goods_in_transit'),
      this.account(tx, actor.orgId, 'inventory'),
    ]);

    const posted = await this.ledger.post(
      tx,
      actor,
      handoverDraft({
        orderId: input.orderId,
        occurredAt: input.occurredAt,
        goodsInTransit,
        inventory,
        lines: costed,
        branchId: input.branchId,
        memo: input.memo ?? null,
      }),
    );
    return { movementIds, journalId: posted.journalId, valuePoisha: total.toString() };
  }

  async receiveSupply(
    tx: Tx,
    actor: { orgId: string; userId: string },
    input: {
      supplyId: string;
      supplierId: string;
      locationId: string;
      branchId: string | null;
      occurredAt: Date;
      lines: readonly SupplyLine[];
      memo?: string | null;
    },
  ): Promise<PostedStockEvent> {
    const movementIds: string[] = [];
    for (const line of input.lines) {
      const applied = await this.movements.apply(tx, actor, {
        skuId: line.skuId,
        locationId: input.locationId,
        kind: 'supply_receipt',
        qty: line.qty,
        unitCostPoisha: line.unitCostPoisha,
        refType: 'supply',
        refId: input.supplyId,
        dedupeKey: `supply:${input.supplyId}:receipt:${line.skuId}:${input.locationId}`,
        occurredAt: input.occurredAt,
        memo: input.memo ?? null,
      });
      if (applied.created) movementIds.push(applied.movementId);
    }

    const [inventory, payable] = await Promise.all([
      this.account(tx, actor.orgId, 'inventory'),
      this.account(tx, actor.orgId, 'supplier_payable'),
    ]);

    const posted = await this.ledger.post(
      tx,
      actor,
      supplyReceivedDraft({
        supplyId: input.supplyId,
        occurredAt: input.occurredAt,
        inventory,
        payable,
        supplierId: input.supplierId,
        lines: input.lines.map((line) => ({ qty: line.qty, unitCostPoisha: line.unitCostPoisha })),
        branchId: input.branchId,
        memo: input.memo ?? null,
      }),
    );
    const total = input.lines.reduce(
      (sum, line) => sum + line.unitCostPoisha * BigInt(line.qty),
      0n,
    );
    return { movementIds, journalId: posted.journalId, valuePoisha: total.toString() };
  }

  async receiveStockInHand(
    tx: Tx,
    actor: { orgId: string; userId: string },
    input: {
      entryId: string;
      locationId: string;
      branchId: string | null;
      occurredAt: Date;
      lines: readonly SupplyLine[];
      memo?: string | null;
    },
  ): Promise<PostedStockEvent> {
    await this.assertOpeningWindowOpen(tx, actor.orgId);
    const movementIds: string[] = [];
    for (const line of input.lines) {
      const applied = await this.movements.apply(tx, actor, {
        skuId: line.skuId,
        locationId: input.locationId,
        // §8's opening kind: an outside cost, blended into WAC like a receipt (D-142).
        kind: 'opening_balance',
        qty: line.qty,
        unitCostPoisha: line.unitCostPoisha,
        refType: 'stock_in_hand',
        refId: input.entryId,
        dedupeKey: `stock_in_hand:${input.entryId}:${line.skuId}:${input.locationId}`,
        occurredAt: input.occurredAt,
        memo: input.memo ?? 'Stock in hand',
      });
      if (applied.created) movementIds.push(applied.movementId);
    }
    // The journal below is for every line; a line whose movement was already recorded would
    // be valued twice. Unreachable while the entry's status guards the post, and kept so.
    if (movementIds.length !== input.lines.length) {
      throw new StockError(
        'IDEMPOTENCY_CONFLICT',
        'Part of that entry’s stock was already recorded; nothing was posted.',
      );
    }

    const [inventory, equity] = await Promise.all([
      this.account(tx, actor.orgId, 'inventory'),
      this.account(tx, actor.orgId, 'opening_equity'),
    ]);

    const posted = await this.ledger.post(
      tx,
      actor,
      stockInHandDraft({
        entryId: input.entryId,
        occurredAt: input.occurredAt,
        inventory,
        equity,
        lines: input.lines.map((line) => ({ qty: line.qty, unitCostPoisha: line.unitCostPoisha })),
        branchId: input.branchId,
        memo: input.memo ?? null,
      }),
    );
    const total = input.lines.reduce(
      (sum, line) => sum + line.unitCostPoisha * BigInt(line.qty),
      0n,
    );
    return { movementIds, journalId: posted.journalId, valuePoisha: total.toString() };
  }

  async reverseStockInHand(
    tx: Tx,
    actor: { orgId: string; userId: string },
    input: {
      entryId: string;
      locationId: string;
      journalId: string;
      occurredAt: Date;
      lines: readonly SupplyLine[];
      reason: string;
    },
  ): Promise<PostedStockEvent> {
    await this.assertOpeningWindowOpen(tx, actor.orgId);

    // The averages first, each under its cost row's lock (held to commit), before anything
    // moves: a refusal then leaves nothing half done.
    for (const line of input.lines) {
      const cost = await repo.lockCost(tx, actor.orgId, line.skuId);
      if (cost.wacPoisha !== line.unitCostPoisha) {
        throw new StockError(
          'STOCK_IN_HAND_REVERSAL_BLOCKED',
          'Those pieces have since been averaged with stock at another cost, so they cannot be taken out at the cost they came in at. Correct the stock with a count instead.',
        );
      }
    }

    const movementIds: string[] = [];
    for (const line of input.lines) {
      const applied = await this.movements.apply(tx, actor, {
        skuId: line.skuId,
        locationId: input.locationId,
        kind: 'adjustment_loss',
        qty: line.qty,
        // The cost it came in at, which the check above holds equal to the average.
        unitCostPoisha: line.unitCostPoisha,
        refType: 'stock_in_hand',
        refId: input.entryId,
        dedupeKey: `stock_in_hand:${input.entryId}:${line.skuId}:${input.locationId}:reversed`,
        occurredAt: input.occurredAt,
        memo: `Stock in hand reversed: ${input.reason}`.slice(0, 500),
      });
      if (applied.created) movementIds.push(applied.movementId);
    }
    if (movementIds.length !== input.lines.length) {
      throw new StockError(
        'IDEMPOTENCY_CONFLICT',
        'Part of that reversal was already recorded; nothing was reversed.',
      );
    }

    const reversed = await this.ledger.reverse(
      tx,
      actor,
      input.journalId,
      input.reason,
      input.occurredAt,
    );
    const total = input.lines.reduce(
      (sum, line) => sum + line.unitCostPoisha * BigInt(line.qty),
      0n,
    );
    return { movementIds, journalId: reversed.journalId, valuePoisha: total.toString() };
  }

  async returnToSupplier(
    tx: Tx,
    actor: { orgId: string; userId: string },
    input: {
      returnId: string;
      supplierId: string;
      locationId: string;
      branchId: string | null;
      occurredAt: Date;
      lines: readonly SupplierReturnLineInput[];
      memo?: string | null;
    },
  ): Promise<PostedStockEvent> {
    const movementIds: string[] = [];
    const postingLines: {
      qty: number;
      originalUnitCostPoisha: Poisha;
      currentWacPoisha: Poisha;
    }[] = [];

    for (const line of input.lines) {
      /*
       * The movement first, and its recorded cost is what the journal relieves
       * inventory at.
       *
       * Read back from the movement rather than queried separately: the average is
       * captured under the cost row's lock inside `apply`, and a second read after
       * it would see whatever a concurrent receipt has since blended in. The journal
       * would then relieve inventory at a figure no movement records.
       */
      const applied = await this.movements.apply(tx, actor, {
        skuId: line.skuId,
        locationId: input.locationId,
        kind: 'supplier_return',
        qty: line.qty,
        refType: 'supply_return',
        refId: input.returnId,
        dedupeKey: `supply_return:${input.returnId}:${line.skuId}:${input.locationId}`,
        occurredAt: input.occurredAt,
        memo: input.memo ?? null,
      });
      if (applied.created) movementIds.push(applied.movementId);
      postingLines.push({
        qty: line.qty,
        originalUnitCostPoisha: line.originalUnitCostPoisha,
        currentWacPoisha: poisha(applied.unitCostPoisha ?? 0n),
      });
    }

    const [payable, inventory, variance] = await Promise.all([
      this.account(tx, actor.orgId, 'supplier_payable'),
      this.account(tx, actor.orgId, 'inventory'),
      this.account(tx, actor.orgId, 'purchase_price_variance'),
    ]);

    const posted = await this.ledger.post(
      tx,
      actor,
      supplierReturnDraft({
        returnId: input.returnId,
        occurredAt: input.occurredAt,
        payable,
        inventory,
        variance,
        supplierId: input.supplierId,
        lines: postingLines,
        branchId: input.branchId,
        memo: input.memo ?? null,
      }),
    );
    const credited = postingLines.reduce(
      (sum, line) => sum + line.originalUnitCostPoisha * BigInt(line.qty),
      0n,
    );
    return { movementIds, journalId: posted.journalId, valuePoisha: credited.toString() };
  }

  async receiveCustomerReturn(
    tx: Tx,
    actor: { orgId: string; userId: string },
    input: {
      orderId: string;
      locationId: string;
      occurredAt: Date;
      lines: readonly (DispatchLine & { dispatchUnitCostPoisha: Poisha })[];
      memo?: string | null;
    },
  ): Promise<{ movementIds: readonly string[]; valuePoisha: string }> {
    const movementIds: string[] = [];
    for (const line of input.lines) {
      const applied = await this.movements.apply(tx, actor, {
        skuId: line.skuId,
        locationId: input.locationId,
        kind: 'customer_return',
        qty: line.qty,
        // §8: a return re-enters at the cost it was dispatched at, which the
        // dispatch movement recorded. Using today's average instead would let a
        // price rise between dispatch and return create inventory value out of a
        // refund.
        unitCostPoisha: line.dispatchUnitCostPoisha,
        refType: 'order',
        refId: input.orderId,
        dedupeKey: `order:${input.orderId}:return:${line.skuId}:${input.locationId}`,
        occurredAt: input.occurredAt,
        memo: input.memo ?? null,
      });
      if (applied.created) movementIds.push(applied.movementId);
    }
    const total = input.lines.reduce(
      (sum, line) => sum + line.dispatchUnitCostPoisha * BigInt(line.qty),
      0n,
    );
    return { movementIds, valuePoisha: total.toString() };
  }

  async costFor(tx: Tx, orgId: string, skuIds: readonly string[]): Promise<Map<string, Poisha>> {
    const rows = await repo.costsFor(tx, orgId, skuIds);
    return new Map(rows.map((row) => [row.sku_id, poisha(BigInt(row.wac_poisha))]));
  }

  async availability(
    tx: Tx,
    orgId: string,
    locationId: string,
    skuIds: readonly string[],
  ): Promise<Map<string, number>> {
    const found = new Map<string, number>();
    for (const skuId of skuIds) {
      const level = await repo.levelFor(tx, orgId, skuId, locationId);
      found.set(skuId, level === undefined ? 0 : level.on_hand - level.reserved);
    }
    return found;
  }

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
      const applied = await this.movements.apply(tx, actor, {
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
      await this.movements.apply(tx, actor, {
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

  async receiveOpening(
    tx: Tx,
    actor: { readonly orgId: string; readonly userId: string },
    input: {
      readonly openingId: string;
      readonly occurredAt: Date;
      readonly lines: readonly OpeningStockLine[];
    },
  ): Promise<{ readonly movementIds: readonly string[]; readonly valuePoisha: Poisha }> {
    // Opening stock credits equity like stock in hand, so it waits for the same window
    // (M38a, D-602): once an org admin said everything was counted in, M14a's opening
    // cannot bring more in either.
    if (input.lines.length > 0) await this.assertOpeningWindowOpen(tx, actor.orgId);
    const movementIds: string[] = [];
    const values: Poisha[] = [];
    for (const line of input.lines) {
      const applied = await this.movements.apply(tx, actor, {
        skuId: line.skuId,
        locationId: line.locationId,
        kind: 'opening_balance',
        qty: line.qty,
        unitCostPoisha: line.unitCostPoisha,
        refType: 'opening',
        refId: input.openingId,
        dedupeKey: `opening:${input.openingId}:${line.skuId}:${line.locationId}`,
        occurredAt: input.occurredAt,
        memo: 'Opening stock',
      });
      // The value the movements *wrote*, not the value asked for: a replayed line wrote
      // nothing, and the caller compares this with the journal it is about to post.
      if (!applied.created) continue;
      movementIds.push(applied.movementId);
      values.push(mulQty(poisha(applied.unitCostPoisha ?? 0n), applied.qtyDelta));
    }
    return { movementIds, valuePoisha: values.length === 0 ? poisha(0) : sum(values) };
  }

  async valuation(
    tx: Tx,
    orgId: string,
  ): Promise<{ readonly units: number; readonly stockValuePoisha: Poisha }> {
    // `true` for the scope: a server-side reconciliation, not a screen, so §6's branch
    // narrowing would only make the valuation smaller than the stock actually held.
    const totals = await repo.stockValuation(tx, orgId, { scope: sql`true` });
    return { units: totals.units, stockValuePoisha: poisha(BigInt(totals.stockValuePoisha)) };
  }

  async heldSkus(tx: Tx, orgId: string, skuIds: readonly string[]): Promise<ReadonlySet<string>> {
    return new Set(await repo.heldSkus(tx, orgId, skuIds));
  }

  async levelsAt(
    tx: Tx,
    orgId: string,
    skuIds: readonly string[],
    locationIds: readonly string[],
  ): Promise<readonly StockLevelAt[]> {
    const rows = await repo.levelsAt(tx, orgId, skuIds, locationIds);
    return rows.map((row) => ({
      skuId: row.sku_id,
      locationId: row.location_id,
      onHand: row.on_hand,
      reserved: row.reserved,
    }));
  }

  /** The brand's opening stock window, held `for share` to commit, and open (D-602). */
  private async assertOpeningWindowOpen(tx: Tx, orgId: string): Promise<void> {
    const window = await lockWindow(tx, orgId, 'share');
    if (window.status === 'closed') {
      throw new StockError(
        'OPENING_STOCK_CLOSED',
        'The opening stock window is closed: stock now comes in from a supplier, a transfer, a return or an approved adjustment.',
      );
    }
  }

  /** One of the four accounts §7's inventory rules name, or a clear refusal. */
  private async account(
    tx: Tx,
    orgId: string,
    subtype: AccountSubtype,
  ): Promise<{ accountId: string; subtype: AccountSubtype; branchId: string | null }> {
    const row = await repo.accountBySubtype(tx, orgId, subtype);
    if (row === undefined) {
      // Seeded by the chart-of-accounts template (D-084). If it is missing the
      // chart is broken, and saying so beats posting the value somewhere else.
      throw new StockError(
        'LEDGER_ACCOUNT_NOT_FOUND',
        `This organization has no ${subtype} account.`,
      );
    }
    return { accountId: row.id, subtype, branchId: row.branch_id };
  }
}
