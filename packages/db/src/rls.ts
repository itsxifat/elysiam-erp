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
  /*
   * §5 exception 2, added by M24 (D-329): the brand-level rollup. The leaderboard, the
   * insight rules' group medians and the consolidated dashboard compare brands, and this is
   * everything they read — counts and sums per day, no buyer or phone. It carries gross
   * profit, so revenue minus it is every brand's cost of goods: a cross-brand read for
   * anyone but Super Admin leaves that column out (`brandRates`). The per-branch and agent
   * rollups and the narrative cache are deliberately absent (channel and campaign: below).
   */
  'analytics.daily_org',
  /*
   * The owner's reporting reads (migrations 0131 and 0132, D-483). With one brand per database
   * (D-469) the owner's figures across brands are read from each brand's database through
   * this role, so the channel and campaign rollups open too. Counts and sums per day; no
   * buyer, no cost.
   */
  'analytics.daily_channel',
  'analytics.daily_campaign',
  /* Which schema version the database holds, read before anything else (D-481). */
  'drizzle.__drizzle_migrations',
];

/**
 * Tables `erp_analytics` may read some columns of, and exactly which (migrations 0131 and 0132, D-483).
 *
 * A column grant rather than the table, because each of these also holds a person's details
 * or a cost: the buyer's name, phone and address on an order, a line's dispatch cost, a staff
 * member's phone, national id and payout details. Only counts, statuses, codes, names the
 * brand gave things, staff members' names and designations, selling prices and dates are
 * here. The guard compares the database's
 * column privileges with this list in both directions, so a column granted by accident, or
 * one listed and never granted, fails the build.
 */
export const ANALYTICS_READABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  'sales.orders': [
    'id',
    'org_id',
    'order_no',
    'channel',
    'status',
    'items_poisha',
    'discount_poisha',
    'delivery_charge_poisha',
    'created_at',
    'delivered_at',
  ],
  'sales.order_lines': [
    'org_id',
    'order_id',
    'sku_id',
    'sku_code',
    'product_name',
    'delivered_qty',
  ],
  'sales.couriers': ['id', 'org_id', 'code', 'name'],
  'catalog.skus': ['id', 'org_id', 'product_id', 'code', 'status'],
  'catalog.products': ['id', 'org_id', 'name', 'status'],
  'inventory.stock_levels': [
    'org_id',
    'sku_id',
    'location_id',
    'on_hand',
    'reserved',
    'reorder_level',
  ],
  'org.branches': ['id', 'org_id', 'code', 'name'],
  'org.locations': ['id', 'org_id', 'code', 'name'],
  'hr.employees': ['id', 'org_id', 'branch_id', 'code', 'full_name', 'designation', 'status'],
  'marketing.campaigns': ['id', 'org_id', 'name'],
};

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
  // gaps-users-auth: everyone who ever granted a role or held a link (D-406, D-410).
  'iam.membership_granters',
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
  /*
   * M26's company loans (§15). A loan's schedule is what was signed, and a reminder went
   * out or it did not. Migration 0095 refuses the UPDATE and the DELETE with a trigger as
   * well. (`loans.loans` itself is below: it is voided once, D-304.)
   */
  'loans.instalments',
  'loans.reminders',
  // M38a: every scan on a stock count, the record a disputed count is settled from (D-606).
  'inventory.count_scans',
  /*
   * M38b: every scan at the packing station, refusals included: what went into the box and
   * who put it there, the record a "wrong item" complaint is settled from (D-610). The
   * M38b append-only migration refuses UPDATE and DELETE with a trigger as well, so
   * `erp_owner` is held to the same rule as `erp_app`.
   */
  'packing.scans',
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
  /*
   * M26. A lender is the party on every loan payable line, so it is renamed, never
   * removed; a repayment needs UPDATE for exactly one transition (waiting, then posted or
   * rejected), which 0095's trigger confines it to.
   */
  'loans.lenders',
  'loans.payments',
  // M26: a loan's terms never change; it may be voided once against the reversal of its
  // receipt, which 0096's trigger confines UPDATE to (D-304).
  'loans.loans',
  /*
   * gaps-users-auth. Every sign-in reset an admin asked for is kept: the reset limits
   * count these rows (D-402), and "who reset this accountant's password, and who agreed"
   * is the question asked after an incident. UPDATE for the lifecycle only, which 0099's
   * trigger confines it to.
   */
  'iam.credential_resets',
  /*
   * M33. The website's settings are one row per brand, edited and never removed: a missing
   * row would silently fall back to the defaults. A website key is revoked, never deleted,
   * like the intake's: `revoked_at` is the record that it once could read the catalog.
   */
  'storefront.settings',
  'storefront.site_keys',
  /*
   * M38a. A brand's opening stock window: a deleted row reads as open again, which is a
   * reopen nobody approved (D-602). UPDATE for closing and an approved reopen only, which
   * the M38a policies migration's trigger confines it to.
   */
  'inventory.opening_stock_windows',
  /*
   * M38b. A packing session is opened, then completed once (0130's trigger); a deleted one
   * would make a packed order look unpacked by anyone. A video part is registered, attached
   * once and marked deleted by the retention job, never removed, so "was this order filmed,
   * and why is the film gone" stays answerable (D-612). The settings are one row per brand:
   * a missing row reads as the default (D-615).
   */
  'packing.sessions',
  'packing.videos',
  'packing.settings',
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
  // M31 (D-473): the owner sign-in links already used, by `jti`. Identity, like the
  // tables above; a link names a brand by its audience, not an org row.
  'iam.owner_link_uses',
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
