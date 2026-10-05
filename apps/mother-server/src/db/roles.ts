import type postgres from 'postgres';

/**
 * The mother's two roles (D-480): `mother_owner` owns every object and runs migrations;
 * `mother_app` is what the API and the worker connect as.
 *
 * Neither is a superuser or may bypass row-level security, the same rule the brand's
 * bootstrap holds its roles to (D-042): the mother has no RLS today, but a role that can
 * do anything is a role nobody can reason about. Run once per database by
 * `pnpm mother:db-bootstrap` as an administrator with CREATEROLE; idempotent, and it resets
 * the passwords to the ones in the configured URLs. Passwords travel as transaction-local
 * settings, never interpolated into SQL text or a log (invariant 10).
 */
const BOOTSTRAP_SQL = `
do $$
declare
  role_name text;
  role_password text;
begin
  foreach role_name in array array['mother_owner', 'mother_app'] loop
    role_password := current_setting('bootstrap.' || role_name || '_password', true);
    if role_password is null or role_password = '' then
      raise exception 'bootstrap: no password supplied for %', role_name;
    end if;
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('alter role %I with login password %L', role_name, role_password);
    else
      execute format('create role %I with login password %L', role_name, role_password);
    end if;
    if (select rolsuper from pg_roles where rolname = role_name) then
      execute format('alter role %I with nosuperuser', role_name);
    end if;
    if (select rolcreatedb from pg_roles where rolname = role_name) then
      execute format('alter role %I with nocreatedb', role_name);
    end if;
    if (select rolcreaterole from pg_roles where rolname = role_name) then
      execute format('alter role %I with nocreaterole', role_name);
    end if;
    if (select rolbypassrls from pg_roles where rolname = role_name) then
      execute format('alter role %I with nobypassrls', role_name);
    end if;
  end loop;
end $$;

do $$
begin
  execute format('grant connect, create on database %I to mother_owner', current_database());
  execute format('grant connect on database %I to mother_app', current_database());
  execute format('revoke all on database %I from public', current_database());
end $$;

revoke create on schema public from public;
`;

export interface MotherRolePasswords {
  readonly owner: string;
  readonly app: string;
}

/** Create or reset both roles on the database `admin` is connected to. */
export async function applyMotherBootstrap(
  admin: postgres.Sql,
  passwords: MotherRolePasswords,
): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`select set_config('bootstrap.mother_owner_password', ${passwords.owner}, true)`;
    await tx`select set_config('bootstrap.mother_app_password', ${passwords.app}, true)`;
    await tx.unsafe(BOOTSTRAP_SQL);
  });
}

export function passwordOf(url: string): string {
  return decodeURIComponent(new URL(url).password);
}

export function userOf(url: string): string {
  return decodeURIComponent(new URL(url).username);
}
