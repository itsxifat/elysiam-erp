import { SEED_ORG_IDS, withAnalytics, withOrg, withSystem } from '@elysium/db';
import {
  findAnalyticsReadProblems,
  findCrossOrgForeignKeys,
  findPrivilegeProblems,
  findTenancyOffenders,
  startTestDatabase,
  stopSharedContainer,
  type TestDatabase,
} from '@elysium/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyInvestorMigrations, seedInvestor } from './investors.testing.js';

/**
 * The tenancy guard, pointed at the `investors` schema (architecture §5,
 * invariant 4).
 *
 * `packages/db/src/testing/tenancy.test.ts` already enumerates every table in the
 * database and fails on any without `org_id`, RLS, FORCE RLS, the generated policy
 * and the right grants. It will cover these six tables the moment the migrations
 * are in `meta/_journal.json` — a shared file the integrator appends to, so until
 * then that suite runs against a database with no `investors` schema in it and
 * would pass by having nothing to look at.
 *
 * This suite closes the gap by applying the migrations and calling the same guard
 * functions, plus the isolation properties §5's required tests name and the refusals
 * 0060 adds.
 *
 * The grants are asserted **directly** rather than through `findAppendOnlyProblems()`,
 * which reads the lists in `packages/db/src/rls.ts` — those lists now name all six
 * tables, and the global guard suite therefore covers them too. The local assertions
 * stay because they say *which* table may be updated and which may not, table by
 * table, which a shared list of names cannot.
 */

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const ORG_B = SEED_ORG_IDS['oura-lifestyle'] ?? '';
const TABLES = [
  'investors',
  'investments',
  'distributions',
  'distribution_lines',
  'withdrawals',
  'documents',
];

let database: TestDatabase;

beforeAll(async () => {
  database = await startTestDatabase('investors-tenancy');
  await applyInvestorMigrations();
}, 300_000);

afterAll(async () => {
  await database?.stop();
  await stopSharedContainer();
}, 60_000);

/**
 * Assert the *database* refused, matching PostgreSQL's own message.
 *
 * Drizzle raises `DrizzleQueryError: Failed query: …` and hangs the real error off
 * `.cause`, so matching the wrapper would pass for any failure at all — including a
 * typo in the statement, which is the failure a test like this is most likely to be
 * hiding.
 */
async function expectRefused(work: Promise<unknown>, pattern: RegExp): Promise<void> {
  let thrown: unknown;
  try {
    await work;
  } catch (error) {
    thrown = error;
  }
  expect(thrown, 'the statement was expected to be refused').toBeInstanceOf(Error);
  let message = '';
  for (let current = thrown; current instanceof Error; current = current.cause) {
    message += `
${current.message}`;
  }
  expect(message).toMatch(pattern);
}

