import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { approvalRequests } from '../approvals/index.js';
import { primaryId, timestamps } from '../columns.js';
import { employees, hr, payrollInputs, payrollRuns, workCalendars } from '../hr/index.js';
import { branches, organizations } from '../org/index.js';

/**
 * Targets, bonus rules and desk productivity (architecture §12, M20).
 *
 * In the `hr` schema, which §3 gives "employees, attendance, payroll, employee loans,
 * targets, bonus rules"; in their own file because they arrive with M20 and `hr/index.ts`
 * is M19's. Every table is tenant-scoped: `org_id NOT NULL`, RLS ENABLE and FORCE
 * (`*_m20_targets_policies`), composite foreign keys so no row can point into another
 * brand (D-047).
 */

/** §12's three metrics, and only those. */
export const targetMetric = hr.enum('target_metric', [
  'confirmed_orders',
  'delivered_orders',
  'delivered_revenue',
]);

export const targetScope = hr.enum('target_scope', ['employee', 'team']);

export const targetStatus = hr.enum('target_status', ['active', 'cancelled']);

export const bonusRuleVersionStatus = hr.enum('bonus_rule_version_status', [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'superseded',
]);

/**
 * One monthly target, for one employee or one team (§12).
 *
 * `target_value` and `achieved` are in the metric's own unit: orders for the two counts,
 * poisha for revenue. One column for both rather than a `*_poisha` beside a count, because
 * a target is always exactly one of them and two nullable columns would allow neither or
 * both. The name does not end in `_poisha` for that reason; the metric says which it is.
 */
