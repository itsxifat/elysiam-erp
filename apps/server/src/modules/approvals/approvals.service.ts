import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  APPROVAL_TYPES,
  BRANCH_TIER_CHECKERS,
  canDecideType,
  canReadCost,
  canRequestType,
  CHECKER_TYPES,
  checkerTier,
  COST_VALUED_APPROVAL_TYPES,
  NEVER_AUTO_APPROVE_TYPES,
  NO_AMOUNT_APPROVAL_TYPES,
  rowInScope,
  scopeFilterFor,
  SERVER_DERIVED_AMOUNT_TYPES,
} from '@elysium/contracts';
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
 * 2. The database: `approval_requests_maker_is_not_checker`, the
 *    never-auto-approved CHECK, and the trigger that fixes a request's terms
 *    from the moment it is raised (migrations 0009–0011). A service can be
 *    refactored, called from a job, or bypassed by the next module; those
 *    cannot.
 * 3. The permission matrix plus the per-type lists (`REQUESTER_TYPES`,
 *    `CHECKER_TYPES`), which decide who may raise and who may decide what.
 *
 * **Below the threshold is auto-approved (D-068)**, but only where the
 * threshold can be trusted to mean something: never for a control type
 * (D-071), never for an amount the requester typed that the owning module
 * should have derived (D-072), and only against a threshold that a second org
 * admin agreed to if it was ever relaxed (D-073).
 */

export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'auto_approved';

export interface ApprovalRequestRow {
  readonly id: string;
  readonly type: ApprovalType;
  readonly status: ApprovalStatus;
  readonly requestedBy: string;
  readonly branchId: string | null;
  /** Null when the type has no amount, or when it is withheld (D-074). */
  readonly amountPoisha: string | null;
  /** True when this caller may not see a cost-valued amount (invariant 5). */
  readonly amountWithheld: boolean;
  readonly decidedBy: string | null;
}

/** What the outbox will carry once M04 exists (§19, §27). */
export interface DomainEvent {
  readonly name: 'approval.requested' | 'approval.decided';
  readonly orgId: string;
  readonly payload: Record<string, unknown>;
}

/** How many events are kept in memory until M04 replaces this (D-067). */
const RETAINED_EVENTS = 500;

/** The PostgreSQL error a row fails with, found through Drizzle's wrapper. */
function pgCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function magnitude(amount: bigint): bigint {
  return amount < 0n ? -amount : amount;
}

@Injectable()
export class ApprovalsService {
  /** Collected in memory until M04's outbox (D-067). See `publish` below. */
  readonly emitted: DomainEvent[] = [];

  constructor(private readonly audit: AuditService) {}

