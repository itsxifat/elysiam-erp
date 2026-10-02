import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, runMigrations } from '../migrations.js';
import { applyBootstrap, type RolePasswords } from '../roles.js';

/**
 * The three roles on managed Postgres (M14b, D-341).
 *
 * A managed provider never hands out a superuser. Its admin user holds CREATEROLE and
 * CREATEDB and owns the databases it creates, and that is all. `bootstrap.sql` used to
 * assume more: it reasserted `nosuperuser … noreplication nobypassrls` on every role, and
 * PostgreSQL 16+ refuses each of those from a role that lacks the attribute itself, even
 * when nothing would change. The first `pnpm db:bootstrap` against the production
 * database would have failed.
 *
 * Its own throwaway server, always, and never `TEST_DATABASE_URL`: this suite creates the
 * roles from nothing as a non-superuser and changes a role's attributes, and a shared
 * server's roles are other suites' fixtures.
 */

const silenceNotices = (): void => undefined;

const ADMIN = { user: 'managed_admin', password: 'managed_admin_test_password' };
const DATABASE = 'elysium_managed';

let container: StartedPostgreSqlContainer;
let rootUrl: string;

function urlFor(user: string, password: string, database = DATABASE): string {
  const url = new URL(rootUrl);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

async function withConnection<T>(url: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(url, { max: 1, onnotice: silenceNotices });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

const passwords = (suffix: string): RolePasswords => ({
  owner: `owner_${suffix}`,
  app: `app_${suffix}`,
  analytics: `analytics_${suffix}`,
});

interface RoleRow {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolcanlogin: boolean;
}

const readRoles = (sql: postgres.Sql) => sql<RoleRow[]>`
  select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin
  from pg_roles
  where rolname in ('erp_owner', 'erp_app', 'erp_analytics')
  order by rolname
`;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17.11-alpine')
    .withDatabase('postgres_root')
    .withUsername('postgres')
    .withPassword('managed_root_test_password')
    .start();
  rootUrl = container.getConnectionUri();

  await withConnection(rootUrl, async (root) => {
    // What a managed provider's admin user is: no SUPERUSER, REPLICATION or BYPASSRLS.
    await root.unsafe(
      `create role ${ADMIN.user} with login password '${ADMIN.password}' createrole createdb`,
    );
    // Created by the admin, as the runbook says, so the admin owns it.
    await root.unsafe(`create database ${DATABASE} owner ${ADMIN.user}`);
  });
}, 180_000);

afterAll(async () => {
  await container.stop();
});

describe('bootstrap.sql run by a managed admin who is not a superuser', () => {
  it('creates the three roles, none of which can bypass row-level security', async () => {
    const roles = await withConnection(urlFor(ADMIN.user, ADMIN.password), async (admin) => {
      const [self] = await admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
        select rolsuper, rolbypassrls from pg_roles where rolname = current_user
      `;
      expect(self).toEqual({ rolsuper: false, rolbypassrls: false });

      await applyBootstrap(admin, passwords('first'));
      return readRoles(admin);
    });

    expect(roles.map((role) => role.rolname)).toEqual(['erp_analytics', 'erp_app', 'erp_owner']);
    for (const role of roles) {
      expect(role, role.rolname).toMatchObject({
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolcanlogin: true,
      });
    }
  });

  it('runs again, resetting the passwords, with nothing privileged to do', async () => {
    await withConnection(urlFor(ADMIN.user, ADMIN.password), (admin) =>
      applyBootstrap(admin, passwords('second')),
    );

    const who = await withConnection(urlFor('erp_app', 'app_second'), async (app) => {
      const [row] = await app<{ who: string }[]>`select current_user as who`;
      return row?.who;
    });
    expect(who).toBe('erp_app');
  });

  it('lets erp_owner apply every migration to the admin-owned database, one run at a time', async () => {
    const journal = JSON.parse(
      readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: unknown[] };

    // The release step and a person at a terminal, at once (M14b): the advisory lock makes
    // the second wait, then find nothing left to apply.
    const ownerUrl = urlFor('erp_owner', 'owner_second');
    const runs = await Promise.all([runMigrations(ownerUrl), runMigrations(ownerUrl)]);
    expect(runs.map((run) => run.total)).toEqual([journal.entries.length, journal.entries.length]);

    // And the tenancy shape survived the move: the app role still cannot create in public.
    await expect(
      withConnection(urlFor('erp_app', 'app_second'), (app) =>
        app.unsafe('create table public.loose (id int)'),
      ),
    ).rejects.toThrow(/permission denied/i);
  }, 180_000);

  it('refuses to migrate as any role but erp_owner', async () => {
    await expect(runMigrations(urlFor('erp_app', 'app_second'))).rejects.toThrow(
      /must run as erp_owner/,
    );
  });

  it('fails loudly when a role holds an attribute the admin cannot clear', async () => {
    // A role that has gained REPLICATION by some other route. The managed admin cannot take
    // it away, and must not report the roles as ready.
    await withConnection(urlFor('postgres', 'managed_root_test_password'), (root) =>
      root.unsafe('alter role erp_analytics with replication'),
    );

    await expect(
      withConnection(urlFor(ADMIN.user, ADMIN.password), (admin) =>
        applyBootstrap(admin, passwords('second')),
      ),
    ).rejects.toThrow(/permission denied to alter role/);

    // A superuser running the same script clears it, as it always did.
    const roles = await withConnection(
      urlFor('postgres', 'managed_root_test_password'),
      async (root) => {
        await applyBootstrap(root, passwords('second'));
        return readRoles(root);
      },
    );
    expect(roles.every((role) => !role.rolreplication)).toBe(true);
  });
});
