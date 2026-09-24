import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withAnalytics, withOrg, withSystem } from '../client.js';
import { GLOBAL_TABLES, tenantTableSql } from '../rls.js';
import { branches, settings } from '../schema/org/index.js';
import { EXPECTED_GEOGRAPHY } from '../seed/geography.js';
import { SEED_ORG_IDS, seedOrganizations } from '../seed/index.js';
import {
  findCrossOrgForeignKeys,
  findDefaultPrivileges,
  findAnalyticsReadProblems,
  findAppendOnlyProblems,
  findPrivilegeProblems,
  findTenancyOffenders,
} from './guard.js';
import {
  resetTenantData,
  startTestDatabase,
  stopSharedContainer,
  type TestDatabase,
} from './harness.js';

/**
 * Tenant isolation (architecture §5, M01 acceptance checks 1-6).
 *
 * These run against real PostgreSQL because row-level security is a database
 * behaviour — a mock cannot have it, and a test against a mock would pass while
 * proving nothing.
 *
 * They are written adversarially rather than confirmatively. The question is
 * not "can org A read its own rows", which any broken policy also answers yes
 * to. It is "given a determined attempt, can org A reach org B's rows by any
 * route the application exposes" — through the ORM, through raw SQL, with no
 * context set, on a reused connection, and concurrently.
 */

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const ORG_B = SEED_ORG_IDS['oura-lifestyle'] ?? '';

let database: TestDatabase;

beforeAll(async () => {
  database = await startTestDatabase('tenancy');
  expect(ORG_A, 'seed org A').not.toBe('');
  expect(ORG_B, 'seed org B').not.toBe('');
  expect(ORG_A).not.toBe(ORG_B);
}, 180_000);

afterAll(async () => {
  await database?.stop();
  await stopSharedContainer();
}, 60_000);

/**
 * Assert that a statement was refused by PostgreSQL, matching the *database's*
 * message rather than Drizzle's wrapper.
 *
 * Drizzle raises `DrizzleQueryError: Failed query: ...` and hangs the real
 * error off `.cause`. Matching the wrapper would pass for any failure at all,
 * including a typo in the SQL — which is exactly the false confidence these
 * tests exist to avoid.
 */
async function expectRefused(work: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await work;
  } catch (error) {
    caught = error;
  }

  expect(caught, 'expected PostgreSQL to refuse this statement').toBeDefined();

  const messages: string[] = [];
  for (let error = caught; error instanceof Error; error = error.cause) {
    messages.push(error.message);
  }

  expect(messages.join(' | ')).toMatch(pattern);
}

/** Insert into one tenant table, inside whatever transaction the caller holds. */
async function insertForAsOrg(
  tx: Parameters<Parameters<typeof withOrg>[1]>[0],
  table: string,
  orgId: string,
  tag: string,
): Promise<void> {
  switch (table) {
    case 'branches':
      await tx.execute(sql`insert into org.branches (org_id, code, name, kind)
        values (${orgId}, ${tag}, 'probe', 'showroom')`);
      break;
    case 'locations':
      await tx.execute(sql`insert into org.locations (org_id, code, name, kind)
        values (${orgId}, ${tag}, 'probe', 'warehouse')`);
      break;
    case 'settings':
      await tx.execute(sql`insert into org.settings (org_id, key, value)
        values (${orgId}, ${tag}, '{}'::jsonb)`);
      break;
    default:
      await tx.execute(sql`insert into org.feature_flags (org_id, key, enabled)
        values (${orgId}, ${tag}, false)`);
  }
}

/** Insert a row belonging to `orgId` and return its id. */
async function seedBranch(orgId: string, code: string): Promise<string> {
  return withSystem(
    async (tx) => {
      const [row] = await tx
        .insert(branches)
        .values({ orgId, code, name: `Branch ${code}`, kind: 'showroom' })
        .returning({ id: branches.id });
      if (row === undefined) throw new Error('insert returned nothing');
      return row.id;
    },
    { orgId },
  );
}

describe('the test database is actually capable of isolating anything', () => {
  it('runs as a role that cannot bypass row-level security', async () => {
    // If this fails, every other assertion in this file is meaningless.
    for (const [role, expected] of [
      ['erp_app', false],
      ['erp_owner', false],
      ['erp_analytics', false],
    ] as const) {
      const rows = await withSystem(async (tx) =>
        tx.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
          sql`select rolsuper, rolbypassrls from pg_roles where rolname = ${role}`,
        ),
      );
      expect(rows[0]?.rolsuper, `${role} rolsuper`).toBe(expected);
      expect(rows[0]?.rolbypassrls, `${role} rolbypassrls`).toBe(expected);
    }
  });

  it('forces row-level security on every tenant table, including for the owner', async () => {
    const rows = await withSystem(async (tx) =>
      tx.execute<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(sql`
        select c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'org' and c.relkind = 'r'
        order by c.relname
      `),
    );

    for (const row of rows) {
      if (GLOBAL_TABLES.includes(`org.${row.relname}`)) continue;
      expect(row.relrowsecurity, `${row.relname} RLS enabled`).toBe(true);
      // Without FORCE, erp_owner - which runs migrations and seeds - is exempt.
      expect(row.relforcerowsecurity, `${row.relname} RLS forced`).toBe(true);
    }
  });
});

