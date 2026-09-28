import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * Test-only setup for the HR suites.
 *
 * Two jobs, and both exist because of how this session is split rather than because of
 * anything about payroll:
 *
 * 1. **Apply the migrations.** `packages/db/migrations/meta/_journal.json` is edited by
 *    several milestones at once, so M19's five files are handed to the integrator as
 *    INTEGRATION lines instead of appended here — and until they are appended,
 *    `startTestDatabase()`'s `migrate()` does not run them.
 * 2. **Seed the people.** The employee endpoints are M19's own to test, but the db suite
 *    needs employees, structures and attendance without going through HTTP — and the
 *    encrypted columns mean an employee cannot be written with a plain INSERT and still
 *    satisfy `employees_payout_ref_present`. So the fixtures write `payout_method = 'cash'`
 *    where they do not need a payout reference, and the e2e suite creates the ones that do
 *    through the real endpoint.
 */

const MIGRATIONS = [
  '0053_hr_schema.sql',
  '0054_hr_policies.sql',
  '0055_hr_integrity.sql',
  '0056_hr_payroll_approval_link.sql',
  '0057_hr_default_calendars.sql',
] as const;

function migrationsDir(): string {
  // Resolved from this file rather than from cwd: vitest runs suites with the repository
  // root as cwd, but a suite run from `apps/server` must find the same files.
  return path.resolve(import.meta.dirname, '../../../../../packages/db/migrations');
}

export async function applyHrMigrations(): Promise<void> {
  const already = await withSystem(async (tx) => {
    const rows = await tx.execute<{ present: boolean }>(
      sql`select to_regnamespace('hr') is not null as present`,
    );
    return rows[0]?.present === true;
  });
  if (already) return;

  const directory = migrationsDir();
  for (const name of MIGRATIONS) {
    const contents = await readFile(path.join(directory, name), 'utf8');
    // The same separator the real migrator splits on. Comment-only fragments are valid
    // no-op statements, so they need no filtering.
    for (const statement of contents.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed === '') continue;
      await withSystem(async (tx) => {
        await tx.execute(sql.raw(trimmed));
      });
    }
  }
}

export interface SeededEmployee {
  readonly id: string;
  readonly code: string;
}

/**
 * An employee with no login and no payout reference.
 *
 * Written as `erp_owner` inside the org's context, so RLS applies exactly as it does to
 * the application: an uncontexted insert would fail, which is itself a small check that
 * migration 0054's policies are on.
 */
export async function seedEmployee(
  orgId: string,
  input: {
    code: string;
    fullName: string;
    joinDate: string;
    branchId?: string | null;
    leaveDate?: string | null;
    userId?: string | null;
    status?: string;
  },
): Promise<SeededEmployee> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into hr.employees
          (org_id, branch_id, user_id, code, full_name, join_date, leave_date, status,
           payout_method, created_by)
        values (${orgId}, ${input.branchId ?? null}::uuid, ${input.userId ?? null},
                ${input.code}, ${input.fullName}, ${input.joinDate}::date,
                ${input.leaveDate ?? null}::date,
                ${input.status ?? 'active'}::hr.employment_status, 'cash', 'usr_hr_test')
        on conflict (org_id, code) do update set full_name = excluded.full_name
        returning id
      `);
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('seeding an employee returned no id');
      return { id, code: input.code };
    },
    { orgId },
  );
}

/** A salary structure with an optional list of components. */
export async function seedStructure(
  orgId: string,
  input: {
    employeeId: string;
    effectiveFrom: string;
    basicPoisha: bigint;
    components?: readonly {
      direction: 'earning' | 'deduction';
      code: string;
      label: string;
      amountPoisha: bigint;
      prorated?: boolean;
    }[];
  },
): Promise<string> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into hr.salary_structures
          (org_id, employee_id, effective_from, basic_poisha, created_by)
        values (${orgId}, ${input.employeeId}, ${input.effectiveFrom}::date,
                ${input.basicPoisha.toString()}, 'usr_hr_test')
        returning id
      `);
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('seeding a salary structure returned no id');

      for (const [index, component] of (input.components ?? []).entries()) {
        await tx.execute(sql`
          insert into hr.salary_components
            (org_id, structure_id, direction, code, label, amount_poisha, prorated, line_no)
          values (${orgId}, ${id}, ${component.direction}::hr.component_direction,
                  ${component.code}, ${component.label}, ${component.amountPoisha.toString()},
                  ${component.prorated ?? component.direction === 'earning'}, ${index + 1})
        `);
      }
      return id;
    },
    { orgId },
  );
}

/** Attendance for one employee, one day. `source` is `manual` so corrections are legal. */
export async function seedAttendance(
  orgId: string,
  input: { employeeId: string; branchId?: string | null; date: string; status: string },
): Promise<void> {
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into hr.attendance_days
          (org_id, employee_id, branch_id, business_date, status, source, recorded_by)
        values (${orgId}, ${input.employeeId}, ${input.branchId ?? null}::uuid,
                ${input.date}::date, ${input.status}::hr.attendance_status, 'manual',
                'usr_hr_test')
        on conflict (org_id, employee_id, business_date) do update
          set status = excluded.status, source = 'manual', updated_at = now()
      `);
    },
    { orgId },
  );
}

/**
 * The org's default `STD` calendar, creating it if this database has none.
 *
 * Migration 0057 backfills every org that exists when it runs — and migrations run *before*
 * the org seed, in the harness exactly as in `pnpm db:migrate && pnpm db:seed`, so in a test
 * database it inserts nothing. `ensureDefaultCalendar` in the repository is what covers that
 * in production code; this is the same upsert for a fixture, which needs an id rather than a
 * service.
 */
export async function defaultCalendarId(orgId: string): Promise<string> {
  return withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into hr.work_calendars (org_id, code, name, weekly_off, is_default, is_active)
        values (${orgId}, 'STD', 'Standard (Friday off)', array[5]::smallint[], true, true)
        on conflict do nothing
      `);
      const rows = await tx.execute<{ id: string }>(sql`
        select id from hr.work_calendars where org_id = ${orgId} and is_default
      `);
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('this org has no active default calendar');
      return id;
    },
    { orgId },
  );
}

/** A holiday on the org's default calendar. */
export async function seedHoliday(
  orgId: string,
  input: { calendarId: string; date: string; label: string },
): Promise<void> {
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into hr.calendar_holidays (org_id, calendar_id, holiday_date, label)
        values (${orgId}, ${input.calendarId}, ${input.date}::date, ${input.label})
        on conflict (org_id, calendar_id, holiday_date) do nothing
      `);
    },
    { orgId },
  );
}

/** An approval threshold, so a suite can decide whether a run needs a checker. */
export async function setThreshold(
  orgId: string,
  type: string,
  thresholdPoisha: string,
): Promise<void> {
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into approvals.approval_thresholds (org_id, type, threshold_poisha)
        values (${orgId}, ${type}::approvals.approval_type, ${thresholdPoisha})
        on conflict (org_id, type) do update set threshold_poisha = excluded.threshold_poisha
      `);
    },
    { orgId },
  );
}
