import { randomUUID } from 'node:crypto';

import { seedAccountId, SEED_ORG_IDS, withOrg, withSystem, ensureBranchWallets } from '@elysium/db';
import {
  ACCOUNT_SUBTYPE_NAMES,
  ACCOUNT_SUBTYPES,
  allocate,
  businessDate,
  idempotencyKey,
  poisha,
  toIsoDate,
  trialBalance,
  type JournalDraft,
  type JournalLineDraft,
} from '@elysium/domain';
import { sql } from 'drizzle-orm';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditRowsFor,
  createBranch,
  ORG_A,
  ORG_B,
  startHttpHarness,
  type Client,
  type HttpHarness,
} from '../../testing/http-harness.js';
import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { attachScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { CashService } from './cash.service.js';
import { LedgerService } from './ledger.service.js';

/**
 * The ledger end to end (M03 checks 1, 4, 5 and 7, plus scope and cost).
 *
 * Real PostgreSQL, the real module graph and production's own request
 * pipeline. The database-level half of checks 2–4 — raw SQL against the
 * triggers — lives in packages/db/src/testing/ledger.test.ts.
 */

const ORG_C = SEED_ORG_IDS.orvo ?? '';
const ORG_D = SEED_ORG_IDS['wear-x-clothing'] ?? '';
const ORG_E = SEED_ORG_IDS.beownz ?? '';

const account = (orgId: string, code: string): string => seedAccountId(orgId, code);

let harness: HttpHarness;
let ledger: LedgerService;
let cash: CashService;

beforeAll(async () => {
  harness = await startHttpHarness('ledger');
  ledger = harness.app.get(LedgerService);
  cash = harness.app.get(CashService);
}, 180_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

function parse<T>(body: string): T {
  return JSON.parse(body) as T;
}

function line(
  accountId: string,
  debit: bigint,
  credit: bigint,
  extra: Partial<JournalLineDraft> = {},
): JournalLineDraft {
  return {
    accountId,
    debitPoisha: poisha(debit),
    creditPoisha: poisha(credit),
    branchId: null,
    partyType: null,
    partyId: null,
    memo: null,
    ...extra,
  };
}

function draft(
  lines: JournalLineDraft[],
  date = '2026-07-15',
  sourceId = randomUUID(),
): JournalDraft {
  return {
    businessDate: toIsoDate(date),
    sourceType: 'test',
    sourceId,
    event: 'posted',
    idempotencyKey: idempotencyKey('test', sourceId, 'posted'),
    memo: null,
    reversesJournalId: null,
    lines,
  };
}

const ACTOR = 'usr_ledger_e2e';

async function post(orgId: string, entry: JournalDraft) {
  return withOrg({ orgId, userId: ACTOR }, async (tx) =>
    ledger.post(tx, { orgId, userId: ACTOR }, entry),
  );
}

/** The HTTP body of a failed call, or the error an in-process call threw. */
async function failure(work: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await work;
  } catch (error) {
    const response = (
      error as { getResponse?: () => unknown; getStatus?: () => number }
    ).getResponse?.() as { code?: string } | undefined;
    const status = (error as { getStatus?: () => number }).getStatus?.() ?? 0;
    const code =
      response?.code ??
      (error as { code?: string }).code ??
      (error instanceof Error ? error.message : String(error));
    return { status, code };
  }
  throw new Error('expected a failure');
}

async function countWhere(orgId: string, key: string): Promise<number> {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{ n: string }>(
        sql`select count(*)::text as n from ledger.journals where idempotency_key = ${key}`,
      ),
    { orgId },
  );
  return Number(rows[0]?.n ?? 0);
}

async function asSuperAdmin(): Promise<Client> {
  const actor = await harness.asRole('org_admin', ORG_A);
  await withSystem(async (tx) => {
    await tx.execute(sql`update iam.users set is_super_admin = true where id = ${actor.userId}`);
  });
  return actor.client;
}

