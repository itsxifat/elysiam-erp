import { randomBytes, randomUUID } from 'node:crypto';

import type { MembershipRole } from '@elysium/contracts';
import { SEED_ORG_IDS, withSystem } from '@elysium/db';
import { createTestUser, grantMembership } from '@elysium/db/testing';
import { businessDate } from '@elysium/domain';
import { sql } from 'drizzle-orm';

import { startHttpHarness, type HttpHarness, type RoleClient } from '../../testing/http-harness.js';
import { accountIdBySubtype, seedFileObject } from './investors.testing.js';

/**
 * The investor portal's real-stack Playwright run (M25 check 1, the browser half).
 *
 * Test-only, and run as a process of its own — `node --env-file=.env
 * dist/modules/investors/investor-portal-stack.provision.js create` from `apps/server` — by
 * the portal's Playwright `globalSetup`, which then points the built API and the portal at
 * the database this prints. Compiled with the server because it is built from the server's
 * own test fixtures, which Playwright's transform cannot load.
 *
 * **The money is written through the real API, in process.** A contribution needs a journal,
 * a declared distribution needs an approval, a paid withdrawal needs three different people
 * and a journal at `paid` — so rather than forging those rows, this boots the application
 * through the HTTP harness every server suite uses and drives the same routes the console
 * does: create the investors, record capital, declare a profit and approve it, request,
 * review, approve and pay a withdrawal, attach documents. Then it shuts the application down
 * and keeps only the database, which the stack's own API serves.
 *
 * **The two investors the browser signs in as have no second factor** and are given a
 * password through Better Auth's reset flow, as `desk-stack.provision.ts` does: §6 walls the
 * investor role, so the spec has to pass the enrolment screen before it sees anything, which
 * is part of what it checks.
 *
 * * `alpha` holds a stake in two brands (Elysiam Lifestyle BD and Oura Lifestyle), so the
 *   brand switcher and capital per brand are real.
 * * `beta` holds a stake in Elysiam only, with figures chosen to be unmistakable on a page
 *   (৳5,00,000 of capital, a ৳7,777 withdrawal, a document titled for them) so the spec can
 *   say they never appear in alpha's session.
 *
 * Throwaway values only (invariant 10): `@example.invalid` addresses, a random password that
 * exists only in this process's stdout and the Playwright process that reads it. Refuses to
 * run against anything but a local server, or with `NODE_ENV=production`.
 */

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const ORG_B = SEED_ORG_IDS['oura-lifestyle'] ?? '';

function adminUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_ADMIN_URL ?? '';
  if (url === '')
    throw new Error('investor-stack: DATABASE_ADMIN_URL is not set (apps/server/.env).');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('investor-stack: refusing to run with NODE_ENV=production.');
  }
  const host = new URL(url).hostname;
  if (!LOCAL.has(host)) throw new Error(`investor-stack: refusing to run against ${host}.`);
  return url;
}

async function call<T>(as: RoleClient, method: string, url: string, body?: unknown): Promise<T> {
  const response = await as.client.request(method, url, body === undefined ? {} : { body });
  if (response.statusCode >= 300) {
    throw new Error(
      `investor-stack: ${method} ${url} answered ${String(response.statusCode)}: ${response.body}`,
    );
  }
  return JSON.parse(response.body) as T;
}

/** A platform super admin, as `investors.e2e.test.ts` makes its declarer and checkers. */
async function superAdmin(harness: HttpHarness): Promise<RoleClient> {
  const client = await harness.asRole('accounts', ORG_A);
  await withSystem(async (tx) => {
    await tx.execute(sql`update iam.users set is_super_admin = true where id = ${client.userId}`);
  });
  return client;
}

