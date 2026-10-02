import type { Tx } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * SQL for targets, bonus rules and desk events (M20; architecture §12).
 *
 * Every table here is in `hr` and every query names its org explicitly, inside the
 * caller's `withOrg` transaction, so RLS and the WHERE clause say the same thing twice
 * (invariant 4). Nothing here reads another module's schema: an agent's orders arrive
 * through `OrdersApi.agentResults`, and desk events through the outbox subscriber.
 */

const ids = (values: readonly string[]): SQL =>
  sql.join(
    values.map((value) => sql`${value}::uuid`),
    sql`, `,
  );

// --- targets ------------------------------------------------------------------

export interface TargetRow extends Record<string, unknown> {
  readonly id: string;
  readonly month: string;
  readonly metric: string;
  readonly scope: string;
  readonly employee_id: string | null;
  readonly team_name: string | null;
  readonly branch_id: string | null;
  readonly calendar_id: string;
  readonly target_value: string;
  readonly achieved: string;
  readonly progress_at: string | null;
  readonly status: string;
  readonly note: string | null;
  readonly created_by: string;
  readonly employee_code: string | null;
  readonly employee_name: string | null;
}

const TARGET_COLUMNS = sql`
  t.id, t.month, t.metric::text as metric, t.scope::text as scope, t.employee_id, t.team_name,
  t.branch_id, t.calendar_id, t.target_value::text as target_value, t.achieved::text as achieved,
  t.progress_at::text as progress_at, t.status::text as status, t.note, t.created_by,
  e.code as employee_code, e.full_name as employee_name
`;

/**
 * The login of the calling member, or null — the column `own` compares against.
 *
 * `scopeWhere` writes `column = <caller>`, and a target has no single "assigned to": a team
 * target counts several people. This expression is the caller's own login when they are
 * one of the target's members and null otherwise, so `own` means exactly "a target that
 * counts me" (D-278).
 */
export function memberColumn(userId: string): SQL {
  return sql`(
    select me.user_id from hr.target_members tm
    join hr.employees me on me.org_id = tm.org_id and me.id = tm.employee_id
    where tm.org_id = t.org_id and tm.target_id = t.id and me.user_id = ${userId}
    limit 1
  )`;
}

export async function listTargets(
  tx: Tx,
  orgId: string,
  filters: {
    readonly scope: SQL;
    readonly month?: string | undefined;
    readonly employeeId?: string | undefined;
    readonly status?: string | undefined;
    readonly memberUserId?: string | undefined;
  },
): Promise<TargetRow[]> {
  const rows = await tx.execute<TargetRow>(sql`
    select ${TARGET_COLUMNS}
    from hr.targets t
    left join hr.employees e on e.org_id = t.org_id and e.id = t.employee_id
    where t.org_id = ${orgId}
      and ${filters.scope}
      and ${filters.month === undefined ? sql`true` : sql`t.month = ${filters.month}`}
      and ${filters.status === undefined ? sql`true` : sql`t.status = ${filters.status}::hr.target_status`}
      and ${
        filters.employeeId === undefined
          ? sql`true`
          : sql`exists (select 1 from hr.target_members m
                        where m.org_id = t.org_id and m.target_id = t.id
                          and m.employee_id = ${filters.employeeId})`
      }
      and ${
        filters.memberUserId === undefined
          ? sql`true`
          : sql`${memberColumn(filters.memberUserId)} is not null`
      }
    order by t.month desc, t.metric, coalesce(e.code, t.team_name)
    limit 500
  `);
  return [...rows];
}

/**
 * `forUpdate` takes `for no key update`: enough to serialise two writers of one target,
 * and it does not block the key-share lock a bonus award's foreign key takes. A cancel
 * then locks the month's payroll runs while a bonus apply holds its run and inserts
 * awards that reference the target; with a full `for update` here each would wait for the
 * other (ledger confirmation of 4215f61).
 */