describe('check 1: random sequences of valid drafts leave the trial balance at zero', () => {
  // Accounts that take no party and no branch, in an org nothing else touches.
  const CODES = ['1100', '1110', '1900', '2900', '3100', '4300', '5890', '1300'];

  const journal = fc
    .record({
      total: fc.bigInt({ min: 1n, max: 10n ** 11n }),
      debit: fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 3 }),
      credit: fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 3 }),
      debitCodes: fc.array(fc.constantFrom(...CODES), { minLength: 3, maxLength: 3 }),
      creditCodes: fc.array(fc.constantFrom(...CODES), { minLength: 3, maxLength: 3 }),
      day: fc.integer({ min: 1, max: 28 }),
      month: fc.integer({ min: 1, max: 8 }),
    })
    .map((spec) => {
      const debits = allocate(poisha(spec.total), spec.debit).filter((part) => part > 0n);
      const credits = allocate(poisha(spec.total), spec.credit).filter((part) => part > 0n);
      const date = `2026-${String(spec.month).padStart(2, '0')}-${String(spec.day).padStart(2, '0')}`;
      return draft(
        [
          ...debits.map((amount, i) =>
            line(account(ORG_C, spec.debitCodes[i] ?? '1100'), amount, 0n),
          ),
          ...credits.map((amount, i) =>
            line(account(ORG_C, spec.creditCodes[i] ?? '4300'), 0n, amount),
          ),
        ],
        date,
      );
    });

  it('holds after every run: each journal balances, and the org nets to zero', async () => {
    const posted: JournalDraft[] = [];

    await fc.assert(
      fc.asyncProperty(fc.array(journal, { minLength: 1, maxLength: 6 }), async (drafts) => {
        for (const entry of drafts) {
          await post(ORG_C, entry);
          posted.push(entry);
        }

        const rows = await withSystem(
          async (tx) =>
            tx.execute<{ unbalanced: string; debit: string; credit: string }>(sql`
              select
                (select count(*) from (
                   select journal_id from ledger.journal_lines
                   group by journal_id
                   having sum(debit_poisha) <> sum(credit_poisha) or count(*) < 2
                 ) bad)::text as unbalanced,
                coalesce(sum(debit_poisha), 0)::text as debit,
                coalesce(sum(credit_poisha), 0)::text as credit
              from ledger.journal_lines
            `),
          { orgId: ORG_C },
        );
        expect(rows[0]?.unbalanced).toBe('0');
        expect(rows[0]?.debit).toBe(rows[0]?.credit);
      }),
      { numRuns: 25 },
    );

    // The trial balance the API serves agrees with the pure definition,
    // account by account, and nets to zero.
    const accounts = await harness.asRole('accounts', ORG_C);
    const response = await accounts.client.request(
      'GET',
      '/v1/ledger/trial-balance?asOf=2026-12-31',
    );
    expect(response.statusCode, response.body).toBe(200);
    const body = parse<{
      items: { accountId: string; debitPoisha: string; creditPoisha: string }[];
      totalDebitPoisha: string;
      totalCreditPoisha: string;
      differencePoisha: string;
    }>(response.body);

    const expected = trialBalance(posted.flatMap((entry) => entry.lines));
    expect(body.differencePoisha).toBe('0');
    expect(body.totalDebitPoisha).toBe(expected.totalDebitPoisha.toString());
    expect(body.totalCreditPoisha).toBe(body.totalDebitPoisha);
    expect(
      body.items.map((row) => [row.accountId, row.debitPoisha, row.creditPoisha]).sort(),
    ).toEqual(
      expected.rows
        .map((row) => [row.accountId, row.debitPoisha.toString(), row.creditPoisha.toString()])
        .sort(),
    );
    expect(posted.length).toBeGreaterThanOrEqual(25);
  }, 300_000);
});

describe('check 5: posting the same idempotency key twice returns the same journal and leaves one row', () => {
  const bank = account(ORG_A, '1100');
  const income = account(ORG_A, '4300');

  it('returns the first journal on a replay and writes nothing', async () => {
    const entry = draft([line(bank, 42_000n, 0n), line(income, 0n, 42_000n)], '2026-07-20');
    const first = await post(ORG_A, entry);
    const second = await post(ORG_A, entry);

    expect(first.created).toBe(true);
    expect(second).toEqual({ ...first, created: false });
    expect(await countWhere(ORG_A, entry.idempotencyKey)).toBe(1);
  });

  it('writes one journal when the same key is posted concurrently', async () => {
    const entry = draft([line(bank, 7_000n, 0n), line(income, 0n, 7_000n)], '2026-07-21');
    const results = await Promise.all(Array.from({ length: 6 }, () => post(ORG_A, entry)));

    expect(new Set(results.map((result) => result.journalId)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await countWhere(ORG_A, entry.idempotencyKey)).toBe(1);
  });

  it('refuses the same key with different content rather than answering with the first', async () => {
    const sourceId = randomUUID();
    await post(
      ORG_A,
      draft([line(bank, 500n, 0n), line(income, 0n, 500n)], '2026-07-22', sourceId),
    );
    const clash = await failure(
      post(ORG_A, draft([line(bank, 900n, 0n), line(income, 0n, 900n)], '2026-07-22', sourceId)),
    );
    expect(clash).toEqual({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect(await countWhere(ORG_A, idempotencyKey('test', sourceId, 'posted'))).toBe(1);
  });

  it('makes a resubmitted cash-in over HTTP the same journal', async () => {
    const actor = await harness.asRole('accounts', ORG_A);
    const body = {
      entryId: randomUUID(),
      walletAccountId: bank,
      incomeAccountId: income,
      amountPoisha: '125050',
      memo: 'Scrap cartons',
    };
    const first = await actor.client.request('POST', '/v1/ledger/cash-in', { body });
    const second = await actor.client.request('POST', '/v1/ledger/cash-in', { body });
    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);

    const a = parse<{ journalId: string; created: boolean }>(first.body);
    const b = parse<{ journalId: string; created: boolean }>(second.body);
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ journalId: a.journalId, created: false });
    expect(await countWhere(ORG_A, `cash_in:${body.entryId}:received`)).toBe(1);

    const changed = await actor.client.request('POST', '/v1/ledger/cash-in', {
      body: { ...body, amountPoisha: '999' },
    });
    expect(changed.statusCode).toBe(409);
    expect(parse<{ code: string }>(changed.body).code).toBe('IDEMPOTENCY_CONFLICT');

    // Audited in the same transaction as the journal.
    const audit = await auditRowsFor(ORG_A, a.journalId);
    expect(audit.map((row) => row.action)).toContain('ledger.cash_in');
    expect(audit[0]?.actor_user_id).toBe(actor.userId);
  });

  it('replays a cash-in retried after Dhaka midnight from the stored journal', async () => {
    const context = contextFor('accounts', ORG_A);
    const input = {
      entryId: randomUUID(),
      walletAccountId: bank,
      incomeAccountId: income,
      amountPoisha: '3000',
      memo: undefined,
      request: scopedRequest(),
    };
    const first = await cash.cashIn(context, input, new Date('2026-09-10T17:55:00Z'));
    const retry = await cash.cashIn(context, input, new Date('2026-09-10T18:05:00Z'));
    expect(first.businessDate).toBe('2026-09-10');
    expect(retry).toMatchObject({
      journalId: first.journalId,
      created: false,
      businessDate: '2026-09-10',
    });
  });
});

