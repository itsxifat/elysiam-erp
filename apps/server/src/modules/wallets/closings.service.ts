import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import {
  aggregateBalanceOf,
  closingVarianceDraft,
  isAccountSubtype,
  poisha,
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
import * as repo from './wallets.repository.js';
import { mapWalletErrors, walletsHttpError } from './wallets.errors.js';
import type { CloseWalletInput } from './wallets.schemas.js';

/**
 * Daily closing: counted cash per wallet, and what to do about the difference
 * (architecture §6 maker-checker, §7 "Daily closing variance"; M08 check 4).
 *
 * Three properties, in the order they matter:
 *
 * 1. **The expected balance is derived here, not sent.** It is `Σ debit − Σ
 *    credit` over the wallet's journal lines up to the business date being
 *    closed. A client-supplied expectation would let anyone make a shortfall
 *    vanish by sending the number that makes the variance zero, which is the
 *    single most attractive thing to forge in this whole module.
 * 2. **A variance never posts by itself.** It raises a `closing_variance`
 *    approval and posts `Dr/Cr cash over/short` only through the executor below,
 *    inside the transaction that approved it. §6 gives that type to org_admin and
 *    to a branch manager under threshold, and deliberately **not** to accounts —
 *    the team that books the cash entries must not also sign off the shortfall.
 * 3. **The variance is the server's number, so the threshold means something.**
 *    `closing_variance` is in `SERVER_DERIVED_AMOUNT_TYPES`, which is what makes
 *    the generic approvals route hold one raised by a person; raised from here
 *    with `amountDerivedByServer`, the org's threshold decides whether a branch
 *    manager may sign it off (D-072, D-076).
 */

/** What a `closing_variance` payload must say for this module to act on it. */
const closingPayloadSchema = z
  .object({ closingId: z.string().uuid(), walletId: z.string().uuid() })
  .strict();

export interface ClosingResult {
  readonly closingId: string;
  readonly walletId: string;
  readonly businessDate: string;
  readonly expectedPoisha: string;
  readonly countedPoisha: string;
  readonly variancePoisha: string;
  readonly status: 'balanced' | 'pending_approval' | 'posted';
  readonly approvalId: string | null;
  readonly journalId: string | null;
}

@Injectable()
export class ClosingsService implements OnModuleInit {
  constructor(
    @Inject(LEDGER_API) private readonly ledger: LedgerApi,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.approvals.registerExecutor('closing_variance', this.executeVariance);
  }

  async close(
    context: ActiveContext,
    request: AuditableRequest,
    input: CloseWalletInput,
  ): Promise<ClosingResult> {
    const counted = poisha(input.countedPoisha);

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const wallet = await repo.walletById(tx, context.orgId, input.walletId);
      if (wallet === undefined || !isAccountSubtype(wallet.subtype)) {
        throw walletsHttpError('LEDGER_ACCOUNT_NOT_FOUND', 'No such wallet.');
      }
      try {
        assertInScope(request, { branchId: wallet.branch_id });
      } catch {
        throw walletsHttpError('LEDGER_ACCOUNT_NOT_FOUND', 'No such wallet.');
      }

      const already = await repo.closingById(tx, context.orgId, input.closingId);
      if (already !== undefined) return this.view(already);

      const expected = await this.expectedBalance(
        tx,
        context.orgId,
        wallet.ledger_account_id,
        input.businessDate,
      );
      const variance = counted - expected;

      if (variance === 0n) {
        await repo.insertClosing(tx, {
          orgId: context.orgId,
          id: input.closingId,
          walletId: wallet.id,
          branchId: wallet.branch_id,
          businessDate: input.businessDate,
          expectedPoisha: expected,
          countedPoisha: counted,
          variancePoisha: 0n,
          status: 'balanced',
          approvalRequestId: null,
          journalId: null,
          countedBy: context.userId,
        });
        await this.auditClose(tx, context, request, input, {
          expected,
          counted,
          variance,
          status: 'balanced',
        });
        return {
          closingId: input.closingId,
          walletId: wallet.id,
          businessDate: input.businessDate,
          expectedPoisha: expected.toString(),
          countedPoisha: counted.toString(),
          variancePoisha: '0',
          status: 'balanced',
          approvalId: null,
          journalId: null,
        };
      }

      const raised = await this.approvals.request(context, {
        type: 'closing_variance',
        amountPoisha: variance,
        payload: { closingId: input.closingId, walletId: wallet.id },
        reason: input.memo ?? `Till count for ${input.businessDate}`,
        ...(wallet.branch_id === null ? {} : { branchId: wallet.branch_id }),
        // This module counted the till and subtracted the ledger. Saying so is
        // what lets the org's threshold decide the request instead of holding
        // every variance for an org admin (D-072).
        amountDerivedByServer: true,
        request,
      });

      await repo.insertClosing(tx, {
        orgId: context.orgId,
        id: input.closingId,
        walletId: wallet.id,
        branchId: wallet.branch_id,
        businessDate: input.businessDate,
        expectedPoisha: expected,
        countedPoisha: counted,
        variancePoisha: variance,
        status: 'pending_approval',
        approvalRequestId: raised.id,
        journalId: null,
        countedBy: context.userId,
      });

      await this.auditClose(tx, context, request, input, {
        expected,
        counted,
        variance,
        status: 'pending_approval',
      });

      return {
        closingId: input.closingId,
        walletId: wallet.id,
        businessDate: input.businessDate,
        expectedPoisha: expected.toString(),
        countedPoisha: counted.toString(),
        variancePoisha: variance.toString(),
        status: 'pending_approval',
        approvalId: raised.id,
        journalId: null,
      };
    });
  }

  async list(
    context: ActiveContext,
    request: object,
    range: { readonly from?: string | undefined; readonly to: string },
  ) {
    const scope = scopeWhere(request, { branchId: sql`c.branch_id` });
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => ({
      items: (
        await repo.listClosings(tx, context.orgId, { scope, from: range.from, to: range.to })
      ).map((row) => this.view(row)),
    }));
  }

  /**
   * Post the variance a checker has just approved, inside the approving
   * transaction.
   *
   * Nothing else in the system raises `closing_variance` with a payload — it is in
   * `SERVER_DERIVED_AMOUNT_TYPES`, so a person raising one through the generic
   * route has it held and carries no `closingId` — but the payload is still parsed
   * and a request that names no waiting closing of this org is left alone. The
   * alternative is an executor that throws on somebody else's request and makes
   * their approval undecidable.
   */
  private readonly executeVariance: ApprovalExecutor = async (
    tx,
    { context, approval, request },
  ) => {
    const parsed = closingPayloadSchema.safeParse(approval.payload);
    if (!parsed.success) return;

    const closing = await repo.closingById(tx, context.orgId, parsed.data.closingId, true);
    if (closing?.status !== 'pending_approval') return;
    if (closing.approval_request_id !== approval.id) return;

    await mapWalletErrors(async () => {
      const wallet = await repo.walletById(tx, context.orgId, closing.wallet_id);
      const overShort = await repo.accountBySubtype(tx, context.orgId, 'cash_over_short');
      if (wallet === undefined || !isAccountSubtype(wallet.subtype)) {
        throw walletsHttpError('LEDGER_ACCOUNT_NOT_FOUND', 'That closing names a missing wallet.');
      }
      if (overShort === undefined) {
        // Seeded by the chart-of-accounts template as 5700 (D-084). If it is
        // missing the chart is broken, and saying so beats posting the variance
        // somewhere else.
        throw walletsHttpError(
          'LEDGER_ACCOUNT_NOT_FOUND',
          'This organization has no cash over/short account.',
        );
      }

      // The approval's amount, not the row's (D-078).
      const variance = approval.amountPoisha;
      if (variance === null || variance !== BigInt(closing.variance_poisha)) {
        throw walletsHttpError(
          'IDEMPOTENCY_CONFLICT',
          'That approval is for a different variance than the closing it names.',
        );
      }

      const posted = await this.ledger.post(
        tx,
        { orgId: context.orgId, userId: context.userId },
        closingVarianceDraft({
          closingId: closing.id,
          businessDate: closing.business_date,
          wallet: {
            accountId: wallet.ledger_account_id,
            subtype: wallet.subtype,
            branchId: wallet.branch_id,
          },
          cashOverShort: {
            accountId: overShort.id,
            subtype: overShort.subtype as AccountSubtype,
          },
          variancePoisha: poisha(variance),
          memo: `Till count ${closing.business_date}`,
        }),
      );

      await repo.settleClosing(tx, context.orgId, closing.id, {
        status: 'posted',
        journalId: posted.journalId,
      });

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'wallets.closing.variance_posted',
        entityType: 'WalletClosing',
        entityId: closing.id,
        before: { status: 'pending_approval', journalId: null },
        after: {
          status: 'posted',
          journalId: posted.journalId,
          approvalId: approval.id,
          variancePoisha: variance.toString(),
        },
        requestId: context.requestId,
        ...(request === undefined ? {} : { request }),
      });
    });
  };

  /** The derived ledger balance of a wallet at the end of a business date. */
  private async expectedBalance(
    tx: Tx,
    orgId: string,
    accountId: string,
    asOf: string,
  ): Promise<bigint> {
    const [row] = await repo.balancesAsOf(tx, orgId, asOf, [accountId]);
    if (row === undefined) return 0n;
    return aggregateBalanceOf('debit', BigInt(row.debit_poisha), BigInt(row.credit_poisha));
  }

  private view(row: repo.ClosingRow): ClosingResult {
    return {
      closingId: row.id,
      walletId: row.wallet_id,
      businessDate: row.business_date,
      expectedPoisha: row.expected_poisha,
      countedPoisha: row.counted_poisha,
      variancePoisha: row.variance_poisha,
      status: row.status as ClosingResult['status'],
      approvalId: row.approval_request_id,
      journalId: row.journal_id,
    };
  }

  private async auditClose(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    input: CloseWalletInput,
    outcome: {
      readonly expected: bigint;
      readonly counted: bigint;
      readonly variance: bigint;
      readonly status: string;
    },
  ): Promise<void> {
    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'create',
      action: 'wallets.closing',
      entityType: 'WalletClosing',
      entityId: input.closingId,
      before: null,
      after: {
        walletId: input.walletId,
        businessDate: input.businessDate,
        expectedPoisha: outcome.expected.toString(),
        countedPoisha: outcome.counted.toString(),
        variancePoisha: outcome.variance.toString(),
        status: outcome.status,
      },
      requestId: context.requestId,
      request,
    });
  }
}
