import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { approvalRequests } from '../approvals/index.js';
import { primaryId, timestamps } from '../columns.js';
import { journals, ledgerAccounts } from '../ledger/index.js';
import { users } from '../iam/index.js';
import { branches, organizations } from '../org/index.js';

/**
 * Employees, attendance, salary structures, loans and payroll runs
 * (architecture §7, §12; M19).
 *
 * This schema holds the most sensitive rows in the system, and two decisions run
 * through all of it.
 *
 * ## Personal data is either masked or encrypted, never plain (invariant 10)
 *
 * A national ID number, a bank account number and a phone number are personal data
 * about a real person who did not choose to be in a database. They appear here
 * twice and never once: a `*_cipher` column holding an AES-256-GCM envelope the
 * database cannot read, and a `*_masked` column holding what a screen is allowed to
 * show. Nothing stores the plain value, so nothing can leak it — not a backup, not
 * a `select *` in a psql session, not a CSV export, not an LLM prompt. M19's
 * acceptance check 3 is exactly this: *encrypted fields are unreadable in a raw
 * database query*.
 *
 * Salary is the exception, and the asymmetry is deliberate. An amount has to be
 * summed, prorated and posted to a ledger, so it lives in ordinary `bigint`
 * `*_poisha` columns (invariant 1) and is protected by permissions instead — §6
 * gives `Payroll` to hr, accounts and org_admin and to nobody else. Encrypting it
 * would mean payroll arithmetic in application memory with no database check that
 * the totals add up, which trades a real guarantee for the appearance of one.
 *
 * ## The numbers a checker approved are frozen
 *
 * A payroll run's lines and their components are written **once**, when the run is
 * submitted for approval, and are append-only from then on (0054's grants). The
 * approval carries the same total, migration 0055 refuses a run whose approval says
 * a different amount, and 0055's status trigger refuses a second posting. Between
 * them, "what was approved" and "what was posted" cannot be two different numbers.
 *
 * Every table is tenant-scoped — `org_id NOT NULL`, indexed, RLS ENABLE and FORCE
 * from `tenantTableSql()` in migration 0054 — and every foreign key between two
 * tenant tables carries `org_id` on both sides (D-047).
 */
export const hr = pgSchema('hr');

/**
 * An encrypted field: the ciphertext envelope, as `bytea`.
 *
 * `customType` rather than `text`, because the type is the documentation that
 * matters here — a `text` column called `national_id_cipher` is one careless
 * assignment away from holding a national ID number, and nothing would complain.
 * A `bytea` holding `Buffer` cannot accidentally be given a string that means
 * something.
 *
 * The envelope's layout, the key and the AAD are `apps/server/src/modules/hr/
 * hr.crypto.ts`'s business. The database's job is to store bytes it cannot read.
 */
const cipher = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/** Where an employee stands. `resigned` and `terminated` differ for HR, not for pay. */
export const employmentStatus = hr.enum('employment_status', [
  'active',
  /** Employed but not working: unpaid suspension pending an investigation. */
  'suspended',
  'resigned',
  'terminated',
]);

/** How the net pay reaches the employee. Decides which payout reference is needed. */
export const payoutMethod = hr.enum('payout_method', ['cash', 'bank', 'bkash', 'nagad']);

/**
 * What a recorded day says about pay (`packages/domain/src/payroll/attendance.ts`).
 *
 * The enum is duplicated between the database and the domain, and a test asserts
 * they are the same list. That is the cheap half of the alternative: a status the
 * database accepts and the domain has no rule for would be a day that silently
 * prorates as present.
 */
export const attendanceStatus = hr.enum('attendance_status', [
  'present',
  'late',
  'half_day',
  'absent',
  'leave_unpaid',
  'leave_paid',
  'weekly_off',
  'holiday',
]);

/** Where an attendance row came from, so a manual correction is distinguishable. */
export const attendanceSource = hr.enum('attendance_source', ['manual', 'csv_import', 'device']);

/** Where a CSV import got to. A parsed import has changed no attendance. */
export const attendanceImportStatus = hr.enum('attendance_import_status', [
  'parsed',
  'applied',
  'rejected',
]);

/**
 * A payroll run's life (§12: `draft → approved (maker-checker) → posted → paid`).
 *
 * Split finer than §12's four words, because the two states §12 collapses are the
 * two that matter operationally. `pending_approval` is a run whose numbers are
 * frozen and which has changed nothing — no journal, no ledger effect, no loan
 * marked deducted. `posted` is a run whose salary is a liability. Between them sits
 * a checker, and the whole point is that a pending run is indistinguishable from a
 * draft as far as the books are concerned.
 *
 * There is no `approved` state of its own: the approval and the posting happen in
 * the same transaction (the approvals module runs the executor inside the deciding
 * transaction), so a run that is approved and not posted is a state that would only
 * ever exist after a crash — and a state that only exists after a crash is a state
 * nobody writes correct code for.
 */
export const payrollRunStatus = hr.enum('payroll_run_status', [
  'draft',
  'pending_approval',
  'posted',
  'paid',
  'rejected',
  'cancelled',
]);

/** What a one-off payroll input is. Bonus inputs feed §12's bonus expense. */
export const payrollInputKind = hr.enum('payroll_input_kind', ['bonus', 'deduction']);

/** Where a loan stands. `active` means money is out and instalments are running. */
export const loanStatus = hr.enum('loan_status', [
  'pending_disbursement',
  'active',
  'settled',
  'written_off',
]);

