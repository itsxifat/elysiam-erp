import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { serializeFor } from '@elysium/contracts';
import { withOrg } from '@elysium/db';
import { ACCOUNT_SUBTYPES, isAccountSubtype, poisha } from '@elysium/domain';
import { assertWithdrawable, withdrawableFor } from '@elysium/domain/investors';
import {
  investorPaymentDraft,
  WITHDRAWAL_DEBIT_SUBTYPE,
  type WithdrawalPaymentKind,
} from '@elysium/domain/posting/investors';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ApprovalsService, type ApprovalExecutor } from '../approvals/approvals.service.js';
import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import * as repo from './investors.repository.js';
import { investorsHttpError, mapInvestorErrors } from './investors.errors.js';
import { InvestorsService, investorScope } from './investors.service.js';
import type { RequestWithdrawalInput, ReviewWithdrawalInput } from './investors.schemas.js';

/**
 * Withdrawals: `requested → reviewed → approved → paid` (architecture §15, §7).
 *
 * Four steps, four different decisions, and the reason they are not two:
 *
 * - **requested** — somebody asks. No money is committed and nothing is checked
 *   except that the investor exists and the amount is positive.
 * - **reviewed** — the finance team confirms the position covers it and names the
 *   wallet it would leave. This is the **maker** side of maker-checker: reviewing
 *   raises the `investor_withdrawal` approval, and the database refuses a reviewer
 *   who is also the requester (0058).
 * - **approved** — a checker decides. Still no journal: an approval is a decision,
 *   and a journal posted here would show the money gone on a day the bank account
 *   still held it.
 * - **paid** — the money leaves a wallet and the journal is posted. This is the
 *   only step that touches the ledger.
 *
 * The amount, the investor and the kind are frozen from the moment the row exists
 * (0060). Without that, UPDATE — which the row needs for its path — would also let
 * the amount be raised after a checker approved the smaller one, and the payment
 * would post the new number.
 *
 * **The position is checked twice, and the second check is the one that matters.**
 * At review, and again at payment: a distribution can be reversed and another
 * withdrawal can be paid between the two, and an investor's capital account is
 * perfectly capable of going negative without anything complaining.
 */

/** What an `investor_withdrawal` payload must say for this module to act on it. */
const withdrawalPayloadSchema = z.object({ withdrawalId: z.string().uuid() }).strict();

export interface WithdrawalView {
  readonly id: string;
  readonly investorId: string;
  readonly investorCode: string;
  readonly investorName: string;
  readonly kind: string;
  readonly amountPoisha: string;
  readonly status: string;
  readonly reason: string | null;
  readonly requestedAt: string;
  readonly walletAccountId: string | null;
  readonly approvalId: string | null;
  readonly journalId: string | null;
  readonly paidOn: string | null;
}

/**
 * Through `serializeFor` like every read (invariant 5).
 *
 * Nothing on a withdrawal is a cost field today. The strip is here anyway, because
 * the first cost-bearing figure anybody adds — a margin on the period a
 * distribution came from, say — would otherwise leave through a mutation response
 * while every list stayed clean, and that is exactly the leak nobody looks for.
 */
function serialized(context: ActiveContext, row: repo.WithdrawalRow): WithdrawalView {
  return serializeFor(context, 'Investor', view(row));
}

function view(row: repo.WithdrawalRow): WithdrawalView {
  return {
    id: row.id,
    investorId: row.investor_id,
    investorCode: row.investor_code,
    investorName: row.investor_name,
    kind: row.kind,
    amountPoisha: row.amount_poisha,
    status: row.status,
    reason: row.reason,
    requestedAt: String(row.requested_at),
    walletAccountId: row.wallet_account_id,
    approvalId: row.approval_request_id,
    journalId: row.journal_id,
    paidOn: row.paid_on,
  };
}

@Injectable()
export class WithdrawalsService implements OnModuleInit {
  constructor(
    @Inject(LEDGER_API) private readonly ledger: LedgerApi,
    private readonly approvals: ApprovalsService,
    private readonly investors: InvestorsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.approvals.registerExecutor('investor_withdrawal', this.executeWithdrawal);
  }

