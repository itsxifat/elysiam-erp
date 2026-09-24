import { sql } from 'drizzle-orm';

import { withSystem } from '../client.js';
import {
  ANALYTICS_READABLE,
  ANALYTICS_READABLE_SCHEMAS,
  APPEND_ONLY_TABLES,
  NO_DELETE_TABLES,
} from '../rls.js';
import { GLOBAL_SCHEMAS, GLOBAL_TABLES, ORG_CONTEXT_SQL } from '../rls.js';

/**
 * The tenancy guard: everything that must be true of the live database for
 * one brand to be unable to see another's data (architecture §5).
 *
 * Extracted from the test file on purpose. A guard that only exists inside its
 * own assertion cannot be pointed at a deliberately broken table to prove it
 * reports anything — and an unexercised guard is worse than none, because it
 * reads like coverage.
 */

/** Schemas PostgreSQL owns, plus the ones we have declared global. */
const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];

export interface Offender {
  readonly schema: string;
  readonly table: string;
  readonly reasons: readonly string[];
}

/**
 * Compare two SQL expressions as PostgreSQL would have rewritten them.
 *
 * `pg_policies.qual` comes back with the planner's parentheses and explicit
 * `::text` casts, so a raw string comparison against the generated source never
 * matches. Normalising both sides is what lets the guard check the *expression*
 * rather than merely counting that a policy exists.
 */
function normalizeExpression(expression: string): string {
  return expression
    .toLowerCase()
    .replace(/::text/g, '')
    .replace(/[()\s]/g, '');
}

const EXPECTED_POLICY = normalizeExpression(`org_id = ${ORG_CONTEXT_SQL}`);

interface TableRow extends Record<string, unknown> {
  schemaname: string;
  tablename: string;
  has_org_id: boolean;
  rls_enabled: boolean;
  rls_forced: boolean;
  qual: string | null;
  with_check: string | null;
  policy_count: string;
  permissive: string | null;
  cmd: string | null;
  roles: string | null;
}

/**
 * Every table that should be tenant-isolated but is not.
 *
 * Opt-out, not opt-in: every schema is examined unless it is a system schema
 * or has been declared global. A new module schema — `sales` in M10,
 * `inventory` in M07, `ledger` in M03 — is therefore guarded the moment it
 * exists, rather than when somebody remembers to add it to a list.
 */
export async function findTenancyOffenders(): Promise<Offender[]> {
  const rows = await withSystem(async (tx) =>
    tx.execute<TableRow>(sql`
      select
        n.nspname as schemaname,
        c.relname as tablename,
        exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'org_id'
            and a.attnum > 0 and not a.attisdropped
        ) as has_org_id,
        c.relrowsecurity as rls_enabled,
        c.relforcerowsecurity as rls_forced,
        p.qual::text as qual,
        p.with_check::text as with_check,
        p.permissive,
        p.cmd,
        p.roles::text as roles,
        (select count(*) from pg_policies q
           where q.schemaname = n.nspname and q.tablename = c.relname) as policy_count
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_policies p
        on p.schemaname = n.nspname
       and p.tablename = c.relname
       and p.policyname = c.relname || '_org_isolation'
      -- 'p' as well as 'r': a partitioned parent needs its own ENABLE/FORCE,
      -- because the policies that apply when querying through it are the
      -- parent's. M02b's audit log and M03's journals are the obvious
      -- candidates for partitioning, and a parent skipped here would be
      -- invisible to the guard while every leaf looked fine.
      where c.relkind in ('r', 'p')
        and n.nspname not in ${SYSTEM_SCHEMAS}
        and n.nspname not like 'pg\\_temp%'
        and n.nspname not in ${[...GLOBAL_SCHEMAS]}
        -- Objects an extension owns are not ours to police.
        and not exists (
          select 1 from pg_depend d
          where d.objid = c.oid and d.deptype = 'e'
        )
      order by n.nspname, c.relname
    `),
  );

  const offenders: Offender[] = [];

  for (const row of rows) {
    const qualified = `${row.schemaname}.${row.tablename}`;
    if (GLOBAL_TABLES.includes(qualified)) continue;

    const reasons: string[] = [];
    if (!row.has_org_id) reasons.push('no org_id column');
    if (!row.rls_enabled) reasons.push('row-level security is not enabled');
    // Without FORCE, erp_owner — which runs migrations and seeds — is exempt.
    if (!row.rls_forced) reasons.push('row-level security is not FORCEd');
    if (Number(row.policy_count) === 0) reasons.push('no policy at all');

    if (row.qual === null) {
      if (Number(row.policy_count) > 0) {
        reasons.push(`no policy named ${row.tablename}_org_isolation`);
      }
    } else {
      // The check that catches `using (true)`: the expression itself, not the
      // fact that some policy exists.
      if (normalizeExpression(row.qual) !== EXPECTED_POLICY) {
        reasons.push(`USING is "${row.qual}", not the generated org policy`);
      }
      if (row.with_check === null) {
        reasons.push('policy has no WITH CHECK, so writes are unconstrained');
      } else if (normalizeExpression(row.with_check) !== EXPECTED_POLICY) {
        reasons.push(`WITH CHECK is "${row.with_check}", not the generated org policy`);
      }
      if (row.permissive !== 'PERMISSIVE') reasons.push(`policy is ${row.permissive}`);
      if (row.cmd !== 'ALL') reasons.push(`policy covers only ${row.cmd}`);
      if (row.roles !== '{public}') reasons.push(`policy applies only to ${row.roles}`);
    }

    if (reasons.length > 0)
      offenders.push({ schema: row.schemaname, table: row.tablename, reasons });
  }

  return offenders;
}

