import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import {
  businessDate,
  payrollPostedDraft,
  poisha,
  salaryPaidDraft,
  withinPostingWindow,
  type AccountSubtype,
  type PayrollAccount,
} from '@elysium/domain';
import {
  computePayrollLine,
  daysInMonth,
  payrollRunTotals,
  toPayrollMonth,
  type PayrollLine,
  type UnrecordedPolicy,
} from '@elysium/domain/payroll';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ApprovalsService, type ApprovalExecutor } from '../approvals/approvals.service.js';
import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import { AttendanceService } from './attendance.service.js';
import { HrError, mapHrErrors } from './hr.errors.js';
import * as repo from './hr.repository.js';
import type {
  CreateRunInput,
  PayRunInput,
  RunInputInput,
  RunQuery,
  SubmitRunInput,
} from './hr.schemas.js';

/**
 * The payroll run: `draft → pending_approval → posted → paid` (architecture §12, §7;
 * M19 acceptance checks 1 and 2).
 *
 * Four properties make the maker-checker real here rather than decorative, and they are
 * the same four M07's stock write-off rests on.
 *
 * 1. **The amount is the server's.** Σ net over payslips computed by
 *    `packages/domain/src/payroll` from the salary structures and the attendance. There
 *    is no field on any request that could carry a net, a gross or a deduction total.
 *    `payroll_run` is in `SERVER_DERIVED_AMOUNT_TYPES`, so a request raised by a person
 *    through the generic `POST /v1/approvals` is held for an org admin regardless of
 *    threshold; this module raises it with `amountDerivedByServer: true`, which is what
 *    lets the org's threshold decide (D-072), and migration 0056 refuses a run pointed
 *    at a request without that flag.
 * 2. **Nothing happens before the decision.** The journal, the loan deductions and the
 *    run's `posted` status are all written by the executor below, inside the transaction
 *    that approved the request. A pending run has posted no journal, moved no money and
 *    marked no instalment deducted — so rejecting it needs no reversal.
 * 3. **The terms are frozen.** The payslips are written at submit and are append-only
 *    (migration 0054); 0055 refuses any change to a submitted run's totals; 0056 refuses
 *    a run whose approval is for a different amount, and refuses one whose totals do not
 *    match its own payslips.
 * 4. **The amount the checker saw is the amount that posts.** The executor reads
 *    `approval.amountPoisha` and compares it to the frozen `net_poisha` (D-078), and the
 *    journal is built from the frozen payslip rows rather than recomputed. Attendance
 *    entered after the approval cannot change what is paid.
 *
 * ## One pending run at a time
 *
 * `submit` refuses if another run for this org is already waiting for a checker. That
 * looks like a workflow restriction and is really a correctness one: two pending runs
 * could each freeze a payslip that takes the *same* loan instalment, and posting both
 * would deduct it twice. The CHECK in migration 0053 would refuse the second, as a
 * conflict, halfway through somebody's approval. Refusing the second submit instead
 * says what to do — approve or cancel the first.
 */

export interface PayrollRunView {
  readonly id: string;
  readonly month: string;
  readonly status: string;
  readonly unrecordedPolicy: string;
  readonly employeeCount: number;
  readonly grossPoisha: string;
  readonly deductionsPoisha: string;
  readonly netPoisha: string;
  readonly approvalId: string | null;
  /** The approval's own state, so a rejected run is visible before it is closed. */
  readonly approvalStatus: string | null;
  readonly journalId: string | null;
  readonly paymentJournalId: string | null;
  readonly postedOn: string | null;
  readonly paidOn: string | null;
  readonly memo: string | null;
  readonly createdBy: string;
}

export interface PayslipView {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly employeeName: string;
  readonly branchId: string | null;
  readonly basicPoisha: string;
  readonly allowancesPoisha: string;
  readonly bonusPoisha: string;
  readonly grossPoisha: string;
  readonly absenceDeductionPoisha: string;
  readonly fixedDeductionPoisha: string;
  readonly otherDeductionPoisha: string;
  readonly loanDeductionPoisha: string;
  readonly loanShortfallPoisha: string;
  readonly deductionsPoisha: string;
  readonly netPoisha: string;
  readonly workingDays: number;
  readonly presentDays: number;
  readonly absentDays: number;
  readonly halfDays: number;
  readonly unrecordedDays: number;
  readonly components: readonly {
    readonly direction: string;
    readonly code: string;
    readonly label: string;
    readonly amountPoisha: string;
  }[];
}

/** One employee's computed payslip before anything is written. */
interface Computed {
  readonly employee: repo.EmployeeRow;
  readonly structureId: string;
  readonly line: PayrollLine;
}

@Injectable()
export class PayrollService implements OnModuleInit {
  constructor(
    @Inject(LEDGER_API) private readonly ledger: LedgerApi,
    private readonly approvals: ApprovalsService,
    private readonly attendance: AttendanceService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.approvals.registerExecutor('payroll_run', this.execute);
  }

  // --- runs -------------------------------------------------------------------

