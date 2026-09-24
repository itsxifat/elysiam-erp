import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  APPROVAL_TYPES,
  canDecideType,
  CHECKER_TYPES,
  defineAbilityFor,
  isLimitedChecker,
  REQUESTER_ABILITY,
  type ApprovalType as ContractApprovalType,
} from '@elysium/contracts';
import { canDecide, requiresApproval, withinCheckerLimit, type Threshold } from '@elysium/domain';
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

/**
 * Re-exported rather than restated.
 *
 * This was a second, hand-written copy of the union, and it had already
 * drifted: §6's investor withdrawals, distributions and fraud overrides were
 * missing from both, and a copy is how that stays true after one of them is
 * fixed.
 */
export type ApprovalType = ContractApprovalType;

export interface ApprovalRequestRow {
  readonly id: string;
  readonly type: ApprovalType;
  readonly status: string;
  readonly requestedBy: string;
  readonly amountPoisha: string | null;
  readonly decidedBy: string | null;
}

/**
 * How many events the in-memory stand-in keeps.
 *
 * Small enough that a process running for weeks cannot grow into it, large
 * enough that a test asserting on a handful of events never races the cap.
 */
const EMITTED_WINDOW = 500;

/** What the outbox will carry once M04 exists (§27). */
export interface DomainEvent {
  readonly name: 'approval.requested' | 'approval.decided';
  readonly orgId: string;
  readonly payload: Record<string, unknown>;
}

/**
 * The org context every query here runs in.
 *
 * `requestId` included, which several of these were quietly dropping: §26 sets
 * `app.request_id` inside the transaction so a slow query in a log can be
 * traced back to the request that caused it, and a transaction that omits it
 * is one nobody can trace.
 */
function orgContext(context: ActiveContext) {
  return { orgId: context.orgId, userId: context.userId, requestId: context.requestId };
}

@Injectable()
export class ApprovalsService {
  /**
   * Collected in memory until M04's outbox. See `emit` below.
   *
   * Capped, because this is a default-scoped Nest provider — one instance per
   * process, for the weeks an API process runs — and an uncapped array here
   * accumulates every `approval.requested` and `approval.decided` from all
   * five orgs until the heap gives out. A ring of the last few hundred is
   * enough for the tests that read it and enough for a human asking "did that
   * fire", which is all it is for until the outbox exists.
   */
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
    // Oldest out, rather than "stop recording once full": a stale window that
    // never updates is worse than a short one, because it looks live.
    if (this.emitted.length > EMITTED_WINDOW) {
      this.emitted.splice(0, this.emitted.length - EMITTED_WINDOW);
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
    return withOrg({ ...orgContext(context) }, async (tx) =>
      requiresApproval({
        type: input.type,
        amountPoisha: input.amountPoisha,
        thresholds: await this.thresholdsFor(tx, context.orgId),
      }),
    );
  }

  /**
   * Raise a request for a second signature.
   *
   * **`amountPoisha` is trusted, and the caller is responsible for it.** This
   * is the module API later milestones call (invariant 12), and the amount it
   * is given decides two things: whether a second person is needed at all, and
   * whether an amount-limited checker may sign it. A caller that passes an
   * amount taken from an HTTP body rather than computed from the thing being
   * approved has defeated both — `{ amountPoisha: '0', payload: { qty: 10000 }}`
   * needs no checker, and an executor that reads the payload writes off ten
   * thousand units against an audit row showing an honest approval of zero.
   *
   * So: compute the amount from the same data the executor will act on. M07
   * and M14b own the first two callers and this note is aimed at them.
   *
   * What *is* enforced here is who may ask: `REQUESTER_ABILITY` requires the
   * caller to already hold the ability the approval authorises. `request
   * ApprovalRequest` alone covered all fourteen types, and `sales` holds it —
   * so a sales agent could raise an investor withdrawal that lands in the
   * accounts queue looking entirely legitimate.
   */
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
    const needed = REQUESTER_ABILITY[input.type];
    if (needed === undefined) {
      throw new BadRequestException(`${input.type} is not an approvable action.`);
    }

    if (!context.isSuperAdmin) {
      const ability = defineAbilityFor({
        roles: context.roles,
        isSuperAdmin: context.isSuperAdmin,
        userId: context.userId,
        branchIds: context.branchIds,
      });

      if (!ability.can(needed.action, needed.subject)) {
        // Says what is missing rather than what they hold, like the guard:
        // listing their roles back turns a denial into a probe.
        throw new ForbiddenException(
          `Raising a ${input.type} needs ${needed.action} ${needed.subject} in this organization.`,
        );
      }
    }