export interface ForeignKeyOffender {
  readonly constraint: string;
  readonly from: string;
  readonly to: string;
}

/**
 * Foreign keys between two tenant tables that do not carry `org_id`.
 *
 * PostgreSQL runs referential-integrity checks with row security bypassed, so
 * a plain `branch_id references branches(id)` lets one org reference a row it
 * cannot see — corrupting integrity, blocking the other org from deleting its
 * own row, and providing an existence oracle (D-047).
 */
export async function findCrossOrgForeignKeys(): Promise<ForeignKeyOffender[]> {
  const rows = await withSystem(async (tx) =>
    tx.execute<{ constraint_name: string; from_table: string; to_table: string }>(sql`
      with tenant_tables as (
        select c.oid, n.nspname, c.relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p')
          and exists (
            select 1 from pg_attribute a
            where a.attrelid = c.oid and a.attname = 'org_id'
              and a.attnum > 0 and not a.attisdropped
          )
      )
      select
        con.conname as constraint_name,
        child.nspname || '.' || child.relname as from_table,
        parent.nspname || '.' || parent.relname as to_table
      from pg_constraint con
      join tenant_tables child on child.oid = con.conrelid
      join tenant_tables parent on parent.oid = con.confrelid
      where con.contype = 'f'
        -- Both sides must include org_id, at the *same position*, so the
        -- reference genuinely ties the two orgs together. Checking only the
        -- referencing side would accept
        --   (org_id, branch_id) references branches (id, org_id)
        -- which type-checks and isolates nothing.
        and not exists (
          select 1
          from generate_subscripts(con.conkey, 1) as i
          join pg_attribute child_col
            on child_col.attrelid = con.conrelid
           and child_col.attnum = con.conkey[i]
          join pg_attribute parent_col
            on parent_col.attrelid = con.confrelid
           and parent_col.attnum = con.confkey[i]
          where child_col.attname = 'org_id'
            and parent_col.attname = 'org_id'
        )
      order by 1
    `),
  );

  return [...rows].map((row) => ({
    constraint: row.constraint_name,
    from: row.from_table,
    to: row.to_table,
  }));
}

export interface PrivilegeOffender {
  readonly role: string;
  readonly table: string;
  readonly privilege: string;
}

/**
 * Privileges no role should hold.
 *
 * `erp_analytics` must not be able to write anything — the read-only
 * transaction in `withAnalytics` is belt, this is braces, and only this one
 * survives a future migration that grants write by accident.
 *
 * `erp_app` must not hold TRUNCATE on any table: TRUNCATE is not subject to
 * row-level security at all, so one org could empty another's table with every
 * policy intact and nothing failing.
 */