/** An instalment's own state. `waived` is a deliberate write-off of one month. */
export const loanInstalmentStatus = hr.enum('loan_instalment_status', [
  'due',
  'partly_deducted',
  'deducted',
  'waived',
]);

/**
 * An org's working-day calendar (§12).
 *
 * `weekly_off` is a list of weekday numbers, 0 = Sunday, because Bangladesh's
 * weekend is Friday alone in some offices and Friday plus Saturday in others.
 * A `smallint[]` rather than seven booleans: the domain reads it as a list, and
 * seven columns would need seven CHECKs and still allow "no day off".
 */
export const workCalendars = hr.table(
  'work_calendars',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    weeklyOff: smallint('weekly_off').array().notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    index('work_calendars_org_idx').on(table.orgId),
    uniqueIndex('work_calendars_org_code_idx').on(table.orgId, table.code),
    // One default per org. A partial unique index rather than a trigger: two
    // defaults would make "which calendar does an employee with none use" depend
    // on row order.
    uniqueIndex('work_calendars_org_default_idx')
      .on(table.orgId)
      .where(sql`is_default`),
    unique('work_calendars_org_id_id_key').on(table.orgId, table.id),
    check('work_calendars_code_format', sql`${table.code} ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'`),
    check(
      'work_calendars_weekly_off_valid',
      // Every entry a real weekday, and never all seven: a calendar with no working
      // day pays a full month for a month nobody could work, and there is no reading
      // of that anybody meant.
      sql`array_length(${table.weeklyOff}, 1) is null
          or (${table.weeklyOff} <@ array[0,1,2,3,4,5,6]::smallint[]
              and array_length(${table.weeklyOff}, 1) <= 6)`,
    ),
  ],
);

/** A dated holiday on a calendar. A holiday on a weekly off is simply both. */
export const calendarHolidays = hr.table(
  'calendar_holidays',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    calendarId: uuid('calendar_id').notNull(),
    holidayDate: date('holiday_date', { mode: 'string' }).notNull(),
    label: text('label').notNull(),
    ...timestamps,
  },
  (table) => [
    index('calendar_holidays_org_idx').on(table.orgId),
    uniqueIndex('calendar_holidays_org_calendar_date_idx').on(
      table.orgId,
      table.calendarId,
      table.holidayDate,
    ),
    unique('calendar_holidays_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'calendar_holidays_org_id_calendar_id_fk',
      columns: [table.orgId, table.calendarId],
      foreignColumns: [workCalendars.orgId, workCalendars.id],
    }).onDelete('cascade'),
    check('calendar_holidays_label_length', sql`length(${table.label}) between 1 and 120`),
  ],
);

/**
 * A person the org employs (§12).
 *
 * `user_id` is nullable and that is the common case rather than an edge one: a
 * warehouse packer or a delivery rider is an employee with a salary and no login.
 * Making it NOT NULL would force an account for everybody, which is both a licence
 * cost and a credential nobody uses — and a credential nobody uses is a credential
 * nobody rotates.
 *
 * `code` is the org's own employee number and is what the attendance CSV joins on,
 * because the biometric device knows an employee number and does not know a uuid.
 */
export const employees = hr.table(
  'employees',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Which branch they work at. Null for head-office staff with no branch. */
    branchId: uuid('branch_id'),
    /** The login, when they have one. Global table, so a plain reference. */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** The org's employee number, e.g. `EMP-014`. What the device CSV carries. */
    code: text('code').notNull(),
    fullName: text('full_name').notNull(),
    designation: text('designation'),
    department: text('department'),
    joinDate: date('join_date', { mode: 'string' }).notNull(),
    /** Inclusive last day of employment. Null while employed. */
    leaveDate: date('leave_date', { mode: 'string' }),
    status: employmentStatus('status').notNull().default('active'),
    /**
     * The working-day calendar this employee's month is measured against.
     *
     * Per employee rather than only per org, because a showroom on a six-day week
     * and a head office on a five-day week is the normal arrangement, and §12's
     * "working-day calendar per org" is then the default rather than the only one.
     * Null means the org's default calendar.
     */
    calendarId: uuid('calendar_id'),
    payoutMethod: payoutMethod('payout_method').notNull().default('cash'),
    /**
     * The bank or mobile-wallet number, encrypted (§12: "encrypted at application
     * level"). Unreadable in a raw query (check 3).
     */
    payoutRefCipher: cipher('payout_ref_cipher'),
    /** Last four digits, for a screen to confirm the right account. */
    payoutRefMasked: text('payout_ref_masked'),
    /** The national ID number, encrypted. Never in a log, a fixture or a prompt. */
    nationalIdCipher: cipher('national_id_cipher'),
    nationalIdMasked: text('national_id_masked'),
    /** The employee's phone, encrypted; the mask is what appears on screen. */
    phoneCipher: cipher('phone_cipher'),
    phoneMasked: text('phone_masked'),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    index('employees_org_idx').on(table.orgId),
    index('employees_org_branch_idx').on(table.orgId, table.branchId),
    index('employees_org_status_idx').on(table.orgId, table.status),
    uniqueIndex('employees_org_code_idx').on(table.orgId, table.code),
    /*
     * One employee row per user per org.
     *
     * A partial index, so the many employees with no login do not collide on NULL.
     * Two employee rows for one person would each get a payslip and each be paid,
     * which is the expensive duplicate rather than the tidy one.
     */
    uniqueIndex('employees_org_user_idx')
      .on(table.orgId, table.userId)
      .where(sql`user_id is not null`),
    unique('employees_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'employees_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'employees_org_id_calendar_id_fk',
      columns: [table.orgId, table.calendarId],
      foreignColumns: [workCalendars.orgId, workCalendars.id],
    }).onDelete('restrict'),
    check('employees_code_format', sql`${table.code} ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$'`),
    check('employees_name_length', sql`length(${table.fullName}) between 1 and 160`),
    check(
      'employees_leave_after_join',
      sql`${table.leaveDate} is null or ${table.leaveDate} >= ${table.joinDate}`,
    ),
    /*
     * A masked value is at most a handful of characters. The CHECK is a guard
     * against the mistake this design exists to prevent: a full account number
     * written into the column meant for its mask. Sixteen digits does not fit.
     */
    check(
      'employees_payout_mask_length',
      sql`${table.payoutRefMasked} is null or length(${table.payoutRefMasked}) <= 12`,
    ),
    check(
      'employees_nid_mask_length',
      sql`${table.nationalIdMasked} is null or length(${table.nationalIdMasked}) <= 12`,
    ),
    check(
      'employees_phone_mask_length',
      sql`${table.phoneMasked} is null or length(${table.phoneMasked}) <= 20`,
    ),
    /*
     * A non-cash payout needs an account to pay into.
     *
     * In the database rather than only in the service, because the cost of getting
     * it wrong is a payroll payment that thinks it went to a bKash number and went
     * nowhere. The plain number is not here to check, so what is checked is that
     * *something* was stored.
     */
    check(
      'employees_payout_ref_present',
      sql`${table.payoutMethod} = 'cash' or ${table.payoutRefCipher} is not null`,
    ),
  ],
);