  async list(
    context: ActiveContext,
    request: object,
    query: { readonly investorId?: string | undefined; readonly status?: string | undefined },
  ): Promise<{ items: readonly WithdrawalView[] }> {
    const scope = investorScope(request);
    return mapInvestorErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) =>
        serializeFor(context, 'Investor', {
          items: (
            await repo.listWithdrawals(tx, context.orgId, {
              scope,
              investorId: query.investorId,
              status: query.status,
            })
          ).map(view),
        }),
      ),
    );
  }

  /** Step 1: record the request. Nothing is committed and nothing posts. */
  async request(
    context: ActiveContext,
    request: AuditableRequest,
    input: RequestWithdrawalInput,
  ): Promise<WithdrawalView> {
    const amount = poisha(input.amountPoisha);

    return mapInvestorErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const investor = await this.investors.requireInvestor(
          tx,
          context,
          request,
          input.investorId,
        );

        const existing = await repo.withdrawalById(tx, context.orgId, input.withdrawalId);
        if (existing !== undefined) {
          if (
            existing.investor_id !== investor.id ||
            existing.kind !== input.kind ||
            BigInt(existing.amount_poisha) !== amount
          ) {
            throw investorsHttpError(
              'IDEMPOTENCY_CONFLICT',
              'That withdrawal id was already used for a different request.',
            );
          }
          return serialized(context, existing);
        }

        /*
         * The investor's row lock, before the headroom is read.
         *
         * Without it the check below is a read followed by a write that another
         * request can interleave with: two simultaneous ৳8,00,000 requests against
         * ৳10,00,000 of capital each see an empty queue and both pass, and the pair
         * then exceeds the position with no way to tell which one was the mistake.
         */
        await repo.lockInvestor(tx, context.orgId, investor.id);

        /*
         * Refused here as well as at review, so an investor is told at once rather
         * than after a person has looked at it. `headroomFor` subtracts the
         * requests already in flight: three ৳1,00,000 requests against ৳1,50,000
         * of capital each pass on their own, and the third would be paid out of
         * nothing.
         */
        const { position, availablePoisha } = await this.investors.headroomFor(
          tx,
          context,
          investor.id,
          input.kind,
        );
        if (amount > availablePoisha) {
          // The domain's message names the limit that was hit — a lock-in reads
          // differently from an empty account, and an investor needs to know which.
          assertWithdrawable(position, input.kind, amount);
          throw investorsHttpError(
            'INVESTOR_POSITION_INSUFFICIENT',
            `Requests already waiting leave only ${availablePoisha.toString()} poisha available.`,
          );
        }

        await repo.insertWithdrawal(tx, {
          orgId: context.orgId,
          id: input.withdrawalId,
          investorId: investor.id,
          kind: input.kind,
          amountPoisha: amount,
          reason: input.reason ?? null,
          requestedBy: context.userId,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'investors.withdrawal.requested',
          entityType: 'InvestorWithdrawal',
          entityId: input.withdrawalId,
          before: null,
          after: {
            investorId: investor.id,
            kind: input.kind,
            amountPoisha: amount.toString(),
            status: 'requested',
          },
          requestId: context.requestId,
          request,
        });

        const row = await repo.withdrawalById(tx, context.orgId, input.withdrawalId);
        if (row === undefined) {
          throw investorsHttpError('INVESTOR_NOT_FOUND', 'No such withdrawal.');
        }
        return serialized(context, row);
      }),
    );
  }

  /**
   * Step 2: review it, name the wallet, and raise the approval.
   *
   * The approval is raised **outside** the row update and before it, for the same
   * reason a declaration is: a `reviewed` row has to name the approval that will
   * decide it (a CHECK in 0058). The reviewer is the maker, so the checker must be
   * somebody else — `approvals.approval_requests` enforces that, and 0058 enforces
   * that the reviewer is not the requester.
   */
  async review(
    context: ActiveContext,
    request: AuditableRequest,
    withdrawalId: string,
    input: ReviewWithdrawalInput,
  ): Promise<WithdrawalView> {
    const prepared = await mapInvestorErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const row = await repo.withdrawalById(tx, context.orgId, withdrawalId);
        if (row === undefined) {
          throw investorsHttpError('INVESTOR_NOT_FOUND', 'No such withdrawal.');
        }
        if (row.status !== 'requested') {
          throw investorsHttpError(
            'INVESTOR_WITHDRAWAL_FROZEN',
            `That withdrawal is ${row.status}; only a requested one can be reviewed.`,
          );
        }
        if (row.requested_by === context.userId) {
          throw investorsHttpError(
            'FORBIDDEN',
            'A withdrawal is reviewed by somebody other than whoever asked for it.',
          );
        }

        const wallet = await repo.accountById(tx, context.orgId, input.walletAccountId);
        if (wallet === undefined || !isAccountSubtype(wallet.subtype)) {
          throw investorsHttpError('LEDGER_ACCOUNT_NOT_FOUND', 'No such wallet account.');
        }
        /*
         * Checked here, not only by the posting rule and the trigger. Both of those
         * fire at payment — days after a checker approved a payment "from" an
         * account that was never a wallet — and the reviewer is the person who can
         * still fix it.
         */
        if (!ACCOUNT_SUBTYPES[wallet.subtype].wallet) {
          throw investorsHttpError(
            'LEDGER_ACCOUNT_INVALID',
            `${wallet.code} is not a wallet; an investor is paid from one (§7).`,
          );
        }
        if (!wallet.is_active) {
          throw investorsHttpError('LEDGER_ACCOUNT_INVALID', `${wallet.code} is closed.`);
        }

        const kind = row.kind === 'capital' ? 'capital' : 'profit';
        const amount = poisha(row.amount_poisha);
        // The same lock the request took, for the same reason: the aggregate check
        // below is a read that decides a write.
        await repo.lockInvestor(tx, context.orgId, row.investor_id);
        const { position, openPoisha } = await this.investors.headroomFor(
          tx,
          context,
          row.investor_id,
          kind,
        );
        /*
         * `openPoisha` **includes this row**, which is exactly the comparison to
         * make: everything waiting has to fit inside the position, not just the
         * request in front of the reviewer. Checking this one alone is how three
         * ৳1,00,000 requests against ৳1,50,000 of capital each get reviewed and
         * approved, and the third gets paid out of nothing.
         */
        if (withdrawableFor(position, kind) < openPoisha) {
          // Names the limit this single request hits, when it hits one at all.
          assertWithdrawable(position, kind, amount);
          throw investorsHttpError(
            'INVESTOR_POSITION_INSUFFICIENT',
            `Withdrawals already waiting come to ${openPoisha.toString()} poisha, more than this investor holds.`,
          );
        }

        return { row, walletId: wallet.id, amount, kind };
      }),
    );

    const raised = await this.approvals.request(context, {
      type: 'investor_withdrawal',
      amountPoisha: prepared.amount,
      payload: { withdrawalId },
      reason: input.note ?? prepared.row.reason ?? `Investor ${prepared.kind} withdrawal`,
      request,
    });

    return mapInvestorErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        await repo.reviewWithdrawal(tx, context.orgId, withdrawalId, {
          reviewedBy: context.userId,
          walletAccountId: prepared.walletId,
          approvalRequestId: raised.id,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'investors.withdrawal.reviewed',
          entityType: 'InvestorWithdrawal',
          entityId: withdrawalId,
          before: { status: 'requested' },
          after: {
            status: 'reviewed',
            walletAccountId: prepared.walletId,
            approvalId: raised.id,
            note: input.note ?? null,
          },
          requestId: context.requestId,
          request,
        });

        const row = await repo.withdrawalById(tx, context.orgId, withdrawalId);
        if (row === undefined) {
          throw investorsHttpError('INVESTOR_NOT_FOUND', 'No such withdrawal.');
        }
        return serialized(context, row);
      }),
    );
  }

  /**
   * Close a withdrawal that is not going to be paid.
   *
   * **This exists because a refusal has to be recordable, and because a request
   * that cannot be closed is money an investor can never get at again.** Every
   * status short of `paid` and `rejected` counts as in flight: `openWithdrawnPoisha`
   * sums `requested`, `reviewed` and `approved`, and `headroomFor` subtracts that
   * from the position. So a request nobody intends to pay silently reduces what its
   * own investor may ever withdraw, by its own amount, for ever.
   *
   * The gap it closes is the approvals module's: an executor runs only on
   * `approved`, so a checker who **rejects** an `investor_withdrawal` decides the
   * approval and leaves this row at `reviewed`. Until that hook exists (handed over
   * as an integration line), this is how the row is closed — by a person, audited,
   * with the same `update Investor` the review needed. 0060 allows `requested →
   * rejected` and `reviewed → rejected` and nothing else, so a paid withdrawal can
   * never be rejected after the fact.
   */
  async reject(
    context: ActiveContext,
    request: AuditableRequest,
    withdrawalId: string,
    reason: string | undefined,
  ): Promise<WithdrawalView> {
    return mapInvestorErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const row = await repo.withdrawalById(tx, context.orgId, withdrawalId, true);
        if (row === undefined) {
          throw investorsHttpError('INVESTOR_NOT_FOUND', 'No such withdrawal.');
        }
        if (row.status === 'rejected') return serialized(context, row);
        if (row.status === 'paid') {
          throw investorsHttpError(
            'INVESTOR_WITHDRAWAL_FROZEN',
            'That withdrawal has been paid. A payment is undone by a reversal, not by a rejection.',
          );
        }
        if (row.status === 'approved') {
          // An approved withdrawal has a checker's decision behind it. Withdrawing
          // that decision is the checker's to make, not the finance team's — and
          // there is no route for it, deliberately.
          throw investorsHttpError(
            'INVESTOR_WITHDRAWAL_FROZEN',
            'That withdrawal is approved. Pay it, or reverse the approval first.',
          );
        }

        await repo.decideWithdrawal(tx, context.orgId, row.id, 'rejected');

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'investors.withdrawal.rejected',
          entityType: 'InvestorWithdrawal',
          entityId: row.id,
          before: { status: row.status },
          after: { status: 'rejected', reason: reason ?? null },
          requestId: context.requestId,
          request,
        });

        const rejected = await repo.withdrawalById(tx, context.orgId, row.id);
        if (rejected === undefined) {
          throw investorsHttpError('INVESTOR_NOT_FOUND', 'No such withdrawal.');
        }
        return serialized(context, rejected);
      }),
    );
  }

  /**
   * Step 4: pay an approved withdrawal, which is where the journal is written.
   *
   * The wallet is the one named at review and approved by a checker, not one
   * chosen here: "approve this payment" would mean nothing if the account could
   * change afterwards. The position is re-checked, because between the approval
   * and the payment another withdrawal may have been paid.
   */
  async pay(
    context: ActiveContext,
    request: AuditableRequest,
    withdrawalId: string,
    now: Date = new Date(),
  ): Promise<WithdrawalView> {
    return mapInvestorErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const row = await repo.withdrawalById(tx, context.orgId, withdrawalId, true);
        if (row === undefined) {
          throw investorsHttpError('INVESTOR_NOT_FOUND', 'No such withdrawal.');
        }
        if (row.status === 'paid') {
          // A double-clicked Pay answers with the row that exists. The journal's
          // idempotency key would have refused a second post anyway; this refuses
          // it a step earlier and without an error.
          return serialized(context, row);
        }
        if (row.status !== 'approved') {
          throw investorsHttpError(
            'APPROVAL_REQUIRED',
            `That withdrawal is ${row.status}; only an approved one can be paid.`,
          );
        }
        if (row.wallet_account_id === null) {
          throw investorsHttpError(
            'LEDGER_ACCOUNT_NOT_FOUND',
            'That withdrawal names no wallet to pay from.',
          );
        }

        const kind: WithdrawalPaymentKind = row.kind === 'capital' ? 'capital' : 'profit';
        const amount = poisha(row.amount_poisha);

        /*
         * The investor's lock, not only this row's.
         *
         * `for update of w` serialises two Pays of the *same* withdrawal; it does
         * nothing about two different approved withdrawals for the same investor
         * paid at the same instant. Both would read the pre-payment position, both
         * would pass this check, and the pair would drive the equity or the payable
         * the wrong way — which neither the ledger nor the database would refuse,
         * because a negative balance is a legitimate thing for an account to hold.
         */
        await repo.lockInvestor(tx, context.orgId, row.investor_id);
        const position = await this.investors.positionOf(tx, context, row.investor_id);
        assertWithdrawable(position, kind, amount);

        const wallet = await repo.accountById(tx, context.orgId, row.wallet_account_id);
        if (wallet === undefined || !isAccountSubtype(wallet.subtype)) {
          throw investorsHttpError('LEDGER_ACCOUNT_NOT_FOUND', 'No such wallet account.');
        }
        if (!wallet.is_active) {
          throw investorsHttpError('LEDGER_ACCOUNT_INVALID', `${wallet.code} is inactive.`);
        }

        const debitSubtype = WITHDRAWAL_DEBIT_SUBTYPE[kind];
        const debit = await repo.accountBySubtype(tx, context.orgId, debitSubtype);
        if (debit === undefined || !isAccountSubtype(debit.subtype)) {
          throw investorsHttpError(
            'LEDGER_ACCOUNT_NOT_FOUND',
            `This organization has no ${debitSubtype} account.`,
          );
        }

        const posted = await this.ledger.post(
          tx,
          { orgId: context.orgId, userId: context.userId },
          investorPaymentDraft({
            withdrawalId: row.id,
            investorId: row.investor_id,
            kind,
            occurredAt: now,
            debit: {
              accountId: debit.id,
              subtype: debit.subtype,
              branchId: debit.branch_id,
            },
            wallet: {
              accountId: wallet.id,
              subtype: wallet.subtype,
              branchId: wallet.branch_id,
            },
            amountPoisha: amount,
            memo: row.reason,
          }),
        );

        await repo.payWithdrawal(tx, context.orgId, row.id, {
          journalId: posted.journalId,
          paidOn: posted.businessDate,
          paidBy: context.userId,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'investors.withdrawal.paid',
          entityType: 'InvestorWithdrawal',
          entityId: row.id,
          before: { status: 'approved', journalId: null },
          after: {
            status: 'paid',
            journalId: posted.journalId,
            paidOn: posted.businessDate,
            walletAccountId: wallet.id,
            amountPoisha: amount.toString(),
          },
          requestId: context.requestId,
          request,
        });

        const paid = await repo.withdrawalById(tx, context.orgId, row.id);
        if (paid === undefined) {
          throw investorsHttpError('INVESTOR_NOT_FOUND', 'No such withdrawal.');
        }
        return serialized(context, paid);
      }),
    );
  }

  /**
   * Step 3: the checker's decision, run inside the approving transaction.
   *
   * It moves the row to `approved` and posts nothing. The payment is a separate,
   * deliberate act — see the note at the top of this file.
   */
  private readonly executeWithdrawal: ApprovalExecutor = async (
    tx,
    { context, approval, request },
  ) => {
    const parsed = withdrawalPayloadSchema.safeParse(approval.payload);
    // A payload this module did not write is not this module's business: the type
    // is also reachable through the generic `POST /v1/approvals`, and an executor
    // that threw on those would make every such approval fail at the moment of
    // decision.
    if (!parsed.success) return;

    await mapInvestorErrors(async () => {
      const row = await repo.withdrawalById(tx, context.orgId, parsed.data.withdrawalId, true);
      /*
       * Past this point the payload *does* name a withdrawal, so silence is the
       * wrong answer. It used to `return`, which meant a checker who approved
       * "৳5,00,000 to an investor" got a 201 and nothing happened — indistinguishable
       * from a payment that was authorised. The ledger's own `period_reopen`
       * executor refuses the same way, and for the same reason (M03 security review).
       */
      if (row === undefined) {
        throw investorsHttpError(
          'INVESTOR_NOT_FOUND',
          'This request names no withdrawal in this organization. Reject it and raise a new one.',
        );
      }
      if (row.approval_request_id !== approval.id) {
        throw investorsHttpError(
          'INVESTOR_WITHDRAWAL_FROZEN',
          'That withdrawal is being decided by a different approval. Reject this one.',
        );
      }
      if (row.status !== 'reviewed') {
        throw investorsHttpError(
          'INVESTOR_WITHDRAWAL_FROZEN',
          `That withdrawal is ${row.status}; only a reviewed one is waiting for a decision.`,
        );
      }

      /*
       * **Three people, not two.** The approvals module keeps the decider apart from
       * whoever raised the *approval* — the reviewer — and 0058 keeps the reviewer
       * apart from whoever asked. Neither compares the decider with the requester,
       * so A-requests → B-reviews → A-approves was allowed: two of the three
       * signatures on money leaving to an owner would be the same hand.
       */
      if (context.userId === row.requested_by) {
        throw investorsHttpError(
          'FORBIDDEN',
          'A withdrawal cannot be approved by whoever asked for it.',
        );
      }
      if (context.userId === row.reviewed_by) {
        throw investorsHttpError(
          'FORBIDDEN',
          'A withdrawal cannot be approved by whoever reviewed it.',
        );
      }

      // The approval's amount, and nothing else, for money (D-078).
      const amount = approval.amountPoisha;
      if (amount === null || amount !== BigInt(row.amount_poisha)) {
        throw investorsHttpError(
          'IDEMPOTENCY_CONFLICT',
          'That approval is for a different amount than the withdrawal it names.',
        );
      }

      await repo.decideWithdrawal(tx, context.orgId, row.id, 'approved');

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'investors.withdrawal.approved',
        entityType: 'InvestorWithdrawal',
        entityId: row.id,
        before: { status: 'reviewed' },
        after: { status: 'approved', approvalId: approval.id, amountPoisha: amount.toString() },
        requestId: context.requestId,
        ...(request === undefined ? {} : { request }),
      });
    });
  };
}
