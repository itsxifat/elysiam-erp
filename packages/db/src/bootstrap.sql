-- Create the three database roles (architecture §5, D-042).
--
-- This is the only step that needs a superuser, and it runs once per database.
-- Everything after it runs as erp_owner.
--
-- The critical property: erp_owner is NOSUPERUSER and NOBYPASSRLS. A superuser
-- bypasses FORCE ROW LEVEL SECURITY entirely, which would make every tenant
-- isolation policy in §5 a no-op for the role that owns the tables — silently,
-- and only in whichever environment happened to make it a superuser.
--
-- Passwords arrive as `bootstrap.*_password` settings rather than being
-- interpolated into this file, so they never appear in the repository or in a
-- query log. `format('%L')` quotes them safely for the DDL that needs them.

do $$
declare
  role_name text;
  role_password text;
begin
  foreach role_name in array array['erp_owner', 'erp_app', 'erp_analytics'] loop
    -- Two-argument form: the single-argument one raises 42704 when the
    -- setting is absent, which made the friendly message below unreachable.
    role_password := current_setting(
      'bootstrap.' || replace(role_name, 'erp_', '') || '_password', true);

    if role_password is null or role_password = '' then
      raise exception 'bootstrap: no password supplied for %', role_name;
    end if;

    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('alter role %I with login password %L', role_name, role_password);
      raise notice 'bootstrap: role % already existed, password reset', role_name;
    else
      execute format('create role %I with login password %L', role_name, role_password);
      raise notice 'bootstrap: role % created', role_name;
    end if;

    -- Reasserted on every run: a role that acquires one of these later, by any
    -- route, is a tenant-isolation hole. Cheap to reapply, expensive to miss.
    execute format(
      'alter role %I with nosuperuser nocreatedb nocreaterole noreplication nobypassrls',
      role_name
    );
  end loop;
end $$;

-- Schema creation rights, without handing over ownership of the database
-- itself. `:"db_name"` style psql variables are avoided deliberately: this file
-- is executed by the driver, not by psql, so everything resolves at runtime.
do $$
begin
  execute format('grant connect, create on database %I to erp_owner', current_database());
  execute format('grant connect on database %I to erp_app, erp_analytics', current_database());
  execute format('revoke all on database %I from public', current_database());
end $$;

-- Nobody creates objects in `public`. Every table lives in a module schema
-- (architecture §3), and an unowned public schema is where a stray table ends
-- up with no RLS on it.
revoke create on schema public from public;

-- The app roles get schema usage and per-table privileges from the migrations,
-- through the tenantTable() helper. Nothing is granted wholesale here, because
-- a wholesale grant is what later lets a new table ship without its policy.