/**
 * A version of one employee's salary (§12, D-029).
 *
 * Versioned by `effective_from` rather than edited in place, and that is the
 * difference between a payslip you can defend and one you cannot: a raise in June
 * must not change what May's payslip says, and a structure that is updated in place
 * makes every past payslip a recomputation of today's numbers. Every payroll line
 * snapshots the structure it used, so even this is belt and braces.
 *
 * `basic_poisha` is a column rather than a component, because D-029's formula starts
 * "basic + allowances" and a structure with no basic is not a structure. As a
 * component it would be a row that could be missing; as a NOT NULL positive column
 * it cannot be.
 */
export const salaryStructures = hr.table(
  'salary_structures',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id').notNull(),
    /** The first month this structure applies to, as its first calendar date. */
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    basicPoisha: bigint('basic_poisha', { mode: 'bigint' }).notNull(),
    note: text('note'),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    index('salary_structures_org_idx').on(table.orgId),
    // One structure per employee per effective date, and the index that answers
    // "which structure applied in March" is the same one — a second non-unique
    // index on the same three columns would be maintained on every write for
    // nothing.
    uniqueIndex('salary_structures_org_employee_from_idx').on(
      table.orgId,
      table.employeeId,
      table.effectiveFrom,
    ),
    unique('salary_structures_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'salary_structures_org_id_employee_id_fk',
      columns: [table.orgId, table.employeeId],
      foreignColumns: [employees.orgId, employees.id],
    }).onDelete('restrict'),
    check('salary_structures_basic_positive', sql`${table.basicPoisha} > 0`),
    check(
      'salary_structures_note_length',
      sql`${table.note} is null or length(${table.note}) <= 500`,
    ),
  ],
);

/** Which way a salary component moves. `earning` adds, `deduction` subtracts. */
export const componentDirection = hr.enum('component_direction', ['earning', 'deduction']);

/**
 * One allowance or fixed deduction on a structure (D-029: "all configurable").
 *
 * `prorated` is the field worth reading. A house-rent allowance is docked with the
 * basic when somebody is absent, because that is how a monthly salary works in
 * Bangladesh; a fixed mobile-bill reimbursement is not, because the bill arrives
 * whether or not the employee came in. Defaulting it to true matches the common
 * case, and the exception has to be stated — which is the right way round, because
 * the opposite default silently pays absent staff their full allowances.
 */
export const salaryComponents = hr.table(
  'salary_components',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    structureId: uuid('structure_id').notNull(),
    direction: componentDirection('direction').notNull(),
    /** A stable code: `house_rent`, `medical`, `transport`, `mobile`, `provident`. */
    code: text('code').notNull(),
    label: text('label').notNull(),
    amountPoisha: bigint('amount_poisha', { mode: 'bigint' }).notNull(),
    prorated: boolean('prorated').notNull().default(true),
    lineNo: integer('line_no').notNull(),
    ...timestamps,
  },
  (table) => [
    index('salary_components_org_idx').on(table.orgId),
    index('salary_components_org_structure_idx').on(table.orgId, table.structureId),
    uniqueIndex('salary_components_org_structure_code_idx').on(
      table.orgId,
      table.structureId,
      table.code,
    ),
    unique('salary_components_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'salary_components_org_id_structure_id_fk',
      columns: [table.orgId, table.structureId],
      foreignColumns: [salaryStructures.orgId, salaryStructures.id],
    }).onDelete('cascade'),
    // Positive, always. Direction carries the sign, so a negative allowance would be
    // a deduction wearing an allowance's label and would be summed as an earning.
    check('salary_components_amount_positive', sql`${table.amountPoisha} > 0`),
    check('salary_components_code_format', sql`${table.code} ~ '^[a-z][a-z0-9_]{0,31}$'`),
    /*
     * The five codes a payslip generates are reserved.
     *
     * `basic` is the structure's own column, and `bonus`, `absence`, `other_deduction` and
     * `loan_instalment` are emitted by `computePayrollLine` for every payslip that has one.
     * `payroll_line_components` is unique on `(org, line, code)`, so a structure carrying an
     * earning coded `bonus` — a fixed monthly bonus allowance, an ordinary thing to type —
     * would collide the moment that employee also got a bonus input, and the *whole month's*
     * submit would die with "that value is already taken" pointing at nothing.
     */
    check(
      'salary_components_code_not_reserved',
      sql`${table.code} not in ('basic', 'bonus', 'absence', 'other_deduction', 'loan_instalment')`,
    ),
    check('salary_components_label_length', sql`length(${table.label}) between 1 and 60`),
  ],
);

