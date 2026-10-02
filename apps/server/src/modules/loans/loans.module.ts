import { Module } from '@nestjs/common';

import { AuditService } from '../../platform/audit/audit.service.js';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { NOTIFY_API } from '../notify/notify.api.js';
import { NotifyModule } from '../notify/notify.module.js';
import { LoansController } from './loans.controller.js';
import { LoansService } from './loans.service.js';
import { LoanPaymentsService } from './payments.service.js';
import { LOANS_NOTIFY_PORT } from './ports/notify.port.js';
import { LoanRemindersService } from './reminders.service.js';

/**
 * Company loans: lenders, schedules, repayments, reminders and statements (§7, §15; M26).
 *
 * Three imports, each for one interface (invariant 12):
 *
 * - `LedgerModule` for `LEDGER_API`: the receipt and every repayment post through
 *   `ledger.post()` with a rule from `packages/domain/src/posting/company-loan.ts`, and the
 *   statement reads the lender's `loan_payable` balance through it.
 * - `ApprovalsModule` for the `loan_repayment` executor and rejection handler (D-298, D-299).
 * - `NotifyModule` for `NOTIFY_API`, bound to this module's own port: a reminder queues its
 *   SMS inside its own transaction, and `notify.send` sends it after commit.
 */
@Module({
  imports: [LedgerModule, ApprovalsModule, NotifyModule],
  controllers: [LoansController],
  providers: [
    AuditService,
    LoansService,
    LoanPaymentsService,
    LoanRemindersService,
    { provide: LOANS_NOTIFY_PORT, useExisting: NOTIFY_API },
  ],
  exports: [LoanRemindersService],
})
export class LoansModule {}
