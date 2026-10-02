import { randomUUID } from 'node:crypto';

import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  ORG_B,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { InvestorsModule } from './investors.module.js';
import {
  accountIdBySubtype,
  applyInvestorMigrations,
  seedFileObject,
} from './investors.testing.js';

/**
 * Investors, against a real database (M25 acceptance checks).
 *
 * The three checks, and where each one is:
 *
 * 1. **An investor sees only their own data** — `describe('check 1')`. Two
 *    investors of one org, each with a portal login, and the assertion is in both
 *    directions: the profile, the position, the contributions, the withdrawals, the
 *    documents and the statement. Plus the cross-org pair, because `own` scope and
 *    RLS are different mechanisms and the failure of either looks the same from
 *    outside.
 * 2. **The withdrawal flow posts correctly through approval** — `describe('check
 *    2')`. Requested → reviewed → approved → paid, with the journal asserted
 *    against the ledger's own reports: the investor's payable falls to zero and
 *    the wallet falls by the same amount, computed from `ledger.journal_lines`
 *    rather than from anything this module stored.
 * 3. **Documents are available only through signed URLs** —
 *    `describe('check 3')`. No response anywhere carries a URL until the signing
 *    endpoint is called, and a role without `read Investor` cannot call it.
 *
 * The profit split has its own centre of gravity in
 * `packages/domain/src/investors/split.test.ts`; what is checked here is that the
 * split reaches the ledger intact — the credits on the journal sum to the declared
 * total, to the poisha.
 *
 * ## Why the checker is a super admin
 *
 * `investor_distribution` and `investor_withdrawal` are new approval types, and
 * which *roles* may raise and decide them lives in `CHECKER_TYPES` and
 * `REQUESTER_TYPES` in `packages/contracts/src/permissions/matrix.ts` — a file
 * another agent is editing in this working tree, so this milestone hands those two
 * rows to the integrator instead of writing them. Until then only a platform super
 * admin may raise or decide one (`canDecideType` short-circuits on super admin),
 * so the suite uses two different super admins as reviewer and checker. What is
 * under test is the flow and the journal; which roles reach it is the route-matrix
 * suite's question.
 */

let harness: HttpHarness;
let accounts: RoleClient;
let secondAccounts: RoleClient;
let sales: RoleClient;
let declarer: RoleClient;
let reviewer: RoleClient;
let checker: RoleClient;
let investorA: RoleClient;
let investorB: RoleClient;
let investorOtherOrg: RoleClient;

const ids = { a: '', b: '', otherOrg: '' };
const accountsById = new Map<string, string>();
let bankAccount = '';