describe('check 1: org A cannot reach org B rows, by any route', () => {
  it('cannot SELECT them through the ORM', async () => {
    const branchB = await seedBranch(ORG_B, 'B-SEL');

    const visible = await withOrg({ orgId: ORG_A }, async (tx) =>
      tx
        .select()
        .from(branches)
        .where(sql`${branches.id} = ${branchB}`),
    );

    expect(visible).toEqual([]);
  });

  it('cannot SELECT them through raw SQL either', async () => {
    const branchB = await seedBranch(ORG_B, 'B-RAW');

    const rows = await withOrg({ orgId: ORG_A }, async (tx) =>
      tx.execute<{ id: string }>(sql`select id from org.branches where id = ${branchB}`),
    );

    // The ORM is not the boundary. If it were, one repository writing raw SQL
    // would undo the whole design.
    expect([...rows]).toEqual([]);
  });

  it('cannot UPDATE them — the statement affects zero rows', async () => {
    const branchB = await seedBranch(ORG_B, 'B-UPD');

    await withOrg({ orgId: ORG_A }, async (tx) => {
      await tx.execute(sql`update org.branches set name = 'taken over' where id = ${branchB}`);
    });

    const [row] = await withSystem(
      async (tx) =>
        tx.execute<{ name: string }>(sql`select name from org.branches where id = ${branchB}`),
      { orgId: ORG_B },
    );
    expect(row?.name).toBe('Branch B-UPD');
  });

  it('cannot DELETE them — the statement affects zero rows', async () => {
    const branchB = await seedBranch(ORG_B, 'B-DEL');

    await withOrg({ orgId: ORG_A }, async (tx) => {
      await tx.execute(sql`delete from org.branches where id = ${branchB}`);
    });

    const survivors = await withSystem(
      async (tx) =>
        tx.execute<{ id: string }>(sql`select id from org.branches where id = ${branchB}`),
      { orgId: ORG_B },
    );
    expect([...survivors]).toHaveLength(1);
  });

  it('cannot INSERT a row labelled as belonging to org B', async () => {
    // The WITH CHECK half of the policy. Without it, org A could write rows
    // into org B's data even while being unable to read them.
    await expectRefused(
      withOrg({ orgId: ORG_A }, async (tx) => {
        await tx.insert(branches).values({
          orgId: ORG_B,
          code: 'SMUGGLED',
          name: 'Planted by org A',
          kind: 'showroom',
        });
      }),
      /row-level security/i,
    );
  });

  it('cannot relabel its own row as belonging to org B', async () => {
    const branchA = await seedBranch(ORG_A, 'A-MOVE');

    await expectRefused(
      withOrg({ orgId: ORG_A }, async (tx) => {
        await tx.execute(sql`update org.branches set org_id = ${ORG_B} where id = ${branchA}`);
      }),
      /row-level security/i,
    );
  });

  it('sees only its own rows when it lists a whole table', async () => {
    await seedBranch(ORG_A, 'A-LIST');
    await seedBranch(ORG_B, 'B-LIST');

    const fromA = await withOrg({ orgId: ORG_A }, async (tx) =>
      tx.execute<{ org_id: string }>(sql`select org_id from org.branches`),
    );

    expect([...fromA].length).toBeGreaterThan(0);
    expect([...new Set([...fromA].map((row) => row.org_id))]).toEqual([ORG_A]);
  });
});

