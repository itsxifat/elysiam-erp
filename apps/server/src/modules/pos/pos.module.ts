import { Module, type DynamicModule, type Provider } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { WalletsModule } from '../wallets/wallets.module.js';
import { BranchesService } from './branches.service.js';
import { POS_CATALOG, UnboundPosCatalog } from './ports/pos-catalog.port.js';
import { POS_STOCK, UnboundPosStock } from './ports/pos-stock.port.js';
import { NoPromoCodes, PROMO_CODES } from './ports/promo-code.port.js';
import { POS_WALLET_CLOSING, UnboundWalletClosing } from './ports/wallet-closing.port.js';
import { PosController } from './pos.controller.js';
import { PosPostingService } from './posting.service.js';
import { RegistersService } from './registers.service.js';
import { ReviewsService } from './reviews.service.js';
import { ShiftsService } from './shifts.service.js';
import { SyncService } from './sync.service.js';

/**
 * Branches and showroom POS (architecture §14, M23).
 *
 * Imports `LedgerModule` for `LEDGER_API` (every journal goes through
 * `ledger.post()` with a rule from `packages/domain/src/posting/pos.ts`),
 * `WalletsModule` for `WALLETS_API` (a tender's ledger account) and
 * `CatalogModule` for `CATALOG_API` (the selling price a sale is checked against).
 *
 * Four ports are bound here, each with a default that is safe before its owner
 * implements it:
 *
 * | port                 | owner                 | default                |
 * | -------------------- | --------------------- | ---------------------- |
 * | `POS_STOCK`          | inventory (M07)       | refuses (`Unbound…`)   |
 * | `POS_CATALOG`        | catalog (M06)         | refuses                |
 * | `POS_WALLET_CLOSING` | wallets (M08)         | refuses                |
 * | `PROMO_CODES`        | promo (M16)           | no code is ever valid  |
 *
 * `register()` takes replacements, which is how the suites bind the real
 * inventory and closing services before integration and how integration binds
 * them for good (`{ provide: POS_STOCK, useExisting: INVENTORY_API }`).
 */
@Module({})
export class PosModule {
  static register(overrides: readonly Provider[] = []): DynamicModule {
    const replaced = new Set(
      overrides.map((provider) =>
        typeof provider === 'object' && 'provide' in provider ? provider.provide : provider,
      ),
    );
    const defaults: Provider[] = [
      { provide: POS_STOCK, useClass: UnboundPosStock },
      { provide: POS_CATALOG, useClass: UnboundPosCatalog },
      { provide: POS_WALLET_CLOSING, useClass: UnboundWalletClosing },
      { provide: PROMO_CODES, useClass: NoPromoCodes },
    ].filter((provider) => !replaced.has(provider.provide));

    return {
      module: PosModule,
      imports: [LedgerModule, WalletsModule, CatalogModule],
      controllers: [PosController],
      providers: [
        PosPostingService,
        RegistersService,
        ShiftsService,
        SyncService,
        ReviewsService,
        BranchesService,
        ...defaults,
        ...overrides,
      ],
      exports: [PosPostingService],
    };
  }
}
