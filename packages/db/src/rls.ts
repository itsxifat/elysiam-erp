/**
 * The one place a tenant table's isolation is defined (architecture §5).
 *
 * Every tenant table gets exactly this treatment, generated rather than typed
 * by hand, because the failure mode of a hand-written policy is silent: it
 * returns rows instead of throwing, and the wrong rows look like the right
 * ones. The guard test in `tenancy.test.ts` enumerates every table in a tenant
 * schema and fails on any that did not go through here.
 *
 * ## Why `nullif`
 *
 * Architecture §5 originally specified:
 *
 *     using (org_id = current_setting('app.org_id', true)::uuid)
 *
 * and reasoned that an unset `app.org_id` yields NULL, so the policy matches
 * nothing. That holds only for a connection that has *never* set it.
 * `set_config(..., true)` is transaction-local, so once a transaction has set
 * it and committed, the setting reverts to the empty string rather than to
 * unset — and `''::uuid` raises `invalid input syntax for type uuid: ""`.
 *
 * On a pooled connection, which is every connection in production after its
 * first request, that policy therefore errors instead of returning zero rows.
 * Failing closed is better than leaking, but acceptance check 2 requires zero
 * rows, and a policy that throws during ordinary pool reuse is not a
 * foundation. `nullif(..., '')` makes both the never-set and the reset case
 * resolve to NULL (D-043).
 */

/** The expression every policy compares `org_id` against. */
export const ORG_CONTEXT_SQL = `nullif(current_setting('app.org_id', true), '')::uuid`;

export type TablePrivilege = 'select' | 'insert' | 'update' | 'delete';

/** Read/write, the default for an ordinary tenant table. */
export const READ_WRITE: readonly TablePrivilege[] = ['select', 'insert', 'update', 'delete'];

/**
 * Append-only: ledger journals, stock movements, audit rows and the outbox
 * (architecture §5, §7). `erp_app` may add and read, never change or remove.
 */
export const APPEND_ONLY: readonly TablePrivilege[] = ['select', 'insert'];

export interface TenantTableOptions {
  readonly schema: string;
  readonly table: string;
  /** What `erp_app` may do. Defaults to read/write. */
  readonly appPrivileges?: readonly TablePrivilege[];
  /**
   * Whether `erp_analytics` may read every org's rows through this table.
   * Only the analytics rollups and the super-admin consolidated reads should
   * set this (§5 cross-org exceptions 2 and 3).
   */
  readonly analyticsReadsAllOrgs?: boolean;
}