describe('check 1, across every tenant table rather than a representative one', () => {
  /** Insert a row for `orgId` into each tenant table, shaped for that table. */
  async function insertFor(table: string, orgId: string, tag: string): Promise<void> {
    await withSystem(
      async (tx) => {
        switch (table) {
          case 'branches':
            await tx.execute(sql`insert into org.branches (org_id, code, name, kind)
              values (${orgId}, ${`ALL-${tag}`}, 'probe', 'showroom')`);
            break;
          case 'locations':
            await tx.execute(sql`insert into org.locations (org_id, code, name, kind)
              values (${orgId}, ${`ALL-${tag}`}, 'probe', 'warehouse')`);
            break;
          case 'settings':
            await tx.execute(sql`insert into org.settings (org_id, key, value)
              values (${orgId}, ${`all-${tag}`}, '{}'::jsonb)`);
            break;
          default:
            await tx.execute(sql`insert into org.feature_flags (org_id, key, enabled)
              values (${orgId}, ${`all-${tag}`}, false)`);
        }
      },
      { orgId },
    );
  }

  const TENANT_TABLES = ['branches', 'locations', 'settings', 'feature_flags'] as const;

  it.each(TENANT_TABLES)("org A sees none of org B's rows in org.%s", async (table) => {
    await insertFor(table, ORG_B, table);

    const rows = await withOrg({ orgId: ORG_A }, async (tx) =>
      tx.execute<{ org_id: string }>(sql.raw(`select org_id from org.${table}`)),
    );

    expect([...rows].filter((row) => row.org_id === ORG_B)).toEqual([]);
  });

  it.each(TENANT_TABLES)('org A cannot write an org B row into org.%s', async (table) => {
    await expectRefused(
      withOrg({ orgId: ORG_A }, async (tx) => {
        await insertForAsOrg(tx, table, ORG_B, `write-${table}`);
      }),
      /row-level security/i,
    );
  });

  it.each(TENANT_TABLES)('org A cannot update or delete org B rows in org.%s', async (table) => {
    await insertFor(table, ORG_B, `mut-${table}`);

    const before = await withSystem(
      async (tx) =>
        tx.execute<{ count: string }>(sql.raw(`select count(*) as count from org.${table}`)),
      { orgId: ORG_B },
    );

    await withOrg({ orgId: ORG_A }, async (tx) => {
      // Explicitly org B's rows. A bare DELETE would also sweep org A's own,
      // and trip their on-delete-restrict foreign keys, which is a different
      // thing entirely.
      await tx.execute(sql.raw(`delete from org.${table} where org_id = '${ORG_B}'`));
      await tx.execute(
        sql.raw(`update org.${table} set org_id = org_id where org_id = '${ORG_B}'`),
      );
    });

    const after = await withSystem(
      async (tx) =>
        tx.execute<{ count: string }>(sql.raw(`select count(*) as count from org.${table}`)),
      { orgId: ORG_B },
    );

    expect(Number(after[0]?.count)).toBe(Number(before[0]?.count));
  });
});

