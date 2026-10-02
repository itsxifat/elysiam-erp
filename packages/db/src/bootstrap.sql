-- Create the three database roles (architecture §5, D-042).
--
-- This is the only step that needs an administrator, and it runs once per
-- database. Everything after it runs as erp_owner. The administrator need not be
-- a superuser: CREATEROLE and ownership of the database are enough, which is what
-- managed Postgres gives you (D-341, docs/runbooks/deploy.md).
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
    --
    -- One attribute at a time, and only when the role actually has it (D-341).
    -- Managed Postgres has no superuser, and PostgreSQL 16+ refuses
    -- `nosuperuser`, `noreplication` and `nobypassrls` from anyone who lacks
    -- that attribute themselves, even when the statement would change nothing
    -- (verified on 17.11). A clean role therefore needs no privileged ALTER, and
    -- a role that has gained one still gets it cleared here, or the run fails
    -- loudly because the admin cannot clear it, which is the right outcome too.
    if (select rolsuper from pg_roles where rolname = role_name) then
      execute format('alter role %I with nosuperuser', role_name);
    end if;
    if (select rolcreatedb from pg_roles where rolname = role_name) then
      execute format('alter role %I with nocreatedb', role_name);
    end if;
    if (select rolcreaterole from pg_roles where rolname = role_name) then
      execute format('alter role %I with nocreaterole', role_name);
    end if;
    if (select rolreplication from pg_roles where rolname = role_name) then
      execute format('alter role %I with noreplication', role_name);
    end if;
    if (select rolbypassrls from pg_roles where rolname = role_name) then
      execute format('alter role %I with nobypassrls', role_name);
    end if;
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
