import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import { parseUrl } from './config.js';

/** `packages/db/migrations`, from `src` under tsx and from `dist` in the image (D-340). */
export const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

/**
 * One migration run at a time, per database.
 *
 * The release step runs from a deploy hook (M14b), and a person can run `pnpm db:migrate`
 * by hand; two runs at once would both try to apply the same file. The second waits here
 * and then finds nothing left to do. Session-level, on the one connection the run uses.
 */
const MIGRATION_LOCK_KEY = 720_240_002;

/**
 * Postgres notices are dropped: they can echo row values, and for this
 * product that means phone numbers reaching the logs (§25).
 */
const silenceNotices = (): void => undefined;

export interface MigrationResult {
  /** Migrations recorded as applied, in total, after this run. */
  readonly total: number;
  readonly milliseconds: number;
}

/**
 * Apply every pending migration as `erp_owner` (§5, §28, invariant 9).
 *
 * Never as the app role, and never as a role that can bypass row-level security: the
 * objects must end up owned by erp_owner, which is subject to FORCE RLS like everyone else.
 */
export async function runMigrations(ownerUrl: string): Promise<MigrationResult> {
  const { user } = parseUrl(ownerUrl);
  if (user !== 'erp_owner') {
    throw new Error(
      `Migrations must run as erp_owner, not "${user}". ` +
        `Running them as the app role would leave every object owned by erp_app.`,
    );
  }

  // max: 1 because migrations are sequential, and the advisory lock is the session's.
  const sql = postgres(ownerUrl, { max: 1, onnotice: silenceNotices });

  try {
    const [attributes] = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = current_user
    `;
    // Both, not just rolsuper. On managed Postgres — RDS, Cloud SQL, Neon —
    // you cannot create a true superuser, and BYPASSRLS is exactly the
    // attribute a DBA grants instead when a migration looks blocked. An owner
    // with NOSUPERUSER BYPASSRLS would pass a rolsuper-only check and then
    // apply migrations to a database where FORCE RLS does not bind it.
    if (attributes?.rolsuper === true || attributes?.rolbypassrls === true) {
      throw new Error(
        'erp_owner can bypass row-level security in this database ' +
          `(rolsuper=${String(attributes.rolsuper)}, rolbypassrls=${String(attributes.rolbypassrls)}). ` +
          'Every tenant isolation policy would silently not apply to it. ' +
          'Fix the role and re-run `pnpm db:bootstrap` (D-042).',
      );
    }

    const started = Date.now();
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }

    const [row] = await sql<{ total: number }[]>`
      select count(*)::int as total from drizzle.__drizzle_migrations
    `;
    return { total: row?.total ?? 0, milliseconds: Date.now() - started };
  } finally {
    await sql.end();
  }
}
