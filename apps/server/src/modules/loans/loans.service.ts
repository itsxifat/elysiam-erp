import { Inject, Injectable } from '@nestjs/common';
import { serializeFor } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import {
  businessDate,
  companyLoanReceivedDraft,
  maskPhone,
  normalizeBdPhone,
  poisha,
  toIsoDate,
  type IsoDate,
  type PostingAccount,
} from '@elysium/domain';
import {
  addMonthsClamped,
  instalmentState,
  loanPosition,
  loanSchedule,
  payableInstalment,
  scheduleTotals,
  type InstalmentFacts,
  type LoanInstalment,
} from '@elysium/domain/loans';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import { LoansHttpError, mapLoanErrors } from './loans.errors.js';
import * as repo from './loans.repository.js';
import type { CreateLenderInput, CreateLoanInput, PreviewScheduleInput } from './loans.schemas.js';

/**
 * Lenders, loans, their schedules and statements (architecture §7, §15; M26).
 *
 * Recording a loan is money **in**, and like investor capital it posts at once with no
 * maker-checker (D-296): nothing is recovered by refusing to admit that the bank paid the
 * principal, and holding it unposted would leave the wallet disagreeing with the bank
 * statement. The receipt journal, the loan row and its whole schedule are one transaction,
 * and a deferred trigger checks at commit that the schedule sums to the principal.
 *
 * The receipt is dated by the server's clock in Asia/Dhaka (invariant 8), so a loan cannot
 * be back-dated into a closed period from a screen. Loans taken before go-live are a
 * follow-up (D-296).
 */

export function toView(row: LoanInstalment) {
  return {
    seq: row.seq,
    dueOn: row.dueOn,
    principalPoisha: row.principalPoisha.toString(),
    interestPoisha: row.interestPoisha.toString(),
    totalPoisha: row.totalPoisha.toString(),
    balanceAfterPoisha: row.balanceAfterPoisha.toString(),
  };
}

function totalsView(rows: readonly LoanInstalment[]) {
  const totals = scheduleTotals(rows);
  return {
    principalPoisha: totals.principalPoisha.toString(),
    interestPoisha: totals.interestPoisha.toString(),
    totalPoisha: totals.totalPoisha.toString(),
  };
}

export function facts(row: repo.InstalmentRow): InstalmentFacts {
  return {
    seq: row.seq,
    dueOn: toIsoDate(row.due_on),
    principalPoisha: poisha(row.principal_poisha),
    interestPoisha: poisha(row.interest_poisha),
    payment: row.payment_status,
  };
}

@Injectable()
export class LoansService {
  constructor(
    @Inject(LEDGER_API) private readonly ledger: LedgerApi,
    private readonly audit: AuditService,
  ) {}

  // --- lenders ---------------------------------------------------------------------

