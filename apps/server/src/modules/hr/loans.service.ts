import { Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import {
  businessDate,
  employeeLoanDisbursedDraft,
  poisha,
  withinPostingWindow,
  type AccountSubtype,
  type PayrollAccount,
} from '@elysium/domain';
import { loanSchedule, toPayrollMonth } from '@elysium/domain/payroll';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import { HrError, mapHrErrors } from './hr.errors.js';
import * as repo from './hr.repository.js';
import type { CreateLoanInput, DisburseLoanInput, LoanQuery } from './hr.schemas.js';

/**
 * Employee loans and their schedules (architecture §12, §7).
 *
 * A staff loan is company money in an employee's hands, so it is an asset with that
 * employee as its party (`employee_loan_receivable`) rather than an expense. Three
 * things follow from that, and each is a thing this service refuses to do otherwise.
 *
 * **The schedule is generated, not typed.** `loanSchedule` splits the principal with
 * largest remainder so the instalments sum to it exactly; typed instalments would be
 * either short — leaving a loan that never reaches zero and an employee chased for four
 * poisha forever — or over, which the ledger would notice and nobody would be able to
 * explain.
 *
 * **Nothing is deducted until the cash has gone out.** A loan is born
 * `pending_disbursement` with no journal, and `outstandingInstalments` only looks at
 * `active` loans. An instalment taken from a payslip for money the employee never
 * received is a wage cut dressed as a repayment.
 *
 * **The disbursement posts, it does not just record.** `Dr Employee loan receivable /
 * Cr W`, through `LEDGER_API` with the posting rule in
 * `packages/domain/src/posting/employee-loan.ts` (invariants 2 and 12). Without the
 * journal the receivable exists only in `hr.employee_loans`, and the monthly deduction
 * would credit an asset the ledger has never heard of.
 *
 * There is no interest. §7's `interest_expense` is for loans where the *company* is the
 * borrower; a staff loan in this business is interest-free, and adding a rate here would
 * be inventing a product rather than implementing one (recorded as D-188).
 */

export interface LoanView {
  readonly id: string;
  readonly employeeId: string;
  readonly branchId: string | null;
  readonly principalPoisha: string;
  readonly instalmentCount: number;
  readonly firstMonth: string;
  readonly status: string;
  readonly journalId: string | null;
  readonly disbursedOn: string | null;
  readonly note: string | null;
  readonly outstandingPoisha: string;
  readonly instalments: readonly {
    readonly id: string;
    readonly seq: number;
    readonly dueMonth: string;
    readonly amountPoisha: string;
    readonly deductedPoisha: string;
    readonly status: string;
  }[];
}

@Injectable()
export class LoansService {
  constructor(
    @Inject(LEDGER_API) private readonly ledger: LedgerApi,
    private readonly audit: AuditService,
  ) {}

  async list(
    context: ActiveContext,
    request: object,
    query: LoanQuery,
  ): Promise<{ items: LoanView[] }> {
    const scope = scopeWhere(request, {
      branchId: sql`l.branch_id`,
      createdBy: sql`l.created_by`,
      // §6's `own` on the employees row: a staff member sees their own loan.
      assignedTo: sql`(select e.user_id from hr.employees e
                       where e.org_id = l.org_id and e.id = l.employee_id)`,
    });
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.listLoans(tx, context.orgId, {
        scope,
        employeeId: query.employeeId,
        status: query.status,
      });
      const items: LoanView[] = [];
      for (const row of rows) {
        items.push(view(row, await repo.instalmentsForLoan(tx, context.orgId, row.id)));
      }
      return { items };
    });
  }

  async get(context: ActiveContext, request: object, id: string): Promise<LoanView> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const loan = await this.scoped(tx, context, request, id);
        return view(loan, await repo.instalmentsForLoan(tx, context.orgId, id));
      }),
    );
  }

  /**
   * Agree a loan and write its schedule. Nothing has moved yet.
   *
   * The whole schedule is written now rather than an instalment at a time, because the
   * schedule *is* the agreement: the employee signed for six instalments of a known
   * amount, and generating each one at payroll time would let the amount drift with
   * whatever the code did that month.
   */
  async create(
    context: ActiveContext,
    request: AuditableRequest,
    input: CreateLoanInput,
  ): Promise<LoanView> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const employee = await repo.employeeById(tx, context.orgId, input.employeeId);
        if (employee === undefined) {
          throw new HrError('HR_NOT_FOUND', 'No such employee in this brand.');
        }
        assertInScope(request, {
          branchId: employee.branch_id,
          createdBy: employee.created_by,
          assignedTo: employee.user_id,
        });
        if (employee.status === 'resigned' || employee.status === 'terminated') {
          throw new HrError(
            'HR_EMPLOYEE_INACTIVE',
            'That employee has left, so a new loan cannot be recorded against them.',
          );
        }

        const principalPoisha = poisha(BigInt(input.principalPoisha));
        // Refuses a schedule that cannot sum to the principal (an instalment of zero
        // poisha) before anything is written.
        const schedule = loanSchedule({
          principalPoisha,
          instalments: input.instalmentCount,
          firstMonth: toPayrollMonth(input.firstMonth),
        });

        const loanId = await repo.insertLoan(tx, {
          orgId: context.orgId,
          employeeId: input.employeeId,
          branchId: employee.branch_id,
          principalPoisha,
          instalmentCount: input.instalmentCount,
          firstMonth: input.firstMonth,
          note: input.note ?? null,
          createdBy: context.userId,
        });

        for (const instalment of schedule) {
          await repo.insertInstalment(tx, {
            orgId: context.orgId,
            loanId,
            seq: instalment.seq,
            dueMonth: instalment.dueMonth,
            amountPoisha: instalment.amountPoisha,
          });
        }

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'hr.employee_loan.created',
          entityType: 'Payroll',
          entityId: loanId,
          before: null,
          after: {
            employeeId: input.employeeId,
            principalPoisha: input.principalPoisha,
            instalmentCount: input.instalmentCount,
            firstMonth: input.firstMonth,
            note: input.note ?? null,
          },
          requestId: context.requestId,
          request,
        });

        const loan = await repo.loanById(tx, context.orgId, loanId);
        if (loan === undefined) throw new HrError('HR_NOT_FOUND', 'No such loan.');
        return view(loan, await repo.instalmentsForLoan(tx, context.orgId, loanId));
      }),
    );
  }

  /** Hand over the cash: **Dr Employee loan receivable / Cr W** (§7). */
  async disburse(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    input: DisburseLoanInput,
  ): Promise<LoanView> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const loan = await this.scoped(tx, context, request, id);
        if (loan.status !== 'pending_disbursement') {
          throw new HrError(
            'PAYROLL_LOAN_FROZEN',
            'That loan has already been disbursed or closed.',
          );
        }

        const wallet = await this.ledger.walletAccountById(
          tx,
          context.orgId,
          input.walletAccountId,
        );
        if (wallet === null) {
          throw new HrError('HR_NOT_FOUND', 'No such wallet in this brand.');
        }
        if (!wallet.isActive) {
          throw new HrError('WALLET_INACTIVE', 'That wallet is deactivated.');
        }
        const receivable = await this.account(tx, context.orgId, 'employee_loan_receivable');

        const occurredAt =
          input.disbursedOn === undefined ? new Date() : atDhakaNoon(input.disbursedOn);
        const posted = await this.ledger.post(
          tx,
          { orgId: context.orgId, userId: context.userId },
          employeeLoanDisbursedDraft({
            loanId: loan.id,
            employeeId: loan.employee_id,
            occurredAt,
            loanReceivable: receivable,
            wallet: {
              accountId: wallet.accountId,
              subtype: wallet.subtype,
              branchId: wallet.branchId,
            },
            amountPoisha: poisha(BigInt(loan.principal_poisha)),
            memo: input.memo ?? 'Staff loan disbursed',
          }),
        );

        await repo.markLoanDisbursed(tx, context.orgId, loan.id, {
          journalId: posted.journalId,
          walletAccountId: wallet.accountId,
          disbursedOn: posted.businessDate,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'hr.employee_loan.disbursed',
          entityType: 'Payroll',
          entityId: loan.id,
          before: { status: 'pending_disbursement', journalId: null },
          after: {
            status: 'active',
            employeeId: loan.employee_id,
            principalPoisha: loan.principal_poisha,
            walletAccountId: wallet.accountId,
            journalId: posted.journalId,
            disbursedOn: posted.businessDate,
          },
          requestId: context.requestId,
          request,
        });

        const after = await repo.loanById(tx, context.orgId, loan.id);
        if (after === undefined) throw new HrError('HR_NOT_FOUND', 'No such loan.');
        return view(after, await repo.instalmentsForLoan(tx, context.orgId, loan.id));
      }),
    );
  }

  private async scoped(
    tx: Tx,
    context: ActiveContext,
    request: object,
    id: string,
  ): Promise<repo.LoanRow> {
    const loan = await repo.loanById(tx, context.orgId, id);
    if (loan === undefined) throw new HrError('HR_NOT_FOUND', 'No such loan in this brand.');
    const employee = await repo.employeeById(tx, context.orgId, loan.employee_id);
    assertInScope(request, {
      branchId: loan.branch_id,
      createdBy: loan.created_by,
      assignedTo: employee?.user_id ?? null,
    });
    return loan;
  }

  private async account(tx: Tx, orgId: string, subtype: AccountSubtype): Promise<PayrollAccount> {
    // Through the ledger's own API: resolving which account a posting rule names is a
    // read of `ledger.accounts`, and that table is the ledger module's (invariant 12).
    const account = await this.ledger.accountBySubtype(tx, orgId, subtype);
    if (account === null) {
      throw new HrError('LEDGER_ACCOUNT_NOT_FOUND', `This organization has no ${subtype} account.`);
    }
    return { accountId: account.accountId, subtype, branchId: account.branchId };
  }
}

