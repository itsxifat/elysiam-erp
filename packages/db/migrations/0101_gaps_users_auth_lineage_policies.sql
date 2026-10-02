-- The grant lineage, kept whole, and a tighter sign-in reset lifecycle (gaps-users-auth,
-- the ledger audit's C2, W4, W7, N1, N3 and N6; D-406, D-407, D-410).
--
-- 1. `iam.membership_granters` is append-only: INSERT and SELECT for erp_app, never UPDATE
--    or DELETE. It is backfilled from `iam.memberships.granted_by`, the one granter the
--    table kept until now.
-- 2. `memberships_not_self_granted` (added NOT VALID by 0100) is validated after clearing
--    any self-grant. Both steps read every brand's rows, which FORCE ROW LEVEL SECURITY
--    hides even from the owner, so RLS is lifted on `iam.memberships` for the length of
--    this transaction only and forced again before it commits.
-- 3. `iam.guard_credential_reset()` replaces 0099's: the requester is the acting user; a
--    password reset is approved and then collected, a second-factor reset is completed by
--    its approval; a decision matches the approval it rests on, decided by the same
--    person; a waiting reset is cancelled only with its approval; and only the admin who
--    asked collects an approved one.
-- 4. `iam.users_active_elsewhere()` answers "which of these people hold an active role in
--    another active brand" inside the caller's transaction, through each person's own
--    lens (the D-050 self policy), restoring the caller's `app.user_id` before it returns.
--    It returns user ids only, never a brand.

-- 1. The granter history.
alter table "iam"."memberships" no force row level security;
--> statement-breakpoint
insert into "iam"."membership_granters" (org_id, user_id, granted_by, reason, created_at)
select m.org_id, m.user_id, m.granted_by, 'backfill', m.created_at
from "iam"."memberships" m
where m.granted_by is not null and m.granted_by <> m.user_id;
--> statement-breakpoint
-- 2. Nobody is their own granter.
update "iam"."memberships" set granted_by = null where granted_by = user_id;
--> statement-breakpoint
alter table "iam"."memberships" validate constraint "memberships_not_self_granted";
--> statement-breakpoint
alter table "iam"."memberships" force row level security;
--> statement-breakpoint
alter table "iam"."membership_granters" enable row level security;
--> statement-breakpoint
alter table "iam"."membership_granters" force row level security;
--> statement-breakpoint
drop policy if exists "membership_granters_org_isolation" on "iam"."membership_granters";
--> statement-breakpoint
create policy "membership_granters_org_isolation" on "iam"."membership_granters"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "iam" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert on "iam"."membership_granters" to "erp_app";
--> statement-breakpoint
-- 3. The reset lifecycle, tightened.
create or replace function iam.guard_credential_reset()
returns trigger
language plpgsql
set search_path = pg_catalog, iam
as $$
declare
  v_actor text := nullif(current_setting('app.user_id', true), '');
  v_approval_status text;
  v_approval_decider text;
begin
  if tg_op = 'INSERT' then
    if not (
      (new.status = 'pending_approval' and new.kind in ('password', 'two_factor')
        and new.approval_request_id is not null
        and new.decided_by is null and new.completed_at is null)
      or (new.status = 'completed' and new.approval_request_id is null
        and new.decided_by is null and new.completed_at is not null)
    ) then
      raise exception 'CREDENTIAL_RESET_INVALID: a reset starts waiting for approval, or completed at once'
        using errcode = 'integrity_constraint_violation';
    end if;
    if v_actor is not null and new.requested_by <> v_actor then
      raise exception 'CREDENTIAL_RESET_INVALID: a reset is asked for by the acting user'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.user_id is distinct from old.user_id
     or new.kind is distinct from old.kind
     or new.requested_by is distinct from old.requested_by
     or new.reason is distinct from old.reason
     or new.approval_request_id is distinct from old.approval_request_id
     or new.created_at is distinct from old.created_at then
    raise exception 'CREDENTIAL_RESET_INVALID: the terms of reset % cannot change', old.id
      using errcode = 'integrity_constraint_violation';
  end if;

  if not (
    (old.status = 'pending_approval' and new.status = 'approved' and old.kind = 'password')
    or (old.status = 'pending_approval' and new.status = 'completed' and old.kind = 'two_factor')
    or (old.status = 'pending_approval' and new.status in ('rejected', 'cancelled'))
    or (old.status = 'approved' and new.status in ('completed', 'cancelled', 'expired'))
  ) then
    raise exception 'CREDENTIAL_RESET_INVALID: reset % cannot move from % to %', old.id, old.status, new.status
      using errcode = 'integrity_constraint_violation';
  end if;

  -- A decision, once recorded, is the decision.
  if old.status <> 'pending_approval' and (
       new.decided_by is distinct from old.decided_by
       or new.decided_at is distinct from old.decided_at) then
    raise exception 'CREDENTIAL_RESET_INVALID: reset % is already decided', old.id
      using errcode = 'integrity_constraint_violation';
  end if;

  if old.status = 'pending_approval' then
    select r.status::text, r.decided_by into v_approval_status, v_approval_decider
    from approvals.approval_requests r
    where r.id = old.approval_request_id;

    if new.status in ('approved', 'completed', 'rejected') then
      if new.decided_by is null or new.decided_at is null then
        raise exception 'CREDENTIAL_RESET_INVALID: deciding reset % needs a decider', old.id
          using errcode = 'integrity_constraint_violation';
      end if;
      if new.decided_by = new.requested_by or new.decided_by = new.user_id then
        raise exception 'CREDENTIAL_RESET_INVALID: reset % is decided by someone other than its requester and its subject', old.id
          using errcode = 'integrity_constraint_violation';
      end if;
      if v_actor is not null and new.decided_by <> v_actor then
        raise exception 'CREDENTIAL_RESET_INVALID: reset % is decided by the acting user', old.id
          using errcode = 'insufficient_privilege';
      end if;
      if v_approval_decider is distinct from new.decided_by
         or v_approval_status is distinct from
            (case when new.status = 'rejected' then 'rejected' else 'approved' end) then
        raise exception 'CREDENTIAL_RESET_INVALID: reset % follows its approval, decided by the same person', old.id
          using errcode = 'integrity_constraint_violation';
      end if;
    elsif new.status = 'cancelled' and v_approval_status is distinct from 'cancelled' then
      raise exception 'CREDENTIAL_RESET_INVALID: a waiting reset is withdrawn with its approval'
        using errcode = 'integrity_constraint_violation';
    end if;
  end if;

  if old.status = 'approved' and new.status = 'completed'
     and v_actor is not null and v_actor <> old.requested_by then
    raise exception 'CREDENTIAL_RESET_INVALID: only the admin who asked collects reset %', old.id
      using errcode = 'insufficient_privilege';
  end if;

  if new.status = 'completed' and new.completed_at is null then
    raise exception 'CREDENTIAL_RESET_INVALID: a completed reset records when'
      using errcode = 'integrity_constraint_violation';
  end if;

  new.updated_at := now();
  return new;
end;
$$;
--> statement-breakpoint
-- 4. Who else works elsewhere, without leaving the caller's transaction.
create or replace function iam.users_active_elsewhere(p_users text[], p_org uuid)
returns setof text
language plpgsql
volatile
security invoker
set search_path = pg_catalog, iam
as $$
declare
  v_previous text := coalesce(current_setting('app.user_id', true), '');
  v_user text;
begin
  foreach v_user in array coalesce(p_users, '{}'::text[]) loop
    perform set_config('app.user_id', v_user, true);
    if exists (
      select 1
      from iam.memberships m
      join org.organizations o on o.id = m.org_id
      where m.user_id = v_user and m.org_id <> p_org and m.is_active and o.is_active
    ) then
      return next v_user;
    end if;
  end loop;
  perform set_config('app.user_id', v_previous, true);
  return;
end;
$$;
--> statement-breakpoint
revoke all on function iam.users_active_elsewhere(text[], uuid) from public;
--> statement-breakpoint
grant execute on function iam.users_active_elsewhere(text[], uuid) to "erp_app";
