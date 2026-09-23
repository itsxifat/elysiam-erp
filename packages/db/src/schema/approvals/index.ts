import {
  bigint,
  check,
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

import { organizations } from '../org/index.js';
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
]);

export const approvalStatus = approvals.enum('approval_status', [
  'pending',
  'approved',
  'rejected',
  'cancelled',
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
    /** Money is integer poisha (invariant 1). Null where the action has no amount. */
    amountPoisha: bigint('amount_poisha', { mode: 'bigint' }),
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
    unique('approval_requests_org_id_id_key').on(table.orgId, table.id),

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
     */
    check(
      'approval_requests_decision_is_complete',
      sql`(${table.status} = 'pending' and ${table.decidedBy} is null and ${table.decidedAt} is null)
          or (${table.status} = 'cancelled' and ${table.decidedBy} is null)
          or (${table.status} in ('approved', 'rejected') and ${table.decidedBy} is not null and ${table.decidedAt} is not null)`,
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
  ],
);
