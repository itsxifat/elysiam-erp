import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { serializeFor } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import {
  businessDate,
  loanInstalmentPaidDraft,
  poisha,
  type PostingAccount,
} from '@elysium/domain';
import { payableInstalment } from '@elysium/domain/loans';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ApprovalsService, type ApprovalExecutor } from '../approvals/approvals.service.js';
import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import { LoansHttpError, mapLoanErrors, pgCode } from './loans.errors.js';
import * as repo from './loans.repository.js';
import type { PayInstalmentInput } from './loans.schemas.js';
import { facts, LoansService } from './loans.service.js';

/**
 * Repaying a company loan, one instalment at a time (architecture §7, §15; M26).
 *
 *     Dr Loan payable (lender, principal) + Dr Interest expense / Cr W
 *
 * ## Through approvals when the brand's threshold says so (D-298)
 *
 * A repayment is money leaving the company, so it is held for a checker exactly like a
 * supplier payment: below the brand's `loan_repayment` threshold it posts at once; at or
 * above it — or with no threshold set — it is written `pending_approval` with **no
 * journal**, and the approval's executor posts it inside the deciding transaction. A
 * rejection marks it rejected through the rejection hook (D-299), and the instalment can
 * be paid again.
 *
 * The amount is never the client's: it is the instalment's, from the schedule, and the
 * approval carries it as server-derived. The executor refuses unless the payment names
 * this approval and the approval's amount is the payment's (D-078).
 *
 * ## Whole instalments, in order (D-297)
 *
 * Only the lowest instalment without a posted payment may be paid, and not while one is
 * waiting for a checker. Two submits for the same instalment meet the unique index on live
 * payments; the journal key is the instalment's, so a second journal is impossible anyway.
 */

const payloadSchema = z
  .object({ paymentId: z.string().uuid(), loanId: z.string().uuid() })
  .strict();

export interface RepaymentResult {
  readonly paymentId: string;
  readonly status: 'posted' | 'pending_approval';
  readonly journalId: string | null;
  readonly approvalId: string | null;
  readonly businessDate: string;
  readonly principalPoisha: string;
  readonly interestPoisha: string;
}

@Injectable()
export class LoanPaymentsService implements OnModuleInit {
  constructor(
    @Inject(LEDGER_API) private readonly ledger: LedgerApi,
    private readonly loans: LoansService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.approvals.registerExecutor('loan_repayment', this.execute);
    this.approvals.registerRejectionHandler('loan_repayment', this.release);
  }

