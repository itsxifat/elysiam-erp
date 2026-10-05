import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { PaymentsService } from './payments.service.js';
import { ReturnsService } from './returns.service.js';
import { SkuCostsController } from './sku-costs.controller.js';
import { SkuCostsService } from './sku-costs.service.js';
import { StatementsService } from './statements.service.js';
import { SuppliesService } from './supplies.service.js';
import { SuppliersService } from './suppliers.service.js';
import { SUPPLY_API, SupplyApiService } from './supply.api.js';
import { SupplyController } from './supply.controller.js';
import { SupplyReferencesBinding } from './references.binding.js';
import { SupplierDeletesController } from './supplier-deletes.controller.js';
import { SupplierDeletesService } from './supplier-deletes.service.js';

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
  // M39a: the catalog for its references registry (D-621); the catalog is a leaf, no cycle.
  // M39b (D-638): and for `CATALOG_API` (variant names and codes for the standard buying
  // price spreadsheet); nothing here reads the catalog's tables.
  imports: [InventoryModule, LedgerModule, ApprovalsModule, CatalogModule],
  // M39a: deleting a supplier nothing names (D-630).
  controllers: [SupplyController, SupplierDeletesController, SkuCostsController],
  providers: [
    // M39a: what supply holds about a SKU or a location (D-621, D-629).
    SupplyReferencesBinding,
    SupplierDeletesService,
    SkuCostsService,
    SuppliersService,
    SuppliesService,
    ReturnsService,
    PaymentsService,
    StatementsService,
    { provide: SUPPLY_API, useClass: SupplyApiService },
  ],
  exports: [SuppliersService, SUPPLY_API],
})
export class SupplyModule {}
