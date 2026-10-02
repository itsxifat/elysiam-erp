import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  APPROVAL_TYPES,
  BRANCH_ITEM_APPROVAL_TYPES,
  BRANCH_TIER_CHECKERS,
  canDecideType,
  canReadCost,
  canRequestType,
  CHECKER_TYPES,
  checkerTier,
  COST_VALUED_APPROVAL_TYPES,
  NEVER_AUTO_APPROVE_TYPES,
  NO_AMOUNT_APPROVAL_TYPES,
  REQUESTER_TYPES,
  rowInScope,
  scopeFilterFor,
  SERVER_DERIVED_AMOUNT_TYPES,
  type ScopeCondition,
  type ScopeFilter,
} from '@elysium/contracts';
import { canDecide, requiresApproval, type Threshold } from '@elysium/domain';
import { withOrg, type Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { emit } from '../../platform/events/outbox.js';
import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeWhere } from '../../platform/auth/scope.js';
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
  /** For a `threshold_change`: which type, from what, to what (final pass W2). */
  readonly thresholdChange: ThresholdChangeTerms | null;
  readonly decidedBy: string | null;
}

/** One row for `events.outbox`, named from the §19 catalog. */
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

/**
 * What a `threshold_change` would do, for the checker deciding it (final pass
 * W2). The row has no amount, so without this the checker approved blind.
 */
export interface ThresholdChangeTerms {
  readonly targetType: string;
  readonly fromPoisha: string | null;
  readonly toPoisha: string;
}

function thresholdChangeTerms(
  type: ApprovalType,
  payload: Record<string, unknown>,
): ThresholdChangeTerms | null {
  if (type !== 'threshold_change') return null;
  const target = payload.type;
  const to = payload.thresholdPoisha;
  const from = payload.previousPoisha;
  if (typeof target !== 'string' || typeof to !== 'string') return null;
  return { targetType: target, fromPoisha: typeof from === 'string' ? from : null, toPoisha: to };
}

/**
 * What an approved request does, run by the module that owns its type.
 *
 * Called inside the transaction that approved it — the decision and its
 * effect commit together or not at all, as a threshold change already did
 * (D-073). The executor reads `amountPoisha` and nothing else for money
 * (D-078), and validates the frozen payload with its own schema.
 */
export interface ApprovedRequest {
  readonly id: string;
  readonly type: ApprovalType;
  readonly requestedBy: string;
  readonly branchId: string | null;
  readonly amountPoisha: bigint | null;
  readonly payload: Record<string, unknown>;
}

export type ApprovalExecutor = (
  tx: Tx,
  input: {
    readonly context: ActiveContext;
    readonly approval: ApprovedRequest;
    readonly request: AuditableRequest | undefined;
  },
) => Promise<void>;

/**
 * What a rejected request undoes, run by the module that owns its type (D-299).
 *
 * Inside the transaction that rejected it, like an executor, so a rejected repayment is
 * never left looking like it is still waiting. Optional: most owning modules have nothing
 * to release, and M25's withdrawals keep their own reject route.
 */
export type RejectionHandler = ApprovalExecutor;

/**
 * What `registerExecutor` hands the module that owns a type: the power to withdraw a
 * pending request of that type, and only that type (gaps-users-auth, D-409).
 */
export interface OwnedApprovalType {
  cancel(
    tx: Tx,
    context: ActiveContext,
    input: {
      readonly id: string;
      readonly reason: string;
      readonly request?: AuditableRequest | undefined;
    },
  ): Promise<boolean>;
}

/**
 * Types whose approval means nothing without an executor. Approving one with
 * no executor registered is refused rather than recorded as done: a period
 * reopen that says "approved" while the period stays closed is worse than an
 * error (M03).
 *
 * `settlement_posting` is here for the same reason and a sharper version of it (M12): the
 * courier module's executor is the only thing that posts a settlement's two journals, so a
 * deployment that served `POST /v1/approvals/:id/decide` without `CourierModule` loaded would
 * record the decision as `approved` with the books unmoved — and `canDecide` requires `pending`,
 * so the request could never be decided again. A settlement whose COD is already in the bank
 * would be unpostable, permanently.
 */
