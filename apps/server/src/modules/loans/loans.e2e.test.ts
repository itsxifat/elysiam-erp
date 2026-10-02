import { randomUUID } from 'node:crypto';

import { seedAccountId, withSystem } from '@elysium/db';
import { toIsoDate } from '@elysium/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  ORG_B,
  startHttpHarness,
  type HttpHarness,
  type InjectedResponse,
  type RoleClient,
} from '../../testing/http-harness.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import { LoanRemindersService } from './reminders.service.js';

/**
 * Company loans over HTTP against real Postgres (M26 check 4: postings are correct).
 *
 * **Golden books.** One loan of ৳10,000 at 12% a year, reducing balance, over three
 * months — the table worked by hand in `packages/domain/src/loans/loans.test.ts`:
 *
 *   seq  principal   interest   instalment
 *    1   3,300.22    100.00     3,400.22
 *    2   3,333.22     67.00     3,400.22
 *    3   3,366.56     33.67     3,400.23
 *        10,000.00   200.67    10,200.67
 *
 * The receipt posts Dr Bank 10,000.00 / Cr Loan payable (lender) 10,000.00. Each repayment
 * waits for a second accounts user (no threshold is set, so §6 holds every one), and its
 * approval posts Dr Loan payable (principal) + Dr Interest expense / Cr Bank. One is
 * rejected first and paid again. Afterwards every figure is read back from
 * `ledger.journal_lines`: Bank down by exactly the interest, the lender owed nothing,
 * Interest expense 200.67, and debits equal to credits across the brand.
 *
 * The brand's books are this file's own: the harness gives every suite a fresh database.
 */

let harness: HttpHarness;
let maker: RoleClient;
let checker: RoleClient;
let otherBrand: RoleClient;
let sales: RoleClient;

const BANK = seedAccountId(ORG_A, '1100');

function body<T>(response: InjectedResponse): T {
  return JSON.parse(response.body) as T;
}

interface Statement {
  readonly loan: {
    readonly id: string;
    readonly lenderId: string;
    readonly principalPoisha: string;
  };
  readonly instalments: readonly {
    readonly id: string;
    readonly seq: number;
    readonly dueOn: string;
    readonly principalPoisha: string;
    readonly interestPoisha: string;
    readonly totalPoisha: string;
    readonly state: string;
  }[];
  readonly payments: readonly {
    readonly id: string;
    readonly status: string;
    readonly seq: number;
  }[];
  readonly totals: {
    readonly paidInstalments: number;
    readonly outstandingPrincipalPoisha: string;
    readonly paidInterestPoisha: string;
  };
  readonly payable: { readonly instalmentId: string | null; readonly reason: string | null };
  readonly lender: { readonly ledgerOwedPoisha: string; readonly scheduleOwedPoisha: string };
}

interface Payment {
  readonly paymentId: string;
  readonly status: 'posted' | 'pending_approval';
  readonly journalId: string | null;
  readonly approvalId: string | null;
}

async function statement(loanId: string): Promise<Statement> {
  const response = await maker.client.request('GET', `/v1/loans/${loanId}`);
  expect(response.statusCode, response.body).toBe(200);
  return body<Statement>(response);
}

async function pay(loanId: string, instalmentId: string, paymentId: string = randomUUID()) {
  return maker.client.request('POST', `/v1/loans/${loanId}/payments`, {
    body: { paymentId, instalmentId, walletAccountId: BANK },
  });
}

async function decide(approvalId: string, decision: 'approved' | 'rejected'): Promise<void> {
  const response = await checker.client.request('POST', `/v1/approvals/${approvalId}/decide`, {
    body: { decision },
  });
  expect(response.statusCode, response.body).toBe(201);
}

/** Σ debit − Σ credit per account subtype (and lender party), from the journal lines. */
async function balances(orgId: string) {
  const rows = await withSystem(
    (tx) =>
      tx.execute<{ subtype: string; party_id: string | null; net: string }>(sql`
        select a.subtype::text as subtype, l.party_id,
               (sum(l.debit_poisha) - sum(l.credit_poisha))::text as net
        from ledger.journal_lines l
        join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
        where l.org_id = ${orgId}
        group by a.subtype, l.party_id
      `),
    { orgId },
  );
  return [...rows];
}

async function trialBalanceDifference(orgId: string): Promise<bigint> {
  const [row] = await withSystem(
    (tx) =>
      tx.execute<{ diff: string }>(sql`
        select (coalesce(sum(debit_poisha), 0) - coalesce(sum(credit_poisha), 0))::text as diff
        from ledger.journal_lines where org_id = ${orgId}
      `),
    { orgId },
  );
  return BigInt(row?.diff ?? '0');
}

