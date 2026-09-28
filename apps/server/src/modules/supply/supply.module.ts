import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { PaymentsService } from './payments.service.js';
import { ReturnsService } from './returns.service.js';
import { StatementsService } from './statements.service.js';
import { SuppliesService } from './supplies.service.js';
import { SuppliersService } from './suppliers.service.js';
import { SupplyController } from './supply.controller.js';

/**
 * Suppliers, supply entries, returns, advances and payments (architecture §7, §8).
 *
 * Three imports, each for one interface and nothing else (invariant 12):
 *
 * * `InventoryModule` for `INVENTORY_API`. A receipt's movements, its weighted average
 *   and its journal are one call — `receiveSupply` — so the three cannot disagree, and
 *   nothing here writes `inventory.*`.
 * * `LedgerModule` for `LEDGER_API`, used only by the three cash-side rules this module
 *   owns (advance paid, advance applied, supplier paid). Nothing here writes
 *   `ledger.journals` or `ledger.journal_lines`.
 * * `ApprovalsModule` for the `supplier_payment` executor: §6 routes a supplier payment
 *   above the org's threshold through a checker, and the approval's transaction is what
 *   posts it.
 */
@Module({
  imports: [InventoryModule, LedgerModule, ApprovalsModule],
  controllers: [SupplyController],
  providers: [
    SuppliersService,
    SuppliesService,
    ReturnsService,
    PaymentsService,
    StatementsService,
  ],
  exports: [SuppliersService],
})
export class SupplyModule {}