describe('check 2: with no org context, tenant tables return zero rows', () => {
  it('returns nothing on a connection that never set a context', async () => {
    await seedBranch(ORG_A, 'A-NOCTX');

    const rows = await withSystem(async (tx) =>
      tx.execute<{ count: string }>(sql`select count(*) as count from org.branches`),
    );

    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('returns zero rows rather than erroring after a context has been set and reset', async () => {
    // The case the original §5 policy got wrong. set_config(..., true) reverts
    // to the empty string, not to unset, so `''::uuid` raised
    // "invalid input syntax for type uuid" on every reused pooled connection.
    // `nullif` is what makes this zero rows instead of an exception (D-043).
    await withOrg({ orgId: ORG_A }, async (tx) => {
      await tx.execute<{ count: string }>(sql`select count(*) as count from org.branches`);
    });

    const rows = await withSystem(async (tx) =>
      tx.execute<{ count: string }>(sql`select count(*) as count from org.branches`),
    );

    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('refuses a non-uuid org id before it reaches the policy', async () => {
    await expectRefused(
      // The callback never runs: withOrg rejects the id before opening a
      // transaction, which is the point of the assertion.
      withOrg({ orgId: "' or '1'='1" }, () => Promise.resolve(undefined)),
      /uuid org id/i,
    );
  });
});

describe('check 3: erp_app cannot escape its own privileges', () => {
  it('cannot SET ROLE to the owner', async () => {
    await expectRefused(
      withOrg({ orgId: ORG_A }, async (tx) => {
        await tx.execute(sql`set role erp_owner`);
      }),
      /permission denied/i,
    );
  });

  it('cannot disable row-level security on a table it does not own', async () => {
    await expectRefused(
      withOrg({ orgId: ORG_A }, async (tx) => {
        await tx.execute(sql`alter table org.branches disable row level security`);
      }),
      /must be owner|permission denied/i,
    );
  });

  it('cannot drop the isolation policy', async () => {
    await expectRefused(
      withOrg({ orgId: ORG_A }, async (tx) => {
        await tx.execute(sql`drop policy branches_org_isolation on org.branches`);
      }),
      /must be owner|permission denied/i,
    );
  });

  it('cannot grant itself the bypass attribute', async () => {
    await expectRefused(
      withOrg({ orgId: ORG_A }, async (tx) => {
        await tx.execute(sql`alter role erp_app with bypassrls`);
      }),
      /permission denied|must be superuser/i,
    );
  });

  it('cannot create a table of its own, which would arrive with no policy', async () => {
    await expectRefused(
      withOrg({ orgId: ORG_A }, async (tx) => {
        await tx.execute(sql`create table org.backdoor (id uuid primary key, org_id uuid)`);
      }),
      /permission denied/i,
    );
  });
});

describe('check 4: erp_analytics reads every org and writes nothing', () => {
  it('reads the global org list', async () => {
    const rows = await withAnalytics(async (tx) =>
      tx.execute<{ count: string }>(sql`select count(*) as count from org.organizations`),
    );
    expect(Number(rows[0]?.count)).toBeGreaterThanOrEqual(5);
  });

  it('cannot write, even to a table it can read', async () => {
    await expectRefused(
      withAnalytics(async (tx) => {
        await tx.execute(sql`insert into org.organizations (slug, legal_name, display_name)
          values ('analytics-should-not-write', 'x', 'x')`);
      }),
      /read-only|permission denied/i,
    );
  });

  it('cannot update or delete', async () => {
    for (const statement of [
      sql`update org.organizations set display_name = 'x'`,
      sql`delete from org.organizations`,
    ]) {
      await expectRefused(
        withAnalytics(async (tx) => {
          await tx.execute(statement);
        }),
        /read-only|permission denied/i,
      );
    }
  });
});

describe('check 4 addendum: analytics access is opt-in per table (D-049)', () => {
  it('holds no read grant on a tenant table that has not opted in', async () => {
    // Worth stating plainly, because the check reads as though analytics can
    // already read every org's rows. It cannot. `tenantTableSql` grants
    // erp_analytics nothing unless a table passes analyticsReadsAllOrgs, and
    // no shipped table does until M24 adds the rollups. What check 4 proves
    // today is the global org list plus the mechanism; the cross-org read of
    // real tenant data starts existing at M24.
    for (const table of ['branches', 'locations', 'settings', 'feature_flags']) {
      const [row] = await withSystem(async (tx) =>
        tx.execute<{ granted: boolean }>(
          sql`select has_table_privilege('erp_analytics', ${`org.${table}`}, 'SELECT') as granted`,
        ),
      );
      expect(row?.granted, `erp_analytics should not read org.${table} yet`).toBe(false);
    }
  });

  it('reads the global tables it is granted, across every org', async () => {
    const rows = await withAnalytics(async (tx) =>
      tx.execute<{ slug: string }>(sql`select slug from org.organizations order by slug`),
    );
    expect([...rows].map((r) => r.slug)).toContain('oura-lifestyle');
    expect([...rows].map((r) => r.slug)).toContain('elysium-lifestyle-bd');
  });
});

describe('D-047 regression: the foreign-key exploit, behaviourally', () => {
  it("refuses a location pointing at another org's branch", async () => {
    // The structural guard catches a reverted constraint. This catches the
    // thing that was actually reproduced as a live exploit, which is worth
    // asserting directly rather than only in terms of constraint shape.
    const [branchB] = await withSystem(
      async (tx) => tx.execute<{ id: string }>(sql`select id from org.branches limit 1`),
      { orgId: ORG_B },
    );
    expect(branchB?.id).toBeDefined();

    await expectRefused(
      withOrg({ orgId: ORG_A }, async (tx) => {
        await tx.execute(sql`insert into org.locations (org_id, branch_id, code, name, kind)
          values (${ORG_A}, ${branchB?.id ?? ''}, 'EXPLOIT', 'probe', 'warehouse')`);
      }),
      /foreign key constraint/i,
    );
  });

  it('gives the same error for a foreign branch as for one that does not exist', async () => {
    // If the two differed, org A would still have an existence oracle on any
    // uuid in any org, which was one of the three consequences of the bug.
    const [branchB] = await withSystem(
      async (tx) => tx.execute<{ id: string }>(sql`select id from org.branches limit 1`),
      { orgId: ORG_B },
    );

    const messageFor = async (branchId: string): Promise<string> => {
      try {
        await withOrg({ orgId: ORG_A }, async (tx) => {
          await tx.execute(sql`insert into org.locations (org_id, branch_id, code, name, kind)
            values (${ORG_A}, ${branchId}, ${`ORACLE-${branchId.slice(0, 8)}`}, 'probe', 'warehouse')`);
        });
        return 'no error';
      } catch (error) {
        let message = '';
        for (let current: unknown = error; current instanceof Error; current = current.cause) {
          message = current.message;
        }
        return message;
      }
    };

    const foreign = await messageFor(branchB?.id ?? '');
    const missing = await messageFor('00000000-0000-4000-8000-000000000000');

    expect(foreign).toMatch(/foreign key constraint/i);
    expect(foreign).toBe(missing);
  });

  it("still allows a location pointing at the org's own branch", async () => {
    const [branchA] = await withSystem(
      async (tx) => tx.execute<{ id: string }>(sql`select id from org.branches limit 1`),
      { orgId: ORG_A },
    );

    await withOrg({ orgId: ORG_A }, async (tx) => {
      await tx.execute(sql`insert into org.locations (org_id, branch_id, code, name, kind)
        values (${ORG_A}, ${branchA?.id ?? ''}, 'OWN-BRANCH', 'probe', 'warehouse')`);
      await tx.execute(sql`delete from org.locations where code = 'OWN-BRANCH'`);
    });
  });
});

describe('check 5: the guard — every tenant table is isolated', () => {
  it('finds no table in a tenant schema without org_id, RLS, FORCE and the real policy', async () => {
    const offenders = await findTenancyOffenders();

    expect(
      offenders.map((o) => `${o.schema}.${o.table}: ${o.reasons.join('; ')}`),
      'Every table outside a declared global schema needs org_id, RLS enabled, RLS ' +
        'forced, and the generated org policy on both USING and WITH CHECK. Use ' +
        'tenantTableSql() in a migration, or declare the schema global in ' +
        'GLOBAL_SCHEMAS / GLOBAL_TABLES with a decision row saying why one org may ' +
        "see another org's rows there.",
    ).toEqual([]);
  });

  it('examines schemas it has never been told about', async () => {
    // The guard used to read an allowlist containing only 'org', so every
    // future module schema — sales, inventory, ledger — would have been
    // unguarded until somebody remembered to append a string to it. The
    // failure was silent and the first symptom would be one brand reading
    // another's revenue. It is now opt-out (D-048).
    await withSystem(async (tx) => {
      await tx.execute(sql`create schema if not exists probe_module`);
      await tx.execute(
        sql`create table probe_module.orders (id uuid primary key default gen_random_uuid(), org_id uuid not null)`,
      );
    });

    try {
      const offenders = await findTenancyOffenders();
      const found = offenders.find((o) => o.schema === 'probe_module' && o.table === 'orders');

      expect(found, 'a table in a brand-new schema must be caught').toBeDefined();
      expect(found?.reasons).toContain('row-level security is not enabled');
    } finally {
      await withSystem(async (tx) => {
        await tx.execute(sql`drop schema if exists probe_module cascade`);
      });
    }
  });

  it('rejects a policy that has been weakened to match every row', async () => {
    // Counting policies is not enough: `using (true)` is a policy. This is the
    // exact failure the generator exists to prevent, so the guard has to check
    // the expression rather than its existence (D-048).
    await withSystem(async (tx) => {
      await tx.execute(
        sql`create table org.weak_guard_probe (id uuid primary key default gen_random_uuid(), org_id uuid not null)`,
      );
      await tx.execute(sql`alter table org.weak_guard_probe enable row level security`);
      await tx.execute(sql`alter table org.weak_guard_probe force row level security`);
      await tx.execute(
        sql`create policy weak_guard_probe_org_isolation on org.weak_guard_probe using (true) with check (true)`,
      );
    });

    try {
      const offenders = await findTenancyOffenders();
      const found = offenders.find((o) => o.table === 'weak_guard_probe');

      expect(found, 'a policy of `using (true)` must be reported').toBeDefined();
      expect(found?.reasons.join(' ')).toMatch(/USING is .*not the generated org policy/);
    } finally {
      await withSystem(async (tx) => {
        await tx.execute(sql`drop table if exists org.weak_guard_probe`);
      });
    }
  });

  it('rejects a policy missing its WITH CHECK, which would leave writes unconstrained', async () => {
    await withSystem(async (tx) => {
      await tx.execute(
        sql`create table org.readonly_policy_probe (id uuid primary key default gen_random_uuid(), org_id uuid not null)`,
      );
      await tx.execute(sql`alter table org.readonly_policy_probe enable row level security`);
      await tx.execute(sql`alter table org.readonly_policy_probe force row level security`);
      await tx.execute(sql`create policy readonly_policy_probe_org_isolation
        on org.readonly_policy_probe for select
        using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)`);
    });

    try {
      const offenders = await findTenancyOffenders();
      const found = offenders.find((o) => o.table === 'readonly_policy_probe');
      expect(found?.reasons.join(' ')).toMatch(/covers only SELECT|no WITH CHECK/);
    } finally {
      await withSystem(async (tx) => {
        await tx.execute(sql`drop table if exists org.readonly_policy_probe`);
      });
    }
  });

  it('sees a partitioned parent, not only its leaves', async () => {
    // relkind 'p' as well as 'r'. A partitioned parent carries the policies
    // that apply when querying through it, so a guard that skipped parents
    // would report every leaf as clean while the parent had no RLS at all.
    // M02b's audit log and M03's journals are the obvious partition candidates.
    await withSystem(async (tx) => {
      await tx.execute(sql`create table org.part_probe (
        id uuid not null default gen_random_uuid(),
        org_id uuid not null,
        created_at timestamptz not null default now()
      ) partition by range (created_at)`);
      await tx.execute(
        sql`create table org.part_probe_2026 partition of org.part_probe
            for values from ('2026-01-01') to ('2027-01-01')`,
      );
    });

    try {
      const offenders = await findTenancyOffenders();
      expect(
        offenders.some((o) => o.table === 'part_probe'),
        'the partitioned parent must be reported, not just the leaf',
      ).toBe(true);
    } finally {
      await withSystem(async (tx) => {
        await tx.execute(sql`drop table if exists org.part_probe cascade`);
      });
    }
  });

  it('finds no foreign key between tenant tables that omits org_id', async () => {
    // PostgreSQL runs referential-integrity checks with row security bypassed,
    // so a plain `branch_id references branches(id)` lets one org reference a
    // row it cannot see (D-047). Verified live before the fix: org A inserted
    // a location pointing at org B's branch.
    const offenders = await findCrossOrgForeignKeys();

    expect(
      offenders.map((o) => `${o.constraint}: ${o.from} -> ${o.to}`),
      'A foreign key between two tenant tables must carry org_id, or it can be ' +
        "satisfied by another org's row. Use a composite reference against a " +
        '(org_id, id) unique constraint.',
    ).toEqual([]);
  });

  it('catches a foreign key that omits org_id', async () => {
    await withSystem(async (tx) => {
      await tx.execute(sql`create table org.fk_probe (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null,
        branch_id uuid references org.branches (id)
      )`);
    });

    try {
      const offenders = await findCrossOrgForeignKeys();
      expect(offenders.some((o) => o.from === 'org.fk_probe')).toBe(true);
    } finally {
      await withSystem(async (tx) => {
        await tx.execute(sql`drop table if exists org.fk_probe`);
      });
    }
  });

  it('grants nothing that would let a role step around a policy', async () => {
    // erp_analytics must be unable to write even outside withAnalytics's
    // read-only transaction, and erp_app must never hold TRUNCATE, which is not
    // subject to row-level security at all.
    const problems = await findPrivilegeProblems();

    expect(
      problems.map((p) => `${p.role} has ${p.privilege} on ${p.table}`),
      'These privileges survive a read-only transaction and bypass RLS.',
    ).toEqual([]);

    // A default privilege would silently grant a future table to a role.
    expect(await findDefaultPrivileges()).toBe(0);
  });

  it('grants erp_analytics no read that nobody opted in to (D-049)', async () => {
    // The write check above was not enough, and the gap was real:
    // `globalTableSql` granted analytics SELECT unconditionally, so every
    // global table became analytics-readable — including iam.accounts, which
    // holds password hashes, and iam.two_factors, which holds TOTP secrets and
    // backup codes. Verified against the running database before it was fixed.
    //
    // Reads are now enumerated the way writes are, so a new global table
    // cannot widen the analytics role by accident.
    expect(
      await findAnalyticsReadProblems(),
      'erp_analytics can read tables outside ANALYTICS_READABLE.',
    ).toEqual([]);
  });

  it('grants erp_app no way to change an append-only table', async () => {
    // The grant is the control. `findPrivilegeProblems` only checked that
    // analytics cannot write and that erp_app has no TRUNCATE, so an
    // append-only table declared READ_WRITE by mistake would have shipped
    // green — and M03's journals and M07's stock movements are both
    // append-only by invariant.
    expect(await findAppendOnlyProblems()).toEqual([]);
  });

  it('would notice if an append-only table were granted update', async () => {
    await withSystem(async (tx) => {
      await tx.execute(sql`grant update on "audit"."audit_log" to "erp_app"`);
    });

    try {
      expect(await findAppendOnlyProblems()).toContain('audit.audit_log: erp_app has UPDATE');
    } finally {
      await withSystem(async (tx) => {
        await tx.execute(sql`revoke update on "audit"."audit_log" from "erp_app"`);
      });
    }

    expect(await findAppendOnlyProblems()).toEqual([]);
  });

  it('would notice if a credential table were granted back', async () => {
    // The guard is only worth having if it fails on the thing it exists to
    // catch, so grant exactly the privilege that was wrong and prove it shows
    // up — then put it back.
    await withSystem(async (tx) => {
      await tx.execute(sql`grant usage on schema "iam" to "erp_analytics"`);
      await tx.execute(sql`grant select on "iam"."accounts" to "erp_analytics"`);
    });

    try {
      expect(await findAnalyticsReadProblems()).toContain('iam.accounts');
    } finally {
      await withSystem(async (tx) => {
        await tx.execute(sql`revoke select on "iam"."accounts" from "erp_analytics"`);
        await tx.execute(sql`revoke usage on schema "iam" from "erp_analytics"`);
      });
    }

    expect(await findAnalyticsReadProblems()).toEqual([]);
  });
});

describe('the harness reproduces the real role setup', () => {
  it('applies bootstrap.sql, not an approximation of it', async () => {
    // The harness used to hand-roll `create role` and skip bootstrap.sql's two
    // revokes, so every test ran against a permissions shape that differed
    // from production. This is the observable difference: after the real
    // bootstrap, erp_app cannot create temporary tables.
    await expectRefused(
      withOrg({ orgId: ORG_A }, async (tx) => {
        await tx.execute(sql`create temp table escape_hatch (id int)`);
      }),
      /permission denied/i,
    );
  });

  it('leaves nobody able to create objects in public', async () => {
    await expectRefused(
      withOrg({ orgId: ORG_A }, async (tx) => {
        await tx.execute(sql`create table public.loose (id int)`);
      }),
      /permission denied/i,
    );
  });
});

describe('the analytics cross-org policy behaves as designed', () => {
  it('lets erp_analytics read every org through a table that opts in', async () => {
    // `analyticsReadsAllOrgs` has no caller until M24, and its semantics rest
    // on PostgreSQL OR-ing permissive policies. Pinned here rather than
    // discovered later.
    await withSystem(async (tx) => {
      await tx.execute(
        sql`create table org.rollup_probe (id uuid primary key default gen_random_uuid(), org_id uuid not null)`,
      );
      await tx.execute(
        sql.raw(
          tenantTableSql({ schema: 'org', table: 'rollup_probe', analyticsReadsAllOrgs: true }),
        ),
      );
    });

    try {
      for (const orgId of [ORG_A, ORG_B]) {
        await withOrg({ orgId }, async (tx) => {
          await tx.execute(sql`insert into org.rollup_probe (org_id) values (${orgId})`);
        });
      }

      const seen = await withAnalytics(async (tx) =>
        tx.execute<{ org_id: string }>(sql`select org_id from org.rollup_probe`),
      );
      expect([...new Set([...seen].map((r) => r.org_id))].sort()).toEqual([ORG_A, ORG_B].sort());

      // Opting in to cross-org reads must not also grant writes.
      await expectRefused(
        withAnalytics(async (tx) => {
          await tx.execute(sql`insert into org.rollup_probe (org_id) values (${ORG_A})`);
        }),
        /read-only|permission denied/i,
      );
    } finally {
      await withSystem(async (tx) => {
        await tx.execute(sql`drop table if exists org.rollup_probe`);
      });
    }
  });
});

describe('reference geography is global and intact', () => {
  it('matches the vendored dataset exactly', async () => {
    const rows = await withOrg({ orgId: ORG_A }, async (tx) =>
      tx.execute<{ divisions: string; districts: string; thanas: string }>(sql`
        select
          (select count(*) from ref.divisions) as divisions,
          (select count(*) from ref.districts) as districts,
          (select count(*) from ref.thanas) as thanas
      `),
    );

    // Literals, not EXPECTED_GEOGRAPHY, which is derived from the same file the
    // seed loads and would therefore agree with a dataset that silently lost
    // rows. These are the numbers D-045 commits to: 8 divisions, 64 districts.
    expect({
      divisions: Number(rows[0]?.divisions),
      districts: Number(rows[0]?.districts),
      thanas: Number(rows[0]?.thanas),
    }).toEqual({ divisions: 8, districts: 64, thanas: 494 });

    // And the vendored file must still be the thing that was loaded.
    expect(EXPECTED_GEOGRAPHY).toEqual({ divisions: 8, districts: 64, thanas: 494 });
  });

  it('is visible to every org, because a district belongs to nobody', async () => {
    // Reference data is global (§5 exception 5). If it were accidentally
    // tenant-scoped, addresses would stop resolving for four of the five orgs.
    for (const orgId of [ORG_A, ORG_B]) {
      const rows = await withOrg({ orgId }, async (tx) =>
        tx.execute<{ count: string }>(sql`select count(*) as count from ref.districts`),
      );
      expect(Number(rows[0]?.count)).toBe(EXPECTED_GEOGRAPHY.districts);
    }
  });

  it('carries both an English and a Bangla name for every row', async () => {
    // Customer-facing output is Bangla (D-036), so a missing bn name would
    // surface as a blank district on an address label.
    const rows = await withOrg({ orgId: ORG_A }, async (tx) =>
      tx.execute<{ count: string }>(sql`
        select
          (select count(*) from ref.divisions where name_en = '' or name_bn = '')
          + (select count(*) from ref.districts where name_en = '' or name_bn = '')
          + (select count(*) from ref.thanas where name_en = '' or name_bn = '') as count
      `),
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('has no orphaned districts or thanas', async () => {
    const rows = await withOrg({ orgId: ORG_A }, async (tx) =>
      tx.execute<{ orphans: string }>(sql`
        select
          (select count(*) from ref.districts d
             where not exists (select 1 from ref.divisions v where v.id = d.division_id))
          + (select count(*) from ref.thanas t
             where not exists (select 1 from ref.districts d where d.id = t.district_id)) as orphans
      `),
    );
    expect(Number(rows[0]?.orphans)).toBe(0);
  });

  it('cannot be written by the app role', async () => {
    await expectRefused(
      withOrg({ orgId: ORG_A }, async (tx) => {
        await tx.execute(
          sql`insert into ref.divisions (id, name_en, name_bn) values (99, 'x', 'x')`,
        );
      }),
      /permission denied/i,
    );
  });
});

describe('these tests would catch a weakened policy', () => {
  it('detects isolation that has been broken to `using (true)`', async () => {
    // Every assertion above is a negative: "org A sees nothing of org B's".
    // A negative passes just as happily when the query is broken, the table is
    // empty, or the harness silently did nothing. So: build a table with a
    // deliberately weak policy, and prove the same method reports a leak.
    await withSystem(async (tx) => {
      await tx.execute(sql`
        create table org.weak_probe (
          id uuid primary key default gen_random_uuid(),
          org_id uuid not null,
          note text not null
        )
      `);
      await tx.execute(sql`alter table org.weak_probe enable row level security`);
      await tx.execute(sql`alter table org.weak_probe force row level security`);
      // The bug being simulated: a policy that matches every row.
      await tx.execute(sql`create policy weak on org.weak_probe using (true) with check (true)`);
      await tx.execute(sql`grant select, insert on org.weak_probe to erp_app`);
      await tx.execute(
        sql`insert into org.weak_probe (org_id, note) values (${ORG_B}, 'org B secret')`,
      );
    });

    try {
      const leaked = await withOrg({ orgId: ORG_A }, async (tx) =>
        tx.execute<{ note: string }>(sql`select note from org.weak_probe`),
      );

      // If this came back empty, the method above could not tell a working
      // policy from a broken one, and every passing test would be worthless.
      expect(
        [...leaked],
        'a policy of `using (true)` must be observable as a leak, or these tests prove nothing',
      ).toHaveLength(1);
      expect(leaked[0]?.note).toBe('org B secret');
    } finally {
      await withSystem(async (tx) => {
        await tx.execute(sql`drop table if exists org.weak_probe`);
      });
    }
  });

  it('detects a table whose RLS was switched off entirely', async () => {
    await withSystem(async (tx) => {
      await tx.execute(
        sql`create table org.unprotected_probe (id uuid primary key default gen_random_uuid(), org_id uuid not null)`,
      );
      await tx.execute(sql`grant select, insert on org.unprotected_probe to erp_app`);
      await tx.execute(sql`insert into org.unprotected_probe (org_id) values (${ORG_B})`);
    });

    try {
      const leaked = await withOrg({ orgId: ORG_A }, async (tx) =>
        tx.execute<{ org_id: string }>(sql`select org_id from org.unprotected_probe`),
      );
      expect([...leaked]).toHaveLength(1);
      expect(leaked[0]?.org_id).toBe(ORG_B);
    } finally {
      await withSystem(async (tx) => {
        await tx.execute(sql`drop table if exists org.unprotected_probe`);
      });
    }
  });
});

describe('the harness reset works', () => {
  it('empties tenant tables and restores the seed', async () => {
    // The Build list asks for "a fast reset between tests". It existed but
    // nothing called it, so nothing proved it worked. It runs last because it
    // truncates the rows the other tests rely on.
    await withOrg({ orgId: ORG_A }, async (tx) => {
      await tx.execute(sql`insert into org.settings (org_id, key, value)
        values (${ORG_A}, 'reset-probe', '{}'::jsonb)`);
    });

    await resetTenantData();

    const settingsAfter = await withOrg({ orgId: ORG_A }, async (tx) =>
      tx.execute<{ count: string }>(sql`select count(*) as count from org.settings`),
    );
    expect(Number(settingsAfter[0]?.count), 'truncate should have emptied settings').toBe(0);

    // And the seed is back, so a following test still has its fixtures.
    const branchesAfter = await withOrg({ orgId: ORG_A }, async (tx) =>
      tx.execute<{ code: string }>(sql`select code from org.branches`),
    );
    expect([...branchesAfter].map((r) => r.code)).toContain('HQ');
  });
});

describe('check 6: migrate and seed are idempotent', () => {
  it('re-seeding changes no row counts', async () => {
    const count = async () =>
      withSystem(async (tx) => {
        const rows = await tx.execute<{ orgs: string }>(
          sql`select count(*) as orgs from org.organizations`,
        );
        return Number(rows[0]?.orgs ?? 0);
      });

    const before = await count();
    await seedOrganizations();
    await seedOrganizations();
    const after = await count();

    expect(after).toBe(before);
  });

  it('keeps derived ids stable across runs', async () => {
    // The seed is idempotent because ids come from the slug, not from a
    // generator. If that ever changes, every fixture and bookmarked URL breaks.
    const [row] = await withSystem(async (tx) =>
      tx.execute<{ id: string }>(
        sql`select id from org.organizations where slug = 'elysium-lifestyle-bd'`,
      ),
    );
    expect(row?.id).toBe(ORG_A);
  });
});

describe('concurrency: contexts do not bleed between overlapping transactions', () => {
  it('keeps each org seeing only its own rows under parallel load', async () => {
    await Promise.all([seedBranch(ORG_A, 'A-PAR'), seedBranch(ORG_B, 'B-PAR')]);

    // Interleaved on a shared pool: if the context were session-scoped rather
    // than transaction-scoped, these would contaminate each other.
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, index) => {
        const orgId = index % 2 === 0 ? ORG_A : ORG_B;
        return withOrg({ orgId }, async (tx) => {
          const rows = await tx.execute<{ org_id: string }>(sql`select org_id from org.branches`);
          return { orgId, seen: [...new Set([...rows].map((row) => row.org_id))] };
        });
      }),
    );

    for (const result of results) {
      expect(result.seen, `context ${result.orgId} saw foreign rows`).toEqual([result.orgId]);
    }
  });

  it('writes land in the org that wrote them', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => {
        const orgId = index % 2 === 0 ? ORG_A : ORG_B;
        return withOrg({ orgId }, async (tx) => {
          await tx.insert(settings).values({ orgId, key: `concurrent-${index}`, value: { index } });
        });
      }),
    );

    for (const [orgId, expectedKeys] of [
      [ORG_A, [0, 2, 4, 6, 8]],
      [ORG_B, [1, 3, 5, 7, 9]],
    ] as const) {
      const rows = await withOrg({ orgId }, async (tx) =>
        tx.execute<{ key: string }>(sql`select key from org.settings order by key`),
      );
      const keys = [...rows]
        .filter((row) => row.key.startsWith('concurrent-'))
        .map((row) => Number(row.key.replace('concurrent-', '')))
        .sort((a, b) => a - b);
      expect(keys).toEqual([...expectedKeys]);
    }
  });
});
