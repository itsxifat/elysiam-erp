-- D-954: the permission is the rule. The database's own copies of the old person-to-person
-- rules go: super admins are made and removed by any active super admin at once (no votes,
-- no "first super admin"), and a bonus rule version goes into force on its approved request
-- whoever decided it. Still held here: only an active super admin with two-step sign-in (an
-- owner counts as enrolled, D-473) changes the flag, never on an owner, never leaving the
-- brand without a super admin, and only through these two functions (0139's trigger).

create or replace function iam.promote_super_admin(p_candidate text)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, iam, pg_temp
as $$
declare
  v_org uuid := nullif(current_setting('app.org_id', true), '')::uuid;
  v_actor text := nullif(current_setting('app.user_id', true), '');
begin
  if v_org is null or v_actor is null then
    raise exception 'SUPER_ADMIN_PROMOTION_REFUSED: a promotion is made by a person, in a brand'
      using errcode = 'insufficient_privilege';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('iam.super_admins', 0));

  if p_candidate is null or p_candidate = v_actor then
    raise exception 'SUPER_ADMIN_PROMOTION_REFUSED: nobody makes themselves a super admin'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from iam.users u
    where u.id = v_actor and u.is_active and u.is_super_admin
      and (u.two_factor_enabled or u.is_owner)
  ) then
    raise exception 'SUPER_ADMIN_PROMOTION_REFUSED: only an active super admin makes a super admin'
      using errcode = 'insufficient_privilege';
  end if;
  perform 1 from iam.users u
  where u.id = p_candidate and u.is_active and not u.is_super_admin and not u.is_owner
  for update;
  if not found then
    raise exception 'SUPER_ADMIN_PROMOTION_REFUSED: % is not someone who can be made a super admin', p_candidate
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from iam.memberships m
    where m.org_id = v_org and m.user_id = p_candidate
      and m.role = 'org_admin' and m.is_active
  ) then
    raise exception 'SUPER_ADMIN_PROMOTION_REFUSED: % is not an active admin of this brand', p_candidate
      using errcode = 'check_violation';
  end if;

  update iam.users set is_super_admin = true, updated_at = now() where id = p_candidate;
  delete from iam.super_admin_votes where org_id = v_org and candidate_user_id = p_candidate;
end;
$$;
--> statement-breakpoint
create or replace function iam.demote_super_admin(p_target text)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, iam, pg_temp
as $$
declare
  v_org uuid := nullif(current_setting('app.org_id', true), '')::uuid;
  v_actor text := nullif(current_setting('app.user_id', true), '');
  v_others integer;
begin
  if v_org is null or v_actor is null then
    raise exception 'SUPER_ADMIN_REMOVAL_REFUSED: a removal is made by a person, in a brand'
      using errcode = 'insufficient_privilege';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('iam.super_admins', 0));

  perform 1 from iam.users u
  where u.id = p_target and u.is_active and u.is_super_admin and not u.is_owner
  for update;
  if not found then
    raise exception 'SUPER_ADMIN_REMOVAL_REFUSED: % is not a super admin who can be removed', p_target
      using errcode = 'check_violation';
  end if;

  select count(*) into v_others
  from iam.users u
  where u.is_super_admin and u.is_active and not u.is_owner and u.id <> p_target;
  if v_others = 0 then
    raise exception 'SUPER_ADMIN_REMOVAL_REFUSED: the last super admin stays'
      using errcode = 'check_violation';
  end if;

  if p_target <> v_actor and not exists (
    select 1 from iam.users u
    where u.id = v_actor and u.is_active and u.is_super_admin
      and (u.two_factor_enabled or u.is_owner)
  ) then
    raise exception 'SUPER_ADMIN_REMOVAL_REFUSED: only an active super admin removes a super admin'
      using errcode = 'insufficient_privilege';
  end if;

  update iam.users set is_super_admin = false, updated_at = now() where id = p_target;
  delete from iam.super_admin_removal_votes where org_id = v_org and target_user_id = p_target;
end;
$$;
--> statement-breakpoint
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

  -- The approval link (M20 ledger audit W6). A version is submitted only with a `bonus_rule`
  -- request that names it; it goes into force only once that request is approved (D-954:
  -- by anyone who may decide it); and it is closed as rejected only once its request was
  -- refused or withdrawn.
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
      and r.status = 'approved';
    if not found then
      raise exception 'BONUS_RULE_FROZEN: a version goes into force only on its own approved request.';
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
$$;
--> statement-breakpoint
-- A loan is voided by whoever may void it, its recorder included (D-954).
create or replace function loans.assert_loan_change() returns trigger
language plpgsql as $$
declare
  v_reverses uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'LOAN_IMMUTABLE: a loan is never removed; void it instead.';
  end if;

  if (new.id, new.org_id, new.lender_id, new.reference, new.principal_poisha, new.rate_bps,
      new.method, new.tenure_months, new.received_on, new.first_due_on, new.reminder_days,
      new.reminder_phone, new.wallet_account_id, new.received_journal_id, new.memo,
      new.created_by, new.created_at)
     is distinct from
     (old.id, old.org_id, old.lender_id, old.reference, old.principal_poisha, old.rate_bps,
      old.method, old.tenure_months, old.received_on, old.first_due_on, old.reminder_days,
      old.reminder_phone, old.wallet_account_id, old.received_journal_id, old.memo,
      old.created_by, old.created_at) then
    raise exception 'LOAN_IMMUTABLE: a loan''s terms are what was signed; void it and record it again.';
  end if;

  if old.voided_at is not null or new.voided_at is null then
    raise exception 'LOAN_IMMUTABLE: a loan is voided once, and only that.';
  end if;

  -- Under READ COMMITTED this query takes a fresh snapshot after the row lock above was
  -- granted, so a payment whose insert held the loan `for share` is seen once it commits.
  if exists (select 1 from loans.payments p
             where p.org_id = new.org_id and p.loan_id = new.id and p.status <> 'rejected') then
    raise exception 'LOAN_IMMUTABLE: a loan with a repayment posted or waiting cannot be voided.';
  end if;

  select reverses_journal_id into v_reverses
    from ledger.journals where org_id = new.org_id and id = new.void_journal_id;
  if v_reverses is distinct from new.received_journal_id then
    raise exception 'LOAN_IMMUTABLE: a void names the journal that reverses the loan''s receipt.';
  end if;

  return new;
end;
$$;
--> statement-breakpoint
-- Sign-in resets no longer wait for a second admin (D-954). Any still open from before are
-- closed: their approvals withdrawn first (iam.guard_credential_reset wants a waiting reset
-- withdrawn with its approval), then the resets. Nothing about a person's sign-in changes;
-- an admin resets them again, at once.
update approvals.approval_requests
set status = 'cancelled', decision_note = 'Closed: resets happen at once now (D-954).', updated_at = now()
where type = 'credential_reset' and status = 'pending';
--> statement-breakpoint
update iam.credential_resets
set status = 'cancelled', updated_at = now()
where status in ('pending_approval', 'approved');