export async function targetById(
  tx: Tx,
  orgId: string,
  id: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<TargetRow | undefined> {
  const rows = await tx.execute<TargetRow>(sql`
    select ${TARGET_COLUMNS}
    from hr.targets t
    left join hr.employees e on e.org_id = t.org_id and e.id = t.employee_id
    where t.org_id = ${orgId} and t.id = ${id}
    ${options.forUpdate === true ? sql`for no key update of t` : sql``}
  `);
  return rows[0];
}

/** Active targets for these months: what a progress refresh recomputes. */
export async function activeTargets(
  tx: Tx,
  orgId: string,
  months: readonly string[],
): Promise<TargetRow[]> {
  if (months.length === 0) return [];
  const rows = await tx.execute<TargetRow>(sql`
    select ${TARGET_COLUMNS}
    from hr.targets t
    left join hr.employees e on e.org_id = t.org_id and e.id = t.employee_id
    where t.org_id = ${orgId} and t.status = 'active'
      and t.month in (${sql.join(
        months.map((month) => sql`${month}`),
        sql`, `,
      )})
    order by t.id
  `);
  return [...rows];
}

export async function insertTarget(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly month: string;
    readonly metric: string;
    readonly scope: 'employee' | 'team';
    readonly employeeId: string | null;
    readonly teamName: string | null;
    readonly branchId: string | null;
    readonly calendarId: string;
    readonly targetValue: bigint;
    readonly note: string | null;
    readonly createdBy: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into hr.targets
      (org_id, month, metric, scope, employee_id, team_name, branch_id, calendar_id,
       target_value, note, created_by)
    values (${input.orgId}, ${input.month}, ${input.metric}::hr.target_metric,
            ${input.scope}::hr.target_scope, ${input.employeeId}::uuid, ${input.teamName},
            ${input.branchId}::uuid, ${input.calendarId}, ${input.targetValue.toString()},
            ${input.note}, ${input.createdBy})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a target returned no id');
  return id;
}

export async function insertTargetMember(
  tx: Tx,
  orgId: string,
  targetId: string,
  employeeId: string,
): Promise<void> {
  await tx.execute(sql`
    insert into hr.target_members (org_id, target_id, employee_id)
    values (${orgId}, ${targetId}, ${employeeId})
  `);
}

export async function insertTargetWeek(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly targetId: string;
    readonly weekNo: number;
    readonly startsOn: string;
    readonly endsOn: string;
    readonly workingDays: number;
    readonly planned: bigint;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into hr.target_weeks
      (org_id, target_id, week_no, starts_on, ends_on, working_days, planned)
    values (${input.orgId}, ${input.targetId}, ${input.weekNo}, ${input.startsOn}::date,
            ${input.endsOn}::date, ${input.workingDays}, ${input.planned.toString()})
  `);
}

export interface MemberRow extends Record<string, unknown> {
  readonly target_id: string;
  readonly employee_id: string;
  readonly user_id: string | null;
  readonly code: string;
  readonly full_name: string;
}

export async function membersOf(
  tx: Tx,
  orgId: string,
  targetIds: readonly string[],
): Promise<MemberRow[]> {
  if (targetIds.length === 0) return [];
  const rows = await tx.execute<MemberRow>(sql`
    select m.target_id, m.employee_id, e.user_id, e.code, e.full_name
    from hr.target_members m
    join hr.employees e on e.org_id = m.org_id and e.id = m.employee_id
    where m.org_id = ${orgId} and m.target_id in (${ids(targetIds)})
    order by e.code
  `);
  return [...rows];
}

export interface WeekRow extends Record<string, unknown> {
  readonly target_id: string;
  readonly week_no: number;
  readonly starts_on: string;
  readonly ends_on: string;
  readonly working_days: number;
  readonly planned: string;
  readonly achieved: string;
}

export async function weeksOf(
  tx: Tx,
  orgId: string,
  targetIds: readonly string[],
): Promise<WeekRow[]> {
  if (targetIds.length === 0) return [];
  const rows = await tx.execute<WeekRow>(sql`
    select target_id, week_no, starts_on::text as starts_on, ends_on::text as ends_on,
           working_days, planned::text as planned, achieved::text as achieved
    from hr.target_weeks
    where org_id = ${orgId} and target_id in (${ids(targetIds)})
    order by target_id, week_no
  `);
  return [...rows];
}

export async function setTargetAchieved(
  tx: Tx,
  orgId: string,
  targetId: string,
  achieved: bigint,
): Promise<void> {
  await tx.execute(sql`
    update hr.targets set achieved = ${achieved.toString()}, progress_at = now(), updated_at = now()
    where org_id = ${orgId} and id = ${targetId}
  `);
}

export async function setWeekAchieved(
  tx: Tx,
  orgId: string,
  targetId: string,
  weekNo: number,
  achieved: bigint,
): Promise<void> {
  await tx.execute(sql`
    update hr.target_weeks set achieved = ${achieved.toString()}
    where org_id = ${orgId} and target_id = ${targetId} and week_no = ${weekNo}
  `);
}

export async function cancelTarget(
  tx: Tx,
  orgId: string,
  targetId: string,
  userId: string,
): Promise<void> {
  await tx.execute(sql`
    update hr.targets
    set status = 'cancelled', cancelled_by = ${userId}, cancelled_at = now(), updated_at = now()
    where org_id = ${orgId} and id = ${targetId}
  `);
}

// --- staff --------------------------------------------------------------------

export interface StaffRow extends Record<string, unknown> {
  readonly id: string;
  readonly user_id: string;
  readonly code: string;
  readonly full_name: string;
  readonly branch_id: string | null;
}

/** Employees with a login, inside the caller's scope: who a productivity report lists. */
export async function staffWithLogins(tx: Tx, orgId: string, scope: SQL): Promise<StaffRow[]> {
  const rows = await tx.execute<StaffRow>(sql`
    select e.id, e.user_id, e.code, e.full_name, e.branch_id
    from hr.employees e
    where e.org_id = ${orgId} and e.user_id is not null and ${scope}
    order by e.code
  `);
  return [...rows];
}

// --- bonus rules --------------------------------------------------------------

export interface RuleRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly metric: string;
  readonly created_by: string;
  readonly created_at: string;
}

export interface VersionRow extends Record<string, unknown> {
  readonly id: string;
  readonly rule_id: string;
  readonly rule_name: string;
  readonly metric: string;
  readonly version: number;
  readonly definition: unknown;
  readonly status: string;
  readonly approval_request_id: string | null;
  readonly decided_at: string | null;
  readonly created_by: string;
  readonly created_at: string;
}

const VERSION_COLUMNS = sql`
  v.id, v.rule_id, r.name as rule_name, r.metric::text as metric, v.version, v.definition,
  v.status::text as status, v.approval_request_id, v.decided_at::text as decided_at,
  v.created_by, v.created_at::text as created_at
`;

export async function listRules(tx: Tx, orgId: string): Promise<RuleRow[]> {
  const rows = await tx.execute<RuleRow>(sql`
    select id, name, metric::text as metric, created_by, created_at::text as created_at
    from hr.bonus_rules where org_id = ${orgId} order by lower(name)
  `);
  return [...rows];
}

export async function ruleById(tx: Tx, orgId: string, id: string): Promise<RuleRow | undefined> {
  const rows = await tx.execute<RuleRow>(sql`
    select id, name, metric::text as metric, created_by, created_at::text as created_at
    from hr.bonus_rules where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

export async function insertRule(
  tx: Tx,
  input: { orgId: string; name: string; metric: string; createdBy: string },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into hr.bonus_rules (org_id, name, metric, created_by)
    values (${input.orgId}, ${input.name}, ${input.metric}::hr.target_metric, ${input.createdBy})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a bonus rule returned no id');
  return id;
}

/**
 * The next version of a rule, numbered `max + 1`.
 *
 * Two editors adding a version at the same instant both compute the same number, and the
 * unique index on (org, rule, version) refuses the second with a message saying to reload
 * (`hr.errors.ts`). No row lock: `erp_app` has no UPDATE on `bonus_rules` (0090), which a
 * `for update` would need, and the index already gives the answer a lock would.
 */
export async function insertVersion(
  tx: Tx,
  input: { orgId: string; ruleId: string; definition: unknown; createdBy: string },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into hr.bonus_rule_versions (org_id, rule_id, version, definition, created_by)
    values (
      ${input.orgId}, ${input.ruleId},
      (select coalesce(max(version), 0) + 1 from hr.bonus_rule_versions
       where org_id = ${input.orgId} and rule_id = ${input.ruleId}),
      ${JSON.stringify(input.definition)}::jsonb, ${input.createdBy}
    )
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a bonus rule version returned no id');
  return id;
}

export async function versionsOf(
  tx: Tx,
  orgId: string,
  ruleIds: readonly string[],
): Promise<VersionRow[]> {
  if (ruleIds.length === 0) return [];
  const rows = await tx.execute<VersionRow>(sql`
    select ${VERSION_COLUMNS}
    from hr.bonus_rule_versions v
    join hr.bonus_rules r on r.org_id = v.org_id and r.id = v.rule_id
    where v.org_id = ${orgId} and v.rule_id in (${ids(ruleIds)})
    order by v.rule_id, v.version desc
  `);
  return [...rows];
}

export async function versionById(
  tx: Tx,
  orgId: string,
  id: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<VersionRow | undefined> {
  const rows = await tx.execute<VersionRow>(sql`
    select ${VERSION_COLUMNS}
    from hr.bonus_rule_versions v
    join hr.bonus_rules r on r.org_id = v.org_id and r.id = v.rule_id
    where v.org_id = ${orgId} and v.id = ${id}
    ${options.forUpdate === true ? sql`for update of v` : sql``}
  `);
  return rows[0];
}

export async function versionByApproval(
  tx: Tx,
  orgId: string,
  approvalId: string,
): Promise<VersionRow | undefined> {
  const rows = await tx.execute<VersionRow>(sql`
    select ${VERSION_COLUMNS}
    from hr.bonus_rule_versions v
    join hr.bonus_rules r on r.org_id = v.org_id and r.id = v.rule_id
    where v.org_id = ${orgId} and v.approval_request_id = ${approvalId}
    for update of v
  `);
  return rows[0];
}

export async function pendingVersionOf(
  tx: Tx,
  orgId: string,
  ruleId: string,
): Promise<VersionRow | undefined> {
  const rows = await tx.execute<VersionRow>(sql`
    select ${VERSION_COLUMNS}
    from hr.bonus_rule_versions v
    join hr.bonus_rules r on r.org_id = v.org_id and r.id = v.rule_id
    where v.org_id = ${orgId} and v.rule_id = ${ruleId} and v.status = 'pending_approval'
    for update of v
  `);
  return rows[0];
}

/** Returns how many versions moved: 0 when it was no longer a draft. */
export async function markSubmitted(
  tx: Tx,
  orgId: string,
  versionId: string,
  approvalId: string,
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    update hr.bonus_rule_versions
    set status = 'pending_approval', approval_request_id = ${approvalId}, updated_at = now()
    where org_id = ${orgId} and id = ${versionId} and status = 'draft'
    returning id
  `);
  return rows.length;
}

export async function setVersionStatus(
  tx: Tx,
  orgId: string,
  versionId: string,
  status: 'approved' | 'rejected' | 'superseded',
): Promise<void> {
  await tx.execute(sql`
    update hr.bonus_rule_versions
    set status = ${status}::hr.bonus_rule_version_status,
        decided_at = case when ${status} = 'superseded' then decided_at else now() end,
        updated_at = now()
    where org_id = ${orgId} and id = ${versionId}
  `);
}

/**
 * The approved version of a rule, if any — what an approval supersedes.
 *
 * Locked `for no key update`, as a target is for its cancel: the activation then waits for
 * every draft run, and an apply holding one inserts awards whose foreign key takes a
 * key-share lock on this very version. A full `for update` would have each wait for the
 * other (ledger confirmation of 4e21161).
 */
export async function approvedVersionOf(
  tx: Tx,
  orgId: string,
  ruleId: string,
): Promise<VersionRow | undefined> {
  const rows = await tx.execute<VersionRow>(sql`
    select ${VERSION_COLUMNS}
    from hr.bonus_rule_versions v
    join hr.bonus_rules r on r.org_id = v.org_id and r.id = v.rule_id
    where v.org_id = ${orgId} and v.rule_id = ${ruleId} and v.status = 'approved'
    for no key update of v
  `);
  return rows[0];
}

/** Every rule's version in force: what a payroll run pays. */
export async function approvedVersions(tx: Tx, orgId: string): Promise<VersionRow[]> {
  const rows = await tx.execute<VersionRow>(sql`
    select ${VERSION_COLUMNS}
    from hr.bonus_rule_versions v
    join hr.bonus_rules r on r.org_id = v.org_id and r.id = v.rule_id
    where v.org_id = ${orgId} and v.status = 'approved'
    order by lower(r.name)
  `);
  return [...rows];
}

// --- bonus awards -------------------------------------------------------------

export interface AwardRow extends Record<string, unknown> {
  readonly id: string;
  readonly employee_id: string;
  readonly employee_code: string;
  readonly employee_name: string;
  readonly target_id: string;
  readonly rule_version_id: string;
  readonly rule_name: string;
  readonly version: number;
  readonly payroll_input_id: string;
  readonly target_value: string;
  readonly achieved: string;
  readonly pct_bps: number;
  readonly amount_poisha: string;
}

export async function awardsForRun(tx: Tx, orgId: string, runId: string): Promise<AwardRow[]> {
  const rows = await tx.execute<AwardRow>(sql`
    select a.id, a.employee_id, e.code as employee_code, e.full_name as employee_name,
           a.target_id, a.rule_version_id, r.name as rule_name, v.version, a.payroll_input_id,
           a.target_value::text as target_value, a.achieved::text as achieved, a.pct_bps,
           a.amount_poisha::text as amount_poisha
    from hr.bonus_awards a
    join hr.employees e on e.org_id = a.org_id and e.id = a.employee_id
    join hr.bonus_rule_versions v on v.org_id = a.org_id and v.id = a.rule_version_id
    join hr.bonus_rules r on r.org_id = v.org_id and r.id = v.rule_id
    where a.org_id = ${orgId} and a.run_id = ${runId}
    order by e.code, lower(r.name)
  `);
  return [...rows];
}

/**
 * Remove the bonus inputs a previous apply made on this run; their awards go with them
 * (`on delete cascade`). Inputs a person typed by hand are not touched — only those an
 * award names. 0055 and 0091 both refuse this once the run is not a draft.
 */
export async function deleteRuleInputs(tx: Tx, orgId: string, runId: string): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from hr.payroll_inputs
    where org_id = ${orgId}
      and id in (select payroll_input_id from hr.bonus_awards
                 where org_id = ${orgId} and run_id = ${runId})
    returning id
  `);
  return rows.length;
}

/**
 * Remove the bonuses a cancelled target or a superseded rule version made on **draft**
 * runs (M20 ledger audit W4); the awards go with their inputs. A submitted run's are what
 * its checker is deciding on, and 0055 and 0091 would refuse touching them anyway.
 *
 * The draft runs are locked first, `for share` and in id order, and the delete is a later
 * statement (ledger confirmation of 4215f61, N-3 and N-4). Taking the run before any input
 * row is the order a bonus apply and a submit use, so the two cannot deadlock. A run whose
 * submit commits while this waits is re-read as no longer a draft and left alone, rather
 * than tripping 0055's guard into an error inside somebody's approval. And the delete's
 * snapshot is taken after the wait, so it sees the awards an apply holding the run wrote.
 */
export async function deleteDraftAwardInputs(
  tx: Tx,
  orgId: string,
  by: { readonly targetId: string; readonly month: string } | { readonly ruleVersionId: string },
): Promise<number> {
  // A target's awards sit only on runs for its own month; a version's on any run.
  const runs = await tx.execute<{ id: string }>(sql`
    select id from hr.payroll_runs
    where org_id = ${orgId} and status = 'draft'
      ${'month' in by ? sql`and month = ${by.month}` : sql``}
    order by id
    for share
  `);
  if (runs.length === 0) return 0;
  const match =
    'targetId' in by
      ? sql`a.target_id = ${by.targetId}`
      : sql`a.rule_version_id = ${by.ruleVersionId}`;
  const rows = await tx.execute<{ id: string }>(sql`
    delete from hr.payroll_inputs
    where org_id = ${orgId}
      and id in (
        select a.payroll_input_id from hr.bonus_awards a
        where a.org_id = ${orgId} and ${match}
          and a.run_id in (${sql.join(
            runs.map((run) => sql`${run.id}`),
            sql`, `,
          )})
      )
    returning id
  `);
  return rows.length;
}

/**
 * Lock the month's payroll runs, `for share` and in id order, before a target cancel
 * reads them (ledger confirmation of 4215f61, W-1). A submit holding one is waited out, so
 * the check that follows sees the run it left pending rather than the draft it was; a
 * submit that starts later waits for the cancel and then finds its inputs changed.
 */
export async function lockRunsForMonth(tx: Tx, orgId: string, month: string): Promise<void> {
  await tx.execute(sql`
    select id from hr.payroll_runs
    where org_id = ${orgId} and month = ${month}
    order by id
    for share
  `);
}

/**
 * Awards on this run whose target is no longer active or whose rule version is no longer
 * in force (ledger confirmation of 4215f61, N-6). A cancel or a supersede removes its
 * bonuses from draft runs, but an apply that read the target or the version just before
 * that committed can still write one after; payroll submit refuses to freeze such a run.
 */
export async function staleAwardCount(tx: Tx, orgId: string, runId: string): Promise<number> {
  const rows = await tx.execute<{ count: string }>(sql`
    select count(*)::text as count from hr.bonus_awards a
    join hr.targets t on t.org_id = a.org_id and t.id = a.target_id
    join hr.bonus_rule_versions v on v.org_id = a.org_id and v.id = a.rule_version_id
    where a.org_id = ${orgId} and a.run_id = ${runId}
      and (t.status <> 'active' or v.status <> 'approved')
  `);
  return Number(rows[0]?.count ?? '0');
}

/** The month of a run awaiting approval that pays a bonus on this target, if any. */
export async function pendingRunPaying(
  tx: Tx,
  orgId: string,
  targetId: string,
): Promise<string | undefined> {
  const rows = await tx.execute<{ month: string }>(sql`
    select r.month from hr.bonus_awards a
    join hr.payroll_runs r on r.org_id = a.org_id and r.id = a.run_id
    where a.org_id = ${orgId} and a.target_id = ${targetId} and r.status = 'pending_approval'
    limit 1
  `);
  return rows[0]?.month;
}

export async function insertAward(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly runId: string;
    readonly employeeId: string;
    readonly targetId: string;
    readonly ruleVersionId: string;
    readonly payrollInputId: string;
    readonly targetValue: bigint;
    readonly achieved: bigint;
    readonly pctBps: number;
    readonly amountPoisha: bigint;
    readonly createdBy: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into hr.bonus_awards
      (org_id, run_id, employee_id, target_id, rule_version_id, payroll_input_id,
       target_value, achieved, pct_bps, amount_poisha, created_by)
    values (${input.orgId}, ${input.runId}, ${input.employeeId}, ${input.targetId},
            ${input.ruleVersionId}, ${input.payrollInputId}, ${input.targetValue.toString()},
            ${input.achieved.toString()}, ${input.pctBps}, ${input.amountPoisha.toString()},
            ${input.createdBy})
  `);
}

// --- desk events --------------------------------------------------------------

export interface DeskEventRow extends Record<string, unknown> {
  readonly event_id: string;
  readonly order_id: string;
  readonly kind: string;
  readonly assignee_user_id: string | null;
  readonly actor_user_id: string | null;
  readonly occurred_at: Date | string;
}

/** One desk event; a redelivered outbox row is a no-op (the index on `event_id`). */
export async function insertDeskEvent(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly eventId: string;
    readonly orderId: string;
    readonly kind: string;
    readonly assigneeUserId: string | null;
    readonly actorUserId: string | null;
    readonly occurredAt: Date;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into hr.desk_events
      (org_id, event_id, order_id, kind, assignee_user_id, actor_user_id, occurred_at)
    values (${input.orgId}, ${input.eventId}, ${input.orderId}, ${input.kind},
            ${input.assigneeUserId}, ${input.actorUserId}, ${input.occurredAt.toISOString()})
    on conflict (org_id, event_id) do nothing
  `);
}

/**
 * Every desk event of every order that had one inside `[from, to)`.
 *
 * The whole stream of those orders, not only the window's slice: an order created
 * yesterday and claimed today waited since yesterday (see `productivity`).
 */
export async function deskEventsTouching(
  tx: Tx,
  orgId: string,
  from: Date,
  to: Date,
): Promise<DeskEventRow[]> {
  const rows = await tx.execute<DeskEventRow>(sql`
    select d.event_id, d.order_id, d.kind, d.assignee_user_id, d.actor_user_id, d.occurred_at
    from hr.desk_events d
    where d.org_id = ${orgId}
      and d.order_id in (
        select w.order_id from hr.desk_events w
        where w.org_id = ${orgId}
          and w.occurred_at >= ${from.toISOString()} and w.occurred_at < ${to.toISOString()}
      )
    order by d.occurred_at
  `);
  return [...rows];
}
