import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module.js';
import { FilesModule } from '../files/files.module.js';
import { IamDirectoryModule } from '../iam/iam.api.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { DistributionsService } from './distributions.service.js';
import { InvestorDocumentsService } from './documents.service.js';
import { InvestmentsService } from './investments.service.js';
import { InvestorsController } from './investors.controller.js';
import { InvestorsService } from './investors.service.js';
import { WithdrawalsService } from './withdrawals.service.js';

/**
 * Investors: capital in, profit declared, money out (architecture §7, §15).
 *
 * Three imports, each for one reason:
 *
 * - `LedgerModule` for `LEDGER_API`. Every journal this module causes is posted
 *   through `ledger.post()` with a posting rule from
 *   `packages/domain/src/posting` (invariants 2 and 12), and nothing here writes
 *   `ledger.journals` or `ledger.journal_lines`.
 * - `ApprovalsModule` for the two executors it registers: `investor_distribution`
 *   and `investor_withdrawal`, which are §6's "investor withdrawals and
 *   distributions". Both run inside the transaction that approved them, so an
 *   approved distribution with no journal is not a state the database can hold.
 * - `FilesModule` for `FilesService`, which mints the signed URL for a private
 *   document. This module never talks to the storage driver itself: the files
 *   module owns the purpose policy that decides who may read what (§22, D-115).
 */
@Module({
  imports: [LedgerModule, ApprovalsModule, FilesModule, IamDirectoryModule],
  controllers: [InvestorsController],
  providers: [
    InvestorsService,
    InvestmentsService,
    DistributionsService,
    WithdrawalsService,
    InvestorDocumentsService,
  ],
  exports: [InvestorsService],
})
export class InvestorsModule {}
