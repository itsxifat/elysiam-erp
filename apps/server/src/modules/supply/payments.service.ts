import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { canReadCost } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import {
  advanceAppliedDraft,
  businessDate,
  isAccountSubtype,
  poisha,
  supplierAdvancePaidDraft,
  supplierPaidDraft,
  type AccountSubtype,
} from '@elysium/domain';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ApprovalsService, type ApprovalExecutor } from '../approvals/approvals.service.js';
import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import * as repo from './supply.repository.js';
import { mapSupplyErrors, SupplyError } from './supply.errors.js';
import type {
  ApplyAdvanceInput,
  PaymentListQuery,
  SupplierPaymentInput,
} from './supply.schemas.js';

/**
 * Supplier advances, payments and applying an advance to a supply (architecture §7).
 *
 * Three journals, all three from `packages/domain/src/posting/supplier-payment.ts`:
 *
 *     advance   Dr Supplier advance / Cr W
 *     payment   Dr Supplier payable / Cr W
 *     applied   Dr Supplier payable / Cr Supplier advance
 *
 * ## Above the threshold, nothing is posted
 *
 * §6's maker-checker list routes "supplier payments above the threshold" through
 * approvals. The row is written `pending_approval` with **no journal at all**, so it is
 * in no report, no balance and no supplier statement until a checker decides it.
 * Posting first and reversing on rejection would leave two journals in the day book for
 * money that never left the bank — and a supplier statement that, for a week, said the
 * brand had paid.
 *
 * The executor is what posts it, inside the transaction that approved it, so the
 * decision and the payment commit together. It reads `approval.amountPoisha` and
 * nothing else for money (D-078) and refuses to act unless the approval it was handed
 * is the approval named on the row — otherwise a second `supplier_payment` request
 * could name somebody else's waiting payment and release it.
 *
 * ## Applying an advance moves no cash, and that is why it is separate
 *
 * The receipt credits the payable for what the invoice says, whatever was paid in
 * advance; this then cancels the two balances against each other. Netting inside the
 * receipt would post a payable that does not match the supplier's own invoice, and the
 * first reconciliation against their statement would be unexplainable.
 */

/**
 * What a `supplier_payment` payload must say for this module to act on it.
 *
 * No amount, at any depth: `approvalRequestSchema` refuses a payload with a
 * money-shaped key (D-078), because a second amount is a second thing the executor
 * could pay instead of the one the checker approved.
 */
const paymentPayloadSchema = z
  .object({ paymentId: z.string().uuid(), supplierId: z.string().uuid() })
  .strict();

export interface PaymentResult {
  readonly paymentId: string;
  readonly status: 'posted' | 'pending_approval';
  readonly journalId: string | null;
  readonly approvalId: string | null;
  readonly businessDate: string;
  readonly amountPoisha: string;
}

@Injectable()
export class PaymentsService implements OnModuleInit {
  constructor(
    @Inject(LEDGER_API) private readonly ledger: LedgerApi,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.approvals.registerExecutor('supplier_payment', this.executePayment);
  }