  async listRuns(context: ActiveContext, query: RunQuery): Promise<{ items: PayrollRunView[] }> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.listRuns(tx, context.orgId, query);
      const items: PayrollRunView[] = [];
      for (const row of rows) items.push(await this.runView(tx, context.orgId, row));
      return { items };
    });
  }

  async getRun(context: ActiveContext, id: string): Promise<PayrollRunView> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) =>
        this.runView(tx, context.orgId, await this.requireRun(tx, context.orgId, id)),
      ),
    );
  }

  async createRun(
    context: ActiveContext,
    request: AuditableRequest,
    input: CreateRunInput,
  ): Promise<PayrollRunView> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const month = toPayrollMonth(input.month);
        const id = await repo.insertRun(tx, {
          orgId: context.orgId,
          month,
          unrecordedPolicy: input.unrecordedPolicy,
          memo: input.memo ?? null,
          createdBy: context.userId,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'hr.payroll_run.created',
          entityType: 'Payroll',
          entityId: id,
          before: null,
          after: { month, unrecordedPolicy: input.unrecordedPolicy, memo: input.memo ?? null },
          requestId: context.requestId,
          request,
        });

        return this.runView(tx, context.orgId, await this.requireRun(tx, context.orgId, id));
      }),
    );
  }

  /**
   * What the run *would* pay, computed from today's data.
   *
   * Read-only and deliberately not stored. It is the number a payroll officer checks
   * against their own spreadsheet before submitting, and it moves as attendance is
   * imported — which is the point of previewing it. What gets frozen is `submit`'s
   * computation, run once, in the transaction that raises the approval.
   */
  async preview(
    context: ActiveContext,
    id: string,
  ): Promise<{
    readonly run: PayrollRunView;
    readonly totals: Record<string, string | number>;
    readonly payslips: readonly PayslipView[];
    readonly warnings: readonly string[];
  }> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const run = await this.requireRun(tx, context.orgId, id);

        // A submitted run's preview is its frozen payslips, not a recomputation. The
        // alternative would show a checker numbers that differ from the ones they are
        // approving the moment anybody touches attendance.
        if (run.status !== 'draft') {
          const payslips = await this.frozenPayslips(tx, context.orgId, run.id);
          return {
            run: await this.runView(tx, context.orgId, run),
            totals: {
              employeeCount: run.employee_count,
              grossPoisha: run.gross_poisha,
              deductionsPoisha: run.deductions_poisha,
              netPoisha: run.net_poisha,
            } as Record<string, string | number>,
            payslips,
            warnings: [],
          };
        }

        const computed = await this.compute(tx, context.orgId, run);
        const totals = payrollRunTotals(computed.map((one) => one.line));
        return {
          run: await this.runView(tx, context.orgId, run),
          totals: {
            employeeCount: totals.employeeCount,
            grossPoisha: totals.grossPoisha.toString(),
            deductionsPoisha: totals.deductionsPoisha.toString(),
            netPoisha: totals.netPoisha.toString(),
            bonusPoisha: totals.bonusPoisha.toString(),
            loanDeductionPoisha: totals.loanDeductionPoisha.toString(),
            salaryExpensePoisha: totals.salaryExpensePoisha.toString(),
          },
          payslips: computed.map((one) => previewPayslip(one)),
          warnings: warningsFor(computed),
        };
      }),
    );
  }

  /**
   * Freeze the payslips and raise the approval.
   *
   * Three steps, in this order, and the order is the whole of the transactional story.
   *
   * 1. **Compute, and write nothing.** Every refusal a person can cause — no salary
   *    structures, a net of zero, another run already pending, deductions larger than
   *    somebody's salary — happens here, before anything exists to clean up.
   * 2. **Raise the approval.** `ApprovalsService.request` opens its own transaction, so
   *    the request has to be committed before the run can point at it: migration 0056
   *    looks the request up to compare its amount.
   * 3. **Freeze the payslips and submit the run, in one transaction.** Both, together,
   *    because 0056's deferred trigger compares the run's totals to its lines at commit
   *    — and because a half-done submit that left committed payslips behind would make
   *    the next attempt collide on `payroll_lines_org_run_employee_idx`.
   *
   * A failure in step 3 therefore leaves an orphan approval request. The executor is
   * written to shrug at a request naming no run, which is the same choice M07's
   * adjustment executor makes and for the same reason: the alternative is somebody's
   * approval that can never be decided.
   */
  async submit(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    input: SubmitRunInput,
  ): Promise<PayrollRunView> {
    return mapHrErrors(async () => {
      const prepared = await withOrg(
        { orgId: context.orgId, userId: context.userId },
        async (tx) => {
          const run = await repo.runForUpdate(tx, context.orgId, id);
          if (run === undefined) {
            throw new HrError('PAYROLL_NOT_FOUND', 'No such payroll run in this brand.');
          }
          if (run.status !== 'draft') {
            throw new HrError(
              'PAYROLL_TRANSITION_INVALID',
              'That payroll run has already been submitted.',
            );
          }

          // See the class comment: two pending runs could freeze payslips that take the
          // same loan instalment.
          const pending = await repo.listRuns(tx, context.orgId, { status: 'pending_approval' });
          const other = pending.find((candidate) => candidate.id !== run.id);
          if (other !== undefined) {
            throw new HrError(
              'PAYROLL_TRANSITION_INVALID',
              `The ${other.month} payroll run is still waiting for approval. Approve or cancel it first.`,
            );
          }

          const computed = await this.compute(tx, context.orgId, run);
          if (computed.length === 0) {
            throw new HrError(
              'PAYROLL_INPUT_INVALID',
              'No employee in this brand has a salary structure effective in that month.',
            );
          }
          const totals = payrollRunTotals(computed.map((one) => one.line));
          if (totals.netPoisha <= 0n) {
            throw new HrError(
              'PAYROLL_INPUT_INVALID',
              'That payroll run pays nothing; there is nothing to approve.',
            );
          }
          assertJournalFits(computed);

          return { run, computed, totals };
        },
      );

      const raised = await this.approvals.request(context, {
        type: 'payroll_run',
        amountPoisha: prepared.totals.netPoisha,
        // No amount in the payload (D-078). The month and the headcount are what a
        // checker needs beyond the amount, and neither is money.
        payload: {
          runId: prepared.run.id,
          month: prepared.run.month,
          employeeCount: prepared.totals.employeeCount,
        },
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        // This module read the salary structures and the attendance and did the
        // arithmetic. Saying so is what lets the org's threshold decide whether a second
        // person signs it off rather than holding every run for an org admin (D-072).
        amountDerivedByServer: true,
        request,
      });

      return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        /*
         * Re-checked under the run's own row lock (W6).
         *
         * Step 1's check ran in its own transaction, whose lock was released when it
         * committed, so two submits for two months could both pass it. Repeating it here —
         * where the run row is locked and the payslips are about to be written — closes the
         * window: the loser is refused with a message about the other run rather than
         * freezing payslips that name the same loan instalment and then failing inside
         * somebody's approval.
         */
        const locked = await repo.runForUpdate(tx, context.orgId, prepared.run.id);
        if (locked?.status !== 'draft') {
          throw new HrError(
            'PAYROLL_TRANSITION_INVALID',
            'That payroll run has already been submitted.',
          );
        }
        const stillPending = (
          await repo.listRuns(tx, context.orgId, { status: 'pending_approval' })
        ).find((candidate) => candidate.id !== prepared.run.id);
        if (stillPending !== undefined) {
          throw new HrError(
            'PAYROLL_TRANSITION_INVALID',
            `The ${stillPending.month} payroll run is still waiting for approval. Approve or cancel it first.`,
          );
        }

        await this.freeze(tx, context.orgId, prepared.run.id, prepared.computed);
        await repo.submitRun(tx, context.orgId, prepared.run.id, {
          approvalRequestId: raised.id,
          employeeCount: prepared.totals.employeeCount,
          grossPoisha: prepared.totals.grossPoisha,
          deductionsPoisha: prepared.totals.deductionsPoisha,
          netPoisha: prepared.totals.netPoisha,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'hr.payroll_run.submitted',
          entityType: 'Payroll',
          entityId: prepared.run.id,
          before: { status: 'draft' },
          after: {
            status: 'pending_approval',
            month: prepared.run.month,
            approvalId: raised.id,
            employeeCount: prepared.totals.employeeCount,
            grossPoisha: prepared.totals.grossPoisha.toString(),
            deductionsPoisha: prepared.totals.deductionsPoisha.toString(),
            netPoisha: prepared.totals.netPoisha.toString(),
          },
          requestId: context.requestId,
          request,
        });

        /*
         * Below the org's threshold, the request was decided the moment it was raised
         * (D-068) — and the executor that would have posted it ran before this transaction
         * existed, found no run pointing at the request, and correctly shrugged.
         *
         * So the posting happens here instead. Without it the run sits in
         * `pending_approval` naming an already-decided request that `decide` will refuse as
         * spent: nothing could ever post it, `cancel` could only reject it, and the month
         * would be unpayable through the system forever. `payroll_run` is not in
         * `NEVER_AUTO_APPROVE_TYPES`, and `amountDerivedByServer` above is exactly what
         * lets a threshold apply to it (D-072) — so this branch is reachable by design and
         * has to be handled rather than prevented.
         *
         * It posts the same way the executor does, from the frozen payslips, against the
         * amount the threshold accepted.
         */
        if (raised.status === 'auto_approved') {
          await this.postApproved(tx, context, prepared.run.id, {
            approvalId: raised.id,
            approvedPoisha: prepared.totals.netPoisha,
            request,
          });
        }

        const after = await this.requireRun(tx, context.orgId, prepared.run.id);
        return this.runView(tx, context.orgId, after);
      });
    });
  }

  /**
   * Close a run that will not be posted.
   *
   * Reachable from `draft` (somebody changed their mind) and from `pending_approval`
   * once the checker rejected it. The second case exists because the approvals module
   * runs an executor on approval and nothing on rejection — a rejected request leaves
   * the run waiting, and the run has to be closable without an approval of its own.
   * Recorded as a follow-up: wiring `approval.decided` through the outbox would close
   * it without anybody clicking.
   */
  async cancel(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
  ): Promise<PayrollRunView> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const run = await repo.runForUpdate(tx, context.orgId, id);
        if (run === undefined) {
          throw new HrError('PAYROLL_NOT_FOUND', 'No such payroll run in this brand.');
        }
        if (run.status !== 'draft' && run.status !== 'pending_approval') {
          throw new HrError(
            'PAYROLL_TRANSITION_INVALID',
            'Only a draft or a run waiting for approval can be closed.',
          );
        }

        /*
         * A pending run is only closable once its approval is out of the way.
         *
         * Otherwise the checker's screen would still offer a decision on a request
         * whose run has gone, and approving it would run an executor that finds a
         * cancelled run and shrugs — an approval recorded as done that did nothing.
         */
        const approval =
          run.approval_request_id === null
            ? null
            : await approvalStatus(tx, context.orgId, run.approval_request_id);
        if (run.status === 'pending_approval' && approval === 'pending') {
          throw new HrError(
            'APPROVAL_REQUIRED',
            'That run is still waiting for a decision. Ask the checker to reject it first.',
          );
        }

        const next = run.status === 'draft' ? 'cancelled' : 'rejected';
        await repo.setRunStatus(tx, context.orgId, run.id, next);

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: `hr.payroll_run.${next}`,
          entityType: 'Payroll',
          entityId: run.id,
          before: { status: run.status },
          after: { status: next, approvalStatus: approval },
          requestId: context.requestId,
          request,
        });

        return this.runView(tx, context.orgId, await this.requireRun(tx, context.orgId, run.id));
      }),
    );
  }

  // --- bonus and deduction inputs ---------------------------------------------

  async listInputs(context: ActiveContext, runId: string): Promise<{ items: unknown[] }> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => ({
      items: (await repo.listInputs(tx, context.orgId, runId)).map((row) => ({
        id: row.id,
        employeeId: row.employee_id,
        kind: row.kind,
        label: row.label,
        amountPoisha: row.amount_poisha,
        note: row.note,
      })),
    }));
  }

  async addInput(
    context: ActiveContext,
    request: AuditableRequest,
    runId: string,
    input: RunInputInput,
  ): Promise<{ id: string }> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        // The trigger in 0055 refuses an input on a run that is no longer a draft; this
        // is the same refusal with a message about payroll rather than about a trigger.
        const run = await this.requireRun(tx, context.orgId, runId);
        if (run.status !== 'draft') {
          throw new HrError(
            'PAYROLL_RUN_FROZEN',
            'That payroll run is no longer a draft, so its bonuses cannot change.',
          );
        }
        const employee = await repo.employeeById(tx, context.orgId, input.employeeId);
        if (employee === undefined) {
          throw new HrError('HR_NOT_FOUND', 'No such employee in this brand.');
        }

        const id = await repo.insertInput(tx, {
          orgId: context.orgId,
          runId,
          employeeId: input.employeeId,
          kind: input.kind,
          label: input.label,
          amountPoisha: BigInt(input.amountPoisha),
          note: input.note ?? null,
          createdBy: context.userId,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: `hr.payroll_input.${input.kind}`,
          entityType: 'Payroll',
          entityId: id,
          before: null,
          after: {
            runId,
            employeeId: input.employeeId,
            kind: input.kind,
            label: input.label,
            amountPoisha: input.amountPoisha,
          },
          requestId: context.requestId,
          request,
        });

        return { id };
      }),
    );
  }

  async removeInput(
    context: ActiveContext,
    request: AuditableRequest,
    runId: string,
    inputId: string,
  ): Promise<{ removed: boolean }> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const run = await this.requireRun(tx, context.orgId, runId);
        if (run.status !== 'draft') {
          throw new HrError(
            'PAYROLL_RUN_FROZEN',
            'That payroll run is no longer a draft, so its bonuses cannot change.',
          );
        }
        const removed = await repo.deleteInput(tx, context.orgId, inputId);
        if (removed === 0) throw new HrError('HR_NOT_FOUND', 'No such payroll input.');

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'delete',
          action: 'hr.payroll_input.removed',
          entityType: 'Payroll',
          entityId: inputId,
          before: { runId },
          after: null,
          requestId: context.requestId,
          request,
        });
        return { removed: true };
      }),
    );
  }

  // --- payslips ---------------------------------------------------------------

  async payslips(context: ActiveContext, runId: string): Promise<{ items: PayslipView[] }> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        await this.requireRun(tx, context.orgId, runId);
        return { items: await this.frozenPayslips(tx, context.orgId, runId) };
      }),
    );
  }

  /** One payslip, for the PDF and for an employee reading their own. */
  async payslip(
    context: ActiveContext,
    runId: string,
    employeeId: string,
  ): Promise<{ run: repo.RunRow; payslip: PayslipView }> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const run = await this.requireRun(tx, context.orgId, runId);
        const line = await repo.lineForRunEmployee(tx, context.orgId, runId, employeeId);
        if (line === undefined) {
          throw new HrError('HR_NOT_FOUND', 'That employee has no payslip in this run.');
        }
        const employee = await repo.employeeById(tx, context.orgId, employeeId);
        if (employee === undefined) {
          throw new HrError('HR_NOT_FOUND', 'No such employee in this brand.');
        }
        const components = await repo.lineComponents(tx, context.orgId, line.id);
        return { run, payslip: frozenPayslip(line, employee, components) };
      }),
    );
  }

  // --- paying -----------------------------------------------------------------

  /**
   * Pay a posted run: **Dr Salary payable / Cr W** (§7).
   *
   * No second approval. The `payroll_run` approval already covered this exact amount —
   * §6 gives accounts "payroll posting and payment" as one capability, and asking a
   * checker to agree twice to a number they already agreed to is the kind of control
   * that gets clicked through. What is checked is that the amount paid is the amount
   * that was approved and posted: the payment is for `run.net_poisha` and nothing else,
   * and there is no field on `payRunSchema` that could say otherwise (D-078).
   */
  async pay(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    input: PayRunInput,
  ): Promise<PayrollRunView> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const run = await repo.runForUpdate(tx, context.orgId, id);
        if (run === undefined) {
          throw new HrError('PAYROLL_NOT_FOUND', 'No such payroll run in this brand.');
        }
        if (run.status === 'paid') {
          throw new HrError(
            'PAYROLL_TRANSITION_INVALID',
            'That payroll run has already been paid.',
          );
        }
        if (run.status !== 'posted') {
          throw new HrError(
            'PAYROLL_TRANSITION_INVALID',
            'A payroll run is paid after it has been approved and posted.',
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
        const payable = await this.account(tx, context.orgId, 'salary_payable');

        const occurredAt = input.paidOn === undefined ? new Date() : atDhakaNoon(input.paidOn);
        const posted = await this.ledger.post(
          tx,
          { orgId: context.orgId, userId: context.userId },
          salaryPaidDraft({
            runId: run.id,
            occurredAt,
            salaryPayable: payable,
            wallet: {
              accountId: wallet.accountId,
              subtype: wallet.subtype,
              branchId: wallet.branchId,
            },
            amountPoisha: poisha(BigInt(run.net_poisha)),
            memo: input.memo ?? `${run.month} salary paid`,
          }),
        );

        await repo.markRunPaid(tx, context.orgId, run.id, {
          paymentJournalId: posted.journalId,
          walletAccountId: wallet.accountId,
          paidOn: posted.businessDate,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'hr.payroll_run.paid',
          entityType: 'Payroll',
          entityId: run.id,
          before: { status: 'posted' },
          after: {
            status: 'paid',
            month: run.month,
            netPoisha: run.net_poisha,
            walletAccountId: wallet.accountId,
            paymentJournalId: posted.journalId,
            paidOn: posted.businessDate,
          },
          requestId: context.requestId,
          request,
        });

        return this.runView(tx, context.orgId, await this.requireRun(tx, context.orgId, run.id));
      }),
    );
  }

  // --- the executor -----------------------------------------------------------

  /**
   * Post an approved run, inside the approving transaction.
   *
   * Written to be indifferent to a request it does not recognise, the way M07's
   * adjustment executor is. Nothing else raises `payroll_run` with a run behind it — the
   * type is server-derived, so a person raising one through the generic route has it
   * held and it names no run — but the alternative to shrugging is an executor that
   * throws on somebody else's request and makes their approval undecidable.
   */
  private readonly execute: ApprovalExecutor = async (tx, { context, approval, request }) => {
    const run = await repo.runByApproval(tx, context.orgId, approval.id);
    if (run === undefined) return;
    if (run.status !== 'pending_approval') return;

    await this.postApproved(tx, context, run.id, {
      approvalId: approval.id,
      approvedPoisha: approval.amountPoisha,
      request,
    });
  };

  /**
   * Post a run whose approval has been decided, from its frozen payslips.
   *
   * Shared by the executor — which runs inside the checker's transaction — and by the
   * auto-approved branch of `submit`, so the journal a threshold waves through is built by
   * exactly the same code as the one a person signs off. Two implementations of "post the
   * run" would be two places for §7's journal to drift.
   */
  private async postApproved(
    tx: Tx,
    context: ActiveContext,
    runId: string,
    input: {
      readonly approvalId: string;
      readonly approvedPoisha: bigint | null;
      readonly request: AuditableRequest | undefined;
    },
  ): Promise<void> {
    const run = await repo.runForUpdate(tx, context.orgId, runId);
    if (run?.status !== 'pending_approval') return;
    const request = input.request;

    await mapHrErrors(async () => {
      /*
       * The approval's amount, not the run's (D-078). Migration 0056 holds them equal on
       * the way in; this is the check that they still are — and it is the last thing
       * standing between "a checker agreed to ৳7,73,148" and what actually posts.
       */
      const approved = input.approvedPoisha;
      if (approved === null || approved !== BigInt(run.net_poisha)) {
        throw new HrError(
          'PAYROLL_APPROVAL_INVALID',
          'That approval is for a different amount than the payroll run it names.',
        );
      }

      const lines = await repo.listLines(tx, context.orgId, run.id);
      if (lines.length === 0) {
        throw new HrError('PAYROLL_TOTALS_MISMATCH', 'That payroll run has no payslips.');
      }

      const [salaryExpense, bonusExpense, salaryPayable, loanReceivable] = await Promise.all([
        this.account(tx, context.orgId, 'salary_expense'),
        this.account(tx, context.orgId, 'bonus_expense'),
        this.account(tx, context.orgId, 'salary_payable'),
        this.account(tx, context.orgId, 'employee_loan_receivable'),
      ]);

      const occurredAt = new Date();
      const posted = await this.ledger.post(
        tx,
        { orgId: context.orgId, userId: context.userId },
        payrollPostedDraft({
          runId: run.id,
          // Today's date, not the payroll month's: the journal records when the
          // decision was carried out. Back-dating into a closed period would be
          // refused by the period lock anyway (D-093), and March's salary approved in
          // April is an April liability.
          occurredAt,
          salaryExpense,
          bonusExpense,
          salaryPayable,
          employeeLoanReceivable: loanReceivable,
          lines: lines.map((line) => ({
            employeeId: line.employee_id,
            branchId: line.branch_id,
            salaryExpensePoisha: poisha(BigInt(line.salary_expense_poisha)),
            bonusPoisha: poisha(BigInt(line.bonus_poisha)),
            netPoisha: poisha(BigInt(line.net_poisha)),
            loanDeductionPoisha: poisha(BigInt(line.loan_deduction_poisha)),
          })),
          memo: run.memo ?? `${run.month} payroll`,
        }),
      );

      // The instalments are marked deducted **here**, not at submit. A rejected run
      // must leave every loan exactly as it was.
      await this.applyLoanDeductions(tx, context.orgId, run.id);

      await repo.markRunPosted(tx, context.orgId, run.id, {
        journalId: posted.journalId,
        postedOn: posted.businessDate,
      });

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'hr.payroll_run.posted',
        entityType: 'Payroll',
        entityId: run.id,
        before: { status: 'pending_approval', journalId: null },
        after: {
          status: 'posted',
          month: run.month,
          approvalId: input.approvalId,
          journalId: posted.journalId,
          netPoisha: run.net_poisha,
          postedOn: posted.businessDate,
        },
        requestId: context.requestId,
        ...(request === undefined ? {} : { request }),
      });
    });
  }

  // --- internals --------------------------------------------------------------

  private async requireRun(tx: Tx, orgId: string, id: string): Promise<repo.RunRow> {
    const run = await repo.runById(tx, orgId, id);
    if (run === undefined) {
      throw new HrError('PAYROLL_NOT_FOUND', 'No such payroll run in this brand.');
    }
    return run;
  }

  private async runView(tx: Tx, orgId: string, row: repo.RunRow): Promise<PayrollRunView> {
    return {
      id: row.id,
      month: row.month,
      status: row.status,
      unrecordedPolicy: row.unrecorded_policy,
      employeeCount: row.employee_count,
      grossPoisha: row.gross_poisha,
      deductionsPoisha: row.deductions_poisha,
      netPoisha: row.net_poisha,
      approvalId: row.approval_request_id,
      approvalStatus:
        row.approval_request_id === null
          ? null
          : await approvalStatus(tx, orgId, row.approval_request_id),
      journalId: row.journal_id,
      paymentJournalId: row.payment_journal_id,
      postedOn: row.posted_on,
      paidOn: row.paid_on,
      memo: row.memo,
      createdBy: row.created_by,
    };
  }

  /**
   * Compute every payslip in the run from today's data.
   *
   * Employees with no salary structure effective in the month are skipped rather than
   * refused: a brand hires somebody in June whose structure has not been entered yet,
   * and refusing the whole run would hold up everybody else's salary. The preview's
   * warnings name them, so the omission is visible before a checker sees the total.
   */
  private async compute(tx: Tx, orgId: string, run: repo.RunRow): Promise<Computed[]> {
    const month = toPayrollMonth(run.month);
    const monthEnd = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;

    const employees = await repo.listEmployees(tx, orgId, {
      // Org-wide: a payroll run covers the brand (§12), and the route that reaches this
      // needs `create Payroll`, which §6 grants at org scope only.
      scope: sql`true`,
      limit: 5000,
      offset: 0,
      q: undefined,
      branchId: undefined,
      status: undefined,
    });

    /*
     * Who is in the run.
     *
     * `active` and `suspended` are both in it and `resigned`/`terminated` are in it only
     * if they left during the month — a person who left on the 10th is owed ten days.
     * A suspended employee is still employed; whether they are paid is what their
     * attendance says, which is where an unpaid suspension belongs.
     */
    const payable = employees.filter((employee) => {
      if (employee.status === 'active' || employee.status === 'suspended') {
        return employee.join_date <= monthEnd;
      }
      return (
        employee.join_date <= monthEnd &&
        employee.leave_date !== null &&
        employee.leave_date >= `${month}-01`
      );
    });

    const summaries = await this.attendance.summariesFor(tx, orgId, {
      month,
      employees: payable,
      unrecorded: run.unrecorded_policy as UnrecordedPolicy,
    });

    const inputs = await repo.listInputs(tx, orgId, run.id);
    const bonusBy = new Map<string, bigint>();
    const deductionBy = new Map<string, bigint>();
    for (const input of inputs) {
      const target = input.kind === 'bonus' ? bonusBy : deductionBy;
      target.set(
        input.employee_id,
        (target.get(input.employee_id) ?? 0n) + BigInt(input.amount_poisha),
      );
    }

    const instalments = await repo.outstandingInstalments(tx, orgId, month);
    const instalmentsBy = new Map<string, typeof instalments>();
    for (const instalment of instalments) {
      const list = instalmentsBy.get(instalment.employee_id) ?? [];
      list.push(instalment);
      instalmentsBy.set(instalment.employee_id, list);
    }

    const structures = new Map<string, repo.StructureRow>();
    for (const employee of payable) {
      const structure = await repo.structureForMonth(tx, orgId, employee.id, monthEnd);
      if (structure !== undefined) structures.set(employee.id, structure);
    }
    const components = await repo.componentsFor(tx, orgId, [
      ...new Set([...structures.values()].map((structure) => structure.id)),
    ]);

    const computed: Computed[] = [];
    for (const employee of payable) {
      const structure = structures.get(employee.id);
      const attendance = summaries.get(employee.id);
      if (structure === undefined || attendance === undefined) continue;

      computed.push({
        employee,
        structureId: structure.id,
        line: computePayrollLine({
          employeeId: employee.id,
          branchId: employee.branch_id,
          month,
          basicPoisha: poisha(BigInt(structure.basic_poisha)),
          components: components
            .filter((component) => component.structure_id === structure.id)
            .map((component) => ({
              code: component.code,
              label: component.label,
              direction: component.direction as 'earning' | 'deduction',
              amountPoisha: poisha(BigInt(component.amount_poisha)),
              prorated: component.prorated,
            })),
          bonusPoisha: poisha(bonusBy.get(employee.id) ?? 0n),
          otherDeductionPoisha: poisha(deductionBy.get(employee.id) ?? 0n),
          attendance,
          loanInstalments: (instalmentsBy.get(employee.id) ?? []).map((instalment) => ({
            instalmentId: instalment.id,
            dueMonth: toPayrollMonth(instalment.due_month),
            remainingPoisha: poisha(
              BigInt(instalment.amount_poisha) - BigInt(instalment.deducted_poisha),
            ),
          })),
        }),
      });
    }

    // Deterministic order, so the journal's employee-loan lines and the payslip list
    // read the same way every time and a diff of two runs is meaningful.
    return computed.sort((a, b) => (a.employee.code < b.employee.code ? -1 : 1));
  }

  /** Write the payslips, their component rows and which instalments they take. */
  private async freeze(
    tx: Tx,
    orgId: string,
    runId: string,
    computed: readonly Computed[],
  ): Promise<void> {
    for (const { employee, structureId, line } of computed) {
      const lineId = await repo.insertLine(tx, {
        orgId,
        runId,
        employeeId: employee.id,
        branchId: employee.branch_id,
        salaryStructureId: structureId,
        basicPoisha: line.basicPoisha,
        allowancesPoisha: line.allowancesPoisha,
        bonusPoisha: line.bonusPoisha,
        grossPoisha: line.grossPoisha,
        absenceDeductionPoisha: line.absenceDeductionPoisha,
        fixedDeductionPoisha: line.fixedDeductionPoisha,
        otherDeductionPoisha: line.otherDeductionPoisha,
        loanDeductionPoisha: line.loanDeductionPoisha,
        loanShortfallPoisha: line.loanShortfallPoisha,
        deductionsPoisha: line.deductionsPoisha,
        netPoisha: line.netPoisha,
        salaryExpensePoisha: line.salaryExpensePoisha,
        workingDays: line.attendance.workingDays,
        presentDays: line.attendance.presentDays,
        absentDays: line.attendance.absentDays,
        halfDays: line.attendance.halfDays,
        paidLeaveDays: line.attendance.paidLeaveDays,
        unrecordedDays: line.attendance.unrecordedDays,
      });

      for (const [index, component] of line.components.entries()) {
        await repo.insertLineComponent(tx, {
          orgId,
          lineId,
          direction: component.direction,
          code: component.code,
          label: component.label,
          amountPoisha: component.amountPoisha,
          lineNo: index + 1,
        });
      }

      for (const deduction of line.loanDeductions) {
        await repo.insertLoanDeduction(tx, {
          orgId,
          lineId,
          instalmentId: deduction.instalmentId,
          amountPoisha: deduction.amountPoisha,
        });
      }
    }
  }

  /**
   * Mark the instalments this run's payslips took, at posting time.
   *
   * Re-checks each instalment's remaining balance rather than trusting the frozen
   * amount blindly. If somebody waived an instalment between the submit and the
   * approval, the frozen payslip would take more than is owed — and the CHECK in
   * migration 0053 would refuse it as a constraint violation halfway through a
   * checker's approval. Refusing with a payroll message instead says what to do:
   * cancel the run and submit it again.
   */
  private async applyLoanDeductions(tx: Tx, orgId: string, runId: string): Promise<void> {
    const rows = await tx.execute<{
      instalment_id: string;
      amount_poisha: string;
      remaining_poisha: string;
      seq: number;
    }>(sql`
      select d.instalment_id, d.amount_poisha::text as amount_poisha,
             (i.amount_poisha - i.deducted_poisha)::text as remaining_poisha, i.seq
      from hr.payroll_loan_deductions d
      join hr.payroll_lines l on l.org_id = d.org_id and l.id = d.line_id
      join hr.loan_instalments i on i.org_id = d.org_id and i.id = d.instalment_id
      where d.org_id = ${orgId} and l.run_id = ${runId}
      order by d.instalment_id
      for update of i
    `);

    for (const row of rows) {
      const amount = BigInt(row.amount_poisha);
      if (amount > BigInt(row.remaining_poisha)) {
        throw new HrError(
          'PAYROLL_LOAN_FROZEN',
          `Instalment ${String(row.seq)} no longer owes what this run deducts. Cancel the run and submit it again.`,
        );
      }
      await repo.applyInstalmentDeduction(tx, orgId, row.instalment_id, amount);
    }

    await repo.settleFullyDeductedLoans(tx, orgId);
  }

  private async frozenPayslips(tx: Tx, orgId: string, runId: string): Promise<PayslipView[]> {
    const lines = await repo.listLines(tx, orgId, runId);
    const out: PayslipView[] = [];
    for (const line of lines) {
      const employee = await repo.employeeById(tx, orgId, line.employee_id);
      const components = await repo.lineComponents(tx, orgId, line.id);
      out.push(frozenPayslip(line, employee, components));
    }
    return out.sort((a, b) => (a.employeeCode < b.employeeCode ? -1 : 1));
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

async function approvalStatus(tx: Tx, orgId: string, id: string): Promise<string | null> {
  const rows = await tx.execute<{ status: string }>(sql`
    select status::text as status from approvals.approval_requests
    where org_id = ${orgId} and id = ${id}
  `);
  return rows[0]?.status ?? null;
}

/**
 * Noon in Dhaka on a chosen date.
 *
 * The date a payment is recorded on is an Asia/Dhaka calendar date, and `businessDate`
 * derives that from an instant. Midnight would be within six hours of the previous day
 * in UTC and would file some payments a day early; noon is far from both boundaries.
 */
function atDhakaNoon(date: string): Date {
  const at = new Date(`${date}T12:00:00+06:00`);
  if (Number.isNaN(at.getTime())) {
    throw new HrError('PAYROLL_INPUT_INVALID', `"${date}" is not a date.`);
  }
  // Round-trips through `businessDate` so a caller cannot smuggle a different day in.
  if (businessDate(at) !== date) {
    throw new HrError('PAYROLL_INPUT_INVALID', `"${date}" is not an Asia/Dhaka calendar date.`);
  }
  /*
   * §7: today or yesterday, or it needs a `back_dated_entry` approval.
   *
   * The forward half is the one that bites. The period lock only refuses a date in or before
   * a *closed* month, so a salary payment dated 2030-01-01 can never be reached by any
   * month-end close: it would sit in every P&L and cash book from now until the calendar
   * catches up, and then appear, unexplained. The same window M10's deliveries use
   * (`withinPostingWindow`), refused here rather than clamped because "which day did we pay
   * the staff" is not a question to guess at.
   */
  if (!withinPostingWindow(at)) {
    throw new HrError(
      'APPROVAL_REQUIRED',
      'That date is outside the posting window. Anything earlier than yesterday, or in the future, needs a back-dated-entry approval.',
    );
  }
  return at;
}

function previewPayslip(one: Computed): PayslipView {
  const { employee, line } = one;
  return {
    employeeId: employee.id,
    employeeCode: employee.code,
    employeeName: employee.full_name,
    branchId: employee.branch_id,
    basicPoisha: line.basicPoisha.toString(),
    allowancesPoisha: line.allowancesPoisha.toString(),
    bonusPoisha: line.bonusPoisha.toString(),
    grossPoisha: line.grossPoisha.toString(),
    absenceDeductionPoisha: line.absenceDeductionPoisha.toString(),
    fixedDeductionPoisha: line.fixedDeductionPoisha.toString(),
    otherDeductionPoisha: line.otherDeductionPoisha.toString(),
    loanDeductionPoisha: line.loanDeductionPoisha.toString(),
    loanShortfallPoisha: line.loanShortfallPoisha.toString(),
    deductionsPoisha: line.deductionsPoisha.toString(),
    netPoisha: line.netPoisha.toString(),
    workingDays: line.attendance.workingDays,
    presentDays: line.attendance.presentDays,
    absentDays: line.attendance.absentDays,
    halfDays: line.attendance.halfDays,
    unrecordedDays: line.attendance.unrecordedDays,
    components: line.components.map((component) => ({
      direction: component.direction,
      code: component.code,
      label: component.label,
      amountPoisha: component.amountPoisha.toString(),
    })),
  };
}

function frozenPayslip(
  line: repo.LineRow,
  employee: repo.EmployeeRow | undefined,
  components: readonly repo.LineComponentRow[],
): PayslipView {
  return {
    employeeId: line.employee_id,
    employeeCode: employee?.code ?? '',
    employeeName: employee?.full_name ?? '',
    branchId: line.branch_id,
    basicPoisha: line.basic_poisha,
    allowancesPoisha: line.allowances_poisha,
    bonusPoisha: line.bonus_poisha,
    grossPoisha: line.gross_poisha,
    absenceDeductionPoisha: line.absence_deduction_poisha,
    fixedDeductionPoisha: line.fixed_deduction_poisha,
    otherDeductionPoisha: line.other_deduction_poisha,
    loanDeductionPoisha: line.loan_deduction_poisha,
    loanShortfallPoisha: line.loan_shortfall_poisha,
    deductionsPoisha: line.deductions_poisha,
    netPoisha: line.net_poisha,
    workingDays: line.working_days,
    presentDays: line.present_days,
    absentDays: line.absent_days,
    halfDays: line.half_days,
    unrecordedDays: line.unrecorded_days,
    components: components.map((component) => ({
      direction: component.direction,
      code: component.code,
      label: component.label,
      amountPoisha: component.amount_poisha,
    })),
  };
}

/**
 * The ledger's 500-line ceiling, checked before anything is frozen.
 *
 * §7's journal model caps a journal at 500 lines (`validateJournalDraft`), and payroll's
 * journal is one line per branch for salary, one per branch for bonus, one payable, and **one
 * per employee carrying a loan deduction** — because `employee_loan_receivable` is a party
 * account and there is no aggregate party a loan could use. An org where five hundred staff
 * are repaying loans therefore cannot post payroll.
 *
 * Refused here, at submit, where the message can say what to do. The alternative is the
 * ledger refusing the draft *inside the checker's approval transaction*, which leaves a run
 * nobody can clear.
 */
function assertJournalFits(computed: readonly Computed[]): void {
  const branches = new Set<string | null>();
  let loanLines = 0;
  for (const { line } of computed) {
    branches.add(line.branchId);
    if (line.loanDeductionPoisha > 0n) loanLines += 1;
  }
  const lines = branches.size * 2 + 1 + loanLines;
  if (lines > 500) {
    throw new HrError(
      'PAYROLL_INPUT_INVALID',
      `This run would post a journal of ${String(lines)} lines and the ledger takes 500. Settle some staff loans first, or raise it with an administrator.`,
    );
  }
}

/**
 * What a checker should notice before approving.
 *
 * Not errors — every one of these is a legitimate state — but each is a way a payroll
 * run is quietly wrong, and the totals alone hide all three: a month nobody imported
 * attendance for, an instalment that could not be taken, and a payslip of zero.
 */
function warningsFor(computed: readonly Computed[]): string[] {
  const warnings: string[] = [];
  const unrecorded = computed.filter((one) => one.line.attendance.unrecordedDays > 0);
  if (unrecorded.length > 0) {
    warnings.push(
      `${String(unrecorded.length)} employees have working days with no attendance recorded.`,
    );
  }
  const shortfall = computed.filter((one) => one.line.loanShortfallPoisha > 0n);
  if (shortfall.length > 0) {
    warnings.push(
      `${String(shortfall.length)} employees could not afford their full loan instalment this month.`,
    );
  }
  const zero = computed.filter((one) => one.line.netPoisha === 0n);
  if (zero.length > 0) {
    warnings.push(`${String(zero.length)} employees are owed nothing this month.`);
  }
  const withBonus = computed.filter((one) => one.line.bonusPoisha > 0n);
  if (withBonus.length > 0) {
    warnings.push(`${String(withBonus.length)} employees have a bonus in this run.`);
  }
  return warnings;
}
