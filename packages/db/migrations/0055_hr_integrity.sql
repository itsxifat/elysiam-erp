-- What the hr schema refuses, in the database (M19; architecture §7, §12).
--
-- Every rule below is also checked by the service that writes these rows. The
-- duplication is the point: a service can be refactored, called from a worker, or
-- bypassed by the next module that needs "just one row"; a trigger cannot. Each
-- raises a message beginning with a code from `packages/contracts/src/errors.ts`, so
-- `databasePayrollCode()` turns a refusal into a 4xx a caller can act on rather than
-- a 500 and a constraint name.
--
-- The two acceptance checks this file carries:
--
-- * **A payroll run cannot be posted twice (check 2).** The status trigger below
--   allows exactly one path out of each state, so `posted → posted` is refused; the
--   unique index in 0053 allows one run per org per month; and the ledger's
--   idempotency key `payroll_run:<id>:posted` makes a replayed job write nothing.
--   Three layers, because which one refuses depends on the path — a double-clicked
--   button hits the trigger, a retried queue message hits the key.
-- * **Personal data is never stored in the clear (check 3).** 0053's masks are short
--   by CHECK; the trigger below refuses a mask that looks like a full number, which
--   is the mistake this design exists to prevent — a developer writing the plain
--   value into both columns because the mask column was the convenient one.

-- A payslip is written once and never changed.
--
-- `erp_app` holds no UPDATE or DELETE on these three tables (migration 0054), which
-- is the real control. This trigger is for the roles the grant does not bind:
-- `erp_owner` runs migrations and seeds, and a repair script connecting as the owner
-- is exactly the situation in which somebody decides to "just fix" a payslip. The
-- fix for a wrong payroll run is a reversing journal and a new run, because a
-- checker approved a total computed from these rows and the journal was posted from
-- them — editing one afterwards makes the approval and the books describe two
-- different months with nothing that disagrees.
create or replace function hr.refuse_payslip_change() returns trigger
language plpgsql as $$
begin
  raise exception 'PAYROLL_IMMUTABLE: a payslip is written once; reverse the run and post a new one instead of changing it.';
end;
$$;--> statement-breakpoint

create trigger payroll_lines_no_change
before update or delete on hr.payroll_lines
for each row execute function hr.refuse_payslip_change();--> statement-breakpoint

create trigger payroll_line_components_no_change
before update or delete on hr.payroll_line_components
for each row execute function hr.refuse_payslip_change();--> statement-breakpoint

create trigger payroll_loan_deductions_no_change
before update or delete on hr.payroll_loan_deductions
for each row execute function hr.refuse_payslip_change();--> statement-breakpoint

-- The payroll run's state machine (§12: `draft → approved → posted → paid`).
--
-- Spelled out as an allow-list of transitions rather than as "refuse the ones we
-- thought of", because the set of wrong transitions is open and the set of right
-- ones is five. A state that is not named here cannot be reached, which is the only
-- direction that stays correct when somebody adds a sixth status.
--
-- `posted → posted` is absent, and its absence is acceptance check 2.
create or replace function hr.assert_run_transition() returns trigger
language plpgsql as $$
begin
  if new.status = old.status then
    -- A same-status update is a memo or a policy edit, allowed only while the run is
    -- still a draft. Once a checker has seen it, its text is part of what they saw.
    if old.status <> 'draft' and (
         new.month is distinct from old.month
      or new.gross_poisha is distinct from old.gross_poisha
      or new.deductions_poisha is distinct from old.deductions_poisha
      or new.net_poisha is distinct from old.net_poisha
      or new.employee_count is distinct from old.employee_count
      or new.unrecorded_policy is distinct from old.unrecorded_policy
      or new.memo is distinct from old.memo
      or new.approval_request_id is distinct from old.approval_request_id
    ) then
      raise exception 'PAYROLL_RUN_FROZEN: a payroll run''s terms are fixed once it has been submitted for approval.';
    end if;
    return new;
  end if;

  if not (
       (old.status = 'draft'            and new.status in ('pending_approval', 'cancelled'))
    or (old.status = 'pending_approval' and new.status in ('posted', 'rejected', 'cancelled'))
    or (old.status = 'posted'           and new.status = 'paid')
  ) then
    raise exception 'PAYROLL_TRANSITION_INVALID: a payroll run cannot go from % to %.', old.status, new.status;
  end if;

  -- The totals a checker approved are the totals that post. They may be written
  -- once, when the run leaves `draft`, and never again.
  if old.status <> 'draft' and (
       new.gross_poisha is distinct from old.gross_poisha
    or new.deductions_poisha is distinct from old.deductions_poisha
    or new.net_poisha is distinct from old.net_poisha
    or new.employee_count is distinct from old.employee_count
    or new.month is distinct from old.month
  ) then
    raise exception 'PAYROLL_RUN_FROZEN: a payroll run''s totals are fixed once it has been submitted for approval.';
  end if;

  -- A posted run keeps the journal it posted. Repointing it at another journal
  -- would move a month's salary cost somewhere else with nothing to notice.
  if old.journal_id is not null and new.journal_id is distinct from old.journal_id then
    raise exception 'PAYROLL_IMMUTABLE: a posted payroll run keeps the journal it posted.';
  end if;
  if old.payment_journal_id is not null
     and new.payment_journal_id is distinct from old.payment_journal_id then
    raise exception 'PAYROLL_IMMUTABLE: a paid payroll run keeps the journal that paid it.';
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger payroll_runs_transition
before update on hr.payroll_runs
for each row execute function hr.assert_run_transition();--> statement-breakpoint