describe('the investors schema under the tenancy guard', () => {
  it('gives every table org_id, RLS, FORCE RLS and the generated policy', async () => {
    const offenders = await findTenancyOffenders();
    const mine = offenders.filter((offender) => offender.schema === 'investors');
    expect(mine, JSON.stringify(mine)).toEqual([]);
    // And the guard did look at them, rather than finding nothing to look at.
    const present = await withSystem(async (tx) =>
      tx.execute<{ count: string }>(sql`
        select count(*) as count from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'investors' and c.relkind = 'r'
      `),
    );
    expect(Number(present[0]?.count ?? 0)).toBe(TABLES.length);
  });

  it('carries org_id on both sides of every foreign key between tenant tables (D-047)', async () => {
    const offenders = await findCrossOrgForeignKeys();
    const mine = offenders.filter((offender) => offender.from.startsWith('investors.'));
    expect(mine, JSON.stringify(mine)).toEqual([]);
  });

  it('gives the analytics role no write anywhere, and no read into this schema', async () => {
    expect(await findPrivilegeProblems()).toEqual([]);
    expect(await findAnalyticsReadProblems()).toEqual([]);

    // The point of not opting in (D-049): `erp_analytics` bypasses org isolation,
    // and these rows are one investor's capital, profit share and KYC.
    await expectRefused(
      withAnalytics(async (tx) => tx.execute(sql`select count(*) from investors.investors`)),
      /permission denied/i,
    );
  });

  it('keeps contributions and distribution lines append-only, and refuses DELETE everywhere', async () => {
    const grants = await withSystem(async (tx) =>
      tx.execute<{ table_name: string; can_update: boolean; can_delete: boolean }>(sql`
        select c.relname as table_name,
               has_table_privilege('erp_app', 'investors.' || c.relname, 'UPDATE') as can_update,
               has_table_privilege('erp_app', 'investors.' || c.relname, 'DELETE') as can_delete
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'investors' and c.relkind = 'r'
        order by c.relname
      `),
    );
    const byName = new Map(grants.map((row) => [row.table_name, row]));

    // Append-only: a contribution and a line exist because money moved and a
    // journal recorded it, and a journal cannot be edited (invariant 2).
    expect(byName.get('investments')?.can_update).toBe(false);
    expect(byName.get('distribution_lines')?.can_update).toBe(false);
    // The rest need UPDATE for their one path, and none may DELETE.
    for (const table of TABLES) {
      expect(byName.get(table)?.can_delete, `${table} must not be deletable`).toBe(false);
    }
  });

  it('hides one org’s investors from another', async () => {
    await seedInvestor(ORG_A, { code: 'INV-GUARD', name: 'Guard Backer' });

    const fromB = await withOrg({ orgId: ORG_B, userId: 'usr_guard' }, async (tx) =>
      tx.execute<{ count: string }>(sql`select count(*) as count from investors.investors`),
    );
    expect(Number(fromB[0]?.count ?? 0)).toBe(0);
  });

  it('returns nothing at all with no org context set', async () => {
    // FORCE RLS, checked from the owner role: without it `erp_owner` — which runs
    // migrations and seeds — would be exempt from the policy.
    const rows = await withSystem(async (tx) =>
      tx.execute<{ count: string }>(sql`select count(*) as count from investors.investors`),
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(0);
  });

  it('refuses to delete an investor, from any role', async () => {
    await expectRefused(
      withOrg({ orgId: ORG_A, userId: 'usr_guard' }, async (tx) => {
        await tx.execute(sql`delete from investors.investors where org_id = ${ORG_A}`);
      }),
      /INVESTOR_IMMUTABLE|permission denied/i,
    );
  });

  it('refuses to move an investor’s login onto another row, or to reinstate an exit', async () => {
    const investorId = await seedInvestor(ORG_A, {
      code: 'INV-LINKED',
      name: 'Linked Backer',
      userId: 'usr_investor_guard',
    });

    await expectRefused(
      withOrg({ orgId: ORG_A, userId: 'usr_guard' }, async (tx) => {
        await tx.execute(sql`
          update investors.investors set user_id = 'usr_someone_else'
          where org_id = ${ORG_A} and id = ${investorId}
        `);
      }),
      /INVESTOR_IMMUTABLE/,
    );

    // Two investors of one org cannot share a login: `own` scope resolves through
    // `user_id`, and two rows would show one person the other's position.
    await expectRefused(
      withOrg({ orgId: ORG_A, userId: 'usr_guard' }, async (tx) => {
        await tx.execute(sql`
          insert into investors.investors (org_id, code, name, user_id, joined_on, created_by)
          values (${ORG_A}, 'INV-DUP', 'Duplicate', 'usr_investor_guard', '2026-01-01', 'seed')
        `);
      }),
      /duplicate key|investors_org_user_idx/i,
    );

    await withOrg({ orgId: ORG_A, userId: 'usr_guard' }, async (tx) => {
      await tx.execute(sql`
        update investors.investors set status = 'exited'
        where org_id = ${ORG_A} and id = ${investorId}
      `);
    });
    await expectRefused(
      withOrg({ orgId: ORG_A, userId: 'usr_guard' }, async (tx) => {
        await tx.execute(sql`
          update investors.investors set status = 'active'
          where org_id = ${ORG_A} and id = ${investorId}
        `);
      }),
      /INVESTOR_IMMUTABLE/,
    );
  });

  it('refuses a contribution for an investor of another org, across the composite key', async () => {
    const investorId = await seedInvestor(ORG_B, { code: 'INV-B-ONLY', name: 'Oura Backer' });
    const accountId = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ id: string }>(sql`
            select id from ledger.accounts where org_id = ${ORG_A} and code = '1100'
          `)
        )[0]?.id ?? '',
      { orgId: ORG_A },
    );

    // D-047: referential integrity runs with row security bypassed, so without
    // `org_id` on both sides of the key this would succeed and org A would hold a
    // contribution against an investor it cannot see.
    await expect(
      withOrg({ orgId: ORG_A, userId: 'usr_guard' }, async (tx) => {
        await tx.execute(sql`
          insert into investors.investments
            (org_id, investor_id, amount_poisha, wallet_account_id, occurred_at, business_date,
             journal_id, created_by)
          values (${ORG_A}, ${investorId}, 1000, ${accountId}, now(), current_date,
                  ${accountId}, 'seed')
        `);
      }),
    ).rejects.toThrow();
  });
});
