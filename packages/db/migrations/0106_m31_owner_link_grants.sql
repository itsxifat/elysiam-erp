-- M31 (D-473): the owner sign-in link's single-use record, and the owner's rules.
--
-- `iam.owner_link_uses` is global identity data like `iam.sessions`: no `org_id`, no RLS,
-- and declared in `GLOBAL_TABLES`. The application role inserts a `jti` before it creates
-- a session (`on conflict do nothing`, and a link whose `jti` was already there is
-- refused), and deletes the rows more than a day old as it goes: a link lives two minutes,
-- so a pruned `jti` can never be presented in time again. No UPDATE: a use is a fact.
--
-- `erp_analytics` gets nothing. Identity is not analytics data (`ANALYTICS_READABLE`).
grant usage on schema "iam" to "erp_app";
--> statement-breakpoint
grant select, insert, delete on "iam"."owner_link_uses" to "erp_app";
--> statement-breakpoint
-- Like super admin (0015), only the owner role makes an owner, and whether an identity is
-- an owner never changes once it is made: no update turns a staff account into an owner (a
-- super admin let past the enrolment wall by its links) or back.
create or replace function iam.guard_owner_flag()
returns trigger
language plpgsql
set search_path = pg_catalog, iam
as $$
begin
  if tg_op = 'INSERT' then
    if new.is_owner and current_user <> 'erp_owner' then
      raise exception 'IAM_FORBIDDEN: only the owner role makes an owner'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if new.is_owner is distinct from old.is_owner then
    raise exception 'OWNER_FLAG_FIXED: whether % is an owner is set when the identity is made', old.id
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
drop trigger if exists users_owner_flag_fixed on "iam"."users";
--> statement-breakpoint
create trigger users_owner_flag_fixed
  before insert or update of is_owner on "iam"."users"
  for each row execute function iam.guard_owner_flag();
--> statement-breakpoint
-- An owner holds no role in a brand: they act as a super admin, and a membership would put
-- them on the Staff screen and in the role-holders' lineage.
create or replace function iam.guard_owner_membership()
returns trigger
language plpgsql
set search_path = pg_catalog, iam
as $$
begin
  if exists (select 1 from iam.users u where u.id = new.user_id and u.is_owner) then
    raise exception 'OWNER_HAS_NO_ROLE: % signs in by owner link and holds no role here', new.user_id
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
drop trigger if exists memberships_not_for_owners on "iam"."memberships";
--> statement-breakpoint
create trigger memberships_not_for_owners
  before insert or update of user_id on "iam"."memberships"
  for each row execute function iam.guard_owner_membership();
--> statement-breakpoint
-- The one way the application makes an owner: as the owner role, and only for a link it has
-- just spent (`p_jti` recorded in the last five minutes). The owner-link route calls it after
-- the signature, audience, expiry and single use have all been checked; everything else in
-- the application still cannot set `is_super_admin` or `is_owner` (the two triggers above).
--
-- Finds the owner by email, or makes one (super admin, owner, no password, no role); keeps
-- the name the link carries. Refuses an address that belongs to anyone else — a staff
-- account, a local super admin, an owner a password was somehow set on — and an owner that
-- was switched off.
create or replace function iam.ensure_owner_identity(p_jti text, p_email text, p_name text)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, iam
as $$
declare
  v_user iam.users%rowtype;
  v_id text;
begin
  if not exists (
    select 1 from iam.owner_link_uses
    where jti = p_jti and used_at > now() - interval '5 minutes'
  ) then
    raise exception 'OWNER_LINK_UNSPENT: no owner link % was just used', p_jti
      using errcode = 'insufficient_privilege';
  end if;
  if p_email is null or p_email <> lower(p_email) or position('@' in p_email) < 2
     or p_name is null or length(btrim(p_name)) = 0 or length(p_name) > 200 then
    raise exception 'OWNER_IDENTITY_INVALID: an owner needs an email and a name'
      using errcode = 'check_violation';
  end if;

  select * into v_user from iam.users where lower(email) = p_email for update;
  if not found then
    v_id := 'usr_' || gen_random_uuid()::text;
    insert into iam.users (id, email, name, email_verified, is_super_admin, is_owner)
    values (v_id, p_email, p_name, true, true, true)
    on conflict (email) do nothing;
    select * into v_user from iam.users where lower(email) = p_email for update;
  end if;

  if not (v_user.is_owner and v_user.is_super_admin)
     or exists (
       select 1 from iam.accounts a
       where a.user_id = v_user.id and a.provider_id = 'credential'
     ) then
    raise exception 'OWNER_IDENTITY_CONFLICT: that address belongs to another account'
      using errcode = 'unique_violation';
  end if;
  if not v_user.is_active then
    raise exception 'OWNER_IDENTITY_INACTIVE: that owner is switched off here'
      using errcode = 'insufficient_privilege';
  end if;
  if v_user.name is distinct from p_name then
    update iam.users set name = p_name, updated_at = now() where id = v_user.id;
  end if;
  return v_user.id;
end;
$$;
--> statement-breakpoint
revoke all on function iam.ensure_owner_identity(text, text, text) from public;
--> statement-breakpoint
grant execute on function iam.ensure_owner_identity(text, text, text) to "erp_app";
