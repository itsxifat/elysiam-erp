import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { APPROVAL_TYPES, canDecideType, CHECKER_TYPES, checkerTier } from '@elysium/contracts';
import { canDecide, requiresApproval, type Threshold } from '@elysium/domain';
import { withOrg, type Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeOf, scopeWhere } from '../../platform/auth/scope.js';
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
 *
 * **Below the threshold is auto-approved (D-068).** §6 routes "supplier
 * payments *above* the threshold" through approvals, and `requiresApproval`
 * already answered "no" below it — but the request used to be stored `pending`
 * anyway, so below and above differed only in a boolean nobody acted on. Now a
 * below-threshold request is written `auto_approved`: recorded, audited, both
 * events emitted, final the moment it is written, and never in a checker's
 * queue. At or above — or with no threshold configured, which fails closed —
 * it waits for a second person.
 */

export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'auto_approved';

export interface ApprovalRequestRow {
  readonly id: string;
  readonly type: ApprovalType;
  readonly status: ApprovalStatus;
  readonly requestedBy: string;
  readonly branchId: string | null;
  readonly amountPoisha: string | null;
  readonly decidedBy: string | null;
}

/** What the outbox will carry once M04 exists (§19, §27). */
export interface DomainEvent {
  readonly name: 'approval.requested' | 'approval.decided';
  readonly orgId: string;
  readonly payload: Record<string, unknown>;
}

/** The PostgreSQL error a row fails with, found through Drizzle's wrapper. */
function pgCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

@Injectable()
export class ApprovalsService {
  /** Collected in memory until M04's outbox (D-067). See `emit` below. */
  readonly emitted: DomainEvent[] = [];

  constructor(private readonly audit: AuditService) {}

