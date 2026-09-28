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
export const ANALYTICS_READABLE: readonly string[] = [
  'org.organizations',
  /*
   * §5 exception 3, added by M08: the Super Admin consolidated wallet total and
   * consolidated P&L. Balances are derived, so the three tables the derivation
   * needs are opened and nothing else — `accounts` for the subtype and class,
   * `journal_lines` for the amounts, `journals` for the business date.
   *
   * SELECT only, through the `erp_analytics` pool, which holds no write
   * privilege on anything. That is the point of routing the consolidated read
   * through a role rather than looping `withOrg()` per org: cross-org code that
   * tries to write gets a permission error instead of a code review (migration
   * 0030).
   */
  'ledger.accounts',
  'ledger.journals',
  'ledger.journal_lines',
];

/**
 * Tables `erp_app` must never be able to UPDATE or DELETE.
 *
 * The grant is the control, and the guard enumerates it the way it already
 * enumerates analytics reads (D-049, D-060). `findPrivilegeProblems` only
 * checked "analytics must not write" and "erp_app must not TRUNCATE", so an
 * append-only table declared with READ_WRITE by mistake would have shipped
 * green — and M03's journals and M07's stock movements are both append-only by
 * invariant 2 and 3.
 */
export const APPEND_ONLY_TABLES: readonly string[] = [
  'audit.audit_log',
  // Invariant 2: journals never change after posting (M03).
  'ledger.journals',
  'ledger.journal_lines',
  /*
   * M08. A transfer between two wallets is a record of money that moved, and
   * the journal behind it cannot change (invariant 2). A transfer row that
   * could be edited afterwards would let the paperwork and the ledger describe
   * different events, with no way to tell which is right. Correcting one means
   * reversing its journal and posting a new transfer.
   */
  'wallets.transfers',
  /*
   * M07's inventory log (invariant 3). `stock_movements` is the record of how
   * every unit got where it is, and every level, valuation and reconciliation is
   * derived from it — so a movement that could be edited would correct all three
   * at once and report itself as healthy. The line tables beside it are the
   * evidence for what was written off and what went in the van; the
   * reconciliation log has to keep "no drift found" distinguishable from "the job
   * stopped running", which only a row nobody can delete does.
   */
  'inventory.stock_movements',
  'inventory.adjustment_lines',
  'inventory.stock_transfer_lines',
  'inventory.reconciliations',
  /*
   * M10's order history (§9). `order_events` is the order's own record of how it reached
   * the status it is in, and it is what a courier dispute, a return-rate argument and
   * §10's trust score are all read back from. Migration 0041 refuses an UPDATE or a
   * DELETE with a trigger as well, so `erp_owner` is held to the same rule as `erp_app` —
   * the grants alone would have exempted the role that owns the table.
   */
  'sales.order_events',
  /*
   * M13. An override is the record that somebody with the authority decided to sell
   * to a buyer the system refused (check 5), and `order_phones` is what the outbox
   * subscriber trusts when it moves a counter four other brands can see — rewriting
   * either would redirect one person's history onto another's number, with no way
   * afterwards to tell which was right. Migration 0047 has the triggers as well, so
   * `erp_owner` is held to the same rule as `erp_app`.
   */
  'fraud.overrides',
  'fraud.order_phones',
  /*
   * M25's investor money (§15). A contribution exists because capital arrived and a
   * journal recorded it, and a distribution line is one investor's share of a total
   * a checker approved — neither can be corrected in place, because the journal
   * behind it cannot (invariant 2). The line is the one worth naming: editing an
   * amount after the fact would break the equality the split rests on, with nothing
   * left to notice it. Migration 0060 refuses the DELETE with a trigger too, so
   * `erp_owner` is held to the same rule as `erp_app`.
   */
  'investors.investments',
  'investors.distribution_lines',
  /*
   * M19's payslips (§12). A payroll line and its component rows are the numbers a
   * checker approved and the numbers §7's journal was built from — the same rows, not a
   * copy — so editing one afterwards would leave the approval, the payslip in the
   * employee's hand and the ledger describing one month three different ways, with a
   * balanced journal and nothing to notice. `payroll_loan_deductions` is the join that
   * says which instalment a payslip paid, and it is what a reversal would have to read.
   * The fix for a wrong run is a reversing journal and a new run. Migration 0055 refuses
   * the UPDATE and the DELETE with a trigger as well, so `erp_owner` is held to the same
   * rule as `erp_app`.
   */
  'hr.payroll_lines',
  'hr.payroll_line_components',
  'hr.payroll_loan_deductions',
];