const EXECUTOR_REQUIRED_TYPES: readonly ApprovalType[] = [
  'period_reopen',
  'settlement_posting',
  // M26: only the loans module's executor posts a repayment; approved without it, the
  // repayment would wait forever and block every later instalment (D-298).
  'loan_repayment',
  // gaps-users-auth: only the iam module's executor resets a second factor or releases a
  // password link; "approved" with nothing done would leave the person locked out (D-404).
  'credential_reset',
];

/**
 * Types only their owning module may raise, because the module writes the
 * payload the executor acts on: `period_reopen` through
 * `POST /v1/ledger/periods/reopen` (D-081).
 *
 * `settlement_posting` is here for the hazard D-081 names: the courier module's executor reads
 * `payload.settlementId` and posts whatever it names, so a requester who could write that
 * payload by hand through the generic route could aim an approval at a batch nobody reconciled.
 * Two other layers already refuse it — `SettlementsService.executePosting` checks that the batch
 * names *this* approval, and migration 0052 checks `payload->>'settlementId'` against the row —
 * so this entry is belt-and-braces rather than the defence itself.
 */
export const MODULE_RAISED_TYPES: readonly ApprovalType[] = [
  'period_reopen',
  'settlement_posting',
  // M26: the payload names a waiting repayment, and the amount is its instalment's (D-298).
  'loan_repayment',
  // gaps-users-auth: the payload names whose sign-in is reset; only `/v1/users/:id/...`
  // writes it, after checking who may reset whom (D-404).
  'credential_reset',
];

function magnitude(amount: bigint): bigint {
  return amount < 0n ? -amount : amount;
}

@Injectable()
export class ApprovalsService {
  private readonly executors = new Map<ApprovalType, ApprovalExecutor>();
  private readonly rejectionHandlers = new Map<ApprovalType, RejectionHandler>();

  constructor(private readonly audit: AuditService) {}

  /**
   * Register what approving a type does. One executor per type, registered
   * by the owning module when it starts (the ledger registers
   * `period_reopen`); a second registration is a wiring mistake.
   */
  registerExecutor(type: ApprovalType, executor: ApprovalExecutor): OwnedApprovalType {
    if (this.executors.has(type)) {
      throw new Error(`An executor for ${type} is already registered.`);
    }
    this.executors.set(type, executor);
    // The withdrawal handle goes to the module that owns the type and nobody else, so
    // one module cannot cancel another's requests (the ledger audit's N5).
    return {
      cancel: (tx, context, input) => this.cancelRaisedByModule(tx, context, { ...input, type }),
    };
  }

  /** Register what rejecting a type releases (D-299). One per type, like an executor. */
  registerRejectionHandler(type: ApprovalType, handler: RejectionHandler): void {
    if (this.rejectionHandlers.has(type)) {
      throw new Error(`A rejection handler for ${type} is already registered.`);
    }
    this.rejectionHandlers.set(type, handler);
  }

  private async execute(
    tx: Tx,
    context: ActiveContext,
    approval: ApprovedRequest,
    request: AuditableRequest | undefined,
  ): Promise<void> {
    const executor = this.executors.get(approval.type);
    if (executor === undefined) {
      if (EXECUTOR_REQUIRED_TYPES.includes(approval.type)) {
        throw new ConflictException(`Nothing is set up to carry out a ${approval.type} yet.`);
      }
      return;
    }
    await executor(tx, { context, approval, request });
  }

