import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import { closeDatabase, configureDatabase, withSystem } from '../client.js';
import { seedOrganizations } from '../seed/index.js';

/**
 * A real PostgreSQL to test against.
 *
 * Row-level security is a database behaviour. A mock cannot have it, so these
 * tests would prove nothing without a real server (architecture §27).
 *
 * Two ways to get one (D-044):
 *
 * - `TEST_DATABASE_URL` set — use that server. This is the fast local loop
 *   against the compose stack, and it is also how CI service containers work.
 * - Otherwise — start a throwaway Testcontainer.
 *
 * Either way the harness creates its own database inside that server, so a
 * test run never touches development data.
 */

const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

const ROLE_PASSWORDS = {
  erp_owner: 'test_owner_password',
  erp_app: 'test_app_password',
  erp_analytics: 'test_analytics_password',
} as const;

export interface TestDatabase {
  readonly adminUrl: string;
  readonly ownerUrl: string;
  readonly appUrl: string;
  readonly analyticsUrl: string;
  readonly databaseName: string;
  stop(): Promise<void>;
}

let container: StartedPostgreSqlContainer | undefined;

function withDatabase(url: string, databaseName: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = encodeURIComponent(user);
  parsed.password = encodeURIComponent(password);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

async function adminConnectionUrl(): Promise<string> {
  const provided = process.env.TEST_DATABASE_URL;
  if (provided !== undefined && provided !== '') return provided;

  container = await new PostgreSqlContainer('postgres:17.11-alpine')
    .withDatabase('elysium_harness')
    .withUsername('postgres')
    .withPassword('postgres_test_password')
    .start();

  return container.getConnectionUri();
}

/**
 * Create a fresh database, its roles, its schema and its seed.
 *
 * The roles are created once per server and reused; the database is per run,
 * so parallel suites cannot see each other's rows.
 */
export async function startTestDatabase(label = 'test'): Promise<TestDatabase> {
  const adminUrl = await adminConnectionUrl();
  const databaseName = `elysium_${label}_${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;

  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });

  try {
    for (const [role, password] of Object.entries(ROLE_PASSWORDS)) {
      await admin.unsafe(`
        do $$
        begin
          if exists (select 1 from pg_roles where rolname = '${role}') then
            alter role "${role}" with login password '${password}';
          else
            create role "${role}" with login password '${password}';
          end if;
          alter role "${role}" with nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
        end $$;
      `);
    }

    await admin.unsafe(`create database "${databaseName}" owner "erp_owner"`);
    await admin.unsafe(`grant connect on database "${databaseName}" to "erp_app", "erp_analytics"`);
  } finally {
    await admin.end();
  }

  const ownerUrl = withDatabase(adminUrl, databaseName, 'erp_owner', ROLE_PASSWORDS.erp_owner);
  const appUrl = withDatabase(adminUrl, databaseName, 'erp_app', ROLE_PASSWORDS.erp_app);
  const analyticsUrl = withDatabase(
    adminUrl,
    databaseName,
    'erp_analytics',
    ROLE_PASSWORDS.erp_analytics,
  );

  const owner = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
    // The property the whole milestone rests on. Asserted in the harness so a
    // misconfigured server fails here, loudly, instead of quietly turning every
    // isolation test into a test of nothing.
    const [role] = await owner<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = current_user
    `;
    if (role?.rolsuper === true || role?.rolbypassrls === true) {
      throw new Error(
        'erp_owner can bypass row-level security in the test server. Every isolation ' +
          'assertion below would pass without proving anything (D-042).',
      );
    }

    await migrate(drizzle(owner), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await owner.end();
  }

  configureDatabase({
    DATABASE_URL: appUrl,
    DATABASE_OWNER_URL: ownerUrl,
    DATABASE_ANALYTICS_URL: analyticsUrl,
    DATABASE_ADMIN_URL: adminUrl,
  });

  await seedOrganizations();

  return {
    adminUrl,
    ownerUrl,
    appUrl,
    analyticsUrl,
    databaseName,
    async stop() {
      await closeDatabase();

      const cleanup = postgres(adminUrl, { max: 1, onnotice: () => {} });
      try {
        await cleanup.unsafe(`drop database if exists "${databaseName}" with (force)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

/** Stop a Testcontainer, if this run started one. */
export async function stopSharedContainer(): Promise<void> {
  if (container !== undefined) {
    await container.stop();
    container = undefined;
  }
}

/**
 * Empty every tenant table and re-seed, for a test that needs a known state.
 *
 * Truncate rather than a transaction rollback: several of these tests open
 * their own transactions and assert on what a *different* connection can see,
 * which a wrapping transaction would hide.
 */
export async function resetTenantData(): Promise<void> {
  await withSystem(async (tx) => {
    await tx.execute(
      sql`truncate org.feature_flags, org.settings, org.locations, org.branches restart identity cascade`,
    );
  });
  await seedOrganizations();
}
