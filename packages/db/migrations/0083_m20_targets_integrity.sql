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
