-- Tenant isolation and lifecycle for sign-in resets (gaps-users-auth, D-402 to D-406).
--
-- The policy is `tenantTableSql()`'s, pasted verbatim as every tenant policy in this repo
-- is (D-048). The grants are where the decisions are: SELECT, INSERT and UPDATE, never
-- DELETE. A reset is evidence — who asked to take over whose sign-in, and who agreed — and
-- the reset limits count these rows, so removing one would also give an admin their
-- allowance back.
--
-- The trigger holds the lifecycle that `canMoveReset` in packages/domain describes:
-- a reset is raised waiting for a second admin, or completed at once; a waiting one is
-- approved, completed (a second factor removed by its approval), rejected or cancelled; an
-- approved password reset is collected, cancelled or left to expire. Every other status is
-- final, and the terms of a reset never change. Whoever decides a waiting reset is neither
-- the admin who asked nor the person being reset — the approvals service checks the first
-- and the iam executor the second; this is the same rule where no service can skip it.

alter table "iam"."credential_resets" enable row level security;
--> statement-breakpoint
alter table "iam"."credential_resets" force row level security;
--> statement-breakpoint
drop policy if exists "credential_resets_org_isolation" on "iam"."credential_resets";
--> statement-breakpoint
create policy "credential_resets_org_isolation" on "iam"."credential_resets"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "iam" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "iam"."credential_resets" to "erp_app";
--> statement-breakpoint
create or replace function iam.guard_credential_reset()
returns trigger
language plpgsql
set search_path = pg_catalog, iam
as $$
begin
  if tg_op = 'INSERT' then
    if not (
      (new.status = 'pending_approval' and new.approval_request_id is not null
        and new.decided_by is null and new.completed_at is null)
      or (new.status = 'completed' and new.approval_request_id is null
        and new.decided_by is null and new.completed_at is not null)
    ) then
      raise exception 'CREDENTIAL_RESET_INVALID: a reset starts waiting for approval, or completed at once'
        using errcode = 'integrity_constraint_violation';
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
    (old.status = 'pending_approval' and new.status in ('approved', 'completed', 'rejected', 'cancelled'))
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

  if old.status = 'pending_approval' and new.status in ('approved', 'completed', 'rejected') then
    if new.decided_by is null or new.decided_at is null then
      raise exception 'CREDENTIAL_RESET_INVALID: deciding reset % needs a decider', old.id
        using errcode = 'integrity_constraint_violation';
    end if;
    if new.decided_by = new.requested_by or new.decided_by = new.user_id then
      raise exception 'CREDENTIAL_RESET_INVALID: reset % is decided by someone other than its requester and its subject', old.id
        using errcode = 'integrity_constraint_violation';
    end if;
    -- The decider is whoever the transaction says is acting, as 0015 holds approvals to.
    -- Checked only when an actor is set: owner-level repair scripts set none.
    if nullif(current_setting('app.user_id', true), '') is not null
       and new.decided_by <> current_setting('app.user_id', true) then
      raise exception 'CREDENTIAL_RESET_INVALID: reset % is decided by the acting user', old.id
        using errcode = 'insufficient_privilege';
    end if;
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
drop trigger if exists credential_resets_guard on "iam"."credential_resets";
--> statement-breakpoint
create trigger credential_resets_guard
  before insert or update on "iam"."credential_resets"
  for each row execute function iam.guard_credential_reset();