/**
 * Tables `erp_app` may update but never delete from, enumerated for the same
 * reason. A maker-checker record is evidence (0009); deleting a closed
 * period's row would reopen it without an approval; deleting an account would
 * orphan the lines posted to it.
 */
export const NO_DELETE_TABLES: readonly string[] = [
  'approvals.approval_requests',
  'ledger.accounts',
  'ledger.periods',
  /*
   * M10's orders and buyers (§9). 0040 grants UPDATE and no DELETE and says so in its
   * header comment — but the guard only checks the tables it is given, so until they were
   * listed here a later `grant delete on sales.orders` would have shipped green. An order
   * is the thing a journal, a dispatch movement and a courier consignment all point at:
   * deleting one leaves three schemas referring to a row that never existed. `order_lines`
   * is deliberately **absent** — 0044 grants DELETE for a pre-dispatch edit, bounded by
   * 0041's trigger.
   */
  'sales.orders',
  'sales.customers',
  'sales.customer_addresses',
  'sales.order_counters',
  /*
   * The outbox is append-then-mark (§19). The dispatcher needs UPDATE to stamp
   * `dispatched_at`, bump `attempts` and record `last_error`; it must never be
   * able to remove a row. Deleting on dispatch would make "did this event ever
   * fire" unanswerable, and that is the question asked exactly when something
   * has gone wrong.
   */
  'events.outbox',
  /*
   * M08's wallets. A wallet is deactivated, never deleted: deleting one would
   * orphan every entry, transfer and closing that names it, and a wallet that
   * once held money is part of the record. Cash entries and closings need
   * UPDATE for exactly one transition — waiting for a checker, then posted or
   * rejected, which migration 0029's trigger confines them to — and DELETE
   * would make "what did we spend last Tuesday" answerable differently on two
   * different days.
   */
  'wallets.wallets',
  'wallets.cash_entries',
  'wallets.closings',
  /*
   * M07's inventory. A level is a cache every movement refreshes, so it needs
   * UPDATE; deleting one would lose its reorder level and make the SKU vanish
   * from availability while its movements still exist. The other four each have
   * exactly one legitimate transition, which migration 0033's triggers confine
   * them to — and a released reservation, a cancelled count and a rejected
   * write-off are all things somebody looks up precisely because they did not
   * happen.
   */
  'inventory.stock_levels',
  'inventory.sku_costs',
  'inventory.reservations',
  'inventory.count_sessions',
  'inventory.count_lines',
  'inventory.adjustments',
  'inventory.stock_transfers',
  /*
   * M13's fraud configuration and manual flags. `rules` needs UPDATE because bands
   * are edited; DELETE would silently reset a brand's fraud policy to D-011's
   * defaults, which is exactly the change that should be a visible edit. A flag is
   * *cleared*, never removed (0047 confines the UPDATE to the three cleared
   * columns): it is part of why a buyer was refused for a fortnight.
   *
   * The two cross-org tables are listed here too, although they carry no `org_id`.
   * This list is about a *grant*, not about tenancy, and they are the tables where
   * the absent DELETE matters most: a counter is what five brands know about one
   * phone number, and making it go away is the single thing a fraudster would want.
   * A stale provider row is overwritten by the next lookup, never removed.
   */
  'fraud.rules',
  'fraud.phone_flags',
  'fraud.phone_signals',
  'fraud.provider_checks',
  /*
   * M25. An investor who ever put money in is part of the record: deleting one would
   * orphan every contribution, share and withdrawal naming them, and `own` scope
   * resolves through that row. A distribution and a withdrawal each need UPDATE for
   * exactly one path — waiting, then declared or rejected; requested → reviewed →
   * approved → paid — which 0060's triggers confine them to. A document's bytes have
   * their own lifecycle in `files.objects`, and a dangling document row is how a
   * signed URL outlives its paperwork.
   */
  'investors.investors',
  'investors.distributions',
  'investors.withdrawals',
  'investors.documents',
  /*
   * M19's people (§12). Nothing about a person is deleted here, and each of these is a
   * different reason why.
   *
   * An employee resigns rather than disappearing: their payslips, loans and attendance all
   * name them, and `own` scope resolves through that row. An attendance day is *corrected*
   * by an UPDATE that records itself as manual (migration 0055), because a DELETE would make
   * "we removed the absence" possible and the audit log the only evidence it ever existed —
   * and an absence costs somebody money. A salary structure is superseded by a new one with a
   * later effective date, never edited away, so May's payslip keeps saying what it said after
   * June's raise. A loan and its instalments are the terms somebody signed; a payroll run and
   * an attendance import each need UPDATE for exactly one path, which 0055's triggers confine
   * them to, and a cancelled run and a rejected import are both things somebody looks up
   * precisely because they did not happen. A working-day calendar is what a past month's
   * proration was measured against.
   */
  'hr.employees',
  'hr.attendance_days',
  'hr.attendance_imports',
  'hr.salary_structures',
  'hr.employee_loans',
  'hr.loan_instalments',
  'hr.payroll_runs',
  'hr.work_calendars',
];

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

  /*
   * M13's cross-org fraud signals (§5 exception 1, D-032).
   *
   * The only tables in the system that one org *writes* and another reads. A buyer
   * who refuses an Oura parcel and then orders from Orvo is one person doing one
   * thing, and five brands each discovering it separately is five brands each
   * paying for it. So the counts are shared, keyed by `HMAC-SHA256(secret, e164)`.
   *
   * What makes the exception narrow is the column list in migration 0045, not a
   * policy. Neither table has anywhere to hold an order number, a customer name, an
   * address, an amount, a brand or a user id — so an org reading them learns "this
   * number has eleven completed orders and four came back" and cannot learn whose.
   * A policy can be widened by a migration nobody reads closely; a column that does
   * not exist cannot leak. The reason text behind a manual flag, and the reason
   * behind an override, stay in `fraud.phone_flags` and `fraud.overrides`, which
   * are ordinary tenant tables with FORCE RLS.
   *
   * Neither is analytics-readable. A fraud score is not analytics data, and a
   * read-only role is still a role that can read (D-049).
   */
  'fraud.phone_signals',
  'fraud.provider_checks',
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

