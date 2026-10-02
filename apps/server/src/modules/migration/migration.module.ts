import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { SupplyModule } from '../supply/supply.module.js';
import { WalletsModule } from '../wallets/wallets.module.js';
import { MigrationService } from './migration.service.js';

/**
 * Data migration and opening balances (M14a).
 *
 * No controller: the importers are run by the implementation team through
 * `pnpm migration` (D-214), which boots this module as an application context the way
 * the worker boots its modules. Every write goes through the owning module's interface,
 * so the imports below are the whole of what this module may touch (invariant 12).
 * `ApprovalsModule` is here for `AuditService`, which it exports.
 */
@Module({
  imports: [
    ApprovalsModule,
    CatalogModule,
    InventoryModule,
    LedgerModule,
    OrdersModule,
    SupplyModule,
    WalletsModule,
  ],
  providers: [MigrationService],
  exports: [MigrationService],
})
export class MigrationModule {}