/**
 * One CSV import from the biometric software (§12, §21 `AttendanceImporter`).
 *
 * The row exists before any attendance is written, and `status` is what says
 * whether it was. `mapping` is the file's own column names — no amounts and no
 * personal data, just headers — and keeping it is what makes the next month's
 * import a one-click repeat instead of a form somebody fills in wrong.
 *
 * `rejected` holds the per-row reasons, because "142 of 148 rows imported" is not a
 * useful thing to tell an office administrator: which six, and why, is.
 */
export const attendanceImports = hr.table(
  'attendance_imports',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** `YYYY-MM`, the month the rows were imported for. */
    month: text('month').notNull(),
    fileName: text('file_name'),
    status: attendanceImportStatus('status').notNull(),
    mapping: jsonb('mapping').notNull(),
    rowCount: integer('row_count').notNull().default(0),
    acceptedCount: integer('accepted_count').notNull().default(0),
    rejectedCount: integer('rejected_count').notNull().default(0),
    /** `[{ line, reason }]`. Line numbers as Excel shows them. */
    rejected: jsonb('rejected')
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    index('attendance_imports_org_idx').on(table.orgId),
    index('attendance_imports_org_month_idx').on(table.orgId, table.month),
    unique('attendance_imports_org_id_id_key').on(table.orgId, table.id),
    check('attendance_imports_month_format', sql`${table.month} ~ '^\\d{4}-(0[1-9]|1[0-2])$'`),
    check(
      'attendance_imports_counts_add_up',
      sql`${table.acceptedCount} + ${table.rejectedCount} = ${table.rowCount}`,
    ),
  ],
);

/**
 * One employee's one day (§12: manual entry plus CSV import).
 *
 * Unique on `(org, employee, date)`, so a device that punches four times a day
 * produces one row and a manual correction replaces it rather than adding to it.
 * `source` is what makes the correction visible: a run whose absences all came from
 * `manual` on the day before payroll is a run worth looking at.
 *
 * Times are `timestamptz` (invariant 8) and the business date is its own column,
 * because "which day's attendance is this" is an Asia/Dhaka calendar question and a
 * night-shift check-out at 01:00 belongs to the shift that started the day before.
 */
export const attendanceDays = hr.table(
  'attendance_days',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id').notNull(),
    /** The employee's branch, copied for row scope (§6 `branch`). */
    branchId: uuid('branch_id'),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    status: attendanceStatus('status').notNull(),
    checkInAt: timestamp('check_in_at', { withTimezone: true, mode: 'date' }),
    checkOutAt: timestamp('check_out_at', { withTimezone: true, mode: 'date' }),
    source: attendanceSource('source').notNull(),
    importId: uuid('import_id'),
    note: text('note'),
    recordedBy: text('recorded_by').notNull(),
    ...timestamps,
  },
  (table) => [
    index('attendance_days_org_idx').on(table.orgId),
    index('attendance_days_org_date_idx').on(table.orgId, table.businessDate),
    index('attendance_days_org_branch_idx').on(table.orgId, table.branchId),
    uniqueIndex('attendance_days_org_employee_date_idx').on(
      table.orgId,
      table.employeeId,
      table.businessDate,
    ),
    unique('attendance_days_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'attendance_days_org_id_employee_id_fk',
      columns: [table.orgId, table.employeeId],
      foreignColumns: [employees.orgId, employees.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'attendance_days_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'attendance_days_org_id_import_id_fk',
      columns: [table.orgId, table.importId],
      foreignColumns: [attendanceImports.orgId, attendanceImports.id],
    }).onDelete('restrict'),
    // An imported row names its import; a manual one cannot claim to be from a
    // device. `source` is the only evidence that a month of absences was typed in
    // by hand the day before payroll, so it has to mean something.
    check(
      'attendance_days_import_matches_source',
      sql`(${table.source} = 'csv_import') = (${table.importId} is not null)`,
    ),
    check(
      'attendance_days_times_ordered',
      sql`${table.checkInAt} is null or ${table.checkOutAt} is null
          or ${table.checkOutAt} >= ${table.checkInAt}`,
    ),
    check(
      'attendance_days_note_length',
      sql`${table.note} is null or length(${table.note}) <= 300`,
    ),
  ],
);

