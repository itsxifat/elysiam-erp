import { Module } from '@nestjs/common';

import { serverEnv } from '../../platform/config/env.js';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { FilesModule } from '../files/files.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { AttendanceService } from './attendance.service.js';
import { EmployeesService } from './employees.service.js';
import { HR_API, HrApiService } from './hr.api.js';
import { HrController } from './hr.controller.js';
import { HR_CRYPTO, HrCrypto, hrFieldKey } from './hr.crypto.js';
import { LoansService } from './loans.service.js';
import { PayrollService } from './payroll.service.js';
import { PayslipService } from './payslip.service.js';

/**
 * Employees, attendance, salary, loans and payroll (architecture §7, §12).
 *
 * Imports three modules and nothing else, and each import is one of this milestone's
 * invariants made structural:
 *
 * * **`LedgerModule`** for `LEDGER_API`. Every journal payroll causes — the posting, the
 *   payment, a loan disbursement — goes through `ledger.post()` with a posting rule from
 *   `packages/domain/src/posting`, and nothing here writes `ledger.journals` or
 *   `ledger.journal_lines` (invariants 2 and 12).
 * * **`ApprovalsModule`** for the one executor it registers, `payroll_run`. The approval
 *   and the posting happen in the same transaction, so a run that says "approved" has
 *   posted its journal or neither happened.
 * * **`FilesModule`** for `GotenbergClient`, which renders the Bangla payslip. Not for the
 *   object store: the payslip is rendered on demand and never stored (see
 *   `payslip.service.ts`), so no private object has to be authorised, signed or eventually
 *   deleted.
 *
 * Other modules reach this one through `HR_API` and never through the `hr` schema's
 * tables. That interface is deliberately two methods wide — "which employee is this
 * login", "who is this employee" — because what M18's productivity metrics and M20's
 * targets need from HR is an identity, and a general accessor would be a way around §6's
 * `Payroll` grant.
 *
 * `HrCrypto` is built here from the parsed secret, once, at module construction — so
 * nothing downstream can choose a different key per request, and a deployment with a bad
 * `HR_FIELD_KEY` fails at boot rather than at the first employee record.
 */
@Module({
  imports: [LedgerModule, ApprovalsModule, FilesModule],
  controllers: [HrController],
  providers: [
    EmployeesService,
    AttendanceService,
    PayrollService,
    LoansService,
    PayslipService,
    {
      provide: HR_CRYPTO,
      useFactory: () => new HrCrypto(hrFieldKey(serverEnv().AUTH_SECRET)),
    },
    { provide: HR_API, useClass: HrApiService },
  ],
  exports: [HR_API],
})
export class HrModule {}