  async list(context: ActiveContext, request: object, query: PaymentListQuery) {
    const scope = scopeWhere(request, { branchId: sql`p.branch_id` });
    return mapSupplyErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const rows = await repo.listPayments(tx, context.orgId, {
          scope,
          supplierId: query.supplierId,
          kind: query.kind,
          status: query.status,
          from: query.from,
          to: query.to,
        });
        return {
          items: rows.map((row) => ({
            id: row.id,
            supplierId: row.supplier_id,
            supplierName: row.supplier_name,
            walletAccountId: row.wallet_account_id,
            walletCode: row.wallet_code,
            walletName: row.wallet_name,
            branchId: row.branch_id,
            kind: row.kind,
            status: row.status,
            amountPoisha: row.amount_poisha,
            /** How much of an advance is already set against a supply. */
            appliedPoisha: row.applied_poisha,
            businessDate: row.business_date,
            memo: row.memo,
            approvalRequestId: row.approval_request_id,
            journalId: row.journal_id,
          })),
        };
      }),
    );
  }

  async pay(
    context: ActiveContext,
    request: AuditableRequest,
    input: SupplierPaymentInput,
    now: Date = new Date(),
  ): Promise<PaymentResult> {
    this.assertMayHandleSupplierMoney(context);
    const amount = poisha(input.amountPoisha);
    const occurredAt = input.occurredAt === undefined ? now : new Date(input.occurredAt);
    const date = businessDate(occurredAt);

    const replay = await mapSupplyErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const existing = await repo.paymentById(tx, context.orgId, input.paymentId);
        if (existing === undefined) return null;
        if (existing.status === 'rejected') {
          throw new SupplyError(
            'IDEMPOTENCY_CONFLICT',
            'That payment was rejected. Raise a new one with a new id.',
          );
        }
        if (BigInt(existing.amount_poisha) !== amount) {
          throw new SupplyError(
            'IDEMPOTENCY_CONFLICT',
            'That payment id was already used for a different amount.',
          );
        }
        return {
          paymentId: existing.id,
          status:
            existing.status === 'posted' ? ('posted' as const) : ('pending_approval' as const),
          journalId: existing.journal_id,
          approvalId: existing.approval_request_id,
          businessDate: existing.business_date,
          amountPoisha: existing.amount_poisha,
        };
      }),
    );
    if (replay !== null) return replay;

    // §6 routes supplier payments above the org's threshold through a checker. The
    // amount is the requester's, so it is compared against the threshold rather than
    // trusted (D-068) — `amountDerivedByServer` is deliberately not passed.
    const needsApproval = await this.approvals.isRequired(context, {
      type: 'supplier_payment',
      amountPoisha: amount,
    });

    if (needsApproval) {
      /*
       * Raised before the row is written, in the approvals module's own transaction.
       *
       * `request()` opens its own `withOrg`, so nesting it inside this module's
       * transaction would not join it — it would deadlock against the row we are about
       * to insert. Raised first instead, which leaves one residual: a crash between the
       * two commits leaves an approval with no payment. That approval can never do
       * anything, because the executor refuses unless the payment it names carries the
       * approval's own id, so the cost of the residual is a row in a checker's queue.
       */
      const raised = await this.approvals.request(context, {
        type: 'supplier_payment',
        amountPoisha: amount,
        payload: { paymentId: input.paymentId, supplierId: input.supplierId },
        reason: input.memo ?? `Supplier ${input.kind}`,
        request,
      });

      return mapSupplyErrors(async () =>
        withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
          await this.assertWalletInScope(tx, context, request, input.walletAccountId);
          await repo.insertPayment(tx, {
            orgId: context.orgId,
            id: input.paymentId,
            supplierId: input.supplierId,
            walletAccountId: input.walletAccountId,
            kind: input.kind,
            status: 'pending_approval',
            amountPoisha: amount,
            occurredAt,
            businessDate: date,
            memo: input.memo ?? null,
            approvalRequestId: raised.id,
            journalId: null,
            createdBy: context.userId,
          });

          await this.auditPayment(tx, context, request, input.paymentId, {
            kind: input.kind,
            status: 'pending_approval',
            approvalId: raised.id,
            journalId: null,
            amountPoisha: amount.toString(),
          });

          return {
            paymentId: input.paymentId,
            status: 'pending_approval' as const,
            journalId: null,
            approvalId: raised.id,
            businessDate: date,
            amountPoisha: amount.toString(),
          };
        }),
      );
    }

    return mapSupplyErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const wallet = await this.assertWalletInScope(tx, context, request, input.walletAccountId);
        const journalId = await this.postPayment(tx, context, {
          paymentId: input.paymentId,
          supplierId: input.supplierId,
          kind: input.kind,
          amountPoisha: amount,
          occurredAt,
          memo: input.memo ?? null,
          wallet,
        });

        await repo.insertPayment(tx, {
          orgId: context.orgId,
          id: input.paymentId,
          supplierId: input.supplierId,
          walletAccountId: input.walletAccountId,
          kind: input.kind,
          status: 'posted',
          amountPoisha: amount,
          occurredAt,
          businessDate: date,
          memo: input.memo ?? null,
          approvalRequestId: null,
          journalId,
          createdBy: context.userId,
        });

        await this.auditPayment(tx, context, request, input.paymentId, {
          kind: input.kind,
          status: 'posted',
          approvalId: null,
          journalId,
          amountPoisha: amount.toString(),
        });

        return {
          paymentId: input.paymentId,
          status: 'posted' as const,
          journalId,
          approvalId: null,
          businessDate: date,
          amountPoisha: amount.toString(),
        };
      }),
    );
  }

  /** Set a posted advance against a received supply: Dr payable / Cr advance (§7). */
  async applyAdvance(
    context: ActiveContext,
    request: AuditableRequest,
    input: ApplyAdvanceInput,
    now: Date = new Date(),
  ) {
    this.assertMayHandleSupplierMoney(context);
    const amount = poisha(input.amountPoisha);

    return mapSupplyErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const already = await repo.advanceApplicationById(tx, context.orgId, input.applicationId);
        if (already !== undefined) {
          return {
            id: already.id,
            journalId: already.journal_id,
            amountPoisha: already.amount_poisha,
            created: false,
          };
        }

        const advance = await repo.advanceForUpdate(tx, context.orgId, input.paymentId);
        if (advance === undefined) {
          throw new SupplyError('SUPPLY_NOT_FOUND', 'No such supplier payment.');
        }
        if (advance.kind !== 'advance' || advance.status !== 'posted') {
          throw new SupplyError(
            'SUPPLY_ADVANCE_INVALID',
            'Only a posted advance can be applied to a supply.',
          );
        }
        const remaining = BigInt(advance.amount_poisha) - BigInt(advance.applied_poisha);
        if (amount > remaining) {
          throw new SupplyError(
            'SUPPLY_ADVANCE_INVALID',
            `That advance holds only ${remaining.toString()} poisha unapplied.`,
          );
        }

        const entry = await repo.supplyById(tx, context.orgId, input.supplyId);
        if (entry === undefined) throw new SupplyError('SUPPLY_NOT_FOUND', 'No such supply entry.');
        assertInScope(request, { branchId: entry.branch_id });
        if (entry.status !== 'received') {
          throw new SupplyError(
            'SUPPLY_ADVANCE_INVALID',
            'An advance is applied to a received supply, not to a draft.',
          );
        }
        if (entry.supplier_id !== advance.supplier_id) {
          throw new SupplyError(
            'SUPPLY_ADVANCE_INVALID',
            'That advance belongs to a different supplier.',
          );
        }

        const [payable, advanceAccount] = await Promise.all([
          this.account(tx, context.orgId, 'supplier_payable'),
          this.account(tx, context.orgId, 'supplier_advance'),
        ]);

        const posted = await this.ledger.post(
          tx,
          { orgId: context.orgId, userId: context.userId },
          advanceAppliedDraft({
            applicationId: input.applicationId,
            occurredAt: now,
            payable,
            advance: advanceAccount,
            supplierId: advance.supplier_id,
            amountPoisha: amount,
            branchId: entry.branch_id,
            memo: `Advance applied to supply ${input.supplyId}`,
          }),
        );

        await repo.insertAdvanceApplication(tx, {
          orgId: context.orgId,
          id: input.applicationId,
          supplierId: advance.supplier_id,
          paymentId: input.paymentId,
          supplyId: input.supplyId,
          amountPoisha: amount,
          businessDate: posted.businessDate,
          journalId: posted.journalId,
          createdBy: context.userId,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'supply.advance.applied',
          entityType: 'SupplierAdvanceApplication',
          entityId: input.applicationId,
          before: null,
          after: {
            paymentId: input.paymentId,
            supplyId: input.supplyId,
            journalId: posted.journalId,
            amountPoisha: amount.toString(),
          },
          requestId: context.requestId,
          request,
        });

        return {
          id: input.applicationId,
          journalId: posted.journalId,
          amountPoisha: amount.toString(),
          created: true,
        };
      }),
    );
  }

  /**
   * Post the approved payment, inside the transaction that approved it.
   *
   * Refuses rather than returns quietly when the numbers disagree: an approval whose
   * amount is not the row's amount means one of the two was changed after the checker
   * read it, which migration 0037's freeze trigger already prevents — and a mismatch
   * surviving both would be the maker-checker bypass itself.
   */
  private readonly executePayment: ApprovalExecutor = async (
    tx,
    { context, approval, request },
  ) => {
    const parsed = paymentPayloadSchema.safeParse(approval.payload);
    if (!parsed.success) return;

    const payment = await repo.paymentById(tx, context.orgId, parsed.data.paymentId);
    if (payment?.status !== 'pending_approval') return;
    // The approval that decided this payment must be the approval on the payment.
    if (payment.approval_request_id !== approval.id) return;

    await mapSupplyErrors(async () => {
      const amount = approval.amountPoisha;
      if (amount === null || amount !== BigInt(payment.amount_poisha)) {
        throw new SupplyError(
          'SUPPLY_PAYMENT_FROZEN',
          'That approval does not carry the amount the payment was raised for.',
        );
      }

      const wallet = await repo.accountById(tx, context.orgId, payment.wallet_account_id);
      if (wallet === undefined || !isAccountSubtype(wallet.subtype)) {
        throw new SupplyError('LEDGER_ACCOUNT_NOT_FOUND', 'That payment names a missing wallet.');
      }

      const journalId = await this.postPayment(tx, context, {
        paymentId: payment.id,
        supplierId: payment.supplier_id,
        kind: payment.kind,
        amountPoisha: poisha(amount),
        occurredAt: new Date(payment.occurred_at),
        memo: payment.memo,
        wallet: {
          accountId: wallet.id,
          subtype: wallet.subtype,
          branchId: wallet.branch_id,
        },
      });

      await repo.settlePayment(tx, context.orgId, payment.id, { status: 'posted', journalId });

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'supply.payment.posted',
        entityType: 'SupplierPayment',
        entityId: payment.id,
        before: { status: 'pending_approval' },
        after: { status: 'posted', journalId, approvalId: approval.id },
        requestId: context.requestId,
        ...(request === undefined ? {} : { request }),
      });
    });
  };

  private async postPayment(
    tx: Tx,
    context: ActiveContext,
    payment: {
      readonly paymentId: string;
      readonly supplierId: string;
      readonly kind: 'advance' | 'payment';
      readonly amountPoisha: ReturnType<typeof poisha>;
      readonly occurredAt: Date;
      readonly memo: string | null;
      readonly wallet: {
        readonly accountId: string;
        readonly subtype: AccountSubtype;
        readonly branchId: string | null;
      };
    },
  ): Promise<string> {
    const subtype: AccountSubtype =
      payment.kind === 'advance' ? 'supplier_advance' : 'supplier_payable';
    const supplierAccount = await this.account(tx, context.orgId, subtype);

    const draft = {
      paymentId: payment.paymentId,
      occurredAt: payment.occurredAt,
      wallet: payment.wallet,
      supplierAccount,
      supplierId: payment.supplierId,
      amountPoisha: payment.amountPoisha,
      memo: payment.memo,
    };
    const posted = await this.ledger.post(
      tx,
      { orgId: context.orgId, userId: context.userId },
      payment.kind === 'advance' ? supplierAdvancePaidDraft(draft) : supplierPaidDraft(draft),
    );
    return posted.journalId;
  }

  /**
   * The wallet exists, is this org's, and is inside the caller's branch scope.
   *
   * Out of scope answers exactly as missing, the way M08 answers it: any other answer
   * is a way of enumerating other branches' tills.
   */
  private async assertWalletInScope(
    tx: Tx,
    context: ActiveContext,
    request: object,
    walletAccountId: string,
  ): Promise<{ accountId: string; subtype: AccountSubtype; branchId: string | null }> {
    const wallet = await repo.accountById(tx, context.orgId, walletAccountId);
    if (wallet === undefined || !isAccountSubtype(wallet.subtype) || !wallet.is_active) {
      throw new SupplyError('LEDGER_ACCOUNT_NOT_FOUND', 'No such wallet.');
    }
    try {
      assertInScope(request, { branchId: wallet.branch_id });
    } catch {
      throw new SupplyError('LEDGER_ACCOUNT_NOT_FOUND', 'No such wallet.');
    }
    return { accountId: wallet.id, subtype: wallet.subtype, branchId: wallet.branch_id };
  }

  /** One of §7's supplier accounts, or a clear refusal that the chart is broken. */
  private async account(
    tx: Tx,
    orgId: string,
    subtype: AccountSubtype,
  ): Promise<{ accountId: string; subtype: AccountSubtype; branchId: string | null }> {
    const row = await repo.accountBySubtype(tx, orgId, subtype);
    if (row === undefined) {
      // Seeded by the chart-of-accounts template (D-084). If it is missing the chart
      // is broken, and saying so beats posting the value somewhere else.
      throw new SupplyError(
        'LEDGER_ACCOUNT_NOT_FOUND',
        `This organization has no ${subtype} account.`,
      );
    }
    return { accountId: row.id, subtype, branchId: row.branch_id };
  }

  private async auditPayment(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    paymentId: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'create',
      action: 'supply.payment.recorded',
      entityType: 'SupplierPayment',
      entityId: paymentId,
      before: null,
      after,
      requestId: context.requestId,
      request,
    });
  }

  /**
   * Only a role that may see what the brand owes its suppliers may move that money.
   *
   * `read Cost` is the matrix cell that means exactly that set — super_admin, org_admin
   * and accounts — and it is the same set `REQUESTER_TYPES` allows to raise a
   * `supplier_payment` (D-122). The route declares it too; this is the second gate,
   * because the first one is a decorator and a route renamed or copied loses it.
   */
  private assertMayHandleSupplierMoney(context: ActiveContext): void {
    if (!canReadCost(context.roles, context.isSuperAdmin)) {
      throw new SupplyError('FORBIDDEN', 'Your role cannot move money to a supplier.');
    }
  }
}
