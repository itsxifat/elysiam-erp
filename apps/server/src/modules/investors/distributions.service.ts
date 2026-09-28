import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { serializeFor } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import { businessDate, isAccountSubtype, periodForMonth, poisha } from '@elysium/domain';
import { splitDistribution, type InvestorShareAmount } from '@elysium/domain/investors';
import { profitDistributionDraft } from '@elysium/domain/posting/investors';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ApprovalsService, type ApprovalExecutor } from '../approvals/approvals.service.js';
import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import * as repo from './investors.repository.js';
import { investorsHttpError, mapInvestorErrors } from './investors.errors.js';
import { assertOrgWideInvestorReach } from './investors.service.js';
import type { DeclareDistributionInput } from './investors.schemas.js';

/**
 * Declaring a profit distribution (architecture §7, §15; D-019).
 *
 * D-019: "Manual declaration per period per org: amount entered, then approved.
 * No automatic formula until one is defined." So the **amount** is typed by a
 * person and the **split** is computed here, from each investor's agreed share or
 * from the capital they contributed. What is not accepted is a client-supplied
 * split: the parts must sum to the declared total exactly or the journal cannot
 * post, and "the client did the arithmetic" is not a property anybody can check a
 * year later.
 *
 * Four decisions worth reading:
 *
 * 1. **Nothing posts until a checker decides.** §6's maker-checker list names
 *    "investor withdrawals and distributions", and the type is in
 *    `SERVER_DERIVED_AMOUNT_TYPES` while this module raises it with a
 *    person-typed amount — so no threshold can ever exempt it (D-019, D-072). The
 *    row is `pending_approval` with no journal at all, so it is in no report, no
 *    position and no investor's statement until it is declared.
 * 2. **The journal is dated the day it is declared**, never the last day of the
 *    period it distributes. A September declaration of August profit is a
 *    September equity movement — which also means this can never silently post
 *    into a closed period, because the month it is dated in is the month that is
 *    still running. D-037's problem (an event that genuinely belongs to a closed
 *    month) does not arise here; what would arise is declaring profit for a month
 *    that has not finished, so that is refused instead.
 * 3. **The weights are snapshotted onto the lines.** An investor whose agreed
 *    share changes next year must not restate a distribution a checker already
 *    approved and an investor has already been paid.
 * 4. **The executor posts inside the approving transaction.** The decision and
 *    the journal commit together, so an approved distribution with no journal is
 *    not a state the database can be left in.
 */

/** What an `investor_distribution` payload must say for this module to act on it. */
const distributionPayloadSchema = z.object({ distributionId: z.string().uuid() }).strict();

export interface DistributionResult {
  readonly distributionId: string;
  readonly status: string;
  readonly approvalId: string | null;
  readonly journalId: string | null;
  readonly totalPoisha: string;
  readonly periodStartsOn: string;
  readonly periodEndsOn: string;
  readonly lines: readonly {
    readonly investorId: string;
    readonly weight: string;
    readonly amountPoisha: string;
  }[];
}

@Injectable()
export class DistributionsService implements OnModuleInit {
  constructor(
    @Inject(LEDGER_API) private readonly ledger: LedgerApi,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.approvals.registerExecutor('investor_distribution', this.executeDeclaration);
  }

