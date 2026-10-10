-- Removing a super admin (D-685 to D-689): tenant isolation and grants for the removal votes,
-- a trigger holding who may cast one, the one function through which the application clears
-- `is_super_admin`, and the flag's guard, now refusing a clear from anyone but the owner role.
--
-- The policy is `tenantTableSql()`'s, pasted verbatim as every tenant policy in this repo is
-- (D-048). SELECT, INSERT and DELETE for erp_app, never UPDATE: a vote is cast, or the whole
-- removal withdrawn; the audit log keeps both. No analytics read.
--
-- `iam.demote_super_admin` is owned by the owner role and checks the owner's rule itself,
-- under the one lock every promotion takes ('iam.super_admins'), so a removal and a
-- promotion, or two removals, never both find the count they expected:
--   - the target is an active super admin who is not an owner, and never the last one
--     (owners left out of the count, as `admin:bootstrap` leaves them out, D-477);
--   - the target is the acting user (`app.user_id`, which `withOrg` always sets): a step down;
--   - or the actor is an active super admin with two-step sign-in, or an owner (D-473); the
--     target is not the first super admin (the earliest active one, owners aside), who is
--     removed only by stepping down; and, when two or more other super admins remain, every
--     one of them has a removal vote recorded here for the target.
alter table "iam"."super_admin_removal_votes" enable row level security;
--> statement-breakpoint
alter table "iam"."super_admin_removal_votes" force row level security;
--> statement-breakpoint
drop policy if exists "super_admin_removal_votes_org_isolation" on "iam"."super_admin_removal_votes";
--> statement-breakpoint
create policy "super_admin_removal_votes_org_isolation" on "iam"."super_admin_removal_votes"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, delete on "iam"."super_admin_removal_votes" to "erp_app";
--> statement-breakpoint
create or replace function iam.guard_super_admin_removal_vote()
returns trigger
language plpgsql
set search_path = pg_catalog, iam
as $$
declare
  v_actor text := nullif(current_setting('app.user_id', true), '');
  v_first text;
begin
  if v_actor is not null and new.voter_user_id <> v_actor then
    raise exception 'SUPER_ADMIN_REMOVAL_VOTE_INVALID: a vote is cast by the acting user'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from iam.users u
    where u.id = new.voter_user_id and u.is_active and u.is_super_admin
      and (u.two_factor_enabled or u.is_owner)
  ) then
    raise exception 'SUPER_ADMIN_REMOVAL_VOTE_INVALID: only an active super admin votes'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from iam.users u
    where u.id = new.target_user_id and u.is_active and u.is_super_admin and not u.is_owner
  ) then
    raise exception 'SUPER_ADMIN_REMOVAL_VOTE_INVALID: % is not a super admin who can be removed', new.target_user_id
      using errcode = 'check_violation';
  end if;
  select u.id into v_first
  from iam.users u
  where u.is_super_admin and u.is_active and not u.is_owner
  order by u.created_at, u.id
  limit 1;
  if v_first = new.target_user_id then
    raise exception 'SUPER_ADMIN_REMOVAL_VOTE_INVALID: the first super admin is removed only by stepping down'
      using errcode = 'insufficient_privilege';
  end if;
  -- The first vote starts the removal: only the first super admin or an owner (D-666).
  if not exists (
    select 1 from iam.super_admin_removal_votes v
    where v.org_id = new.org_id and v.target_user_id = new.target_user_id
  ) and new.voter_user_id is distinct from v_first and not exists (
    select 1 from iam.users u where u.id = new.voter_user_id and u.is_owner
  ) then
    raise exception 'SUPER_ADMIN_REMOVAL_VOTE_INVALID: only the first super admin starts a removal'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
drop trigger if exists super_admin_removal_votes_guard on "iam"."super_admin_removal_votes";
--> statement-breakpoint
create trigger super_admin_removal_votes_guard
  before insert on "iam"."super_admin_removal_votes"
  for each row execute function iam.guard_super_admin_removal_vote();
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
  v_first text;
  v_others integer;
  v_missing integer;
begin
  if v_org is null or v_actor is null then
    raise exception 'SUPER_ADMIN_REMOVAL_REFUSED: a removal is made by a person, in a brand'
      using errcode = 'insufficient_privilege';
  end if;
  -- The promotions' lock: "how many super admins are there" stays true until this
  -- transaction ends.
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

  if p_target <> v_actor then
    if not exists (
      select 1 from iam.users u
      where u.id = v_actor and u.is_active and u.is_super_admin
        and (u.two_factor_enabled or u.is_owner)
    ) then
      raise exception 'SUPER_ADMIN_REMOVAL_REFUSED: only an active super admin removes a super admin'
        using errcode = 'insufficient_privilege';
    end if;
    select u.id into v_first
    from iam.users u
    where u.is_super_admin and u.is_active and not u.is_owner
    order by u.created_at, u.id
    limit 1;
    if v_first = p_target then
      raise exception 'SUPER_ADMIN_REMOVAL_REFUSED: the first super admin is removed only by stepping down'
        using errcode = 'insufficient_privilege';
    end if;
    -- With one other super admin left, that one is the first, and the actor is them or an
    -- owner: the removal is at once. With two or more, every one of them has voted.
    if v_others >= 2 then
      select count(*) into v_missing
      from iam.users u
      where u.is_super_admin and u.is_active and not u.is_owner and u.id <> p_target
        and not exists (
          select 1 from iam.super_admin_removal_votes v
          where v.org_id = v_org and v.target_user_id = p_target and v.voter_user_id = u.id
        );
      if v_missing > 0 then
        raise exception 'SUPER_ADMIN_REMOVAL_VOTES_MISSING: % super admin(s) have not voted yet', v_missing
          using errcode = 'insufficient_privilege';
      end if;
    end if;
  end if;

  update iam.users set is_super_admin = false, updated_at = now() where id = p_target;
  delete from iam.super_admin_removal_votes where org_id = v_org and target_user_id = p_target;
end;
$$;
--> statement-breakpoint
revoke all on function iam.demote_super_admin(text) from public;
--> statement-breakpoint
grant execute on function iam.demote_super_admin(text) to "erp_app";
--> statement-breakpoint
-- 0015's guard let the application role clear the flag with a plain UPDATE. Now only the
-- owner role changes it either way, and the application reaches the owner role only through
-- `iam.promote_super_admin` and `iam.demote_super_admin`, which check the rules.
create or replace function iam.guard_super_admin()
returns trigger
language plpgsql
set search_path = pg_catalog, iam
as $$
begin
  if current_user <> 'erp_owner' then
    if new.is_super_admin and (tg_op = 'INSERT' or not old.is_super_admin) then
      raise exception 'IAM_FORBIDDEN: only the owner role grants super admin'
        using errcode = 'insufficient_privilege';
    end if;
    if tg_op = 'UPDATE' and old.is_super_admin and not new.is_super_admin then
      raise exception 'IAM_FORBIDDEN: only iam.demote_super_admin removes a super admin'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;
