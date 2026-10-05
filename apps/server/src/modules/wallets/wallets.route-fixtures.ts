import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, seedAccountId } from '@elysium/db';

import { applyWalletsMigrations, seedWallet } from './wallets.testing.js';

/**
 * How the route-matrix suite calls M08's routes (M02b's D-070 gate).
 *
 * `route-matrix.e2e.test.ts` asserts that its fixture keys, the manifest and the
 * application's live routes are the same three sets — so the moment `WalletsModule`
 * is registered in `app.module.ts`, that suite fails until these exist. They live
 * here rather than in the suite because the suite is one file shared by every
 * milestone building in parallel, and a second write to it silently discards the
 * first; the integrator adds one import and one spread.
 *
 * The fixtures deliberately do **not** try to succeed. The suite's question is which
 * roles the *guard* admits, so a 404 or a 409 from a handler is as good as a 201 —
 * what matters is that it is not a 403. The exceptions are the mutations, which the
 * suite also checks leave an audit row, so those get real wallets to work on and a
 * fresh id per call: the suite runs each fixture once per role, and every one of
 * these routes is reached by more than one.
 *
 * Two things about this module make its fixtures unlike the others':
 *
 * - **A branch-scoped caller answers 404, not 403.** §6 gives branch_manager
 *   `Wallet` at `branch` scope, and the suite signs its roles in with no branch
 *   memberships — so `assertInScope` refuses every wallet here as "not found"
 *   (which is deliberate: a till you may not see must be indistinguishable from one
 *   that does not exist). That is an *admission* by the guard and the suite reads it
 *   as one, which is exactly the assertion this milestone wants.
 * - **Every closing gets its own business date.** `wallet_closings_org_wallet_date_idx`
 *   is unique on (org, wallet, date), so a shared date would answer 409 to every
 *   role after the first. The dates are in 2019, before anything this suite posts:
 *   the expected balance is derived from journal lines up to the date being closed,
 *   so it is zero, a counted zero balances, and a balanced closing posts no journal
 *   and raises no approval. That keeps this fixture independent of the org's
 *   thresholds and of whichever ledger periods another fixture has closed.
 *
 * `prepare()` is idempotent and cheap after the first call: it applies this
 * milestone's migrations (the journal is integrated separately) and registers the
 * seed's Bank and bKash accounts as wallets.
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';

/** Other income (4300), the one seeded category a `cash_in` may be credited to. */
const INCOME_CATEGORY = seedAccountId(ORG_A, '4300');

/** Upper-case hex, which is a valid ledger account code fragment. */
function token(length = 8): string {
  return randomUUID().replace(/-/g, '').slice(0, length).toUpperCase();
}

let closingIndex = 0;
/** A distinct, long-past business date per call: 2019-01-01, 2019-01-02, … */
function nextClosingDate(): string {
  closingIndex += 1;
  return new Date(Date.UTC(2019, 0, closingIndex)).toISOString().slice(0, 10);
}

interface Fixtures {
  /** The seed's Bank account (1100), org-level: the patch, entry and transfer source. */
  readonly bankWallet: string;
  /** The seed's bKash account (1110): a second wallet, so a transfer has a target. */
  readonly bkashWallet: string;
}

let prepared: Fixtures | undefined;

/** Called once from the route-matrix suite's `beforeAll`, after the harness boots. */
export async function prepareWalletsFixtures(): Promise<void> {
  if (prepared !== undefined) return;
  await applyWalletsMigrations();

  const bank = await seedWallet(ORG_A, '1100', { provider: 'Route Matrix Bank' });
  const bkash = await seedWallet(ORG_A, '1110', { provider: 'bKash' });

  prepared = { bankWallet: bank.id, bkashWallet: bkash.id };
}

function state(): Fixtures {
  if (prepared === undefined) {
    throw new Error('call prepareWalletsFixtures() in the suite’s beforeAll first');
  }
  return prepared;
}

export const WALLETS_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/accounts/wallets': () => ({ url: '/v1/accounts/wallets' }),
  'POST /v1/accounts/wallets': () => ({
    url: '/v1/accounts/wallets',
    /*
     * A new account rather than one that exists, and `wallet_bank` rather than
     * `wallet_cash`. `wallets_org_account_idx` is unique on (org, account), so
     * naming the seed's Bank account would answer 409 for the second admitted
     * role; and hand cash must name a branch, which a fixture cannot do for a
     * caller whose branch scope it does not know.
     */
    body: {
      account: {
        code: `1199-${token()}`,
        name: 'Route matrix bank',
        subtype: 'wallet_bank',
      },
      provider: 'Route Matrix Bank',
      requiresDailyClosing: false,
    },
  }),
  'PATCH /v1/accounts/wallets/:id': () => ({
    url: `/v1/accounts/wallets/${state().bankWallet}`,
    // The provider, never `isActive: false`: deactivating this wallet would make
    // every later cash entry and transfer in the suite answer WALLET_INACTIVE, and
    // the fixture order that hid it would be an accident either way.
    body: { provider: 'Route Matrix Bank' },
  }),

  'GET /v1/accounts/categories': () => ({ url: '/v1/accounts/categories' }),

  'GET /v1/accounts/cash-entries': () => ({ url: '/v1/accounts/cash-entries?to=2030-12-31' }),
  'POST /v1/accounts/cash-entries': () => ({
    url: '/v1/accounts/cash-entries',
    /*
     * `cash_in`, not `petty_cash`. Petty cash is the one kind that goes through
     * maker-checker, so its answer would depend on the org's `wallet_adjustment`
     * threshold — which another fixture in this suite is free to change. A cash in
     * from a known income category is ordinary bookkeeping and posts directly,
     * which is what makes the audit row the suite looks for appear.
     */
    body: {
      entryId: randomUUID(),
      walletId: state().bankWallet,
      kind: 'cash_in',
      categoryAccountId: INCOME_CATEGORY,
      amountPoisha: '1000',
      memo: 'Route matrix',
    },
  }),

  'POST /v1/accounts/transfers': () => ({
    url: '/v1/accounts/transfers',
    // No charge, so no `chargeAccountId` is needed: the schema pairs the two and
    // refuses one without the other.
    body: {
      transferId: randomUUID(),
      fromWalletId: state().bankWallet,
      toWalletId: state().bkashWallet,
      amountPoisha: '100',
      memo: 'Route matrix',
    },
  }),

  'GET /v1/accounts/closings': () => ({ url: '/v1/accounts/closings?to=2030-12-31' }),
  'POST /v1/accounts/closings': () => ({
    url: '/v1/accounts/closings',
    body: {
      closingId: randomUUID(),
      walletId: state().bankWallet,
      businessDate: nextClosingDate(),
      countedPoisha: '0',
    },
  }),

  'GET /v1/accounts/reports/profit-and-loss': () => ({
    url: '/v1/accounts/reports/profit-and-loss?from=2000-01-01&to=2030-12-31',
  }),
  'GET /v1/accounts/reports/balance-sheet': () => ({
    url: '/v1/accounts/reports/balance-sheet?asOf=2030-12-31',
  }),
  'GET /v1/accounts/reports/aging': () => ({
    url: '/v1/accounts/reports/aging?asOf=2030-12-31&side=payable',
  }),
};

/** The manifest entries the integrator appends, derived from the fixtures. */
export const WALLETS_ROUTE_KEYS: readonly string[] = Object.keys(WALLETS_ROUTE_FIXTURES);