/**
 * A request object the way the guard leaves it for an org-wide caller, so a
 * service called directly can apply its row scope (D-061).
 */
function scopedRequest(): AuditableRequest {
  const request = {} as AuditableRequest;
  attachScope(request, 'update', 'Wallet', { kind: 'all' });
  return request;
}

/** A context as the guard would build it, for calling services directly. */
function contextFor(
  role: 'accounts' | 'org_admin' | 'branch_manager',
  orgId: string,
  branchIds: string[] = [],
): ActiveContext {
  return {
    userId: `usr_${role}_${randomUUID()}`,
    orgId,
    isSuperAdmin: false,
    roles: [role],
    branchIds,
    branchIdsByRole: { [role]: branchIds },
    requestId: randomUUID(),
  };
}

describe('check 4: posting into a closed period fails; reopening goes through approval', () => {
  const bank = account(ORG_A, '1100');
  const income = account(ORG_A, '4300');

  it('closes an ended month, refuses posting into it, and refuses an unfinished month', async () => {
    const actor = await harness.asRole('accounts', ORG_A);
    const closed = await actor.client.request('POST', '/v1/ledger/periods/close', {
      body: { month: '2025-03' },
    });
    expect(closed.statusCode, closed.body).toBe(201);
    const period = parse<{ id: string; status: string }>(closed.body);
    expect(period.status).toBe('closed');
    expect((await auditRowsFor(ORG_A, period.id)).map((row) => row.action)).toContain(
      'ledger.period.closed',
    );

    const refused = await failure(
      post(ORG_A, draft([line(bank, 100n, 0n), line(income, 0n, 100n)], '2025-03-31')),
    );
    expect(refused).toEqual({ status: 409, code: 'PERIOD_CLOSED' });
    // The neighbours are open.
    await post(ORG_A, draft([line(bank, 100n, 0n), line(income, 0n, 100n)], '2025-04-01'));

    const again = await actor.client.request('POST', '/v1/ledger/periods/close', {
      body: { month: '2025-03' },
    });
    expect(parse<{ code: string }>(again.body).code).toBe('PERIOD_ALREADY_CLOSED');

    const thisMonth = businessDate(new Date()).slice(0, 7);
    const early = await actor.client.request('POST', '/v1/ledger/periods/close', {
      body: { month: thisMonth },
    });
    expect(early.statusCode).toBe(409);
    expect(parse<{ code: string }>(early.body).code).toBe('PERIOD_NOT_ENDED');
  });

  it('reopens only when a super_admin approves the period_reopen request', async () => {
    const accounts = await harness.asRole('accounts', ORG_A);
    const orgAdmin = await harness.asRole('org_admin', ORG_A);
    const superAdmin = await asSuperAdmin();

    await accounts.client.request('POST', '/v1/ledger/periods/close', {
      body: { month: '2025-05' },
    });

    // Raising the request changes nothing yet.
    const raised = await accounts.client.request('POST', '/v1/ledger/periods/reopen', {
      body: { month: '2025-05', reason: 'Supplier invoice missed' },
    });
    expect(raised.statusCode, raised.body).toBe(201);
    const { approvalId, status, periodId } = parse<{
      approvalId: string;
      status: string;
      periodId: string;
    }>(raised.body);
    expect(status).toBe('pending');
    expect(
      (await failure(post(ORG_A, draft([line(bank, 5n, 0n), line(income, 0n, 5n)], '2025-05-10'))))
        .code,
    ).toBe('PERIOD_CLOSED');

    // Not the maker, and not an org admin: §7 says super_admin.
    for (const checker of [accounts.client, orgAdmin.client]) {
      const decided = await checker.request('POST', `/v1/approvals/${approvalId}/decide`, {
        body: { decision: 'approved' },
      });
      expect(decided.statusCode, decided.body).toBe(403);
    }

    const approved = await superAdmin.request('POST', `/v1/approvals/${approvalId}/decide`, {
      body: { decision: 'approved' },
    });
    expect(approved.statusCode, approved.body).toBe(201);

    const periods = await accounts.client.request('GET', '/v1/ledger/periods');
    const row = parse<{
      items: { id: string; month: string; status: string; reopenApprovalId: string }[];
    }>(periods.body).items.find((item) => item.month === '2025-05');
    expect(row).toMatchObject({ id: periodId, status: 'open', reopenApprovalId: approvalId });
    await post(ORG_A, draft([line(bank, 5n, 0n), line(income, 0n, 5n)], '2025-05-10'));

    const audit = await auditRowsFor(ORG_A, periodId);
    expect(audit.map((entry) => entry.action)).toEqual([
      'ledger.period.closed',
      'ledger.period.reopened',
    ]);

    // A second request for a period that is open is refused up front.
    const notClosed = await accounts.client.request('POST', '/v1/ledger/periods/reopen', {
      body: { month: '2025-05', reason: 'again' },
    });
    expect(parse<{ code: string }>(notClosed.body).code).toBe('PERIOD_NOT_CLOSED');
  });

  it('refuses a duplicate reopen request, and reopening a month while a later one is closed', async () => {
    const accounts = await harness.asRole('accounts', ORG_A);
    const superAdmin = await asSuperAdmin();
    await accounts.client.request('POST', '/v1/ledger/periods/close', {
      body: { month: '2025-08' },
    });

    const first = await accounts.client.request('POST', '/v1/ledger/periods/reopen', {
      body: { month: '2025-08', reason: 'first' },
    });
    expect(first.statusCode, first.body).toBe(201);
    const duplicate = await accounts.client.request('POST', '/v1/ledger/periods/reopen', {
      body: { month: '2025-08', reason: 'again' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(parse<{ code: string }>(duplicate.body).code).toBe('PERIOD_REOPEN_PENDING');

    // A closed month locks every date before it (D-093): reopening March
    // while August is closed would change nothing, so it is refused.
    const earlier = await accounts.client.request('POST', '/v1/ledger/periods/reopen', {
      body: { month: '2025-03', reason: 'late invoice' },
    });
    expect(earlier.statusCode).toBe(409);
    expect(parse<{ code: string }>(earlier.body).code).toBe('PERIOD_LATER_CLOSED');

    // And the lock is real: April sits between two closed months.
    expect(
      (
        await failure(
          post(
            ORG_A,
            draft(
              [line(account(ORG_A, '1100'), 5n, 0n), line(account(ORG_A, '4300'), 0n, 5n)],
              '2025-04-15',
            ),
          ),
        )
      ).code,
    ).toBe('PERIOD_CLOSED');

    // Leave August reopened for the tests after this one.
    const { approvalId } = parse<{ approvalId: string }>(first.body);
    const approved = await superAdmin.request('POST', `/v1/approvals/${approvalId}/decide`, {
      body: { decision: 'approved' },
    });
    expect(approved.statusCode, approved.body).toBe(201);
  });

  it('leaves the period closed when the request is rejected', async () => {
    const accounts = await harness.asRole('accounts', ORG_A);
    const superAdmin = await asSuperAdmin();
    await accounts.client.request('POST', '/v1/ledger/periods/close', {
      body: { month: '2025-06' },
    });
    const raised = await accounts.client.request('POST', '/v1/ledger/periods/reopen', {
      body: { month: '2025-06', reason: 'x' },
    });
    const { approvalId } = parse<{ approvalId: string }>(raised.body);
    const rejected = await superAdmin.request('POST', `/v1/approvals/${approvalId}/decide`, {
      body: { decision: 'rejected' },
    });
    expect(rejected.statusCode, rejected.body).toBe(201);
    expect(
      (await failure(post(ORG_A, draft([line(bank, 5n, 0n), line(income, 0n, 5n)], '2025-06-10'))))
        .code,
    ).toBe('PERIOD_CLOSED');
  });

  it('refuses period_reopen through the generic route, and a payload that misleads (review M1)', async () => {
    const accounts = await harness.asRole('accounts', ORG_A);
    const superAdmin = await asSuperAdmin();

    // A hand-written payload could label one month and name another period.
    const generic = await accounts.client.request('POST', '/v1/approvals', {
      body: { type: 'period_reopen', amountPoisha: null, payload: { periodId: randomUUID() } },
    });
    expect(generic.statusCode, generic.body).toBe(400);

    // And if such a request existed anyway (raised by a buggy module), the
    // executor refuses it: the label must be the period's own month, and the
    // period must be closed. The decision rolls back with it.
    await accounts.client.request('POST', '/v1/ledger/periods/close', {
      body: { month: '2025-07' },
    });
    const periods = parse<{ items: { id: string; month: string }[] }>(
      (await accounts.client.request('GET', '/v1/ledger/periods')).body,
    ).items;
    const july = periods.find((item) => item.month === '2025-07')?.id ?? '';
    const approvals = harness.app.get(ApprovalsService);
    const context = contextFor('accounts', ORG_A);

    const cases: [Record<string, unknown>, string][] = [
      [{ periodId: july, month: '2025-08' }, 'PERIOD_REOPEN_UNAUTHORISED'],
      [{ periodId: randomUUID(), month: '2025-07' }, 'PERIOD_NOT_CLOSED'],
      [{ periodId: july, month: '2025-07', extra: 'x' }, 'PERIOD_REOPEN_UNAUTHORISED'],
    ];
    for (const [payload, code] of cases) {
      const { id } = await approvals.request(context, {
        type: 'period_reopen',
        amountPoisha: null,
        payload,
        raisedByModule: true,
      });
      const decided = await superAdmin.request('POST', `/v1/approvals/${id}/decide`, {
        body: { decision: 'approved' },
      });
      expect(parse<{ code: string }>(decided.body).code, JSON.stringify(payload)).toBe(code);

      const [row] = await withSystem(
        async (tx) =>
          tx.execute<{ status: string }>(
            sql`select status::text as status from approvals.approval_requests where id = ${id}`,
          ),
        { orgId: ORG_A },
      );
      expect(row?.status).toBe('pending');
    }
    const refused = await failure(
      post(
        ORG_A,
        draft(
          [line(account(ORG_A, '1100'), 5n, 0n), line(account(ORG_A, '4300'), 0n, 5n)],
          '2025-07-10',
        ),
      ),
    );
    expect(refused.code).toBe('PERIOD_CLOSED');
  });

  it('does not let sales, marketing or a branch manager close a period', async () => {
    for (const role of ['sales', 'marketing', 'branch_manager', 'warehouse'] as const) {
      const actor = await harness.asRole(role, ORG_A);
      const response = await actor.client.request('POST', '/v1/ledger/periods/close', {
        body: { month: '2024-01' },
      });
      expect(response.statusCode, role).toBe(403);
    }
  });
});

describe('reversal', () => {
  const bank = account(ORG_D, '1100');
  const income = account(ORG_D, '4300');

  it('posts the mirror image once, and never reverses a reversal', async () => {
    const original = await post(
      ORG_D,
      draft([line(bank, 10_000n, 0n), line(income, 0n, 10_000n)], '2026-07-01'),
    );
    const reverse = () =>
      withOrg({ orgId: ORG_D, userId: ACTOR }, async (tx) =>
        ledger.reverse(
          tx,
          { orgId: ORG_D, userId: ACTOR },
          original.journalId,
          'Entered twice',
          new Date('2026-07-02T04:00:00Z'),
        ),
      );

    const reversal = await reverse();
    expect(reversal).toMatchObject({ created: true, businessDate: '2026-07-02' });
    expect(await reverse()).toEqual({ ...reversal, created: false });

    const lines = await withSystem(
      async (tx) =>
        tx.execute<{ account_id: string; debit_poisha: string; credit_poisha: string }>(sql`
          select account_id, debit_poisha::text, credit_poisha::text
          from ledger.journal_lines where journal_id = ${reversal.journalId} order by line_no
        `),
      { orgId: ORG_D },
    );
    expect([...lines]).toEqual([
      { account_id: bank, debit_poisha: '0', credit_poisha: '10000' },
      { account_id: income, debit_poisha: '10000', credit_poisha: '0' },
    ]);

    const twice = await failure(
      withOrg({ orgId: ORG_D, userId: ACTOR }, async (tx) =>
        ledger.reverse(tx, { orgId: ORG_D, userId: ACTOR }, reversal.journalId, 'undo the undo'),
      ),
    );
    expect(twice.code).toBe('POSTING_INPUT_INVALID');

    const missing = await failure(
      withOrg({ orgId: ORG_D, userId: ACTOR }, async (tx) =>
        ledger.reverse(tx, { orgId: ORG_D, userId: ACTOR }, randomUUID(), 'nothing'),
      ),
    );
    expect(missing).toEqual({ status: 404, code: 'JOURNAL_NOT_FOUND' });
  });
});

describe('reports: a worked example with hand-computed numbers', () => {
  it('serves the account ledger, cash book and day book for a small month', async () => {
    const orgId = ORG_E;
    const hq = account(orgId, '1010-HQ');
    const other = account(orgId, '4300');
    const context = contextFor('accounts', orgId);
    const cashIn = (entry: string, amount: string, at: string) =>
      cash.cashIn(
        context,
        {
          entryId: entry,
          walletAccountId: hq,
          incomeAccountId: other,
          amountPoisha: amount,
          memo: undefined,
          request: scopedRequest(),
        },
        new Date(at),
      );

    // ৳1,000.00 on 3 Aug (Dhaka), ৳250.50 on 5 Aug, ৳75.25 on 9 Aug.
    await cashIn(randomUUID(), '100000', '2026-08-03T06:00:00Z');
    await cashIn(randomUUID(), '25050', '2026-08-05T06:00:00Z');
    await cashIn(randomUUID(), '7525', '2026-08-09T06:00:00Z');

    const actor = await harness.asRole('accounts', orgId);
    const book = await actor.client.request(
      'GET',
      `/v1/ledger/wallets/${hq}/cash-book?from=2026-08-04&to=2026-08-31`,
    );
    expect(book.statusCode, book.body).toBe(200);
    const statement = parse<{
      openingBalancePoisha: string;
      totalDebitPoisha: string;
      closingBalancePoisha: string;
      items: {
        businessDate: string;
        debitPoisha: string;
        balancePoisha: string;
        against: { code: string }[];
      }[];
    }>(book.body);

    // Opening: the 3 Aug receipt, ৳1,000.00. Then +250.50 = 1,250.50, +75.25 = 1,325.75.
    expect(statement.openingBalancePoisha).toBe('100000');
    expect(
      statement.items.map((item) => [item.businessDate, item.debitPoisha, item.balancePoisha]),
    ).toEqual([
      ['2026-08-05', '25050', '125050'],
      ['2026-08-09', '7525', '132575'],
    ]);
    expect(statement.totalDebitPoisha).toBe('32575');
    expect(statement.closingBalancePoisha).toBe('132575');
    expect(statement.items[0]?.against).toEqual([{ code: '4300', name: 'Other income' }]);

    // The income account is credit-normal: its balance is the same ৳1,325.75.
    const ledgerResponse = await actor.client.request(
      'GET',
      `/v1/ledger/accounts/${other}/ledger?to=2026-08-31`,
    );
    const incomeLedger = parse<{ closingBalancePoisha: string; totalCreditPoisha: string }>(
      ledgerResponse.body,
    );
    expect(incomeLedger).toMatchObject({
      closingBalancePoisha: '132575',
      totalCreditPoisha: '132575',
    });

    const wallets = await actor.client.request('GET', '/v1/ledger/wallets');
    const hqWallet = parse<{ items: { accountId: string; balancePoisha: string }[] }>(
      wallets.body,
    ).items.find((item) => item.accountId === hq);
    expect(hqWallet?.balancePoisha).toBe('132575');
  });
});

describe("check 7 end to end: a cash-in at 23:30 UTC on the 1st lands in the 2nd's day book", () => {
  it('dates the journal by the Asia/Dhaka calendar', async () => {
    const context = contextFor('accounts', ORG_B);
    const result = await cash.cashIn(
      context,
      {
        entryId: randomUUID(),
        walletAccountId: account(ORG_B, '1100'),
        incomeAccountId: account(ORG_B, '4300'),
        amountPoisha: '5000',
        memo: 'late-night transfer',
        request: scopedRequest(),
      },
      new Date('2026-06-01T23:30:00Z'),
    );
    expect(result.businessDate).toBe('2026-06-02');

    const actor = await harness.asRole('accounts', ORG_B);
    const onSecond = await actor.client.request(
      'GET',
      '/v1/ledger/day-book?from=2026-06-02&to=2026-06-02',
    );
    const onFirst = await actor.client.request(
      'GET',
      '/v1/ledger/day-book?from=2026-06-01&to=2026-06-01',
    );
    const ids = (body: string) =>
      parse<{ items: { journalId: string }[] }>(body).items.map((item) => item.journalId);
    expect(ids(onSecond.body)).toContain(result.journalId);
    expect(ids(onFirst.body)).not.toContain(result.journalId);
  });
});

describe('row scope and cost: a branch manager sees their branch, and no cost', () => {
  let branch: string;
  let manager: Awaited<ReturnType<HttpHarness['asRole']>>;
  const bank = account(ORG_A, '1100');
  const income = account(ORG_A, '4300');
  const hq = account(ORG_A, '1010-HQ');
  let branchWallet: string;

  beforeAll(async () => {
    branch = await createBranch(ORG_A, 'SR-SCOPE');
    await withSystem(async (tx) => ensureBranchWallets(tx, ORG_A), { orgId: ORG_A });
    branchWallet = account(ORG_A, '1010-SR-SCOPE');
    manager = await harness.asRole('branch_manager', ORG_A, { branchIds: [branch] });

    // Cost-bearing activity in the branch: stock bought with branch cash.
    await post(
      ORG_A,
      draft(
        [
          line(account(ORG_A, '1300'), 40_000n, 0n, { branchId: branch }),
          line(branchWallet, 0n, 40_000n, { branchId: branch }),
        ],
        '2026-07-25',
      ),
    );
  }, 120_000);

  it('posts cash in only to their own branch wallet', async () => {
    const own = await manager.client.request('POST', '/v1/ledger/cash-in', {
      body: {
        entryId: randomUUID(),
        walletAccountId: branchWallet,
        incomeAccountId: income,
        amountPoisha: '90000',
      },
    });
    expect(own.statusCode, own.body).toBe(201);

    // Another branch's wallet, an org-level wallet and a uuid that is nothing
    // at all get the same answer, body included (review L1).
    const bodies = new Set<string>();
    for (const wallet of [hq, bank, randomUUID()]) {
      const other = await manager.client.request('POST', '/v1/ledger/cash-in', {
        body: {
          entryId: randomUUID(),
          walletAccountId: wallet,
          incomeAccountId: income,
          amountPoisha: '100',
        },
      });
      expect(other.statusCode, other.body).toBe(404);
      bodies.add(other.body);
    }
    expect([...bodies]).toHaveLength(1);
  });

  it('lists the org-level income categories cash in needs, and no cost account', async () => {
    const accounts = parse<{ items: { code: string; subtype: string }[] }>(
      (await manager.client.request('GET', '/v1/ledger/accounts')).body,
    ).items;
    expect(accounts.map((row) => row.code)).toContain('4300');
    expect(accounts.map((row) => row.code)).toContain('1010-SR-SCOPE');
    expect(accounts.map((row) => row.code)).not.toContain('1010-HQ');
    expect(accounts.map((row) => row.subtype)).not.toContain('inventory');
  });

  it('never names a cost account in the cash book for a branch manager (audit N6)', async () => {
    interface Book {
      items: { against: { code: string }[] }[];
    }
    const url = `/v1/ledger/wallets/${branchWallet}/cash-book?to=2030-01-01`;
    const managerCodes = parse<Book>((await manager.client.request('GET', url)).body).items.flatMap(
      (item) => item.against.map((entry) => entry.code),
    );
    expect(managerCodes).not.toContain('1300');

    const accounts = await harness.asRole('accounts', ORG_A);
    const accountsCodes = parse<Book>(
      (await accounts.client.request('GET', url)).body,
    ).items.flatMap((item) => item.against.map((entry) => entry.code));
    expect(accountsCodes).toContain('1300');
  });

  it('lists only their wallet, and 404s another branch’s cash book', async () => {
    const wallets = await manager.client.request('GET', '/v1/ledger/wallets');
    expect(
      parse<{ items: { accountId: string }[] }>(wallets.body).items.map((item) => item.accountId),
    ).toEqual([branchWallet]);
    const other = await manager.client.request(
      'GET',
      `/v1/ledger/wallets/${hq}/cash-book?to=2030-01-01`,
    );
    expect(other.statusCode).toBe(404);
    const own = await manager.client.request(
      'GET',
      `/v1/ledger/wallets/${branchWallet}/cash-book?to=2030-01-01`,
    );
    expect(own.statusCode, own.body).toBe(200);
  });

  it('withholds cost accounts from the trial balance and day book, and keeps them for accounts', async () => {
    const managerView = parse<{
      items: { code: string; branchId: string | null; subtype: string }[];
      costWithheld: boolean;
    }>((await manager.client.request('GET', '/v1/ledger/trial-balance?asOf=2030-01-01')).body);
    expect(managerView.costWithheld).toBe(true);
    expect(managerView.items.map((row) => row.subtype)).not.toContain('inventory');
    // Only the branch's lines reached it: the branch wallet and other income.
    expect(managerView.items.map((row) => row.code).sort()).toEqual(['1010-SR-SCOPE', '4300']);

    const accounts = await harness.asRole('accounts', ORG_A);
    const full = parse<{ items: { subtype: string }[]; costWithheld: boolean }>(
      (await accounts.client.request('GET', '/v1/ledger/trial-balance?asOf=2030-01-01')).body,
    );
    expect(full.costWithheld).toBe(false);
    expect(full.items.map((row) => row.subtype)).toContain('inventory');

    const dayBook = parse<{ items: { lines: { accountCode: string }[] }[] }>(
      (await manager.client.request('GET', '/v1/ledger/day-book?from=2026-07-25&to=2026-07-25'))
        .body,
    );
    const codes = dayBook.items.flatMap((item) => item.lines.map((l) => l.accountCode));
    expect(codes).toContain('1010-SR-SCOPE');
    expect(codes).not.toContain('1300');

    const inventoryLedger = await manager.client.request(
      'GET',
      `/v1/ledger/accounts/${account(ORG_A, '1300')}/ledger?to=2030-01-01`,
    );
    expect(inventoryLedger.statusCode).toBe(404);
  });

  it('shows party balances to accounts, and never a supplier balance to a branch manager', async () => {
    const supplier = randomUUID();
    const courier = randomUUID();
    await post(
      ORG_A,
      draft(
        [
          line(account(ORG_A, '1200'), 3_000n, 0n, {
            partyType: 'courier',
            partyId: courier,
            branchId: branch,
          }),
          line(account(ORG_A, '1300'), 2_000n, 0n, { branchId: branch }),
          line(account(ORG_A, '2100'), 0n, 2_000n, {
            partyType: 'supplier',
            partyId: supplier,
            branchId: branch,
          }),
          line(income, 0n, 3_000n, { branchId: branch }),
        ],
        '2026-07-26',
      ),
    );

    const accounts = await harness.asRole('accounts', ORG_A);
    const full = parse<{ items: { partyId: string; balancePoisha: string }[] }>(
      (await accounts.client.request('GET', '/v1/ledger/party-balances?asOf=2030-01-01')).body,
    ).items;
    expect(full.find((row) => row.partyId === supplier)?.balancePoisha).toBe('2000');
    expect(full.find((row) => row.partyId === courier)?.balancePoisha).toBe('3000');

    const limited = parse<{ items: { partyId: string; partyType: string }[] }>(
      (await manager.client.request('GET', '/v1/ledger/party-balances?asOf=2030-01-01')).body,
    ).items;
    expect(limited.map((row) => row.partyType)).not.toContain('supplier');
    expect(limited.find((row) => row.partyId === courier)).toBeDefined();
  });
});

describe("tenancy: one org never reaches another org's ledger", () => {
  it("404s another org's account and wallet, and posts nothing into them", async () => {
    const outsider = await harness.asRole('accounts', ORG_B);
    const bankA = account(ORG_A, '1100');

    const ledgerResponse = await outsider.client.request(
      'GET',
      `/v1/ledger/accounts/${bankA}/ledger?to=2030-01-01`,
    );
    expect(ledgerResponse.statusCode).toBe(404);

    const cashIn = await outsider.client.request('POST', '/v1/ledger/cash-in', {
      body: {
        entryId: randomUUID(),
        walletAccountId: bankA,
        incomeAccountId: account(ORG_B, '4300'),
        amountPoisha: '100',
      },
    });
    expect(cashIn.statusCode).toBe(404);

    const accounts = parse<{ items: { id: string }[] }>(
      (await outsider.client.request('GET', '/v1/ledger/accounts')).body,
    ).items.map((item) => item.id);
    expect(accounts).not.toContain(bankA);
    expect(accounts).toContain(account(ORG_B, '1100'));
  });

  it('refuses an account from another org inside a draft', async () => {
    const refused = await failure(
      post(
        ORG_B,
        draft([line(account(ORG_A, '1100'), 10n, 0n), line(account(ORG_B, '4300'), 0n, 10n)]),
      ),
    );
    expect(refused.code).toBe('LEDGER_ACCOUNT_INVALID');
  });
});

describe('large amounts (security review M2)', () => {
  it('caps a single cash-in, and still serves reports over balances past 9e15', async () => {
    const actor = await harness.asRole('accounts', ORG_D);
    const tooBig = await actor.client.request('POST', '/v1/ledger/cash-in', {
      body: {
        entryId: randomUUID(),
        walletAccountId: account(ORG_D, '1110'),
        incomeAccountId: account(ORG_D, '4300'),
        // One poisha over the default ৳1 crore cap.
        amountPoisha: '1000000001',
      },
    });
    expect(tooBig.statusCode).toBe(400);
    expect(parse<{ code: string }>(tooBig.body).code).toBe('POSTING_INPUT_INVALID');

    // Two maximal journals: each is a legal amount, their sum is not a Poisha.
    for (let i = 0; i < 2; i += 1) {
      await post(
        ORG_D,
        draft(
          [
            line(account(ORG_D, '1110'), 9_000_000_000_000_000n, 0n),
            line(account(ORG_D, '3100'), 0n, 9_000_000_000_000_000n),
          ],
          '2026-06-15',
        ),
      );
    }
    const trial = await actor.client.request('GET', '/v1/ledger/trial-balance?asOf=2030-01-01');
    expect(trial.statusCode, trial.body).toBe(200);
    const body = parse<{
      items: { code: string; balancePoisha: string }[];
      differencePoisha: string;
    }>(trial.body);
    expect(body.differencePoisha).toBe('0');
    expect(body.items.find((row) => row.code === '1110')?.balancePoisha).toBe('18000000000000000');

    for (const url of [
      '/v1/ledger/wallets',
      `/v1/ledger/wallets/${account(ORG_D, '1110')}/cash-book?to=2030-01-01`,
      `/v1/ledger/accounts/${account(ORG_D, '3100')}/ledger?to=2030-01-01`,
    ]) {
      const response = await actor.client.request('GET', url);
      expect(response.statusCode, `${url} ${response.body}`).toBe(200);
    }
  });
});

describe('the database knows each subtype as the domain does (0015)', () => {
  it('ledger.subtype_shape agrees with ACCOUNT_SUBTYPES for every subtype', async () => {
    const rows = await withSystem(async (tx) =>
      tx.execute<{
        subtype: string;
        class: string;
        normal_balance: string;
        party_type: string | null;
      }>(
        sql`select s.subtype::text as subtype, shape.class::text as class,
                   shape.normal_balance::text as normal_balance, shape.party_type::text as party_type
            from unnest(enum_range(null::ledger.account_subtype)) as s(subtype)
            cross join lateral ledger.subtype_shape(s.subtype) as shape`,
      ),
    );
    expect(rows.length).toBe(ACCOUNT_SUBTYPE_NAMES.length);
    for (const row of rows) {
      const info = ACCOUNT_SUBTYPES[row.subtype as keyof typeof ACCOUNT_SUBTYPES];
      expect([row.class, row.normal_balance, row.party_type], row.subtype).toEqual([
        info.class,
        info.normalBalance,
        info.party,
      ]);
    }
  });
});

/**
 * The resolver HR depends on since it stopped reading `ledger.accounts` itself (D-199).
 *
 * Two rules are load-bearing and neither was asserted anywhere: an inactive account is
 * never chosen, and where a brand has added a second account of a subtype the lowest code
 * wins. Payroll, payroll payment and loan disbursement across all five brands now share
 * this one resolver with the ledger's own cash service, so a change made for one caller
 * moves the others' journals. The failure is silent — the journal still balances, the
 * trial balance is still zero, and the salary liability accumulates in the wrong account.
 */
describe('accountBySubtype picks the account a posting rule means', () => {
  it('skips an inactive account and takes the lowest code among the active ones', async () => {
    const seeded = await withSystem(
      async (tx) => {
        const add = async (code: string, isActive: boolean) => {
          const rows = await tx.execute<{ id: string }>(sql`
            insert into ledger.accounts (org_id, code, name, class, subtype, normal_balance, is_active)
            values (${ORG_B}, ${code}, ${`Salary payable ${code}`}, 'liability',
                    'salary_payable'::ledger.account_subtype, 'credit', ${isActive})
            on conflict (org_id, code) do update set is_active = excluded.is_active
            returning id
          `);
          return rows[0]?.id ?? '';
        };
        // Lower code than either, and inactive: the row a naive `order by code` takes.
        const closed = await add('2095-CLOSED', false);
        const lowest = await add('2096-LOW', true);
        const higher = await add('2097-HIGH', true);
        return { closed, lowest, higher };
      },
      { orgId: ORG_B },
    );

    const chosen = await withOrg({ orgId: ORG_B, userId: ACTOR }, (tx) =>
      ledger.accountBySubtype(tx, ORG_B, 'salary_payable'),
    );

    // The seed's own 2300 is lower than all three, so it is what must win; what the
    // assertion really pins is that neither the inactive row nor a higher code does.
    expect(chosen).not.toBeNull();
    expect(chosen?.accountId).not.toBe(seeded.closed);
    expect(chosen?.accountId).not.toBe(seeded.higher);

    const code = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ code: string }>(
            sql`select code from ledger.accounts where org_id = ${ORG_B} and id = ${chosen?.accountId ?? ''}`,
          )
        )[0]?.code ?? '',
      { orgId: ORG_B },
    );
    const everyActive = await withSystem(
      async (tx) =>
        [
          ...(await tx.execute<{ code: string }>(sql`
            select code from ledger.accounts
            where org_id = ${ORG_B} and subtype = 'salary_payable'::ledger.account_subtype
              and is_active
            order by code
          `)),
        ].map((row) => row.code),
      { orgId: ORG_B },
    );
    expect(code).toBe(everyActive[0]);
    expect(everyActive).not.toContain('2095-CLOSED');
  });
});
