import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

import { databaseConfig, loadDatabaseEnv, requireUrl, type DatabaseConfig } from './config.js';
import * as schema from './schema/index.js';

/**
 * Postgres notices are dropped: they can echo row values, and for this
 * product that means phone numbers reaching the logs (§25).
 */
const silenceNotices = (): void => undefined;

/**
 * The three ways into the database (architecture §5).
 *
 * `withOrg` is the only one application code should reach for. The other two
 * exist because analytics genuinely needs to read across orgs and migrations
 * genuinely need to own objects — both narrow enough that the wrong one is
 * obvious in review.
 */

export type Database = PostgresJsDatabase<typeof schema>;

/**
 * A transaction, as Drizzle hands it to a callback.
 *
 * Derived from `Database['transaction']` rather than imported from Drizzle's
 * internals, so a Drizzle upgrade that reshapes those types is a compile error
 * here instead of a silent `any` everywhere.
 */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface OrgContext {
  /** The active organization. Every row this transaction touches belongs to it. */
  readonly orgId: string;
  /** Who is acting, for the audit interceptor (M02b). */
  readonly userId?: string | undefined;
  /** Correlates database work with the request in the logs (§26). */
  readonly requestId?: string | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PoolKind = 'app' | 'analytics' | 'owner';

const drivers = new Map<PoolKind, Sql>();
const databases = new Map<PoolKind, Database>();
let config: DatabaseConfig | undefined;

function resolvedConfig(): DatabaseConfig {
  if (config === undefined) {
    loadDatabaseEnv();
    config = databaseConfig();
  }
  return config;
}

function urlFor(kind: PoolKind): string {
  const settings = resolvedConfig();
  switch (kind) {
    case 'app':
      return settings.DATABASE_URL;
    case 'analytics':
      return requireUrl(settings, 'DATABASE_ANALYTICS_URL', 'withAnalytics()');
    case 'owner':
      return requireUrl(settings, 'DATABASE_OWNER_URL', 'withSystem()');
  }
}

function database(kind: PoolKind): Database {
  const existing = databases.get(kind);
  if (existing !== undefined) return existing;

  const driver = postgres(urlFor(kind), {
    max: kind === 'app' ? 10 : 2,
    idle_timeout: 30,
    // The driver's default notice handler is chatty, and notices can echo row
    // values — which for this product means phone numbers (§25).
    onnotice: silenceNotices,
  });

  const db = drizzle(driver, { schema });
  drivers.set(kind, driver);
  databases.set(kind, db);
  return db;
}

async function applyContext(tx: Tx, context: OrgContext): Promise<void> {
  // Transaction-local (`set_config(..., true)`), so the setting cannot leak to
  // the next borrower of a pooled connection. It reverts to the empty string
  // rather than to unset, which is precisely why the RLS policy wraps it in
  // `nullif` (D-043).
  // One statement, as architecture §5 specifies. Three round trips would have
  // been three network hops on every tenant request, against the §29 budgets.
  await tx.execute(sql`
    select
      set_config('app.org_id', ${context.orgId}, true),
      set_config('app.user_id', ${context.userId ?? ''}, true),
      set_config('app.request_id', ${context.requestId ?? ''}, true)
  `);
}

function assertUuid(value: string, caller: string): void {
  if (!UUID.test(value)) {
    throw new Error(`${caller} needs a uuid org id, received "${value}".`);
  }
}

/**
 * Run `fn` inside a transaction scoped to one organization.
 *
 * Every tenant query goes through here. A malformed `orgId` is rejected up
 * front rather than inside the policy, where it would surface as an opaque
 * cast error from deep inside somebody else's query.
 */
export async function withOrg<T>(context: OrgContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  assertUuid(context.orgId, 'withOrg()');

  return database('app').transaction(async (tx) => {
    await applyContext(tx, context);
    return fn(tx);
  });
}

/**
 * Run `fn` as the application role, identified but not yet in an org.
 *
 * This is the narrow window between signing in and choosing an org: the user
 * is known, `app.org_id` is not set, and the only thing they may read is their
 * own memberships, through the self policy on `iam.memberships` (D-050).
 *
 * `app.org_id` is cleared explicitly rather than left alone. On a pooled
 * connection the previous borrower's value has reverted to the empty string,
 * which the policy already treats as no org — but relying on that would make
 * this correct by accident.
 */
export async function withUser<T>(
  context: { readonly userId: string; readonly requestId?: string | undefined },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (context.userId === '') throw new Error('withUser() needs a user id.');

  return database('app').transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.org_id', '', true),
        set_config('app.user_id', ${context.userId}, true),
        set_config('app.request_id', ${context.requestId ?? ''}, true)
    `);
    return fn(tx);
  });
}

/**
 * Read across every org, through the read-only analytics role.
 *
 * Only the analytics module and super-admin consolidated reads (§5 exceptions
 * 2 and 3). The role holds no write grant anywhere, so a mistake here fails
 * rather than corrupts, and the transaction is marked read-only on top of that.
 */
export async function withAnalytics<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return database('analytics').transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    return fn(tx);
  });
}

/**
 * Owner access, for migrations and seeds only.
 *
 * `erp_owner` is NOT exempt from RLS — FORCE sees to that — so seeding tenant
 * rows still has to say which org it is acting for. That is deliberate: the
 * seed exercises the same policies as the application, so a broken policy
 * breaks the seed loudly instead of hiding until production.
 */
export async function withSystem<T>(
  fn: (tx: Tx) => Promise<T>,
  context?: { readonly orgId?: string },
): Promise<T> {
  return database('owner').transaction(async (tx) => {
    if (context?.orgId === undefined) {
      // Cleared explicitly rather than relied upon to be absent, so a value
      // arriving through a connection-string `options=-c app.org_id=...`
      // cannot grant an uncontexted transaction someone else's rows.
      await tx.execute(sql`select set_config('app.org_id', '', true)`);
    } else {
      assertUuid(context.orgId, 'withSystem()');
      await tx.execute(sql`select set_config('app.org_id', ${context.orgId}, true)`);
    }
    return fn(tx);
  });
}

/**
 * The configuration the pools are actually using.
 *
 * Anything that opens its own connection — Better Auth does, because it owns
 * its session mechanics — must read this rather than the environment, or it
 * will quietly talk to a different database than the rest of the application
 * whenever `configureDatabase()` has repointed things. Which is every test run.
 */
export function currentDatabaseConfig(): DatabaseConfig {
  return resolvedConfig();
}

/** Close every pool. Call on shutdown, and at the end of a test run. */
export async function closeDatabase(): Promise<void> {
  const open = [...drivers.entries()];
  drivers.clear();
  databases.clear();
  config = undefined;
  await Promise.all(open.map(async ([, driver]) => driver.end({ timeout: 5 })));
}

/** Point the pools at a different database. Used by the test harness. */
export function configureDatabase(overrides: DatabaseConfig): void {
  config = overrides;
  drivers.clear();
  databases.clear();
}
