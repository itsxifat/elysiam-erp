import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import {
  businessDate,
  cashInDraft,
  cashOutDraft,
  idempotencyKey,
  isAccountSubtype,
  poisha,
  subtypeInfo,
  type AccountSubtype,
  type JournalDraft,
} from '@elysium/domain';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ApprovalsService, type ApprovalExecutor } from '../approvals/approvals.service.js';
import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import * as repo from './wallets.repository.js';
import { mapWalletErrors, walletsHttpError } from './wallets.errors.js';
import type { CashEntryInput } from './wallets.schemas.js';

/**
 * Cash in, cash out and petty cash (architecture §7 posting rules; §6 "cash
 * entries, petty cash").
 *
 * Three things here are the milestone's checks rather than plumbing:
 *
 * 1. **Petty cash without a receipt is refused** (check 2), and the receipt has
 *    to be a *private*, stored file of the petty-cash purpose. Refused in three
 *    places — the Zod schema, this service, and a CHECK plus a trigger in
 *    migrations 0027 and 0029 — because the service is the layer most likely to
 *    be bypassed by the next caller and the least likely to be noticed doing it.
 * 2. **Above the org's threshold, nothing is posted.** The entry is recorded
 *    `pending_approval` with no journal at all, so it is in no report and no
 *    balance until a checker decides it. Posting first and reversing on rejection
 *    would leave two journals in the day book for an expense that never happened.
 * 3. **The business date is the Asia/Dhaka date of the server's clock** at the
 *    time the entry is made, not the client's, and not the approval's. A
 *    Tuesday-approved Monday expense belongs to Monday's P&L.
 */

/** What a `wallet_adjustment` payload must say for this module to act on it. */
const pettyCashPayloadSchema = z
  .object({ cashEntryId: z.string().uuid(), walletId: z.string().uuid() })
  .strict();

export interface CashEntryResult {
  readonly entryId: string;
  readonly status: 'posted' | 'pending_approval';
  readonly journalId: string | null;
  readonly approvalId: string | null;
  readonly businessDate: string;
  readonly amountPoisha: string;
}

@Injectable()
export class CashService implements OnModuleInit {
  constructor(
    @Inject(LEDGER_API) private readonly ledger: LedgerApi,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.approvals.registerExecutor('wallet_adjustment', this.executePettyCash);
  }

