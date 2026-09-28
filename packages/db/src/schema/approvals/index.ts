import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { branches, organizations } from '../org/index.js';
import { primaryId, timestamps } from '../columns.js';

/**
 * Maker-checker (architecture §2, §6, §25).
 *
 * "An action one user requests and a *different* user approves." The second
 * half of that sentence is the whole control, so it is a database constraint
 * rather than a service check: services get refactored, called from jobs, and
 * bypassed by the next person in a hurry. A CHECK cannot be.
 */
export const approvals = pgSchema('approvals');

/**
 * The actions §6 routes through approvals. Each org sets its own thresholds.
 *
 * An enum rather than free text because the threshold table joins on it, and a
 * typo there would silently mean "no threshold configured, allow everything".
 */
export const approvalType = approvals.enum('approval_type', [
  'wallet_adjustment',
  'stock_write_off',
  'stock_gain',
  'supplier_payment',
  'settlement_posting',
  'closing_variance',
  'back_dated_entry',
  'payroll_run',
  'bonus_rule',
  'reseller_payout_batch',
  'period_reopen',
  // D-073: relaxing a threshold is itself maker-checker.
  'threshold_change',
  // M25, §6's "investor withdrawals and distributions". Added to the type by
  // migration 0058; a new enum value cannot be used as a literal in the
  // transaction that adds it, so nothing in that file mentions either by name.
  'investor_distribution',
  'investor_withdrawal',
]);

/**
 * Types no threshold may exempt (D-071), as SQL for the CHECKs below. Kept in
 * step with `NEVER_AUTO_APPROVE_TYPES` in @elysium/contracts by a test.
 * Compared as text: 0011 adds `threshold_change` to the enum in the same
 * transaction, and a new enum value cannot be used as a literal before commit.
 */
export const NEVER_AUTO_APPROVE_TYPE_NAMES = [
  'period_reopen',
  'bonus_rule',
  'threshold_change',
  'back_dated_entry',
] as const;

export const NEVER_AUTO_APPROVE_SQL = sql.raw(
  `(${NEVER_AUTO_APPROVE_TYPE_NAMES.map((name) => `'${name}'`).join(', ')})`,
);

/**
 * Branch items (D-076): held for a branch-tier checker under the threshold
 * rather than auto-approved. Kept in step with CHECKER_TYPES.branch_manager in
 * @elysium/contracts by a test.
 */
export const BRANCH_ITEM_TYPE_NAMES = [
  'stock_write_off',
  'stock_gain',
  'closing_variance',
] as const;

const BRANCH_ITEM_SQL = sql.raw(
  `(${BRANCH_ITEM_TYPE_NAMES.map((name) => `'${name}'`).join(', ')})`,
);

/**
 * `auto_approved` is a request below its org's threshold (§6 "above the
 * threshold"): recorded, audited and announced like any other, but with no
 * checker, because the org decided that amount does not need one. It is final
 * the moment it is written, exactly like a human decision (migration 0009).
 */
export const approvalStatus = approvals.enum('approval_status', [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'auto_approved',
]);