beforeAll(async () => {
  // `InvestorsModule` is handed to the harness rather than added to
  // `app.module.ts`: that file is shared with the other milestones building in
  // parallel, and the integrator adds the one import line. Nest builds each module
  // once per application, so this shares the approvals, ledger and files instances
  // `AppModule` already made — which is what makes the executors registered here
  // visible to the approvals route.
  harness = await startHttpHarness('investors', { extraModules: [InvestorsModule] });
  await applyInvestorMigrations();

  accounts = await harness.asRole('accounts', ORG_A);
  secondAccounts = await harness.asRole('accounts', ORG_A);
  sales = await harness.asRole('sales', ORG_A);
  declarer = await makeSuperAdmin();
  reviewer = await makeSuperAdmin();
  checker = await makeSuperAdmin();
  investorA = await harness.asRole('investor', ORG_A);
  investorB = await harness.asRole('investor', ORG_A);
  investorOtherOrg = await harness.asRole('investor', ORG_B);

  bankAccount = await accountIdBySubtype(ORG_A, 'wallet_bank');
  for (const subtype of [
    'wallet_bank',
    'investor_capital',
    'investor_payable',
    'profit_distribution',
  ]) {
    accountsById.set(subtype, await accountIdBySubtype(ORG_A, subtype));
  }

  ids.a = await createInvestor(accounts, {
    code: 'INV-A',
    name: 'Rahima Akhtar',
    userId: investorA.userId,
    shareBps: 6_000,
  });
  ids.b = await createInvestor(accounts, {
    code: 'INV-B',
    name: 'Shahidul Islam',
    userId: investorB.userId,
    shareBps: 4_000,
  });

  // The other org's investor, so check 1 is tested across orgs as well as within
  // one. RLS and `own` scope are different mechanisms with the same symptom.
  const otherAccounts = await harness.asRole('accounts', ORG_B);
  ids.otherOrg = await createInvestor(otherAccounts, {
    code: 'INV-X',
    name: 'Oura Backer',
    userId: investorOtherOrg.userId,
    shareBps: 10_000,
  });

  // ৳10,00,000 and ৳5,00,000 of capital, one lot locked until 2030.
  await contribute(ids.a, '100000000');
  await contribute(ids.b, '50000000', { lockInUntil: '2030-12-31' });
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

// --- helpers -----------------------------------------------------------------

function body<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

/**
 * A platform super admin (§5 exception 3).
 *
 * `is_super_admin` is a column rather than a membership role, and the request
 * context is rebuilt from the session on every request — so flipping it after
 * sign-in is enough, and it also proves the context is not cached.
 */
async function makeSuperAdmin(): Promise<RoleClient> {
  const client = await harness.asRole('accounts', ORG_A);
  await withSystem(async (tx) => {
    await tx.execute(sql`update iam.users set is_super_admin = true where id = ${client.userId}`);
  });
  return client;
}

async function createInvestor(
  as: RoleClient,
  input: { code: string; name: string; userId?: string; shareBps?: number },
): Promise<string> {
  const response = await as.client.request('POST', '/v1/investors', {
    body: {
      code: input.code,
      name: input.name,
      joinedOn: '2025-01-01',
      shareBps: input.shareBps ?? 0,
      ...(input.userId === undefined ? {} : { userId: input.userId }),
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return body<{ id: string }>(response).id;
}

async function contribute(
  investorId: string,
  amountPoisha: string,
  options: { lockInUntil?: string } = {},
): Promise<{ journalId: string }> {
  const response = await accounts.client.request('POST', '/v1/investors/investments', {
    body: {
      investmentId: randomUUID(),
      investorId,
      walletAccountId: bankAccount,
      amountPoisha,
      ...(options.lockInUntil === undefined ? {} : { lockInUntil: options.lockInUntil }),
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return body<{ journalId: string }>(response);
}

/** A balance straight from the journal lines, which nothing in this module stores. */
async function ledgerBalance(accountId: string, partyId?: string): Promise<bigint> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ balance: string }>(sql`
        select coalesce(sum(debit_poisha) - sum(credit_poisha), 0)::text as balance
        from ledger.journal_lines
        where org_id = ${ORG_A} and account_id = ${accountId}
          and ${partyId === undefined ? sql`true` : sql`party_id = ${partyId}`}
      `);
      return BigInt(rows[0]?.balance ?? '0');
    },
    { orgId: ORG_A },
  );
}

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

async function decide(approvalId: string, decision: 'approved' | 'rejected'): Promise<void> {
  const response = await checker.client.request('POST', `/v1/approvals/${approvalId}/decide`, {
    body: { decision },
  });
  expect(response.statusCode, response.body).toBe(201);
}

// --- check 1 -----------------------------------------------------------------

describe('check 1: an investor sees only their own data', () => {
  it('shows an investor exactly one row — their own', async () => {
    const response = await investorA.client.request('GET', '/v1/investors');
    expect(response.statusCode, response.body).toBe(200);
    const listed = body<{ items: { id: string; code: string }[] }>(response);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.id).toBe(ids.a);
  });

  it('answers "no such investor" for another investor of the same org', async () => {
    // 404 rather than 403, and deliberately identical to a uuid that does not
    // exist: any other answer tells one investor that the other one is there.
    const other = await investorA.client.request('GET', `/v1/investors/${ids.b}`);
    const missing = await investorA.client.request('GET', `/v1/investors/${randomUUID()}`);
    expect(other.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(body<{ message: string }>(other).message).toBe(
      body<{ message: string }>(missing).message,
    );
  });

  it('refuses another investor’s statement and contributions', async () => {
    const statement = await investorA.client.request(
      'GET',
      `/v1/investors/${ids.b}/statement?from=2025-01-01&to=2030-12-31`,
    );
    expect(statement.statusCode).toBe(404);

    const contributions = await investorA.client.request(
      'GET',
      `/v1/investors/investments?investorId=${ids.b}`,
    );
    expect(contributions.statusCode).toBe(200);
    // Not an error — a filter for somebody else's rows simply matches none. The
    // scope is applied to the query, so there is nothing to refuse.
    expect(body<{ items: unknown[] }>(contributions).items).toHaveLength(0);

    const own = await investorA.client.request('GET', '/v1/investors/investments');
    expect(
      body<{ items: { investorId: string }[] }>(own).items.every((r) => r.investorId === ids.a),
    ).toBe(true);
  });

  it('shows an investor their own position, derived from their own lots', async () => {
    const response = await investorA.client.request('GET', `/v1/investors/${ids.a}`);
    expect(response.statusCode, response.body).toBe(200);
    const view = body<{ position: { capitalPoisha: string; lockedPoisha: string } }>(response);
    expect(view.position.capitalPoisha).toBe('100000000');
    expect(view.position.lockedPoisha).toBe('0');
  });

  it('applies lock-in per contribution', async () => {
    const response = await investorB.client.request('GET', `/v1/investors/${ids.b}`);
    const view = body<{
      position: { capitalPoisha: string; lockedPoisha: string; withdrawableCapitalPoisha: string };
    }>(response);
    expect(view.position.capitalPoisha).toBe('50000000');
    expect(view.position.lockedPoisha).toBe('50000000');
    expect(view.position.withdrawableCapitalPoisha).toBe('0');
  });

  it('shows another org’s investor nothing at all', async () => {
    // RLS, not scope: the row is in a different org, so it does not exist for
    // this session however the query is written.
    const list = await investorOtherOrg.client.request('GET', '/v1/investors');
    expect(body<{ items: { id: string }[] }>(list).items.map((r) => r.id)).toEqual([ids.otherOrg]);

    const reach = await investorOtherOrg.client.request('GET', `/v1/investors/${ids.a}`);
    expect(reach.statusCode).toBe(404);
  });

  it('lets an investor read but never write', async () => {
    const created = await investorA.client.request('POST', '/v1/investors', {
      body: { code: 'INV-SELF', name: 'Myself', joinedOn: '2026-01-01' },
    });
    expect(created.statusCode).toBe(403);

    const patched = await investorA.client.request('PATCH', `/v1/investors/${ids.a}`, {
      body: { name: 'Renamed' },
    });
    expect(patched.statusCode).toBe(403);
  });

  it('keeps investors out of a role that holds no Investor grant at all', async () => {
    const response = await sales.client.request('GET', '/v1/investors');
    expect(response.statusCode).toBe(403);
  });

  it('never shows an investor the org’s distribution records', async () => {
    /*
     * A distribution's total is what the company declared and its lines say what
     * every investor got. Narrowing it per caller would mean showing an investor a
     * total that is not theirs and a line list with everybody else's removed, which
     * is a worse answer than none — their own share is on their statement. So the
     * two distribution endpoints refuse anyone whose reach is narrower than the org.
     */
    const list = await investorA.client.request('GET', '/v1/investors/distributions');
    expect(list.statusCode).toBe(403);
    const one = await investorA.client.request(
      'GET',
      `/v1/investors/distributions/${randomUUID()}`,
    );
    expect(one.statusCode).toBe(403);
  });

  it('keeps the brand’s own notes about an investor from that investor (D-315)', async () => {
    const note = 'Prefers calls after six';
    const patched = await accounts.client.request('PATCH', `/v1/investors/${ids.a}`, {
      body: { notes: note },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const staff = await accounts.client.request('GET', `/v1/investors/${ids.a}`);
    expect(body<{ notes: string | null }>(staff).notes).toBe(note);

    for (const path of [
      `/v1/investors/${ids.a}`,
      '/v1/investors',
      `/v1/investors/${ids.a}/statement?from=2020-01-01&to=2099-12-31`,
    ]) {
      const response = await investorA.client.request('GET', path);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body, path).not.toContain(note);
    }
    expect(
      body<{ notes: string | null }>(
        await investorA.client.request('GET', `/v1/investors/${ids.a}`),
      ).notes,
    ).toBeNull();
  });

  it('never shows an investor the org’s wallet accounts', async () => {
    // `create Investor`, not `read Investor`: enumerating the brand's bank and
    // bKash accounts is not something an investor's own position needs.
    const response = await investorA.client.request('GET', '/v1/investors/wallet-accounts');
    expect(response.statusCode).toBe(403);
  });
});

// --- the split reaching the ledger -------------------------------------------

describe('a declared distribution splits to the poisha and posts one journal', () => {
  it('waits for a checker, then posts one debit and one credit per investor', async () => {
    const distributionId = randomUUID();
    // ৳3,333.33 — chosen because 60/40 of 333333 poisha does not divide evenly,
    // so the largest-remainder allocation is what makes the journal balance.
    const declared = await declarer.client.request('POST', '/v1/investors/distributions', {
      body: {
        distributionId,
        month: '2026-08',
        totalPoisha: '333333',
        basis: 'share_bps',
        memo: 'August profit',
      },
    });
    expect(declared.statusCode, declared.body).toBe(201);
    const result = body<{
      status: string;
      approvalId: string;
      journalId: string | null;
      lines: { investorId: string; amountPoisha: string }[];
    }>(declared);

    expect(result.status).toBe('pending_approval');
    // Nothing posted: no threshold can exempt an investor distribution.
    expect(result.journalId).toBeNull();
    expect(result.lines.reduce((total, line) => total + BigInt(line.amountPoisha), 0n)).toBe(
      333_333n,
    );
    expect(result.lines.map((line) => line.amountPoisha).sort()).toEqual(['133333', '200000']);

    const payableBefore = await ledgerBalance(accountsById.get('investor_payable') ?? '');
    expect(payableBefore).toBe(0n);

    await decide(result.approvalId, 'approved');

    const after = await accounts.client.request(
      'GET',
      `/v1/investors/distributions/${distributionId}`,
    );
    const view = body<{ status: string; journalId: string; declaredOn: string }>(after);
    expect(view.status).toBe('declared');
    expect(view.journalId).not.toBeNull();

    // The journal, read from the ledger: Dr profit distribution 333333,
    // Cr investor payable 333333 across two party lines.
    const distributionBalance = await ledgerBalance(accountsById.get('profit_distribution') ?? '');
    expect(distributionBalance).toBe(333_333n);
    expect(await ledgerBalance(accountsById.get('investor_payable') ?? '')).toBe(-333_333n);
    expect(await ledgerBalance(accountsById.get('investor_payable') ?? '', ids.a)).toBe(-200_000n);
    expect(await ledgerBalance(accountsById.get('investor_payable') ?? '', ids.b)).toBe(-133_333n);
  });

  it('refuses a month that has not ended yet', async () => {
    const response = await declarer.client.request('POST', '/v1/investors/distributions', {
      body: {
        distributionId: randomUUID(),
        month: '2099-01',
        totalPoisha: '1000',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(body<{ code: string }>(response).code).toBe('INVESTOR_SPLIT_INVALID');
  });

  it('refuses a second live distribution for the same month', async () => {
    const first = await declarer.client.request('POST', '/v1/investors/distributions', {
      body: { distributionId: randomUUID(), month: '2026-07', totalPoisha: '5000' },
    });
    expect(first.statusCode, first.body).toBe(201);

    const second = await declarer.client.request('POST', '/v1/investors/distributions', {
      body: { distributionId: randomUUID(), month: '2026-07', totalPoisha: '5000' },
    });
    // The unique index in 0058: two rows claiming one month's profit is a
    // duplicate submit, not a top-up.
    expect(second.statusCode).toBe(409);
  });

  it('leaves a rejected declaration with no journal and no payable', async () => {
    const distributionId = randomUUID();
    const declared = await declarer.client.request('POST', '/v1/investors/distributions', {
      body: { distributionId, month: '2026-06', totalPoisha: '9999' },
    });
    const { approvalId } = body<{ approvalId: string }>(declared);
    const payableBefore = await ledgerBalance(accountsById.get('investor_payable') ?? '');

    await decide(approvalId, 'rejected');

    const after = await accounts.client.request(
      'GET',
      `/v1/investors/distributions/${distributionId}`,
    );
    expect(body<{ status: string; journalId: string | null }>(after).journalId).toBeNull();
    expect(await ledgerBalance(accountsById.get('investor_payable') ?? '')).toBe(payableBefore);

    /*
     * And the month can be declared again — which it cannot while the refused row
     * sits at `pending_approval`, because 0058's unique index allows one live
     * distribution per period. An executor runs only on approval, so closing the
     * row is a deliberate step.
     */
    const blocked = await declarer.client.request('POST', '/v1/investors/distributions', {
      body: { distributionId: randomUUID(), month: '2026-06', totalPoisha: '9999' },
    });
    expect(blocked.statusCode).toBe(409);

    const closed = await declarer.client.request(
      'POST',
      `/v1/investors/distributions/${distributionId}/reject`,
      { body: { reason: 'The checker refused it' } },
    );
    expect(closed.statusCode, closed.body).toBe(201);
    expect(body<{ status: string }>(closed).status).toBe('rejected');

    const reDeclared = await declarer.client.request('POST', '/v1/investors/distributions', {
      body: { distributionId: randomUUID(), month: '2026-06', totalPoisha: '4444' },
    });
    expect(reDeclared.statusCode, reDeclared.body).toBe(201);
    const reDeclaredId = body<{ distributionId: string }>(reDeclared).distributionId;
    await declarer.client.request(`POST`, `/v1/investors/distributions/${reDeclaredId}/reject`, {
      body: { reason: 'Tidying up after the test' },
    });
  });

  it('refuses to reject a declared distribution', async () => {
    // A declared distribution has a journal behind it, and invariant 2 says a posted
    // journal is undone by a reversal rather than by a status change.
    const listed = await accounts.client.request('GET', '/v1/investors/distributions');
    const declared = body<{ items: { id: string; status: string }[] }>(listed).items.find(
      (item) => item.status === 'declared',
    );
    expect(declared, 'the suite declared one earlier').toBeDefined();

    const response = await declarer.client.request(
      'POST',
      `/v1/investors/distributions/${declared?.id ?? ''}/reject`,
      { body: { reason: 'Changed our minds' } },
    );
    expect(response.statusCode).toBe(409);
    expect(body<{ code: string }>(response).code).toBe('INVESTOR_DISTRIBUTION_FROZEN');
  });
});

// --- check 2 -----------------------------------------------------------------

describe('check 2: the withdrawal flow posts correctly through approval', () => {
  it('goes requested → reviewed → approved → paid, posting only at the end', async () => {
    const withdrawalId = randomUUID();
    const payable = accountsById.get('investor_payable') ?? '';
    const wallet = accountsById.get('wallet_bank') ?? '';

    const requested = await accounts.client.request('POST', '/v1/investors/withdrawals', {
      body: {
        withdrawalId,
        investorId: ids.a,
        kind: 'profit',
        amountPoisha: '200000',
        reason: 'August distribution payout',
      },
    });
    expect(requested.statusCode, requested.body).toBe(201);
    expect(body<{ status: string }>(requested).status).toBe('requested');

    // Paying before approval is refused, and the refusal names the reason.
    const early = await accounts.client.request(
      'POST',
      `/v1/investors/withdrawals/${withdrawalId}/pay`,
    );
    expect(early.statusCode).toBe(409);
    expect(body<{ code: string }>(early).code).toBe('APPROVAL_REQUIRED');

    // The requester may not review their own request: the maker-checker rule
    // starts here, and the database holds it too (0058).
    const selfReview = await accounts.client.request(
      'POST',
      `/v1/investors/withdrawals/${withdrawalId}/review`,
      { body: { walletAccountId: wallet } },
    );
    expect(selfReview.statusCode).toBe(403);

    const reviewed = await reviewer.client.request(
      'POST',
      `/v1/investors/withdrawals/${withdrawalId}/review`,
      { body: { walletAccountId: wallet, note: 'Position covers it' } },
    );
    expect(reviewed.statusCode, reviewed.body).toBe(201);
    const { approvalId, status } = body<{ approvalId: string; status: string }>(reviewed);
    expect(status).toBe('reviewed');

    const payableBefore = await ledgerBalance(payable, ids.a);
    const walletBefore = await ledgerBalance(wallet);

    await decide(approvalId, 'approved');

    const approved = await accounts.client.request(
      'GET',
      `/v1/investors/withdrawals?investorId=${ids.a}`,
    );
    const row = body<{ items: { id: string; status: string; journalId: string | null }[] }>(
      approved,
    ).items.find((item) => item.id === withdrawalId);
    expect(row?.status).toBe('approved');
    // An approval is a decision, not a payment: nothing has moved yet.
    expect(row?.journalId).toBeNull();
    expect(await ledgerBalance(payable, ids.a)).toBe(payableBefore);

    const paid = await accounts.client.request(
      'POST',
      `/v1/investors/withdrawals/${withdrawalId}/pay`,
    );
    expect(paid.statusCode, paid.body).toBe(201);
    const paidRow = body<{ status: string; journalId: string; paidOn: string }>(paid);
    expect(paidRow.status).toBe('paid');
    expect(paidRow.journalId).not.toBeNull();

    // Dr investor payable / Cr bank, for exactly the approved amount. Both read
    // from the journal lines, not from anything this module stored.
    expect(await ledgerBalance(payable, ids.a)).toBe(payableBefore + 200_000n);
    expect(await ledgerBalance(wallet)).toBe(walletBefore - 200_000n);

    // Paid is terminal, and a second Pay is answered from the row rather than
    // posting again.
    const again = await accounts.client.request(
      'POST',
      `/v1/investors/withdrawals/${withdrawalId}/pay`,
    );
    expect(again.statusCode, again.body).toBe(201);
    expect(body<{ journalId: string }>(again).journalId).toBe(paidRow.journalId);
    expect(await ledgerBalance(wallet)).toBe(walletBefore - 200_000n);
  });

  it('returns capital against the capital account, not the payable', async () => {
    const withdrawalId = randomUUID();
    const capital = accountsById.get('investor_capital') ?? '';
    const wallet = accountsById.get('wallet_bank') ?? '';
    const capitalBefore = await ledgerBalance(capital, ids.a);

    const requested = await accounts.client.request('POST', '/v1/investors/withdrawals', {
      body: { withdrawalId, investorId: ids.a, kind: 'capital', amountPoisha: '1000000' },
    });
    expect(requested.statusCode, requested.body).toBe(201);

    const reviewed = await reviewer.client.request(
      'POST',
      `/v1/investors/withdrawals/${withdrawalId}/review`,
      { body: { walletAccountId: wallet } },
    );
    await decide(body<{ approvalId: string }>(reviewed).approvalId, 'approved');
    const paid = await accounts.client.request(
      'POST',
      `/v1/investors/withdrawals/${withdrawalId}/pay`,
    );
    expect(paid.statusCode, paid.body).toBe(201);

    // Equity down by ৳10,000; the payable untouched. Paying capital out of the
    // payable would have left the company still showing the debt.
    expect(await ledgerBalance(capital, ids.a)).toBe(capitalBefore + 1_000_000n);
  });

  it('refuses more than the investor holds, and says which limit it hit', async () => {
    const tooMuch = await accounts.client.request('POST', '/v1/investors/withdrawals', {
      body: {
        withdrawalId: randomUUID(),
        investorId: ids.a,
        kind: 'profit',
        amountPoisha: '999999999',
      },
    });
    expect(tooMuch.statusCode).toBe(409);
    expect(body<{ code: string }>(tooMuch).code).toBe('INVESTOR_POSITION_INSUFFICIENT');

    // Investor B's only capital is locked until 2030, so this is "not yet"
    // rather than "not at all" — a different conversation, and a different code.
    const locked = await accounts.client.request('POST', '/v1/investors/withdrawals', {
      body: {
        withdrawalId: randomUUID(),
        investorId: ids.b,
        kind: 'capital',
        amountPoisha: '1000',
      },
    });
    expect(locked.statusCode).toBe(409);
    expect(body<{ code: string }>(locked).code).toBe('INVESTOR_CAPITAL_LOCKED');
  });

  it('counts requests already in flight against the position', async () => {
    // Two requests that each fit but together do not. The second is refused at
    // the door rather than approved and paid out of nothing.
    const investorId = await createInvestor(accounts, { code: 'INV-C', name: 'Nasima Begum' });
    await contribute(investorId, '1000000');

    const first = await accounts.client.request('POST', '/v1/investors/withdrawals', {
      body: { withdrawalId: randomUUID(), investorId, kind: 'capital', amountPoisha: '800000' },
    });
    expect(first.statusCode, first.body).toBe(201);

    const second = await accounts.client.request('POST', '/v1/investors/withdrawals', {
      body: { withdrawalId: randomUUID(), investorId, kind: 'capital', amountPoisha: '800000' },
    });
    expect(second.statusCode).toBe(409);
  });

  it('lets only one of two simultaneous requests through', async () => {
    /*
     * The one the sequential test cannot catch. Both requests read the position and
     * then write, and without a lock on the investor both see an empty queue: two
     * ৳8,00,000 requests against ৳10,00,000 of capital would both be accepted, and
     * the pair would then exceed what the investor holds with no way to tell which
     * was the mistake. `lockInvestor` serialises them, so the second sees the first.
     */
    const investorId = await createInvestor(accounts, { code: 'INV-RACE', name: 'Race Backer' });
    await contribute(investorId, '1000000');

    const body_ = { investorId, kind: 'capital' as const, amountPoisha: '800000' };
    const [first, second] = await Promise.all([
      accounts.client.request('POST', '/v1/investors/withdrawals', {
        body: { withdrawalId: randomUUID(), ...body_ },
      }),
      accounts.client.request('POST', '/v1/investors/withdrawals', {
        body: { withdrawalId: randomUUID(), ...body_ },
      }),
    ]);

    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes, `${first.body} / ${second.body}`).toEqual([201, 409]);
  });

  it('leaves a rejected withdrawal unpaid, unpostable and closable', async () => {
    const withdrawalId = randomUUID();
    const wallet = accountsById.get('wallet_bank') ?? '';
    // Investor B, whose declared profit is still unpaid: A's was paid out above,
    // and a test that depends on an earlier one's leftovers is a test that breaks
    // when somebody reorders them.
    const requested = await accounts.client.request('POST', '/v1/investors/withdrawals', {
      body: { withdrawalId, investorId: ids.b, kind: 'profit', amountPoisha: '1000' },
    });
    expect(requested.statusCode, requested.body).toBe(201);
    const reviewed = await reviewer.client.request(
      'POST',
      `/v1/investors/withdrawals/${withdrawalId}/review`,
      { body: { walletAccountId: wallet } },
    );
    await decide(body<{ approvalId: string }>(reviewed).approvalId, 'rejected');

    const paid = await accounts.client.request(
      'POST',
      `/v1/investors/withdrawals/${withdrawalId}/pay`,
    );
    expect(paid.statusCode).toBe(409);

    /*
     * And the row can be **closed**. This is the important half: an executor runs
     * only on approval, so a rejected approval leaves the withdrawal at `reviewed`
     * — and `reviewed` counts against the investor's own headroom. Without a way to
     * close it, every refusal would permanently reduce what that investor can ever
     * withdraw, by the refused amount.
     */
    const stuck = await accounts.client.request(
      'GET',
      `/v1/investors/withdrawals?investorId=${ids.b}`,
    );
    const before = body<{ items: { id: string; status: string }[] }>(stuck).items.find(
      (item) => item.id === withdrawalId,
    );
    expect(before?.status).toBe('reviewed');

    const closed = await accounts.client.request(
      'POST',
      `/v1/investors/withdrawals/${withdrawalId}/reject`,
      { body: { reason: 'The checker refused it' } },
    );
    expect(closed.statusCode, closed.body).toBe(201);
    expect(body<{ status: string }>(closed).status).toBe('rejected');

    // Closing it gives the headroom back: a fresh request for the same money is
    // accepted again.
    const again = await accounts.client.request('POST', '/v1/investors/withdrawals', {
      body: {
        withdrawalId: randomUUID(),
        investorId: ids.b,
        kind: 'profit',
        amountPoisha: '1000',
      },
    });
    expect(again.statusCode, again.body).toBe(201);
    await accounts.client.request(
      'POST',
      `/v1/investors/withdrawals/${body<{ id: string }>(again).id}/reject`,
      { body: { reason: 'Tidying up after the test' } },
    );
  });

  it('refuses to reject a paid withdrawal', async () => {
    // A payment is undone by a reversal, not by a status change (invariant 2).
    const listed = await accounts.client.request('GET', '/v1/investors/withdrawals?status=paid');
    const paid = body<{ items: { id: string }[] }>(listed).items[0];
    expect(paid, 'the suite paid one earlier').toBeDefined();

    const response = await accounts.client.request(
      'POST',
      `/v1/investors/withdrawals/${paid?.id ?? ''}/reject`,
      { body: { reason: 'Changed our minds' } },
    );
    expect(response.statusCode).toBe(409);
    expect(body<{ code: string }>(response).code).toBe('INVESTOR_WITHDRAWAL_FROZEN');
  });

  it('answers a second Close from the row rather than refusing', async () => {
    const withdrawalId = randomUUID();
    const requested = await accounts.client.request('POST', '/v1/investors/withdrawals', {
      body: { withdrawalId, investorId: ids.b, kind: 'profit', amountPoisha: '500' },
    });
    expect(requested.statusCode, requested.body).toBe(201);

    const first = await accounts.client.request(
      'POST',
      `/v1/investors/withdrawals/${withdrawalId}/reject`,
      { body: { reason: 'Withdrawn by the investor' } },
    );
    expect(first.statusCode, first.body).toBe(201);
    // A double-clicked Close answers from the row rather than refusing.
    const second = await accounts.client.request(
      'POST',
      `/v1/investors/withdrawals/${withdrawalId}/reject`,
      { body: {} },
    );
    expect(second.statusCode, second.body).toBe(201);
    expect(body<{ status: string }>(second).status).toBe('rejected');
  });

  it('cannot be approved by the person who asked for it', async () => {
    /*
     * Three people, not two. The approvals module keeps the decider apart from the
     * reviewer (who raised the approval) and 0058 keeps the reviewer apart from the
     * requester — neither compares the decider with the requester, so
     * A-requests, B-reviews, A-approves was allowed until the executor checked.
     */
    const withdrawalId = randomUUID();
    const wallet = accountsById.get('wallet_bank') ?? '';
    const requested = await checker.client.request('POST', '/v1/investors/withdrawals', {
      body: { withdrawalId, investorId: ids.b, kind: 'profit', amountPoisha: '700' },
    });
    expect(requested.statusCode, requested.body).toBe(201);

    const reviewed = await reviewer.client.request(
      'POST',
      `/v1/investors/withdrawals/${withdrawalId}/review`,
      { body: { walletAccountId: wallet } },
    );
    expect(reviewed.statusCode, reviewed.body).toBe(201);

    // `checker` asked for this one, so `checker` may not decide it.
    const decided = await checker.client.request(
      'POST',
      `/v1/approvals/${body<{ approvalId: string }>(reviewed).approvalId}/decide`,
      { body: { decision: 'approved' } },
    );
    expect(decided.statusCode).toBe(403);

    // Nothing moved, and the row is still waiting.
    const after = await accounts.client.request(
      'GET',
      `/v1/investors/withdrawals?investorId=${ids.b}`,
    );
    const row = body<{ items: { id: string; status: string }[] }>(after).items.find(
      (item) => item.id === withdrawalId,
    );
    expect(row?.status).toBe('reviewed');

    await accounts.client.request('POST', `/v1/investors/withdrawals/${withdrawalId}/reject`, {
      body: { reason: 'Tidying up after the test' },
    });
  });

  it('never lets the investor being paid raise, review, approve or pay it (D-314)', async () => {
    // Staff in this brand who are also one of its investors: the roles a login may hold.
    const insider = await harness.asRole(['accounts', 'investor'], ORG_A);
    const wallet = accountsById.get('wallet_bank') ?? '';
    const investorId = await createInvestor(accounts, {
      code: 'INV-S',
      name: 'Staff Investor',
      userId: insider.userId,
    });
    await contribute(investorId, '1000000');

    const own = await insider.client.request('POST', '/v1/investors/withdrawals', {
      body: { withdrawalId: randomUUID(), investorId, kind: 'capital', amountPoisha: '100000' },
    });
    expect(own.statusCode, own.body).toBe(403);
    // Refused for being the beneficiary, not for any other reason (D-314).
    expect(own.body).toContain('by the investor it pays');

    const withdrawalId = randomUUID();
    const requested = await accounts.client.request('POST', '/v1/investors/withdrawals', {
      body: { withdrawalId, investorId, kind: 'capital', amountPoisha: '100000' },
    });
    expect(requested.statusCode, requested.body).toBe(201);

    const selfReview = await insider.client.request(
      'POST',
      `/v1/investors/withdrawals/${withdrawalId}/review`,
      { body: { walletAccountId: wallet } },
    );
    expect(selfReview.statusCode, selfReview.body).toBe(403);
    // Refused for being the beneficiary, not for any other reason (D-314).
    expect(selfReview.body).toContain('by the investor it pays');

    const reviewed = await reviewer.client.request(
      'POST',
      `/v1/investors/withdrawals/${withdrawalId}/review`,
      { body: { walletAccountId: wallet } },
    );
    expect(reviewed.statusCode, reviewed.body).toBe(201);
    const { approvalId } = body<{ approvalId: string }>(reviewed);

    // Accounts may decide an investor withdrawal (D-119) — but not this one.
    const selfApproval = await insider.client.request(
      'POST',
      `/v1/approvals/${approvalId}/decide`,
      { body: { decision: 'approved' } },
    );
    expect(selfApproval.statusCode, selfApproval.body).toBe(403);
    // Refused for being the beneficiary, not for any other reason (D-314).
    expect(selfApproval.body).toContain('by the investor it pays');

    await decide(approvalId, 'approved');

    const selfPay = await insider.client.request(
      'POST',
      `/v1/investors/withdrawals/${withdrawalId}/pay`,
    );
    expect(selfPay.statusCode, selfPay.body).toBe(403);
    // Refused for being the beneficiary, not for any other reason (D-314).
    expect(selfPay.body).toContain('by the investor it pays');

    const paid = await accounts.client.request(
      'POST',
      `/v1/investors/withdrawals/${withdrawalId}/pay`,
    );
    expect(paid.statusCode, paid.body).toBe(201);
    expect(body<{ status: string }>(paid).status).toBe('paid');
  });

  it('refuses a review that names an account which is not a wallet', async () => {
    // Caught at review rather than at payment: the posting rule and the trigger
    // both fire days later, and the reviewer is the person who can still fix it.
    const withdrawalId = randomUUID();
    const requested = await accounts.client.request('POST', '/v1/investors/withdrawals', {
      body: { withdrawalId, investorId: ids.b, kind: 'profit', amountPoisha: '300' },
    });
    expect(requested.statusCode, requested.body).toBe(201);

    const reviewed = await reviewer.client.request(
      'POST',
      `/v1/investors/withdrawals/${withdrawalId}/review`,
      { body: { walletAccountId: accountsById.get('investor_payable') ?? '' } },
    );
    expect(reviewed.statusCode).toBe(400);
    expect(body<{ code: string }>(reviewed).code).toBe('LEDGER_ACCOUNT_INVALID');

    await accounts.client.request('POST', `/v1/investors/withdrawals/${withdrawalId}/reject`, {
      body: { reason: 'Tidying up after the test' },
    });
  });

  it('refuses to change the amount of a withdrawal after it exists', async () => {
    // The terms a checker saw are frozen by a trigger (0060), not only by the
    // absence of a route. Written directly, as a future repair script would.
    const withdrawalId = randomUUID();
    const requested = await accounts.client.request('POST', '/v1/investors/withdrawals', {
      body: { withdrawalId, investorId: ids.b, kind: 'profit', amountPoisha: '500' },
    });
    expect(requested.statusCode, requested.body).toBe(201);

    await expectRefused(
      withSystem(
        async (tx) => {
          await tx.execute(sql`
            update investors.withdrawals set amount_poisha = 500000
            where org_id = ${ORG_A} and id = ${withdrawalId}
          `);
        },
        { orgId: ORG_A },
      ),
      /INVESTOR_WITHDRAWAL_FROZEN/,
    );
  });

  it('refuses a distribution whose lines do not sum to its total', async () => {
    // The deferred trigger in 0060, which is the split invariant in the database.
    // Written directly: the service cannot produce this, and that is the point.
    const distributionId = randomUUID();
    await expectRefused(
      withSystem(
        async (tx) => {
          await tx.execute(sql`
            insert into approvals.approval_requests (org_id, type, status, requested_by, amount_poisha)
            values (${ORG_A}, 'investor_withdrawal', 'pending', 'seed', 1000)
          `);
          const approval = await tx.execute<{ id: string }>(sql`
            select id from approvals.approval_requests
            where org_id = ${ORG_A} order by created_at desc limit 1
          `);
          await tx.execute(sql`
            insert into investors.distributions
              (org_id, id, period_starts_on, period_ends_on, total_poisha, basis, status,
               approval_request_id, created_by)
            values (${ORG_A}, ${distributionId}, '2026-05-01', '2026-05-31', 1000, 'share_bps',
                    'pending_approval', ${approval[0]?.id ?? null}, 'seed')
          `);
          await tx.execute(sql`
            insert into investors.distribution_lines (org_id, distribution_id, investor_id, weight, amount_poisha)
            values (${ORG_A}, ${distributionId}, ${ids.a}, 1, 999)
          `);
        },
        { orgId: ORG_A },
      ),
      /INVESTOR_SPLIT_INVALID/,
    );
  });
});

// --- check 1, once both investors have withdrawals ----------------------------

describe('check 1: an investor’s withdrawal list holds only their own requests', () => {
  /*
   * After check 2 both investors have requests on file — paid, reviewed and
   * rejected ones — so a list that leaked would have something to leak. At check
   * 1's own point in the file investor B has none yet.
   */
  it('lists only the caller’s requests, and nothing when filtered to another investor', async () => {
    const mine = body<{ items: { investorId: string }[] }>(
      await investorA.client.request('GET', '/v1/investors/withdrawals'),
    ).items;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((row) => row.investorId === ids.a)).toBe(true);

    const theirs = body<{ items: { investorId: string }[] }>(
      await investorB.client.request('GET', '/v1/investors/withdrawals'),
    ).items;
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every((row) => row.investorId === ids.b)).toBe(true);

    const reached = await investorA.client.request(
      'GET',
      `/v1/investors/withdrawals?investorId=${ids.b}`,
    );
    expect(reached.statusCode).toBe(200);
    expect(body<{ items: unknown[] }>(reached).items).toHaveLength(0);
  });
});

// --- check 3 -----------------------------------------------------------------

describe('check 3: documents are available only through signed URLs', () => {
  let documentId = '';

  it('attaches a stored, private, investor-document file', async () => {
    const fileId = await seedFileObject(ORG_A, { ownerUserId: accounts.userId });
    const response = await accounts.client.request('POST', '/v1/investors/documents', {
      body: { investorId: ids.a, kind: 'agreement', title: 'Investment agreement', fileId },
    });
    expect(response.statusCode, response.body).toBe(201);
    const view = body<{ id: string; fileId: string }>(response);
    documentId = view.id;
    expect(view.fileId).toBe(fileId);
    // No URL anywhere in the response, and none in the row either.
    expect(response.body).not.toContain('http');
  });

  it('refuses a public file, and a file of another purpose', async () => {
    const publicFile = await seedFileObject(ORG_A, {
      ownerUserId: accounts.userId,
      visibility: 'public',
      purpose: 'product-image',
    });
    const response = await accounts.client.request('POST', '/v1/investors/documents', {
      body: { investorId: ids.a, kind: 'kyc', title: 'NID', fileId: publicFile },
    });
    expect(response.statusCode).toBe(400);
    expect(body<{ code: string }>(response).code).toBe('INVESTOR_DOCUMENT_INVALID');
  });

  it('lists documents as ids only, never as URLs', async () => {
    const response = await investorA.client.request('GET', '/v1/investors/documents');
    expect(response.statusCode, response.body).toBe(200);
    const listed = body<{ items: { id: string; fileId: string }[] }>(response);
    expect(listed.items).toHaveLength(1);
    expect(response.body).not.toContain('http');
  });

  it('mints a short-lived URL for the investor it belongs to', async () => {
    const response = await investorA.client.request(
      'GET',
      `/v1/investors/documents/${documentId}/download`,
    );
    expect(response.statusCode, response.body).toBe(200);
    const signed = body<{ url: string; expiresAt: string }>(response);
    expect(signed.url).toMatch(/^https?:\/\//);
    // A bearer token: no cache between here and the browser may keep a copy of it.
    expect(String(response.headers['cache-control'])).toContain('no-store');
    // A signed URL is a bearer token, so it has to die. The files module's TTL.
    expect(new Date(signed.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses another investor’s document, as if it did not exist', async () => {
    const response = await investorB.client.request(
      'GET',
      `/v1/investors/documents/${documentId}/download`,
    );
    expect(response.statusCode).toBe(404);
  });

  it('refuses a role with no Investor grant', async () => {
    const response = await sales.client.request(
      'GET',
      `/v1/investors/documents/${documentId}/download`,
    );
    expect(response.statusCode).toBe(403);
  });
});

// --- the statement -----------------------------------------------------------

describe('statements', () => {
  it('lists every movement with the journal behind it', async () => {
    const response = await accounts.client.request(
      'GET',
      `/v1/investors/${ids.a}/statement?from=2020-01-01&to=2099-12-31`,
    );
    expect(response.statusCode, response.body).toBe(200);
    const statement = body<{
      entries: { kind: string; amountPoisha: string; journalId: string | null }[];
      position: { capitalPoisha: string; payablePoisha: string };
    }>(response);

    const kinds = statement.entries.map((entry) => entry.kind);
    expect(kinds).toContain('contribution');
    expect(kinds).toContain('distribution');
    expect(kinds).toContain('profit_paid');
    expect(kinds).toContain('capital_withdrawal');
    // Every line is answerable in the day book.
    expect(statement.entries.every((entry) => entry.journalId !== null)).toBe(true);

    // And the position agrees with the ledger, computed independently.
    expect(BigInt(statement.position.capitalPoisha)).toBe(
      -(await ledgerBalance(accountsById.get('investor_capital') ?? '', ids.a)),
    );
    expect(BigInt(statement.position.payablePoisha)).toBe(
      -(await ledgerBalance(accountsById.get('investor_payable') ?? '', ids.a)),
    );
  });

  it('shows an investor their own statement', async () => {
    const response = await investorA.client.request(
      'GET',
      `/v1/investors/${ids.a}/statement?from=2020-01-01&to=2099-12-31`,
    );
    expect(response.statusCode, response.body).toBe(200);
  });
});

// --- contributions -----------------------------------------------------------

describe('capital contributions', () => {
  it('posts Dr wallet / Cr investor capital, once per contribution id', async () => {
    const investorId = await createInvestor(accounts, { code: 'INV-D', name: 'Farid Uddin' });
    const capital = accountsById.get('investor_capital') ?? '';
    const wallet = accountsById.get('wallet_bank') ?? '';
    const capitalBefore = await ledgerBalance(capital, investorId);
    const walletBefore = await ledgerBalance(wallet);

    const investmentId = randomUUID();
    const first = await accounts.client.request('POST', '/v1/investors/investments', {
      body: { investmentId, investorId, walletAccountId: wallet, amountPoisha: '2500000' },
    });
    expect(first.statusCode, first.body).toBe(201);

    // The same id again: one journal, not two. The posting rule's key is derived
    // from the contribution id and nothing else.
    const retry = await accounts.client.request('POST', '/v1/investors/investments', {
      body: { investmentId, investorId, walletAccountId: wallet, amountPoisha: '2500000' },
    });
    expect(retry.statusCode, retry.body).toBe(201);
    expect(body<{ journalId: string }>(retry).journalId).toBe(
      body<{ journalId: string }>(first).journalId,
    );

    expect(await ledgerBalance(capital, investorId)).toBe(capitalBefore - 2_500_000n);
    expect(await ledgerBalance(wallet)).toBe(walletBefore + 2_500_000n);
  });

  it('refuses the same id with a different amount', async () => {
    const investorId = await createInvestor(accounts, { code: 'INV-E', name: 'Kamal Hossain' });
    const investmentId = randomUUID();
    await accounts.client.request('POST', '/v1/investors/investments', {
      body: {
        investmentId,
        investorId,
        walletAccountId: bankAccount,
        amountPoisha: '1000',
      },
    });
    const conflict = await accounts.client.request('POST', '/v1/investors/investments', {
      body: {
        investmentId,
        investorId,
        walletAccountId: bankAccount,
        amountPoisha: '2000',
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(body<{ code: string }>(conflict).code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('refuses capital into an account that is not a wallet', async () => {
    const response = await accounts.client.request('POST', '/v1/investors/investments', {
      body: {
        investmentId: randomUUID(),
        investorId: ids.a,
        walletAccountId: accountsById.get('investor_payable') ?? '',
        amountPoisha: '1000',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a contribution for an investor who has exited', async () => {
    const investorId = await createInvestor(accounts, { code: 'INV-F', name: 'Exited Backer' });
    const exited = await secondAccounts.client.request('PATCH', `/v1/investors/${investorId}`, {
      body: { status: 'exited' },
    });
    expect(exited.statusCode, exited.body).toBe(200);

    const response = await accounts.client.request('POST', '/v1/investors/investments', {
      body: {
        investmentId: randomUUID(),
        investorId,
        walletAccountId: bankAccount,
        amountPoisha: '1000',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(body<{ code: string }>(response).code).toBe('INVESTOR_INACTIVE');
  });

  it('masks a phone number on the way in', async () => {
    const response = await accounts.client.request('POST', '/v1/investors', {
      body: {
        code: 'INV-G',
        name: 'Masked Backer',
        joinedOn: '2026-01-01',
        phone: '+8801712345678',
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const view = body<{ phoneMasked: string }>(response);
    // Invariant 10: what reaches the column is already masked, so it is masked in
    // every backup and export too.
    expect(view.phoneMasked).not.toContain('1712345678');
    expect(view.phoneMasked).toMatch(/\*/);
  });
});
