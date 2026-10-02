import type { Tx } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Every SQL statement the HR module runs (tenancy rules: raw SQL lives in
 * repositories, parameterised, never built by string interpolation).
 *
 * All of it runs inside a caller's `withOrg()` transaction, so RLS decides which org's
 * rows exist before any of these WHERE clauses run — the explicit `org_id = ${orgId}`
 * is the second layer, the way every repository in this codebase writes it.
 *
 * Two rules about what is *not* here.
 *
 * **No statement selects a `*_cipher` column into a general-purpose row type.** The
 * encrypted fields are read by exactly one function, `employeeSecrets`, which the
 * services call only when a caller has been authorised to see that one employee's
 * details. A `select *` on `hr.employees` in a list query would pull three ciphertexts
 * into every response object and rely on the serializer to drop them, and invariant 10
 * is not a thing to delegate to a field-name allow-list.
 *
 * **Nothing here touches `ledger.*` at all.** Resolving which account a posting rule
 * names is a read of the ledger module's table, so it goes through `LedgerApi`
 * (`accountBySubtype`, `walletAccountById`) like the posting itself — invariant 12, and
 * `../module-boundaries.test.ts` fails the build if a read creeps back in.
 */

// --- employees ----------------------------------------------------------------

export interface EmployeeRow extends Record<string, unknown> {
  readonly id: string;
  readonly branch_id: string | null;
  readonly user_id: string | null;
  readonly code: string;
  readonly full_name: string;
  readonly designation: string | null;
  readonly department: string | null;
  readonly join_date: string;
  readonly leave_date: string | null;
  readonly status: string;
  readonly calendar_id: string | null;
  readonly payout_method: string;
  readonly payout_ref_masked: string | null;
  readonly national_id_masked: string | null;
  readonly phone_masked: string | null;
  readonly created_by: string;
}

/**
 * The columns an employee response is built from — masks, never ciphertexts.
 *
 * Spelled out rather than `e.*`, which is the point: adding an encrypted column to the
 * table cannot widen what this returns.
 */
const EMPLOYEE_COLUMNS = sql`
  e.id, e.branch_id, e.user_id, e.code, e.full_name, e.designation, e.department,
  e.join_date::text as join_date, e.leave_date::text as leave_date,
  e.status::text as status, e.calendar_id, e.payout_method::text as payout_method,
  e.payout_ref_masked, e.national_id_masked, e.phone_masked, e.created_by
`;

export async function listEmployees(
  tx: Tx,
  orgId: string,
  filters: {
    readonly scope: SQL;
    readonly q?: string | undefined;
    readonly branchId?: string | undefined;
    readonly status?: string | undefined;
    readonly limit: number;
    readonly offset: number;
  },
): Promise<EmployeeRow[]> {
  const rows = await tx.execute<EmployeeRow>(sql`
    select ${EMPLOYEE_COLUMNS}
    from hr.employees e
    where e.org_id = ${orgId}
      and ${filters.scope}
      and ${filters.branchId === undefined ? sql`true` : sql`e.branch_id = ${filters.branchId}`}
      and ${filters.status === undefined ? sql`true` : sql`e.status = ${filters.status}::hr.employment_status`}
      and ${
        filters.q === undefined
          ? sql`true`
          : sql`(e.full_name ilike ${`%${filters.q}%`} or e.code ilike ${`%${filters.q}%`}
                 or coalesce(e.designation, '') ilike ${`%${filters.q}%`})`
      }
    order by e.code
    limit ${filters.limit} offset ${filters.offset}
  `);
  return [...rows];
}

export async function employeeById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<EmployeeRow | undefined> {
  const rows = await tx.execute<EmployeeRow>(sql`
    select ${EMPLOYEE_COLUMNS} from hr.employees e where e.org_id = ${orgId} and e.id = ${id}
  `);
  return rows[0];
}

