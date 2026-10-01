import { z } from 'zod';

/**
 * What the HR endpoints accept (architecture §23; validate at the edge).
 *
 * Three shapes are deliberately absent, and their absence is the design.
 *
 * * **No net pay, gross pay or absence deduction on any request.** Every one of those
 *   is computed by `packages/domain/src/payroll` from the salary structure and the
 *   attendance, and the approval's amount is that computation (D-072). A `netPoisha`
 *   a client could send is a number that decides whether a second person looks at a
 *   payroll run, which makes every threshold in the org advisory.
 * * **No plain personal data in any response schema.** The requests carry a national
 *   ID and a payout number, because somebody has to type them once; nothing returns
 *   them. What comes back is the mask (invariant 10).
 * * **No `status` on a payroll run create or update.** A run is born a draft and moves
 *   through its own endpoints. A settable status is a way to post a run without an
 *   approval, and migration 0055 refuses it — the schema not having the field is what
 *   stops a client trying.
 */

export const hrIdSchema = z.string().uuid('That is not a valid id.');

/** `YYYY-MM` in the Asia/Dhaka calendar (invariant 8). */
export const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A payroll month is written YYYY-MM.');

/** `YYYY-MM-DD`, an Asia/Dhaka calendar date. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'A date is written YYYY-MM-DD.');

/**
 * Integer poisha as a decimal string (§23, invariant 1).
 *
 * A string rather than a number, for the reason `packages/contracts/src/approvals.ts`
 * gives: a crore-scale salary bill in poisha is above 2^53, and `JSON.parse` would
 * round it silently. A monthly basic is capped at ৳50,00,000 — five million taka a
 * month is already implausible, and the cap is what turns a keystroke that adds two
 * zeros into a rejected request rather than a payroll run somebody has to unwind.
 */
const poishaString = (max: bigint, what: string) =>
  z
    .string()
    .regex(/^\d+$/, `${what} is integer poisha, sent as a decimal string.`)
    .refine(
      (value) => {
        if (!/^\d+$/.test(value)) return true;
        const amount = BigInt(value);
        return amount > 0n && amount <= max;
      },
      `${what} must be positive and no more than ${(max / 100n).toString()} taka.`,
    );

const SALARY_MAX = 500_000_000n;
const LOAN_MAX = 5_000_000_000n;

/**
 * A plain personal value on its way in, bounded and never logged.
 *
 * The bound is the interesting part: a national ID is at most 17 digits and a bKash
 * number 11, so 40 characters is generous. An unbounded field here would be a place
 * to park a megabyte of text inside an encrypted column nobody can inspect.
 */
const secretString = (what: string) =>
  z
    .string()
    .trim()
    .min(4, `${what} is too short to be one.`)
    .max(40, `${what} is longer than any real one.`);

export const createEmployeeSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$/,
        'An employee code is letters, digits, dots, slashes and dashes.',
      ),
    fullName: z.string().trim().min(1).max(160),
    designation: z.string().trim().max(80).optional(),
    department: z.string().trim().max(80).optional(),
    joinDate: isoDateSchema,
    branchId: hrIdSchema.optional(),
    /** The login, when they have one. Most employees do not (§12). */
    userId: z.string().trim().min(1).max(64).optional(),
    calendarId: hrIdSchema.optional(),
    payoutMethod: z.enum(['cash', 'bank', 'bkash', 'nagad']).default('cash'),
    /** Encrypted before it is stored, and only its mask ever comes back. */
    payoutRef: secretString('A payout account number').optional(),
    nationalId: secretString('A national ID number').optional(),
    phone: secretString('A phone number').optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.payoutMethod !== 'cash' && value.payoutRef === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['payoutRef'],
        message: 'A bank or mobile-wallet payout needs an account number.',
      });
    }
  });