  /**
   * Events, written to the outbox **inside the caller's transaction** (§19).
   *
   * They used to be collected in a local list and handed to an in-memory ring
   * after commit. That got the rollback property right — a rolled-back request
   * announced nothing — and got everything else wrong: the events lived in one
   * process's heap, so a replica never saw them, a restart lost them, and
   * `.claude/rules`' "realtime events go only through the outbox" was not true.
   *
   * Now the row commits with the change that caused it. The dispatcher reads it
   * afterwards, which is what makes §19's "emit only after commit" structural:
   * there is no code path from here to a socket.
   */
  private async writeEvents(tx: Tx, orgId: string, events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      await emit(tx, event.name, event.payload as never, { orgId });
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
    // Branch items go to a branch-tier checker, never auto-approved (D-076).
    if (BRANCH_ITEM_APPROVAL_TYPES.includes(type)) return true;
    return SERVER_DERIVED_AMOUNT_TYPES.includes(type) && !amountDerivedByServer;
  }

  /**
   * Would this action need a second person?
   *
   * Exposed so a caller can ask before doing the work — the preview and the
   * enforcement read the same pure function (`requiresApproval`), which is why
   * it lives in the domain rather than here.
   */
  /**
   * Is a request of this type already pending whose payload names this value
   * under this key? Lets an owning module refuse a duplicate (a second reopen
   * of the same period) without reading this module's tables (invariant 12).
   */
  async hasPending(
    context: ActiveContext,
    input: { type: ApprovalType; payloadKey: string; value: string },
  ): Promise<boolean> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await tx.execute<{ found: boolean }>(sql`
        select exists (
          select 1 from approvals.approval_requests
          where org_id = ${context.orgId}
            and type = ${input.type}::approvals.approval_type
            and status = 'pending'
            and payload ->> ${input.payloadKey} = ${input.value}
        ) as found
      `);
      return rows[0]?.found === true;
    });
  }

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
      /**
       * Set only by the module that owns a type in MODULE_RAISED_TYPES, which
       * builds and validates the payload itself (M03 security review M1).
       */
      raisedByModule?: boolean;
      /** The HTTP request: carries the caller's scope, and tells the audit net to stand down. */
      request?: AuditableRequest;
      /**
       * The owning module's own transaction, so the request and the module's row that
       * names it commit together or not at all (gaps-users-auth, the ledger audit's W3).
       * Omitted, the request opens its own.
       */
      tx?: Tx;
    },
  ): Promise<{ id: string; required: boolean; status: ApprovalStatus }> {
    // A type whose payload decides what gets executed is raised only by its
    // owning module. A period_reopen with a hand-written payload could name one
    // month in its label and another in its periodId (security review M1).
    if (MODULE_RAISED_TYPES.includes(input.type) && input.raisedByModule !== true) {
      throw new BadRequestException(
        `A ${input.type} request is raised through its own endpoint, not this one.`,
      );
    }

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

    const branchId = this.requesterBranch(context, input.type, input.branchId, input.request);
    const events: DomainEvent[] = [];

    try {
      const work = async (tx: Tx) => {
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
               amount_derived_by_server, payload, reason, decided_at)
            values (
              ${context.orgId},
              ${input.type}::approvals.approval_type,
              ${status}::approvals.approval_status,
              ${context.userId},
              ${branchId}::uuid,
              ${input.amountPoisha === null ? null : input.amountPoisha.toString()},
              ${threshold === undefined ? null : threshold.thresholdPoisha.toString()},
              ${input.amountDerivedByServer ?? false},
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
            // Typed by a person, or computed by the owning module (D-072).
            amountDerivedByServer: input.amountDerivedByServer ?? false,
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

        // Below the threshold the request is decided the moment it exists, and
        // what it authorises happens in the same transaction.
        if (!required) {
          await this.execute(
            tx,
            context,
            {
              id,
              type: input.type,
              requestedBy: context.userId,
              branchId,
              amountPoisha: input.amountPoisha,
              payload: input.payload ?? {},
            },
            input.request,
          );
        }

        // Below the threshold the request is decided the moment it exists, so
        // the requester hears about it exactly as they would from a checker.
        if (!required) {
          events.push({
            name: 'approval.decided',
            orgId: context.orgId,
            payload: { id, decision: 'auto_approved', requestedBy: context.userId },
          });
        }

        await this.writeEvents(tx, context.orgId, events);
        return { id, required, status };
      };

      return input.tx === undefined
        ? await withOrg({ orgId: context.orgId, userId: context.userId }, work)
        : await work(input.tx);
    } catch (error) {
      // The composite FK: a branch that does not exist in this org. The same
      // answer whether it exists elsewhere or nowhere, so it is not an oracle.
      if (pgCode(error) === '23503') throw new BadRequestException('No such branch.');
      throw error;
    }
  }

  /**
   * The branches this caller may raise *this type* for (C-1, final ledger pass).
   *
   * Type rights and branch scope must come from the **same** role. The route's
   * scope is the union over all the caller's roles, so a branch manager at A
   * who is also warehouse (org-wide `request`) could raise a wallet
   * adjustment — a branch manager's type — for branch B or for no branch at
   * all, and have it auto-approved. So the filter here is the union, over only
   * the roles whose REQUESTER_TYPES include this type, of each role's own
   * `request ApprovalRequest` scope.
   */
  private requesterFilter(context: ActiveContext, type: ApprovalType): ScopeFilter {
    if (context.isSuperAdmin) return { kind: 'all' };

    const anyOf: ScopeCondition[] = [];
    for (const role of context.roles) {
      if (!(REQUESTER_TYPES[role] ?? []).includes(type)) continue;
      const filter = scopeFilterFor(
        {
          roles: [role],
          isSuperAdmin: false,
          userId: context.userId,
          branchIds: context.branchIds,
          branchIdsByRole: context.branchIdsByRole,
        },
        'request',
        'ApprovalRequest',
      );
      if (filter.kind === 'all') return filter;
      if (filter.kind === 'some') anyOf.push(...filter.anyOf);
    }
    return anyOf.length === 0 ? { kind: 'none' } : { kind: 'some', anyOf };
  }

  /**
   * The branch a request is about, checked against `requesterFilter`.
   *
   * A branch-scoped requester may only raise this type for their own branches
   * — never for no branch, which would make it an org-level request — and when
   * they name none and hold exactly one, it is theirs. An org-wide requester
   * may name any branch in the org, or none. The composite foreign key stops a
   * branch from another org being named at all (D-047).
   */
  private requesterBranch(
    context: ActiveContext,
    type: ApprovalType,
    requested: string | undefined,
    request: AuditableRequest | undefined,
  ): string | null {
    const filter = this.requesterFilter(context, type);
    let branchId = requested ?? null;

    if (branchId === null && filter.kind === 'some') {
      const branches = filter.anyOf.flatMap((condition) =>
        condition.field === 'branchId' ? [...condition.in] : [],
      );
      if (branches.length === 1) branchId = branches[0] ?? null;
    }

    if (!rowInScope(filter, { branchId, createdBy: context.userId })) {
      throw new ForbiddenException(
        'You can only raise this request for your own branches. Name one of them as branchId.',
      );
    }

    // The route's own scope is a superset, so this cannot refuse; it records
    // that the handler applied row scope (D-061).
    if (request !== undefined) assertInScope(request, { branchId, createdBy: context.userId });
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
        amount_derived_by_server: boolean;
        payload: Record<string, unknown>;
      }>(sql`
        select id, status, requested_by, branch_id, type, amount_poisha, threshold_poisha,
               amount_derived_by_server, payload
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

      if (!context.isSuperAdmin) await this.assertNotGrantedByRequester(tx, context, row);

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
        await this.assertThresholdUnchanged(tx, context, row.payload);
        await this.applyThreshold(tx, context, row.payload, input.id);
      }

      const decided: ApprovedRequest = {
        id: input.id,
        type: row.type,
        requestedBy: row.requested_by,
        branchId: row.branch_id,
        amountPoisha: row.amount_poisha === null ? null : BigInt(row.amount_poisha),
        payload: row.payload,
      };
      if (input.decision === 'approved') {
        await this.execute(tx, context, decided, input.request);
      } else {
        const release = this.rejectionHandlers.get(row.type);
        if (release !== undefined) {
          await release(tx, { context, approval: decided, request: input.request });
        }
      }

      // §19: `approval.decided` goes back to the requester.
      events.push({
        name: 'approval.decided',
        orgId: context.orgId,
        payload: { id: input.id, decision: input.decision, requestedBy: row.requested_by },
      });

      await this.writeEvents(tx, context.orgId, events);
      return { id: input.id, status: input.decision };
    });

    return result;
  }

  /**
   * Withdraw a pending request its owning module raised, because what it asked for no
   * longer makes sense (gaps-users-auth: the person whose sign-in it would reset has been
   * deactivated). Inside the caller's transaction, like an executor.
   *
   * Only for a type in `MODULE_RAISED_TYPES`: a request a person raised through the
   * generic route is theirs to have decided, not a module's to withdraw. Returns false
   * when the request is no longer pending — decided meanwhile, which is not an error.
   */
  private async cancelRaisedByModule(
    tx: Tx,
    context: ActiveContext,
    input: {
      readonly id: string;
      readonly type: ApprovalType;
      readonly reason: string;
      readonly request?: AuditableRequest | undefined;
    },
  ): Promise<boolean> {
    if (!MODULE_RAISED_TYPES.includes(input.type)) {
      throw new Error(`A ${input.type} request is not a module's to cancel.`);
    }
    const rows = await tx.execute<{ requested_by: string }>(sql`
      update approvals.approval_requests
      set status = 'cancelled'::approvals.approval_status,
          decision_note = ${input.reason},
          updated_at = now()
      where id = ${input.id}
        and type = ${input.type}::approvals.approval_type
        and status = 'pending'
      returning requested_by
    `);
    const row = rows[0];
    if (row === undefined) return false;

    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'update',
      action: `approval.cancelled:${input.type}`,
      entityType: 'ApprovalRequest',
      entityId: input.id,
      before: { status: 'pending' },
      after: { status: 'cancelled', note: input.reason },
      requestId: context.requestId,
      ...(input.request === undefined ? {} : { request: input.request }),
    });
    await this.writeEvents(tx, context.orgId, [
      {
        name: 'approval.decided',
        orgId: context.orgId,
        payload: { id: input.id, decision: 'cancelled', requestedBy: row.requested_by },
      },
    ]);
    return true;
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
      readonly amount_derived_by_server: boolean;
    },
  ): Promise<void> {
    // A typed amount cannot pick the checker (final pass W3, D-076): only an
    // amount the owning module computed is trusted to say "under threshold".
    if (!row.amount_derived_by_server) {
      throw new ForbiddenException(
        'A branch manager can only decide a request whose amount the system derived. This one needs an org-level checker.',
      );
    }

    const branchTierRoles = context.roles.filter((role) => BRANCH_TIER_CHECKERS.includes(role));
    const filter = scopeFilterFor(
      {
        roles: branchTierRoles,
        isSuperAdmin: false,
        userId: context.userId,
        branchIds: context.branchIds,
        branchIdsByRole: context.branchIdsByRole,
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
   * Nobody approves for whoever granted them the power to (D-077).
   *
   * Until M16 emails invites, `POST /v1/users` hands the new user's invite
   * token to the admin who created them — who can therefore set that user's
   * password and act as them. An org admin who mints a second "org admin" has
   * minted a puppet checker. So a checker may not decide a request raised by
   * anyone in the grant lineage of their memberships in this org: whoever
   * granted them, whoever granted that person, and so on. Transitive, because
   * X → Y → Z is the same puppet one step removed.
   */
  private async assertNotGrantedByRequester(
    tx: Tx,
    context: ActiveContext,
    row: { readonly requested_by: string },
  ): Promise<void> {
    /*
     * Every granter counts, not only the latest (gaps-users-auth, D-410): a re-grant or a
     * reset by a second admin overwrites `memberships.granted_by`, and the first granter —
     * who may have held the password link — would drop out of the lineage with it.
     * `iam.membership_granters` keeps them all.
     */
    const found = await tx.execute<{ hit: number }>(sql`
      with recursive grants (user_id, granted_by) as (
        select user_id, granted_by from iam.memberships
        where org_id = ${context.orgId} and granted_by is not null
        union
        select user_id, granted_by from iam.membership_granters
        where org_id = ${context.orgId}
      ),
      lineage (user_id, depth) as (
        select g.granted_by, 1
        from grants g
        where g.user_id = ${context.userId}
        union
        select g.granted_by, l.depth + 1
        from grants g
        join lineage l on g.user_id = l.user_id
        where l.depth < 16
      )
      select 1 as hit from lineage where user_id = ${row.requested_by} limit 1
    `);

    if (found.length > 0) {
      throw new ForbiddenException(
        'You cannot decide a request raised by the person who granted you your role, directly or through someone they granted.',
      );
    }
  }

  /**
   * An approved threshold change applies only over the value it was proposed
   * against (final pass W1).
   *
   * Otherwise: raise to X is proposed, the threshold is lowered meanwhile, and
   * approving the raise silently reverts the lowering. The row is locked so a
   * concurrent change waits, and a mismatch is a 409 — propose again.
   */
  private async assertThresholdUnchanged(
    tx: Tx,
    context: ActiveContext,
    change: Record<string, unknown>,
  ): Promise<void> {
    const type = change.type;
    if (typeof type !== 'string') {
      throw new ConflictException('This threshold change is malformed and cannot be applied.');
    }
    const [current] = await tx.execute<{ threshold_poisha: string }>(sql`
      select threshold_poisha::text as threshold_poisha from approvals.approval_thresholds
      where org_id = ${context.orgId} and type = ${type}::approvals.approval_type
      for update
    `);
    const proposedOver = change.previousPoisha ?? null;
    if ((current?.threshold_poisha ?? null) !== proposedOver) {
      throw new ConflictException(
        'The threshold has changed since this was proposed. Propose the change again.',
      );
    }
  }

  /**
   * One request, as a checker decides it (final pass W2): its frozen terms,
   * including what a threshold change would do. Scoped and filtered by
   * relevance exactly like the list, and a WAC-valued amount is withheld from
   * a caller who cannot read cost (D-074).
   */
  async get(context: ActiveContext, request: object, id: string) {
    const scope = scopeWhere(request, {
      createdBy: sql`requested_by`,
      branchId: sql`branch_id`,
    });

    const rows = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) =>
      tx.execute<{
        id: string;
        type: ApprovalType;
        status: ApprovalStatus;
        requested_by: string;
        branch_id: string | null;
        amount_poisha: string | null;
        amount_derived_by_server: boolean;
        threshold_poisha: string | null;
        payload: Record<string, unknown>;
        reason: string | null;
        decided_by: string | null;
        decision_note: string | null;
      }>(sql`
        select id, type, status, requested_by, branch_id, amount_poisha, amount_derived_by_server,
               threshold_poisha, payload, reason, decided_by, decision_note
        from approvals.approval_requests
        where id = ${id} and ${scope}
      `),
    );

    const row = rows[0];
    const relevant =
      row !== undefined &&
      (row.requested_by === context.userId ||
        context.isSuperAdmin ||
        context.roles.some((role) => (CHECKER_TYPES[role] ?? []).includes(row.type)));
    if (row === undefined || !relevant) throw new NotFoundException('No such approval request.');

    const withheld =
      !canReadCost(context.roles, context.isSuperAdmin) &&
      COST_VALUED_APPROVAL_TYPES.includes(row.type);

    return {
      id: row.id,
      type: row.type,
      status: row.status,
      requestedBy: row.requested_by,
      branchId: row.branch_id,
      amountPoisha: withheld ? null : row.amount_poisha,
      amountWithheld: withheld,
      amountDerivedByServer: row.amount_derived_by_server,
      thresholdPoisha: withheld ? null : row.threshold_poisha,
      thresholdChange: thresholdChangeTerms(row.type, row.payload),
      // The serializer strips any cost-named field in here for a non-cost role.
      payload: row.type === 'threshold_change' ? {} : row.payload,
      reason: row.reason,
      decidedBy: row.decided_by,
      decisionNote: row.decision_note,
    };
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
  async list(
    context: ActiveContext,
    request: object,
    query: { status?: string; type?: string; limit?: number; cursor?: string } = {},
  ): Promise<{ rows: ApprovalRequestRow[]; nextCursor: string | null }> {
    const limit = query.limit ?? 50;

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

    /*
     * Filters and a keyset cursor (§23).
     *
     * The `limit 100` this replaced was a silent truncation: the hundred-and-
     * first request pushed an older *pending* supplier payment off the end of
     * the only endpoint that lists them, and its id is discoverable nowhere
     * else. The checker could not find the request they were there to decide,
     * and the list looked healthy.
     */
    const filters = [scope, sql`(requested_by = ${context.userId} or ${relevant})`];
    if (query.status !== undefined) filters.push(sql`status::text = ${query.status}`);
    if (query.type !== undefined) filters.push(sql`type::text = ${query.type}`);
    if (query.cursor !== undefined) {
      const [createdAt, id] = query.cursor.split(',');
      filters.push(sql`(created_at, id) < (${createdAt ?? ''}::timestamptz, ${id ?? ''}::uuid)`);
    }

    const where = sql.join(
      filters.map((clause) => sql`(${clause})`),
      sql` and `,
    );

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      // One more than asked for, so "is there another page" is an observation
      // rather than a guess — a count(*) would race the next insert.
      const rows = await tx.execute<{
        id: string;
        type: ApprovalType;
        status: ApprovalStatus;
        requested_by: string;
        branch_id: string | null;
        amount_poisha: string | null;
        decided_by: string | null;
        payload: Record<string, unknown>;
        // postgres.js hands timestamptz back as a Date, but `tx.execute` is a
        // raw path with no schema to parse against, so a string is possible —
        // and was what a 500 on the first cursor page turned out to be.
        created_at: Date | string;
      }>(sql`
        select id, type, status, requested_by, branch_id, amount_poisha, decided_by, created_at,
               case when type::text = 'threshold_change' then payload else '{}'::jsonb end
                 as payload
        from approvals.approval_requests
        where ${where}
        order by created_at desc, id desc
        limit ${limit + 1}
      `);

      const page = [...rows].slice(0, limit);
      const last = page.at(-1);
      const nextCursor =
        rows.length > limit && last !== undefined
          ? `${new Date(last.created_at).toISOString()},${last.id}`
          : null;

      const mapped = page.map((row) => {
        const withheld = !seesCost && COST_VALUED_APPROVAL_TYPES.includes(row.type);
        return {
          id: row.id,
          type: row.type,
          status: row.status,
          requestedBy: row.requested_by,
          branchId: row.branch_id,
          amountPoisha: withheld ? null : row.amount_poisha,
          amountWithheld: withheld,
          thresholdChange: thresholdChangeTerms(row.type, row.payload),
          decidedBy: row.decided_by,
        };
      });

      return { rows: mapped, nextCursor };
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
      // Locked, so a concurrent change to the same type waits rather than
      // deciding "lower" or "raise" against a value that is about to change
      // (final pass note 2). A first threshold has no row to lock; it is a
      // relaxation and goes through approval, which re-checks under a lock.
      const [locked] = await tx.execute<{ threshold_poisha: string }>(sql`
        select threshold_poisha::text as threshold_poisha from approvals.approval_thresholds
        where org_id = ${context.orgId} and type = ${input.type}::approvals.approval_type
        for update
      `);
      const previous =
        locked === undefined ? undefined : { thresholdPoisha: BigInt(locked.threshold_poisha) };

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

      await this.writeEvents(tx, context.orgId, events);
      return {
        type: input.type,
        thresholdPoisha: input.thresholdPoisha.toString(),
        status: 'pending_approval' as const,
        approvalId: id,
      };
    });

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