  async listLenders(context: ActiveContext) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.listLenders(tx, context.orgId);
      return serializeFor(context, 'CompanyLoan', {
        items: rows.map((row) => ({
          id: row.id,
          name: row.name,
          kind: row.kind,
          notes: row.notes,
        })),
      });
    });
  }

  async createLender(context: ActiveContext, request: AuditableRequest, input: CreateLenderInput) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const notes = input.notes === undefined || input.notes === '' ? null : input.notes;
      const id = await repo.insertLender(tx, {
        orgId: context.orgId,
        name: input.name,
        kind: input.kind,
        notes,
        createdBy: context.userId,
      });
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'loans.lender.created',
        entityType: 'Lender',
        entityId: id,
        before: null,
        after: { name: input.name, kind: input.kind },
        requestId: context.requestId,
        request,
      });
      return serializeFor(context, 'CompanyLoan', {
        id,
        name: input.name,
        kind: input.kind,
        notes,
      });
    });
  }

  // --- schedules -------------------------------------------------------------------

  /** The schedule proposed terms would have, received today. Nothing is written. */
  preview(context: ActiveContext, input: PreviewScheduleInput, now: Date = new Date()) {
    const receivedOn = businessDate(now);
    const firstDueOn = this.firstDue(receivedOn, input.firstDueOn);
    const rows = loanSchedule({
      principalPoisha: poisha(input.principalPoisha),
      rateBps: input.rateBps,
      method: input.method,
      tenureMonths: input.tenureMonths,
      firstDueOn,
    });
    return serializeFor(context, 'CompanyLoan', {
      receivedOn,
      firstDueOn,
      instalments: rows.map(toView),
      totals: totalsView(rows),
    });
  }

  private firstDue(receivedOn: IsoDate, requested: string | undefined): IsoDate {
    const firstDueOn =
      requested === undefined ? addMonthsClamped(receivedOn, 1) : toIsoDate(requested);
    if (firstDueOn <= receivedOn) {
      throw new LoansHttpError(
        'LOAN_TERMS_INVALID',
        'The first instalment falls due after the day the loan is received.',
      );
    }
    return firstDueOn;
  }

  // --- loans -----------------------------------------------------------------------

  async list(context: ActiveContext, now: Date = new Date()) {
    const today = businessDate(now);
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.listLoans(tx, context.orgId);
      return serializeFor(context, 'CompanyLoan', {
        items: rows.map((row) => {
          const voided = row.voided_at !== null;
          const outstanding = voided
            ? 0n
            : BigInt(row.principal_poisha) - BigInt(row.paid_principal_poisha);
          return {
            id: row.id,
            lenderId: row.lender_id,
            lenderName: row.lender_name,
            reference: row.reference,
            principalPoisha: row.principal_poisha,
            rateBps: row.rate_bps,
            method: row.method,
            tenureMonths: row.tenure_months,
            receivedOn: row.received_on,
            paidInstalments: row.paid_instalments,
            outstandingPrincipalPoisha: outstanding.toString(),
            voided,
            next:
              voided || row.next_instalment_id === null
                ? null
                : {
                    instalmentId: row.next_instalment_id,
                    seq: row.next_seq,
                    dueOn: row.next_due_on,
                    totalPoisha: row.next_total_poisha,
                    state:
                      row.next_status === 'pending_approval'
                        ? 'pending_approval'
                        : (row.next_due_on ?? '') < today
                          ? 'overdue'
                          : 'due',
                  },
          };
        }),
      });
    });
  }

  /**
   * Record a loan: Dr W / Cr Loan payable (lender), the loan row and its schedule, in one
   * transaction. A retried submit with the same `loanId` answers from the row that exists.
   */
  async create(
    context: ActiveContext,
    request: AuditableRequest,
    input: CreateLoanInput,
    now: Date = new Date(),
  ) {
    const principal = poisha(input.principalPoisha);
    const reminderPhone = this.reminderPhone(input.reminderPhone);

    return mapLoanErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const existing = await repo.loanById(tx, context.orgId, input.loanId);
        if (existing !== undefined) {
          // A replay must be the same loan in every term, not just the same lender and
          // amount: a reused id with another rate answering 201 would hide the mistake.
          const firstDueOn = input.firstDueOn ?? existing.first_due_on;
          if (
            existing.lender_id !== input.lenderId.toLowerCase() ||
            BigInt(existing.principal_poisha) !== principal ||
            existing.rate_bps !== input.rateBps ||
            existing.method !== input.method ||
            existing.tenure_months !== input.tenureMonths ||
            existing.first_due_on !== firstDueOn ||
            existing.wallet_account_id !== input.walletAccountId.toLowerCase()
          ) {
            throw new LoansHttpError(
              'IDEMPOTENCY_CONFLICT',
              'That loan id was already used for a different loan.',
            );
          }
          return this.statementIn(tx, context, existing, now);
        }

        const lender = await repo.lenderById(tx, context.orgId, input.lenderId);
        if (lender === undefined) {
          throw new LoansHttpError('LOAN_LENDER_NOT_FOUND', 'No such lender.');
        }
        const wallet = await this.wallet(tx, context.orgId, input.walletAccountId);
        const loanPayable = await this.account(tx, context.orgId, 'loan_payable');

        const receivedOn = businessDate(now);
        const firstDueOn = this.firstDue(receivedOn, input.firstDueOn);
        const schedule = loanSchedule({
          principalPoisha: principal,
          rateBps: input.rateBps,
          method: input.method,
          tenureMonths: input.tenureMonths,
          firstDueOn,
        });

        const draft = companyLoanReceivedDraft({
          loanId: input.loanId,
          lenderId: lender.id,
          occurredAt: now,
          wallet,
          loanPayable,
          principalPoisha: principal,
          memo: input.memo ?? `Loan from ${lender.name}`,
        });
        const posted = await this.ledger.post(
          tx,
          { orgId: context.orgId, userId: context.userId },
          draft,
        );

        await repo.insertLoan(tx, {
          orgId: context.orgId,
          id: input.loanId,
          lenderId: lender.id,
          reference:
            input.reference === undefined || input.reference === '' ? null : input.reference,
          principalPoisha: principal,
          rateBps: input.rateBps,
          method: input.method,
          tenureMonths: input.tenureMonths,
          receivedOn: posted.businessDate,
          firstDueOn,
          reminderDays: input.reminderDays,
          reminderPhone,
          walletAccountId: wallet.accountId,
          receivedJournalId: posted.journalId,
          memo: input.memo === undefined || input.memo === '' ? null : input.memo,
          createdBy: context.userId,
        });
        await repo.insertInstalments(
          tx,
          context.orgId,
          input.loanId,
          schedule.map((row) => ({
            seq: row.seq,
            dueOn: row.dueOn,
            principalPoisha: row.principalPoisha,
            interestPoisha: row.interestPoisha,
          })),
        );

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'loans.loan.received',
          entityType: 'CompanyLoan',
          entityId: input.loanId,
          before: null,
          after: {
            lenderId: lender.id,
            principalPoisha: principal.toString(),
            rateBps: input.rateBps,
            method: input.method,
            tenureMonths: input.tenureMonths,
            firstDueOn,
            walletAccountId: wallet.accountId,
            journalId: posted.journalId,
            idempotencyKey: draft.idempotencyKey,
          },
          requestId: context.requestId,
          request,
        });

        const created = await repo.loanById(tx, context.orgId, input.loanId);
        if (created === undefined) throw new Error('the loan just written is not readable');
        return this.statementIn(tx, context, created, now);
      }),
    );
  }

  /** The statement: schedule, payments, totals, and the ledger's balance beside them. */
  async statement(context: ActiveContext, loanId: string, now: Date = new Date()) {
    return mapLoanErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const loan = await repo.loanById(tx, context.orgId, loanId);
        if (loan === undefined) throw new LoansHttpError('LOAN_NOT_FOUND', 'No such loan.');
        return this.statementIn(tx, context, loan, now);
      }),
    );
  }

  /**
   * Void a loan recorded by mistake (D-304): reverse its receipt journal and mark it void,
   * in one transaction. Only while nothing is repaid or waiting — after that the loan is
   * real and its mistakes are settled with the lender, not erased.
   */
  async void(
    context: ActiveContext,
    request: AuditableRequest,
    loanId: string,
    reason: string,
    now: Date = new Date(),
  ) {
    return mapLoanErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const loan = await repo.loanById(tx, context.orgId, loanId);
        if (loan === undefined) throw new LoansHttpError('LOAN_NOT_FOUND', 'No such loan.');
        if (loan.voided_at !== null) {
          throw new LoansHttpError('LOAN_IMMUTABLE', 'That loan is already void.');
        }
        if ((await repo.livePayments(tx, context.orgId, loan.id)) > 0) {
          throw new LoansHttpError(
            'LOAN_IMMUTABLE',
            'A repayment of this loan is posted or waiting, so it cannot be voided.',
          );
        }
        const reversal = await this.ledger.reverse(
          tx,
          { orgId: context.orgId, userId: context.userId },
          loan.received_journal_id,
          `Loan voided: ${reason}`,
          now,
        );
        const moved = await repo.voidLoan(tx, {
          orgId: context.orgId,
          id: loan.id,
          voidedBy: context.userId,
          reason,
          voidJournalId: reversal.journalId,
        });
        if (moved !== 1) throw new LoansHttpError('LOAN_IMMUTABLE', 'That loan is already void.');
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'loans.loan.voided',
          entityType: 'CompanyLoan',
          entityId: loan.id,
          before: { voided: false },
          after: { voided: true, reason, voidJournalId: reversal.journalId },
          requestId: context.requestId,
          request,
        });
        const voided = await repo.loanById(tx, context.orgId, loan.id);
        if (voided === undefined) throw new Error('the loan just voided is not readable');
        return this.statementIn(tx, context, voided, now);
      }),
    );
  }

  private async statementIn(tx: Tx, context: ActiveContext, loan: repo.LoanRow, now: Date) {
    const today = businessDate(now);
    const voided = loan.voided_at !== null;
    const instalments = await repo.instalmentsOf(tx, context.orgId, loan.id);
    const payments = await repo.paymentsOf(tx, context.orgId, loan.id);
    const rows = instalments.map(facts);
    const position = loanPosition(rows);
    const payable = payableInstalment(rows);

    // What the ledger says the brand owes this lender, across all their loans, beside what
    // this module's schedules say: Σ credit − Σ debit on `loan_payable` for the party.
    const balances = await this.ledger.balancesAsOf(tx, context.orgId, today, ['loan_payable']);
    const ledgerOwed = balances
      .filter((balance) => balance.partyId === loan.lender_id)
      .reduce((acc, balance) => acc + balance.creditPoisha - balance.debitPoisha, 0n);
    const scheduleOwed = await repo.lenderOutstanding(tx, context.orgId, loan.lender_id);

    let balance = BigInt(loan.principal_poisha);
    return serializeFor(context, 'CompanyLoan', {
      loan: {
        id: loan.id,
        lenderId: loan.lender_id,
        lenderName: loan.lender_name,
        reference: loan.reference,
        principalPoisha: loan.principal_poisha,
        rateBps: loan.rate_bps,
        method: loan.method,
        tenureMonths: loan.tenure_months,
        receivedOn: loan.received_on,
        firstDueOn: loan.first_due_on,
        reminderDays: loan.reminder_days,
        reminderPhoneMasked: loan.reminder_phone === null ? null : maskPhone(loan.reminder_phone),
        walletAccountId: loan.wallet_account_id,
        receivedJournalId: loan.received_journal_id,
        memo: loan.memo,
        voidedAt: loan.voided_at === null ? null : new Date(loan.voided_at).toISOString(),
        voidReason: loan.void_reason,
        voidJournalId: loan.void_journal_id,
      },
      instalments: instalments.map((row) => {
        const fact = facts(row);
        balance -= fact.principalPoisha;
        return {
          id: row.id,
          seq: row.seq,
          dueOn: row.due_on,
          principalPoisha: row.principal_poisha,
          interestPoisha: row.interest_poisha,
          totalPoisha: (fact.principalPoisha + fact.interestPoisha).toString(),
          balanceAfterPoisha: balance.toString(),
          state: voided && fact.payment === null ? 'void' : instalmentState(fact, today),
          paymentId: row.payment_id,
          remindedOn: row.reminded_on,
        };
      }),
      payments: payments.map((row) => ({
        id: row.id,
        instalmentId: row.instalment_id,
        seq: row.seq,
        walletAccountId: row.wallet_account_id,
        principalPoisha: row.principal_poisha,
        interestPoisha: row.interest_poisha,
        totalPoisha: (BigInt(row.principal_poisha) + BigInt(row.interest_poisha)).toString(),
        status: row.status,
        businessDate: row.business_date,
        approvalRequestId: row.approval_request_id,
        journalId: row.journal_id,
        memo: row.memo,
      })),
      totals: {
        paidInstalments: position.paidInstalments,
        paidPrincipalPoisha: position.paidPrincipalPoisha.toString(),
        paidInterestPoisha: position.paidInterestPoisha.toString(),
        outstandingPrincipalPoisha: voided ? '0' : position.outstandingPrincipalPoisha.toString(),
        outstandingInterestPoisha: voided ? '0' : position.outstandingInterestPoisha.toString(),
      },
      payable: voided
        ? { instalmentId: null, reason: 'voided' }
        : payable.seq === null
          ? { instalmentId: null, reason: payable.reason }
          : {
              instalmentId: instalments.find((row) => row.seq === payable.seq)?.id ?? null,
              reason: null,
            },
      lender: {
        asOf: today,
        ledgerOwedPoisha: ledgerOwed.toString(),
        scheduleOwedPoisha: scheduleOwed.toString(),
      },
    });
  }

  // --- helpers ---------------------------------------------------------------------

  private reminderPhone(input: string | undefined): string | null {
    if (input === undefined || input === '') return null;
    try {
      return normalizeBdPhone(input);
    } catch {
      throw new LoansHttpError(
        'LOAN_TERMS_INVALID',
        'The reminder phone is not a Bangladeshi mobile number.',
      );
    }
  }

  /** A wallet of this brand, active. Anything else answers as missing. */
  async wallet(tx: Tx, orgId: string, id: string): Promise<PostingAccount> {
    const wallet = await this.ledger.walletAccountById(tx, orgId, id);
    if (!wallet?.isActive) {
      throw new LoansHttpError('LEDGER_ACCOUNT_NOT_FOUND', 'No such wallet.');
    }
    return { accountId: wallet.accountId, subtype: wallet.subtype, branchId: wallet.branchId };
  }

  /** One of §7's system accounts, or a clear refusal that the chart is broken. */
  async account(
    tx: Tx,
    orgId: string,
    subtype: 'loan_payable' | 'interest_expense',
  ): Promise<PostingAccount> {
    const account = await this.ledger.accountBySubtype(tx, orgId, subtype);
    if (account === null) {
      throw new LoansHttpError(
        'LEDGER_ACCOUNT_NOT_FOUND',
        `This organization has no ${subtype} account. Seed the chart of accounts first.`,
      );
    }
    return account;
  }
}