export async function employeeByUser(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<EmployeeRow | undefined> {
  const rows = await tx.execute<EmployeeRow>(sql`
    select ${EMPLOYEE_COLUMNS} from hr.employees e
    where e.org_id = ${orgId} and e.user_id = ${userId}
  `);
  return rows[0];
}

/** The employees these logins belong to (M24's agent names). Users who are not staff are absent. */
export async function employeesByUsers(
  tx: Tx,
  orgId: string,
  userIds: readonly string[],
): Promise<EmployeeRow[]> {
  if (userIds.length === 0) return [];
  const rows = await tx.execute<EmployeeRow>(sql`
    select ${EMPLOYEE_COLUMNS} from hr.employees e
    where e.org_id = ${orgId} and e.user_id = any (${sql.param([...userIds])}::text[])
  `);
  return [...rows];
}

/**
 * Employees matching a set of codes, inside the caller's row scope.
 *
 * `scope` is not optional, and that is the point: this is what a CSV import joins on, and an
 * import is a file somebody pastes in. Without the scope a branch manager — who holds
 * `update Employee` for their own branch — could paste a file naming every employee code in
 * the brand and write another branch's attendance, which is a month of somebody else's pay.
 * Out-of-scope codes simply do not come back, so the importer reports them the same way it
 * reports a code that does not exist: which is the right answer, because the two should be
 * indistinguishable.
 */
export async function employeeIdsByCode(
  tx: Tx,
  orgId: string,
  codes: readonly string[],
  scope: SQL,
): Promise<{ id: string; code: string; branch_id: string | null }[]> {
  if (codes.length === 0) return [];
  const rows = await tx.execute<{ id: string; code: string; branch_id: string | null }>(sql`
    select e.id, e.code, e.branch_id from hr.employees e
    where e.org_id = ${orgId}
      and ${scope}
      and upper(e.code) = any(${sql`array[${sql.join(
        codes.map((code) => sql`${code.toUpperCase()}`),
        sql`, `,
      )}]::text[]`})
  `);
  return [...rows];
}

/**
 * The three encrypted fields, for one employee.
 *
 * The only read of a `*_cipher` column in the module, and it is called only after the
 * caller has been authorised to see this employee. `bytea` arrives as a `Buffer`.
 */
export async function employeeSecrets(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<
  | {
      payout_ref_cipher: Buffer | null;
      national_id_cipher: Buffer | null;
      phone_cipher: Buffer | null;
    }
  | undefined
> {
  const rows = await tx.execute<{
    payout_ref_cipher: Buffer | null;
    national_id_cipher: Buffer | null;
    phone_cipher: Buffer | null;
  }>(sql`
    select payout_ref_cipher, national_id_cipher, phone_cipher
    from hr.employees where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

export interface NewEmployee {
  readonly orgId: string;
  readonly branchId: string | null;
  readonly userId: string | null;
  readonly code: string;
  readonly fullName: string;
  readonly designation: string | null;
  readonly department: string | null;
  readonly joinDate: string;
  readonly calendarId: string | null;
  readonly payoutMethod: string;
  readonly payoutRefCipher: Buffer | null;
  readonly payoutRefMasked: string | null;
  readonly nationalIdCipher: Buffer | null;
  readonly nationalIdMasked: string | null;
  readonly phoneCipher: Buffer | null;
  readonly phoneMasked: string | null;
  readonly createdBy: string;
}

export async function insertEmployee(tx: Tx, employee: NewEmployee): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into hr.employees
      (org_id, branch_id, user_id, code, full_name, designation, department, join_date,
       calendar_id, payout_method, payout_ref_cipher, payout_ref_masked,
       national_id_cipher, national_id_masked, phone_cipher, phone_masked, created_by)
    values (
      ${employee.orgId}, ${employee.branchId}::uuid, ${employee.userId},
      ${employee.code}, ${employee.fullName}, ${employee.designation}, ${employee.department},
      ${employee.joinDate}::date, ${employee.calendarId}::uuid,
      ${employee.payoutMethod}::hr.payout_method,
      ${employee.payoutRefCipher}, ${employee.payoutRefMasked},
      ${employee.nationalIdCipher}, ${employee.nationalIdMasked},
      ${employee.phoneCipher}, ${employee.phoneMasked}, ${employee.createdBy}
    )
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting an employee returned no id');
  return id;
}

export interface EmployeePatch {
  readonly fullName?: string | undefined;
  readonly userId?: string | null | undefined;
  readonly designation?: string | null | undefined;
  readonly department?: string | null | undefined;
  readonly branchId?: string | null | undefined;
  readonly calendarId?: string | null | undefined;
  readonly status?: string | undefined;
  readonly leaveDate?: string | null | undefined;
  readonly payoutMethod?: string | undefined;
  readonly payoutRefCipher?: Buffer | undefined;
  readonly payoutRefMasked?: string | undefined;
  readonly nationalIdCipher?: Buffer | undefined;
  readonly nationalIdMasked?: string | undefined;
  readonly phoneCipher?: Buffer | undefined;
  readonly phoneMasked?: string | undefined;
}

export async function updateEmployee(
  tx: Tx,
  orgId: string,
  id: string,
  patch: EmployeePatch,
): Promise<void> {
  const sets: SQL[] = [];
  if (patch.fullName !== undefined) sets.push(sql`full_name = ${patch.fullName}`);
  if (patch.userId !== undefined) sets.push(sql`user_id = ${patch.userId}`);
  if (patch.designation !== undefined) sets.push(sql`designation = ${patch.designation}`);
  if (patch.department !== undefined) sets.push(sql`department = ${patch.department}`);
  if (patch.branchId !== undefined) sets.push(sql`branch_id = ${patch.branchId}::uuid`);
  if (patch.calendarId !== undefined) sets.push(sql`calendar_id = ${patch.calendarId}::uuid`);
  if (patch.status !== undefined) {
    sets.push(sql`status = ${patch.status}::hr.employment_status`);
  }
  if (patch.leaveDate !== undefined) sets.push(sql`leave_date = ${patch.leaveDate}::date`);
  if (patch.payoutMethod !== undefined) {
    sets.push(sql`payout_method = ${patch.payoutMethod}::hr.payout_method`);
  }
  if (patch.payoutRefCipher !== undefined) {
    sets.push(sql`payout_ref_cipher = ${patch.payoutRefCipher}`);
    sets.push(sql`payout_ref_masked = ${patch.payoutRefMasked ?? null}`);
  }
  if (patch.nationalIdCipher !== undefined) {
    sets.push(sql`national_id_cipher = ${patch.nationalIdCipher}`);
    sets.push(sql`national_id_masked = ${patch.nationalIdMasked ?? null}`);
  }
  if (patch.phoneCipher !== undefined) {
    sets.push(sql`phone_cipher = ${patch.phoneCipher}`);
    sets.push(sql`phone_masked = ${patch.phoneMasked ?? null}`);
  }
  if (sets.length === 0) return;

  await tx.execute(sql`
    update hr.employees set ${sql.join(sets, sql`, `)}, updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

// --- working-day calendars ----------------------------------------------------

export interface CalendarRow extends Record<string, unknown> {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly weekly_off: number[];
  readonly is_default: boolean;
  readonly is_active: boolean;
}

export async function listCalendars(tx: Tx, orgId: string): Promise<CalendarRow[]> {
  const rows = await tx.execute<CalendarRow>(sql`
    select id, code, name, weekly_off, is_default, is_active
    from hr.work_calendars where org_id = ${orgId} order by code
  `);
  return [...rows];
}

export async function calendarById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<CalendarRow | undefined> {
  const rows = await tx.execute<CalendarRow>(sql`
    select id, code, name, weekly_off, is_default, is_active
    from hr.work_calendars where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

export async function defaultCalendar(tx: Tx, orgId: string): Promise<CalendarRow | undefined> {
  const rows = await tx.execute<CalendarRow>(sql`
    select id, code, name, weekly_off, is_default, is_active
    from hr.work_calendars where org_id = ${orgId} and is_default and is_active
  `);
  return rows[0];
}

/**
 * The org's default calendar, creating `STD` if it has none (D-187).
 *
 * Migration 0057 backfills every org that existed when M19 shipped, but migrations run
 * before the org seed — so a brand created afterwards has no calendar, and payroll cannot
 * compute a month without one. Rather than refusing, the first path that needs a calendar
 * creates the same `STD` row the migration would have.
 *
 * `on conflict do nothing` plus a re-read rather than `returning`: two requests racing to
 * create it both succeed, and the loser reads the winner's row instead of getting nothing
 * back from a suppressed insert.
 */
export async function ensureDefaultCalendar(tx: Tx, orgId: string): Promise<CalendarRow> {
  const existing = await defaultCalendar(tx, orgId);
  if (existing !== undefined) return existing;

  await tx.execute(sql`
    insert into hr.work_calendars (org_id, code, name, weekly_off, is_default, is_active)
    values (${orgId}, 'STD', 'Standard (Friday off)', array[5]::smallint[], true, true)
    on conflict do nothing
  `);
  const created = await defaultCalendar(tx, orgId);
  if (created === undefined) {
    // Only reachable if an org has a `STD` calendar that is not the default or not active,
    // which is a deliberate configuration rather than a missing row — so say that.
    throw new Error('This organization has no active default working-day calendar.');
  }
  return created;
}

export async function insertCalendar(
  tx: Tx,
  input: {
    orgId: string;
    code: string;
    name: string;
    weeklyOff: readonly number[];
    isDefault: boolean;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into hr.work_calendars (org_id, code, name, weekly_off, is_default)
    values (${input.orgId}, ${input.code}, ${input.name},
            ${sql`array[${sql.join(
              input.weeklyOff.map((day) => sql`${day}`),
              sql`, `,
            )}]::smallint[]`}, ${input.isDefault})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a calendar returned no id');
  return id;
}

export async function insertHoliday(
  tx: Tx,
  input: { orgId: string; calendarId: string; holidayDate: string; label: string },
): Promise<void> {
  await tx.execute(sql`
    insert into hr.calendar_holidays (org_id, calendar_id, holiday_date, label)
    values (${input.orgId}, ${input.calendarId}, ${input.holidayDate}::date, ${input.label})
    on conflict (org_id, calendar_id, holiday_date) do update set label = excluded.label
  `);
}

export async function holidaysBetween(
  tx: Tx,
  orgId: string,
  calendarId: string,
  from: string,
  to: string,
): Promise<string[]> {
  const rows = await tx.execute<{ holiday_date: string }>(sql`
    select holiday_date::text as holiday_date from hr.calendar_holidays
    where org_id = ${orgId} and calendar_id = ${calendarId}
      and holiday_date between ${from}::date and ${to}::date
    order by holiday_date
  `);
  return rows.map((row) => row.holiday_date);
}

export async function listHolidays(
  tx: Tx,
  orgId: string,
  calendarId: string,
): Promise<{ id: string; holiday_date: string; label: string }[]> {
  const rows = await tx.execute<{ id: string; holiday_date: string; label: string }>(sql`
    select id, holiday_date::text as holiday_date, label from hr.calendar_holidays
    where org_id = ${orgId} and calendar_id = ${calendarId} order by holiday_date
  `);
  return [...rows];
}

// --- salary structures --------------------------------------------------------

export interface StructureRow extends Record<string, unknown> {
  readonly id: string;
  readonly employee_id: string;
  readonly effective_from: string;
  readonly basic_poisha: string;
  readonly note: string | null;
}

export interface ComponentRow extends Record<string, unknown> {
  readonly id: string;
  readonly structure_id: string;
  readonly direction: string;
  readonly code: string;
  readonly label: string;
  readonly amount_poisha: string;
  readonly prorated: boolean;
  readonly line_no: number;
}

export async function listStructures(
  tx: Tx,
  orgId: string,
  employeeId: string,
): Promise<StructureRow[]> {
  const rows = await tx.execute<StructureRow>(sql`
    select id, employee_id, effective_from::text as effective_from,
           basic_poisha::text as basic_poisha, note
    from hr.salary_structures
    where org_id = ${orgId} and employee_id = ${employeeId}
    order by effective_from desc
  `);
  return [...rows];
}

/**
 * The structure in force for a month: the latest one effective on or before its
 * last day.
 *
 * `<= the month's end` rather than `<= the month's start`, so a structure effective
 * from the 15th applies to that month — which is what "effective from" means to the
 * person who typed it. The proration for the days before the 15th is attendance's job,
 * not the structure's.
 */
export async function structureForMonth(
  tx: Tx,
  orgId: string,
  employeeId: string,
  monthEnd: string,
): Promise<StructureRow | undefined> {
  const rows = await tx.execute<StructureRow>(sql`
    select id, employee_id, effective_from::text as effective_from,
           basic_poisha::text as basic_poisha, note
    from hr.salary_structures
    where org_id = ${orgId} and employee_id = ${employeeId}
      and effective_from <= ${monthEnd}::date
    order by effective_from desc
    limit 1
  `);
  return rows[0];
}

export async function componentsFor(
  tx: Tx,
  orgId: string,
  structureIds: readonly string[],
): Promise<ComponentRow[]> {
  if (structureIds.length === 0) return [];
  const rows = await tx.execute<ComponentRow>(sql`
    select id, structure_id, direction::text as direction, code, label,
           amount_poisha::text as amount_poisha, prorated, line_no
    from hr.salary_components
    where org_id = ${orgId} and structure_id = any(${sql`array[${sql.join(
      structureIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::uuid[]`})
    order by structure_id, line_no
  `);
  return [...rows];
}

export async function insertStructure(
  tx: Tx,
  input: {
    orgId: string;
    employeeId: string;
    effectiveFrom: string;
    basicPoisha: bigint;
    note: string | null;
    createdBy: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into hr.salary_structures
      (org_id, employee_id, effective_from, basic_poisha, note, created_by)
    values (${input.orgId}, ${input.employeeId}, ${input.effectiveFrom}::date,
            ${input.basicPoisha.toString()}, ${input.note}, ${input.createdBy})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a salary structure returned no id');
  return id;
}

export async function insertComponent(
  tx: Tx,
  input: {
    orgId: string;
    structureId: string;
    direction: string;
    code: string;
    label: string;
    amountPoisha: bigint;
    prorated: boolean;
    lineNo: number;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into hr.salary_components
      (org_id, structure_id, direction, code, label, amount_poisha, prorated, line_no)
    values (${input.orgId}, ${input.structureId}, ${input.direction}::hr.component_direction,
            ${input.code}, ${input.label}, ${input.amountPoisha.toString()},
            ${input.prorated}, ${input.lineNo})
  `);
}

// --- attendance ---------------------------------------------------------------

export interface AttendanceRow extends Record<string, unknown> {
  readonly id: string;
  readonly employee_id: string;
  readonly branch_id: string | null;
  readonly business_date: string;
  readonly status: string;
  readonly check_in_at: Date | null;
  readonly check_out_at: Date | null;
  readonly source: string;
  readonly note: string | null;
}

export async function listAttendance(
  tx: Tx,
  orgId: string,
  filters: {
    readonly scope: SQL;
    readonly from: string;
    readonly to: string;
    readonly employeeId?: string | undefined;
    readonly branchId?: string | undefined;
  },
): Promise<AttendanceRow[]> {
  const rows = await tx.execute<AttendanceRow>(sql`
    select a.id, a.employee_id, a.branch_id, a.business_date::text as business_date,
           a.status::text as status, a.check_in_at, a.check_out_at,
           a.source::text as source, a.note
    from hr.attendance_days a
    where a.org_id = ${orgId}
      and ${filters.scope}
      and a.business_date between ${filters.from}::date and ${filters.to}::date
      and ${filters.employeeId === undefined ? sql`true` : sql`a.employee_id = ${filters.employeeId}`}
      and ${filters.branchId === undefined ? sql`true` : sql`a.branch_id = ${filters.branchId}`}
    order by a.business_date, a.employee_id
  `);
  return [...rows];
}

export interface AttendanceUpsert {
  readonly orgId: string;
  readonly employeeId: string;
  readonly branchId: string | null;
  readonly businessDate: string;
  readonly status: string;
  readonly checkInAt: Date | null;
  readonly checkOutAt: Date | null;
  readonly source: 'manual' | 'csv_import' | 'device';
  readonly importId: string | null;
  readonly note: string | null;
  readonly recordedBy: string;
}

/**
 * Record or correct one day.
 *
 * `on conflict … do update` rather than delete-and-insert, because 0054 grants no
 * DELETE on this table: an absence that could be removed would make "we deleted the
 * absence" possible, and the audit trail would be the only evidence it ever existed.
 * An update leaves the row, its id and its `created_at` in place.
 *
 * The update forces `source` to what the caller passed, which for a correction is
 * `manual` — migration 0055's trigger refuses a correction that claims to be from a
 * device, so a hand-edited month cannot hide behind the biometric import.
 */
export async function upsertAttendance(tx: Tx, entry: AttendanceUpsert): Promise<void> {
  await tx.execute(sql`
    insert into hr.attendance_days
      (org_id, employee_id, branch_id, business_date, status, check_in_at, check_out_at,
       source, import_id, note, recorded_by)
    values (${entry.orgId}, ${entry.employeeId}, ${entry.branchId}::uuid,
            ${entry.businessDate}::date, ${entry.status}::hr.attendance_status,
            ${entry.checkInAt}, ${entry.checkOutAt},
            ${entry.source}::hr.attendance_source, ${entry.importId}::uuid,
            ${entry.note}, ${entry.recordedBy})
    on conflict (org_id, employee_id, business_date) do update
      set status = excluded.status,
          check_in_at = excluded.check_in_at,
          check_out_at = excluded.check_out_at,
          source = excluded.source,
          import_id = excluded.import_id,
          note = excluded.note,
          recorded_by = excluded.recorded_by,
          updated_at = now()
  `);
}

export interface ImportRow extends Record<string, unknown> {
  readonly id: string;
  readonly month: string;
  readonly file_name: string | null;
  readonly status: string;
  readonly mapping: unknown;
  readonly row_count: number;
  readonly accepted_count: number;
  readonly rejected_count: number;
  readonly rejected: unknown;
  readonly created_by: string;
  readonly created_at: Date;
}

export async function insertImport(
  tx: Tx,
  input: {
    orgId: string;
    month: string;
    fileName: string | null;
    status: 'parsed' | 'applied' | 'rejected';
    mapping: unknown;
    rowCount: number;
    acceptedCount: number;
    rejectedCount: number;
    rejected: unknown;
    createdBy: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into hr.attendance_imports
      (org_id, month, file_name, status, mapping, row_count, accepted_count,
       rejected_count, rejected, created_by)
    values (${input.orgId}, ${input.month}, ${input.fileName},
            ${input.status}::hr.attendance_import_status,
            ${JSON.stringify(input.mapping)}::jsonb, ${input.rowCount},
            ${input.acceptedCount}, ${input.rejectedCount},
            ${JSON.stringify(input.rejected)}::jsonb, ${input.createdBy})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting an attendance import returned no id');
  return id;
}

export async function listImports(tx: Tx, orgId: string, month?: string): Promise<ImportRow[]> {
  const rows = await tx.execute<ImportRow>(sql`
    select id, month, file_name, status::text as status, mapping, row_count,
           accepted_count, rejected_count, rejected, created_by, created_at
    from hr.attendance_imports
    where org_id = ${orgId} and ${month === undefined ? sql`true` : sql`month = ${month}`}
    order by created_at desc
    limit 100
  `);
  return [...rows];
}

// --- loans --------------------------------------------------------------------

export interface LoanRow extends Record<string, unknown> {
  readonly id: string;
  readonly employee_id: string;
  readonly branch_id: string | null;
  readonly principal_poisha: string;
  readonly instalment_count: number;
  readonly first_month: string;
  readonly status: string;
  readonly journal_id: string | null;
  readonly disbursed_on: string | null;
  readonly note: string | null;
  readonly created_by: string;
}

export interface InstalmentRow extends Record<string, unknown> {
  readonly id: string;
  readonly loan_id: string;
  readonly employee_id: string;
  readonly seq: number;
  readonly due_month: string;
  readonly amount_poisha: string;
  readonly deducted_poisha: string;
  readonly status: string;
}

export async function listLoans(
  tx: Tx,
  orgId: string,
  filters: {
    readonly scope: SQL;
    readonly employeeId?: string | undefined;
    readonly status?: string | undefined;
  },
): Promise<LoanRow[]> {
  const rows = await tx.execute<LoanRow>(sql`
    select l.id, l.employee_id, l.branch_id, l.principal_poisha::text as principal_poisha,
           l.instalment_count, l.first_month, l.status::text as status, l.journal_id,
           l.disbursed_on::text as disbursed_on, l.note, l.created_by
    from hr.employee_loans l
    where l.org_id = ${orgId}
      and ${filters.scope}
      and ${filters.employeeId === undefined ? sql`true` : sql`l.employee_id = ${filters.employeeId}`}
      and ${filters.status === undefined ? sql`true` : sql`l.status = ${filters.status}::hr.loan_status`}
    order by l.created_at desc
  `);
  return [...rows];
}

export async function loanById(tx: Tx, orgId: string, id: string): Promise<LoanRow | undefined> {
  const rows = await tx.execute<LoanRow>(sql`
    select l.id, l.employee_id, l.branch_id, l.principal_poisha::text as principal_poisha,
           l.instalment_count, l.first_month, l.status::text as status, l.journal_id,
           l.disbursed_on::text as disbursed_on, l.note, l.created_by
    from hr.employee_loans l where l.org_id = ${orgId} and l.id = ${id}
  `);
  return rows[0];
}

export async function insertLoan(
  tx: Tx,
  input: {
    orgId: string;
    employeeId: string;
    branchId: string | null;
    principalPoisha: bigint;
    instalmentCount: number;
    firstMonth: string;
    note: string | null;
    createdBy: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into hr.employee_loans
      (org_id, employee_id, branch_id, principal_poisha, instalment_count, first_month,
       status, note, created_by)
    values (${input.orgId}, ${input.employeeId}, ${input.branchId}::uuid,
            ${input.principalPoisha.toString()}, ${input.instalmentCount},
            ${input.firstMonth}, 'pending_disbursement', ${input.note}, ${input.createdBy})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a loan returned no id');
  return id;
}

export async function insertInstalment(
  tx: Tx,
  input: {
    orgId: string;
    loanId: string;
    seq: number;
    dueMonth: string;
    amountPoisha: bigint;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into hr.loan_instalments (org_id, loan_id, seq, due_month, amount_poisha)
    values (${input.orgId}, ${input.loanId}, ${input.seq}, ${input.dueMonth},
            ${input.amountPoisha.toString()})
  `);
}

export async function markLoanDisbursed(
  tx: Tx,
  orgId: string,
  id: string,
  input: { journalId: string; walletAccountId: string; disbursedOn: string },
): Promise<void> {
  await tx.execute(sql`
    update hr.employee_loans
    set status = 'active', journal_id = ${input.journalId},
        wallet_account_id = ${input.walletAccountId}, disbursed_on = ${input.disbursedOn}::date,
        updated_at = now()
    where org_id = ${orgId} and id = ${id} and status = 'pending_disbursement'
  `);
}

export async function instalmentsForLoan(
  tx: Tx,
  orgId: string,
  loanId: string,
): Promise<InstalmentRow[]> {
  const rows = await tx.execute<InstalmentRow>(sql`
    select i.id, i.loan_id, l.employee_id, i.seq, i.due_month,
           i.amount_poisha::text as amount_poisha, i.deducted_poisha::text as deducted_poisha,
           i.status::text as status
    from hr.loan_instalments i
    join hr.employee_loans l on l.org_id = i.org_id and l.id = i.loan_id
    where i.org_id = ${orgId} and i.loan_id = ${loanId}
    order by i.seq
  `);
  return [...rows];
}

/**
 * Every instalment still owing anything, for active loans, due on or before `month`.
 *
 * `for update` on the instalment rows, because two payroll runs for two months
 * submitted at the same second would otherwise both read the same outstanding
 * instalment and both deduct it. The CHECK in 0053 would catch the overflow, but a
 * CHECK violation surfaces as a 500 for whoever lost the race; the lock makes the
 * second one read the committed remainder and deduct what is actually left.
 */
export async function outstandingInstalments(
  tx: Tx,
  orgId: string,
  month: string,
): Promise<InstalmentRow[]> {
  const rows = await tx.execute<InstalmentRow>(sql`
    select i.id, i.loan_id, l.employee_id, i.seq, i.due_month,
           i.amount_poisha::text as amount_poisha, i.deducted_poisha::text as deducted_poisha,
           i.status::text as status
    from hr.loan_instalments i
    join hr.employee_loans l on l.org_id = i.org_id and l.id = i.loan_id
    where i.org_id = ${orgId}
      and l.status = 'active'
      and i.status in ('due', 'partly_deducted')
      and i.due_month <= ${month}
      and i.deducted_poisha < i.amount_poisha
    order by l.employee_id, i.due_month, i.seq
    for update of i
  `);
  return [...rows];
}

export async function applyInstalmentDeduction(
  tx: Tx,
  orgId: string,
  instalmentId: string,
  amountPoisha: bigint,
): Promise<void> {
  await tx.execute(sql`
    update hr.loan_instalments
    set deducted_poisha = deducted_poisha + ${amountPoisha.toString()},
        status = case
          when deducted_poisha + ${amountPoisha.toString()} >= amount_poisha then 'deducted'
          else 'partly_deducted'
        end::hr.loan_instalment_status,
        updated_at = now()
    where org_id = ${orgId} and id = ${instalmentId}
  `);
}

/** Settle a loan whose every instalment has been taken. */
export async function settleFullyDeductedLoans(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(sql`
    update hr.employee_loans l
    set status = 'settled', updated_at = now()
    where l.org_id = ${orgId} and l.status = 'active'
      and not exists (
        select 1 from hr.loan_instalments i
        where i.org_id = l.org_id and i.loan_id = l.id
          and i.status in ('due', 'partly_deducted')
      )
  `);
}

// --- payroll runs -------------------------------------------------------------

export interface RunRow extends Record<string, unknown> {
  readonly id: string;
  readonly month: string;
  readonly status: string;
  readonly unrecorded_policy: string;
  readonly employee_count: number;
  readonly gross_poisha: string;
  readonly deductions_poisha: string;
  readonly net_poisha: string;
  readonly approval_request_id: string | null;
  readonly journal_id: string | null;
  readonly payment_journal_id: string | null;
  readonly paid_from_account_id: string | null;
  readonly posted_on: string | null;
  readonly paid_on: string | null;
  readonly memo: string | null;
  readonly created_by: string;
}

const RUN_COLUMNS = sql`
  r.id, r.month, r.status::text as status, r.unrecorded_policy, r.employee_count,
  r.gross_poisha::text as gross_poisha, r.deductions_poisha::text as deductions_poisha,
  r.net_poisha::text as net_poisha, r.approval_request_id, r.journal_id,
  r.payment_journal_id, r.paid_from_account_id, r.posted_on::text as posted_on,
  r.paid_on::text as paid_on, r.memo, r.created_by
`;

export async function listRuns(
  tx: Tx,
  orgId: string,
  filters: { readonly status?: string | undefined; readonly month?: string | undefined },
): Promise<RunRow[]> {
  const rows = await tx.execute<RunRow>(sql`
    select ${RUN_COLUMNS} from hr.payroll_runs r
    where r.org_id = ${orgId}
      and ${filters.status === undefined ? sql`true` : sql`r.status = ${filters.status}::hr.payroll_run_status`}
      and ${filters.month === undefined ? sql`true` : sql`r.month = ${filters.month}`}
    order by r.month desc
  `);
  return [...rows];
}

export async function runById(tx: Tx, orgId: string, id: string): Promise<RunRow | undefined> {
  const rows = await tx.execute<RunRow>(sql`
    select ${RUN_COLUMNS} from hr.payroll_runs r where r.org_id = ${orgId} and r.id = ${id}
  `);
  return rows[0];
}

/** Locks the run row, so a second submit or post waits rather than racing. */
export async function runForUpdate(tx: Tx, orgId: string, id: string): Promise<RunRow | undefined> {
  const rows = await tx.execute<RunRow>(sql`
    select ${RUN_COLUMNS} from hr.payroll_runs r
    where r.org_id = ${orgId} and r.id = ${id}
    for update
  `);
  return rows[0];
}

export async function runByApproval(
  tx: Tx,
  orgId: string,
  approvalId: string,
): Promise<RunRow | undefined> {
  const rows = await tx.execute<RunRow>(sql`
    select ${RUN_COLUMNS} from hr.payroll_runs r
    where r.org_id = ${orgId} and r.approval_request_id = ${approvalId}
    for update
  `);
  return rows[0];
}

export async function insertRun(
  tx: Tx,
  input: {
    orgId: string;
    month: string;
    unrecordedPolicy: string;
    memo: string | null;
    createdBy: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into hr.payroll_runs (org_id, month, status, unrecorded_policy, memo, created_by)
    values (${input.orgId}, ${input.month}, 'draft', ${input.unrecordedPolicy},
            ${input.memo}, ${input.createdBy})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a payroll run returned no id');
  return id;
}

export async function submitRun(
  tx: Tx,
  orgId: string,
  id: string,
  input: {
    approvalRequestId: string;
    employeeCount: number;
    grossPoisha: bigint;
    deductionsPoisha: bigint;
    netPoisha: bigint;
  },
): Promise<void> {
  await tx.execute(sql`
    update hr.payroll_runs
    set status = 'pending_approval',
        approval_request_id = ${input.approvalRequestId},
        employee_count = ${input.employeeCount},
        gross_poisha = ${input.grossPoisha.toString()},
        deductions_poisha = ${input.deductionsPoisha.toString()},
        net_poisha = ${input.netPoisha.toString()},
        updated_at = now()
    where org_id = ${orgId} and id = ${id} and status = 'draft'
  `);
}

export async function markRunPosted(
  tx: Tx,
  orgId: string,
  id: string,
  input: { journalId: string; postedOn: string },
): Promise<void> {
  await tx.execute(sql`
    update hr.payroll_runs
    set status = 'posted', journal_id = ${input.journalId}, posted_on = ${input.postedOn}::date,
        updated_at = now()
    where org_id = ${orgId} and id = ${id} and status = 'pending_approval'
  `);
}

export async function markRunPaid(
  tx: Tx,
  orgId: string,
  id: string,
  input: { paymentJournalId: string; walletAccountId: string; paidOn: string },
): Promise<void> {
  await tx.execute(sql`
    update hr.payroll_runs
    set status = 'paid', payment_journal_id = ${input.paymentJournalId},
        paid_from_account_id = ${input.walletAccountId}, paid_on = ${input.paidOn}::date,
        updated_at = now()
    where org_id = ${orgId} and id = ${id} and status = 'posted'
  `);
}

export async function setRunStatus(
  tx: Tx,
  orgId: string,
  id: string,
  status: 'rejected' | 'cancelled',
): Promise<void> {
  await tx.execute(sql`
    update hr.payroll_runs set status = ${status}::hr.payroll_run_status, updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

// --- payroll inputs, lines and components -------------------------------------

export interface InputRow extends Record<string, unknown> {
  readonly id: string;
  readonly employee_id: string;
  readonly kind: string;
  readonly label: string;
  readonly amount_poisha: string;
  readonly note: string | null;
}

export async function listInputs(tx: Tx, orgId: string, runId: string): Promise<InputRow[]> {
  const rows = await tx.execute<InputRow>(sql`
    select id, employee_id, kind::text as kind, label, amount_poisha::text as amount_poisha, note
    from hr.payroll_inputs where org_id = ${orgId} and run_id = ${runId}
    order by employee_id, kind, label
  `);
  return [...rows];
}

export async function insertInput(
  tx: Tx,
  input: {
    orgId: string;
    runId: string;
    employeeId: string;
    kind: string;
    label: string;
    amountPoisha: bigint;
    note: string | null;
    createdBy: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into hr.payroll_inputs
      (org_id, run_id, employee_id, kind, label, amount_poisha, note, created_by)
    values (${input.orgId}, ${input.runId}, ${input.employeeId},
            ${input.kind}::hr.payroll_input_kind, ${input.label},
            ${input.amountPoisha.toString()}, ${input.note}, ${input.createdBy})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a payroll input returned no id');
  return id;
}

/**
 * One input of one run. The run is part of the match (M20 ledger audit N10): by id alone,
 * a run's URL could delete another draft run's input — and with it, through the cascade,
 * the bonus award that input carries.
 */
export async function deleteInput(
  tx: Tx,
  orgId: string,
  runId: string,
  id: string,
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from hr.payroll_inputs
    where org_id = ${orgId} and run_id = ${runId} and id = ${id}
    returning id
  `);
  return rows.length;
}

export interface LineRow extends Record<string, unknown> {
  readonly id: string;
  readonly run_id: string;
  readonly employee_id: string;
  readonly branch_id: string | null;
  readonly salary_structure_id: string;
  readonly basic_poisha: string;
  readonly allowances_poisha: string;
  readonly bonus_poisha: string;
  readonly gross_poisha: string;
  readonly absence_deduction_poisha: string;
  readonly fixed_deduction_poisha: string;
  readonly other_deduction_poisha: string;
  readonly loan_deduction_poisha: string;
  readonly loan_shortfall_poisha: string;
  readonly deductions_poisha: string;
  readonly net_poisha: string;
  readonly salary_expense_poisha: string;
  readonly working_days: number;
  readonly present_days: number;
  readonly absent_days: number;
  readonly half_days: number;
  readonly paid_leave_days: number;
  readonly unrecorded_days: number;
}

const LINE_COLUMNS = sql`
  l.id, l.run_id, l.employee_id, l.branch_id, l.salary_structure_id,
  l.basic_poisha::text as basic_poisha, l.allowances_poisha::text as allowances_poisha,
  l.bonus_poisha::text as bonus_poisha, l.gross_poisha::text as gross_poisha,
  l.absence_deduction_poisha::text as absence_deduction_poisha,
  l.fixed_deduction_poisha::text as fixed_deduction_poisha,
  l.other_deduction_poisha::text as other_deduction_poisha,
  l.loan_deduction_poisha::text as loan_deduction_poisha,
  l.loan_shortfall_poisha::text as loan_shortfall_poisha,
  l.deductions_poisha::text as deductions_poisha, l.net_poisha::text as net_poisha,
  l.salary_expense_poisha::text as salary_expense_poisha,
  l.working_days, l.present_days, l.absent_days, l.half_days, l.paid_leave_days,
  l.unrecorded_days
`;

export async function listLines(tx: Tx, orgId: string, runId: string): Promise<LineRow[]> {
  const rows = await tx.execute<LineRow>(sql`
    select ${LINE_COLUMNS} from hr.payroll_lines l
    where l.org_id = ${orgId} and l.run_id = ${runId}
    order by l.employee_id
  `);
  return [...rows];
}

export async function lineById(tx: Tx, orgId: string, id: string): Promise<LineRow | undefined> {
  const rows = await tx.execute<LineRow>(sql`
    select ${LINE_COLUMNS} from hr.payroll_lines l where l.org_id = ${orgId} and l.id = ${id}
  `);
  return rows[0];
}

export async function lineForRunEmployee(
  tx: Tx,
  orgId: string,
  runId: string,
  employeeId: string,
): Promise<LineRow | undefined> {
  const rows = await tx.execute<LineRow>(sql`
    select ${LINE_COLUMNS} from hr.payroll_lines l
    where l.org_id = ${orgId} and l.run_id = ${runId} and l.employee_id = ${employeeId}
  `);
  return rows[0];
}

export interface NewLine {
  readonly orgId: string;
  readonly runId: string;
  readonly employeeId: string;
  readonly branchId: string | null;
  readonly salaryStructureId: string;
  readonly basicPoisha: bigint;
  readonly allowancesPoisha: bigint;
  readonly bonusPoisha: bigint;
  readonly grossPoisha: bigint;
  readonly absenceDeductionPoisha: bigint;
  readonly fixedDeductionPoisha: bigint;
  readonly otherDeductionPoisha: bigint;
  readonly loanDeductionPoisha: bigint;
  readonly loanShortfallPoisha: bigint;
  readonly deductionsPoisha: bigint;
  readonly netPoisha: bigint;
  readonly salaryExpensePoisha: bigint;
  readonly workingDays: number;
  readonly presentDays: number;
  readonly absentDays: number;
  readonly halfDays: number;
  readonly paidLeaveDays: number;
  readonly unrecordedDays: number;
}

export async function insertLine(tx: Tx, line: NewLine): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into hr.payroll_lines
      (org_id, run_id, employee_id, branch_id, salary_structure_id, basic_poisha,
       allowances_poisha, bonus_poisha, gross_poisha, absence_deduction_poisha,
       fixed_deduction_poisha, other_deduction_poisha, loan_deduction_poisha,
       loan_shortfall_poisha, deductions_poisha, net_poisha, salary_expense_poisha,
       working_days, present_days, absent_days, half_days, paid_leave_days, unrecorded_days)
    values (${line.orgId}, ${line.runId}, ${line.employeeId}, ${line.branchId}::uuid,
            ${line.salaryStructureId}, ${line.basicPoisha.toString()},
            ${line.allowancesPoisha.toString()}, ${line.bonusPoisha.toString()},
            ${line.grossPoisha.toString()}, ${line.absenceDeductionPoisha.toString()},
            ${line.fixedDeductionPoisha.toString()}, ${line.otherDeductionPoisha.toString()},
            ${line.loanDeductionPoisha.toString()}, ${line.loanShortfallPoisha.toString()},
            ${line.deductionsPoisha.toString()}, ${line.netPoisha.toString()},
            ${line.salaryExpensePoisha.toString()}, ${line.workingDays}, ${line.presentDays},
            ${line.absentDays}, ${line.halfDays}, ${line.paidLeaveDays}, ${line.unrecordedDays})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a payroll line returned no id');
  return id;
}

export async function insertLineComponent(
  tx: Tx,
  input: {
    orgId: string;
    lineId: string;
    direction: string;
    code: string;
    label: string;
    amountPoisha: bigint;
    lineNo: number;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into hr.payroll_line_components
      (org_id, line_id, direction, code, label, amount_poisha, line_no)
    values (${input.orgId}, ${input.lineId}, ${input.direction}::hr.component_direction,
            ${input.code}, ${input.label}, ${input.amountPoisha.toString()}, ${input.lineNo})
  `);
}

export interface LineComponentRow extends Record<string, unknown> {
  readonly direction: string;
  readonly code: string;
  readonly label: string;
  readonly amount_poisha: string;
  readonly line_no: number;
}

export async function lineComponents(
  tx: Tx,
  orgId: string,
  lineId: string,
): Promise<LineComponentRow[]> {
  const rows = await tx.execute<LineComponentRow>(sql`
    select direction::text as direction, code, label,
           amount_poisha::text as amount_poisha, line_no
    from hr.payroll_line_components
    where org_id = ${orgId} and line_id = ${lineId}
    order by line_no
  `);
  return [...rows];
}

export async function insertLoanDeduction(
  tx: Tx,
  input: { orgId: string; lineId: string; instalmentId: string; amountPoisha: bigint },
): Promise<void> {
  await tx.execute(sql`
    insert into hr.payroll_loan_deductions (org_id, line_id, instalment_id, amount_poisha)
    values (${input.orgId}, ${input.lineId}, ${input.instalmentId},
            ${input.amountPoisha.toString()})
  `);
}

/** The brand's own details, for the payslip's header (§22, D-034). */
export async function orgBrand(
  tx: Tx,
  orgId: string,
): Promise<{ display_name: string; legal_name: string; brand: unknown } | undefined> {
  const rows = await tx.execute<{ display_name: string; legal_name: string; brand: unknown }>(sql`
    select display_name, legal_name, brand from org.organizations where id = ${orgId}
  `);
  return rows[0];
}