/** A portal sign-in with a password and no second factor, as a person is invited. */
async function portalUser(
  harness: HttpHarness,
  label: string,
  run: string,
  password: string,
  grants: readonly { orgId: string; role: MembershipRole }[],
): Promise<{ email: string; userId: string }> {
  const email = `e2e.${label}.${run}@example.invalid`;
  const user = await createTestUser({ email, name: `E2E investor ${label}` });
  for (const grant of grants) {
    await grantMembership({ userId: user.id, orgId: grant.orgId, role: grant.role });
  }
  const anonymous = harness.client();
  await anonymous.request('GET', '/v1/auth/login-branding');
  // Minted from the server, as the iam module does: the HTTP path is disabled (D-402).
  await harness.auth.auth.api.requestPasswordReset({
    body: { email, redirectTo: '/accept-invite' },
    headers: new Headers(),
  });
  const token = harness.tokens.take(email);
  const reset = await anonymous.request('POST', '/api/auth/reset-password', {
    body: { newPassword: password, token },
  });
  if (reset.statusCode !== 200) {
    throw new Error(
      `investor-stack: setting ${label}'s password answered ${String(reset.statusCode)}`,
    );
  }
  return { email, userId: user.id };
}

/** The month before this one in Asia/Dhaka, which has ended and so may be declared. */
function lastMonth(): string {
  const [year = 0, month = 0] = businessDate(new Date()).split('-').map(Number);
  const previous = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  return `${String(previous.year)}-${String(previous.month).padStart(2, '0')}`;
}