/**
 * A staff loan (§12, §7 "Employee loan disbursed").
 *
 * `pending_disbursement` is a loan that has been agreed and not paid, which is a
 * real state: the agreement is signed on Monday and accounts pays on Thursday. It
 * has no journal and its instalments are not yet running, because an instalment
 * deducted from a loan the employee never received is money taken for nothing.
 */
export const employeeLoans = hr.table(
  'employee_loans',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id').notNull(),
    branchId: uuid('branch_id'),
    principalPoisha: bigint('principal_poisha', { mode: 'bigint' }).notNull(),
    instalmentCount: integer('instalment_count').notNull(),
    /** `YYYY-MM` of the first instalment. */
    firstMonth: text('first_month').notNull(),
    status: loanStatus('status').notNull().default('pending_disbursement'),
    /** The wallet's ledger account the cash left, once disbursed. */
    walletAccountId: uuid('wallet_account_id'),
    /** §7's `Dr Employee loan receivable / Cr W`. Null until disbursed. */
    journalId: uuid('journal_id'),
    disbursedOn: date('disbursed_on', { mode: 'string' }),
    note: text('note'),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    index('employee_loans_org_idx').on(table.orgId),
    index('employee_loans_org_employee_idx').on(table.orgId, table.employeeId),
    index('employee_loans_org_status_idx').on(table.orgId, table.status),
    unique('employee_loans_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'employee_loans_org_id_employee_id_fk',
      columns: [table.orgId, table.employeeId],
      foreignColumns: [employees.orgId, employees.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'employee_loans_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'employee_loans_org_id_wallet_account_id_fk',
      columns: [table.orgId, table.walletAccountId],
      foreignColumns: [ledgerAccounts.orgId, ledgerAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'employee_loans_org_id_journal_id_fk',
      columns: [table.orgId, table.journalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    check('employee_loans_principal_positive', sql`${table.principalPoisha} > 0`),
    check('employee_loans_instalments_sane', sql`${table.instalmentCount} between 1 and 120`),
    check(
      'employee_loans_first_month_format',
      sql`${table.firstMonth} ~ '^\\d{4}-(0[1-9]|1[0-2])$'`,
    ),
    // A loan that is not waiting for its cash has been disbursed, so it names the
    // journal that moved the money. Without this, an `active` loan with no journal
    // is a receivable nobody booked — the schedule would deduct from payslips
    // against an asset that does not exist in the ledger.
    check(
      'employee_loans_disbursed_has_journal',
      sql`case ${table.status}
            when 'pending_disbursement' then ${table.journalId} is null
            else ${table.journalId} is not null and ${table.disbursedOn} is not null
          end`,
    ),
    check('employee_loans_note_length', sql`${table.note} is null or length(${table.note}) <= 500`),
  ],
);

/**
 * One month's instalment of a loan.
 *
 * `deducted_poisha` rather than a boolean, because a payslip cannot always afford
 * the whole instalment — a month of unpaid leave leaves nothing to deduct from — and
 * what happens then has to be expressible. A partly deducted instalment stays
 * outstanding for its remainder and the next run picks it up, so an arrear carries
 * without anything being recomputed. That is why nothing in the loan arithmetic
 * rounds: the amount taken is always bounded by two whole numbers of poisha.
 */
export const loanInstalments = hr.table(
  'loan_instalments',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    loanId: uuid('loan_id').notNull(),
    seq: integer('seq').notNull(),
    /** `YYYY-MM`. The first month this instalment may be deducted in. */
    dueMonth: text('due_month').notNull(),
    amountPoisha: bigint('amount_poisha', { mode: 'bigint' }).notNull(),
    deductedPoisha: bigint('deducted_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    status: loanInstalmentStatus('status').notNull().default('due'),
    ...timestamps,
  },
  (table) => [
    index('loan_instalments_org_idx').on(table.orgId),
    index('loan_instalments_org_due_idx').on(table.orgId, table.dueMonth, table.status),
    uniqueIndex('loan_instalments_org_loan_seq_idx').on(table.orgId, table.loanId, table.seq),
    unique('loan_instalments_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'loan_instalments_org_id_loan_id_fk',
      columns: [table.orgId, table.loanId],
      foreignColumns: [employeeLoans.orgId, employeeLoans.id],
    }).onDelete('cascade'),
    check('loan_instalments_amount_positive', sql`${table.amountPoisha} > 0`),
    // Never more taken than was owed. This is the CHECK that makes over-deduction
    // impossible rather than unlikely: an employee cannot be charged twice for one
    // instalment even if two payroll runs for the same month somehow reached it.
    check(
      'loan_instalments_deducted_within_amount',
      sql`${table.deductedPoisha} >= 0 and ${table.deductedPoisha} <= ${table.amountPoisha}`,
    ),
    check('loan_instalments_due_month_format', sql`${table.dueMonth} ~ '^\\d{4}-(0[1-9]|1[0-2])$'`),
    check(
      'loan_instalments_status_matches_deducted',
      sql`case ${table.status}
            when 'due' then ${table.deductedPoisha} = 0
            when 'partly_deducted' then ${table.deductedPoisha} > 0 and ${table.deductedPoisha} < ${table.amountPoisha}
            when 'deducted' then ${table.deductedPoisha} = ${table.amountPoisha}
            else true
          end`,
    ),
  ],
);

/**
 * A month's payroll run (§12).
 *
 * One per org per month, which the unique index enforces, and that is half of
 * acceptance check 2 — *a payroll run cannot be posted twice*. The other halves are
 * the status trigger in 0055 and the ledger's idempotency key
 * `payroll_run:<id>:posted`. Three layers, because which one refuses depends on the
 * path: a second submit is caught here, a second approval by the trigger, a replayed
 * job by the key.
 *
 * The totals are columns rather than derived from the lines. Derived would be more
 * obviously correct and is wrong for this table: the approval's `amount_poisha` is a
 * number a human agreed to, and it has to be comparable to something stored at the
 * moment they agreed. 0055's trigger holds the two equal.
 */
export const payrollRuns = hr.table(
  'payroll_runs',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** `YYYY-MM`, in the Asia/Dhaka calendar (invariant 8). */
    month: text('month').notNull(),
    status: payrollRunStatus('status').notNull().default('draft'),
    /** How an unrecorded working day is treated for this run (D-186). */
    unrecordedPolicy: text('unrecorded_policy').notNull().default('present'),
    employeeCount: integer('employee_count').notNull().default(0),
    grossPoisha: bigint('gross_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    deductionsPoisha: bigint('deductions_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    netPoisha: bigint('net_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /** The maker-checker request (§6, D-072). NOT NULL once submitted. */
    approvalRequestId: uuid('approval_request_id'),
    /** §7's `Dr Salary expense + Dr Bonus expense / Cr Salary payable + Cr Loans`. */
    journalId: uuid('journal_id'),
    /** §7's `Dr Salary payable / Cr W`, when the money actually goes out. */
    paymentJournalId: uuid('payment_journal_id'),
    paidFromAccountId: uuid('paid_from_account_id'),
    /** The Asia/Dhaka date the posting journal carries. */
    postedOn: date('posted_on', { mode: 'string' }),
    paidOn: date('paid_on', { mode: 'string' }),
    memo: text('memo'),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    index('payroll_runs_org_idx').on(table.orgId),
    index('payroll_runs_org_status_idx').on(table.orgId, table.status),
    /*
     * One **live** run per org per month.
     *
     * Partial, excluding `cancelled` and `rejected`, and that exclusion is the whole point.
     * An unconditional unique index makes the ordinary maker-checker loop impossible: the
     * checker rejects March because the attendance was wrong, HR fixes the attendance — and
     * cannot submit March again, because the rejected row has consumed the month. The month
     * would be unpayable through the system forever, which is how staff end up being paid
     * outside the ledger.
     *
     * The dead run's payslips stay append-only and still resolve, because they key on
     * `run_id` rather than on the month.
     */
    uniqueIndex('payroll_runs_org_live_month_idx')
      .on(table.orgId, table.month)
      .where(sql`status not in ('cancelled', 'rejected')`),
    unique('payroll_runs_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'payroll_runs_org_id_approval_request_id_fk',
      columns: [table.orgId, table.approvalRequestId],
      foreignColumns: [approvalRequests.orgId, approvalRequests.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payroll_runs_org_id_journal_id_fk',
      columns: [table.orgId, table.journalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payroll_runs_org_id_payment_journal_id_fk',
      columns: [table.orgId, table.paymentJournalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payroll_runs_org_id_paid_from_account_id_fk',
      columns: [table.orgId, table.paidFromAccountId],
      foreignColumns: [ledgerAccounts.orgId, ledgerAccounts.id],
    }).onDelete('restrict'),
    check('payroll_runs_month_format', sql`${table.month} ~ '^\\d{4}-(0[1-9]|1[0-2])$'`),
    check(
      'payroll_runs_unrecorded_policy',
      sql`${table.unrecordedPolicy} in ('present', 'absent')`,
    ),
    check(
      'payroll_runs_totals_not_negative',
      sql`${table.grossPoisha} >= 0
          and ${table.deductionsPoisha} >= 0 and ${table.netPoisha} >= 0`,
    ),
    // The identity every payslip obeys, at the run level. A run whose totals do not
    // add up cannot be stored, so no journal can be built from them.
    check(
      'payroll_runs_totals_add_up',
      sql`${table.grossPoisha} - ${table.deductionsPoisha} = ${table.netPoisha}`,
    ),
    /*
     * What each state must and must not name.
     *
     * A draft has no approval and no journal, so it is in no report and no balance.
     * A pending run has frozen numbers and an approval and *still* no journal —
     * which is the property the whole maker-checker design rests on. Posted names
     * its journal; paid names both and the wallet it came from.
     */
    check(
      'payroll_runs_status_links',
      sql`case ${table.status}
            when 'draft' then ${table.approvalRequestId} is null and ${table.journalId} is null
              and ${table.paymentJournalId} is null
            when 'pending_approval' then ${table.approvalRequestId} is not null
              and ${table.journalId} is null and ${table.paymentJournalId} is null
            when 'posted' then ${table.approvalRequestId} is not null
              and ${table.journalId} is not null and ${table.postedOn} is not null
              and ${table.paymentJournalId} is null
            when 'paid' then ${table.approvalRequestId} is not null
              and ${table.journalId} is not null
              and ${table.paymentJournalId} is not null and ${table.paidOn} is not null
              and ${table.paidFromAccountId} is not null
            else ${table.journalId} is null and ${table.paymentJournalId} is null
          end`,
    ),
    check('payroll_runs_memo_length', sql`${table.memo} is null or length(${table.memo}) <= 500`),
  ],
);

/**
 * A bonus or a one-off deduction entered for one employee in one run (§12).
 *
 * Editable while the run is a draft and frozen the moment it is submitted, which
 * 0055's trigger enforces. That is the only table here that is genuinely mutable,
 * and it is mutable because a draft is a working document: somebody types the Eid
 * bonuses over an afternoon and corrects two of them.
 *
 * `amount_poisha` is positive and `kind` carries the direction, for the same reason
 * the salary components are: a signed amount lets "bonus 5000" become "deduct 5000"
 * with one keystroke, and both readings look plausible on a form.
 */
export const payrollInputs = hr.table(
  'payroll_inputs',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    runId: uuid('run_id').notNull(),
    employeeId: uuid('employee_id').notNull(),
    kind: payrollInputKind('kind').notNull(),
    label: text('label').notNull(),
    amountPoisha: bigint('amount_poisha', { mode: 'bigint' }).notNull(),
    note: text('note'),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    index('payroll_inputs_org_idx').on(table.orgId),
    index('payroll_inputs_org_run_idx').on(table.orgId, table.runId),
    unique('payroll_inputs_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'payroll_inputs_org_id_run_id_fk',
      columns: [table.orgId, table.runId],
      foreignColumns: [payrollRuns.orgId, payrollRuns.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'payroll_inputs_org_id_employee_id_fk',
      columns: [table.orgId, table.employeeId],
      foreignColumns: [employees.orgId, employees.id],
    }).onDelete('restrict'),
    check('payroll_inputs_amount_positive', sql`${table.amountPoisha} > 0`),
    check('payroll_inputs_label_length', sql`length(${table.label}) between 1 and 60`),
    check('payroll_inputs_note_length', sql`${table.note} is null or length(${table.note}) <= 300`),
  ],
);

/**
 * One employee's payslip for one run — the frozen numbers (§12).
 *
 * Append-only (0054's grants): written when the run is submitted for approval and
 * never touched again. The checker approves a total built from these rows and the
 * journal is posted from these rows, so a line that could be edited between the two
 * would make the approval a formality.
 *
 * Every snapshot column — branch, structure, basic — is here because the source can
 * change. An employee transferred to another showroom in April must not move March's
 * wage cost to the new branch's P&L.
 */
export const payrollLines = hr.table(
  'payroll_lines',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    runId: uuid('run_id').notNull(),
    employeeId: uuid('employee_id').notNull(),
    /** The employee's branch as it was, so the journal splits P&L correctly. */
    branchId: uuid('branch_id'),
    salaryStructureId: uuid('salary_structure_id').notNull(),
    basicPoisha: bigint('basic_poisha', { mode: 'bigint' }).notNull(),
    allowancesPoisha: bigint('allowances_poisha', { mode: 'bigint' }).notNull(),
    bonusPoisha: bigint('bonus_poisha', { mode: 'bigint' }).notNull(),
    grossPoisha: bigint('gross_poisha', { mode: 'bigint' }).notNull(),
    absenceDeductionPoisha: bigint('absence_deduction_poisha', { mode: 'bigint' }).notNull(),
    fixedDeductionPoisha: bigint('fixed_deduction_poisha', { mode: 'bigint' }).notNull(),
    otherDeductionPoisha: bigint('other_deduction_poisha', { mode: 'bigint' }).notNull(),
    loanDeductionPoisha: bigint('loan_deduction_poisha', { mode: 'bigint' }).notNull(),
    /** What was due on the loan and could not be taken. On the payslip. */
    loanShortfallPoisha: bigint('loan_shortfall_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    deductionsPoisha: bigint('deductions_poisha', { mode: 'bigint' }).notNull(),
    netPoisha: bigint('net_poisha', { mode: 'bigint' }).notNull(),
    /** What debits `salary_expense` for this employee (§7). */
    salaryExpensePoisha: bigint('salary_expense_poisha', { mode: 'bigint' }).notNull(),
    workingDays: integer('working_days').notNull(),
    presentDays: integer('present_days').notNull(),
    absentDays: integer('absent_days').notNull(),
    halfDays: integer('half_days').notNull().default(0),
    paidLeaveDays: integer('paid_leave_days').notNull().default(0),
    /** How many working days had no attendance record at all (D-186). */
    unrecordedDays: integer('unrecorded_days').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    index('payroll_lines_org_idx').on(table.orgId),
    index('payroll_lines_org_run_idx').on(table.orgId, table.runId),
    index('payroll_lines_org_employee_idx').on(table.orgId, table.employeeId),
    index('payroll_lines_org_branch_idx').on(table.orgId, table.branchId),
    // One payslip per employee per run. Two would each be paid.
    uniqueIndex('payroll_lines_org_run_employee_idx').on(
      table.orgId,
      table.runId,
      table.employeeId,
    ),
    unique('payroll_lines_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'payroll_lines_org_id_run_id_fk',
      columns: [table.orgId, table.runId],
      foreignColumns: [payrollRuns.orgId, payrollRuns.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payroll_lines_org_id_employee_id_fk',
      columns: [table.orgId, table.employeeId],
      foreignColumns: [employees.orgId, employees.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payroll_lines_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payroll_lines_org_id_salary_structure_id_fk',
      columns: [table.orgId, table.salaryStructureId],
      foreignColumns: [salaryStructures.orgId, salaryStructures.id],
    }).onDelete('restrict'),
    check(
      'payroll_lines_amounts_not_negative',
      sql`${table.basicPoisha} > 0 and ${table.allowancesPoisha} >= 0
          and ${table.bonusPoisha} >= 0 and ${table.grossPoisha} > 0
          and ${table.absenceDeductionPoisha} >= 0 and ${table.fixedDeductionPoisha} >= 0
          and ${table.otherDeductionPoisha} >= 0 and ${table.loanDeductionPoisha} >= 0
          and ${table.loanShortfallPoisha} >= 0
          and ${table.deductionsPoisha} >= 0 and ${table.netPoisha} >= 0`,
    ),
    // D-029's formula, in the database. Gross is basic + allowances + bonus; the
    // deductions are the four kinds; net is the difference. A line that does not
    // satisfy all three cannot be stored, so `payroll_runs_totals_add_up` cannot be
    // satisfied by lines that individually do not.
    check(
      'payroll_lines_gross_composition',
      sql`${table.grossPoisha} = ${table.basicPoisha} + ${table.allowancesPoisha} + ${table.bonusPoisha}`,
    ),
    check(
      'payroll_lines_deductions_composition',
      sql`${table.deductionsPoisha} = ${table.absenceDeductionPoisha} + ${table.fixedDeductionPoisha}
          + ${table.otherDeductionPoisha} + ${table.loanDeductionPoisha}`,
    ),
    check(
      'payroll_lines_net_composition',
      sql`${table.netPoisha} = ${table.grossPoisha} - ${table.deductionsPoisha}`,
    ),
    /*
     * §7's journal identity, per line: salary expense + bonus = net + loan.
     *
     * The journal is built from these two columns and these two columns only, so a
     * line that breaks the identity would produce a journal that balances and books
     * the wrong expense. Checked here because a CHECK cannot be forgotten by the
     * next caller of this table.
     */
    check(
      'payroll_lines_journal_identity',
      sql`${table.salaryExpensePoisha} + ${table.bonusPoisha}
          = ${table.netPoisha} + ${table.loanDeductionPoisha}`,
    ),
    check(
      'payroll_lines_days_sane',
      sql`${table.workingDays} >= 0 and ${table.presentDays} >= 0 and ${table.absentDays} >= 0
          and ${table.halfDays} >= 0 and ${table.paidLeaveDays} >= 0 and ${table.unrecordedDays} >= 0
          and ${table.presentDays} + ${table.absentDays} + ${table.halfDays}
              + ${table.paidLeaveDays} <= ${table.workingDays}`,
    ),
  ],
);

/**
 * One row of one payslip: `Basic ৳30,000`, `House rent ৳5,000`, `Absence −৳222.22`.
 *
 * A table rather than a jsonb blob on the line, and the reason is that the payslip
 * is a document handed to an employee who will argue with it. Real rows mean a test
 * can assert Σ earnings − Σ deductions = the net that was posted, and a query can
 * answer "how much did we pay in house rent allowance last year" without parsing
 * JSON. Append-only, like the line it belongs to.
 */
export const payrollLineComponents = hr.table(
  'payroll_line_components',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    lineId: uuid('line_id').notNull(),
    direction: componentDirection('direction').notNull(),
    code: text('code').notNull(),
    label: text('label').notNull(),
    amountPoisha: bigint('amount_poisha', { mode: 'bigint' }).notNull(),
    lineNo: integer('line_no').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('payroll_line_components_org_idx').on(table.orgId),
    index('payroll_line_components_org_line_idx').on(table.orgId, table.lineId),
    uniqueIndex('payroll_line_components_org_line_code_idx').on(
      table.orgId,
      table.lineId,
      table.code,
    ),
    unique('payroll_line_components_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'payroll_line_components_org_id_line_id_fk',
      columns: [table.orgId, table.lineId],
      foreignColumns: [payrollLines.orgId, payrollLines.id],
    }).onDelete('restrict'),
    check('payroll_line_components_amount_positive', sql`${table.amountPoisha} > 0`),
    check('payroll_line_components_label_length', sql`length(${table.label}) between 1 and 60`),
  ],
);

/**
 * Which instalment a payslip's loan deduction paid (§12).
 *
 * The join between a payslip and a loan schedule, append-only. Without it, "which
 * months has Chameli's loan been deducted in" is answerable only by adding up
 * `deducted_poisha` and guessing, and a reversal would have nothing to undo.
 */
export const payrollLoanDeductions = hr.table(
  'payroll_loan_deductions',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    lineId: uuid('line_id').notNull(),
    instalmentId: uuid('instalment_id').notNull(),
    amountPoisha: bigint('amount_poisha', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('payroll_loan_deductions_org_idx').on(table.orgId),
    index('payroll_loan_deductions_org_line_idx').on(table.orgId, table.lineId),
    // One row per (payslip, instalment). A retried submit cannot deduct twice.
    uniqueIndex('payroll_loan_deductions_org_line_instalment_idx').on(
      table.orgId,
      table.lineId,
      table.instalmentId,
    ),
    unique('payroll_loan_deductions_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'payroll_loan_deductions_org_id_line_id_fk',
      columns: [table.orgId, table.lineId],
      foreignColumns: [payrollLines.orgId, payrollLines.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payroll_loan_deductions_org_id_instalment_id_fk',
      columns: [table.orgId, table.instalmentId],
      foreignColumns: [loanInstalments.orgId, loanInstalments.id],
    }).onDelete('restrict'),
    check('payroll_loan_deductions_amount_positive', sql`${table.amountPoisha} > 0`),
  ],
);
