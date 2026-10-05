-- M31 (D-476), after the review of 0104: the application role must not be able to make an
-- owner on its own.
--
-- 0104 let `erp_app` insert into `iam.owner_link_uses` and then call
-- `iam.ensure_owner_identity`, whose only gate was "this `jti` was spent in the last five
-- minutes" — a gate `erp_app` could satisfy by inserting the `jti` itself, and so mint a
-- super admin, which 0015 says nobody but the owner role does. Now one owner-role function,
-- `iam.accept_owner_link`, spends the `jti` (refusing one already spent), forgets uses more
-- than a day old, and finds or makes the owner, in one statement; `erp_app` holds no right
-- on `iam.owner_link_uses` at all.
--
-- What the database cannot do is check the link's Ed25519 signature: that is the route's
-- (`owner-link.service.ts`), before it calls this. A role that can run arbitrary SQL as
-- `erp_app` can still call this function with a `jti` of its choosing; that is the same
-- reach it already has over sessions, and out of this function's scope. What it can no
-- longer do is skip the single-use record, take over an account that is not an owner's, or
-- mark a session as an owner link for anyone but an owner (the trigger below).
revoke all on "iam"."owner_link_uses" from "erp_app";
--> statement-breakpoint
drop function if exists iam.ensure_owner_identity(text, text, text);
--> statement-breakpoint
create or replace function iam.accept_owner_link(p_jti text, p_email text, p_name text)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, iam, pg_temp
as $$
declare
  v_user iam.users%rowtype;
  v_spent text;
begin
  if p_jti is null or p_jti !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'OWNER_LINK_INVALID: a link is named by a lower-case UUID'
      using errcode = 'check_violation';
  end if;
  if p_email is null or p_email <> lower(p_email) or position('@' in p_email) < 2
     or p_name is null or length(btrim(p_name)) = 0 or length(p_name) > 200 then
    raise exception 'OWNER_IDENTITY_INVALID: an owner needs an email and a name'
      using errcode = 'check_violation';
  end if;

  insert into iam.owner_link_uses (jti) values (p_jti)
  on conflict (jti) do nothing
  returning jti into v_spent;
  if v_spent is null then
    raise exception 'OWNER_LINK_REPLAYED: that link was used already'
      using errcode = 'unique_violation';
  end if;
  -- A link lives two minutes; a day is far past any use of one still in flight.
  delete from iam.owner_link_uses where used_at < now() - interval '1 day';

  select * into v_user from iam.users where lower(email) = p_email for update;
  if not found then
    insert into iam.users (id, email, name, email_verified, is_super_admin, is_owner)
    values ('usr_' || gen_random_uuid()::text, p_email, p_name, true, true, true)
    on conflict (email) do nothing;
    select * into v_user from iam.users where lower(email) = p_email for update;
    if not found then
      raise exception 'OWNER_IDENTITY_CONFLICT: that address could not be claimed'
        using errcode = 'unique_violation';
    end if;
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
revoke all on function iam.accept_owner_link(text, text, text) from public;
--> statement-breakpoint
grant execute on function iam.accept_owner_link(text, text, text) to "erp_app";
--> statement-breakpoint
-- The enrolment wall lets an owner-link session through, so the flag is held as tightly as
-- `is_owner`: only an owner's session may carry it, and it never changes once the session
-- exists.
create or replace function iam.guard_owner_link_session()
returns trigger
language plpgsql
set search_path = pg_catalog, iam, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.owner_link is distinct from old.owner_link then
    raise exception 'OWNER_LINK_FIXED: a session is an owner link from the start or never'
      using errcode = 'integrity_constraint_violation';
  end if;
  if new.owner_link and not exists (
    select 1 from iam.users u where u.id = new.user_id and u.is_owner
  ) then
    raise exception 'OWNER_LINK_NOT_OWNER: only an owner holds an owner-link session'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
drop trigger if exists sessions_owner_link_guard on "iam"."sessions";
--> statement-breakpoint
create trigger sessions_owner_link_guard
  before insert or update on "iam"."sessions"
  for each row execute function iam.guard_owner_link_session();