export const targets = hr.table(
  'targets',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** `YYYY-MM`, an Asia/Dhaka month (invariant 8). */
    month: text('month').notNull(),
    metric: targetMetric('metric').notNull(),
    scope: targetScope('scope').notNull(),
    /** Set for an employee target, null for a team. */
    employeeId: uuid('employee_id'),
    /** Set for a team target, null for an employee. */
    teamName: text('team_name'),
    /**
     * The branch a branch manager sees this target under (§6 "branch progress"): the
     * employee's branch when the target was set, or the team's.
     */
    branchId: uuid('branch_id'),
    /** The calendar whose working days weighted the weekly split (D-271). */
    calendarId: uuid('calendar_id').notNull(),
    targetValue: bigint('target_value', { mode: 'bigint' }).notNull(),
    achieved: bigint('achieved', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /** When `achieved` was last recomputed. */
    progressAt: timestamp('progress_at', { withTimezone: true, mode: 'date' }),
    status: targetStatus('status').notNull().default('active'),
    note: text('note'),
    createdBy: text('created_by').notNull(),
    cancelledBy: text('cancelled_by'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    index('targets_org_idx').on(table.orgId),
    index('targets_org_month_idx').on(table.orgId, table.month),
    unique('targets_org_id_id_key').on(table.orgId, table.id),
    /*
     * One live target per employee per metric per month. Partial, so a cancelled target
     * does not consume the month — the same reason M19's run index is partial.
     */
    uniqueIndex('targets_org_month_metric_employee_idx')
      .on(table.orgId, table.month, table.metric, table.employeeId)
      .where(sql`status = 'active' and scope = 'employee'`),
    foreignKey({
      name: 'targets_org_id_employee_id_fk',
      columns: [table.orgId, table.employeeId],
      foreignColumns: [employees.orgId, employees.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'targets_org_id_calendar_id_fk',
      columns: [table.orgId, table.calendarId],
      foreignColumns: [workCalendars.orgId, workCalendars.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'targets_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    check('targets_month_format', sql`${table.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check('targets_value_positive', sql`${table.targetValue} > 0`),
    check('targets_achieved_non_negative', sql`${table.achieved} >= 0`),
    check(
      'targets_scope_shape',
      sql`(${table.scope} = 'employee' and ${table.employeeId} is not null and ${table.teamName} is null)
          or (${table.scope} = 'team' and ${table.employeeId} is null and ${table.teamName} is not null)`,
    ),
    check(
      'targets_team_name_length',
      sql`${table.teamName} is null or length(${table.teamName}) between 1 and 80`,
    ),
    check('targets_note_length', sql`${table.note} is null or length(${table.note}) <= 300`),
    check(
      'targets_cancel_shape',
      sql`(${table.status} = 'cancelled') = (${table.cancelledAt} is not null)`,
    ),
  ],
);

/** Whose results count towards a target: one employee, or a team's members. */
export const targetMembers = hr.table(
  'target_members',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    targetId: uuid('target_id').notNull(),
    employeeId: uuid('employee_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'target_members_pkey',
      columns: [table.orgId, table.targetId, table.employeeId],
    }),
    index('target_members_org_employee_idx').on(table.orgId, table.employeeId),
    foreignKey({
      name: 'target_members_org_id_target_id_fk',
      columns: [table.orgId, table.targetId],
      foreignColumns: [targets.orgId, targets.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'target_members_org_id_employee_id_fk',
      columns: [table.orgId, table.employeeId],
      foreignColumns: [employees.orgId, employees.id],
    }).onDelete('restrict'),
  ],
);

/**
 * A target's weekly split (§12; M20 check 1).
 *
 * `planned` is written once, from `splitTarget`, and never changes (`*_integrity`): the
 * weeks an agent was shown on the 1st are the weeks they are measured against on the 30th.
 * `achieved` is the rollup's.
 */
export const targetWeeks = hr.table(
  'target_weeks',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    targetId: uuid('target_id').notNull(),
    weekNo: smallint('week_no').notNull(),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    workingDays: smallint('working_days').notNull(),
    planned: bigint('planned', { mode: 'bigint' }).notNull(),
    achieved: bigint('achieved', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
  },
  (table) => [
    primaryKey({ name: 'target_weeks_pkey', columns: [table.orgId, table.targetId, table.weekNo] }),
    foreignKey({
      name: 'target_weeks_org_id_target_id_fk',
      columns: [table.orgId, table.targetId],
      foreignColumns: [targets.orgId, targets.id],
    }).onDelete('cascade'),
    check('target_weeks_week_no', sql`${table.weekNo} between 1 and 6`),
    check('target_weeks_dates', sql`${table.endsOn} >= ${table.startsOn}`),
    check('target_weeks_working_days', sql`${table.workingDays} between 0 and 7`),
    check('target_weeks_planned_non_negative', sql`${table.planned} >= 0`),
    check('target_weeks_achieved_non_negative', sql`${table.achieved} >= 0`),
  ],
);

/** A named bonus rule on one metric. Its terms live in its versions. */
export const bonusRules = hr.table(
  'bonus_rules',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    metric: targetMetric('metric').notNull(),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    index('bonus_rules_org_idx').on(table.orgId),
    unique('bonus_rules_org_id_id_key').on(table.orgId, table.id),
    uniqueIndex('bonus_rules_org_name_idx').on(table.orgId, sql`lower(${table.name})`),
    check('bonus_rules_name_length', sql`length(${table.name}) between 1 and 80`),
  ],
);

/**
 * One version of a bonus rule: the JSON a checker approved (§12, D-275).
 *
 * The definition never changes after insert (`*_integrity`). An edit is a new version, so
 * the version an award names is exactly the terms that paid it — and a draft cannot be
 * changed between the preview HR looked at and the request a checker approves.
 */
export const bonusRuleVersions = hr.table(
  'bonus_rule_versions',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    ruleId: uuid('rule_id').notNull(),
    version: integer('version').notNull(),
    definition: jsonb('definition').notNull(),
    status: bonusRuleVersionStatus('status').notNull().default('draft'),
    /** The `bonus_rule` request that decides it. Set on submit. */
    approvalRequestId: uuid('approval_request_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    index('bonus_rule_versions_org_idx').on(table.orgId),
    unique('bonus_rule_versions_org_id_id_key').on(table.orgId, table.id),
    uniqueIndex('bonus_rule_versions_org_rule_version_idx').on(
      table.orgId,
      table.ruleId,
      table.version,
    ),
    // One version in force per rule, and one waiting for a checker.
    uniqueIndex('bonus_rule_versions_org_rule_approved_idx')
      .on(table.orgId, table.ruleId)
      .where(sql`status = 'approved'`),
    uniqueIndex('bonus_rule_versions_org_rule_pending_idx')
      .on(table.orgId, table.ruleId)
      .where(sql`status = 'pending_approval'`),
    uniqueIndex('bonus_rule_versions_org_approval_idx')
      .on(table.orgId, table.approvalRequestId)
      .where(sql`approval_request_id is not null`),
    foreignKey({
      name: 'bonus_rule_versions_org_id_rule_id_fk',
      columns: [table.orgId, table.ruleId],
      foreignColumns: [bonusRules.orgId, bonusRules.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'bonus_rule_versions_org_id_approval_request_id_fk',
      columns: [table.orgId, table.approvalRequestId],
      foreignColumns: [approvalRequests.orgId, approvalRequests.id],
    }).onDelete('restrict'),
    check('bonus_rule_versions_version_positive', sql`${table.version} >= 1`),
    check(
      'bonus_rule_versions_submitted_has_request',
      sql`${table.status} = 'draft' or ${table.approvalRequestId} is not null`,
    ),
  ],
);

/**
 * What one approved rule version paid one employee, for one target, in one payroll run.
 *
 * The bonus itself is the `payroll_inputs` row it names, so M19's run computes, freezes,
 * approves and posts it like any other bonus; this row is the why. Insert and delete only,
 * and only while the run is a draft (`*_integrity`): re-applying the rules replaces a draft
 * run's awards, and a submitted run's are what the checker approved.
 */
export const bonusAwards = hr.table(
  'bonus_awards',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    runId: uuid('run_id').notNull(),
    employeeId: uuid('employee_id').notNull(),
    targetId: uuid('target_id').notNull(),
    ruleVersionId: uuid('rule_version_id').notNull(),
    payrollInputId: uuid('payroll_input_id').notNull(),
    targetValue: bigint('target_value', { mode: 'bigint' }).notNull(),
    achieved: bigint('achieved', { mode: 'bigint' }).notNull(),
    pctBps: integer('pct_bps').notNull(),
    amountPoisha: bigint('amount_poisha', { mode: 'bigint' }).notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('bonus_awards_org_run_idx').on(table.orgId, table.runId),
    unique('bonus_awards_org_id_id_key').on(table.orgId, table.id),
    uniqueIndex('bonus_awards_org_run_target_version_idx').on(
      table.orgId,
      table.runId,
      table.targetId,
      table.ruleVersionId,
    ),
    uniqueIndex('bonus_awards_org_input_idx').on(table.orgId, table.payrollInputId),
    foreignKey({
      name: 'bonus_awards_org_id_run_id_fk',
      columns: [table.orgId, table.runId],
      foreignColumns: [payrollRuns.orgId, payrollRuns.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'bonus_awards_org_id_employee_id_fk',
      columns: [table.orgId, table.employeeId],
      foreignColumns: [employees.orgId, employees.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'bonus_awards_org_id_target_id_fk',
      columns: [table.orgId, table.targetId],
      foreignColumns: [targets.orgId, targets.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'bonus_awards_org_id_rule_version_id_fk',
      columns: [table.orgId, table.ruleVersionId],
      foreignColumns: [bonusRuleVersions.orgId, bonusRuleVersions.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'bonus_awards_org_id_payroll_input_id_fk',
      columns: [table.orgId, table.payrollInputId],
      foreignColumns: [payrollInputs.orgId, payrollInputs.id],
    }).onDelete('cascade'),
    check('bonus_awards_amount_positive', sql`${table.amountPoisha} > 0`),
    check('bonus_awards_target_positive', sql`${table.targetValue} > 0`),
  ],
);

/**
 * The order desk's events, as productivity facts (§12; M20 check 3).
 *
 * Written by the worker's outbox subscriber, one row per outbox event: §3 makes the outbox
 * "the domain event log that productivity metrics are computed from", and this is the slice
 * of it HR reads, kept in HR's own schema so the report never reaches into the platform's
 * table (invariant 12). Append-only; `event_id` unique, so a redelivered event is one row.
 */
export const deskEvents = hr.table(
  'desk_events',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** The outbox row's id. */
    eventId: uuid('event_id').notNull(),
    orderId: uuid('order_id').notNull(),
    kind: text('kind').notNull(),
    assigneeUserId: text('assignee_user_id'),
    actorUserId: text('actor_user_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('desk_events_org_event_idx').on(table.orgId, table.eventId),
    index('desk_events_org_order_idx').on(table.orgId, table.orderId),
    index('desk_events_org_occurred_idx').on(table.orgId, table.occurredAt),
    check(
      'desk_events_kind',
      sql`${table.kind} in ('created', 'assigned', 'claimed', 'confirmed', 'cancelled')`,
    ),
  ],
);
