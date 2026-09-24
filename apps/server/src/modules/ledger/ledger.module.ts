import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module.js';
import { CashService } from './cash.service.js';
import { LEDGER_API } from './ledger.api.js';
import { LedgerController } from './ledger.controller.js';
import { LedgerService } from './ledger.service.js';
import { PeriodsService } from './periods.service.js';
import { ReportsService } from './reports.service.js';

/**
 * The ledger (architecture §7). Other modules post through `LEDGER_API`
 * (`ledger.api.ts`) and never through the `ledger` schema's tables
 * (invariant 12). Imports approvals for the `period_reopen` executor.
 */
@Module({
  imports: [ApprovalsModule],
  controllers: [LedgerController],
  providers: [
    LedgerService,
    { provide: LEDGER_API, useExisting: LedgerService },
    CashService,
    PeriodsService,
    ReportsService,
  ],
  exports: [LEDGER_API],
})
export class LedgerModule {}
