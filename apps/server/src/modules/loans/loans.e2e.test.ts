import { randomUUID } from 'node:crypto';

import { seedAccountId, withSystem } from '@elysium/db';
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
  readonly loan: { readonly id: string; readonly principalPoisha: string };
  readonly instalments: readonly {
    readonly id: string;
    readonly seq: number;
    readonly principalPoisha: string;
    readonly interestPoisha: string;
    readonly totalPoisha: string;
    readonly state: string;
  }[];
  readonly payments: readonly { readonly id: string; readonly status: string; readonly seq: number }[];
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

async function pay(loanId: string, instalmentId: string, paymentId = randomUUID()) {
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
    expect(loan.lender).toMatchObject({ ledgerOwedPoisha: '1000000', scheduleOwedPoisha: '1000000' });

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

describe('what the database refuses (0090)', () => {
  it('refuses a schedule whose principal does not sum to the loan, at commit', async () => {
    const journal = (await journalsOf(ORG_A))[0];
    expect(journal).toBeDefined();
    const attempt = withSystem(
      async (tx) => {
        const [received] = await tx.execute<{ id: string }>(sql`
          select id from ledger.journals where org_id = ${ORG_A} order by created_at limit 1
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