export async function findPrivilegeProblems(): Promise<PrivilegeOffender[]> {
  const rows = await withSystem(async (tx) =>
    tx.execute<{ role: string; table_name: string; privilege: string }>(sql`
      with candidates as (
        select n.nspname || '.' || c.relname as table_name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p')
          and n.nspname not in ${SYSTEM_SCHEMAS}
          and n.nspname not like 'pg\\_temp%'
      ),
      checks as (
        select 'erp_analytics' as role, table_name, unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as privilege
        from candidates
        union all
        select 'erp_app' as role, table_name, 'TRUNCATE' as privilege
        from candidates
      )
      select role, table_name, privilege
      from checks
      where has_table_privilege(role, table_name, privilege)
      order by role, table_name, privilege
    `),
  );

  return [...rows].map((row) => ({
    role: row.role,
    table: row.table_name,
    privilege: row.privilege,
  }));
}

/**
 * Tables `erp_analytics` can read that nobody opted in (D-049).
 *
 * The write check above was not enough. `globalTableSql` granted analytics
 * SELECT unconditionally, so every global table became analytics-readable —
 * including `iam.accounts` (password hashes) and `iam.two_factors` (TOTP
 * secrets and backup codes). A read-only role is still a role that can read,
 * and nothing in analytics ever needed either table.
 *
 * So reads are enumerated the same way writes are: anything SELECT-able that is
 * not on the allowlist is an offender, and adding a table cannot widen the
 * analytics role by accident.
 */
export async function findAnalyticsReadProblems(): Promise<string[]> {
  const rows = await withSystem(async (tx) =>
    tx.execute<{ table_name: string }>(sql`
      select n.nspname || '.' || c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p')
        and n.nspname not in ${SYSTEM_SCHEMAS}
        and n.nspname not like 'pg\\_temp%'
        and n.nspname <> all (${sql.param(ANALYTICS_READABLE_SCHEMAS as string[])}::text[])
        and (n.nspname || '.' || c.relname) <> all (${sql.param(ANALYTICS_READABLE as string[])}::text[])
        and has_table_privilege('erp_analytics', c.oid, 'SELECT')
      order by 1
    `),
  );

  return [...rows].map((row) => row.table_name);
}

/**
 * Append-only tables `erp_app` can nonetheless change.
 *
 * A log whose rows can be edited is not evidence of anything, and the only
 * thing that makes "append-only" true rather than intended is the absence of
 * the grant. Enumerated for the same reason analytics reads are: so a table
 * declared READ_WRITE by mistake fails the build rather than shipping green.
 */
export async function findAppendOnlyProblems(): Promise<string[]> {
  const offenders: string[] = [];

  for (const table of APPEND_ONLY_TABLES) {
    const rows = await withSystem(async (tx) =>
      tx.execute<{ can_update: boolean; can_delete: boolean }>(sql`
        select
          has_table_privilege('erp_app', ${table}, 'UPDATE') as can_update,
          has_table_privilege('erp_app', ${table}, 'DELETE') as can_delete
      `),
    );

    const row = rows[0];
    if (row?.can_update === true) offenders.push(`${table}: erp_app has UPDATE`);
    if (row?.can_delete === true) offenders.push(`${table}: erp_app has DELETE`);
  }

  /*
   * And the weaker rule: changeable once, erasable never.
   *
   * An approval record is evidence in the same sense the audit log is — it is
   * what says a payment was authorised — but it must be updatable, because
   * deciding it *is* an update. So DELETE alone is checked, and it is checked
   * structurally rather than only by the one end-to-end test that tries it:
   * `grant all on all tables in schema approvals to erp_app` is an entirely
   * plausible line for a later migration, and it would hand the grant back
   * without mentioning this table at all.
   */
  for (const table of NO_DELETE_TABLES) {
    const rows = await withSystem(async (tx) =>
      tx.execute<{ can_delete: boolean }>(sql`
        select has_table_privilege('erp_app', ${table}, 'DELETE') as can_delete
      `),
    );

    if (rows[0]?.can_delete === true) offenders.push(`${table}: erp_app has DELETE`);
  }

  return offenders;
}

/** Default privileges that would silently grant a future table to a role. */
export async function findDefaultPrivileges(): Promise<number> {
  const rows = await withSystem(async (tx) =>
    tx.execute<{ count: string }>(sql`select count(*) as count from pg_default_acl`),
  );
  return Number(rows[0]?.count ?? 0);
}
