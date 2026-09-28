-- Tenant isolation for the hr schema (M19; invariant 4, §5).
--
-- Emitted by `tenantTableSql()` in `packages/db/src/rls.ts` and pasted verbatim,
-- the way every tenant policy in this repo is: a policy that differs by one
-- character fails silently, returning rows rather than throwing, and the wrong rows
-- look like the right ones (D-048). RLS is ENABLE **and** FORCE on all fourteen
-- tables, so even `erp_owner` — the role that runs migrations and seeds — is bound
-- by the org policy.
--
-- The grants are where the thinking is, and on this schema they are two rules.
--
-- **Nothing that a checker approved can be changed.** `payroll_lines`,
-- `payroll_line_components` and `payroll_loan_deductions` are append-only: SELECT
-- and INSERT, no UPDATE and no DELETE. They are written once, when a run is
-- submitted for approval, and the approval's amount was computed from them. A line
-- that could be edited between the approval and the posting would make the approval
-- a formality — and the edit would be invisible, because the journal is posted from
-- these same rows and would balance either way.
--
-- **Nothing about a person is deleted.** `employees`, `attendance_days`,
-- `salary_structures`, `employee_loans`, `loan_instalments`, `payroll_runs`,
-- `attendance_imports` and `work_calendars` get UPDATE and no DELETE. An employee
-- resigns rather than disappearing; an absence is corrected by an update that leaves
-- `source = 'manual'` behind rather than by a row nobody can see any more; a
-- cancelled payroll run and a rejected one are both things somebody looks up
-- precisely because they did not happen. A salary structure is superseded by a new
-- one with a later effective date, never edited away — May's payslip has to keep
-- saying what it said after June's raise.
--
-- The two genuinely mutable tables are the two that hold work in progress:
-- `payroll_inputs`, which is a draft somebody types the Eid bonuses into over an
-- afternoon and corrects, and `calendar_holidays`, where a mistyped Eid date should
-- simply be removed. 0055's triggers freeze the inputs the moment the run is
-- submitted.
--
-- **No analytics read on anything here.** §5's cross-org exceptions cover the org
-- list, the leaderboard's normalized metrics and the consolidated wallet and P&L
-- reads. A salary is none of those, and a read-only role is still a role that can
-- read (D-049). §18's consolidated payroll cost, if it ever arrives, opens the
-- ledger accounts it needs — which migration 0030 already did — rather than these
-- tables.

