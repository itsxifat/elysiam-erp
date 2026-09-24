import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { APPROVAL_TYPES, canDecideType, CHECKER_TYPES } from '@elysium/contracts';
import { canDecide, requiresApproval, type Threshold } from '@elysium/domain';
import { withOrg, type Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';

/**
 * Maker-checker (architecture §6, §25).
 *
 * The rule — one person requests, a *different* person approves — is enforced
 * in three places on purpose, weakest to strongest:
 *
 * 1. Here, so the API can explain itself.
 * 2. The `approval_requests_maker_is_not_checker` CHECK constraint, which is
 *    what actually holds. A service can be refactored, called from a job, or
 *    bypassed by the next module; a constraint cannot.
 * 3. The permission matrix, which decides who may `approve` at all.
 *
 * Only the second is load-bearing. The other two exist so that hitting it is
 * rare and legible rather than a raw constraint violation in a log.
 */

export type ApprovalType =
  | 'wallet_adjustment'
  | 'stock_write_off'
  | 'stock_gain'
  | 'supplier_payment'
  | 'settlement_posting'
  | 'closing_variance'
  | 'back_dated_entry'
  | 'payroll_run'
  | 'bonus_rule'
  | 'reseller_payout_batch'
  | 'period_reopen';

export interface ApprovalRequestRow {
  readonly id: string;
  readonly type: ApprovalType;
  readonly status: string;
  readonly requestedBy: string;
  readonly amountPoisha: string | null;
  readonly decidedBy: string | null;
}

/** What the outbox will carry once M04 exists (§27). */
export interface DomainEvent {
  readonly name: 'approval.requested' | 'approval.decided';
  readonly orgId: string;
  readonly payload: Record<string, unknown>;
}

@Injectable()
export class ApprovalsService {
  /** Collected in memory until M04's outbox. See `emit` below. */
  readonly emitted: DomainEvent[] = [];

  constructor(private readonly audit: AuditService) {}

  /**
   * Events, held rather than published.
   *
   * M04 adds the transactional outbox and Socket.IO; until then a request
   * emitting an event that nothing delivers would be a lie in the code. This
   * records them so §27's contract — `approval.requested` and
   * `approval.decided` — is exercised and asserted now, and M04 replaces the
   * body rather than adding the call sites.
   */
  private emit(event: DomainEvent): void {
    this.emitted.push(event);
  }

  private async thresholdsFor(tx: Tx, orgId: string): Promise<Threshold[]> {
    const rows = await tx.execute<{ type: string; threshold_poisha: string }>(
      sql`select type, threshold_poisha from approvals.approval_thresholds where org_id = ${orgId}`,
    );

    return [...rows].map((row) => ({
      type: row.type,
      thresholdPoisha: BigInt(row.threshold_poisha),
    }));
  }

  /**
   * Would this action need a second person?
   *
   * Exposed so a caller can ask before doing the work — the preview and the
   * enforcement read the same pure function (`requiresApproval`), which is why
   * it lives in the domain rather than here.
   */
  async isRequired(
    context: ActiveContext,
    input: { type: ApprovalType; amountPoisha: bigint | null },
  ): Promise<boolean> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) =>
      requiresApproval({
        type: input.type,
        amountPoisha: input.amountPoisha,
        thresholds: await this.thresholdsFor(tx, context.orgId),
      }),
    );
  }

  async request(
    context: ActiveContext,
    input: {
      type: ApprovalType;
      amountPoisha: bigint | null;
      payload?: Record<string, unknown>;
      reason?: string;
      request?: AuditableRequest;
    },
  ): Promise<{ id: string; required: boolean; status: string }> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const thresholds = await this.thresholdsFor(tx, context.orgId);
      const required = requiresApproval({
        type: input.type,
        amountPoisha: input.amountPoisha,
        thresholds,
      });

      const rows = await tx.execute<{ id: string }>(sql`
        insert into approvals.approval_requests (org_id, type, requested_by, amount_poisha, payload, reason)
        values (
          ${context.orgId},
          ${input.type}::approvals.approval_type,
          ${context.userId},
          ${input.amountPoisha === null ? null : input.amountPoisha.toString()},
          ${JSON.stringify(input.payload ?? {})}::jsonb,
          ${input.reason ?? null}
        )
        returning id
      `);

      const id = rows[0]?.id;
      if (id === undefined) throw new ConflictException('Could not record the request.');

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: `approval.requested:${input.type}`,
        entityType: 'ApprovalRequest',
        entityId: id,
        after: {
          type: input.type,
          amountPoisha: input.amountPoisha?.toString() ?? null,
          required,
          // The payload is the *intent* — what will be executed once this is
          // approved — so the log is not much use without it. `AuditService`
          // redacts on the way in, which is why this can be passed through
          // rather than each caller remembering to scrub it.
          payload: input.payload ?? {},
        },
        requestId: context.requestId,
        ...(input.request === undefined ? {} : { request: input.request }),
      });

      // §27: `approval.requested` goes to every eligible checker.
      this.emit({
        name: 'approval.requested',
        orgId: context.orgId,
        payload: {
          id,
          type: input.type,
          amountPoisha: input.amountPoisha?.toString() ?? null,
          required,
        },
      });

      return { id, required, status: 'pending' };
    });
  }

  async decide(
    context: ActiveContext,
    input: {
      id: string;
      decision: 'approved' | 'rejected';
      note?: string;
      request?: AuditableRequest;
    },
  ): Promise<{ id: string; status: string }> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await tx.execute<{
        id: string;
        status: string;
        requested_by: string;
        type: string;
      }>(sql`
        select id, status, requested_by, type
        from approvals.approval_requests
        where id = ${input.id}
        for update
      `);

      const row = rows[0];
      // RLS already scoped this to the active org, so "not found" and "another
      // org's request" are the same answer — which is what we want it to be.
      if (row === undefined) throw new NotFoundException('No such approval request.');

      /*
       * What you may check, as distinct from whether you are a checker (§6).
       *
       * The ability gets you to this method; this decides whether this *type*
       * is yours to decide. Without it, one `approve ApprovalRequest` grant let
       * a branch_manager approve a payroll run, a reseller payout batch or a
       * period reopen — reproduced, 201. Checked before the maker≠checker rule
       * so a checker who may not touch this type is told that, rather than
       * being told they raised it.
       */
      if (!canDecideType(context.roles, row.type, context.isSuperAdmin)) {
        throw new ForbiddenException(
          `Your role cannot decide a ${row.type} request in this organization.`,
        );
      }

      const verdict = canDecide({
        requestedBy: row.requested_by,
        decidedBy: context.userId,
        status: row.status,
      });

      if (!verdict.ok) {
        // 403 for self-approval, 409 for an already-decided request: one is a
        // permission answer and the other is a state answer, and a client that
        // cannot tell them apart retries the wrong one.
        if (row.requested_by === context.userId) {
          throw new ForbiddenException(verdict.reason);
        }
        throw new ConflictException(verdict.reason);
      }

      await tx.execute(sql`
        update approvals.approval_requests
        set status = ${input.decision}::approvals.approval_status,
            decided_by = ${context.userId},
            decided_at = now(),
            decision_note = ${input.note ?? null},
            updated_at = now()
        where id = ${input.id}
      `);

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: input.decision === 'approved' ? 'approve' : 'reject',
        action: `approval.decided:${row.type}`,
        entityType: 'ApprovalRequest',
        entityId: input.id,
        before: { status: row.status },
        after: { status: input.decision, decidedBy: context.userId },
        requestId: context.requestId,
        ...(input.request === undefined ? {} : { request: input.request }),
      });

      // §27: `approval.decided` goes back to the requester.
      this.emit({
        name: 'approval.decided',
        orgId: context.orgId,
        payload: { id: input.id, decision: input.decision, requestedBy: row.requested_by },
      });

      return { id: input.id, status: input.decision };
    });
  }

  /**
   * The requests this caller may see.
   *
   * Scope is declared in the matrix and, today, enforced nowhere on the request
   * path: `ability.can(action, 'ApprovalRequest')` with a bare subject string
   * returns true for a conditional rule, because CASL is being asked about the
   * *type* rather than a row. So a `branch_manager`, whose matrix scope is
   * `branch`, could read every pending supplier payment and payroll run in the
   * org, with amounts.
   *
   * Until a general scope filter exists (M03 follow-up), the narrowing is done
   * here, explicitly: a checker sees what they may decide, and everyone else
   * sees what they raised. That is a smaller answer than the matrix implies,
   * which is the safe direction to be wrong in.
   */
  async list(context: ActiveContext): Promise<ApprovalRequestRow[]> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const decidable = context.isSuperAdmin
        ? [...APPROVAL_TYPES]
        : context.roles.flatMap((role) => [...(CHECKER_TYPES[role] ?? [])]);

      const rows = await tx.execute<{
        id: string;
        type: ApprovalType;
        status: string;
        requested_by: string;
        amount_poisha: string | null;
        decided_by: string | null;
      }>(sql`
        select id, type, status, requested_by, amount_poisha, decided_by
        from approvals.approval_requests
        where requested_by = ${context.userId}
           or type = any(${decidable}::text[]::approvals.approval_type[])
        order by created_at desc
        limit 100
      `);

      return [...rows].map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        requestedBy: row.requested_by,
        amountPoisha: row.amount_poisha,
        decidedBy: row.decided_by,
      }));
    });
  }

  /** Set an org's threshold for one action type. */
  async setThreshold(
    context: ActiveContext,
    input: { type: ApprovalType; thresholdPoisha: bigint },
  ): Promise<void> {
    if (input.thresholdPoisha < 0n) {
      throw new BadRequestException('A threshold cannot be negative.');
    }

    await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      await tx.execute(sql`
        insert into approvals.approval_thresholds (org_id, type, threshold_poisha)
        values (${context.orgId}, ${input.type}::approvals.approval_type, ${input.thresholdPoisha.toString()})
        on conflict (org_id, type) do update
          set threshold_poisha = excluded.threshold_poisha, updated_at = now()
      `);
    });
  }
}