  async record(
    context: ActiveContext,
    request: AuditableRequest,
    input: CashEntryInput,
    now: Date = new Date(),
  ): Promise<CashEntryResult> {
    const amount = poisha(input.amountPoisha);

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const wallet = await this.walletFor(tx, context, request, input.walletId);
      const category = await this.categoryFor(tx, context, input, wallet);
      await this.assertReceipt(tx, context, input);

      // A retried submit — the same client-generated entry id — answers from the
      // row that exists rather than posting a second journal.
      const existing = await repo.cashEntryById(tx, context.orgId, input.entryId);
      if (existing !== undefined) return this.replay(existing, input, amount);

      const occurredAt = now;
      const draft = this.draftFor(input, wallet, category, amount, occurredAt);

      // Petty cash is the only kind that goes through maker-checker: §6's
      // maker-checker list names "wallet adjustments", and a cash in from a known
      // income category or a cash out booked by the finance team is ordinary
      // bookkeeping. The amount is the requester's, so it is compared against the
      // org's threshold rather than trusted (D-068).
      const needsApproval =
        input.kind === 'petty_cash' &&
        (await this.approvals.isRequired(context, {
          type: 'wallet_adjustment',
          amountPoisha: amount,
        }));

      if (needsApproval) {
        return this.hold(tx, context, request, input, wallet, amount, occurredAt, draft);
      }

      const posted = await this.ledger.post(
        tx,
        { orgId: context.orgId, userId: context.userId },
        draft,
      );

      await repo.insertCashEntry(tx, {
        orgId: context.orgId,
        id: input.entryId,
        walletId: wallet.id,
        branchId: wallet.branch_id,
        kind: input.kind,
        status: 'posted',
        categoryAccountId: category.id,
        amountPoisha: amount,
        occurredAt,
        businessDate: posted.businessDate,
        memo: input.memo ?? null,
        receiptFileId: input.receiptFileId ?? null,
        approvalRequestId: null,
        journalId: posted.journalId,
        createdBy: context.userId,
      });

      await this.auditEntry(tx, context, request, input, {
        status: 'posted',
        journalId: posted.journalId,
        businessDate: posted.businessDate,
        amount,
      });

      return {
        entryId: input.entryId,
        status: 'posted',
        journalId: posted.journalId,
        approvalId: null,
        businessDate: posted.businessDate,
        amountPoisha: amount.toString(),
      };
    });
  }

  /** The entries the caller may see, newest first. */
  async list(
    context: ActiveContext,
    request: object,
    query: {
      readonly from?: string | undefined;
      readonly to: string;
      readonly walletId?: string | undefined;
      readonly status?: string | undefined;
    },
  ) {
    const scope = scopeWhere(request, { branchId: sql`e.branch_id` });
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => ({
      items: (
        await repo.listCashEntries(tx, context.orgId, {
          scope,
          from: query.from,
          to: query.to,
          walletId: query.walletId,
          status: query.status,
          limit: 500,
        })
      ).map((row) => ({
        id: row.id,
        walletId: row.wallet_id,
        branchId: row.branch_id,
        kind: row.kind,
        status: row.status,
        categoryAccountId: row.category_account_id,
        categoryCode: row.category_code,
        categoryName: row.category_name,
        amountPoisha: row.amount_poisha,
        businessDate: row.business_date,
        memo: row.memo,
        /*
         * The id only, never a URL. A signed URL is a bearer token: once it
         * exists it works for whoever holds it, so it is minted by the files
         * module after that module has authorized this caller for this purpose
         * (§22, D-115). Putting one in a list response would authorize every
         * receipt in the list to anybody who could read the list.
         */
        receiptFileId: row.receipt_file_id,
        approvalRequestId: row.approval_request_id,
        journalId: row.journal_id,
      })),
    }));
  }

  // --- the approval path -----------------------------------------------------

  /** Record the entry as waiting, with its approval, and post nothing. */
  private async hold(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    input: CashEntryInput,
    wallet: repo.WalletRow,
    amount: bigint,
    occurredAt: Date,
    draft: JournalDraft,
  ): Promise<CashEntryResult> {
    const raised = await this.approvals.request(context, {
      type: 'wallet_adjustment',
      amountPoisha: amount,
      payload: { cashEntryId: input.entryId, walletId: wallet.id },
      reason: input.memo ?? 'Petty cash',
      ...(wallet.branch_id === null ? {} : { branchId: wallet.branch_id }),
      request,
    });

    await repo.insertCashEntry(tx, {
      orgId: context.orgId,
      id: input.entryId,
      walletId: wallet.id,
      branchId: wallet.branch_id,
      kind: input.kind,
      status: 'pending_approval',
      categoryAccountId: input.categoryAccountId.toLowerCase(),
      amountPoisha: amount,
      occurredAt,
      businessDate: draft.businessDate,
      memo: input.memo ?? null,
      receiptFileId: input.receiptFileId ?? null,
      approvalRequestId: raised.id,
      journalId: null,
      createdBy: context.userId,
    });

    await this.auditEntry(tx, context, request, input, {
      status: 'pending_approval',
      journalId: null,
      businessDate: draft.businessDate,
      amount,
    });

    return {
      entryId: input.entryId,
      status: 'pending_approval',
      journalId: null,
      approvalId: raised.id,
      businessDate: draft.businessDate,
      amountPoisha: amount.toString(),
    };
  }

  /**
   * Post a petty-cash entry a checker has just approved, inside the approving
   * transaction.
   *
   * **A payload this module did not write is left alone.** `wallet_adjustment` is
   * also raised through the generic `POST /v1/approvals` route by accounts and by
   * branch managers — §6's maker-checker list has had that type since M02b — and
   * those requests carry whatever payload the requester typed. An executor that
   * threw on them would make every existing wallet-adjustment approval fail at the
   * moment of decision. So the payload is parsed, and a request that does not name
   * a waiting cash entry of this org is not this module's business.
   */
  private readonly executePettyCash: ApprovalExecutor = async (
    tx,
    { context, approval, request },
  ) => {
    const parsed = pettyCashPayloadSchema.safeParse(approval.payload);
    if (!parsed.success) return;

    const entry = await repo.cashEntryById(tx, context.orgId, parsed.data.cashEntryId, true);
    if (entry?.status !== 'pending_approval') return;
    // The approval that decided this entry must be the approval on the entry.
    // Otherwise a second wallet_adjustment naming somebody else's waiting entry
    // would post it.
    if (entry.approval_request_id !== approval.id) return;

    await mapWalletErrors(async () => {
      const wallet = await repo.walletById(tx, context.orgId, entry.wallet_id);
      const category = await repo.accountById(tx, context.orgId, entry.category_account_id);
      if (wallet === undefined || category === undefined) {
        throw walletsHttpError('LEDGER_ACCOUNT_NOT_FOUND', 'That entry names a missing account.');
      }
      if (!isAccountSubtype(wallet.subtype) || !isAccountSubtype(category.subtype)) {
        throw walletsHttpError('LEDGER_ACCOUNT_INVALID', 'That entry names an unknown subtype.');
      }

      // The **approval's** amount, not the row's (D-078). They are the same row
      // and the same number, and the rule is that an executor reads
      // `amountPoisha` and nothing else for money — so that a payload can never
      // carry an amount of its own past the threshold that was checked.
      const amount = approval.amountPoisha;
      if (amount === null || amount !== BigInt(entry.amount_poisha)) {
        throw walletsHttpError(
          'IDEMPOTENCY_CONFLICT',
          'That approval is for a different amount than the entry it names.',
        );
      }

      const posted = await this.ledger.post(
        tx,
        { orgId: context.orgId, userId: context.userId },
        {
          ...cashOutDraft({
            entryId: entry.id,
            kind: entry.kind === 'petty_cash' ? 'petty_cash' : 'cash_out',
            // The date the money left, recovered from the row, so the approval's own
            // date does not move the expense into a later period.
            occurredAt: new Date(entry.occurred_at),
            wallet: {
              accountId: wallet.ledger_account_id,
              subtype: wallet.subtype,
              branchId: wallet.branch_id,
            },
            expense: {
              accountId: category.id,
              subtype: category.subtype,
              branchId: category.branch_id,
            },
            amountPoisha: poisha(amount),
            memo: entry.memo,
          }),
        },
      );

      await repo.settleCashEntry(tx, context.orgId, entry.id, {
        status: 'posted',
        journalId: posted.journalId,
      });

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'wallets.cash_entry.approved',
        entityType: 'CashEntry',
        entityId: entry.id,
        before: { status: 'pending_approval', journalId: null },
        after: {
          status: 'posted',
          journalId: posted.journalId,
          approvalId: approval.id,
          amountPoisha: amount.toString(),
        },
        requestId: context.requestId,
        ...(request === undefined ? {} : { request }),
      });
    });
  };

  // --- resolution and refusals ----------------------------------------------

  private async walletFor(
    tx: Tx,
    context: ActiveContext,
    request: object,
    walletId: string,
  ): Promise<repo.WalletRow> {
    const wallet = await repo.walletById(tx, context.orgId, walletId);
    // Another org's wallet, a deleted one and a nonexistent uuid are one answer:
    // RLS has already made the first two the same, and a different message for
    // the third would be a way to test uuids for existence.
    if (wallet === undefined || !isAccountSubtype(wallet.subtype)) {
      throw walletsHttpError('LEDGER_ACCOUNT_NOT_FOUND', 'No such wallet.');
    }
    // §6 gives branch_manager `update Wallet` at `branch` scope. Out of scope must
    // answer the same as missing, or the error enumerates other branches' tills.
    try {
      assertInScope(request, { branchId: wallet.branch_id });
    } catch {
      throw walletsHttpError('LEDGER_ACCOUNT_NOT_FOUND', 'No such wallet.');
    }
    if (!wallet.is_active) {
      throw walletsHttpError('WALLET_INACTIVE', 'That wallet is closed.');
    }
    return wallet;
  }

  private async categoryFor(
    tx: Tx,
    context: ActiveContext,
    input: CashEntryInput,
    wallet: repo.WalletRow,
  ): Promise<repo.CategoryRow> {
    const category = await repo.accountById(tx, context.orgId, input.categoryAccountId);
    if (category === undefined || !isAccountSubtype(category.subtype)) {
      throw walletsHttpError('LEDGER_ACCOUNT_NOT_FOUND', 'No such category.');
    }
    if (!category.is_active) {
      throw walletsHttpError('LEDGER_ACCOUNT_INVALID', `Category ${category.code} is inactive.`);
    }
    // Which subtypes are allowed is the posting rule's decision, not this
    // service's, so it is not restated here — `cashInDraft` and `cashOutDraft`
    // refuse anything else and this exists to fail before the draft is built with
    // a message naming the account. The one thing checked here is the direction,
    // because the two rules would each give a confusing answer to the other's
    // input.
    const wantsIncome = input.kind === 'cash_in';
    if (wantsIncome !== (subtypeInfo(category.subtype).class === 'income')) {
      throw walletsHttpError(
        'LEDGER_ACCOUNT_INVALID',
        wantsIncome
          ? `Cash in is credited to an income category; ${category.code} is not one.`
          : `Cash out is charged to an expense category; ${category.code} is not one.`,
      );
    }
    void wallet;
    return category;
  }

  /**
   * A petty-cash receipt must exist, be stored, be of the petty-cash purpose and
   * be **private** (check 2).
   *
   * The purpose is checked because it is what the files module authorizes a
   * download against: a receipt uploaded as a `product-image` would be readable by
   * every role with `read Catalog`, which is everyone. The private check is here
   * as well as in the trigger so the refusal can say why.
   */
  private async assertReceipt(
    tx: Tx,
    context: ActiveContext,
    input: CashEntryInput,
  ): Promise<void> {
    if (input.kind === 'petty_cash' && input.receiptFileId === undefined) {
      throw walletsHttpError('RECEIPT_REQUIRED', 'Petty cash needs a receipt photo.');
    }
    if (input.receiptFileId === undefined) return;

    const file = await repo.receiptFile(tx, context.orgId, input.receiptFileId);
    if (file?.status !== 'stored') {
      throw walletsHttpError('RECEIPT_REQUIRED', 'That receipt has not finished uploading.');
    }
    if (file.purpose !== 'petty-cash-receipt') {
      throw walletsHttpError(
        'RECEIPT_REQUIRED',
        'Upload the receipt with the petty-cash-receipt purpose, so only the right roles can read it.',
      );
    }
    if (file.visibility !== 'private') {
      throw walletsHttpError('RECEIPT_REQUIRED', 'A receipt must be a private file (§22).');
    }
    // One receipt, one entry, and the person recording it is the one who
    // photographed it. Without these, one ৳250 slip could stand behind any number
    // of petty-cash entries each under the approval threshold (ledger audit W2).
    // A retry of the same entry finds itself and passes. The unique index on
    // `cash_entries (org_id, receipt_file_id)` is the floor under the first check.
    if (file.used_by_entry_id !== null && file.used_by_entry_id !== input.entryId) {
      throw walletsHttpError(
        'RECEIPT_ALREADY_USED',
        'That receipt is already the evidence for another cash entry. Each entry needs its own.',
      );
    }
    if (file.owner_user_id !== context.userId) {
      throw walletsHttpError('RECEIPT_REQUIRED', 'Attach a receipt you uploaded yourself.');
    }
  }

  private draftFor(
    input: CashEntryInput,
    wallet: repo.WalletRow,
    category: repo.CategoryRow,
    amount: bigint,
    occurredAt: Date,
  ): JournalDraft {
    const walletSide = {
      accountId: wallet.ledger_account_id,
      subtype: wallet.subtype as AccountSubtype,
      branchId: wallet.branch_id,
    };
    const categorySide = {
      accountId: category.id,
      subtype: category.subtype as AccountSubtype,
      branchId: category.branch_id,
    };

    if (input.kind === 'cash_in') {
      return cashInDraft({
        entryId: input.entryId,
        occurredAt,
        wallet: walletSide,
        income: categorySide,
        amountPoisha: poisha(amount),
        memo: input.memo ?? null,
      });
    }
    return cashOutDraft({
      entryId: input.entryId,
      kind: input.kind,
      occurredAt,
      wallet: walletSide,
      expense: categorySide,
      amountPoisha: poisha(amount),
      memo: input.memo ?? null,
    });
  }

  /** A retry of an entry that already exists, if it says the same thing. */
  private replay(
    existing: repo.CashEntryRow,
    input: CashEntryInput,
    amount: bigint,
  ): CashEntryResult {
    const same =
      existing.kind === input.kind &&
      existing.wallet_id === input.walletId.toLowerCase() &&
      existing.category_account_id === input.categoryAccountId.toLowerCase() &&
      BigInt(existing.amount_poisha) === amount;
    if (!same) {
      throw walletsHttpError(
        'IDEMPOTENCY_CONFLICT',
        'That entry id was already used for a different cash entry.',
      );
    }
    if (existing.status === 'rejected') {
      throw walletsHttpError(
        'IDEMPOTENCY_CONFLICT',
        'That entry was rejected. Raise a new one with a new id.',
      );
    }
    return {
      entryId: existing.id,
      status: existing.status === 'posted' ? 'posted' : 'pending_approval',
      journalId: existing.journal_id,
      approvalId: existing.approval_request_id,
      businessDate: existing.business_date,
      amountPoisha: existing.amount_poisha,
    };
  }

  private async auditEntry(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    input: CashEntryInput,
    outcome: {
      readonly status: string;
      readonly journalId: string | null;
      readonly businessDate: string;
      readonly amount: bigint;
    },
  ): Promise<void> {
    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'create',
      action: `wallets.${input.kind}`,
      entityType: 'CashEntry',
      entityId: input.entryId,
      before: null,
      after: {
        walletId: input.walletId,
        categoryAccountId: input.categoryAccountId,
        amountPoisha: outcome.amount.toString(),
        businessDate: outcome.businessDate,
        status: outcome.status,
        journalId: outcome.journalId,
        receiptFileId: input.receiptFileId ?? null,
        idempotencyKey: idempotencyKey(
          input.kind === 'cash_in' ? 'cash_in' : input.kind,
          input.entryId,
          input.kind === 'cash_in' ? 'received' : 'paid',
        ),
      },
      requestId: context.requestId,
      request,
    });
  }
}

/** Exported for the tests: today's Asia/Dhaka date, as the service computes it. */
export const todayInDhaka = (): string => businessDate(new Date());
