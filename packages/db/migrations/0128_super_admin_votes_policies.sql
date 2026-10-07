-- Super admins making super admins (D-659): tenant isolation and grants for their votes, a
-- trigger holding who may cast one, and the one function through which the application sets
-- `is_super_admin`.
--
-- The policy is `tenantTableSql()`'s, pasted verbatim as every tenant policy in this repo is
-- (D-048). SELECT, INSERT and DELETE for erp_app, never UPDATE: a vote is cast, or the whole
-- nomination withdrawn; the audit log keeps both. No analytics read.
--
-- 0015's trigger still lets nobody but the owner role set the flag. `iam.promote_super_admin`
-- is owned by that role and checks the owner's rule itself, under one lock for every
-- promotion, so two nominations racing cannot both find "one super admin" and make three:
-- the acting user (`app.user_id`, which `withOrg` always sets) is an active super admin with
-- two-step sign-in (an owner counts as enrolled, D-473); the candidate is an active admin of
-- this brand who is neither a super admin nor an owner, and not the actor; and, when the
-- brand has two or more active super admins (owners left out, as `admin:bootstrap` leaves
-- them out, D-477), every one of them has a vote recorded here for the candidate.
alter table "iam"."super_admin_votes" enable row level security;
--> statement-breakpoint
alter table "iam"."super_admin_votes" force row level security;
--> statement-breakpoint
drop policy if exists "super_admin_votes_org_isolation" on "iam"."super_admin_votes";
--> statement-breakpoint
create policy "super_admin_votes_org_isolation" on "iam"."super_admin_votes"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "iam" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, delete on "iam"."super_admin_votes" to "erp_app";
--> statement-breakpoint
create or replace function iam.guard_super_admin_vote()
returns trigger
language plpgsql
set search_path = pg_catalog, iam
as $$
declare
  v_actor text := nullif(current_setting('app.user_id', true), '');
begin
  if v_actor is not null and new.voter_user_id <> v_actor then
    raise exception 'SUPER_ADMIN_VOTE_INVALID: a vote is cast by the acting user'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from iam.users u
    where u.id = new.voter_user_id and u.is_active and u.is_super_admin
      and (u.two_factor_enabled or u.is_owner)
  ) then
    raise exception 'SUPER_ADMIN_VOTE_INVALID: only an active super admin votes'
      using errcode = 'insufficient_privilege';
  end if;
  if exists (
    select 1 from iam.users u
    where u.id = new.candidate_user_id and (u.is_super_admin or u.is_owner)
  ) then
    raise exception 'SUPER_ADMIN_VOTE_INVALID: % holds super admin authority already', new.candidate_user_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
drop trigger if exists super_admin_votes_guard on "iam"."super_admin_votes";
--> statement-breakpoint
create trigger super_admin_votes_guard
  before insert on "iam"."super_admin_votes"
  for each row execute function iam.guard_super_admin_vote();
--> statement-breakpoint
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
  v_required integer;
  v_missing integer;
begin
  if v_org is null or v_actor is null then
    raise exception 'SUPER_ADMIN_PROMOTION_REFUSED: a promotion is made by a person, in a brand'
      using errcode = 'insufficient_privilege';
  end if;
  -- One promotion at a time, everywhere: "how many super admins are there" stays true until
  -- this transaction ends.
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

  select count(*) into v_required
  from iam.users u
  where u.is_super_admin and u.is_active and not u.is_owner;
  if v_required >= 2 then
    select count(*) into v_missing
    from iam.users u
    where u.is_super_admin and u.is_active and not u.is_owner
      and not exists (
        select 1 from iam.super_admin_votes v
        where v.org_id = v_org and v.candidate_user_id = p_candidate
          and v.voter_user_id = u.id
      );
    if v_missing > 0 then
      raise exception 'SUPER_ADMIN_VOTES_MISSING: % super admin(s) have not voted yet', v_missing
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  update iam.users set is_super_admin = true, updated_at = now() where id = p_candidate;
  delete from iam.super_admin_votes where org_id = v_org and candidate_user_id = p_candidate;
end;
$$;
--> statement-breakpoint
revoke all on function iam.promote_super_admin(text) from public;
--> statement-breakpoint
grant execute on function iam.promote_super_admin(text) to "erp_app";