-- A run is born a draft.
--
-- Not a default — a default only applies when the column is omitted, and an INSERT
-- naming `status = 'posted'` would skip the transition trigger entirely and land a
-- run that claims to be posted with whatever journal the caller passed. The state
-- machine is only a state machine if there is one way in.
create or replace function hr.assert_run_born_draft() returns trigger
language plpgsql as $$
begin
  if new.status <> 'draft' then
    raise exception 'PAYROLL_TRANSITION_INVALID: a payroll run starts as a draft and is submitted for approval.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger payroll_runs_born_draft
before insert on hr.payroll_runs
for each row execute function hr.assert_run_born_draft();--> statement-breakpoint

-- Bonus and deduction inputs are a draft's working document, and stop being one.
--
-- Once the run is submitted, the inputs are part of the numbers a checker is
-- looking at. Adding a ৳50,000 bonus to a run that is waiting for approval would
-- change nothing about the frozen payslips — which is worse than it sounds, because
-- the input would then be invisible in the run that posts and present in the one
-- somebody reads back afterwards.
create or replace function hr.assert_input_run_is_draft() returns trigger
language plpgsql as $$
declare
  v_status hr.payroll_run_status;
  v_run uuid := coalesce(new.run_id, old.run_id);
  v_org uuid := coalesce(new.org_id, old.org_id);
begin
  select status into v_status from hr.payroll_runs
  where org_id = v_org and id = v_run;

  if v_status is distinct from 'draft' then
    raise exception 'PAYROLL_RUN_FROZEN: that payroll run is no longer a draft, so its bonus and deduction inputs cannot change.';
  end if;
  return coalesce(new, old);
end;
$$;--> statement-breakpoint

create trigger payroll_inputs_draft_only
before insert or update or delete on hr.payroll_inputs
for each row execute function hr.assert_input_run_is_draft();--> statement-breakpoint

-- A salary structure's money is fixed once a payslip has used it.
--
-- §12 versions a structure by `effective_from` rather than editing it, and this is
-- what makes that real. A raise is a new row with a later date; editing the basic on
-- the existing one would silently restate every past payroll line that snapshotted
-- it, and the payslip the employee is holding would no longer match the database.
-- The note stays editable, because a note is not a number.
create or replace function hr.assert_structure_not_used() returns trigger
language plpgsql as $$
begin
  if new.basic_poisha = old.basic_poisha
     and new.employee_id = old.employee_id
     and new.effective_from = old.effective_from then
    return new;
  end if;

  if exists (
    select 1 from hr.payroll_lines l
    where l.org_id = old.org_id and l.salary_structure_id = old.id
  ) then
    raise exception 'PAYROLL_STRUCTURE_FROZEN: a payslip has already been issued against that salary structure; add a new one with a later effective date.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger salary_structures_not_used
before update on hr.salary_structures
for each row execute function hr.assert_structure_not_used();--> statement-breakpoint

create or replace function hr.assert_component_structure_unused() returns trigger
language plpgsql as $$
declare
  v_structure uuid := coalesce(new.structure_id, old.structure_id);
  v_org uuid := coalesce(new.org_id, old.org_id);
begin
  if exists (
    select 1 from hr.payroll_lines l
    where l.org_id = v_org and l.salary_structure_id = v_structure
  ) then
    raise exception 'PAYROLL_STRUCTURE_FROZEN: a payslip has already been issued against that salary structure; add a new one with a later effective date.';
  end if;
  return coalesce(new, old);
end;
$$;--> statement-breakpoint

create trigger salary_components_structure_unused
before insert or update or delete on hr.salary_components
for each row execute function hr.assert_component_structure_unused();--> statement-breakpoint

