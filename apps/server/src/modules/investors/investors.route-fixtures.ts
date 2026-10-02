import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS } from '@elysium/db';

import { accountIdBySubtype, applyInvestorMigrations, seedInvestor } from './investors.testing.js';

/**
 * How the route-matrix suite calls M25's routes (M02b's D-070 gate).
 *
 * `route-matrix.e2e.test.ts` asserts that its fixture keys, the manifest and the
 * application's live routes are the same three sets — so the moment
 * `InvestorsModule` is registered in `app.module.ts`, that suite fails until these
 * exist. They live here rather than in the suite because the suite is one file
 * shared by every milestone building in parallel, and a second write to it silently
 * discards the first; the integrator adds one import and one spread.
 *
 * The fixtures deliberately do **not** try to succeed. The suite's question is
 * which roles the *guard* admits, so a 404 or a 409 from a handler is as good as a
 * 201 — what matters is that it is not a 403. The mutations get a fresh uuid per
 * call, because the suite runs each fixture once per role and the second admitted
 * role must not be answered from the first's row.
 *
 * One fixture is worth explaining: `POST /v1/investors/withdrawals/:id/review`
 * points at a uuid that does not exist, so every admitted role gets a 404. Making
 * it succeed would need a *different* requester per role — the reviewer may not be
 * the requester (0058) — and that is a rule with its own tests, not something to
 * encode in a guard fixture.
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';

interface Fixtures {
  readonly investorId: string;
  readonly walletAccountId: string;
  readonly documentId: string;
  readonly distributionId: string;
}

let prepared: Fixtures | undefined;

/** Called once from the route-matrix suite's `beforeAll`. */
export async function prepareInvestorFixtures(): Promise<void> {
  if (prepared !== undefined) return;
  await applyInvestorMigrations();

  const investorId = await seedInvestor(ORG_A, { code: 'INV-RM', name: 'Route Matrix Backer' });
  const walletAccountId = await accountIdBySubtype(ORG_A, 'wallet_bank');
  // A document row is not seeded: the download fixture points at a uuid that does
  // not exist, which answers 404 for an admitted role and 403 for a denied one —
  // all the matrix asks.
  prepared = {
    investorId,
    walletAccountId,
    documentId: randomUUID(),
    distributionId: randomUUID(),
  };
}

let monthSeq = 0;
/** A distinct, long-past month per call: 2001-01, 2001-02, … */
function freshMonth(): string {
  const index = monthSeq;
  monthSeq += 1;
  return `${String(2001 + Math.floor(index / 12))}-${String((index % 12) + 1).padStart(2, '0')}`;
}

function state(): Fixtures {
  if (prepared === undefined) {
    throw new Error('call prepareInvestorFixtures() in the suite’s beforeAll first');
  }
  return prepared;
}

export const INVESTORS_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/investors': () => ({ url: '/v1/investors' }),
  'POST /v1/investors': () => ({
    url: '/v1/investors',
    // A fresh code per call: the suite runs each fixture once per role, and a
    // duplicate code would answer 409 for the second admitted role.
    body: {
      code: `INV-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Route Matrix Investor',
      joinedOn: '2026-01-01',
    },
  }),
  'GET /v1/investors/wallet-accounts': () => ({ url: '/v1/investors/wallet-accounts' }),
  'GET /v1/investors/login-options': () => ({ url: '/v1/investors/login-options' }),
  'GET /v1/investors/investments': () => ({ url: '/v1/investors/investments' }),
  'POST /v1/investors/investments': () => ({
    url: '/v1/investors/investments',
    body: {
      investmentId: randomUUID(),
      investorId: state().investorId,
      walletAccountId: state().walletAccountId,
      amountPoisha: '100000',
    },
  }),
  'GET /v1/investors/distributions': () => ({ url: '/v1/investors/distributions' }),
  'POST /v1/investors/distributions': () => ({
    url: '/v1/investors/distributions',
    /*
     * A long-past month, so the "has that month ended" check passes, and a distinct
     * one per call: the unique index in 0058 allows one live distribution per period,
     * and the suite calls this once per role.
     *
     * `basis: 'capital'` against an investor with no contributions **fails at the
     * split**, with a 400, before the approval is raised — and that is on purpose.
     * Raising an `investor_distribution` needs the role in `REQUESTER_TYPES`, which
     * lives in the permission matrix this milestone hands to the integrator; until
     * those rows land, reaching the approval would answer 403 for `accounts` and the
     * suite would read it as the guard denying a role the matrix grants. A 400 is as
     * good as a 201 to the matrix — what it asks is that the answer is not 403.
     */
    body: {
      distributionId: randomUUID(),
      month: freshMonth(),
      totalPoisha: '10000',
      basis: 'capital',
    },
  }),
  'GET /v1/investors/distributions/:id': () => ({
    url: `/v1/investors/distributions/${state().distributionId}`,
  }),
  'POST /v1/investors/distributions/:id/reject': () => ({
    url: `/v1/investors/distributions/${state().distributionId}/reject`,
    body: { reason: 'Route matrix' },
  }),
  'GET /v1/investors/withdrawals': () => ({ url: '/v1/investors/withdrawals' }),
  'POST /v1/investors/withdrawals': () => ({
    url: '/v1/investors/withdrawals',
    body: {
      withdrawalId: randomUUID(),
      investorId: state().investorId,
      kind: 'profit',
      amountPoisha: '100',
    },
  }),
  'POST /v1/investors/withdrawals/:id/review': () => ({
    url: `/v1/investors/withdrawals/${randomUUID()}/review`,
    body: { walletAccountId: state().walletAccountId },
  }),
  'POST /v1/investors/withdrawals/:id/pay': () => ({
    url: `/v1/investors/withdrawals/${randomUUID()}/pay`,
  }),
  'POST /v1/investors/withdrawals/:id/reject': () => ({
    url: `/v1/investors/withdrawals/${randomUUID()}/reject`,
    body: { reason: 'Route matrix' },
  }),
  'GET /v1/investors/documents': () => ({ url: '/v1/investors/documents' }),
  'POST /v1/investors/documents': () => ({
    url: '/v1/investors/documents',
    body: {
      investorId: state().investorId,
      kind: 'agreement',
      title: 'Route Matrix Agreement',
      fileId: randomUUID(),
    },
  }),
  'GET /v1/investors/documents/:id/download': () => ({
    url: `/v1/investors/documents/${state().documentId}/download`,
  }),
  'GET /v1/investors/:id': () => ({ url: `/v1/investors/${state().investorId}` }),
  'PATCH /v1/investors/:id': () => ({
    url: `/v1/investors/${state().investorId}`,
    body: { notes: 'Seen by the route matrix.' },
  }),
  'GET /v1/investors/:id/statement': () => ({
    url: `/v1/investors/${state().investorId}/statement?from=2026-01-01&to=2026-12-31`,
  }),
};
