import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { AdjustmentsService } from './adjustments.service.js';
import { CountsService } from './counts.service.js';
import { InventoryController } from './inventory.controller.js';
import { INVENTORY_API, InventoryApiService } from './inventory.api.js';
import { MovementsService } from './movements.service.js';
import { ReconcileService } from './reconcile.service.js';
import { StockService } from './stock.service.js';
import { TransfersService } from './transfers.service.js';

/**
 * Stock levels, movements, reservations, costing, transfers and counts
 * (architecture §8, invariant 3).
 *
 * Imports `LedgerModule` for `LEDGER_API` — every journal this module causes is
 * posted through `ledger.post()` with a posting rule from
 * `packages/domain/src/posting` (invariants 2 and 12), and nothing here writes
 * `ledger.journals` or `ledger.journal_lines` — and `ApprovalsModule` for the two
 * executors it registers, `stock_write_off` and `stock_gain`.
 *
 * Other modules reach this one through `INVENTORY_API` and never through the
 * `inventory` schema's tables. That interface is where M09's supply receipts, M10's
 * reservations, M11's dispatches, M12's returns and M23's POS sales come in, and it
 * is deliberately the only door: a movement and the journal beside it have to be
 * written by one transaction, and a second module writing movements would be a
 * second module deciding when to post.
 */
@Module({
  imports: [LedgerModule, ApprovalsModule, CatalogModule],
  controllers: [InventoryController],
  providers: [
    MovementsService,
    StockService,
    AdjustmentsService,
    TransfersService,
    CountsService,
    ReconcileService,
    { provide: INVENTORY_API, useClass: InventoryApiService },
  ],
  exports: [INVENTORY_API, ReconcileService],
})
export class InventoryModule {}
