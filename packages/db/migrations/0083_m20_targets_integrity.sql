-- What M20's tables refuse, in the database (M20; architecture §12).
--
-- Every rule below is also kept by the service that writes these rows. The duplication is
-- deliberate, as in 0055 and 0079: a service can be refactored or bypassed, a trigger
-- cannot. Each refusal starts with a code from `packages/contracts/src/errors.ts`, so the
-- module turns it into a 4xx a caller can act on rather than a 500.

-- A target's terms are what the agent was told on the 1st. The rollup moves `achieved`,
-- cancelling moves the status once, and nothing else changes.
create or replace function hr.assert_target_change() returns trigger
language plpgsql as $$
begin
  if old.status = 'cancelled' then
    raise exception 'TARGET_FROZEN: a cancelled target is final.';
  end if;
  if (to_jsonb(new) - array['achieved', 'progress_at', 'status', 'cancelled_by', 'cancelled_at', 'updated_at'])
     is distinct from
     (to_jsonb(old) - array['achieved', 'progress_at', 'status', 'cancelled_by', 'cancelled_at', 'updated_at']) then
    raise exception 'TARGET_FROZEN: a target''s month, metric, people and value cannot change; cancel it and set a new one.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger targets_terms_frozen
before update on hr.targets
for each row execute function hr.assert_target_change();--> statement-breakpoint

-- The weekly split is written once. Only the rollup's `achieved` moves.
create or replace function hr.assert_target_week_change() returns trigger
language plpgsql as $$
begin
  if (to_jsonb(new) - 'achieved') is distinct from (to_jsonb(old) - 'achieved') then
    raise exception 'TARGET_FROZEN: a target''s weekly split cannot change.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger target_weeks_plan_frozen
before update on hr.target_weeks
for each row execute function hr.assert_target_week_change();--> statement-breakpoint

-- Who a target counts is decided when it is set (D-273), and an employee target counts
-- that employee alone (M20 ledger audit W6). A member row added later, or a second person
-- on an employee target, would add somebody else's orders to the figure a bonus is paid on.
-- `created_at` is the inserting transaction's `now()`, so "the same transaction" is an
-- equality.
create or replace function hr.assert_target_member() returns trigger
language plpgsql as $$
declare
  t record;
begin
  select scope::text as scope, employee_id, created_at into t
  from hr.targets where org_id = new.org_id and id = new.target_id;
  if not found or t.created_at <> now() then
    raise exception 'TARGET_FROZEN: a target''s people are set with the target, never added later.';
  end if;
  if t.scope = 'employee' and t.employee_id <> new.employee_id then
    raise exception 'TARGET_INVALID: an employee target counts that employee and nobody else.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger target_members_set_once
before insert on hr.target_members
for each row execute function hr.assert_target_member();--> statement-breakpoint

-- A bonus rule version is the JSON a checker approved: the definition never changes, and
-- the status only moves forward (D-275).
create or replace function hr.assert_bonus_rule_version_change() returns trigger
language plpgsql as $$
begin
  if (to_jsonb(new) - array['status', 'approval_request_id', 'decided_at', 'updated_at'])
     is distinct from
     (to_jsonb(old) - array['status', 'approval_request_id', 'decided_at', 'updated_at']) then
    raise exception 'BONUS_RULE_FROZEN: a bonus rule version cannot be edited; add a new version.';
  end if;
  if old.approval_request_id is not null
     and new.approval_request_id is distinct from old.approval_request_id then
    raise exception 'BONUS_RULE_FROZEN: a submitted version keeps the request it was submitted with.';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'draft' and new.status = 'pending_approval')
    or (old.status = 'pending_approval' and new.status in ('approved', 'rejected'))
    or (old.status = 'approved' and new.status = 'superseded')
  ) then
    raise exception 'BONUS_RULE_FROZEN: a bonus rule version cannot go from % to %.', old.status, new.status;
  end if;

  -- The approval link, held here as 0056 holds a payroll run's (M20 ledger audit W6). A
  -- version is submitted only with a `bonus_rule` request that names it; it goes into
  -- force only once that request is approved, by somebody other than the version's author;
  -- and it is closed as rejected only once its request was refused or withdrawn.
  if old.status = 'draft' and new.status = 'pending_approval' then
    perform 1 from approvals.approval_requests r
    where r.org_id = new.org_id and r.id = new.approval_request_id
      and r.type = 'bonus_rule' and r.payload->>'ruleVersionId' = new.id::text;
    if not found then
      raise exception 'BONUS_RULE_FROZEN: a version is submitted only with a bonus_rule request that names it.';
    end if;
  end if;
  if old.status = 'pending_approval' and new.status = 'approved' then
    perform 1 from approvals.approval_requests r
    where r.org_id = new.org_id and r.id = new.approval_request_id
      and r.status = 'approved' and r.decided_by is distinct from new.created_by;
    if not found then
      raise exception 'BONUS_RULE_FROZEN: a version goes into force only on its own approved request, decided by somebody other than its author.';
    end if;
  end if;
  if old.status = 'pending_approval' and new.status = 'rejected' then
    perform 1 from approvals.approval_requests r
    where r.org_id = new.org_id and r.id = new.approval_request_id
      and r.status in ('rejected', 'cancelled');
    if not found then
      raise exception 'BONUS_RULE_FROZEN: a version is closed as rejected only once its request was refused or withdrawn.';
    end if;
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger bonus_rule_versions_frozen
before update on hr.bonus_rule_versions
for each row execute function hr.assert_bonus_rule_version_change();--> statement-breakpoint

-- An award, and the bonus input it made, belong to a draft run. Once the run is
-- submitted its bonuses are what the checker approves, so neither may be added or
-- removed (0055 already freezes the inputs themselves).
create or replace function hr.assert_bonus_award_run_draft() returns trigger
language plpgsql as $$
declare
  run_status text;
  run_org uuid;
  the_run uuid;
begin
  if tg_op = 'DELETE' then
    run_org := old.org_id;
    the_run := old.run_id;
  else
    run_org := new.org_id;
    the_run := new.run_id;
  end if;

  select status::text into run_status
  from hr.payroll_runs where org_id = run_org and id = the_run;

  -- A run deleted with its awards (the cascade) has no row left to read; nothing to guard.
  if run_status is not null and run_status <> 'draft' then
    raise exception 'PAYROLL_RUN_FROZEN: that payroll run is no longer a draft, so its bonuses cannot change.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger bonus_awards_run_draft
before insert or delete on hr.bonus_awards
for each row execute function hr.assert_bonus_award_run_draft();--> statement-breakpoint

-- An award pays the employee its input pays, the amount its input says, in its run.
create or replace function hr.assert_bonus_award_matches_input() returns trigger
language plpgsql as $$
declare
  input record;
begin
  select run_id, employee_id, kind::text as kind, amount_poisha into input
  from hr.payroll_inputs where org_id = new.org_id and id = new.payroll_input_id;

  if not found
     or input.run_id <> new.run_id
     or input.employee_id <> new.employee_id
     or input.kind <> 'bonus'
     or input.amount_poisha <> new.amount_poisha then
    raise exception 'PAYROLL_INPUT_INVALID: a bonus award must name the bonus input it created.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger bonus_awards_match_input
before insert on hr.bonus_awards
for each row execute function hr.assert_bonus_award_matches_input();