  /**
   * Events, held rather than published (D-067).
   *
   * Each method collects its events in a local list and hands them here only
   * after its transaction has committed, so a rolled-back request announces
   * nothing — the property the M04 outbox gets from `enqueue(tx, …)`. Bounded,
   * because a list that only ever grows is a memory leak in a long-lived API
   * process. M04 replaces this body, not the call sites.
   */
  private publish(events: readonly DomainEvent[]): void {
    this.emitted.push(...events);
    if (this.emitted.length > RETAINED_EVENTS) {
      this.emitted.splice(0, this.emitted.length - RETAINED_EVENTS);
    }
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
   * Does no threshold apply to this request, whatever it says?
   *
   * Control types never (D-071), and a server-derived amount typed by the
   * requester never (D-072) — only the owning module, passing
   * `amountDerivedByServer`, lets the threshold decide for those.
   */
  private alwaysRequired(type: ApprovalType, amountDerivedByServer: boolean): boolean {
    if (NEVER_AUTO_APPROVE_TYPES.includes(type)) return true;
    return SERVER_DERIVED_AMOUNT_TYPES.includes(type) && !amountDerivedByServer;
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
    input: { type: ApprovalType; amountPoisha: bigint | null; amountDerivedByServer?: boolean },
  ): Promise<boolean> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) =>
      requiresApproval({
        type: input.type,
        amountPoisha: input.amountPoisha,
        thresholds: await this.thresholdsFor(tx, context.orgId),
        alwaysRequired: this.alwaysRequired(input.type, input.amountDerivedByServer ?? false),
      }),
    );
  }

  /** An event payload every recipient may see: no cost-valued amount (D-074). */
  private eventAmount(type: ApprovalType, amount: bigint | null): Record<string, unknown> {
    if (COST_VALUED_APPROVAL_TYPES.includes(type)) {
      return { amountPoisha: null, amountWithheld: true };
    }
    return { amountPoisha: amount?.toString() ?? null };
  }

  async request(
    context: ActiveContext,
    input: {
      type: ApprovalType;
      amountPoisha: bigint | null;
      payload?: Record<string, unknown>;
      reason?: string;
      branchId?: string;
      /**
       * Set only by the module that owns the type and computed the amount
       * itself (M07 WAC, M19 payroll…). The generic HTTP route never sets it.
       */
      amountDerivedByServer?: boolean;
      /** The HTTP request: carries the caller's scope, and tells the audit net to stand down. */
      request?: AuditableRequest;
    },
  ): Promise<{ id: string; required: boolean; status: ApprovalStatus }> {
    // Who may raise what (D-072). `threshold_change` is never raised here.
    if (!canRequestType(context.roles, input.type, context.isSuperAdmin)) {
      throw new ForbiddenException(
        `Your role cannot raise a ${input.type} request in this organization.`,
      );
    }

    // The schema checks this at the edge; a job calling the service directly
    // does not pass through the edge.
    const amountless = NO_AMOUNT_APPROVAL_TYPES.includes(input.type);
    if (amountless !== (input.amountPoisha === null)) {
      throw new BadRequestException(
        amountless
          ? `A ${input.type} request carries no amount.`
          : `A ${input.type} request needs an amount.`,
      );
    }

    const branchId = this.branchForRequest(input.request, input.branchId, context.userId);
    const events: DomainEvent[] = [];

    try {
      const result = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const thresholds = await this.thresholdsFor(tx, context.orgId);
        const threshold = thresholds.find((entry) => entry.type === input.type);
        const required = requiresApproval({
          type: input.type,
          amountPoisha: input.amountPoisha,
          thresholds,
          alwaysRequired: this.alwaysRequired(input.type, input.amountDerivedByServer ?? false),
        });
        const status: ApprovalStatus = required ? 'pending' : 'auto_approved';

        const rows = await tx.execute<{ id: string }>(sql`
            insert into approvals.approval_requests
              (org_id, type, status, requested_by, branch_id, amount_poisha, threshold_poisha,
               payload, reason, decided_at)
            values (
              ${context.orgId},
              ${input.type}::approvals.approval_type,
              ${status}::approvals.approval_status,
              ${context.userId},
              ${branchId}::uuid,
              ${input.amountPoisha === null ? null : input.amountPoisha.toString()},
              ${threshold === undefined ? null : threshold.thresholdPoisha.toString()},
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
            // What decided "needs a second person", as it stood (D-073).
            thresholdPoisha: threshold?.thresholdPoisha.toString() ?? null,
            required,
            reason: input.reason ?? null,
            // The payload is the *intent* — what will be executed once this
            // is approved. `AuditService` redacts on the way in.
            payload: input.payload ?? {},
          },
          requestId: context.requestId,
          ...(input.request === undefined ? {} : { request: input.request }),
        });

        // §19: `approval.requested` goes to every eligible checker.
        events.push({
          name: 'approval.requested',
          orgId: context.orgId,
          payload: {
            id,
            type: input.type,
            ...this.eventAmount(input.type, input.amountPoisha),
            required,
            status,
          },
        });

        // Below the threshold the request is decided the moment it exists, so
        // the requester hears about it exactly as they would from a checker.
        if (!required) {
          events.push({
            name: 'approval.decided',
            orgId: context.orgId,
            payload: { id, decision: 'auto_approved', requestedBy: context.userId },
          });
        }

        return { id, required, status };
      });

      this.publish(events);
      return result;
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
    const events: DomainEvent[] = [];

    const result = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await tx.execute<{
        id: string;
        status: ApprovalStatus;
        requested_by: string;
        branch_id: string | null;
        type: ApprovalType;
        amount_poisha: string | null;
        threshold_poisha: string | null;
        payload: Record<string, unknown>;
      }>(sql`
        select id, status, requested_by, branch_id, type, amount_poisha, threshold_poisha, payload
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
       * Checked before maker≠checker so a checker who may not touch this type
       * is told that, rather than being told they raised it.
       */
      const tier = checkerTier(context.roles, row.type, context.isSuperAdmin);
      if (tier === null || !canDecideType(context.roles, row.type, context.isSuperAdmin)) {
        throw new ForbiddenException(
          `Your role cannot decide a ${row.type} request in this organization.`,
        );
      }

      if (tier === 'branch') await this.assertBranchTier(tx, context, row);

      const verdict = canDecide({
        requestedBy: row.requested_by,
        decidedBy: context.userId,
        status: row.status,
      });

      if (!verdict.ok) {
        // 403 for self-approval, 409 for an already-decided request: one is a
        // permission answer and the other is a state answer.
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

      // An approved threshold relaxation takes effect now, in the same
      // transaction as the decision that authorised it (D-073).
      if (row.type === 'threshold_change' && input.decision === 'approved') {
        await this.applyThreshold(tx, context, row.payload, input.id);
      }

      // §19: `approval.decided` goes back to the requester.
      events.push({
        name: 'approval.decided',
        orgId: context.orgId,
        payload: { id: input.id, decision: input.decision, requestedBy: row.requested_by },
      });

      return { id: input.id, status: input.decision };
    });

    this.publish(events);
    return result;
  }

  /**
   * §6: a branch manager checks "branch items **under threshold**".
   *
   * Two conditions, both judged on the branch-tier roles alone:
   *
   * 1. **The branch is theirs.** Not the caller's scope unioned across roles:
   *    `hr` + `branch_manager@A` has org-wide `approve` through hr, so the
   *    union let them approve branch B's write-off — which hr may not check at
   *    all and branch_manager may not check outside A (re-audit C2).
   * 2. **The amount is under the threshold** — both the one captured when the
   *    request was raised and the one configured now, so neither a stale nor a
   *    freshly raised threshold widens it. No threshold, or no amount, means
   *    nothing is "under": fail closed, wait for an org-level checker.
   */
  private async assertBranchTier(
    tx: Tx,
    context: ActiveContext,
    row: {
      readonly type: ApprovalType;
      readonly branch_id: string | null;
      readonly amount_poisha: string | null;
      readonly threshold_poisha: string | null;
    },
  ): Promise<void> {
    const branchTierRoles = context.roles.filter((role) => BRANCH_TIER_CHECKERS.includes(role));
    const filter = scopeFilterFor(
      {
        roles: branchTierRoles,
        isSuperAdmin: false,
        userId: context.userId,
        branchIds: context.branchIds,
        ...(context.branchIdsByRole === undefined
          ? {}
          : { branchIdsByRole: context.branchIdsByRole }),
      },
      'approve',
      'ApprovalRequest',
    );

    if (row.branch_id === null || !rowInScope(filter, { branchId: row.branch_id })) {
      throw new ForbiddenException(
        'A branch manager can only decide requests about their own branches.',
      );
    }

    const current = (await this.thresholdsFor(tx, context.orgId)).find(
      (entry) => entry.type === row.type,
    );
    const captured = row.threshold_poisha === null ? null : BigInt(row.threshold_poisha);
    const amount = row.amount_poisha === null ? null : magnitude(BigInt(row.amount_poisha));

    const under =
      current !== undefined &&
      captured !== null &&
      amount !== null &&
      amount < current.thresholdPoisha &&
      amount < captured;

    if (!under) {
      throw new ForbiddenException(
        'This request is at or above the threshold a branch manager may approve. It needs an org-level checker.',
      );
    }
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
   *    everyone sees what they raised (D-063).
   *
   * A cost-valued amount — a write-off at WAC — is withheld from a caller who
   * cannot read cost (D-074, invariant 5).
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

    const seesCost = canReadCost(context.roles, context.isSuperAdmin);

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

      return [...rows].map((row) => {
        const withheld = !seesCost && COST_VALUED_APPROVAL_TYPES.includes(row.type);
        return {
          id: row.id,
          type: row.type,
          status: row.status,
          requestedBy: row.requested_by,
          branchId: row.branch_id,
          amountPoisha: withheld ? null : row.amount_poisha,
          amountWithheld: withheld,
          decidedBy: row.decided_by,
        };
      });
    });
  }

  /**
   * Set an org's threshold for one approval type (D-065, D-073).
   *
   * **Tightening applies at once; relaxing needs a second org admin.** A
   * threshold decides which requests skip the second person, so an org admin
   * who could raise it could raise it, auto-approve their own request, and
   * lower it again — maker-checker bypassed by the maker alone. So a raise —
   * including the first threshold for a type, which relaxes "always checked"
   * into "checked above X" — becomes a `threshold_change` request that another
   * org admin (or super admin) must approve, and only takes effect then.
   * Lowering one only ever asks for *more* checking, and applies immediately.
   */
  async setThreshold(
    context: ActiveContext,
    input: { type: ApprovalType; thresholdPoisha: bigint; request?: AuditableRequest },
  ): Promise<{
    type: ApprovalType;
    thresholdPoisha: string;
    status: 'applied' | 'pending_approval';
    approvalId?: string;
  }> {
    if (input.thresholdPoisha < 0n) {
      throw new BadRequestException('A threshold cannot be negative.');
    }
    if (NEVER_AUTO_APPROVE_TYPES.includes(input.type)) {
      throw new BadRequestException(
        'That approval type always needs a second person; it cannot have a threshold.',
      );
    }

    const events: DomainEvent[] = [];

    const result = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const previous = (await this.thresholdsFor(tx, context.orgId)).find(
        (entry) => entry.type === input.type,
      );

      if (previous !== undefined && input.thresholdPoisha <= previous.thresholdPoisha) {
        await this.applyThreshold(
          tx,
          context,
          { type: input.type, thresholdPoisha: input.thresholdPoisha.toString() },
          null,
          input.request,
        );
        return {
          type: input.type,
          thresholdPoisha: input.thresholdPoisha.toString(),
          status: 'applied' as const,
        };
      }

      const payload = {
        type: input.type,
        thresholdPoisha: input.thresholdPoisha.toString(),
        previousPoisha: previous?.thresholdPoisha.toString() ?? null,
      };

      const rows = await tx.execute<{ id: string }>(sql`
        insert into approvals.approval_requests (org_id, type, requested_by, payload, reason)
        values (
          ${context.orgId},
          'threshold_change'::approvals.approval_type,
          ${context.userId},
          ${JSON.stringify(payload)}::jsonb,
          ${`Relax the ${input.type} threshold`}
        )
        returning id
      `);
      const id = rows[0]?.id;
      if (id === undefined) throw new ConflictException('Could not record the request.');

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'approval.requested:threshold_change',
        entityType: 'ApprovalRequest',
        entityId: id,
        before: null,
        after: { status: 'pending', required: true, payload },
        requestId: context.requestId,
        ...(input.request === undefined ? {} : { request: input.request }),
      });

      events.push({
        name: 'approval.requested',
        orgId: context.orgId,
        payload: {
          id,
          type: 'threshold_change',
          amountPoisha: null,
          required: true,
          status: 'pending',
        },
      });

      return {
        type: input.type,
        thresholdPoisha: input.thresholdPoisha.toString(),
        status: 'pending_approval' as const,
        approvalId: id,
      };
    });

    this.publish(events);
    return result;
  }

  /** Write a threshold and its audit row, in the caller's transaction. */
  private async applyThreshold(
    tx: Tx,
    context: ActiveContext,
    change: Record<string, unknown>,
    approvalId: string | null,
    request?: AuditableRequest,
  ): Promise<void> {
    const type = change.type;
    const value = change.thresholdPoisha;
    if (typeof type !== 'string' || typeof value !== 'string' || !/^\d+$/.test(value)) {
      throw new ConflictException('This threshold change is malformed and cannot be applied.');
    }

    const previous = (await this.thresholdsFor(tx, context.orgId)).find(
      (entry) => entry.type === type,
    );

    const rows = await tx.execute<{ id: string }>(sql`
      insert into approvals.approval_thresholds (org_id, type, threshold_poisha)
      values (${context.orgId}, ${type}::approvals.approval_type, ${value})
      on conflict (org_id, type) do update
        set threshold_poisha = excluded.threshold_poisha, updated_at = now()
      returning id
    `);

    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: previous === undefined ? 'create' : 'update',
      action: `approval.threshold_set:${type}`,
      entityType: 'ApprovalThreshold',
      entityId: rows[0]?.id ?? type,
      before:
        previous === undefined
          ? null
          : { type, thresholdPoisha: previous.thresholdPoisha.toString() },
      after: {
        type,
        thresholdPoisha: value,
        approvedBy: approvalId === null ? null : context.userId,
        approvalId,
      },
      requestId: context.requestId,
      ...(request === undefined ? {} : { request }),
    });
  }
}