export const updateEmployeeSchema = z
  .object({
    fullName: z.string().trim().min(1).max(160).optional(),
    /**
     * Link this employee to a login, or unlink them.
     *
     * Separate from creating the person, because the two happen months apart: a packer is
     * hired and paid for a year before anybody gives them a console account. Unique per org,
     * so one login cannot be two employees and be paid twice.
     */
    userId: z.string().trim().min(1).max(64).nullable().optional(),
    designation: z.string().trim().max(80).nullable().optional(),
    department: z.string().trim().max(80).nullable().optional(),
    branchId: hrIdSchema.nullable().optional(),
    calendarId: hrIdSchema.nullable().optional(),
    /**
     * Resigning, not deleting. §6 has no `delete Employee` cell and 0054 grants no
     * DELETE: a person who worked here is part of the record, and their payslips
     * reference them.
     */
    status: z.enum(['active', 'suspended', 'resigned', 'terminated']).optional(),
    leaveDate: isoDateSchema.nullable().optional(),
    payoutMethod: z.enum(['cash', 'bank', 'bkash', 'nagad']).optional(),
    payoutRef: secretString('A payout account number').optional(),
    nationalId: secretString('A national ID number').optional(),
    phone: secretString('A phone number').optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');

export const employeeQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(80).optional(),
    branchId: hrIdSchema.optional(),
    status: z.enum(['active', 'suspended', 'resigned', 'terminated']).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const salaryStructureSchema = z
  .object({
    /** The first day of the month this applies from; earlier payslips keep theirs. */
    effectiveFrom: isoDateSchema,
    basicPoisha: poishaString(SALARY_MAX, 'A basic salary'),
    note: z.string().trim().max(500).optional(),
    components: z
      .array(
        z
          .object({
            direction: z.enum(['earning', 'deduction']),
            code: z
              .string()
              .trim()
              .regex(/^[a-z][a-z0-9_]{0,31}$/, 'A component code is lower-case snake_case.')
              /*
               * The five codes a payslip generates are reserved.
               *
               * `basic` is the structure's own column, and `bonus`, `absence`,
               * `other_deduction` and `loan_instalment` are emitted by `computePayrollLine`
               * for every payslip that has one. The payslip's component rows are unique on
               * `(line, code)`, so a structure carrying an earning coded `bonus` — a fixed
               * monthly bonus allowance, an ordinary thing to type — would collide the moment
               * that employee also got a bonus input, and the whole month's submit would die.
               * The CHECK in migration 0053 says the same; this is what turns it into a 400
               * naming the field rather than a 500.
               */
              .refine(
                (code) =>
                  !['basic', 'bonus', 'absence', 'other_deduction', 'loan_instalment'].includes(
                    code,
                  ),
                'basic, bonus, absence, other_deduction and loan_instalment are the codes a payslip generates; use a different one.',
              ),
            label: z.string().trim().min(1).max(60),
            amountPoisha: poishaString(SALARY_MAX, 'A component amount'),
            /** Earnings prorate with attendance unless this says otherwise (D-029). */
            prorated: z.boolean().optional(),
          })
          .strict(),
      )
      .max(20, 'A salary structure has at most twenty components.')
      .default([]),
  })
  .strict();

export const calendarSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Z0-9][A-Z0-9-]{0,15}$/, 'A calendar code is upper-case letters and digits.'),
    name: z.string().trim().min(1).max(80),
    /** 0 = Sunday. Never all seven: a month with no working day cannot be prorated. */
    weeklyOff: z
      .array(z.number().int().min(0).max(6))
      .max(6, 'A calendar needs at least one working day in the week.'),
    isDefault: z.boolean().default(false),
  })
  .strict();

export const holidaySchema = z
  .object({ holidayDate: isoDateSchema, label: z.string().trim().min(1).max(120) })
  .strict();

export const attendanceEntrySchema = z
  .object({
    employeeId: hrIdSchema,
    businessDate: isoDateSchema,
    status: z.enum([
      'present',
      'late',
      'half_day',
      'absent',
      'leave_unpaid',
      'leave_paid',
      'weekly_off',
      'holiday',
    ]),
    /** `HH:MM` in Asia/Dhaka. The service turns it into a `timestamptz`. */
    checkIn: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time is written HH:MM.')
      .nullable()
      .optional(),
    checkOut: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time is written HH:MM.')
      .nullable()
      .optional(),
    note: z.string().trim().max(300).optional(),
  })
  .strict();

export const recordAttendanceSchema = z
  .object({
    entries: z
      .array(attendanceEntrySchema)
      .min(1, 'Nothing to record.')
      .max(500, 'Record at most five hundred days at a time.'),
  })
  .strict();

export const attendanceQuerySchema = z
  .object({
    month: monthSchema,
    employeeId: hrIdSchema.optional(),
    branchId: hrIdSchema.optional(),
  })
  .strict();

/**
 * The CSV import (§12, §21).
 *
 * The file arrives as text in the body rather than through M04's upload tickets. A
 * device export is tens of kilobytes of ASCII, and routing it through the object
 * store would mean storing a file whose whole content is personal data — attendance
 * for every employee, by name — in the private bucket forever, to read it once
 * (invariant 10). The parsed rows are what is worth keeping, and they go into
 * `hr.attendance_days`.
 */