    return withOrg(orgContext(context), async (tx) => {
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
    return withOrg(orgContext(context), async (tx) => {
      const rows = await tx.execute<{
        id: string;
        status: string;
        requested_by: string;
        type: string;
        amount_poisha: string | null;
      }>(sql`
        select id, status, requested_by, type, amount_poisha
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

      /*
       * What this does NOT check, and cannot yet: which branch.
       *
       * §6 scopes a branch_manager's approvals to `branch`, and
       * `approvals.approval_requests` carries no `branch_id` — there is
       * nothing to compare. So a manager of one showroom can decide a
       * stock write-off raised in another, as long as it is under the
       * threshold and of a type they hold. That is narrower than "any
       * amount anywhere", which is where this started, and wider than §6.
       *
       * The column belongs with the module that knows what a branch-scoped
       * request is, which is M07 (stock) and M14b (till). Adding it here
       * would mean inventing the semantics of a nullable branch on a table
       * whose rows are raised by six different modules. Logged as a
       * follow-up rather than left silent, because the next person to read
       * `scope: 'branch'` in the matrix will reasonably assume it is
       * enforced.
       */

      /*
       * How much, as distinct from which type (§6).
       *
       * §6 gives branch_manager "branch items **under threshold**", and the
       * last two words are the whole limit: without them a showroom manager
       * could approve a stock write-off of any size — the cheapest way to make
       * inventory disappear in a company where the branch is also the till.
       *
       * Only a caller whose *sole* route to this type is a limited role is
       * capped, because roles are additive and the wider one is what applies.
       */
      if (isLimitedChecker(context.roles, row.type, context.isSuperAdmin)) {
        const thresholds = await this.thresholdsFor(tx, context.orgId);
        const configured = thresholds.find((entry) => entry.type === row.type);
        const limit = withinCheckerLimit({
          amountPoisha: row.amount_poisha === null ? null : BigInt(row.amount_poisha),
          thresholdPoisha: configured?.thresholdPoisha ?? null,
        });
        if (!limit.ok) throw new ForbiddenException(limit.reason);
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
  async list(
    context: ActiveContext,
    query: {
      status?: string;
      type?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<{ rows: ApprovalRequestRow[]; nextCursor: string | null }> {
    const limit = query.limit ?? 50;

    return withOrg(orgContext(context), async (tx) => {
      const decidable = context.isSuperAdmin
        ? [...APPROVAL_TYPES]
        : [...new Set(context.roles.flatMap((role) => [...(CHECKER_TYPES[role] ?? [])]))];

      /*
       * One bound parameter per type, compared as text.
       *
       * The first attempt passed the array as a single parameter and cast it
       * (`= any(${decidable}::text[]::approvals.approval_type[])`). That is a
       * 500 for every caller: the driver does not bind a JS array into a
       * double-cast enum array the way the literal form suggests. It shipped
       * green because nothing tested this route — verified by hand against the
       * running API, `GET /v1/approvals` returned 500.
       *
       * `type::text in (…)` sidesteps the enum cast entirely, and each value is
       * still a separate bound parameter, so it is injection-safe even though
       * the list is built in JavaScript. A role that may decide nothing gets
       * only the `requested_by` clause — `in ()` is a syntax error, not an
       * empty set.
       */
      const mine = sql`requested_by = ${context.userId}`;
      const visible =
        decidable.length === 0
          ? mine
          : sql`${mine} or type::text in (${sql.join(
              decidable.map((type) => sql`${type}`),
              sql`, `,
            )})`;

      /*
       * Filters and a keyset cursor (§23).
       *
       * Keyset rather than OFFSET: rows arrive constantly, and an offset page
       * two shifts under the reader — which on this endpoint means a pending
       * payment can be skipped entirely between two clicks. The cursor is the
       * composite `created_at,id`, because `created_at` alone is not unique
       * and a boundary inside a same-millisecond group repeats or drops a row.
       */
      const filters = [visible];
      if (query.status !== undefined) {
        filters.push(sql`status::text = ${query.status}`);
      }
      if (query.type !== undefined) {
        filters.push(sql`type::text = ${query.type}`);
      }
      if (query.cursor !== undefined) {
        const [createdAt, id] = query.cursor.split(',');
        filters.push(sql`(created_at, id) < (${createdAt ?? ''}::timestamptz, ${id ?? ''}::uuid)`);
      }

      const where = sql.join(
        filters.map((clause) => sql`(${clause})`),
        sql` and `,
      );

      // One more than asked for, so "is there another page" is an observation
      // rather than a guess. A count(*) would race the insert that follows it.
      const rows = await tx.execute<{
        id: string;
        type: ApprovalType;
        status: string;
        requested_by: string;
        amount_poisha: string | null;
        decided_by: string | null;
        // postgres.js hands timestamptz back as a Date, but `tx.execute` is a
        // raw path with no schema to parse against, so a string is possible
        // and was what a 500 in the first page request turned out to be.
        created_at: Date | string;
      }>(sql`
        select id, type, status, requested_by, amount_poisha, decided_by, created_at
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

      return {
        rows: page.map((row) => ({
          id: row.id,
          type: row.type,
          status: row.status,
          requestedBy: row.requested_by,
          amountPoisha: row.amount_poisha,
          decidedBy: row.decided_by,
        })),
        nextCursor,
      };
    });
  }

  /**
   * The thresholds this org has configured.
   *
   * Worth being able to read, and not only because a console needs it: an
   * unconfigured threshold means `requiresApproval` returns true for every
   * amount and a branch checker may decide nothing. Both are the fail-closed
   * direction, and both look like a bug from the outside unless the numbers
   * are visible somewhere.
   */
  async listThresholds(
    context: ActiveContext,
  ): Promise<{ type: string; thresholdPoisha: string }[]> {
    return withOrg(orgContext(context), async (tx) => {
      const rows = await this.thresholdsFor(tx, context.orgId);
      return rows
        .map((row) => ({ type: row.type, thresholdPoisha: row.thresholdPoisha.toString() }))
        .sort((a, b) => a.type.localeCompare(b.type));
    });
  }

  /**
   * Set an org's threshold for one action type.
   *
   * **This number does two jobs, and only one of them is obvious.** It decides
   * when a second person is needed (`requiresApproval`), and since D-063 it is
   * also the ceiling on an amount-limited checker's authority
   * (`withinCheckerLimit`). So raising `stock_write_off` from ৫,০০০ to ৫০
   * লাখ both stops write-offs under ৫০ লাখ needing a checker *and* lets every
   * branch manager in the org single-handedly approve a ৪৯ লাখ one. One
   * org_admin, acting alone, moves both.
   *
   * It is not itself a maker-checker action — §6's list does not include
   * settings changes — so what this does instead is leave an unambiguous
   * trail: its own audit row, in the same transaction as the write, keyed on
   * the *type* rather than the route, with the old value in `before`. The
   * interceptor's net would key every threshold change in every org on the
   * same path string, so "what happened to this setting" could not be asked.
   */
  async setThreshold(
    context: ActiveContext,
    input: { type: ApprovalType; thresholdPoisha: bigint; request?: AuditableRequest },
  ): Promise<void> {
    if (input.thresholdPoisha < 0n) {
      throw new BadRequestException('A threshold cannot be negative.');
    }

    await withOrg(orgContext(context), async (tx) => {
      const existing = await tx.execute<{ threshold_poisha: string }>(sql`
        select threshold_poisha from approvals.approval_thresholds
        where org_id = ${context.orgId} and type = ${input.type}::approvals.approval_type
      `);

      await tx.execute(sql`
        insert into approvals.approval_thresholds (org_id, type, threshold_poisha)
        values (${context.orgId}, ${input.type}::approvals.approval_type, ${input.thresholdPoisha.toString()})
        on conflict (org_id, type) do update
          set threshold_poisha = excluded.threshold_poisha, updated_at = now()
      `);

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: `approvals.threshold_changed:${input.type}`,
        entityType: 'Settings',
        // The type, not the route. Keyed on the path, every threshold change
        // in every org shared one `entity_id` and the entity index could not
        // separate them.
        entityId: input.type,
        before: { thresholdPoisha: existing[0]?.threshold_poisha ?? null },
        after: {
          thresholdPoisha: input.thresholdPoisha.toString(),
          // Named explicitly, because it is the effect nobody expects: the
          // same number caps a branch checker (D-063).
          branchCheckerCeilingPoisha: input.thresholdPoisha.toString(),
        },
        requestId: context.requestId,
        ...(input.request === undefined ? {} : { request: input.request }),
      });
    });
  }
}