  /**
   * Events, held rather than published (D-067).
   *
   * M04 adds the transactional outbox and Socket.IO; until then a request
   * emitting an event that nothing delivers would be a lie in the code. This
   * records them so §19's contract — `approval.requested` and
   * `approval.decided` — is exercised and asserted now, and M04 replaces the
   * body rather than adding the call sites. Emitted inside the transaction
   * callback, after the writes, which is where `enqueue(tx, …)` will go.
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
      branchId?: string;
      /** The HTTP request: carries the caller's scope, and tells the audit net to stand down. */
      request?: AuditableRequest;
    },
  ): Promise<{ id: string; required: boolean; status: ApprovalStatus }> {
    const branchId = this.branchForRequest(input.request, input.branchId, context.userId);

    try {
      return await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const thresholds = await this.thresholdsFor(tx, context.orgId);
        const required = requiresApproval({
          type: input.type,
          amountPoisha: input.amountPoisha,
          thresholds,
        });
        const status: ApprovalStatus = required ? 'pending' : 'auto_approved';

        const rows = await tx.execute<{ id: string }>(sql`
          insert into approvals.approval_requests
            (org_id, type, status, requested_by, branch_id, amount_poisha, payload, reason, decided_at)
          values (
            ${context.orgId},
            ${input.type}::approvals.approval_type,
            ${status}::approvals.approval_status,
            ${context.userId},
            ${branchId}::uuid,
            ${input.amountPoisha === null ? null : input.amountPoisha.toString()},
            ${JSON.stringify(input.payload ?? {})}::jsonb,
            ${input.reason ?? null},
            ${required ? null : sql`now()`}
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
          before: null,
          after: {
            type: input.type,
            status,
            branchId,
            amountPoisha: input.amountPoisha?.toString() ?? null,
            required,
            reason: input.reason ?? null,
            // The payload is the *intent* — what will be executed once this is
            // approved — so the log is not much use without it. `AuditService`
            // redacts on the way in, which is why this can be passed through
            // rather than each caller remembering to scrub it.
            payload: input.payload ?? {},
          },
          requestId: context.requestId,
          ...(input.request === undefined ? {} : { request: input.request }),
        });

        // §19: `approval.requested` goes to every eligible checker. Ids and
        // non-sensitive fields only; the amount is visible to every checker.
        this.emit({
          name: 'approval.requested',
          orgId: context.orgId,
          payload: {
            id,
            type: input.type,
            amountPoisha: input.amountPoisha?.toString() ?? null,
            required,
            status,
          },
        });

        // Below the threshold the request is decided the moment it exists, so
        // the requester hears about the decision exactly as they would from a
        // checker — the client does not need a second code path.
        if (!required) {
          this.emit({
            name: 'approval.decided',
            orgId: context.orgId,
            payload: { id, decision: 'auto_approved', requestedBy: context.userId },
          });
        }

        return { id, required, status };
      });
    } catch (error) {
      // The composite FK: a branch that does not exist in this org. The same
      // answer whether it exists elsewhere or nowhere, so it is not an oracle.
      if (pgCode(error) === '23503') throw new BadRequestException('No such branch.');
      throw error;
    }
  }

  /**
   * The branch a request is about, checked against the requester's scope.
   *
   * A branch-scoped requester (a branch manager with branches assigned) may
   * only raise requests for their own branches, and when they name none and
   * hold exactly one, it is theirs. An org-wide requester may name any branch
   * in the org, or none for an org-level action. The composite foreign key is
   * what stops a branch from another org being named at all (D-047).
   *
   * No HTTP request means a system caller — a job — which has no role scope.
   */
  private branchForRequest(
    request: AuditableRequest | undefined,
    requested: string | undefined,
    userId: string,
  ): string | null {
    if (request === undefined) return requested ?? null;

    const filter = scopeOf(request);
    let branchId = requested ?? null;

    if (branchId === null && filter.kind === 'some') {
      const branches = filter.anyOf.flatMap((condition) =>
        condition.field === 'branchId' ? [...condition.in] : [],
      );
      if (branches.length === 1) branchId = branches[0] ?? null;
    }

    // A request is always the requester's own, so `createdBy` is them; the
    // branch is what a branch-scoped requester can get wrong.
    try {
      assertInScope(request, { branchId, createdBy: userId });
    } catch {
      throw new ForbiddenException(
        'You can only raise requests for your own branches. Name one of them as branchId.',
      );
    }
    return branchId;
  }

  async decide(
    context: ActiveContext,
    input: {
      id: string;
      decision: 'approved' | 'rejected';
      note?: string;
      request: AuditableRequest;
    },
  ): Promise<{ id: string; status: ApprovalStatus }> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await tx.execute<{
        id: string;
        status: ApprovalStatus;
        requested_by: string;
        branch_id: string | null;
        type: ApprovalType;
        amount_poisha: string | null;
      }>(sql`
        select id, status, requested_by, branch_id, type, amount_poisha
        from approvals.approval_requests
        where id = ${input.id}
        for update
      `);

      const row = rows[0];
      // RLS already scoped this to the active org, so "not found" and "another
      // org's request" are the same answer — which is what we want it to be.
      if (row === undefined) throw new NotFoundException('No such approval request.');

      // And the caller's own reach within the org: a branch manager scoped to
      // branch A gets the same "not found" for branch B's request (§6).
      assertInScope(input.request, { branchId: row.branch_id, createdBy: row.requested_by });

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
      const tier = checkerTier(context.roles, row.type, context.isSuperAdmin);
      if (tier === null || !canDecideType(context.roles, row.type, context.isSuperAdmin)) {
        throw new ForbiddenException(
          `Your role cannot decide a ${row.type} request in this organization.`,
        );
      }

      /*
       * §6: a branch manager checks "branch items **under threshold**".
       *
       * So a checker whose only qualifying role is branch-tier may decide a
       * request only when it is about a branch, and only when its amount is
       * under the org's configured threshold for its type. No threshold, or no
       * amount, means nothing is "under" it — fail closed, and the request
       * waits for an org-level checker. Without this a showroom manager could
       * approve any amount for any branch in the org.
       */
      if (tier === 'branch') {
        if (row.branch_id === null) {
          throw new ForbiddenException('A branch manager can only decide a branch request.');
        }
        const threshold = (await this.thresholdsFor(tx, context.orgId)).find(
          (entry) => entry.type === row.type,
        );
        const amount = row.amount_poisha === null ? null : BigInt(row.amount_poisha);
        const magnitude = amount === null ? null : amount < 0n ? -amount : amount;
        if (
          threshold === undefined ||
          magnitude === null ||
          magnitude >= threshold.thresholdPoisha
        ) {
          throw new ForbiddenException(
            'This request is at or above the threshold a branch manager may approve. It needs an org-level checker.',
          );
        }
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
        before: { status: row.status, decidedBy: null },
        after: { status: input.decision, decidedBy: context.userId, note: input.note ?? null },
        requestId: context.requestId,
        request: input.request,
      });

      // §19: `approval.decided` goes back to the requester.
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
   * Two filters, and both must hold:
   *
   * 1. **Scope** (`scopeWhere`): the rows the matrix lets this caller reach for
   *    `read ApprovalRequest` — the whole org for org_admin, accounts and hr,
   *    their own branches for a branch manager.
   * 2. **Relevance**: within that, a checker sees what they may decide, and
   *    everyone sees what they raised. Accounts does not need hr's payroll
   *    runs in their queue, and hr has no business reading supplier payments
   *    with amounts.
   */
  async list(context: ActiveContext, request: object): Promise<ApprovalRequestRow[]> {
    const scope = scopeWhere(request, {
      createdBy: sql`requested_by`,
      branchId: sql`branch_id`,
    });

    const decidable = context.isSuperAdmin
      ? [...APPROVAL_TYPES]
      : [...new Set(context.roles.flatMap((role) => [...(CHECKER_TYPES[role] ?? [])]))];

    // One bound parameter per type, joined — never a JS array interpolated
    // into `any(...)`, which Drizzle expands into a parenthesised list and
    // PostgreSQL rejects. That was a 500 on this route for every caller.
    const relevant =
      decidable.length === 0
        ? sql`false`
        : sql`type::text in (${sql.join(
            decidable.map((type) => sql`${type}`),
            sql`, `,
          )})`;

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await tx.execute<{
        id: string;
        type: ApprovalType;
        status: ApprovalStatus;
        requested_by: string;
        branch_id: string | null;
        amount_poisha: string | null;
        decided_by: string | null;
      }>(sql`
        select id, type, status, requested_by, branch_id, amount_poisha, decided_by
        from approvals.approval_requests
        where ${scope}
          and (requested_by = ${context.userId} or ${relevant})
        order by created_at desc
        limit 100
      `);

      return [...rows].map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        requestedBy: row.requested_by,
        branchId: row.branch_id,
        amountPoisha: row.amount_poisha,
        decidedBy: row.decided_by,
      }));
    });
  }

  /**
   * Set an org's threshold for one action type.
   *
   * Behind `update ApprovalThreshold`, which only org_admin holds (§6
   * "settings"). A threshold decides whether maker-checker applies at all, so
   * whoever sets it can exempt requests from a second person — which is why it
   * is audited in the same transaction, with the old value alongside the new.
   */
  async setThreshold(
    context: ActiveContext,
    input: { type: ApprovalType; thresholdPoisha: bigint; request?: AuditableRequest },
  ): Promise<{ type: ApprovalType; thresholdPoisha: string }> {
    if (input.thresholdPoisha < 0n) {
      throw new BadRequestException('A threshold cannot be negative.');
    }

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const previous = (await this.thresholdsFor(tx, context.orgId)).find(
        (entry) => entry.type === input.type,
      );

      const rows = await tx.execute<{ id: string }>(sql`
        insert into approvals.approval_thresholds (org_id, type, threshold_poisha)
        values (${context.orgId}, ${input.type}::approvals.approval_type, ${input.thresholdPoisha.toString()})
        on conflict (org_id, type) do update
          set threshold_poisha = excluded.threshold_poisha, updated_at = now()
        returning id
      `);

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: previous === undefined ? 'create' : 'update',
        action: `approval.threshold_set:${input.type}`,
        entityType: 'ApprovalThreshold',
        entityId: rows[0]?.id ?? input.type,
        before:
          previous === undefined
            ? null
            : { type: input.type, thresholdPoisha: previous.thresholdPoisha.toString() },
        after: { type: input.type, thresholdPoisha: input.thresholdPoisha.toString() },
        requestId: context.requestId,
        ...(input.request === undefined ? {} : { request: input.request }),
      });

      return { type: input.type, thresholdPoisha: input.thresholdPoisha.toString() };
    });
  }
}
