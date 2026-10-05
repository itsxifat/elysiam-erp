import { SEED_ORG_IDS, withAnalytics, withOrg, withSystem } from '@elysium/db';
import {
  findAnalyticsReadProblems,
  findAppendOnlyProblems,
  findCrossOrgForeignKeys,
  findPrivilegeProblems,
  findTenancyOffenders,
  startTestDatabase,
  stopSharedContainer,
  type TestDatabase,
} from '@elysium/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyWalletsMigrations } from './wallets.testing.js';

/**
 * The tenancy guard, pointed at the `wallets` schema (architecture §5,
 * invariant 4).
 *
 * `packages/db/src/testing/tenancy.test.ts` already enumerates every table in the
 * database and fails on any without `org_id`, RLS, FORCE RLS, the generated policy
 * and the right grants. It will cover these four tables the moment the migrations
 * are in `meta/_journal.json` — which is a shared file the integrator appends to,
 * so until then that suite runs against a database with no `wallets` schema in it
 * and would pass by having nothing to look at.
 *
 * This suite closes that gap by applying the migrations and calling the same guard
 * functions. It is not a copy of the guard: it is the guard, with the wallets
 * schema present, plus the two isolation properties §5's required tests name —
 * org A cannot reach org B's rows, and with no context set a tenant table returns
 * nothing.
 */

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const ORG_B = SEED_ORG_IDS['oura-lifestyle'] ?? '';
const TABLES = ['wallets', 'cash_entries', 'transfers', 'closings'];

let database: TestDatabase;

beforeAll(async () => {
  database = await startTestDatabase('wallets-tenancy');

  await applyWalletsMigrations();
}, 300_000);

afterAll(async () => {
  await database?.stop();
  await stopSharedContainer();
}, 60_000);

/**
 * Assert the *database* refused, matching PostgreSQL's own message.
 *
 * Drizzle raises `DrizzleQueryError: Failed query: …` and hangs the real error off
 * `.cause`, so matching the wrapper would pass for any failure at all — including
 * a typo in the statement, which is the failure a test like this is most likely to
 * be hiding.
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

describe('the wallets schema under the tenancy guard', () => {
  it('gives every table org_id, RLS, FORCE RLS and the generated policy', async () => {
    const offenders = await findTenancyOffenders();
    const mine = offenders.filter((offender) => offender.schema === 'wallets');
    expect(mine, JSON.stringify(mine)).toEqual([]);
    // And the guard did look at them, rather than finding nothing to look at.
    const present = await withSystem(async (tx) =>
      tx.execute<{ count: string }>(sql`
        select count(*) as count from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'wallets' and c.relkind = 'r'
      `),
    );
    expect(Number(present[0]?.count ?? 0)).toBe(TABLES.length);
  });

  it('carries org_id on both sides of every foreign key between tenant tables (D-047)', async () => {
    const offenders = await findCrossOrgForeignKeys();
    const mine = offenders.filter((offender) => offender.from.startsWith('wallets.'));
    expect(mine, JSON.stringify(mine)).toEqual([]);
  });

  it('gives the analytics role no write anywhere, and no read it did not opt into', async () => {
    expect(await findPrivilegeProblems()).toEqual([]);
    // The three ledger tables migration 0030 opens are in ANALYTICS_READABLE; the
    // wallets tables are not, and this is what would fail if one were granted by
    // accident.
    expect(await findAnalyticsReadProblems()).toEqual([]);
  });

  it('keeps transfers append-only and refuses DELETE on the rest', async () => {
    expect(await findAppendOnlyProblems()).toEqual([]);
  });

  it('lets the analytics role read ledger lines across orgs, and write nothing', async () => {
    // §5 exception 3: the read-only role the mother ERP reads a brand through (M32).
    const rows = await withAnalytics(async (tx) =>
      tx.execute<{ count: string }>(sql`select count(*) as count from ledger.accounts`),
    );
    // Every org's chart of accounts, not one org's: the seed gives all five a chart.
    expect(Number(rows[0]?.count ?? 0)).toBeGreaterThan(40);

    await expect(
      withAnalytics(async (tx) =>
        tx.execute(sql`insert into wallets.wallets (org_id, ledger_account_id) values (
          ${ORG_A}::uuid, ${ORG_A}::uuid)`),
      ),
    ).rejects.toThrow();
  });

  it('hides one org’s wallets from another', async () => {
    const accountId = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ id: string }>(sql`
            select id from ledger.accounts where org_id = ${ORG_A} and code = '1100'
          `)
        )[0]?.id ?? '',
      { orgId: ORG_A },
    );

    await withOrg({ orgId: ORG_A, userId: 'usr_guard' }, async (tx) => {
      await tx.execute(sql`
        insert into wallets.wallets (org_id, ledger_account_id) values (${ORG_A}, ${accountId})
      `);
    });

    const fromB = await withOrg({ orgId: ORG_B, userId: 'usr_guard' }, async (tx) =>
      tx.execute<{ count: string }>(sql`select count(*) as count from wallets.wallets`),
    );
    expect(Number(fromB[0]?.count ?? 0)).toBe(0);
  });

  it('refuses a wallet over an account from another branch, and a deleted row', async () => {
    const [handCash, otherOrgAccount] = await withSystem(
      async (tx) => [
        (
          await tx.execute<{ id: string }>(sql`
            select id from ledger.accounts where org_id = ${ORG_A} and code = '1010-HQ'
          `)
        )[0]?.id ?? '',
        (
          await tx.execute<{ id: string }>(sql`
            select id from ledger.accounts where org_id = ${ORG_B} and code = '1100'
          `)
        )[0]?.id ?? '',
      ],
      { orgId: ORG_A },
    );

    // Hand cash belongs to a branch, and the trigger holds the wallet's branch
    // equal to the account's rather than trusting the writer (0029).
    await expectRefused(
      withOrg({ orgId: ORG_A, userId: 'usr_guard' }, async (tx) => {
        await tx.execute(sql`
          insert into wallets.wallets (org_id, ledger_account_id, branch_id)
          values (${ORG_A}, ${handCash}, null)
        `);
      }),
      /LEDGER_ACCOUNT_INVALID/,
    );

    // Another org's account is invisible, so it reads as missing rather than as
    // a foreign key that could be satisfied across orgs.
    await expect(
      withOrg({ orgId: ORG_A, userId: 'usr_guard' }, async (tx) => {
        await tx.execute(sql`
          insert into wallets.wallets (org_id, ledger_account_id)
          values (${ORG_A}, ${otherOrgAccount})
        `);
      }),
    ).rejects.toThrow();

    await expect(
      withOrg({ orgId: ORG_A, userId: 'usr_guard' }, async (tx) => {
        await tx.execute(sql`delete from wallets.wallets where org_id = ${ORG_A}`);
      }),
    ).rejects.toThrow();
  });
});