/** A refusal from the database, found anywhere on Drizzle's `.cause` chain. */
async function refusedWith(work: Promise<unknown>, pattern: RegExp): Promise<void> {
  const thrown: unknown = await work.then(
    () => null,
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(Error);
  let message = '';
  for (let current = thrown; current instanceof Error; current = current.cause) {
    message += `
${current.message}`;
  }
  expect(message).toMatch(pattern);
}

async function journalsOf(orgId: string) {
  const rows = await withSystem(
    (tx) =>
      tx.execute<{ source_type: string; idempotency_key: string }>(sql`
        select source_type, idempotency_key from ledger.journals
        where org_id = ${orgId} order by created_at
      `),
    { orgId },
  );
  return [...rows];
}

let lenderId = '';
let loanId = '';

beforeAll(async () => {
  harness = await startHttpHarness('loans-e2e');
  maker = await harness.asRole('accounts', ORG_A);
  checker = await harness.asRole('accounts', ORG_A);
  otherBrand = await harness.asRole('accounts', ORG_B);
  sales = await harness.asRole('sales', ORG_A);

  const lender = await maker.client.request('POST', '/v1/loans/lenders', {
    body: { name: 'Sonali Bank, Motijheel', kind: 'bank' },
  });
  expect(lender.statusCode, lender.body).toBe(201);
  lenderId = body<{ id: string }>(lender).id;
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 120_000);

describe('check 4: the postings are correct (golden books)', () => {
  it('previews the hand-computed schedule without writing anything', async () => {
    const response = await maker.client.request('POST', '/v1/loans/preview', {
      body: { principalPoisha: '1000000', rateBps: 1200, method: 'reducing', tenureMonths: 3 },
    });
    expect(response.statusCode, response.body).toBe(201);
    const preview = body<{
      instalments: { principalPoisha: string; interestPoisha: string }[];
      totals: { interestPoisha: string };
    }>(response);
    expect(preview.instalments.map((row) => [row.principalPoisha, row.interestPoisha])).toEqual([
      ['330022', '10000'],
      ['333322', '6700'],
      ['336656', '3367'],
    ]);
    expect(preview.totals.interestPoisha).toBe('20067');
    expect(await journalsOf(ORG_A)).toEqual([]);
  });

  it('receives the loan: Dr Bank / Cr Loan payable (lender), and the schedule', async () => {
    loanId = randomUUID();
    const request = {
      loanId,
      lenderId,
      principalPoisha: '1000000',
      rateBps: 1200,
      method: 'reducing',
      tenureMonths: 3,
      walletAccountId: BANK,
      reference: 'TL-2026-0042',
      reminderPhone: '01700000003',
    };
    const created = await maker.client.request('POST', '/v1/loans', { body: request });
    expect(created.statusCode, created.body).toBe(201);
    const loan = body<Statement>(created);
    expect(loan.instalments.map((row) => row.totalPoisha)).toEqual(['340022', '340022', '340023']);
    expect(loan.lender).toMatchObject({
      ledgerOwedPoisha: '1000000',
      scheduleOwedPoisha: '1000000',
    });

    // A retried submit answers from the loan it wrote, and posts nothing more.
    const replay = await maker.client.request('POST', '/v1/loans', { body: request });
    expect(replay.statusCode, replay.body).toBe(201);
    expect(body<Statement>(replay).loan.id).toBe(loanId);
    expect(await journalsOf(ORG_A)).toEqual([
      { source_type: 'company_loan', idempotency_key: `company_loan:${loanId}:received` },
    ]);
  });

  it('holds instalment 1 for a checker, posting nothing until it is approved', async () => {
    const before = await statement(loanId);
    const first = before.instalments[0];
    expect(before.payable.instalmentId).toBe(first?.id);

    // Out of order is refused before anything is raised.
    const early = await pay(loanId, before.instalments[1]?.id ?? '');
    expect(early.statusCode, early.body).toBe(409);
    expect(body<{ code: string }>(early).code).toBe('LOAN_PAYMENT_INVALID');

    const paymentId = randomUUID();
    const held = await pay(loanId, first?.id ?? '', paymentId);
    expect(held.statusCode, held.body).toBe(201);
    const payment = body<Payment>(held);
    expect(payment).toMatchObject({ status: 'pending_approval', journalId: null });
    expect(await journalsOf(ORG_A)).toHaveLength(1);

    // Nothing else may be paid while it waits, and a replay answers from the row.
    const meanwhile = await pay(loanId, before.instalments[1]?.id ?? '');
    expect(meanwhile.statusCode, meanwhile.body).toBe(409);
    const replay = await pay(loanId, first?.id ?? '', paymentId);
    expect(body<Payment>(replay).approvalId).toBe(payment.approvalId);

    // The maker cannot approve their own repayment.
    const self = await maker.client.request(
      'POST',
      `/v1/approvals/${payment.approvalId ?? ''}/decide`,
      { body: { decision: 'approved' } },
    );
    expect(self.statusCode, self.body).toBe(403);

    await decide(payment.approvalId ?? '', 'approved');
    const after = await statement(loanId);
    expect(after.instalments[0]?.state).toBe('paid');
    expect(after.lender).toEqual({
      asOf: expect.any(String) as string,
      ledgerOwedPoisha: '669978',
      scheduleOwedPoisha: '669978',
    });
  });

  it('releases a rejected repayment, so the instalment can be paid again', async () => {
    const before = await statement(loanId);
    const second = before.instalments[1];
    const rejected = body<Payment>(await pay(loanId, second?.id ?? ''));
    await decide(rejected.approvalId ?? '', 'rejected');

    const between = await statement(loanId);
    expect(between.payments.find((row) => row.id === rejected.paymentId)?.status).toBe('rejected');
    expect(between.instalments[1]?.state).not.toBe('pending_approval');
    expect(between.payable.instalmentId).toBe(second?.id);

    const again = body<Payment>(await pay(loanId, second?.id ?? ''));
    expect(again.status).toBe('pending_approval');
    await decide(again.approvalId ?? '', 'approved');

    const third = before.instalments[2];
    const last = body<Payment>(await pay(loanId, third?.id ?? ''));
    await decide(last.approvalId ?? '', 'approved');

    const settled = await statement(loanId);
    expect(settled.totals).toMatchObject({
      paidInstalments: 3,
      outstandingPrincipalPoisha: '0',
      paidInterestPoisha: '20067',
    });
    expect(settled.payable).toEqual({ instalmentId: null, reason: 'settled' });
    expect(settled.lender).toMatchObject({ ledgerOwedPoisha: '0', scheduleOwedPoisha: '0' });

    const again2 = await pay(loanId, third?.id ?? '');
    expect(again2.statusCode, again2.body).toBe(409);
  });

  it('leaves the books exactly as worked by hand, and balanced', async () => {
    const lines = await balances(ORG_A);
    const net = (subtype: string, party: string | null = null) =>
      lines
        .filter((row) => row.subtype === subtype && (party === null || row.party_id === party))
        .reduce((acc, row) => acc + BigInt(row.net), 0n);

    // Bank: +10,000.00 received, −10,200.67 repaid.
    expect(net('wallet_bank')).toBe(-20_067n);
    // The lender: credited 10,000.00, debited 3,300.22 + 3,333.22 + 3,366.56.
    expect(net('loan_payable', lenderId)).toBe(0n);
    expect(net('interest_expense')).toBe(20_067n);
    expect(await trialBalanceDifference(ORG_A)).toBe(0n);

    // Four journals: the receipt and one per instalment, keyed by the instalment. The
    // rejected repayment posted nothing.
    const journals = await journalsOf(ORG_A);
    const instalments = (await statement(loanId)).instalments.map((row) => row.id);
    expect(journals).toEqual([
      { source_type: 'company_loan', idempotency_key: `company_loan:${loanId}:received` },
      ...instalments.map((id) => ({
        source_type: 'loan_instalment',
        idempotency_key: `loan_instalment:${id}:paid`,
      })),
    ]);
  });
});

describe('a repayment under the brand’s threshold posts at once', () => {
  it('needs no checker below `loan_repayment`’s threshold, as a supplier payment does', async () => {
    // A first threshold is a relaxation, so it is itself maker-checker (D-073).
    const admin = await harness.asRole('org_admin', ORG_A);
    const secondAdmin = await harness.asRole('org_admin', ORG_A);
    const set = await admin.client.request('PUT', '/v1/approvals/thresholds', {
      body: { type: 'loan_repayment', thresholdPoisha: '500000' },
    });
    expect(set.statusCode, set.body).toBe(200);
    const pending = body<{ approvalId?: string }>(set);
    const decided = await secondAdmin.client.request(
      'POST',
      `/v1/approvals/${pending.approvalId ?? ''}/decide`,
      { body: { decision: 'approved' } },
    );
    expect(decided.statusCode, decided.body).toBe(201);

    const smallLoan = randomUUID();
    const created = await maker.client.request('POST', '/v1/loans', {
      body: {
        loanId: smallLoan,
        lenderId,
        principalPoisha: '1200000',
        rateBps: 1000,
        method: 'flat',
        tenureMonths: 12,
        walletAccountId: BANK,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const first = body<Statement>(created).instalments[0];
    // ৳12,000 at 10% flat over a year: ৳1,000 + ৳100 a month, under the ৳5,000 threshold.
    expect(first).toMatchObject({ principalPoisha: '100000', interestPoisha: '10000' });

    const paid = body<Payment>(await pay(smallLoan, first?.id ?? ''));
    expect(paid.status).toBe('posted');
    expect(paid.journalId).not.toBeNull();
    expect(paid.approvalId).toBeNull();
    expect(await trialBalanceDifference(ORG_A)).toBe(0n);
  });
});

describe('who may see and touch a loan', () => {
  it('shows another brand nothing, and refuses a role without CompanyLoan', async () => {
    const list = await otherBrand.client.request('GET', '/v1/loans');
    expect(list.statusCode, list.body).toBe(200);
    expect(body<{ items: unknown[] }>(list).items).toEqual([]);
    const foreign = await otherBrand.client.request('GET', `/v1/loans/${loanId}`);
    expect(foreign.statusCode, foreign.body).toBe(404);
    const foreignPay = await otherBrand.client.request('POST', `/v1/loans/${loanId}/payments`, {
      body: { paymentId: randomUUID(), instalmentId: randomUUID(), walletAccountId: BANK },
    });
    expect(foreignPay.statusCode, foreignPay.body).toBe(404);

    const denied = await sales.client.request('GET', '/v1/loans');
    expect(denied.statusCode).toBe(403);
  });

  it('masks the reminder phone on the statement', async () => {
    const response = await maker.client.request('GET', `/v1/loans/${loanId}`);
    expect(response.body).not.toContain('01700000003');
    expect(response.body).not.toContain('+8801700000003');
  });
});

describe('what the database refuses (0095)', () => {
  it('refuses a schedule whose principal does not sum to the loan, at commit', async () => {
    const journal = (await journalsOf(ORG_A))[0];
    expect(journal).toBeDefined();
    const attempt = withSystem(
      async (tx) => {
        const [received] = await tx.execute<{ id: string }>(sql`
          select id from ledger.journals where org_id = ${ORG_A}
            and source_type = 'loan_instalment' order by created_at limit 1
        `);
        const id = randomUUID();
        await tx.execute(sql`
          insert into loans.loans (org_id, id, lender_id, principal_poisha, rate_bps, method,
            tenure_months, received_on, first_due_on, wallet_account_id, received_journal_id,
            created_by)
          values (${ORG_A}, ${id}, ${lenderId}, 1000, 0, 'flat', 2, '2026-10-01', '2026-11-01',
            ${BANK}, ${received?.id ?? ''}, 'usr_m26_test')
        `);
        await tx.execute(sql`
          insert into loans.instalments (org_id, loan_id, seq, due_on, principal_poisha, interest_poisha)
          values (${ORG_A}, ${id}, 1, '2026-11-01', 500, 0), (${ORG_A}, ${id}, 2, '2026-12-01', 499, 0)
        `);
      },
      { orgId: ORG_A },
    );
    await refusedWith(attempt, /LOAN_SCHEDULE_INVALID/);
  });

  it('refuses a second loan on a receipt journal another loan already names', async () => {
    const [first] = await withSystem(
      (tx) =>
        tx.execute<{ received_journal_id: string }>(sql`
          select received_journal_id from loans.loans where id = ${loanId}
        `),
      { orgId: ORG_A },
    );
    await refusedWith(
      withSystem(
        (tx) =>
          tx.execute(sql`
            insert into loans.loans (org_id, lender_id, principal_poisha, rate_bps, method,
              tenure_months, received_on, first_due_on, wallet_account_id, received_journal_id,
              created_by)
            values (${ORG_A}, ${lenderId}, 1000000, 1200, 'reducing', 3, '2026-10-01',
              '2026-11-01', ${BANK}, ${first?.received_journal_id ?? ''}, 'usr_m26_test')
          `),
        { orgId: ORG_A },
      ),
      /loans_org_received_journal_idx/,
    );
  });

  it('refuses to change a loan or delete a payment, for the owner too', async () => {
    await refusedWith(
      withSystem(
        (tx) => tx.execute(sql`update loans.loans set rate_bps = 0 where id = ${loanId}`),
        { orgId: ORG_A },
      ),
      /LOAN_IMMUTABLE/,
    );
    await refusedWith(
      withSystem((tx) => tx.execute(sql`delete from loans.payments where loan_id = ${loanId}`), {
        orgId: ORG_A,
      }),
      /LOAN_IMMUTABLE/,
    );
  });
});

// --- the ledger audit's findings (W1 to W4), each pinned --------------------------------

/** A context for calling a service as the maker, as the HTTP layer would build it. */
function makerContext(): ActiveContext {
  return {
    userId: maker.userId,
    orgId: ORG_A,
    isSuperAdmin: false,
    roles: ['accounts'],
    branchIds: [],
    branchIdsByRole: {},
    requestId: randomUUID(),
  };
}

/** A loan of 12 instalments of `instalmentPoisha` each, interest-free, on its own lender. */
async function flatLoan(instalmentPoisha: bigint, name: string): Promise<Statement> {
  const lender = await maker.client.request('POST', '/v1/loans/lenders', {
    body: { name, kind: 'person' },
  });
  const created = await maker.client.request('POST', '/v1/loans', {
    body: {
      loanId: randomUUID(),
      lenderId: body<{ id: string }>(lender).id,
      principalPoisha: (instalmentPoisha * 12n).toString(),
      rateBps: 0,
      method: 'flat',
      tenureMonths: 12,
      walletAccountId: BANK,
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  return body<Statement>(created);
}

async function livePaymentsOf(instalmentId: string) {
  const [row] = await withSystem(
    (tx) =>
      tx.execute<{ live: number; journals: number }>(sql`
        select
          (select count(*)::int from loans.payments
            where org_id = ${ORG_A} and instalment_id = ${instalmentId} and status <> 'rejected')
            as live,
          (select count(*)::int from ledger.journals
            where org_id = ${ORG_A} and idempotency_key = ${`loan_instalment:${instalmentId}:paid`})
            as journals
      `),
    { orgId: ORG_A },
  );
  return row;
}

async function voidLoan(id: string, reason = 'Recorded by mistake', as: RoleClient = checker) {
  return as.client.request('POST', `/v1/loans/${id}/void`, { body: { reason } });
}

async function voidedAt(id: string): Promise<string | null> {
  const [row] = await withSystem(
    (tx) =>
      tx.execute<{ voided_at: string | null }>(sql`
        select voided_at::text from loans.loans where id = ${id}
      `),
    { orgId: ORG_A },
  );
  return row?.voided_at ?? null;
}

/** Journals that reverse this loan's receipt: 1 once it is void, 0 otherwise. */
async function reversalsOfReceipt(id: string): Promise<number> {
  const [row] = await withSystem(
    (tx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n from ledger.journals j
        join loans.loans l on l.org_id = j.org_id and l.received_journal_id = j.reverses_journal_id
        where l.org_id = ${ORG_A} and l.id = ${id}
      `),
    { orgId: ORG_A },
  );
  return row?.n ?? -1;
}

/** What the ledger says the brand owes a lender: Σ credit − Σ debit on its loan payable. */
async function lenderOwed(lender: string): Promise<bigint> {
  return (await balances(ORG_A))
    .filter((row) => row.subtype === 'loan_payable' && row.party_id === lender)
    .reduce((owed, row) => owed - BigInt(row.net), 0n);
}

/** A promise opened from outside, to hold a transaction open at a chosen point. */
function latch() {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}

/**
 * Until some transaction waits for a `loans.loans` row lock in this suite's database, held by
 * another: the race is then set.
 */
async function waitForLoanLockWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const [row] = await withSystem((tx) =>
      tx.execute<{ waiting: boolean }>(sql`
        select exists (
          select 1 from pg_locks
          where locktype = 'tuple' and relation = 'loans.loans'::regclass
            and database = (select oid from pg_database where datname = current_database())
            and cardinality(pg_blocking_pids(pid)) > 0
        ) as waiting
      `),
    );
    if (row?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('nothing waited for the loan row within 10 s');
}

/**
 * A void as 0096 and 0097 see it, written straight to the database: the receipt reversed
 * through the ledger, then the four void columns. `journal: 'receipt'` names the receipt
 * itself instead of its reversal; `hold` keeps the transaction open once the row is updated.
 */
async function voidInDatabase(
  id: string,
  options: {
    readonly voidedBy?: string;
    readonly journal?: 'reversal' | 'receipt';
    readonly updated?: { open: () => void };
    readonly hold?: Promise<void>;
  } = {},
): Promise<void> {
  await withSystem(
    async (tx) => {
      const [loan] = await tx.execute<{ received_journal_id: string }>(sql`
        select received_journal_id from loans.loans where id = ${id}
      `);
      const receipt = loan?.received_journal_id ?? '';
      const journalId =
        options.journal === 'receipt'
          ? receipt
          : (
              await harness.app
                .get<LedgerApi>(LEDGER_API)
                .reverse(tx, { orgId: ORG_A, userId: checker.userId }, receipt, 'Voided in a test')
            ).journalId;
      await tx.execute(sql`
        update loans.loans
        set voided_at = now(), voided_by = ${options.voidedBy ?? checker.userId},
            void_reason = 'Voided in a test', void_journal_id = ${journalId}::uuid
        where id = ${id}
      `);
      options.updated?.open();
      await options.hold;
    },
    { orgId: ORG_A },
  );
}

describe('races, orphans and the database checks (ledger audit)', () => {
  // The brand's `loan_repayment` threshold is 5,000 taka from the suite above.

  it('posts one repayment when two pay the same instalment at once, under the threshold', async () => {
    const loan = await flatLoan(100_000n, 'Race Lender Small');
    const first = loan.instalments[0]?.id ?? '';
    const [a, b] = await Promise.all([pay(loan.loan.id, first), pay(loan.loan.id, first)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(await livePaymentsOf(first)).toEqual({ live: 1, journals: 1 });
    expect(await trialBalanceDifference(ORG_A)).toBe(0n);
  });

  it('holds one repayment when two pay the same instalment at once, above it', async () => {
    const loan = await flatLoan(1_000_000n, 'Race Lender Large');
    const first = loan.instalments[0]?.id ?? '';
    const results = await Promise.all([pay(loan.loan.id, first), pay(loan.loan.id, first)]);
    expect(results.filter((response) => response.statusCode === 201)).toHaveLength(1);
    expect(await livePaymentsOf(first)).toEqual({ live: 1, journals: 0 });
  });

  it('records one loan when the same loan id is submitted twice at once', async () => {
    const id = randomUUID();
    const request = {
      loanId: id,
      lenderId,
      principalPoisha: '500000',
      rateBps: 900,
      method: 'reducing',
      tenureMonths: 6,
      walletAccountId: BANK,
    };
    const results = await Promise.all([
      maker.client.request('POST', '/v1/loans', { body: request }),
      maker.client.request('POST', '/v1/loans', { body: request }),
    ]);
    expect(results.some((response) => response.statusCode === 201)).toBe(true);
    for (const response of results) expect([201, 409]).toContain(response.statusCode);
    const [row] = await withSystem(
      (tx) =>
        tx.execute<{ loans: number; journals: number }>(sql`
          select (select count(*)::int from loans.loans where id = ${id}) as loans,
                 (select count(*)::int from ledger.journals
                   where idempotency_key = ${`company_loan:${id}:received`}) as journals
        `),
      { orgId: ORG_A },
    );
    expect(row).toEqual({ loans: 1, journals: 1 });

    // A reused id with different terms is a conflict, not the old loan.
    const changed = await maker.client.request('POST', '/v1/loans', {
      body: { ...request, rateBps: 1_000 },
    });
    expect(changed.statusCode, changed.body).toBe(409);
  });

  it('refuses a loan_repayment raised through the generic route', async () => {
    const response = await maker.client.request('POST', '/v1/approvals', {
      body: { type: 'loan_repayment', amountPoisha: '100000' },
    });
    expect(response.statusCode, response.body).toBe(400);
  });

  it('never records an approval that posted nothing (W1)', async () => {
    const approvals = harness.app.get(ApprovalsService);
    const orphanPayload = { paymentId: randomUUID(), loanId };

    // Under the threshold the request auto-approves and runs the executor at once; with no
    // repayment behind it the executor refuses, and nothing is left behind.
    await expect(
      approvals.request(makerContext(), {
        type: 'loan_repayment',
        amountPoisha: 100_000n,
        amountDerivedByServer: true,
        raisedByModule: true,
        payload: orphanPayload,
      }),
    ).rejects.toThrow();
    const [left] = await withSystem(
      (tx) =>
        tx.execute<{ n: number }>(sql`
          select count(*)::int as n from approvals.approval_requests
          where org_id = ${ORG_A} and payload ->> 'paymentId' = ${orphanPayload.paymentId}
        `),
      { orgId: ORG_A },
    );
    expect(left?.n).toBe(0);

    // Above it, an orphan waits; a checker cannot approve it into a no-op, only reject it.
    const orphan = await approvals.request(makerContext(), {
      type: 'loan_repayment',
      amountPoisha: 2_000_000n,
      amountDerivedByServer: true,
      raisedByModule: true,
      payload: { paymentId: randomUUID(), loanId },
    });
    expect(orphan.status).toBe('pending');
    const approve = await checker.client.request('POST', `/v1/approvals/${orphan.id}/decide`, {
      body: { decision: 'approved' },
    });
    expect(approve.statusCode, approve.body).toBe(409);
    await decide(orphan.id, 'rejected');
  });

  it('ties a repayment state to its approval and its journal in the database (W2)', async () => {
    const loan = await flatLoan(1_000_000n, 'Trigger Lender');
    const first = loan.instalments[0]?.id ?? '';
    const held = body<Payment>(await pay(loan.loan.id, first));
    expect(held.status).toBe('pending_approval');
    const [receipt] = await journalsOf(ORG_A);

    // Posted while its request still waits, and on somebody else's journal.
    await refusedWith(
      withSystem(
        (tx) =>
          tx.execute(sql`
            update loans.payments set status = 'posted', journal_id = (
              select id from ledger.journals
              where org_id = ${ORG_A} and idempotency_key = ${receipt?.idempotency_key ?? ''})
            where id = ${held.paymentId}
          `),
        { orgId: ORG_A },
      ),
      /LOAN_PAYMENT_INVALID/,
    );
    // Rejected while its request still waits.
    await refusedWith(
      withSystem(
        (tx) =>
          tx.execute(
            sql`update loans.payments set status = 'rejected' where id = ${held.paymentId}`,
          ),
        { orgId: ORG_A },
      ),
      /LOAN_PAYMENT_INVALID/,
    );
    // Born posted on another loan's journal.
    await refusedWith(
      withSystem(
        async (tx) => {
          const [journal] = await tx.execute<{ id: string }>(sql`
            select id from ledger.journals where org_id = ${ORG_A} order by created_at limit 1
          `);
          await tx.execute(sql`
            insert into loans.payments (org_id, loan_id, instalment_id, wallet_account_id,
              principal_poisha, interest_poisha, status, occurred_at, business_date, journal_id,
              created_by)
            values (${ORG_A}, ${loan.loan.id}, ${loan.instalments[1]?.id ?? ''}, ${BANK},
              1000000, 0, 'posted', now(), current_date, ${journal?.id ?? ''}, 'usr_m26_test')
          `);
        },
        { orgId: ORG_A },
      ),
      /LOAN_PAYMENT_INVALID/,
    );
  });
});

describe('voiding a loan recorded by mistake (W3, D-304)', () => {
  it('reverses the receipt, stops reminders and repayments, and happens once', async () => {
    const loan = await flatLoan(50_000n, 'Typo Lender');
    const voided = await voidLoan(loan.loan.id);
    expect(voided.statusCode, voided.body).toBe(201);
    const statement = body<Statement & { loan: { voidedAt: string | null } }>(voided);
    expect(statement.loan.voidedAt).not.toBeNull();
    expect(statement.payable).toEqual({ instalmentId: null, reason: 'voided' });
    expect(statement.totals.outstandingPrincipalPoisha).toBe('0');
    expect(statement.lender).toMatchObject({ ledgerOwedPoisha: '0', scheduleOwedPoisha: '0' });

    // The receipt and its reversal, and the books still balanced.
    const [pair] = await withSystem(
      (tx) =>
        tx.execute<{ reversals: number }>(sql`
          select count(*)::int as reversals from ledger.journals r
          join ledger.journals j on j.org_id = r.org_id and j.id = r.reverses_journal_id
          where r.org_id = ${ORG_A}
            and j.idempotency_key = ${`company_loan:${loan.loan.id}:received`}
        `),
      { orgId: ORG_A },
    );
    expect(pair?.reversals).toBe(1);
    expect(await trialBalanceDifference(ORG_A)).toBe(0n);

    const again = await voidLoan(loan.loan.id, 'Twice');
    expect(again.statusCode, again.body).toBe(409);
    const repaid = await pay(loan.loan.id, loan.instalments[0]?.id ?? '');
    expect(repaid.statusCode, repaid.body).toBe(409);

    // The reminder job passes it by, even long after every due date.
    await harness.app
      .get(LoanRemindersService)
      .run(ORG_A, toIsoDate(loan.instalments[11]?.dueOn ?? '2030-01-01'));
    const [reminded] = await withSystem(
      (tx) =>
        tx.execute<{ n: number }>(sql`
          select count(*)::int as n from loans.reminders where loan_id = ${loan.loan.id}
        `),
      { orgId: ORG_A },
    );
    expect(reminded?.n).toBe(0);
  });

  it('refuses to void a loan with a repayment waiting', async () => {
    const loan = await flatLoan(1_000_000n, 'Busy Lender');
    const held = await pay(loan.loan.id, loan.instalments[0]?.id ?? '');
    expect(held.statusCode, held.body).toBe(201);
    const voided = await voidLoan(loan.loan.id, 'Too late');
    expect(voided.statusCode, voided.body).toBe(409);
  });

  it('needs a second person: the one who recorded a loan cannot void it (W-B)', async () => {
    const loan = await flatLoan(50_000n, 'Own Loan Lender');
    const own = await voidLoan(loan.loan.id, 'My own mistake', maker);
    expect(own.statusCode, own.body).toBe(403);
    expect(body<{ code: string }>(own).code).toBe('LOAN_SELF_VOID');
    expect(await voidedAt(loan.loan.id)).toBeNull();

    // The statement tells each viewer whether they may.
    const asMaker = await maker.client.request('GET', `/v1/loans/${loan.loan.id}`);
    const asChecker = await checker.client.request('GET', `/v1/loans/${loan.loan.id}`);
    expect(body<{ loan: { voidable: boolean } }>(asMaker).loan.voidable).toBe(false);
    expect(body<{ loan: { voidable: boolean } }>(asChecker).loan.voidable).toBe(true);
  });
});

describe('a void and a repayment cannot both commit (W-A)', () => {
  it('lets exactly one through when the two race, in either order', async () => {
    for (const order of ['void first', 'pay first'] as const) {
      // Under the threshold, so the repayment posts in the same request. ৳12,000 in twelve
      // interest-free instalments of ৳1,000.
      const loan = await flatLoan(100_000n, `Race Void Lender (${order})`);
      const first = loan.instalments[0]?.id ?? '';
      const [voidResponse, payResponse] =
        order === 'void first'
          ? await Promise.all([voidLoan(loan.loan.id, 'Race'), pay(loan.loan.id, first)])
          : await Promise.all([pay(loan.loan.id, first), voidLoan(loan.loan.id, 'Race')]).then(
              ([paid, voided]) => [voided, paid] as const,
            );
      const responses = [voidResponse, payResponse];
      expect(
        responses.filter((response) => response?.statusCode === 201),
        responses.map((response) => response?.body).join('\n'),
      ).toHaveLength(1);

      // Whichever won, the books say exactly that and nothing of the loser.
      const voided = (await voidedAt(loan.loan.id)) !== null;
      const loser = voided ? payResponse : voidResponse;
      expect(loser?.statusCode, loser?.body).toBe(409);
      expect(body<{ code: string }>(loser).code).toBe(
        voided ? 'LOAN_PAYMENT_INVALID' : 'LOAN_IMMUTABLE',
      );
      expect(await livePaymentsOf(first)).toEqual(
        voided ? { live: 0, journals: 0 } : { live: 1, journals: 1 },
      );
      expect(await reversalsOfReceipt(loan.loan.id)).toBe(voided ? 1 : 0);
      expect(await lenderOwed(loan.loan.lenderId)).toBe(voided ? 0n : 1_100_000n);
    }
    expect(await trialBalanceDifference(ORG_A)).toBe(0n);
  });

  it('refuses the void once a payment that held the loan commits', async () => {
    // Deterministic: the payment's insert holds the loan `for share` and stays open; the
    // void blocks on it; the payment commits; the void's trigger then sees it.
    const loan = await flatLoan(1_000_000n, 'Held By Payment Lender');
    const first = loan.instalments[0];
    const paymentId = randomUUID();
    const approval = await harness.app.get(ApprovalsService).request(makerContext(), {
      type: 'loan_repayment',
      amountPoisha: 1_000_000n,
      amountDerivedByServer: true,
      raisedByModule: true,
      payload: { paymentId, loanId: loan.loan.id },
    });
    expect(approval.status).toBe('pending');

    const gate = latch();
    const inserted = latch();
    const payment = withSystem(
      async (tx) => {
        await tx.execute(sql`
          insert into loans.payments (org_id, id, loan_id, instalment_id, wallet_account_id,
            principal_poisha, interest_poisha, status, occurred_at, business_date,
            approval_request_id, created_by)
          values (${ORG_A}, ${paymentId}, ${loan.loan.id}, ${first?.id ?? ''}, ${BANK},
            1000000, 0, 'pending_approval', now(), current_date, ${approval.id},
            ${maker.userId})
        `);
        inserted.open();
        await gate.promise;
      },
      { orgId: ORG_A },
    );
    await inserted.promise;
    const voiding = voidLoan(loan.loan.id, 'Racing a payment');
    await waitForLoanLockWaiter();
    gate.open();
    await payment;

    // Refused by the trigger's own payments check, and the reversal it posted rolled back
    // with it: the lender is still owed the whole principal.
    const voided = await voiding;
    expect(voided.statusCode, voided.body).toBe(409);
    expect(body<{ code: string }>(voided).code).toBe('LOAN_IMMUTABLE');
    expect(voided.body).toMatch(/repayment posted or waiting/);
    expect(await voidedAt(loan.loan.id)).toBeNull();
    expect(await reversalsOfReceipt(loan.loan.id)).toBe(0);
    expect(await lenderOwed(loan.loan.lenderId)).toBe(12_000_000n);
    await decide(approval.id, 'rejected');
  });

  it('refuses the payment once a void that held the loan commits', async () => {
    // The other order: the void holds the loan's row lock and stays open; the payment's
    // insert waits for it `for share`, then reads the void and refuses.
    const loan = await flatLoan(1_000_000n, 'Held By Void Lender');
    const gate = latch();
    const updated = latch();
    const voiding = voidInDatabase(loan.loan.id, { updated, hold: gate.promise });
    await updated.promise;
    const paying = pay(loan.loan.id, loan.instalments[0]?.id ?? '');
    await waitForLoanLockWaiter();
    gate.open();
    await voiding;

    const paid = await paying;
    expect(paid.statusCode, paid.body).toBe(409);
    expect(body<{ code: string }>(paid).code).toBe('LOAN_PAYMENT_INVALID');
    expect(paid.body).toMatch(/that loan is void/i);
    expect(await voidedAt(loan.loan.id)).not.toBeNull();
    expect(await livePaymentsOf(loan.instalments[0]?.id ?? '')).toEqual({
      live: 0,
      journals: 0,
    });
    expect(await reversalsOfReceipt(loan.loan.id)).toBe(1);
    expect(await lenderOwed(loan.loan.lenderId)).toBe(0n);
  });
});

describe('what the database refuses of a void (0096, 0097; W-D)', () => {
  it('refuses a void by the person who recorded the loan', async () => {
    const loan = await flatLoan(50_000n, 'DB Self Void Lender');
    await refusedWith(voidInDatabase(loan.loan.id, { voidedBy: maker.userId }), /LOAN_SELF_VOID/);
  });

  it('refuses a void that names a journal other than the receipt’s reversal', async () => {
    const loan = await flatLoan(50_000n, 'DB Wrong Journal Lender');
    await refusedWith(
      voidInDatabase(loan.loan.id, { journal: 'receipt' }),
      /names the journal that reverses the loan's receipt/,
    );
  });

  it('refuses a void while a repayment waits', async () => {
    const loan = await flatLoan(1_000_000n, 'DB Waiting Lender');
    const held = body<Payment>(await pay(loan.loan.id, loan.instalments[0]?.id ?? ''));
    expect(held.status).toBe('pending_approval');
    await refusedWith(voidInDatabase(loan.loan.id), /repayment posted or waiting/);
  });

  it('refuses a void after a repayment posted', async () => {
    const loan = await flatLoan(100_000n, 'DB Posted Lender');
    const posted = body<Payment>(await pay(loan.loan.id, loan.instalments[0]?.id ?? ''));
    expect(posted.status).toBe('posted');
    await refusedWith(voidInDatabase(loan.loan.id), /repayment posted or waiting/);
  });

  it('refuses a second void, and any edit of the void', async () => {
    const loan = await flatLoan(50_000n, 'DB Twice Lender');
    expect((await voidLoan(loan.loan.id)).statusCode).toBe(201);
    await refusedWith(
      withSystem(
        (tx) =>
          tx.execute(
            sql`update loans.loans set void_reason = 'Rewritten' where id = ${loan.loan.id}`,
          ),
        { orgId: ORG_A },
      ),
      /voided once/,
    );
    await refusedWith(
      withSystem(
        (tx) =>
          tx.execute(sql`update loans.loans set voided_at = now() where id = ${loan.loan.id}`),
        { orgId: ORG_A },
      ),
      /voided once/,
    );
  });
});

describe('a payment id in any case (N2)', () => {
  it('approves and posts a repayment whose id arrived in capitals', async () => {
    const loan = await flatLoan(1_000_000n, 'Capitals Lender');
    const held = await pay(loan.loan.id, loan.instalments[0]?.id ?? '', randomUUID().toUpperCase());
    expect(held.statusCode, held.body).toBe(201);
    const payment = body<Payment>(held);
    expect(payment.status).toBe('pending_approval');
    await decide(payment.approvalId ?? '', 'approved');
    const after = await statement(loan.loan.id);
    expect(after.payments.map((row) => row.status)).toEqual(['posted']);
  });
});