export const approvalRequests = approvals.table(
  'approval_requests',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    type: approvalType('type').notNull(),
    status: approvalStatus('status').notNull().default('pending'),

    requestedBy: text('requested_by').notNull(),
    /**
     * The branch this request is about, for §6's branch-tier checker. Null for
     * an org-level action. Composite reference, never `.references(branches.id)`
     * — a single-column FK is satisfiable by another org's branch (D-047).
     */
    branchId: uuid('branch_id'),
    /** Money is integer poisha (invariant 1). Null where the action has no amount. */
    amountPoisha: bigint('amount_poisha', { mode: 'bigint' }),
    /**
     * The org's threshold for this type at the moment of the request, or null
     * when none was configured (D-073). What decided "needs a second person"
     * is part of the record, so a threshold changed afterwards cannot rewrite
     * why a request was or was not held.
     */
    thresholdPoisha: bigint('threshold_poisha', { mode: 'bigint' }),
    /**
     * Whether the owning module computed the amount (true) or a person typed
     * it (false). Only a derived amount may be judged by a branch-tier checker
     * or relaxed by a threshold for server-derived types (D-072, D-076).
     */
    amountDerivedByServer: boolean('amount_derived_by_server').notNull().default(false),
    /** What to do once approved. The requesting module owns its shape. */
    payload: jsonb('payload').notNull().default({}),
    reason: text('reason'),

    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decisionNote: text('decision_note'),

    ...timestamps,
  },
  (table) => [
    index('approval_requests_org_idx').on(table.orgId),
    index('approval_requests_pending_idx').on(table.orgId, table.status, table.type),
    index('approval_requests_requester_idx').on(table.orgId, table.requestedBy),
    index('approval_requests_branch_idx').on(table.orgId, table.branchId),
    unique('approval_requests_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'approval_requests_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),

    /**
     * Maker ≠ checker, at the database.
     *
     * The service checks it too, and says something helpful when it fails. This
     * exists for the paths that do not go through the service: a job, a repair
     * script, a future module that writes the row directly. Any of those can
     * forget the rule; none of them can get past this.
     */
    check(
      'approval_requests_maker_is_not_checker',
      sql`${table.decidedBy} <> ${table.requestedBy}`,
    ),

    /**
     * A decision is all-or-nothing.
     *
     * Without this a row could sit `approved` with no decider, or carry a
     * decider while still `pending` — states nothing would ever produce on
     * purpose but which a partial update produces easily, and which the
     * maker≠checker constraint above does not catch because NULL passes it.
     *
     * `auto_approved` has a time and no decider — the threshold decided, not a
     * person. Compared as text because migration 0010 adds the enum value in
     * the same transaction, and PostgreSQL refuses to use a new enum value as
     * a literal before it commits.
     */
    check(
      'approval_requests_decision_is_complete',
      sql`(${table.status} = 'pending' and ${table.decidedBy} is null and ${table.decidedAt} is null)
          or (${table.status} = 'cancelled' and ${table.decidedBy} is null)
          or (${table.status}::text = 'auto_approved' and ${table.decidedBy} is null and ${table.decidedAt} is not null)
          or (${table.status} in ('approved', 'rejected') and ${table.decidedBy} is not null and ${table.decidedAt} is not null)`,
    ),

    /** D-071: these types are never auto-approved, whatever a threshold says. */
    check(
      'approval_requests_never_auto_approved',
      sql`${table.status}::text <> 'auto_approved' or ${table.type}::text not in ${NEVER_AUTO_APPROVE_SQL}`,
    ),

    /** D-076: branch items go to a branch-tier checker, never auto-approved. */
    check(
      'approval_requests_branch_items_never_auto_approved',
      sql`${table.status}::text <> 'auto_approved' or ${table.type}::text not in ${BRANCH_ITEM_SQL}`,
    ),
  ],
);

/**
 * Per-org thresholds.
 *
 * An action below its threshold does not need approval; at or above it does.
 * A type with no row configured needs approval for **any** amount — fail
 * closed, because the alternative is that forgetting to configure a threshold
 * silently disables maker-checker for that action.
 */
export const approvalThresholds = approvals.table(
  'approval_thresholds',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    type: approvalType('type').notNull(),
    thresholdPoisha: bigint('threshold_poisha', { mode: 'bigint' }).notNull(),

    ...timestamps,
  },
  (table) => [
    uniqueIndex('approval_thresholds_org_type_idx').on(table.orgId, table.type),
    index('approval_thresholds_org_idx').on(table.orgId),
    /** D-071: a type that must always be checked cannot have a threshold. */
    check(
      'approval_thresholds_never_for_controls',
      sql`${table.type}::text not in ${NEVER_AUTO_APPROVE_SQL}`,
    ),
    check('approval_thresholds_not_negative', sql`${table.thresholdPoisha} >= 0`),
  ],
);
