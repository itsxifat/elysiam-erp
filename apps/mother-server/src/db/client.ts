import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

import * as schema from './schema.js';

/**
 * The mother's connections to its own database, as `mother_app` (D-480).
 *
 * Two pools, on purpose. The mother's own queries are plain parameterised SQL through
 * postgres.js's tagged templates (every value a bind parameter). Better Auth reaches the
 * same database through Drizzle's adapter, and Drizzle rewires the client it is given —
 * it replaces the date and JSON parsers and serializers with pass-throughs, because it
 * maps those itself. Shared, that turned every `Date` parameter of a raw query into an
 * error and every timestamp read back into a string. So Drizzle gets a client of its own.
 */

export type MotherDatabase = PostgresJsDatabase<typeof schema>;

/** Postgres notices can echo row values; they never reach a log (invariant 10). */
const silence = (): void => undefined;

interface Pools {
  readonly url: string;
  readonly sql: Sql;
  readonly drizzleSql: Sql;
  readonly db: MotherDatabase;
}

let pools: Pools | undefined;
let configuredUrl: string | undefined;

/** Point the pools somewhere (a test's throwaway database, or the configured one). */
export function configureMotherDatabase(url: string): void {
  configuredUrl = url;
}

function current(): Pools {
  if (configuredUrl === undefined) {
    throw new Error('The mother database is not configured; call configureMotherDatabase().');
  }
  if (pools?.url !== configuredUrl) {
    const sql = postgres(configuredUrl, {
      max: 10,
      idle_timeout: 30,
      onnotice: silence,
      connection: { application_name: 'mother-app' },
    });
    const drizzleSql = postgres(configuredUrl, {
      max: 5,
      idle_timeout: 30,
      onnotice: silence,
      connection: { application_name: 'mother-auth' },
    });
    pools = { url: configuredUrl, sql, drizzleSql, db: drizzle(drizzleSql, { schema }) };
  }
  return pools;
}

/** The raw driver: `await motherSql()\`select …\``. */
export function motherSql(): Sql {
  return current().sql;
}

/** Drizzle over its own client, for Better Auth's adapter only. */
export function motherDb(): MotherDatabase {
  return current().db;
}

export async function closeMotherDatabase(): Promise<void> {
  const open = pools;
  pools = undefined;
  if (open !== undefined) {
    await Promise.all([open.sql.end({ timeout: 5 }), open.drizzleSql.end({ timeout: 5 })]);
  }
}

/** A transaction on the mother's pool. */
export async function inMother<T>(work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await motherSql().begin(work)) as T;
}