  /**
   * Compute the split, raise the approval, record the declaration. Post nothing.
   *
   * The order matters. The approval is raised **before** the rows exist, because
   * a `pending_approval` distribution has to name the approval that will decide
   * it (a CHECK in 0058 says so) — the alternative is a row that claims to be
   * waiting for nothing. If the insert then fails, what is left behind is a
   * pending approval whose executor finds no distribution and does nothing, which
   * is the same shape M08's petty cash leaves and is harmless.
   */
  async declare(
    context: ActiveContext,
    request: AuditableRequest,
    input: DeclareDistributionInput,
    now: Date = new Date(),
  ): Promise<DistributionResult> {
    const total = poisha(input.totalPoisha);
    const period = periodForMonth(input.month);
    const today = businessDate(now);

    // Profit for a month that has not ended is not a number anybody has. The
    // ledger refuses to *close* such a month for the same reason (§7), and this
    // is the same rule one step earlier.
    if (period.endsOn >= today) {
      throw investorsHttpError(
        'INVESTOR_SPLIT_INVALID',
        `${input.month} has not ended yet in Asia/Dhaka, so its profit is not known.`,
      );
    }

    const { parts, basis } = await mapInvestorErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const existing = await repo.distributionById(tx, context.orgId, input.distributionId);
        if (existing !== undefined) {
          throw investorsHttpError(
            'IDEMPOTENCY_CONFLICT',
            'That distribution id has already been used.',
          );
        }
        const live = await repo.livePeriodDistribution(tx, context.orgId, period);
        if (live !== undefined) {
          throw investorsHttpError(
            'CONFLICT',
            `${input.month} already has a ${live.status} distribution. A second one claiming the same month is a duplicate, not a top-up.`,
          );
        }
        return {
          parts: await this.splitFor(tx, context, input, period, total),
          basis: input.basis,
        };
      }),
    );

    const raised = await this.approvals.request(context, {
      type: 'investor_distribution',
      amountPoisha: total,
      payload: { distributionId: input.distributionId },
      reason: input.memo ?? `Profit distribution for ${input.month}`,
      request,
    });

    return mapInvestorErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        await repo.insertDistribution(tx, {
          orgId: context.orgId,
          id: input.distributionId,
          periodStartsOn: period.startsOn,
          periodEndsOn: period.endsOn,
          totalPoisha: total,
          basis,
          approvalRequestId: raised.id,
          memo: input.memo ?? null,
          createdBy: context.userId,
        });
        await repo.insertDistributionLines(
          tx,
          parts.map((part) => ({
            orgId: context.orgId,
            distributionId: input.distributionId,
            investorId: part.investorId,
            weight: part.weight,
            amountPoisha: part.amountPoisha,
          })),
        );

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'investors.distribution.declared',
          entityType: 'Distribution',
          entityId: input.distributionId,
          before: null,
          after: {
            month: input.month,
            totalPoisha: total.toString(),
            basis,
            approvalId: raised.id,
            status: 'pending_approval',
            // Who gets what, as a checker will see it. The split is the decision
            // being approved, so it belongs in the audit row.
            shares: parts.map((part) => ({
              investorId: part.investorId,
              amountPoisha: part.amountPoisha.toString(),
            })),
          },
          requestId: context.requestId,
          request,
        });

        // Through `serializeFor` like every read, although nothing here is a cost
        // field today. The first cost-bearing figure added to a declaration — a
        // margin, a period's gross profit — would otherwise walk straight out
        // (invariant 5).
        return serializeFor(context, 'Investor', {
          distributionId: input.distributionId,
          status: 'pending_approval',
          approvalId: raised.id,
          journalId: null,
          totalPoisha: total.toString(),
          periodStartsOn: period.startsOn,
          periodEndsOn: period.endsOn,
          lines: parts.map((part) => ({
            investorId: part.investorId,
            weight: part.weight.toString(),
            amountPoisha: part.amountPoisha.toString(),
          })),
        });
      }),
    );
  }

  async list(context: ActiveContext, request: object) {
    assertOrgWideInvestorReach(request);
    return mapInvestorErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const rows = await repo.listDistributions(tx, context.orgId);
        return serializeFor(context, 'Investor', {
          items: rows.map((row) => ({
            id: row.id,
            periodStartsOn: row.period_starts_on,
            periodEndsOn: row.period_ends_on,
            totalPoisha: row.total_poisha,
            basis: row.basis,
            status: row.status,
            approvalId: row.approval_request_id,
            journalId: row.journal_id,
            declaredOn: row.declared_on,
            memo: row.memo,
          })),
        });
      }),
    );
  }

  async get(context: ActiveContext, request: object, distributionId: string) {
    assertOrgWideInvestorReach(request);
    return mapInvestorErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const row = await repo.distributionById(tx, context.orgId, distributionId);
        if (row === undefined) {
          throw investorsHttpError('INVESTOR_NOT_FOUND', 'No such distribution.');
        }
        const lines = await repo.distributionLines(tx, context.orgId, distributionId);
        return serializeFor(context, 'Investor', {
          id: row.id,
          periodStartsOn: row.period_starts_on,
          periodEndsOn: row.period_ends_on,
          totalPoisha: row.total_poisha,
          basis: row.basis,
          status: row.status,
          approvalId: row.approval_request_id,
          journalId: row.journal_id,
          declaredOn: row.declared_on,
          memo: row.memo,
          lines: lines.map((line) => ({
            investorId: line.investor_id,
            investorCode: line.investor_code,
            investorName: line.investor_name,
            weight: line.weight,
            amountPoisha: line.amount_poisha,
          })),
        });
      }),
    );
  }

  /**
   * Close a declaration that is not going to be declared.
   *
   * **A month whose declaration cannot be closed is a month whose profit can never
   * be declared again.** The unique index in 0058 allows one distribution per period
   * that is not `rejected`, so a row left at `pending_approval` occupies August for
   * ever — and its own approval, once decided, can never be approved again either.
   *
   * The gap is the approvals module's: an executor runs only on `approved`, so a
   * checker who **rejects** an `investor_distribution` decides the approval and
   * leaves this row waiting. Until that hook exists (handed over as an integration
   * line), this is how the row is closed: by a person, audited, under the
   * `create Investor` that declaring needed. 0060 allows `pending_approval →
   * rejected` and nothing else, so a declared distribution can never be rejected
   * after the fact — that correction is a reversal.
   */
  async reject(
    context: ActiveContext,
    request: AuditableRequest,
    distributionId: string,
    reason: string | undefined,
  ) {
    return mapInvestorErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const row = await repo.distributionById(tx, context.orgId, distributionId, true);
        if (row === undefined) {
          throw investorsHttpError('INVESTOR_NOT_FOUND', 'No such distribution.');
        }
        if (row.status === 'rejected') return { distributionId: row.id, status: row.status };
        if (row.status !== 'pending_approval') {
          throw investorsHttpError(
            'INVESTOR_DISTRIBUTION_FROZEN',
            'That distribution has been declared. A declared distribution is undone by a reversal.',
          );
        }

        await repo.settleDistribution(tx, context.orgId, row.id, {
          status: 'rejected',
          journalId: null,
          declaredOn: null,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'investors.distribution.rejected',
          entityType: 'Distribution',
          entityId: row.id,
          before: { status: 'pending_approval' },
          after: { status: 'rejected', reason: reason ?? null },
          requestId: context.requestId,
          request,
        });

        return serializeFor(context, 'Investor', {
          distributionId: row.id,
          status: 'rejected' as const,
        });
      }),
    );
  }

  // --- the approval path -----------------------------------------------------

  /**
   * Post a distribution a checker has just approved, inside the approving
   * transaction.
   *
   * A payload this module did not write is left alone: the type is also reachable
   * through the generic `POST /v1/approvals`, and an executor that threw on a
   * request naming nothing would make every such approval fail at the moment of
   * decision (the shape M08's petty cash executor established).
   */
  private readonly executeDeclaration: ApprovalExecutor = async (
    tx,
    { context, approval, request },
  ) => {
    const parsed = distributionPayloadSchema.safeParse(approval.payload);
    if (!parsed.success) return;

    await mapInvestorErrors(async () => {
      const row = await repo.distributionById(tx, context.orgId, parsed.data.distributionId, true);
      /*
       * Past the payload check, silence is the wrong answer. Returning quietly meant
       * a checker who approved "৳3,33,333 of August profit" got a 201 while nothing
       * was declared and nothing posted — indistinguishable, from outside, from a
       * distribution that went through. The ledger's `period_reopen` executor
       * refuses the same way (M03 security review M1).
       */
      if (row === undefined) {
        throw investorsHttpError(
          'INVESTOR_NOT_FOUND',
          'This request names no distribution in this organization. Reject it and declare a new one.',
        );
      }
      // The approval that decided this row must be the approval *on* the row.
      // Otherwise a second `investor_distribution` naming somebody else's waiting
      // declaration would post it.
      if (row.approval_request_id !== approval.id) {
        throw investorsHttpError(
          'INVESTOR_DISTRIBUTION_FROZEN',
          'That distribution is being decided by a different approval. Reject this one.',
        );
      }
      if (row.status !== 'pending_approval') {
        throw investorsHttpError(
          'INVESTOR_DISTRIBUTION_FROZEN',
          `That distribution is already ${row.status}.`,
        );
      }

      const lines = await repo.distributionLines(tx, context.orgId, row.id);
      if (lines.length === 0) {
        throw investorsHttpError(
          'INVESTOR_SPLIT_INVALID',
          'That distribution names no investors. Reject it and declare a new one.',
        );
      }

      /*
       * The **approval's** amount, not the row's (D-078). They are the same
       * number, and the rule is that an executor reads `amountPoisha` and nothing
       * else for money — so a payload can never carry an amount of its own past
       * the threshold that was checked.
       */
      const amount = approval.amountPoisha;
      if (amount === null || amount !== BigInt(row.total_poisha)) {
        throw investorsHttpError(
          'IDEMPOTENCY_CONFLICT',
          'That approval is for a different amount than the distribution it names.',
        );
      }

      const distributionAccount = await repo.accountBySubtype(
        tx,
        context.orgId,
        'profit_distribution',
      );
      if (distributionAccount === undefined || !isAccountSubtype(distributionAccount.subtype)) {
        throw investorsHttpError(
          'LEDGER_ACCOUNT_NOT_FOUND',
          'This organization has no profit distribution account.',
        );
      }

      const posted = await this.ledger.post(
        tx,
        { orgId: context.orgId, userId: context.userId },
        profitDistributionDraft({
          distributionId: row.id,
          // Dated when the checker decided, which is when the company took on
          // the debt to its investors.
          declaredAt: new Date(),
          distributionAccount: {
            accountId: distributionAccount.id,
            subtype: distributionAccount.subtype,
            branchId: distributionAccount.branch_id,
          },
          totalPoisha: poisha(amount),
          lines: lines.map((line) => {
            if (line.payable_account_id === null) {
              throw investorsHttpError(
                'LEDGER_ACCOUNT_NOT_FOUND',
                'This organization has no investor payable account.',
              );
            }
            return {
              investorId: line.investor_id,
              payableAccountId: line.payable_account_id,
              payableSubtype: 'investor_payable' as const,
              amountPoisha: poisha(line.amount_poisha),
            };
          }),
          memo: row.memo,
        }),
      );

      await repo.settleDistribution(tx, context.orgId, row.id, {
        status: 'declared',
        journalId: posted.journalId,
        declaredOn: posted.businessDate,
      });

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'investors.distribution.approved',
        entityType: 'Distribution',
        entityId: row.id,
        before: { status: 'pending_approval', journalId: null },
        after: {
          status: 'declared',
          journalId: posted.journalId,
          declaredOn: posted.businessDate,
          approvalId: approval.id,
          totalPoisha: amount.toString(),
        },
        requestId: context.requestId,
        ...(request === undefined ? {} : { request }),
      });
    });
  };

  // --- the split -------------------------------------------------------------

  /**
   * Who participates, with what weight, and what each one gets.
   *
   * The weight comes from the basis: the agreed share in basis points, or the
   * capital each investor has contributed. Investors with a zero weight are
   * dropped before the split rather than passed in with zero — an investor who
   * contributed nothing is not a participant, and including them would make the
   * declaration's own list disagree with what a checker reads.
   */
  private async splitFor(
    tx: Tx,
    context: ActiveContext,
    input: DeclareDistributionInput,
    period: { readonly endsOn: string },
    total: ReturnType<typeof poisha>,
  ): Promise<InvestorShareAmount[]> {
    // Weighted as at the **end of the period**, not today: capital that arrived in
    // September did not earn August's profit, and capital returned before August
    // ended was not funding the company while it was earned.
    const participants = await repo.distributionParticipants(tx, context.orgId, period.endsOn);
    const wanted =
      input.investorIds === undefined
        ? participants
        : participants.filter((row) => input.investorIds?.includes(row.id) === true);

    if (input.investorIds !== undefined && wanted.length !== input.investorIds.length) {
      throw investorsHttpError(
        'INVESTOR_NOT_FOUND',
        'One of those investors does not exist in this organization, or has exited.',
      );
    }

    const weighed = wanted.map((row) => ({
      investorId: row.id,
      code: row.code,
      weight: input.basis === 'share_bps' ? BigInt(row.share_bps) : BigInt(row.capital_poisha),
    }));

    /*
     * An investor named explicitly and weighed at zero is refused rather than
     * dropped. Somebody who listed them meant them to share in this, and a
     * declaration that silently excludes a named person is the one error nobody
     * finds by reading the screen — the remaining shares still sum to the total, so
     * everything looks right.
     */
    const idle = weighed.filter((share) => share.weight === 0n);
    if (input.investorIds !== undefined && idle.length > 0) {
      throw investorsHttpError(
        'INVESTOR_SPLIT_INVALID',
        input.basis === 'share_bps'
          ? `${idle.map((share) => share.code).join(', ')} has no agreed share, so a split by share would give them nothing.`
          : `${idle.map((share) => share.code).join(', ')} held no capital at the end of that period.`,
      );
    }

    const shares = weighed
      .map((share) => ({ investorId: share.investorId, weight: share.weight }))
      .filter((share) => share.weight > 0n);

    if (shares.length === 0) {
      throw investorsHttpError(
        'INVESTOR_SPLIT_INVALID',
        input.basis === 'share_bps'
          ? 'No active investor has an agreed share. Set the shares, or distribute by capital.'
          : 'No active investor has contributed capital yet.',
      );
    }

    // The domain does the arithmetic, including the remainder (invariant 11).
    return splitDistribution(total, shares);
  }
}