/**
 * Noon on a chosen Asia/Dhaka date, inside §7's posting window.
 *
 * Noon rather than midnight because midnight is within six hours of the previous day in UTC
 * and would file some disbursements a day early. The window is §7's "today or yesterday,
 * anything earlier needs approval" — and the forward half matters as much: the period lock
 * only refuses dates in or before a *closed* month, so a loan disbursed on 2030-01-01 would
 * sit in the cash book until the calendar reached it.
 */
function atDhakaNoon(date: string): Date {
  const at = new Date(`${date}T12:00:00+06:00`);
  if (Number.isNaN(at.getTime()) || businessDate(at) !== date) {
    throw new HrError('PAYROLL_INPUT_INVALID', `"${date}" is not an Asia/Dhaka calendar date.`);
  }
  if (!withinPostingWindow(at)) {
    throw new HrError(
      'APPROVAL_REQUIRED',
      'That date is outside the posting window. Anything earlier than yesterday, or in the future, needs a back-dated-entry approval.',
    );
  }
  return at;
}

function view(row: repo.LoanRow, instalments: readonly repo.InstalmentRow[]): LoanView {
  const outstanding = instalments.reduce(
    (total, instalment) =>
      total +
      (instalment.status === 'waived'
        ? 0n
        : BigInt(instalment.amount_poisha) - BigInt(instalment.deducted_poisha)),
    0n,
  );
  return {
    id: row.id,
    employeeId: row.employee_id,
    branchId: row.branch_id,
    principalPoisha: row.principal_poisha,
    instalmentCount: row.instalment_count,
    firstMonth: row.first_month,
    status: row.status,
    journalId: row.journal_id,
    disbursedOn: row.disbursed_on,
    note: row.note,
    outstandingPoisha: outstanding.toString(),
    instalments: instalments.map((instalment) => ({
      id: instalment.id,
      seq: instalment.seq,
      dueMonth: instalment.due_month,
      amountPoisha: instalment.amount_poisha,
      deductedPoisha: instalment.deducted_poisha,
      status: instalment.status,
    })),
  };
}