/**
 * A policy on a tenant table other than its generated `<table>_org_isolation`.
 *
 * PostgreSQL ORs permissive policies, so a second permissive policy can only
 * ever *widen* what a table shows — and the guard used to check the one policy
 * it expected by name and merely count the rest. `iam.memberships` was the
 * first table with two; a later `using (true)` beside it would have passed.
 * Now every policy the guard finds must be the org policy, the generated
 * analytics policy on a table that opted in (D-049), or declared here with its
 * exact expression (M02a follow-up, D-089).
 */
export interface DeclaredPolicy {
  /** `schema.table`. */
  readonly table: string;
  readonly name: string;
  readonly permissive: 'PERMISSIVE' | 'RESTRICTIVE';
  /** `ALL`, `SELECT`, `INSERT`, `UPDATE` or `DELETE`, as `pg_policies.cmd` reports it. */
  readonly cmd: string;
  /** As `pg_policies.roles` renders it, e.g. `{public}`. */
  readonly roles: string;
  readonly using: string | null;
  readonly withCheck: string | null;
  /** Why this table needs more than the org policy. */
  readonly reason: string;
}

export const DECLARED_POLICIES: readonly DeclaredPolicy[] = [
  {
    table: 'iam.memberships',
    name: 'memberships_own_rows',
    permissive: 'PERMISSIVE',
    cmd: 'SELECT',
    roles: '{public}',
    using: `user_id = ${USER_CONTEXT_SQL}`,
    withCheck: null,
    reason: 'D-050: a user lists their own memberships before choosing an org.',
  },
];
