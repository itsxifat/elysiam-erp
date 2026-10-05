import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module.js';
import { CATALOG_API } from '../catalog/catalog.api.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { INVENTORY_API } from '../inventory/inventory.api.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { ClosingsService } from '../wallets/closings.service.js';
import { WalletsModule } from '../wallets/wallets.module.js';
import { BranchesService } from './branches.service.js';
import { POS_CATALOG } from './ports/pos-catalog.port.js';
import { POS_STOCK } from './ports/pos-stock.port.js';
import { NoPromoCodes, PROMO_CODES } from './ports/promo-code.port.js';
import { POS_WALLET_CLOSING } from './ports/wallet-closing.port.js';
import { PosController } from './pos.controller.js';
import { PosPostingService } from './posting.service.js';
import { RegistersService } from './registers.service.js';
import { ReviewsService } from './reviews.service.js';
import { ShiftsService } from './shifts.service.js';
import { SyncService } from './sync.service.js';
import { PosReferencesBinding } from './references.binding.js';
import { HrModule } from '../hr/hr.module.js';
import { BranchAdminController } from './branch-admin.controller.js';
import { BranchAdminService } from './branch-admin.service.js';

/**
 * Branches and showroom POS (architecture §14, M23).
 *
 * Imports `LedgerModule` for `LEDGER_API` (every journal goes through
 * `ledger.post()` with a rule from `packages/domain/src/posting/pos.ts`),
 * `WalletsModule` for `WALLETS_API` (a tender's ledger account) and its closing,
 * `CatalogModule` for `CATALOG_API` (the selling price a sale is checked against),
 * `InventoryModule` for the stock movements, and `ApprovalsModule` only for the
 * `AuditService` it exports — this module raises no approval type of its own; the
 * closing variance is M08's, raised by M08.
 *
 * The POS reaches other modules only through four ports, each bound here to the
 * service that owns the work (invariant 12):
 *
 * | port                 | bound to                                   |
 * | -------------------- | ------------------------------------------ |
 * | `POS_STOCK`          | inventory's `INVENTORY_API` (M07)          |
 * | `POS_CATALOG`        | the catalog's `CATALOG_API` (M06)          |
 * | `POS_WALLET_CLOSING` | wallets' `ClosingsService` (M08)           |
 * | `PROMO_CODES`        | `NoPromoCodes`; M16 applies codes at the desk only (D-209) |
 *
 * `NoPromoCodes` answers that no code is valid. That is a safe default for a
 * discount: the till sells at the catalog price until the till can redeem a code
 * when its sale syncs, which is what binding the real thing requires (D-209).
 */
@Module({
  // M39a: HR answers whether a branch still has staff before it is switched off (D-633).
  imports: [LedgerModule, WalletsModule, CatalogModule, InventoryModule, ApprovalsModule, HrModule],
  controllers: [PosController, BranchAdminController],
  providers: [
    // M39a: what the till holds about a SKU or a location (D-621, D-629).
    PosReferencesBinding,
    BranchAdminService,
    PosPostingService,
    RegistersService,
    ShiftsService,
    SyncService,
    ReviewsService,
    BranchesService,
    { provide: POS_STOCK, useExisting: INVENTORY_API },
    { provide: POS_CATALOG, useExisting: CATALOG_API },
    { provide: POS_WALLET_CLOSING, useExisting: ClosingsService },
    { provide: PROMO_CODES, useClass: NoPromoCodes },
  ],
  exports: [PosPostingService],
})
export class PosModule {}