async function create(): Promise<void> {
  // `startTestDatabase` creates its database on TEST_DATABASE_URL's server. A container would
  // die with this process and take the database away from the stack's API.
  process.env.TEST_DATABASE_URL = adminUrl();
  const harness = await startHttpHarness('investorportal');
  // Whatever happens below, the database this process made is dropped: a failed run must
  // not leave an `elysium_investorportal_*` behind on the developer's server.
  let appOpen = true;
  try {
    const run = randomBytes(4).toString('hex');
    const password = randomBytes(18).toString('base64url');

    const alpha = await portalUser(harness, 'alpha', run, password, [
      { orgId: ORG_A, role: 'investor' },
      { orgId: ORG_B, role: 'investor' },
    ]);
    const beta = await portalUser(harness, 'beta', run, password, [
      { orgId: ORG_A, role: 'investor' },
    ]);

    // The staff who move the money: three different people for a withdrawal (D-118).
    const accounts = await harness.asRole('accounts', ORG_A);
    const accountsB = await harness.asRole('accounts', ORG_B);
    const reviewer = await superAdmin(harness);
    const checker = await superAdmin(harness);

    const investor = async (
      as: RoleClient,
      input: { code: string; name: string; userId: string; shareBps: number },
    ) =>
      (
        await call<{ id: string }>(as, 'POST', '/v1/investors', {
          ...input,
          joinedOn: '2025-01-01',
        })
      ).id;

    const alphaA = await investor(accounts, {
      code: 'INV-A',
      name: 'Rahima Akhtar',
      userId: alpha.userId,
      shareBps: 6_000,
    });
    const betaA = await investor(accounts, {
      code: 'INV-B',
      name: 'Shahidul Islam',
      userId: beta.userId,
      shareBps: 4_000,
    });
    const alphaB = await investor(accountsB, {
      code: 'INV-O1',
      name: 'Rahima Akhtar',
      userId: alpha.userId,
      shareBps: 10_000,
    });

    const bankA = await accountIdBySubtype(ORG_A, 'wallet_bank');
    const bankB = await accountIdBySubtype(ORG_B, 'wallet_bank');
    const contribute = (
      as: RoleClient,
      investorId: string,
      walletAccountId: string,
      amountPoisha: string,
      lockInUntil?: string,
    ) =>
      call(as, 'POST', '/v1/investors/investments', {
        investmentId: randomUUID(),
        investorId,
        walletAccountId,
        amountPoisha,
        ...(lockInUntil === undefined ? {} : { lockInUntil }),
      });

    // Alpha: ৳10,00,000 free and ৳2,00,000 locked until 2030 in Elysiam; ৳3,00,000 in Oura.
    await contribute(accounts, alphaA, bankA, '100000000');
    await contribute(accounts, alphaA, bankA, '20000000', '2030-12-31');
    await contribute(accountsB, alphaB, bankB, '30000000');
    // Beta: ৳5,00,000 in Elysiam.
    await contribute(accounts, betaA, bankA, '50000000');

    // Last month's profit, ৳50,000 by agreed share: alpha ৳30,000, beta ৳20,000.
    const declared = await call<{ approvalId: string }>(
      reviewer,
      'POST',
      '/v1/investors/distributions',
      {
        distributionId: randomUUID(),
        month: lastMonth(),
        totalPoisha: '5000000',
        basis: 'share_bps',
        memo: 'E2E profit',
      },
    );
    await call(checker, 'POST', `/v1/approvals/${declared.approvalId}/decide`, {
      decision: 'approved',
    });

    // Alpha: ৳12,000 of profit paid out through the whole flow, and ৳25,000 of capital asked
    // for and not yet reviewed. Beta: ৳7,777 of profit asked for.
    const paid = randomUUID();
    await call(accounts, 'POST', '/v1/investors/withdrawals', {
      withdrawalId: paid,
      investorId: alphaA,
      kind: 'profit',
      amountPoisha: '1200000',
    });
    const reviewed = await call<{ approvalId: string }>(
      reviewer,
      'POST',
      `/v1/investors/withdrawals/${paid}/review`,
      { walletAccountId: bankA },
    );
    await call(checker, 'POST', `/v1/approvals/${reviewed.approvalId}/decide`, {
      decision: 'approved',
    });
    await call(accounts, 'POST', `/v1/investors/withdrawals/${paid}/pay`);

    await call(accounts, 'POST', '/v1/investors/withdrawals', {
      withdrawalId: randomUUID(),
      investorId: alphaA,
      kind: 'capital',
      amountPoisha: '2500000',
    });
    const betaWithdrawal = randomUUID();
    await call(accounts, 'POST', '/v1/investors/withdrawals', {
      withdrawalId: betaWithdrawal,
      investorId: betaA,
      kind: 'profit',
      amountPoisha: '777700',
    });

    const attach = async (
      as: RoleClient,
      orgId: string,
      investorId: string,
      kind: string,
      title: string,
    ) => {
      const fileId = await seedFileObject(orgId, { ownerUserId: as.userId });
      return (
        await call<{ id: string }>(as, 'POST', '/v1/investors/documents', {
          investorId,
          kind,
          title,
          fileId,
        })
      ).id;
    };
    const alphaDocument = await attach(
      accounts,
      ORG_A,
      alphaA,
      'agreement',
      'Investment agreement INV-A',
    );
    const betaDocument = await attach(accounts, ORG_A, betaA, 'kyc', 'National ID INV-B');
    await attach(accountsB, ORG_B, alphaB, 'agreement', 'Investment agreement INV-O1');

    // The stack's own API serves the database from here; this process only keeps it alive.
    await harness.app.close();
    await harness.auth.close();
    appOpen = false;
    const database = harness.database;

    process.stdout.write(
      `${JSON.stringify({
        databaseName: database.databaseName,
        appUrl: database.appUrl,
        ownerUrl: database.ownerUrl,
        analyticsUrl: database.analyticsUrl,
        adminUrl: database.adminUrl,
        password,
        users: [
          { role: 'alpha', email: alpha.email, userId: alpha.userId },
          { role: 'beta', email: beta.email, userId: beta.userId },
        ],
        brands: {
          elysium: { orgId: ORG_A, alpha: alphaA, beta: betaA },
          oura: { orgId: ORG_B, alpha: alphaB },
        },
        documents: { alpha: alphaDocument, beta: betaDocument },
        betaWithdrawal,
      })}\n`,
    );

    // Hold the database open until the run is over; `finally` drops it the harness's way.
    await new Promise<void>((resolve) => {
      let buffered = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk: string) => {
        buffered += chunk;
        if (buffered.includes('stop')) resolve();
      });
      process.stdin.on('end', () => resolve());
    });
  } finally {
    if (appOpen) {
      await harness.app.close().catch(() => undefined);
      await harness.auth.close().catch(() => undefined);
    }
    await harness.database.stop();
  }
}

const [command] = process.argv.slice(2);
const work =
  command === 'create'
    ? create()
    : Promise.reject(new Error('usage: investor-portal-stack.provision.js create'));

work.then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `investor-stack failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  },
);
