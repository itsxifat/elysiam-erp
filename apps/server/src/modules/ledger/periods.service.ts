import { Injectable, type OnModuleInit } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { addDays, businessDate, periodForMonth } from '@elysium/domain';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ApprovalsService, type ApprovalExecutor } from '../approvals/approvals.service.js';
import { ledgerHttpError, mapLedgerErrors } from './ledger.errors.js';
import * as repo from './ledger.repository.js';

/**
 * Monthly periods (architecture §7 "Periods and dates").
 *
 * - `org_admin` or `accounts` closes a month once it has ended.
 * - Reopening is a `period_reopen` approval request. Only super_admin may
 *   decide one (`CHECKER_TYPES` lists it for nobody), no threshold can exempt
 *   it (D-071), and when it is approved the period reopens **in the same
 *   transaction as the decision**, through the executor registered below.
 *
 * The database holds the same rules independently (0014): a period row can be
 * created only closed, and closed → open needs an approved `period_reopen`
 * for that period raised and decided after the close.
 */

/** What a `period_reopen` payload must say; the executor trusts nothing else. */
const reopenPayloadSchema = z
  .object({ periodId: z.string().uuid(), month: z.string().regex(/^\d{4}-\d{2}$/) })
  .strict();

export interface PeriodView {
  readonly id: string;
  readonly month: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: 'open' | 'closed';
  readonly closedAt: string | null;
  readonly closedBy: string | null;
  readonly reopenedAt: string | null;
  readonly reopenApprovalId: string | null;
}

function view(row: repo.PeriodRow): PeriodView {
  return {
    id: row.id,
    month: row.starts_on.slice(0, 7),
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    status: row.status,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    reopenedAt: row.reopened_at,
    reopenApprovalId: row.reopen_approval_id,
  };
}

@Injectable()
export class PeriodsService implements OnModuleInit {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.approvals.registerExecutor('period_reopen', this.executeReopen);
  }

  async list(context: ActiveContext): Promise<PeriodView[]> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) =>
      (await repo.listPeriods(tx, context.orgId)).map(view),
    );
  }

  /**
   * Close a month that has ended. Posting into it is refused from the moment
   * this commits — the database's period lock, not this service, is what
   * enforces that.
   */
  async close(
    context: ActiveContext,
    month: string,
    request: AuditableRequest,
    now: Date = new Date(),
  ): Promise<PeriodView> {
    const period = periodForMonth(month);
    const today = businessDate(now);
    if (period.endsOn >= today) {
      throw ledgerHttpError(
        'PERIOD_NOT_ENDED',
        `${month} has not ended yet in Asia/Dhaka; it can be closed from ${addDays(period.endsOn, 1)}.`,
      );
    }

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const closed = await repo.closePeriod(tx, {
        orgId: context.orgId,
        startsOn: period.startsOn,
        endsOn: period.endsOn,
        closedBy: context.userId,
      });
      if (closed === undefined) {
        throw ledgerHttpError('PERIOD_ALREADY_CLOSED', `${month} is already closed.`);
      }

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'ledger.period.closed',
        entityType: 'LedgerPeriod',
        entityId: closed.id,
        before: { month, status: 'open' },
        after: { month, status: 'closed' },
        requestId: context.requestId,
        request,
      });

      return view(closed);
    });
  }

  /**
   * Ask for a closed month to be reopened: raises a `period_reopen` approval
   * request that only super_admin can decide. Nothing reopens here.
   */
  async requestReopen(
    context: ActiveContext,
    input: { month: string; reason: string },
    request: AuditableRequest,
  ): Promise<{ approvalId: string; status: string; periodId: string }> {
    const period = periodForMonth(input.month);
    const { existing, laterClosed } = await withOrg(
      { orgId: context.orgId, userId: context.userId },
      async (tx) => ({
        existing: await repo.periodByStart(tx, context.orgId, period.startsOn),
        laterClosed: await repo.closedAfter(tx, context.orgId, period.startsOn),
      }),
    );
    if (existing?.status !== 'closed') {
      throw ledgerHttpError('PERIOD_NOT_CLOSED', `${input.month} is not closed.`);
    }
    // A closed month locks every date before it (D-093), so reopening this one
    // alone would change nothing. Later months are reopened first.
    if (laterClosed !== undefined) {
      throw ledgerHttpError(
        'PERIOD_LATER_CLOSED',
        `${laterClosed} is closed too. Reopen the later months first, latest first.`,
      );
    }
    if (
      await this.approvals.hasPending(context, {
        type: 'period_reopen',
        payloadKey: 'periodId',
        value: existing.id,
      })
    ) {
      throw ledgerHttpError(
        'PERIOD_REOPEN_PENDING',
        `A request to reopen ${input.month} is already waiting for a decision.`,
      );
    }

    // The approvals service checks the caller may raise this type (D-072),
    // writes the request and its audit row in one transaction, and holds it
    // for a super_admin whatever the thresholds say (D-071).
    const raised = await this.approvals.request(context, {
      type: 'period_reopen',
      amountPoisha: null,
      payload: { periodId: existing.id, month: input.month },
      reason: input.reason,
      request,
      // Only the ledger may raise this type: it wrote the payload (D-081).
      raisedByModule: true,
    });

    return { approvalId: raised.id, status: raised.status, periodId: existing.id };
  }

  /**
   * The executor: runs inside the approving transaction, as the checker.
   * An arrow function so `this` survives being handed to the registry.
   */
  private readonly executeReopen: ApprovalExecutor = async (tx, { context, approval, request }) => {
    const parsed = reopenPayloadSchema.safeParse(approval.payload);
    if (!parsed.success) {
      throw ledgerHttpError(
        'PERIOD_REOPEN_UNAUTHORISED',
        'This request does not name a period to reopen. Reject it and raise a new one.',
      );
    }

    // Refusals from the database surface as ledger errors, not 500s (audit N4).
    await mapLedgerErrors(() => this.reopenLocked(tx, context, parsed.data, approval.id, request));
  };

  private async reopenLocked(
    tx: Tx,
    context: ActiveContext,
    target: { periodId: string; month: string },
    approvalId: string,
    request: AuditableRequest | undefined,
  ): Promise<void> {
    const { periodId } = target;
    // The org's period lock before the row lock, in the same order a close
    // takes them, so the two cannot deadlock (audit N5).
    await repo.lockPeriods(tx, context.orgId);
    const period = await repo.periodById(tx, context.orgId, periodId);
    if (period?.status !== 'closed') {
      throw ledgerHttpError(
        'PERIOD_NOT_CLOSED',
        'That period is not closed any more. Reject this request.',
      );
    }
    // The month the checker read must be the month that reopens.
    if (period.starts_on.slice(0, 7) !== target.month) {
      throw ledgerHttpError(
        'PERIOD_REOPEN_UNAUTHORISED',
        'This request names a different month than the period it would reopen. Reject it.',
      );
    }

    await repo.reopenPeriod(tx, { orgId: context.orgId, periodId, approvalId });

    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'update',
      action: 'ledger.period.reopened',
      entityType: 'LedgerPeriod',
      entityId: periodId,
      before: { month: period.starts_on.slice(0, 7), status: 'closed' },
      after: { month: period.starts_on.slice(0, 7), status: 'open', approvalId },
      requestId: context.requestId,
      ...(request === undefined ? {} : { request }),
    });
  }
}
