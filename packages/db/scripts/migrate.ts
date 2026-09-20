/**
 * Apply migrations as `erp_owner`.
 *
 * Never as the app role, and never as a superuser: the objects must end up
 * owned by erp_owner, which is subject to FORCE RLS like everyone else (§5).
 *
 *   pnpm db:migrate
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import { databaseConfig, loadDatabaseEnv, parseUrl, requireUrl } from '../src/config.js';

const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

async function main(): Promise<void> {
  loadDatabaseEnv();
  const config = databaseConfig();
  const ownerUrl = requireUrl(config, 'DATABASE_OWNER_URL', 'pnpm db:migrate');

  const { user } = parseUrl(ownerUrl);
  if (user !== 'erp_owner') {
    throw new Error(
      `Migrations must run as erp_owner, not "${user}". ` +
        `Running them as the app role would leave every object owned by erp_app.`,
    );
  }

  // max: 1 because migrations are sequential and a pool would interleave them.
  const sql = postgres(ownerUrl, { max: 1, onnotice: () => {} });

  try {
    const superuser = await sql<{ rolsuper: boolean }[]>`
      select rolsuper from pg_roles where rolname = current_user
    `;
    if (superuser[0]?.rolsuper === true) {
      throw new Error(
        'erp_owner is a superuser in this database. A superuser bypasses FORCE ROW ' +
          'LEVEL SECURITY, so every tenant isolation policy would silently not apply ' +
          'to it. Re-create the database and run `pnpm db:bootstrap` (D-042).',
      );
    }

    const started = Date.now();
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });

    const applied = await sql<{ hash: string; created_at: string }[]>`
      select hash, created_at from drizzle.__drizzle_migrations order by created_at
    `;
    console.log(
      `db:migrate — ${applied.length} migration(s) applied in total (${Date.now() - started} ms).`,
    );
  } finally {
    await sql.end();
  }
}

await main();