  async pay(
    context: ActiveContext,
    request: AuditableRequest,
    loanId: string,
    input: PayInstalmentInput,
    now: Date = new Date(),
  ): Promise<RepaymentResult> {
    const date = businessDate(now);

    // A retried submit answers from the row it wrote.
    const checked = await mapLoanErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const existing = await repo.paymentById(tx, context.orgId, input.paymentId);
        if (existing !== undefined) {
          if (existing.instalment_id !== input.instalmentId.toLowerCase()) {
            throw new LoansHttpError(
              'IDEMPOTENCY_CONFLICT',
              'That payment id was already used for a different instalment.',
            );
          }
          if (existing.status === 'rejected') {
            throw new LoansHttpError(
              'IDEMPOTENCY_CONFLICT',
              'That payment was rejected. Pay the instalment again with a new id.',
            );
          }
          return { replay: this.view(existing), instalment: null };
        }
        const instalment = await this.payable(tx, context.orgId, loanId, input.instalmentId);
        // Checked here so a request with a foreign or inactive wallet is refused before an
        // approval is raised for it.
        await this.loans.wallet(tx, context.orgId, input.walletAccountId);
        return { replay: null, instalment };
      }),
    );
    if (checked.replay !== null) return checked.replay;
    const { instalment } = checked;
    if (instalment === null) throw new Error('unreachable: no replay and no instalment');
    const principal = poisha(instalment.principal_poisha);
    const interest = poisha(instalment.interest_poisha);
    const total = poisha(principal + interest);

    const needsApproval = await this.approvals.isRequired(context, {
      type: 'loan_repayment',
      amountPoisha: total,
      amountDerivedByServer: true,
    });

    let approvalId: string | null = null;
    if (needsApproval) {
      /*
       * Raised before the row is written, in the approvals module's own transaction, as a
       * supplier payment is: `request()` opens its own `withOrg`. A crash between the two
       * leaves an approval naming no payment, which its executor refuses to act on.
       */
      const raised = await this.approvals.request(context, {
        type: 'loan_repayment',
        amountPoisha: total,
        amountDerivedByServer: true,
        raisedByModule: true,
        payload: { paymentId: input.paymentId, loanId },
        reason: input.memo ?? `Loan instalment ${String(instalment.seq)}`,
        request,
      });
      approvalId = raised.id;
    }

    return mapLoanErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        // Checked again inside the writing transaction: another payment may have landed.
        await this.payable(tx, context.orgId, loanId, input.instalmentId);
        const wallet = await this.loans.wallet(tx, context.orgId, input.walletAccountId);
        const journalId =
          approvalId === null
            ? await this.post(tx, context, {
                instalmentId: instalment.id,
                lenderId: instalment.lender_id,
                occurredAt: now,
                wallet,
                principalPoisha: principal,
                interestPoisha: interest,
                memo: input.memo ?? null,
              })
            : null;

        try {
          await repo.insertPayment(tx, {
            orgId: context.orgId,
            id: input.paymentId,
            loanId,
            instalmentId: instalment.id,
            walletAccountId: wallet.accountId,
            principalPoisha: principal,
            interestPoisha: interest,
            status: approvalId === null ? 'posted' : 'pending_approval',
            occurredAt: now,
            businessDate: date,
            approvalRequestId: approvalId,
            journalId,
            memo: input.memo ?? null,
            createdBy: context.userId,
          });
        } catch (error) {
          if (pgCode(error) === '23505') {
            throw new LoansHttpError(
              'LOAN_PAYMENT_INVALID',
              'That instalment is already paid or waiting for approval.',
            );
          }
          throw error;
        }

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'loans.payment.recorded',
          entityType: 'LoanPayment',
          entityId: input.paymentId,
          before: null,
          after: {
            loanId,
            instalmentId: instalment.id,
            seq: instalment.seq,
            status: approvalId === null ? 'posted' : 'pending_approval',
            principalPoisha: principal.toString(),
            interestPoisha: interest.toString(),
            walletAccountId: wallet.accountId,
            approvalId,
            journalId,
          },
          requestId: context.requestId,
          request,
        });

        return serializeFor(context, 'CompanyLoan', {
          paymentId: input.paymentId,
          status: approvalId === null ? ('posted' as const) : ('pending_approval' as const),
          journalId,
          approvalId,
          businessDate: date,
          principalPoisha: principal.toString(),
          interestPoisha: interest.toString(),
        });
      }),
    );
  }

  /**
   * The instalment, if it is the one that may be paid now (D-297). Its loan must be this
   * one, it must be the lowest without a posted payment, and none may be waiting.
   */
  private async payable(tx: Tx, orgId: string, loanId: string, instalmentId: string) {
    const loan = await repo.loanById(tx, orgId, loanId);
    if (loan === undefined) throw new LoansHttpError('LOAN_NOT_FOUND', 'No such loan.');
    const instalments = await repo.instalmentsOf(tx, orgId, loanId);
    const target = instalments.find((row) => row.id === instalmentId.toLowerCase());
    if (target === undefined) {
      throw new LoansHttpError('LOAN_NOT_FOUND', 'That loan has no such instalment.');
    }
    const next = payableInstalment(instalments.map(facts));
    if (next.seq === null) {
      throw new LoansHttpError(
        'LOAN_PAYMENT_INVALID',
        next.reason === 'settled'
          ? 'Every instalment of this loan is paid.'
          : 'A payment for this loan is waiting for approval; decide it first.',
      );
    }
    if (next.seq !== target.seq) {
      throw new LoansHttpError(
        'LOAN_PAYMENT_INVALID',
        `Instalments are paid in order; instalment ${String(next.seq)} is next.`,
      );
    }
    return { ...target, lender_id: loan.lender_id };
  }

  private async post(
    tx: Tx,
    context: ActiveContext,
    input: {
      readonly instalmentId: string;
      readonly lenderId: string;
      readonly occurredAt: Date;
      readonly wallet: PostingAccount;
      readonly principalPoisha: ReturnType<typeof poisha>;
      readonly interestPoisha: ReturnType<typeof poisha>;
      readonly memo: string | null;
    },
  ): Promise<string> {
    const [loanPayable, interestExpense] = await Promise.all([
      this.loans.account(tx, context.orgId, 'loan_payable'),
      this.loans.account(tx, context.orgId, 'interest_expense'),
    ]);
    const posted = await this.ledger.post(
      tx,
      { orgId: context.orgId, userId: context.userId },
      loanInstalmentPaidDraft({ ...input, loanPayable, interestExpense }),
    );
    return posted.journalId;
  }

  /**
   * Post the approved repayment, inside the transaction that approved it. Refuses rather
   * than returns quietly when the approval's amount is not the payment's: that would be
   * the maker-checker bypass itself.
   */
  private readonly execute: ApprovalExecutor = async (tx, { context, approval, request }) => {
    const parsed = payloadSchema.safeParse(approval.payload);
    if (!parsed.success) return;
    const payment = await repo.paymentById(tx, context.orgId, parsed.data.paymentId);
    if (payment?.status !== 'pending_approval') return;
    if (payment.approval_request_id !== approval.id) return;

    await mapLoanErrors(async () => {
      const principal = poisha(payment.principal_poisha);
      const interest = poisha(payment.interest_poisha);
      if (approval.amountPoisha === null || approval.amountPoisha !== principal + interest) {
        throw new LoansHttpError(
          'LOAN_PAYMENT_INVALID',
          'That approval does not carry the amount the payment was raised for.',
        );
      }
      const loan = await repo.loanById(tx, context.orgId, payment.loan_id);
      if (loan === undefined) throw new LoansHttpError('LOAN_NOT_FOUND', 'No such loan.');
      const wallet = await this.loans.wallet(tx, context.orgId, payment.wallet_account_id);
      const journalId = await this.post(tx, context, {
        instalmentId: payment.instalment_id,
        lenderId: loan.lender_id,
        // The day the payment was recorded, as a supplier payment's is: the row and its
        // journal carry one date.
        occurredAt: new Date(payment.occurred_at),
        wallet,
        principalPoisha: principal,
        interestPoisha: interest,
        memo: payment.memo,
      });
      await repo.settlePayment(tx, context.orgId, payment.id, { status: 'posted', journalId });
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'loans.payment.posted',
        entityType: 'LoanPayment',
        entityId: payment.id,
        before: { status: 'pending_approval' },
        after: { status: 'posted', journalId, approvalId: approval.id },
        requestId: context.requestId,
        ...(request === undefined ? {} : { request }),
      });
    });
  };

  /** A rejected repayment is marked rejected, so its instalment can be paid again (D-299). */
  private readonly release: ApprovalExecutor = async (tx, { context, approval, request }) => {
    const parsed = payloadSchema.safeParse(approval.payload);
    if (!parsed.success) return;
    const payment = await repo.paymentById(tx, context.orgId, parsed.data.paymentId);
    if (payment?.status !== 'pending_approval') return;
    if (payment.approval_request_id !== approval.id) return;
    await repo.settlePayment(tx, context.orgId, payment.id, {
      status: 'rejected',
      journalId: null,
    });
    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'reject',
      action: 'loans.payment.rejected',
      entityType: 'LoanPayment',
      entityId: payment.id,
      before: { status: 'pending_approval' },
      after: { status: 'rejected', approvalId: approval.id },
      requestId: context.requestId,
      ...(request === undefined ? {} : { request }),
    });
  };

  private view(row: repo.PaymentRow): RepaymentResult {
    return {
      paymentId: row.id,
      status: row.status === 'posted' ? 'posted' : 'pending_approval',
      journalId: row.journal_id,
      approvalId: row.approval_request_id,
      businessDate: row.business_date,
      principalPoisha: row.principal_poisha,
      interestPoisha: row.interest_poisha,
    };
  }
}