alter table "hr"."work_calendars" enable row level security;
--> statement-breakpoint
alter table "hr"."work_calendars" force row level security;
--> statement-breakpoint
drop policy if exists "work_calendars_org_isolation" on "hr"."work_calendars";
--> statement-breakpoint
create policy "work_calendars_org_isolation" on "hr"."work_calendars"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "hr" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "hr"."work_calendars" to "erp_app";
--> statement-breakpoint
alter table "hr"."calendar_holidays" enable row level security;
--> statement-breakpoint
alter table "hr"."calendar_holidays" force row level security;
--> statement-breakpoint
drop policy if exists "calendar_holidays_org_isolation" on "hr"."calendar_holidays";
--> statement-breakpoint
create policy "calendar_holidays_org_isolation" on "hr"."calendar_holidays"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "hr" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update, delete on "hr"."calendar_holidays" to "erp_app";
--> statement-breakpoint
alter table "hr"."employees" enable row level security;
--> statement-breakpoint
alter table "hr"."employees" force row level security;
--> statement-breakpoint
drop policy if exists "employees_org_isolation" on "hr"."employees";
--> statement-breakpoint
create policy "employees_org_isolation" on "hr"."employees"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "hr" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "hr"."employees" to "erp_app";
--> statement-breakpoint
alter table "hr"."salary_structures" enable row level security;
--> statement-breakpoint
alter table "hr"."salary_structures" force row level security;
--> statement-breakpoint
drop policy if exists "salary_structures_org_isolation" on "hr"."salary_structures";
--> statement-breakpoint
create policy "salary_structures_org_isolation" on "hr"."salary_structures"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "hr" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "hr"."salary_structures" to "erp_app";
--> statement-breakpoint
alter table "hr"."salary_components" enable row level security;
--> statement-breakpoint
alter table "hr"."salary_components" force row level security;
--> statement-breakpoint
drop policy if exists "salary_components_org_isolation" on "hr"."salary_components";
--> statement-breakpoint
create policy "salary_components_org_isolation" on "hr"."salary_components"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "hr" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update, delete on "hr"."salary_components" to "erp_app";
--> statement-breakpoint
alter table "hr"."attendance_imports" enable row level security;
--> statement-breakpoint
alter table "hr"."attendance_imports" force row level security;
--> statement-breakpoint
drop policy if exists "attendance_imports_org_isolation" on "hr"."attendance_imports";
--> statement-breakpoint
create policy "attendance_imports_org_isolation" on "hr"."attendance_imports"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "hr" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "hr"."attendance_imports" to "erp_app";
--> statement-breakpoint
alter table "hr"."attendance_days" enable row level security;
--> statement-breakpoint
alter table "hr"."attendance_days" force row level security;
--> statement-breakpoint
drop policy if exists "attendance_days_org_isolation" on "hr"."attendance_days";
--> statement-breakpoint
create policy "attendance_days_org_isolation" on "hr"."attendance_days"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "hr" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "hr"."attendance_days" to "erp_app";
--> statement-breakpoint
alter table "hr"."employee_loans" enable row level security;
--> statement-breakpoint
alter table "hr"."employee_loans" force row level security;
--> statement-breakpoint
drop policy if exists "employee_loans_org_isolation" on "hr"."employee_loans";
--> statement-breakpoint
create policy "employee_loans_org_isolation" on "hr"."employee_loans"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "hr" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "hr"."employee_loans" to "erp_app";
--> statement-breakpoint
alter table "hr"."loan_instalments" enable row level security;
--> statement-breakpoint
alter table "hr"."loan_instalments" force row level security;
--> statement-breakpoint
drop policy if exists "loan_instalments_org_isolation" on "hr"."loan_instalments";
--> statement-breakpoint
create policy "loan_instalments_org_isolation" on "hr"."loan_instalments"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "hr" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "hr"."loan_instalments" to "erp_app";
--> statement-breakpoint
alter table "hr"."payroll_runs" enable row level security;
--> statement-breakpoint
alter table "hr"."payroll_runs" force row level security;
--> statement-breakpoint
drop policy if exists "payroll_runs_org_isolation" on "hr"."payroll_runs";
--> statement-breakpoint
create policy "payroll_runs_org_isolation" on "hr"."payroll_runs"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "hr" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "hr"."payroll_runs" to "erp_app";
--> statement-breakpoint
alter table "hr"."payroll_inputs" enable row level security;
--> statement-breakpoint
alter table "hr"."payroll_inputs" force row level security;
--> statement-breakpoint
drop policy if exists "payroll_inputs_org_isolation" on "hr"."payroll_inputs";
--> statement-breakpoint
create policy "payroll_inputs_org_isolation" on "hr"."payroll_inputs"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "hr" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update, delete on "hr"."payroll_inputs" to "erp_app";
--> statement-breakpoint
alter table "hr"."payroll_lines" enable row level security;
--> statement-breakpoint
alter table "hr"."payroll_lines" force row level security;
--> statement-breakpoint
drop policy if exists "payroll_lines_org_isolation" on "hr"."payroll_lines";
--> statement-breakpoint
create policy "payroll_lines_org_isolation" on "hr"."payroll_lines"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "hr" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert on "hr"."payroll_lines" to "erp_app";
--> statement-breakpoint
alter table "hr"."payroll_line_components" enable row level security;
--> statement-breakpoint
alter table "hr"."payroll_line_components" force row level security;
--> statement-breakpoint
drop policy if exists "payroll_line_components_org_isolation" on "hr"."payroll_line_components";
--> statement-breakpoint
create policy "payroll_line_components_org_isolation" on "hr"."payroll_line_components"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "hr" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert on "hr"."payroll_line_components" to "erp_app";
--> statement-breakpoint
alter table "hr"."payroll_loan_deductions" enable row level security;
--> statement-breakpoint
alter table "hr"."payroll_loan_deductions" force row level security;
--> statement-breakpoint
drop policy if exists "payroll_loan_deductions_org_isolation" on "hr"."payroll_loan_deductions";
--> statement-breakpoint
create policy "payroll_loan_deductions_org_isolation" on "hr"."payroll_loan_deductions"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "hr" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert on "hr"."payroll_loan_deductions" to "erp_app";