function quote(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Refusing to build SQL for identifier "${identifier}".`);
  }
  return `"${identifier}"`;
}

/**
 * The full isolation block for one tenant table: RLS on and forced, the
 * org policy, an index on `org_id`, and the minimum grants.
 *
 * FORCE is not optional. Without it the table's owner — which is `erp_owner`,
 * the role that runs migrations and seeds — is exempt from the policy.
 */
export function tenantTableSql(options: TenantTableOptions): string {
  const { schema, table, appPrivileges = READ_WRITE, analyticsReadsAllOrgs = false } = options;
  const qualified = `${quote(schema)}.${quote(table)}`;
  const policyName = quote(`${table}_org_isolation`);

  // Note: the org_id index is declared in the Drizzle schema, not here, so
  // `pnpm db:generate` can see it. Emitting it from both places produced two
  // byte-identical indexes on every tenant table, each maintained on every write.
  const statements = [
    `alter table ${qualified} enable row level security;`,
    `alter table ${qualified} force row level security;`,
    `drop policy if exists ${policyName} on ${qualified};`,
    `create policy ${policyName} on ${qualified}`,
    `  using (org_id = ${ORG_CONTEXT_SQL})`,
    `  with check (org_id = ${ORG_CONTEXT_SQL});`,
    `grant usage on schema ${quote(schema)} to "erp_app", "erp_analytics";`,
    `grant ${appPrivileges.join(', ')} on ${qualified} to "erp_app";`,
  ];

  if (analyticsReadsAllOrgs) {
    const analyticsPolicy = quote(`${table}_analytics_all_orgs`);
    statements.push(
      `grant select on ${qualified} to "erp_analytics";`,
      `drop policy if exists ${analyticsPolicy} on ${qualified};`,
      `create policy ${analyticsPolicy} on ${qualified}`,
      `  for select to "erp_analytics"`,
      `  using (true);`,
    );
  }

  return statements.join('\n');
}

/**
 * A global (non-tenant) table: reference data and the org list itself
 * (§5 cross-org exception 5).
 *
 * These get no RLS, so they are listed explicitly in `GLOBAL_TABLES` and the
 * guard test treats anything else in a tenant schema as a mistake. Adding to
 * that list is a decision, not a convenience.
 */
export interface GlobalTableOptions {
  readonly readOnly?: boolean;
  /**
   * Whether `erp_analytics` may read this table.
   *
   * Defaults to **false**, like `analyticsReadsAllOrgs` on tenant tables and for
   * the same reason (D-049): analytics reads are opt-in per table. This used to
   * be unconditional, which quietly granted the analytics role SELECT on
   * `iam.accounts` — password hashes — and `iam.two_factors` — TOTP secrets and
   * backup codes. Nothing needed either, and a read-only role is still a role
   * that can read.
   */
  readonly analyticsReads?: boolean;
}

export function globalTableSql(
  schema: string,
  table: string,
  options: GlobalTableOptions = {},
): string {
  const { readOnly = true, analyticsReads = false } = options;
  const qualified = `${quote(schema)}.${quote(table)}`;
  const readers = analyticsReads ? '"erp_app", "erp_analytics"' : '"erp_app"';

  return [
    `grant usage on schema ${quote(schema)} to "erp_app", "erp_analytics";`,
    `grant select on ${qualified} to ${readers};`,
    ...(readOnly ? [] : [`grant insert, update, delete on ${qualified} to "erp_app";`]),
  ].join('\n');
}

/**
 * Every table `erp_analytics` is allowed to read, qualified.
 *
 * The guard test fails on anything it can SELECT that is not listed here, so
 * adding a global table does not silently widen the analytics role. Entries are
 * deliberate and each one is a decision: `org.organizations` is the brand list
 * every consolidated report labels its rows with, and the `ref` schema is public
 * Bangladesh geography. Nothing in `iam` is here — identity is not analytics
 * data, and the credential tables least of all.
 */
export const ANALYTICS_READABLE: readonly string[] = ['org.organizations'];

/** Schemas `erp_analytics` may read wholesale. Reference data only. */
export const ANALYTICS_READABLE_SCHEMAS: readonly string[] = ['ref'];

/**
 * Schemas that are globally readable, and the handful of individual tables
 * inside them that are legitimately global.
 *
 * The guard test reads both. Keep the exception list short: every entry is a
 * table that one org can see another org's rows in, by design.
 */
export const GLOBAL_SCHEMAS: readonly string[] = ['ref', 'drizzle'];

export const GLOBAL_TABLES: readonly string[] = [
  // The org list itself. Which orgs a user may see is a membership question,
  // answered by iam.memberships, not a row-level one (§5 exception 5).
  'org.organizations',

  // Identity (§5 exception 4, D-050). A person is not an org's property: one
  // user works for three of the five brands with a different role in each, so
  // an org_id on these tables would make that impossible to express.
  //
  // Access to them is by identity, not by row: a session belongs to exactly
  // one user, and iam.memberships — which IS tenant-scoped — is what decides
  // which orgs that user may enter.
  'iam.users',
  'iam.sessions',
  'iam.accounts',
  'iam.verifications',
  'iam.two_factors',
];

/**
 * The self-access policy for `iam.memberships` (D-050).
 *
 * Tenant tables answer "what is in this org". Memberships must also answer
 * "which orgs may I enter", which is asked before an org is chosen and so
 * cannot be scoped by `app.org_id`. PostgreSQL ORs permissive policies, so
 * this sits alongside the standard org policy: a user sees their own
 * memberships anywhere, plus everyone's memberships in the org they are
 * currently acting in.
 *
 * Scoped to `app.user_id` exactly. Widen it and it becomes "any authenticated
 * user reads every membership in every org".
 */
export const USER_CONTEXT_SQL = `nullif(current_setting('app.user_id', true), '')`;
