import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import { userOf } from './roles.js';

/** `apps/mother-server/migrations`, from `src` under vitest and from `dist` in the image. */
export const MOTHER_MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

const LOCK_KEY = 720_480_001;

/**
 * Apply the mother's migrations as `mother_owner`, one run at a time (D-480).
 *
 * Refused for any other role, and for an owner that could bypass row-level security, the
 * same two rules the brand's release step keeps (D-042).
 */
export async function migrateMother(ownerUrl: string): Promise<{ total: number }> {
  if (userOf(ownerUrl) !== 'mother_owner') {
    throw new Error(`Mother migrations run as mother_owner, not "${userOf(ownerUrl)}".`);
  }
  const sql = postgres(ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    const [role] = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = current_user
    `;
    if (role?.rolsuper === true || role?.rolbypassrls === true) {
      throw new Error('mother_owner can bypass row-level security here; fix the role first.');
    }
    await sql`select pg_advisory_lock(${LOCK_KEY})`;
    try {
      await migrate(drizzle(sql), { migrationsFolder: MOTHER_MIGRATIONS_FOLDER });
    } finally {
      await sql`select pg_advisory_unlock(${LOCK_KEY})`;
    }
    const [row] = await sql<{ total: number }[]>`
      select count(*)::int as total from drizzle.__drizzle_migrations
    `;
    return { total: row?.total ?? 0 };
  } finally {
    await sql.end();
  }
}