export const attendanceImportSchema = z
  .object({
    month: monthSchema,
    fileName: z.string().trim().max(160).optional(),
    /** 2 MB of CSV is about 40,000 rows; `CSV_MAX_ROWS` refuses above 5,000 anyway. */
    csv: z.string().min(1).max(2_000_000, 'That file is larger than an attendance export.'),
    mapping: z
      .object({
        employeeCode: z.string().trim().min(1).max(80),
        date: z.string().trim().min(1).max(80),
        status: z.string().trim().min(1).max(80).optional(),
        checkIn: z.string().trim().min(1).max(80).optional(),
        checkOut: z.string().trim().min(1).max(80).optional(),
      })
      .strict(),
    /**
     * Whether to write the accepted rows or only report what would happen.
     *
     * Defaults to a dry run. An import that silently applied would mean the first
     * click a person makes with a wrong column mapping marks a month of absences —
     * and an absence costs somebody money, which is the asymmetry that makes preview
     * the right default here and only here.
     */
    apply: z.boolean().default(false),
  })
  .strict();

export const createRunSchema = z
  .object({
    month: monthSchema,
    /** How an unrecorded working day is treated for this run (D-186). */
    unrecordedPolicy: z.enum(['present', 'absent']).default('present'),
    memo: z.string().trim().max(500).optional(),
  })
  .strict();

export const runInputSchema = z
  .object({
    employeeId: hrIdSchema,
    kind: z.enum(['bonus', 'deduction']),
    label: z.string().trim().min(1).max(60),
    amountPoisha: poishaString(SALARY_MAX, 'A bonus or deduction'),
    note: z.string().trim().max(300).optional(),
  })
  .strict();

export const submitRunSchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict()
  .default({});

/**
 * Paying the run.
 *
 * `walletAccountId` is a **ledger account** id of a `wallet_*` subtype, not a row in
 * the wallets module's own table. HR posts through `LEDGER_API` and resolves the wallet
 * accounts it may credit through `LedgerApi.walletAccountById`; it reads neither
 * `ledger.*` nor `wallets.*` itself (invariant 12, D-199). `GET /v1/ledger/wallets` is
 * what the console's picker reads and it returns exactly these ids — including
 * deactivated ones, which is why that lookup carries `isActive` rather than filtering
 * them out.
 */
export const payRunSchema = z
  .object({
    walletAccountId: hrIdSchema,
    paidOn: isoDateSchema.optional(),
    memo: z.string().trim().max(500).optional(),
  })
  .strict();

export const createLoanSchema = z
  .object({
    employeeId: hrIdSchema,
    principalPoisha: poishaString(LOAN_MAX, 'A loan principal'),
    instalmentCount: z.number().int().min(1).max(120),
    /** The month the first instalment comes out of a payslip. */
    firstMonth: monthSchema,
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export const disburseLoanSchema = z
  .object({
    walletAccountId: hrIdSchema,
    disbursedOn: isoDateSchema.optional(),
    memo: z.string().trim().max(500).optional(),
  })
  .strict();

export const runQuerySchema = z
  .object({
    status: z
      .enum(['draft', 'pending_approval', 'posted', 'paid', 'rejected', 'cancelled'])
      .optional(),
    month: monthSchema.optional(),
  })
  .strict();

export const loanQuerySchema = z
  .object({
    employeeId: hrIdSchema.optional(),
    status: z.enum(['pending_disbursement', 'active', 'settled', 'written_off']).optional(),
  })
  .strict();

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
export type EmployeeQuery = z.infer<typeof employeeQuerySchema>;
export type SalaryStructureInput = z.infer<typeof salaryStructureSchema>;
export type CalendarInput = z.infer<typeof calendarSchema>;
export type HolidayInput = z.infer<typeof holidaySchema>;
export type RecordAttendanceInput = z.infer<typeof recordAttendanceSchema>;
export type AttendanceQuery = z.infer<typeof attendanceQuerySchema>;
export type AttendanceImportInput = z.infer<typeof attendanceImportSchema>;
export type CreateRunInput = z.infer<typeof createRunSchema>;
export type RunInputInput = z.infer<typeof runInputSchema>;
export type SubmitRunInput = z.infer<typeof submitRunSchema>;
export type PayRunInput = z.infer<typeof payRunSchema>;
export type CreateLoanInput = z.infer<typeof createLoanSchema>;
export type DisburseLoanInput = z.infer<typeof disburseLoanSchema>;
export type RunQuery = z.infer<typeof runQuerySchema>;
export type LoanQuery = z.infer<typeof loanQuerySchema>;
