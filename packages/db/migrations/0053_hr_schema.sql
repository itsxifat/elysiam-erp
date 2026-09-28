-- Employees, attendance, salary, loans and payroll runs (M19; architecture §7, §12).
--
-- Generated from `packages/db/src/schema/hr/index.ts` by drizzle-kit and placed at
-- this milestone's assigned number. The isolation policies and grants follow in
-- 0054, the triggers Drizzle cannot express in 0055, and the link that makes a
-- payroll approval mean what it says in 0056. 0057 seeds each org's default
-- working-day calendar.
--
-- Three things in this file carry the milestone's invariants, and each is a CHECK
-- rather than a convention, because a convention cannot survive the next caller of
-- these tables.
--
-- * **`payroll_lines_journal_identity`.** §7's payroll journal is
--   `Dr Salary expense + Dr Bonus expense / Cr Salary payable + Cr Employee loan
--   receivable`, so it balances only if `salary_expense + bonus = net + loan` holds
--   for every payslip. The journal is built from exactly those columns, which means
--   a line that broke the identity would still produce a *balanced* journal — with
--   the wrong expense in it, and nothing to notice. The CHECK is what makes that
--   line unstorable.
-- * **`payroll_runs_status_links`.** A draft names no approval and no journal; a run
--   waiting for a checker names its approval and *still* no journal. That is the
--   whole maker-checker guarantee: a pending payroll has changed no books, so
--   rejecting it needs no reversal.
-- * **`loan_instalments_deducted_within_amount`.** An instalment can never have more
--   taken off it than it was for, so an employee cannot be charged twice for one
--   month even if two runs somehow reached the same instalment.
--
-- * **`payroll_runs_org_live_month_idx`** is *partial*, excluding `cancelled` and
--   `rejected`. An unconditional unique index on `(org_id, month)` would make the
--   ordinary maker-checker loop impossible: the checker rejects March because the
--   attendance was wrong, HR fixes it, and cannot submit March again because the
--   rejected row has consumed the month — permanently, which is how staff end up
--   being paid outside the ledger.
--
-- The `*_cipher` columns are `bytea` and hold AES-256-GCM envelopes the database
-- cannot read (invariant 10, M19 check 3). A national ID number, a bank account
-- number and a phone number exist here only as ciphertext plus a short mask; the
-- plain value is never stored, so no backup, log line or CSV export can carry it.
CREATE SCHEMA "hr";
--> statement-breakpoint
CREATE TYPE "hr"."attendance_import_status" AS ENUM('parsed', 'applied', 'rejected');--> statement-breakpoint
CREATE TYPE "hr"."attendance_source" AS ENUM('manual', 'csv_import', 'device');--> statement-breakpoint
CREATE TYPE "hr"."attendance_status" AS ENUM('present', 'late', 'half_day', 'absent', 'leave_unpaid', 'leave_paid', 'weekly_off', 'holiday');--> statement-breakpoint
CREATE TYPE "hr"."component_direction" AS ENUM('earning', 'deduction');--> statement-breakpoint
CREATE TYPE "hr"."employment_status" AS ENUM('active', 'suspended', 'resigned', 'terminated');--> statement-breakpoint
CREATE TYPE "hr"."loan_instalment_status" AS ENUM('due', 'partly_deducted', 'deducted', 'waived');--> statement-breakpoint
CREATE TYPE "hr"."loan_status" AS ENUM('pending_disbursement', 'active', 'settled', 'written_off');--> statement-breakpoint
CREATE TYPE "hr"."payout_method" AS ENUM('cash', 'bank', 'bkash', 'nagad');--> statement-breakpoint
CREATE TYPE "hr"."payroll_input_kind" AS ENUM('bonus', 'deduction');--> statement-breakpoint
CREATE TYPE "hr"."payroll_run_status" AS ENUM('draft', 'pending_approval', 'posted', 'paid', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TABLE "hr"."attendance_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"branch_id" uuid,
	"business_date" date NOT NULL,
	"status" "hr"."attendance_status" NOT NULL,
	"check_in_at" timestamp with time zone,
	"check_out_at" timestamp with time zone,
	"source" "hr"."attendance_source" NOT NULL,
	"import_id" uuid,
	"note" text,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_days_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "attendance_days_import_matches_source" CHECK (("hr"."attendance_days"."source" = 'csv_import') = ("hr"."attendance_days"."import_id" is not null)),
	CONSTRAINT "attendance_days_times_ordered" CHECK ("hr"."attendance_days"."check_in_at" is null or "hr"."attendance_days"."check_out_at" is null
          or "hr"."attendance_days"."check_out_at" >= "hr"."attendance_days"."check_in_at"),
	CONSTRAINT "attendance_days_note_length" CHECK ("hr"."attendance_days"."note" is null or length("hr"."attendance_days"."note") <= 300)
);
--> statement-breakpoint
CREATE TABLE "hr"."attendance_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"month" text NOT NULL,
	"file_name" text,
	"status" "hr"."attendance_import_status" NOT NULL,
	"mapping" jsonb NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"accepted_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"rejected" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_imports_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "attendance_imports_month_format" CHECK ("hr"."attendance_imports"."month" ~ '^\d{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "attendance_imports_counts_add_up" CHECK ("hr"."attendance_imports"."accepted_count" + "hr"."attendance_imports"."rejected_count" = "hr"."attendance_imports"."row_count")
);
--> statement-breakpoint
CREATE TABLE "hr"."calendar_holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"holiday_date" date NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_holidays_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "calendar_holidays_label_length" CHECK (length("hr"."calendar_holidays"."label") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "hr"."employee_loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"branch_id" uuid,
	"principal_poisha" bigint NOT NULL,
	"instalment_count" integer NOT NULL,
	"first_month" text NOT NULL,
	"status" "hr"."loan_status" DEFAULT 'pending_disbursement' NOT NULL,
	"wallet_account_id" uuid,
	"journal_id" uuid,
	"disbursed_on" date,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_loans_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "employee_loans_principal_positive" CHECK ("hr"."employee_loans"."principal_poisha" > 0),
	CONSTRAINT "employee_loans_instalments_sane" CHECK ("hr"."employee_loans"."instalment_count" between 1 and 120),
	CONSTRAINT "employee_loans_first_month_format" CHECK ("hr"."employee_loans"."first_month" ~ '^\d{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "employee_loans_disbursed_has_journal" CHECK (case "hr"."employee_loans"."status"
            when 'pending_disbursement' then "hr"."employee_loans"."journal_id" is null
            else "hr"."employee_loans"."journal_id" is not null and "hr"."employee_loans"."disbursed_on" is not null
          end),
	CONSTRAINT "employee_loans_note_length" CHECK ("hr"."employee_loans"."note" is null or length("hr"."employee_loans"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "hr"."employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"branch_id" uuid,
	"user_id" text,
	"code" text NOT NULL,
	"full_name" text NOT NULL,
	"designation" text,
	"department" text,
	"join_date" date NOT NULL,
	"leave_date" date,
	"status" "hr"."employment_status" DEFAULT 'active' NOT NULL,
	"calendar_id" uuid,
	"payout_method" "hr"."payout_method" DEFAULT 'cash' NOT NULL,
	"payout_ref_cipher" "bytea",
	"payout_ref_masked" text,
	"national_id_cipher" "bytea",
	"national_id_masked" text,
	"phone_cipher" "bytea",
	"phone_masked" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employees_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "employees_code_format" CHECK ("hr"."employees"."code" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$'),
	CONSTRAINT "employees_name_length" CHECK (length("hr"."employees"."full_name") between 1 and 160),
	CONSTRAINT "employees_leave_after_join" CHECK ("hr"."employees"."leave_date" is null or "hr"."employees"."leave_date" >= "hr"."employees"."join_date"),
	CONSTRAINT "employees_payout_mask_length" CHECK ("hr"."employees"."payout_ref_masked" is null or length("hr"."employees"."payout_ref_masked") <= 12),
	CONSTRAINT "employees_nid_mask_length" CHECK ("hr"."employees"."national_id_masked" is null or length("hr"."employees"."national_id_masked") <= 12),
	CONSTRAINT "employees_phone_mask_length" CHECK ("hr"."employees"."phone_masked" is null or length("hr"."employees"."phone_masked") <= 20),
	CONSTRAINT "employees_payout_ref_present" CHECK ("hr"."employees"."payout_method" = 'cash' or "hr"."employees"."payout_ref_cipher" is not null)
);
--> statement-breakpoint
CREATE TABLE "hr"."loan_instalments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"due_month" text NOT NULL,
	"amount_poisha" bigint NOT NULL,
	"deducted_poisha" bigint DEFAULT 0 NOT NULL,
	"status" "hr"."loan_instalment_status" DEFAULT 'due' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_instalments_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "loan_instalments_amount_positive" CHECK ("hr"."loan_instalments"."amount_poisha" > 0),
	CONSTRAINT "loan_instalments_deducted_within_amount" CHECK ("hr"."loan_instalments"."deducted_poisha" >= 0 and "hr"."loan_instalments"."deducted_poisha" <= "hr"."loan_instalments"."amount_poisha"),
	CONSTRAINT "loan_instalments_due_month_format" CHECK ("hr"."loan_instalments"."due_month" ~ '^\d{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "loan_instalments_status_matches_deducted" CHECK (case "hr"."loan_instalments"."status"
            when 'due' then "hr"."loan_instalments"."deducted_poisha" = 0
            when 'partly_deducted' then "hr"."loan_instalments"."deducted_poisha" > 0 and "hr"."loan_instalments"."deducted_poisha" < "hr"."loan_instalments"."amount_poisha"
            when 'deducted' then "hr"."loan_instalments"."deducted_poisha" = "hr"."loan_instalments"."amount_poisha"
            else true
          end)
);
--> statement-breakpoint
CREATE TABLE "hr"."payroll_inputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"kind" "hr"."payroll_input_kind" NOT NULL,
	"label" text NOT NULL,
	"amount_poisha" bigint NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_inputs_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "payroll_inputs_amount_positive" CHECK ("hr"."payroll_inputs"."amount_poisha" > 0),
	CONSTRAINT "payroll_inputs_label_length" CHECK (length("hr"."payroll_inputs"."label") between 1 and 60),
	CONSTRAINT "payroll_inputs_note_length" CHECK ("hr"."payroll_inputs"."note" is null or length("hr"."payroll_inputs"."note") <= 300)
);
--> statement-breakpoint
CREATE TABLE "hr"."payroll_line_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"direction" "hr"."component_direction" NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"amount_poisha" bigint NOT NULL,
	"line_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_line_components_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "payroll_line_components_amount_positive" CHECK ("hr"."payroll_line_components"."amount_poisha" > 0),
	CONSTRAINT "payroll_line_components_label_length" CHECK (length("hr"."payroll_line_components"."label") between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "hr"."payroll_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"branch_id" uuid,
	"salary_structure_id" uuid NOT NULL,
	"basic_poisha" bigint NOT NULL,
	"allowances_poisha" bigint NOT NULL,
	"bonus_poisha" bigint NOT NULL,
	"gross_poisha" bigint NOT NULL,
	"absence_deduction_poisha" bigint NOT NULL,
	"fixed_deduction_poisha" bigint NOT NULL,
	"other_deduction_poisha" bigint NOT NULL,
	"loan_deduction_poisha" bigint NOT NULL,
	"loan_shortfall_poisha" bigint DEFAULT 0 NOT NULL,
	"deductions_poisha" bigint NOT NULL,
	"net_poisha" bigint NOT NULL,
	"salary_expense_poisha" bigint NOT NULL,
	"working_days" integer NOT NULL,
	"present_days" integer NOT NULL,
	"absent_days" integer NOT NULL,
	"half_days" integer DEFAULT 0 NOT NULL,
	"paid_leave_days" integer DEFAULT 0 NOT NULL,
	"unrecorded_days" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_lines_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "payroll_lines_amounts_not_negative" CHECK ("hr"."payroll_lines"."basic_poisha" > 0 and "hr"."payroll_lines"."allowances_poisha" >= 0
          and "hr"."payroll_lines"."bonus_poisha" >= 0 and "hr"."payroll_lines"."gross_poisha" > 0
          and "hr"."payroll_lines"."absence_deduction_poisha" >= 0 and "hr"."payroll_lines"."fixed_deduction_poisha" >= 0
          and "hr"."payroll_lines"."other_deduction_poisha" >= 0 and "hr"."payroll_lines"."loan_deduction_poisha" >= 0
          and "hr"."payroll_lines"."loan_shortfall_poisha" >= 0
          and "hr"."payroll_lines"."deductions_poisha" >= 0 and "hr"."payroll_lines"."net_poisha" >= 0),
	CONSTRAINT "payroll_lines_gross_composition" CHECK ("hr"."payroll_lines"."gross_poisha" = "hr"."payroll_lines"."basic_poisha" + "hr"."payroll_lines"."allowances_poisha" + "hr"."payroll_lines"."bonus_poisha"),
	CONSTRAINT "payroll_lines_deductions_composition" CHECK ("hr"."payroll_lines"."deductions_poisha" = "hr"."payroll_lines"."absence_deduction_poisha" + "hr"."payroll_lines"."fixed_deduction_poisha"
          + "hr"."payroll_lines"."other_deduction_poisha" + "hr"."payroll_lines"."loan_deduction_poisha"),
	CONSTRAINT "payroll_lines_net_composition" CHECK ("hr"."payroll_lines"."net_poisha" = "hr"."payroll_lines"."gross_poisha" - "hr"."payroll_lines"."deductions_poisha"),
	CONSTRAINT "payroll_lines_journal_identity" CHECK ("hr"."payroll_lines"."salary_expense_poisha" + "hr"."payroll_lines"."bonus_poisha"
          = "hr"."payroll_lines"."net_poisha" + "hr"."payroll_lines"."loan_deduction_poisha"),
	CONSTRAINT "payroll_lines_days_sane" CHECK ("hr"."payroll_lines"."working_days" >= 0 and "hr"."payroll_lines"."present_days" >= 0 and "hr"."payroll_lines"."absent_days" >= 0
          and "hr"."payroll_lines"."half_days" >= 0 and "hr"."payroll_lines"."paid_leave_days" >= 0 and "hr"."payroll_lines"."unrecorded_days" >= 0
          and "hr"."payroll_lines"."present_days" + "hr"."payroll_lines"."absent_days" + "hr"."payroll_lines"."half_days"
              + "hr"."payroll_lines"."paid_leave_days" <= "hr"."payroll_lines"."working_days")
);
--> statement-breakpoint
CREATE TABLE "hr"."payroll_loan_deductions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"instalment_id" uuid NOT NULL,
	"amount_poisha" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_loan_deductions_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "payroll_loan_deductions_amount_positive" CHECK ("hr"."payroll_loan_deductions"."amount_poisha" > 0)
);
--> statement-breakpoint
CREATE TABLE "hr"."payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"month" text NOT NULL,
	"status" "hr"."payroll_run_status" DEFAULT 'draft' NOT NULL,
	"unrecorded_policy" text DEFAULT 'present' NOT NULL,
	"employee_count" integer DEFAULT 0 NOT NULL,
	"gross_poisha" bigint DEFAULT 0 NOT NULL,
	"deductions_poisha" bigint DEFAULT 0 NOT NULL,
	"net_poisha" bigint DEFAULT 0 NOT NULL,
	"approval_request_id" uuid,
	"journal_id" uuid,
	"payment_journal_id" uuid,
	"paid_from_account_id" uuid,
	"posted_on" date,
	"paid_on" date,
	"memo" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_runs_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "payroll_runs_month_format" CHECK ("hr"."payroll_runs"."month" ~ '^\d{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "payroll_runs_unrecorded_policy" CHECK ("hr"."payroll_runs"."unrecorded_policy" in ('present', 'absent')),
	CONSTRAINT "payroll_runs_totals_not_negative" CHECK ("hr"."payroll_runs"."gross_poisha" >= 0
          and "hr"."payroll_runs"."deductions_poisha" >= 0 and "hr"."payroll_runs"."net_poisha" >= 0),
	CONSTRAINT "payroll_runs_totals_add_up" CHECK ("hr"."payroll_runs"."gross_poisha" - "hr"."payroll_runs"."deductions_poisha" = "hr"."payroll_runs"."net_poisha"),
	CONSTRAINT "payroll_runs_status_links" CHECK (case "hr"."payroll_runs"."status"
            when 'draft' then "hr"."payroll_runs"."approval_request_id" is null and "hr"."payroll_runs"."journal_id" is null
              and "hr"."payroll_runs"."payment_journal_id" is null
            when 'pending_approval' then "hr"."payroll_runs"."approval_request_id" is not null
              and "hr"."payroll_runs"."journal_id" is null and "hr"."payroll_runs"."payment_journal_id" is null
            when 'posted' then "hr"."payroll_runs"."approval_request_id" is not null
              and "hr"."payroll_runs"."journal_id" is not null and "hr"."payroll_runs"."posted_on" is not null
              and "hr"."payroll_runs"."payment_journal_id" is null
            when 'paid' then "hr"."payroll_runs"."approval_request_id" is not null
              and "hr"."payroll_runs"."journal_id" is not null
              and "hr"."payroll_runs"."payment_journal_id" is not null and "hr"."payroll_runs"."paid_on" is not null
              and "hr"."payroll_runs"."paid_from_account_id" is not null
            else "hr"."payroll_runs"."journal_id" is null and "hr"."payroll_runs"."payment_journal_id" is null
          end),
	CONSTRAINT "payroll_runs_memo_length" CHECK ("hr"."payroll_runs"."memo" is null or length("hr"."payroll_runs"."memo") <= 500)
);
--> statement-breakpoint
CREATE TABLE "hr"."salary_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"structure_id" uuid NOT NULL,
	"direction" "hr"."component_direction" NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"amount_poisha" bigint NOT NULL,
	"prorated" boolean DEFAULT true NOT NULL,
	"line_no" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "salary_components_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "salary_components_amount_positive" CHECK ("hr"."salary_components"."amount_poisha" > 0),
	CONSTRAINT "salary_components_code_format" CHECK ("hr"."salary_components"."code" ~ '^[a-z][a-z0-9_]{0,31}$'),
	CONSTRAINT "salary_components_code_not_reserved" CHECK ("hr"."salary_components"."code" not in ('basic', 'bonus', 'absence', 'other_deduction', 'loan_instalment')),
	CONSTRAINT "salary_components_label_length" CHECK (length("hr"."salary_components"."label") between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "hr"."salary_structures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"basic_poisha" bigint NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "salary_structures_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "salary_structures_basic_positive" CHECK ("hr"."salary_structures"."basic_poisha" > 0),
	CONSTRAINT "salary_structures_note_length" CHECK ("hr"."salary_structures"."note" is null or length("hr"."salary_structures"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "hr"."work_calendars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"weekly_off" smallint[] NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_calendars_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "work_calendars_code_format" CHECK ("hr"."work_calendars"."code" ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
	CONSTRAINT "work_calendars_weekly_off_valid" CHECK (array_length("hr"."work_calendars"."weekly_off", 1) is null
          or ("hr"."work_calendars"."weekly_off" <@ array[0,1,2,3,4,5,6]::smallint[]
              and array_length("hr"."work_calendars"."weekly_off", 1) <= 6))
);
--> statement-breakpoint
ALTER TABLE "hr"."attendance_days" ADD CONSTRAINT "attendance_days_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."attendance_days" ADD CONSTRAINT "attendance_days_org_id_employee_id_fk" FOREIGN KEY ("org_id","employee_id") REFERENCES "hr"."employees"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."attendance_days" ADD CONSTRAINT "attendance_days_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."attendance_days" ADD CONSTRAINT "attendance_days_org_id_import_id_fk" FOREIGN KEY ("org_id","import_id") REFERENCES "hr"."attendance_imports"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."attendance_imports" ADD CONSTRAINT "attendance_imports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."calendar_holidays" ADD CONSTRAINT "calendar_holidays_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."calendar_holidays" ADD CONSTRAINT "calendar_holidays_org_id_calendar_id_fk" FOREIGN KEY ("org_id","calendar_id") REFERENCES "hr"."work_calendars"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."employee_loans" ADD CONSTRAINT "employee_loans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."employee_loans" ADD CONSTRAINT "employee_loans_org_id_employee_id_fk" FOREIGN KEY ("org_id","employee_id") REFERENCES "hr"."employees"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."employee_loans" ADD CONSTRAINT "employee_loans_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."employee_loans" ADD CONSTRAINT "employee_loans_org_id_wallet_account_id_fk" FOREIGN KEY ("org_id","wallet_account_id") REFERENCES "ledger"."accounts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."employee_loans" ADD CONSTRAINT "employee_loans_org_id_journal_id_fk" FOREIGN KEY ("org_id","journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."employees" ADD CONSTRAINT "employees_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."employees" ADD CONSTRAINT "employees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."employees" ADD CONSTRAINT "employees_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."employees" ADD CONSTRAINT "employees_org_id_calendar_id_fk" FOREIGN KEY ("org_id","calendar_id") REFERENCES "hr"."work_calendars"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."loan_instalments" ADD CONSTRAINT "loan_instalments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."loan_instalments" ADD CONSTRAINT "loan_instalments_org_id_loan_id_fk" FOREIGN KEY ("org_id","loan_id") REFERENCES "hr"."employee_loans"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."payroll_inputs" ADD CONSTRAINT "payroll_inputs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."payroll_inputs" ADD CONSTRAINT "payroll_inputs_org_id_run_id_fk" FOREIGN KEY ("org_id","run_id") REFERENCES "hr"."payroll_runs"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."payroll_inputs" ADD CONSTRAINT "payroll_inputs_org_id_employee_id_fk" FOREIGN KEY ("org_id","employee_id") REFERENCES "hr"."employees"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."payroll_line_components" ADD CONSTRAINT "payroll_line_components_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."payroll_line_components" ADD CONSTRAINT "payroll_line_components_org_id_line_id_fk" FOREIGN KEY ("org_id","line_id") REFERENCES "hr"."payroll_lines"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."payroll_lines" ADD CONSTRAINT "payroll_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."payroll_lines" ADD CONSTRAINT "payroll_lines_org_id_run_id_fk" FOREIGN KEY ("org_id","run_id") REFERENCES "hr"."payroll_runs"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."payroll_lines" ADD CONSTRAINT "payroll_lines_org_id_employee_id_fk" FOREIGN KEY ("org_id","employee_id") REFERENCES "hr"."employees"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."payroll_lines" ADD CONSTRAINT "payroll_lines_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."payroll_lines" ADD CONSTRAINT "payroll_lines_org_id_salary_structure_id_fk" FOREIGN KEY ("org_id","salary_structure_id") REFERENCES "hr"."salary_structures"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."payroll_loan_deductions" ADD CONSTRAINT "payroll_loan_deductions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."payroll_loan_deductions" ADD CONSTRAINT "payroll_loan_deductions_org_id_line_id_fk" FOREIGN KEY ("org_id","line_id") REFERENCES "hr"."payroll_lines"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."payroll_loan_deductions" ADD CONSTRAINT "payroll_loan_deductions_org_id_instalment_id_fk" FOREIGN KEY ("org_id","instalment_id") REFERENCES "hr"."loan_instalments"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."payroll_runs" ADD CONSTRAINT "payroll_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."payroll_runs" ADD CONSTRAINT "payroll_runs_org_id_approval_request_id_fk" FOREIGN KEY ("org_id","approval_request_id") REFERENCES "approvals"."approval_requests"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."payroll_runs" ADD CONSTRAINT "payroll_runs_org_id_journal_id_fk" FOREIGN KEY ("org_id","journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."payroll_runs" ADD CONSTRAINT "payroll_runs_org_id_payment_journal_id_fk" FOREIGN KEY ("org_id","payment_journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."payroll_runs" ADD CONSTRAINT "payroll_runs_org_id_paid_from_account_id_fk" FOREIGN KEY ("org_id","paid_from_account_id") REFERENCES "ledger"."accounts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."salary_components" ADD CONSTRAINT "salary_components_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."salary_components" ADD CONSTRAINT "salary_components_org_id_structure_id_fk" FOREIGN KEY ("org_id","structure_id") REFERENCES "hr"."salary_structures"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."salary_structures" ADD CONSTRAINT "salary_structures_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."salary_structures" ADD CONSTRAINT "salary_structures_org_id_employee_id_fk" FOREIGN KEY ("org_id","employee_id") REFERENCES "hr"."employees"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."work_calendars" ADD CONSTRAINT "work_calendars_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_days_org_idx" ON "hr"."attendance_days" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "attendance_days_org_date_idx" ON "hr"."attendance_days" USING btree ("org_id","business_date");--> statement-breakpoint
CREATE INDEX "attendance_days_org_branch_idx" ON "hr"."attendance_days" USING btree ("org_id","branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_days_org_employee_date_idx" ON "hr"."attendance_days" USING btree ("org_id","employee_id","business_date");--> statement-breakpoint
CREATE INDEX "attendance_imports_org_idx" ON "hr"."attendance_imports" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "attendance_imports_org_month_idx" ON "hr"."attendance_imports" USING btree ("org_id","month");--> statement-breakpoint
CREATE INDEX "calendar_holidays_org_idx" ON "hr"."calendar_holidays" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_holidays_org_calendar_date_idx" ON "hr"."calendar_holidays" USING btree ("org_id","calendar_id","holiday_date");--> statement-breakpoint
CREATE INDEX "employee_loans_org_idx" ON "hr"."employee_loans" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "employee_loans_org_employee_idx" ON "hr"."employee_loans" USING btree ("org_id","employee_id");--> statement-breakpoint
CREATE INDEX "employee_loans_org_status_idx" ON "hr"."employee_loans" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "employees_org_idx" ON "hr"."employees" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "employees_org_branch_idx" ON "hr"."employees" USING btree ("org_id","branch_id");--> statement-breakpoint
CREATE INDEX "employees_org_status_idx" ON "hr"."employees" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_org_code_idx" ON "hr"."employees" USING btree ("org_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_org_user_idx" ON "hr"."employees" USING btree ("org_id","user_id") WHERE user_id is not null;--> statement-breakpoint
CREATE INDEX "loan_instalments_org_idx" ON "hr"."loan_instalments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "loan_instalments_org_due_idx" ON "hr"."loan_instalments" USING btree ("org_id","due_month","status");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_instalments_org_loan_seq_idx" ON "hr"."loan_instalments" USING btree ("org_id","loan_id","seq");--> statement-breakpoint
CREATE INDEX "payroll_inputs_org_idx" ON "hr"."payroll_inputs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "payroll_inputs_org_run_idx" ON "hr"."payroll_inputs" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "payroll_line_components_org_idx" ON "hr"."payroll_line_components" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "payroll_line_components_org_line_idx" ON "hr"."payroll_line_components" USING btree ("org_id","line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_line_components_org_line_code_idx" ON "hr"."payroll_line_components" USING btree ("org_id","line_id","code");--> statement-breakpoint
CREATE INDEX "payroll_lines_org_idx" ON "hr"."payroll_lines" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "payroll_lines_org_run_idx" ON "hr"."payroll_lines" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "payroll_lines_org_employee_idx" ON "hr"."payroll_lines" USING btree ("org_id","employee_id");--> statement-breakpoint
CREATE INDEX "payroll_lines_org_branch_idx" ON "hr"."payroll_lines" USING btree ("org_id","branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_lines_org_run_employee_idx" ON "hr"."payroll_lines" USING btree ("org_id","run_id","employee_id");--> statement-breakpoint
CREATE INDEX "payroll_loan_deductions_org_idx" ON "hr"."payroll_loan_deductions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "payroll_loan_deductions_org_line_idx" ON "hr"."payroll_loan_deductions" USING btree ("org_id","line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_loan_deductions_org_line_instalment_idx" ON "hr"."payroll_loan_deductions" USING btree ("org_id","line_id","instalment_id");--> statement-breakpoint
CREATE INDEX "payroll_runs_org_idx" ON "hr"."payroll_runs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "payroll_runs_org_status_idx" ON "hr"."payroll_runs" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_runs_org_live_month_idx" ON "hr"."payroll_runs" USING btree ("org_id","month") WHERE status not in ('cancelled', 'rejected');--> statement-breakpoint
CREATE INDEX "salary_components_org_idx" ON "hr"."salary_components" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "salary_components_org_structure_idx" ON "hr"."salary_components" USING btree ("org_id","structure_id");--> statement-breakpoint
CREATE UNIQUE INDEX "salary_components_org_structure_code_idx" ON "hr"."salary_components" USING btree ("org_id","structure_id","code");--> statement-breakpoint
CREATE INDEX "salary_structures_org_idx" ON "hr"."salary_structures" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "salary_structures_org_employee_from_idx" ON "hr"."salary_structures" USING btree ("org_id","employee_id","effective_from");--> statement-breakpoint
CREATE INDEX "work_calendars_org_idx" ON "hr"."work_calendars" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_calendars_org_code_idx" ON "hr"."work_calendars" USING btree ("org_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "work_calendars_org_default_idx" ON "hr"."work_calendars" USING btree ("org_id") WHERE is_default;