-- A loan instalment only ever moves forward, and never past what it was for.
--
-- The CHECK in 0053 already bounds `deducted_poisha` by `amount_poisha`. This adds
-- the direction: an instalment that has been deducted cannot be un-deducted, which
-- is what would let a second run take the same instalment again. `waived` is the one
-- deliberate exit, and it is a decision somebody makes rather than a side effect.
create or replace function hr.assert_instalment_forward() returns trigger
language plpgsql as $$
begin
  if new.amount_poisha <> old.amount_poisha or new.seq <> old.seq
     or new.due_month <> old.due_month or new.loan_id <> old.loan_id then
    raise exception 'PAYROLL_LOAN_FROZEN: a loan instalment''s amount and due month are fixed once the loan is disbursed.';
  end if;
  if new.deducted_poisha < old.deducted_poisha then
    raise exception 'PAYROLL_LOAN_FROZEN: a loan instalment that has been deducted cannot be un-deducted; waive it or record a new loan.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger loan_instalments_forward
before update on hr.loan_instalments
for each row execute function hr.assert_instalment_forward();--> statement-breakpoint

-- A disbursed loan's principal, employee and schedule length are fixed.
--
-- The journal has already booked the receivable against that employee (§7). Changing
-- the principal afterwards would leave `employee_loan_receivable` and this row
-- disagreeing about what is owed, and the ledger is the one that is right.
create or replace function hr.assert_loan_terms_frozen() returns trigger
language plpgsql as $$
begin
  if old.journal_id is not null and (
       new.principal_poisha is distinct from old.principal_poisha
    or new.employee_id is distinct from old.employee_id
    or new.instalment_count is distinct from old.instalment_count
    or new.first_month is distinct from old.first_month
    or new.journal_id is distinct from old.journal_id
  ) then
    raise exception 'PAYROLL_LOAN_FROZEN: a disbursed loan''s terms are fixed; the ledger has already booked it.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger employee_loans_frozen
before update on hr.employee_loans
for each row execute function hr.assert_loan_terms_frozen();--> statement-breakpoint

-- A mask is a mask (invariant 10, check 3).
--
-- 0053 bounds the mask columns by length, which stops a sixteen-digit account number
-- outright. This catches the near miss: an eleven-digit Bangladeshi mobile number
-- fits in twenty characters, and `phone_masked = '01712345678'` would be the plain
-- number sitting in the column designed to be safe to show. A mask has at least one
-- masking character in it, and a value that is all digits is not a mask.
create or replace function hr.assert_masks_are_masked() returns trigger
language plpgsql as $$
begin
  if new.payout_ref_masked ~ '^[0-9]{7,}$'
     or new.national_id_masked ~ '^[0-9]{7,}$'
     or new.phone_masked ~ '^[0-9]{7,}$' then
    raise exception 'HR_FIELD_NOT_MASKED: that looks like a full number rather than a mask; store the plain value encrypted and only the last digits here.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger employees_masks_are_masked
before insert or update on hr.employees
for each row execute function hr.assert_masks_are_masked();--> statement-breakpoint

-- Attendance is corrected, never rewritten to look like something it was not.
--
-- An imported row may be corrected by hand — that is the whole reason `source`
-- exists — but the correction has to say so. A manual edit that left
-- `source = 'csv_import'` would make a month of absences typed in the day before
-- payroll indistinguishable from a month the biometric device reported, and that
-- distinction is the only evidence anyone has.
create or replace function hr.assert_attendance_correction_is_manual() returns trigger
language plpgsql as $$
begin
  if (new.status is distinct from old.status
      or new.check_in_at is distinct from old.check_in_at
      or new.check_out_at is distinct from old.check_out_at)
     and new.source <> 'manual' then
    raise exception 'ATTENDANCE_INVALID: correcting an attendance day records it as a manual entry.';
  end if;
  if new.employee_id <> old.employee_id or new.business_date <> old.business_date then
    raise exception 'ATTENDANCE_INVALID: an attendance day cannot be moved to another employee or another date.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger attendance_days_correction_is_manual
before update on hr.attendance_days
for each row execute function hr.assert_attendance_correction_is_manual();--> statement-breakpoint

-- An applied import is a record of what happened.
create or replace function hr.assert_import_transition() returns trigger
language plpgsql as $$
begin
  if old.status <> 'parsed' and new.status <> old.status then
    raise exception 'ATTENDANCE_IMPORT_FROZEN: that import has already been decided.';
  end if;
  if new.mapping is distinct from old.mapping or new.month is distinct from old.month then
    raise exception 'ATTENDANCE_IMPORT_FROZEN: an import keeps the mapping and month it was parsed with.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger attendance_imports_transition
before update on hr.attendance_imports
for each row execute function hr.assert_import_transition();--> statement-breakpoint

-- The grants in 0054 are for `erp_app`; these functions run as their definer only
-- where they must. None of them read another org's rows, so they are left as
-- SECURITY INVOKER — the default — and therefore see exactly what the caller sees.
-- Stated because the opposite is the usual mistake: a SECURITY DEFINER trigger on a
-- tenant table is a hole in RLS that looks like a performance tweak.
select 1;
