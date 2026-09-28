import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { CashService } from './cash.service.js';
import { ClosingsService } from './closings.service.js';
import { WalletReportsService } from './reports.service.js';
import { TransfersService } from './transfers.service.js';
import { WALLETS_API, WalletsApiService } from './wallets.api.js';
import { WalletsController } from './wallets.controller.js';
import { WalletsService } from './wallets.service.js';

/**
 * Wallets, cash entries, transfers, daily closings and the cash reports
 * (architecture §6, §7).
 *
 * Imports `LedgerModule` for `LEDGER_API` — every journal this module causes is
 * posted through `ledger.post()` with a posting rule from
 * `packages/domain/src/posting` (invariant 2, invariant 12), and nothing here
 * writes `ledger.journals` or `ledger.journal_lines` — and `ApprovalsModule` for
 * the two executors it registers: `wallet_adjustment` (petty cash above the
 * threshold) and `closing_variance` (a till that did not balance).
 *
 * `WALLETS_API` is exported for M12, whose settlement posting has to name a wallet's
 * ledger account inside the transaction that writes the settlement — see
 * `wallets.api.ts` for why the wallet *list* cannot answer that.
 */
@Module({
  imports: [LedgerModule, ApprovalsModule],
  controllers: [WalletsController],
  providers: [
    WalletsService,
    CashService,
    TransfersService,
    ClosingsService,
    WalletReportsService,
    { provide: WALLETS_API, useClass: WalletsApiService },
  ],
  exports: [WalletsService, WALLETS_API],
})
export class WalletsModule {}
