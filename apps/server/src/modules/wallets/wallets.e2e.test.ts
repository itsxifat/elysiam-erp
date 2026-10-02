import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, withOrg, withSystem } from '@elysium/db';
import { addDays, poisha, toIsoDate, ZERO } from '@elysium/domain';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  ORG_B,
  startHttpHarness,
  type Client,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { resetFilesEnv } from '../files/files.config.js';
import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import { WalletsModule } from './wallets.module.js';
import { applyWalletsMigrations } from './wallets.testing.js';

/**
 * Wallets and the cash picture, against a real database (M08 acceptance checks).
 *
 * The suite is built around **check 1**, and the shape of it is the point:
 *
 * > a scripted day of entries leaves every cash book closing balance equal to its
 * > ledger balance, and the trial balance at zero.
 *
 * So `scriptedDay()` below does what a showroom actually does in a day — takes
 * cash in, pays a bill, buys packaging out of the till, banks the float and pays a
 * bank charge, then counts the drawer — and every assertion afterwards compares two
 * *independently computed* answers: this module's wallet balance, M03's cash book
 * closing balance, and M03's trial balance row for the same account. Three queries
 * over the same journal lines. That is only a real check because no balance is
 * stored anywhere: if one were, all three would read it and agree while being
 * wrong together.
 *
 * `ORG_C` is the third brand, for check 3's consolidated total. Three orgs rather
 * than two because a sum of two is the same as a difference and the same as a
 * maximum for some inputs, and a bug that returns "the first org's total" passes a
 * two-org test half the time.
 */

const ORG_C = SEED_ORG_IDS.orvo ?? '';

let harness: HttpHarness;
let accounts: RoleClient;
let admin: RoleClient;
let secondAdmin: RoleClient;
let sales: RoleClient;
let branchManager: RoleClient;
let superAdmin: RoleClient;

/** The org's seeded HQ branch, and a second branch this suite adds for scope tests. */
let hqBranch = '';
let otherBranch = '';
const ledgerAccounts = new Map<string, { id: string; branchId: string | null }>();
const wallets = { handCash: '', bank: '', bkash: '', handCashAccount: '', bankAccount: '' };

beforeAll(async () => {
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_LOCAL_ROOT = await mkdtemp(path.join(tmpdir(), 'elysium-wallets-e2e-'));
  process.env.FILE_URL_TTL_SECONDS = '120';
  resetFilesEnv();

  // `WalletsModule` is handed to the harness rather than added to `app.module.ts`:
  // that file is shared with the other milestones building in parallel, and the
  // integrator adds the one import line. Nest builds each module once per app, so
  // this shares the approvals and ledger instances `AppModule` already made —
  // which is what makes the executors registered here visible to the approvals
  // route.
  harness = await startHttpHarness('wallets', { extraModules: [WalletsModule] });
  await applyWalletsMigrations();

  await withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
      select id from org.branches where org_id = ${ORG_A} and code = 'HQ'
    `);
      hqBranch = rows[0]?.id ?? '';
      const inserted = await tx.execute<{ id: string }>(sql`
      insert into org.branches (org_id, code, name, kind)
      values (${ORG_A}, 'SHR-2', 'Second Showroom', 'showroom')
      on conflict (org_id, code) do update set name = excluded.name
      returning id
    `);
      otherBranch = inserted[0]?.id ?? '';
    },
    { orgId: ORG_A },
  );

  accounts = await harness.asRole('accounts', ORG_A);
  admin = await harness.asRole('org_admin', ORG_A);
  secondAdmin = await harness.asRole('org_admin', ORG_A);
  sales = await harness.asRole('sales', ORG_A);
  branchManager = await harness.asRole('branch_manager', ORG_A, { branchIds: [otherBranch] });
  superAdmin = await makeSuperAdmin();

  await loadAccounts();
  await setThreshold('wallet_adjustment', '100000');
  await registerWallets();
  await scriptedDay();
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

// --- helpers -----------------------------------------------------------------

function body<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

/**
 * A super admin: an ordinary member whose `iam.users` row carries the platform
 * flag.
 *
 * `is_super_admin` is a column rather than a membership role (§5 exception 3), and
 * the request context is rebuilt from the session on every request — so flipping it
 * after sign-in is enough, and it also proves the context is not cached.
 */
async function makeSuperAdmin(): Promise<RoleClient> {
  const client = await harness.asRole('accounts', ORG_A);
  await withSystem(async (tx) => {
    await tx.execute(sql`update iam.users set is_super_admin = true where id = ${client.userId}`);
  });
  return client;
}

async function loadAccounts(): Promise<void> {
  const response = await accounts.client.request('GET', '/v1/ledger/accounts');
  expect(response.statusCode, response.body).toBe(200);
  const parsed = body<{ items: { id: string; code: string; branchId: string | null }[] }>(response);
  for (const item of parsed.items)
    ledgerAccounts.set(item.code, { id: item.id, branchId: item.branchId });
}

function accountId(code: string): string {
  const account = ledgerAccounts.get(code);
  if (account === undefined) throw new Error(`the seed has no account ${code}`);
  return account.id;
}

/**
 * Configure one org threshold, through the real flow.
 *
 * Setting the first threshold for a type is itself a `threshold_change` request a
 * *second* org admin has to approve (D-073) — so this is two calls, and it is
 * worth doing through the API rather than writing the row: a threshold inserted
 * behind the approvals module's back would be a threshold the module never agreed
 * to, and the test would then be asserting against a state production cannot reach.
 */
async function setThreshold(type: string, thresholdPoisha: string): Promise<void> {
  const set = await admin.client.request('PUT', '/v1/approvals/thresholds', {
    body: { type, thresholdPoisha },
  });
  expect(set.statusCode, set.body).toBe(200);
  const { approvalId } = body<{ approvalId: string | null }>(set);
  if (approvalId === null) return;

  const decided = await secondAdmin.client.request('POST', `/v1/approvals/${approvalId}/decide`, {
    body: { decision: 'approved' },
  });
  // 201: a decision creates a record of itself.
  expect(decided.statusCode, decided.body).toBe(201);
}

async function registerWallets(): Promise<void> {
  const handCash = await accounts.client.request('POST', '/v1/accounts/wallets', {
    body: { account: { existingAccountId: accountId('1010-HQ') }, branchId: hqBranch },
  });
  expect(handCash.statusCode, handCash.body).toBe(201);
  const bank = await accounts.client.request('POST', '/v1/accounts/wallets', {
    body: {
      account: { existingAccountId: accountId('1100') },
      provider: 'BRAC Bank',
      accountRefLast4: '4417',
    },
  });
  expect(bank.statusCode, bank.body).toBe(201);
  const bkash = await accounts.client.request('POST', '/v1/accounts/wallets', {
    body: { account: { existingAccountId: accountId('1110') }, provider: 'bKash' },
  });
  expect(bkash.statusCode, bkash.body).toBe(201);

  wallets.handCash = body<{ id: string }>(handCash).id;
  wallets.handCashAccount = body<{ ledgerAccountId: string }>(handCash).ledgerAccountId;
  wallets.bank = body<{ id: string }>(bank).id;
  wallets.bankAccount = body<{ ledgerAccountId: string }>(bank).ledgerAccountId;
  wallets.bkash = body<{ id: string }>(bkash).id;
}

/** The whole file upload flow, as `files.e2e.test.ts` drives it. */
async function uploadReceipt(client: Client): Promise<string> {
  const bytes = await sharp({
    create: { width: 32, height: 32, channels: 3, background: '#404040' },
  })
    .jpeg()
    .toBuffer();

  const ticketResponse = await client.request('POST', '/v1/files', {
    body: {
      purpose: 'petty-cash-receipt',
      contentType: 'image/jpeg',
      sizeBytes: bytes.byteLength,
      originalName: 'receipt.jpg',
    },
  });
  expect(ticketResponse.statusCode, ticketResponse.body).toBe(201);
  const ticket = body<{ fileId: string; url: string; headers: Record<string, string> }>(
    ticketResponse,
  );

  const url = new URL(ticket.url);
  const put = await harness.server.inject({
    method: 'PUT',
    url: `${url.pathname}${url.search}`,
    headers: { ...ticket.headers, host: url.host },
    payload: bytes,
  });
  expect(put.statusCode, put.body).toBe(200);

  const finalize = await client.request('POST', `/v1/files/${ticket.fileId}/finalize`);
  expect(finalize.statusCode, finalize.body).toBe(201);
  return ticket.fileId;
}

interface DayRecord {
  readonly pettyReceipt: string;
  readonly heldEntryId: string;
  readonly heldApprovalId: string;
  readonly closingId: string;
  readonly closingApprovalId: string;
  readonly variancePoisha: string;
}

let day: DayRecord;

/**
 * One business day in a showroom, posted through the real endpoints.
 *
 * Every figure here is chosen so a person can add them up: the till takes ৳2,000,
 * pays ৳300 for a courier, spends ৳150 on packaging, banks ৳1,000 with a ৳20
 * charge, and is then counted ৳50 short.
 */
async function scriptedDay(): Promise<void> {
  const client = accounts.client;

  const cashIn = await client.request('POST', '/v1/accounts/cash-entries', {
    body: {
      entryId: randomUUID(),
      walletId: wallets.handCash,
      kind: 'cash_in',
      categoryAccountId: accountId('4300'),
      amountPoisha: '200000',
      memo: 'Scrap cartons sold',
    },
  });
  expect(cashIn.statusCode, cashIn.body).toBe(201);
  expect(body<{ status: string }>(cashIn).status).toBe('posted');

  const cashOut = await client.request('POST', '/v1/accounts/cash-entries', {
    body: {
      entryId: randomUUID(),
      walletId: wallets.handCash,
      kind: 'cash_out',
      categoryAccountId: accountId('5830'),
      amountPoisha: '30000',
      memo: 'Courier van fare',
    },
  });
  expect(cashOut.statusCode, cashOut.body).toBe(201);

  // Petty cash under the ৳1,000 threshold: posts straight away, with its receipt.
  const receipt = await uploadReceipt(client);
  const petty = await client.request('POST', '/v1/accounts/cash-entries', {
    body: {
      entryId: randomUUID(),
      walletId: wallets.handCash,
      kind: 'petty_cash',
      categoryAccountId: accountId('5820'),
      amountPoisha: '15000',
      receiptFileId: receipt,
      memo: 'Poly bags',
    },
  });
  expect(petty.statusCode, petty.body).toBe(201);
  expect(body<{ status: string }>(petty).status).toBe('posted');

  // Petty cash at or above the threshold: recorded, but nothing posted until a
  // checker decides it.
  const heldReceipt = await uploadReceipt(client);
  const heldEntryId = randomUUID();
  const held = await client.request('POST', '/v1/accounts/cash-entries', {
    body: {
      entryId: heldEntryId,
      walletId: wallets.handCash,
      kind: 'petty_cash',
      categoryAccountId: accountId('5890'),
      amountPoisha: '250000',
      receiptFileId: heldReceipt,
      memo: 'Signboard repair',
    },
  });
  expect(held.statusCode, held.body).toBe(201);
  const heldResult = body<{ status: string; approvalId: string; journalId: null }>(held);
  expect(heldResult.status).toBe('pending_approval');
  expect(heldResult.journalId).toBeNull();

  const transfer = await client.request('POST', '/v1/accounts/transfers', {
    body: {
      transferId: randomUUID(),
      fromWalletId: wallets.handCash,
      toWalletId: wallets.bank,
      amountPoisha: '100000',
      chargePoisha: '2000',
      chargeAccountId: accountId('5710'),
      memo: 'Float banked',
    },
  });
  expect(transfer.statusCode, transfer.body).toBe(201);

  // The till at close: 2,000 − 300 − 150 − 1,000 − 20 = ৳530, counted ৳480.
  const closingId = randomUUID();
  const closing = await client.request('POST', '/v1/accounts/closings', {
    body: {
      closingId,
      walletId: wallets.handCash,
      businessDate: today(),
      countedPoisha: '48000',
      memo: 'Drawer count',
    },
  });
  expect(closing.statusCode, closing.body).toBe(201);
  const closed = body<{
    status: string;
    approvalId: string;
    expectedPoisha: string;
    variancePoisha: string;
  }>(closing);

  day = {
    pettyReceipt: heldReceipt,
    heldEntryId,
    heldApprovalId: heldResult.approvalId,
    closingId,
    closingApprovalId: closed.approvalId,
    variancePoisha: closed.variancePoisha,
  };
}

/** Today in Asia/Dhaka, as the server computes a business date (invariant 8). */
function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// --- check 1 ------------------------------------------------------------------

describe('check 1: the cash books agree with the ledger, and the trial balance is zero', () => {
  it('derives every wallet balance from journal lines, so three queries give one answer', async () => {
    const asOf = today();

    const walletList = body<{
      items: { id: string; ledgerAccountId: string; code: string; balancePoisha: string }[];
    }>(await accounts.client.request('GET', `/v1/accounts/wallets?asOf=${asOf}`));
    expect(walletList.items.length).toBe(3);

    const trial = body<{
      items: { accountId: string; balancePoisha: string }[];
      differencePoisha: string;
    }>(await accounts.client.request('GET', `/v1/ledger/trial-balance?asOf=${asOf}`));

    for (const wallet of walletList.items) {
      // M03's cash book: the same lines, summed by a different query, with an
      // opening balance and a running total in between.
      const cashBook = body<{ closingBalancePoisha: string }>(
        await accounts.client.request(
          'GET',
          `/v1/ledger/wallets/${wallet.ledgerAccountId}/cash-book?to=${asOf}`,
        ),
      );
      expect(cashBook.closingBalancePoisha, `cash book for ${wallet.code}`).toBe(
        wallet.balancePoisha,
      );

      const fromTrial = trial.items.find((item) => item.accountId === wallet.ledgerAccountId);
      // A wallet with no lines has no trial-balance row at all, and a balance of
      // zero is the right answer for it rather than a missing one.
      expect(fromTrial?.balancePoisha ?? '0', `trial balance for ${wallet.code}`).toBe(
        wallet.balancePoisha,
      );
    }

    // ৳2,000 in, ৳300 + ৳150 out, ৳1,000 banked with a ৳20 charge. The held
    // petty cash and the unapproved variance are deliberately not in it.
    const handCash = walletList.items.find((item) => item.code === '1010-HQ');
    expect(handCash?.balancePoisha).toBe('53000');
    const bank = walletList.items.find((item) => item.code === '1100');
    expect(bank?.balancePoisha).toBe('100000');

    expect(trial.differencePoisha).toBe('0');
  });

  it('shows the day in the day book, and the bank charge as its own line', async () => {
    const asOf = today();
    const dayBook = body<{
      items: {
        sourceType: string;
        lines: { accountCode: string; debitPoisha: string; creditPoisha: string }[];
      }[];
    }>(await accounts.client.request('GET', `/v1/ledger/day-book?from=${asOf}&to=${asOf}`));

    const sources = dayBook.items.map((item) => item.sourceType);
    expect(sources).toContain('cash_in');
    expect(sources).toContain('cash_out');
    expect(sources).toContain('petty_cash');
    expect(sources).toContain('wallet_transfer');

    // §7: Dr W2 + Dr Bank charges / Cr W1. The charge is a third line, not a
    // deduction from the amount — a two-line transfer would balance and lose it.
    const banked = dayBook.items.find((item) => item.sourceType === 'wallet_transfer');
    expect(banked?.lines).toHaveLength(3);
    const charge = banked?.lines.find((line) => line.accountCode === '5710');
    expect(charge?.debitPoisha).toBe('2000');
    const paid = banked?.lines.find((line) => line.accountCode === '1010-HQ');
    expect(paid?.creditPoisha).toBe('102000');
  });

  it('puts the day in the P&L, and the operating expenses under it', async () => {
    const asOf = today();
    const pnl = body<{
      income: { code: string; amountPoisha: string }[];
      expense: { code: string; amountPoisha: string }[];
      incomePoisha: string;
      expensePoisha: string;
      netPoisha: string;
      costWithheld: boolean;
    }>(
      await accounts.client.request(
        'GET',
        `/v1/accounts/reports/profit-and-loss?from=${asOf}&to=${asOf}`,
      ),
    );

    expect(pnl.incomePoisha).toBe('200000');
    // ৳300 transport + ৳150 packaging + ৳20 bank charge.
    expect(pnl.expensePoisha).toBe('47000');
    expect(pnl.netPoisha).toBe('153000');
    expect(pnl.costWithheld).toBe(false);
    expect(pnl.expense.map((line) => line.code)).toEqual(
      expect.arrayContaining(['5710', '5820', '5830']),
    );
  });

  it('balances the balance sheet for a caller who can see cost', async () => {
    const sheet = body<{ differencePoisha: string; costWithheld: boolean }>(
      await accounts.client.request('GET', `/v1/accounts/reports/balance-sheet?asOf=${today()}`),
    );
    expect(sheet.costWithheld).toBe(false);
    expect(sheet.differencePoisha).toBe('0');
  });
});

// --- check 2 ------------------------------------------------------------------

describe('check 2: petty cash needs a receipt, and the receipt is private', () => {
  it('refuses petty cash with no receipt', async () => {
    const response = await accounts.client.request('POST', '/v1/accounts/cash-entries', {
      body: {
        entryId: randomUUID(),
        walletId: wallets.handCash,
        kind: 'petty_cash',
        categoryAccountId: accountId('5890'),
        amountPoisha: '5000',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('receipt');
  });

  it('refuses a receipt uploaded under another purpose, which would be readable by anyone', async () => {
    const bytes = await sharp({
      create: { width: 16, height: 16, channels: 3, background: '#808080' },
    })
      .jpeg()
      .toBuffer();
    const ticket = body<{ fileId: string; url: string; headers: Record<string, string> }>(
      await accounts.client.request('POST', '/v1/files', {
        body: {
          purpose: 'product-image',
          contentType: 'image/jpeg',
          visibility: 'public',
          sizeBytes: bytes.byteLength,
        },
      }),
    );
    const url = new URL(ticket.url);
    await harness.server.inject({
      method: 'PUT',
      url: `${url.pathname}${url.search}`,
      headers: { ...ticket.headers, host: url.host },
      payload: bytes,
    });
    await accounts.client.request('POST', `/v1/files/${ticket.fileId}/finalize`);

    const response = await accounts.client.request('POST', '/v1/accounts/cash-entries', {
      body: {
        entryId: randomUUID(),
        walletId: wallets.handCash,
        kind: 'petty_cash',
        categoryAccountId: accountId('5890'),
        amountPoisha: '5000',
        receiptFileId: ticket.fileId,
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).toContain('petty-cash-receipt');
  });

  it('needs permission to read one: accounts may, a sales agent may not', async () => {
    const allowed = await accounts.client.request('GET', `/v1/files/${day.pettyReceipt}/download`);
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(body<{ url: string }>(allowed).url).toContain('/v1/files/content?t=');

    // A sales agent holds `read FileObject` at org scope and downloads payment
    // screenshots all day. What refuses them here is the purpose gate: a
    // petty-cash receipt needs `read Wallet`, which §6 gives them nowhere.
    const refused = await sales.client.request('GET', `/v1/files/${day.pettyReceipt}/download`);
    expect(refused.statusCode).toBe(403);
    expect(refused.body).not.toContain('/v1/files/content');
  });
});

// --- check 3 ------------------------------------------------------------------

describe('check 3: the consolidated total is the sum of the orgs', () => {
  it('adds three brands up, read through the analytics role', async () => {
    // Money in two more brands, posted through each org's own scoped path.
    const inB = await harness.asRole('accounts', ORG_B);
    const inC = await harness.asRole('accounts', ORG_C);
    await postCashIn(inB, ORG_B, '70000');
    await postCashIn(inC, ORG_C, '110000');

    const consolidated = body<{
      orgs: { orgId: string; totalPoisha: string }[];
      totalPoisha: string;
    }>(await superAdmin.client.request('GET', '/v1/accounts/reports/consolidated-wallets'));

    const sum = consolidated.orgs.reduce((total, org) => total + BigInt(org.totalPoisha), 0n);
    expect(consolidated.totalPoisha).toBe(sum.toString());

    const byOrg = new Map(consolidated.orgs.map((org) => [org.orgId, org.totalPoisha]));
    // ORG_A: ৳530 in the till + ৳1,000 in the bank.
    expect(byOrg.get(ORG_A)).toBe('153000');
    expect(byOrg.get(ORG_B)).toBe('70000');
    expect(byOrg.get(ORG_C)).toBe('110000');
    expect(BigInt(consolidated.totalPoisha)).toBe(153_000n + 70_000n + 110_000n);
  });

  it('refuses an org admin, whose LedgerReport grant is org-wide and not cross-org', async () => {
    const response = await admin.client.request('GET', '/v1/accounts/reports/consolidated-wallets');
    expect(response.statusCode).toBe(403);
  });

  it('gives each brand the P&L its own accounts team reads, and adds them up', async () => {
    const range = `from=${addDays(toIsoDate(today()), -60)}&to=${today()}`;
    const consolidated = body<{
      orgs: { orgId: string; incomePoisha: string; expensePoisha: string; netPoisha: string }[];
      incomePoisha: string;
      expensePoisha: string;
      netPoisha: string;
    }>(
      await superAdmin.client.request(
        'GET',
        `/v1/accounts/reports/consolidated-profit-and-loss?${range}`,
      ),
    );

    // Each brand's line, against that brand's own P&L read through its own scope.
    for (const [orgId, role] of [
      [ORG_A, accounts],
      [ORG_B, await harness.asRole('accounts', ORG_B)],
      [ORG_C, await harness.asRole('accounts', ORG_C)],
    ] as const) {
      const own = body<{ incomePoisha: string; expensePoisha: string }>(
        await role.client.request('GET', `/v1/accounts/reports/profit-and-loss?${range}`),
      );
      const line = consolidated.orgs.find((org) => org.orgId === orgId);
      expect(line, `${orgId} is in the consolidated P&L`).toBeDefined();
      expect(line?.incomePoisha).toBe(own.incomePoisha);
      expect(line?.expensePoisha).toBe(own.expensePoisha);
      expect(BigInt(line?.netPoisha ?? '0')).toBe(
        BigInt(own.incomePoisha) - BigInt(own.expensePoisha),
      );
    }

    // ORG_B and ORG_C took ৳700 and ৳1,100 of other income above, and nothing else.
    expect(consolidated.orgs.find((org) => org.orgId === ORG_B)?.incomePoisha).toBe('70000');
    expect(consolidated.orgs.find((org) => org.orgId === ORG_C)?.incomePoisha).toBe('110000');

    const sum = (field: 'incomePoisha' | 'expensePoisha' | 'netPoisha') =>
      consolidated.orgs.reduce((total, org) => total + BigInt(org[field]), 0n).toString();
    expect(consolidated.incomePoisha).toBe(sum('incomePoisha'));
    expect(consolidated.expensePoisha).toBe(sum('expensePoisha'));
    expect(consolidated.netPoisha).toBe(sum('netPoisha'));
  });

  it('refuses the consolidated P&L to an org admin too', async () => {
    const response = await admin.client.request(
      'GET',
      `/v1/accounts/reports/consolidated-profit-and-loss?from=${today()}&to=${today()}`,
    );
    expect(response.statusCode).toBe(403);
  });
});

/** Register a hand-cash wallet in another org and take money into it. */
async function postCashIn(role: RoleClient, orgId: string, amountPoisha: string): Promise<void> {
  const accountList = body<{ items: { id: string; code: string; branchId: string | null }[] }>(
    await role.client.request('GET', '/v1/ledger/accounts'),
  );
  const cash = accountList.items.find((item) => item.code === '1010-HQ');
  const income = accountList.items.find((item) => item.code === '4300');
  expect(cash?.branchId, `${orgId} has a hand-cash account`).toBeTruthy();

  const wallet = body<{ id: string }>(
    await role.client.request('POST', '/v1/accounts/wallets', {
      body: { account: { existingAccountId: cash?.id }, branchId: cash?.branchId },
    }),
  );
  const response = await role.client.request('POST', '/v1/accounts/cash-entries', {
    body: {
      entryId: randomUUID(),
      walletId: wallet.id,
      kind: 'cash_in',
      categoryAccountId: income?.id,
      amountPoisha,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
}

// --- check 4 ------------------------------------------------------------------

describe('check 4: a closing variance needs approval and posts to cash over/short', () => {
  it('records the shortfall against the derived balance, and posts nothing yet', async () => {
    const listed = body<{
      items: {
        closingId: string;
        expectedPoisha: string;
        countedPoisha: string;
        variancePoisha: string;
        status: string;
        journalId: string | null;
      }[];
    }>(await accounts.client.request('GET', `/v1/accounts/closings?to=${today()}`));

    const closing = listed.items.find((item) => item.closingId === day.closingId);
    // The expected balance is the server's: ৳530 derived from the journal lines,
    // never a number the client sent.
    expect(closing?.expectedPoisha).toBe('53000');
    expect(closing?.countedPoisha).toBe('48000');
    expect(closing?.variancePoisha).toBe('-5000');
    expect(closing?.status).toBe('pending_approval');
    expect(closing?.journalId).toBeNull();
  });

  it('is never auto-approved, whatever the threshold, because it is a branch item', async () => {
    // D-076: a branch item goes to a branch-tier checker and is never waved
    // through. The request exists and is pending even though a threshold for
    // wallet adjustments is configured.
    const approval = body<{ status: string; type: string }>(
      await admin.client.request('GET', `/v1/approvals/${day.closingApprovalId}`),
    );
    expect(approval.type).toBe('closing_variance');
    expect(approval.status).toBe('pending');
  });

  it('refuses the accounts team as checker: they booked the entries', async () => {
    // §6's maker-checker list names closing variances separately from payments,
    // and M03's audit removed `closing_variance` from the accounts checker list
    // for exactly this reason.
    const response = await accounts.client.request(
      'POST',
      `/v1/approvals/${day.closingApprovalId}/decide`,
      { body: { decision: 'approved' } },
    );
    expect(response.statusCode).toBe(403);
  });

  it('posts Dr cash over/short / Cr the wallet when an org admin approves', async () => {
    const decided = await admin.client.request(
      'POST',
      `/v1/approvals/${day.closingApprovalId}/decide`,
      { body: { decision: 'approved' } },
    );
    expect(decided.statusCode, decided.body).toBe(201);

    const listed = body<{
      items: { closingId: string; status: string; journalId: string | null }[];
    }>(await accounts.client.request('GET', `/v1/accounts/closings?to=${today()}`));
    const closing = listed.items.find((item) => item.closingId === day.closingId);
    expect(closing?.status).toBe('posted');
    expect(closing?.journalId).not.toBeNull();

    const overShort = body<{ closingBalancePoisha: string }>(
      await accounts.client.request(
        'GET',
        `/v1/ledger/accounts/${accountId('5700')}/ledger?to=${today()}`,
      ),
    );
    // A ৳50 shortfall is an expense on the debit-normal cash over/short account.
    expect(overShort.closingBalancePoisha).toBe('5000');

    // And the till now agrees with what was counted, which is the whole point of
    // posting the variance rather than filing it.
    const walletList = body<{ items: { code: string; balancePoisha: string }[] }>(
      await accounts.client.request('GET', `/v1/accounts/wallets?asOf=${today()}`),
    );
    expect(walletList.items.find((item) => item.code === '1010-HQ')?.balancePoisha).toBe('48000');

    const trial = body<{ differencePoisha: string }>(
      await accounts.client.request('GET', `/v1/ledger/trial-balance?asOf=${today()}`),
    );
    expect(trial.differencePoisha).toBe('0');
  });

  it('posts the held petty cash only once its own approval is decided', async () => {
    const decided = await admin.client.request(
      'POST',
      `/v1/approvals/${day.heldApprovalId}/decide`,
      { body: { decision: 'approved' } },
    );
    expect(decided.statusCode, decided.body).toBe(201);

    const entries = body<{ items: { id: string; status: string; journalId: string | null }[] }>(
      await accounts.client.request('GET', `/v1/accounts/cash-entries?to=${today()}`),
    );
    const entry = entries.items.find((item) => item.id === day.heldEntryId);
    expect(entry?.status).toBe('posted');
    expect(entry?.journalId).not.toBeNull();

    const trial = body<{ differencePoisha: string }>(
      await accounts.client.request('GET', `/v1/ledger/trial-balance?asOf=${today()}`),
    );
    expect(trial.differencePoisha).toBe('0');
  });
});

// --- check 5 ------------------------------------------------------------------

describe('check 5: the role matrix', () => {
  const readRoutes = [
    '/v1/accounts/wallets',
    '/v1/accounts/categories',
    `/v1/accounts/cash-entries?to=${today()}`,
    `/v1/accounts/closings?to=${today()}`,
    `/v1/accounts/reports/profit-and-loss?from=${today()}&to=${today()}`,
    `/v1/accounts/reports/balance-sheet?asOf=${today()}`,
    `/v1/accounts/reports/aging?asOf=${today()}`,
    '/v1/accounts/reports/consolidated-wallets',
  ];

  it('refuses a sales agent on every accounts route', async () => {
    for (const route of readRoutes) {
      const response = await sales.client.request('GET', route);
      expect(response.statusCode, `GET ${route}`).toBe(403);
    }
    const write = await sales.client.request('POST', '/v1/accounts/cash-entries', {
      body: {
        entryId: randomUUID(),
        walletId: wallets.handCash,
        kind: 'cash_in',
        categoryAccountId: accountId('4300'),
        amountPoisha: '1000',
      },
    });
    expect(write.statusCode).toBe(403);
    const transfer = await sales.client.request('POST', '/v1/accounts/transfers', {
      body: {
        transferId: randomUUID(),
        fromWalletId: wallets.handCash,
        toWalletId: wallets.bank,
        amountPoisha: '1000',
      },
    });
    expect(transfer.statusCode).toBe(403);
  });

  it('lets accounts use everything in the milestone', async () => {
    for (const route of readRoutes.filter((route) => !route.includes('consolidated'))) {
      const response = await accounts.client.request('GET', route);
      expect(response.statusCode, `GET ${route}`).toBe(200);
    }
  });

  it('shows a branch manager only their own branch, and hides the rest', async () => {
    // Their membership is scoped to SHR-2, which has no wallet. The org's
    // hand cash belongs to HQ and the bank and bKash wallets are org-level.
    const visible = body<{ items: { code: string }[]; totalPoisha: string }>(
      await branchManager.client.request('GET', '/v1/accounts/wallets'),
    );
    expect(visible.items).toEqual([]);
    expect(visible.totalPoisha).toBe('0');

    // And the HQ till is "not found" rather than "forbidden": a different answer
    // would let them enumerate the tills other branches keep.
    const refused = await branchManager.client.request('POST', '/v1/accounts/cash-entries', {
      body: {
        entryId: randomUUID(),
        walletId: wallets.handCash,
        kind: 'cash_in',
        categoryAccountId: accountId('4300'),
        amountPoisha: '1000',
      },
    });
    expect(refused.statusCode, refused.body).toBe(404);
  });

  /*
   * The test above only proves that a manager whose branch has no wallet sees an empty
   * list — and so does an implementation that hides every wallet from every branch
   * manager, which is a broken scope and not a narrow one. This is the half that tells
   * them apart: once their branch has a till, they see exactly that till and its real
   * balance, and still nothing of HQ's or of the org-level bank and bKash.
   */
  it('shows a branch manager their own branch’s wallet and its balance, and no other', async () => {
    const created = await accounts.client.request('POST', '/v1/accounts/wallets', {
      body: {
        account: { code: '1010-SHR-2', name: 'Hand cash, Second Showroom', subtype: 'wallet_cash' },
        branchId: otherBranch,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const own = body<{ id: string }>(created);

    // A balance that is not zero, so a scope that listed the right row with the wrong
    // derived figure — or summed someone else's — shows up as a wrong number.
    const cashIn = await accounts.client.request('POST', '/v1/accounts/cash-entries', {
      body: {
        entryId: randomUUID(),
        walletId: own.id,
        kind: 'cash_in',
        categoryAccountId: accountId('4300'),
        amountPoisha: '250000',
        memo: 'Opening float, Second Showroom',
      },
    });
    expect(cashIn.statusCode, cashIn.body).toBe(201);

    const visible = body<{
      items: { id: string; branchId: string | null; balancePoisha: string }[];
      totalPoisha: string;
    }>(await branchManager.client.request('GET', '/v1/accounts/wallets'));
    expect(visible.items.map((wallet) => wallet.id)).toEqual([own.id]);
    expect(visible.items[0]).toMatchObject({ branchId: otherBranch, balancePoisha: '250000' });
    expect(visible.totalPoisha).toBe('250000');

    // Accounts, org-wide, sees both tills and the org-level wallets: the manager's view is
    // a subset of the org's, not a different list.
    const everything = body<{ items: { id: string }[] }>(
      await accounts.client.request('GET', '/v1/accounts/wallets'),
    );
    expect(everything.items.map((wallet) => wallet.id)).toEqual(
      expect.arrayContaining([own.id, wallets.handCash, wallets.bank, wallets.bkash]),
    );
  });

  it('withholds cost from a branch manager’s P&L rather than silently netting it', async () => {
    const pnl = body<{ costWithheld: boolean }>(
      await branchManager.client.request(
        'GET',
        `/v1/accounts/reports/profit-and-loss?from=${today()}&to=${today()}`,
      ),
    );
    // §6: "branch P&L without cost detail". The flag is what stops the net being
    // read as gross profit when COGS has been removed from it (D-085).
    expect(pnl.costWithheld).toBe(true);
  });
});

// --- refusals worth their own test -------------------------------------------

describe('what the module refuses', () => {
  it('refuses a transfer to the same wallet', async () => {
    const response = await accounts.client.request('POST', '/v1/accounts/transfers', {
      body: {
        transferId: randomUUID(),
        fromWalletId: wallets.handCash,
        toWalletId: wallets.handCash,
        amountPoisha: '1000',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a transfer charge posted anywhere but bank charges', async () => {
    const response = await accounts.client.request('POST', '/v1/accounts/transfers', {
      body: {
        transferId: randomUUID(),
        fromWalletId: wallets.handCash,
        toWalletId: wallets.bank,
        amountPoisha: '1000',
        chargePoisha: '100',
        chargeAccountId: accountId('5890'),
      },
    });
    expect(response.statusCode, response.body).toBe(400);
  });

  it('refuses cash in credited to an expense account, and cash out charged to income', async () => {
    const wrongWay = await accounts.client.request('POST', '/v1/accounts/cash-entries', {
      body: {
        entryId: randomUUID(),
        walletId: wallets.handCash,
        kind: 'cash_in',
        categoryAccountId: accountId('5890'),
        amountPoisha: '1000',
      },
    });
    expect(wrongWay.statusCode, wrongWay.body).toBe(400);

    const otherWay = await accounts.client.request('POST', '/v1/accounts/cash-entries', {
      body: {
        entryId: randomUUID(),
        walletId: wallets.handCash,
        kind: 'cash_out',
        categoryAccountId: accountId('4300'),
        amountPoisha: '1000',
      },
    });
    expect(otherWay.statusCode, otherWay.body).toBe(400);
  });

  it('refuses a second wallet over the same ledger account', async () => {
    const response = await accounts.client.request('POST', '/v1/accounts/wallets', {
      body: { account: { existingAccountId: wallets.bankAccount }, provider: 'Duplicate' },
    });
    // Two wallet rows over one account would count the same money twice in the
    // consolidated total.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('refuses a non-wallet account as a wallet', async () => {
    const response = await accounts.client.request('POST', '/v1/accounts/wallets', {
      body: { account: { existingAccountId: accountId('1300') } },
    });
    expect(response.statusCode, response.body).toBe(400);
  });

  it('answers a retried cash entry from the entry that exists', async () => {
    const entryId = randomUUID();
    const payload = {
      entryId,
      walletId: wallets.bkash,
      kind: 'cash_in' as const,
      categoryAccountId: accountId('4300'),
      amountPoisha: '12345',
    };
    const first = await accounts.client.request('POST', '/v1/accounts/cash-entries', {
      body: payload,
    });
    const second = await accounts.client.request('POST', '/v1/accounts/cash-entries', {
      body: payload,
    });
    expect(second.statusCode, second.body).toBe(201);
    expect(body<{ journalId: string }>(second).journalId).toBe(
      body<{ journalId: string }>(first).journalId,
    );
  });

  it('refuses the same entry id used for a different entry', async () => {
    const entryId = randomUUID();
    await accounts.client.request('POST', '/v1/accounts/cash-entries', {
      body: {
        entryId,
        walletId: wallets.bkash,
        kind: 'cash_in',
        categoryAccountId: accountId('4300'),
        amountPoisha: '500',
      },
    });
    const clash = await accounts.client.request('POST', '/v1/accounts/cash-entries', {
      body: {
        entryId,
        walletId: wallets.bkash,
        kind: 'cash_in',
        categoryAccountId: accountId('4300'),
        amountPoisha: '900',
      },
    });
    expect(clash.statusCode).toBe(409);
  });
});

describe('a closed wallet', () => {
  it('drops out of the cash screens, and stays on the setup screen to be reopened', async () => {
    const created = await accounts.client.request('POST', '/v1/accounts/wallets', {
      body: {
        account: { code: '1130-CLOSE', name: 'Old current account', subtype: 'wallet_bank' },
        provider: 'Test Bank',
        accountRefLast4: '0042',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const wallet = body<{ id: string }>(created);

    const closed = await accounts.client.request('PATCH', `/v1/accounts/wallets/${wallet.id}`, {
      body: { isActive: false },
    });
    expect(closed.statusCode, closed.body).toBe(200);

    const ids = async (query: string) =>
      body<{ items: { id: string; isActive: boolean }[] }>(
        await accounts.client.request('GET', `/v1/accounts/wallets${query}`),
      ).items;

    expect((await ids('')).map((row) => row.id)).not.toContain(wallet.id);
    const all = await ids('?includeInactive=true');
    expect(all.find((row) => row.id === wallet.id)?.isActive).toBe(false);

    const reopened = await accounts.client.request('PATCH', `/v1/accounts/wallets/${wallet.id}`, {
      body: { isActive: true },
    });
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect((await ids('')).map((row) => row.id)).toContain(wallet.id);
  });

  it('refuses anything but true or false for includeInactive', async () => {
    const response = await accounts.client.request(
      'GET',
      '/v1/accounts/wallets?includeInactive=yes',
    );
    expect(response.statusCode).toBe(400);
  });
});

/**
 * Aging by open item (§7, D-193), against journals the real ledger posted.
 *
 * Bills and payments are posted on past business dates straight through the
 * ledger, because the supply module that would raise them is not part of this
 * harness; the party, the account and the date are all the report reads.
 */
describe('payables aging matches settlements to the oldest open amount', () => {
  it('ages a part-paid bill by the bill, takes an advance off the next bill, and never shows a negative bucket', async () => {
    const ledger = harness.app.get<LedgerApi>(LEDGER_API, { strict: false });
    const asOf = toIsoDate(today());
    const [partPaid, advanced, overpaid] = [randomUUID(), randomUUID(), randomUUID()];

    const post = (supplierId: string, daysAgo: number, kind: 'bill' | 'payment', amount: bigint) =>
      withOrg({ orgId: ORG_A, userId: accounts.userId }, (tx) => {
        const supplierLine = {
          accountId: accountId('2100'),
          debitPoisha: kind === 'payment' ? poisha(amount) : ZERO,
          creditPoisha: kind === 'bill' ? poisha(amount) : ZERO,
          branchId: null,
          partyType: 'supplier' as const,
          partyId: supplierId,
          memo: null,
        };
        // The other side is an expense for a bill and another payable for a
        // payment: neither touches a wallet, so the cash checks above are unmoved.
        const otherLine = {
          accountId: accountId(kind === 'bill' ? '5890' : '2900'),
          debitPoisha: kind === 'bill' ? poisha(amount) : ZERO,
          creditPoisha: kind === 'payment' ? poisha(amount) : ZERO,
          branchId: null,
          partyType: null,
          partyId: null,
          memo: null,
        };
        const sourceId = randomUUID();
        return ledger.post(
          tx,
          { orgId: ORG_A, userId: accounts.userId },
          {
            businessDate: addDays(asOf, -daysAgo),
            sourceType: 'aging_fixture',
            sourceId,
            event: kind,
            idempotencyKey: `aging_fixture:${sourceId}:${kind}`,
            memo: null,
            reversesJournalId: null,
            lines: [supplierLine, otherLine],
          },
        );
      });

    await post(partPaid, 40, 'bill', 100_000n);
    await post(partPaid, 3, 'payment', 40_000n);
    await post(advanced, 20, 'payment', 50_000n);
    await post(advanced, 10, 'bill', 80_000n);
    await post(overpaid, 5, 'bill', 10_000n);
    await post(overpaid, 2, 'payment', 15_000n);

    const response = await accounts.client.request(
      'GET',
      `/v1/accounts/reports/aging?asOf=${asOf}&side=payable`,
    );
    expect(response.statusCode, response.body).toBe(200);
    const items = body<{
      items: {
        partyId: string;
        bucket0to7Poisha: string;
        bucket8to30Poisha: string;
        bucket31to60Poisha: string;
        bucketOver60Poisha: string;
        unappliedPoisha: string;
        totalPoisha: string;
      }[];
    }>(response).items;
    const row = (id: string) => items.find((item) => item.partyId === id);

    expect(row(partPaid)).toMatchObject({
      bucket0to7Poisha: '0',
      bucket8to30Poisha: '0',
      bucket31to60Poisha: '60000',
      bucketOver60Poisha: '0',
      unappliedPoisha: '0',
      totalPoisha: '60000',
    });
    expect(row(advanced)).toMatchObject({
      bucket8to30Poisha: '30000',
      bucket31to60Poisha: '0',
      unappliedPoisha: '0',
      totalPoisha: '30000',
    });
    expect(row(overpaid)).toMatchObject({
      bucket0to7Poisha: '0',
      unappliedPoisha: '5000',
      totalPoisha: '-5000',
    });
  });
});

// --- what the M08 gap-closure ledger audit found --------------------------------

/** One balanced journal with a party line, posted on a past business date. */
async function postPartyJournal(input: {
  readonly partyType: 'supplier' | 'courier';
  readonly partyId: string;
  readonly partyAccount: string;
  readonly otherAccount: string;
  /** Which side the party line is on. */
  readonly partySide: 'debit' | 'credit';
  readonly amount: bigint;
  readonly daysAgo: number;
  readonly branchId?: string | null;
}): Promise<void> {
  const ledger = harness.app.get<LedgerApi>(LEDGER_API, { strict: false });
  const amount = poisha(input.amount);
  const line = (accountCode: string, debit: boolean, party: boolean) => ({
    accountId: accountId(accountCode),
    debitPoisha: debit ? amount : ZERO,
    creditPoisha: debit ? ZERO : amount,
    branchId: input.branchId ?? null,
    partyType: party ? input.partyType : null,
    partyId: party ? input.partyId : null,
    memo: null,
  });
  const sourceId = randomUUID();
  await withOrg({ orgId: ORG_A, userId: accounts.userId }, (tx) =>
    ledger.post(
      tx,
      { orgId: ORG_A, userId: accounts.userId },
      {
        businessDate: addDays(toIsoDate(today()), -input.daysAgo),
        sourceType: 'aging_fixture',
        sourceId,
        event: 'post',
        idempotencyKey: `aging_fixture:${sourceId}:post`,
        memo: null,
        reversesJournalId: null,
        lines: [
          line(input.partyAccount, input.partySide === 'debit', true),
          line(input.otherAccount, input.partySide !== 'debit', false),
        ],
      },
    ),
  );
}

interface AgingItem {
  partyType: string;
  partyId: string;
  bucket0to7Poisha: string;
  bucket8to30Poisha: string;
  bucket31to60Poisha: string;
  bucketOver60Poisha: string;
  unappliedPoisha: string;
  totalPoisha: string;
}

async function agingAs(role: RoleClient, side: 'payable' | 'receivable') {
  const response = await role.client.request(
    'GET',
    `/v1/accounts/reports/aging?asOf=${today()}&side=${side}`,
  );
  expect(response.statusCode, response.body).toBe(200);
  return body<{ costWithheld: boolean; items: AgingItem[] }>(response);
}

describe('M08 gap-closure audit', () => {
  it('W2: one receipt backs one entry, and only its uploader may attach it', async () => {
    const receipt = await uploadReceipt(accounts.client);
    const first = {
      entryId: randomUUID(),
      walletId: wallets.handCash,
      kind: 'cash_out',
      categoryAccountId: accountId('5830'),
      amountPoisha: '2500',
      receiptFileId: receipt,
    };
    const posted = await accounts.client.request('POST', '/v1/accounts/cash-entries', {
      body: first,
    });
    expect(posted.statusCode, posted.body).toBe(201);

    // The same slip behind a second entry is refused...
    const reused = await accounts.client.request('POST', '/v1/accounts/cash-entries', {
      body: { ...first, entryId: randomUUID(), amountPoisha: '4900' },
    });
    expect(reused.statusCode, reused.body).toBe(409);
    expect(body<{ code: string }>(reused).code).toBe('RECEIPT_ALREADY_USED');

    // ...while a retry of the first entry finds itself and answers as before.
    const retried = await accounts.client.request('POST', '/v1/accounts/cash-entries', {
      body: first,
    });
    expect(retried.statusCode, retried.body).toBeLessThan(300);

    // A receipt somebody else photographed is not this entry's evidence.
    const theirs = await uploadReceipt(admin.client);
    const borrowed = await accounts.client.request('POST', '/v1/accounts/cash-entries', {
      body: { ...first, entryId: randomUUID(), receiptFileId: theirs },
    });
    expect(borrowed.statusCode, borrowed.body).toBe(400);
    expect(borrowed.body).toContain('uploaded yourself');
  });

  it('W3: a wallet still holding money cannot be closed', async () => {
    const wallet = body<{ items: { id: string; balancePoisha: string; isActive: boolean }[] }>(
      await accounts.client.request('GET', '/v1/accounts/wallets'),
    ).items.find((item) => item.id === wallets.bank);
    expect(BigInt(wallet?.balancePoisha ?? '0')).not.toBe(0n);

    const refused = await accounts.client.request('PATCH', `/v1/accounts/wallets/${wallets.bank}`, {
      body: { isActive: false },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(body<{ code: string }>(refused).code).toBe('WALLET_NOT_EMPTY');

    const after = body<{ items: { id: string; isActive: boolean }[] }>(
      await accounts.client.request('GET', '/v1/accounts/wallets'),
    ).items.find((item) => item.id === wallets.bank);
    expect(after?.isActive).toBe(true);
  });

  it('W4: receivables age by open item, a branch sees its own lines, and a cost-blind reader sees no supplier', async () => {
    const courier = randomUUID();
    // Delivered COD at the second showroom, partly settled; and an HQ amount the
    // branch manager must not see.
    await postPartyJournal({
      partyType: 'courier',
      partyId: courier,
      partyAccount: '1200',
      otherAccount: '2900',
      partySide: 'debit',
      amount: 100_000n,
      daysAgo: 40,
      branchId: otherBranch,
    });
    await postPartyJournal({
      partyType: 'courier',
      partyId: courier,
      partyAccount: '1200',
      otherAccount: '2900',
      partySide: 'credit',
      amount: 40_000n,
      daysAgo: 3,
      branchId: otherBranch,
    });
    await postPartyJournal({
      partyType: 'courier',
      partyId: courier,
      partyAccount: '1200',
      otherAccount: '2900',
      partySide: 'debit',
      amount: 7_000n,
      daysAgo: 1,
      branchId: hqBranch,
    });

    const orgWide = (await agingAs(accounts, 'receivable')).items.find(
      (item) => item.partyId === courier,
    );
    expect(orgWide).toMatchObject({
      bucket0to7Poisha: '7000',
      bucket31to60Poisha: '60000',
      unappliedPoisha: '0',
      totalPoisha: '67000',
    });

    const branchView = await agingAs(branchManager, 'receivable');
    expect(branchView.items.find((item) => item.partyId === courier)).toMatchObject({
      bucket0to7Poisha: '0',
      bucket31to60Poisha: '60000',
      totalPoisha: '60000',
    });

    // A supplier owed money at the manager's own branch is still not theirs to see.
    const supplier = randomUUID();
    await postPartyJournal({
      partyType: 'supplier',
      partyId: supplier,
      partyAccount: '2100',
      otherAccount: '5890',
      partySide: 'credit',
      amount: 9_000n,
      daysAgo: 2,
      branchId: otherBranch,
    });
    const payables = await agingAs(branchManager, 'payable');
    expect(payables.costWithheld).toBe(true);
    expect(payables.items.some((item) => item.partyType === 'supplier')).toBe(false);
    expect(
      (await agingAs(accounts, 'payable')).items.find((item) => item.partyId === supplier)
        ?.totalPoisha,
    ).toBe('9000');
  });

  it('W4: every party aging total is its ledger balance', async () => {
    for (const side of ['payable', 'receivable'] as const) {
      const { items } = await agingAs(accounts, side);
      const ledger = await withSystem(
        async (tx) =>
          tx.execute<{ party_id: string; balance: string }>(sql`
            select l.party_id,
                   sum(case when a.normal_balance = 'debit'
                            then l.debit_poisha - l.credit_poisha
                            else l.credit_poisha - l.debit_poisha end)::text as balance
            from ledger.journal_lines l
            join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
            join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
            where l.org_id = ${ORG_A} and l.party_type is not null
              and j.business_date <= ${today()}
              and a.class::text = ${side === 'payable' ? 'liability' : 'asset'}
            group by l.party_id
          `),
        { orgId: ORG_A },
      );
      const byParty = new Map(ledger.map((row) => [row.party_id, row.balance]));
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) expect(item.totalPoisha).toBe(byParty.get(item.partyId));
    }
  });

  it('N6: a branch manager asking for closed wallets still sees only their own branch', async () => {
    const created = await accounts.client.request('POST', '/v1/accounts/wallets', {
      body: {
        account: { code: '1140-SHUT', name: 'Shut org account', subtype: 'wallet_bank' },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const shut = body<{ id: string }>(created).id;
    const closed = await accounts.client.request('PATCH', `/v1/accounts/wallets/${shut}`, {
      body: { isActive: false },
    });
    expect(closed.statusCode, closed.body).toBe(200);

    const seen = body<{ items: { id: string; branchId: string | null }[] }>(
      await branchManager.client.request('GET', '/v1/accounts/wallets?includeInactive=true'),
    ).items;
    expect(seen.map((item) => item.id)).not.toContain(shut);
    expect(seen.every((item) => item.branchId === otherBranch)).toBe(true);
  });
});

/*
 * M30 security review, C1 (D-362). A branch manager holds `update Wallet` at their own
 * branch. A cash out used to skip both of petty cash's controls, so till cash could be
 * booked out to an operating expense with no receipt and no checker, and the daily
 * closing balanced because its expected balance moved by the same amount. A cash out
 * from someone whose reach is narrower than the brand is now held to petty cash's rules.
 */
describe('M30: a branch-scoped cash out follows petty cash’s rules', () => {
  let manager: RoleClient;
  let till = '';
  let tillAccount = '';
  let drawer = '';
  let heldEntryId = '';
  let heldApprovalId = '';

  beforeAll(async () => {
    const branch = await withSystem(
      async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`
          insert into org.branches (org_id, code, name, kind)
          values (${ORG_A}, 'SHR-3', 'Third Showroom', 'showroom')
          on conflict (org_id, code) do update set name = excluded.name
          returning id
        `);
        return rows[0]?.id ?? '';
      },
      { orgId: ORG_A },
    );
    manager = await harness.asRole('branch_manager', ORG_A, { branchIds: [branch] });

    const created = await accounts.client.request('POST', '/v1/accounts/wallets', {
      body: {
        account: { code: '1010-SHR-3', name: 'Hand cash, Third Showroom', subtype: 'wallet_cash' },
        branchId: branch,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    till = body<{ id: string }>(created).id;
    tillAccount = body<{ ledgerAccountId: string }>(created).ledgerAccountId;

    // A second wallet in the same branch, for the transfer-charge case.
    const second = await accounts.client.request('POST', '/v1/accounts/wallets', {
      body: {
        account: {
          code: '1012-SHR-3',
          name: 'Second drawer, Third Showroom',
          subtype: 'wallet_cash',
        },
        branchId: branch,
      },
    });
    expect(second.statusCode, second.body).toBe(201);
    drawer = body<{ id: string }>(second).id;

    const float = await accounts.client.request('POST', '/v1/accounts/cash-entries', {
      body: {
        entryId: randomUUID(),
        walletId: till,
        kind: 'cash_in',
        categoryAccountId: accountId('4300'),
        amountPoisha: '500000',
        memo: 'Opening float, Third Showroom',
      },
    });
    expect(float.statusCode, float.body).toBe(201);
  }, 120_000);

  function cashOut(client: Client, amountPoisha: string, receiptFileId?: string) {
    return client.request('POST', '/v1/accounts/cash-entries', {
      body: {
        entryId: randomUUID(),
        walletId: till,
        kind: 'cash_out',
        categoryAccountId: accountId('5890'),
        amountPoisha,
        memo: 'Packaging',
        ...(receiptFileId === undefined ? {} : { receiptFileId }),
      },
    });
  }

  it('refuses a branch manager’s cash out with no receipt', async () => {
    const response = await cashOut(manager.client, '5000');
    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).toContain('RECEIPT_REQUIRED');
  });

  it('holds one at or above the wallet-adjustment threshold for a second person', async () => {
    const response = await cashOut(manager.client, '150000', await uploadReceipt(manager.client));
    expect(response.statusCode, response.body).toBe(201);
    const held = body<{
      entryId: string;
      status: string;
      journalId: string | null;
      approvalId: string | null;
    }>(response);
    expect(held).toMatchObject({ status: 'pending_approval', journalId: null });
    expect(held.approvalId).not.toBeNull();
    heldEntryId = held.entryId;
    heldApprovalId = held.approvalId ?? '';
  });

  it('posts one below the threshold once it carries a receipt', async () => {
    const response = await cashOut(manager.client, '5000', await uploadReceipt(manager.client));
    expect(response.statusCode, response.body).toBe(201);
    expect(body<{ status: string }>(response).status).toBe('posted');
  });

  it('leaves the finance team’s org-wide cash out as ordinary bookkeeping', async () => {
    const response = await cashOut(accounts.client, '150000');
    expect(response.statusCode, response.body).toBe(201);
    expect(body<{ status: string }>(response).status).toBe('posted');
  });

  it('is decided by someone else, and posts exactly Dr expense / Cr the till once approved', async () => {
    // The requester is never the checker (0007's CHECK), and a manager of another branch
    // cannot reach this branch's request.
    const own = await manager.client.request('POST', `/v1/approvals/${heldApprovalId}/decide`, {
      body: { decision: 'approved' },
    });
    expect([403, 409], own.body).toContain(own.statusCode);
    const elsewhere = await branchManager.client.request(
      'POST',
      `/v1/approvals/${heldApprovalId}/decide`,
      { body: { decision: 'approved' } },
    );
    expect([403, 404], elsewhere.body).toContain(elsewhere.statusCode);

    const decided = await admin.client.request('POST', `/v1/approvals/${heldApprovalId}/decide`, {
      body: { decision: 'approved' },
    });
    expect(decided.statusCode, decided.body).toBe(201);

    const lines = await withSystem(
      async (tx) =>
        tx.execute<{ account_id: string; debit: string; credit: string; source_type: string }>(sql`
          select l.account_id, l.debit_poisha::text as debit, l.credit_poisha::text as credit,
                 j.source_type
          from ledger.journals j
          join ledger.journal_lines l on l.org_id = j.org_id and l.journal_id = j.id
          join wallets.cash_entries e on e.org_id = j.org_id and e.journal_id = j.id
          where e.org_id = ${ORG_A} and e.id = ${heldEntryId}
          order by l.debit_poisha desc
        `),
      { orgId: ORG_A },
    );
    expect(lines.map((line) => ({ ...line }))).toEqual([
      { account_id: accountId('5890'), debit: '150000', credit: '0', source_type: 'cash_out' },
      { account_id: tillAccount, debit: '0', credit: '150000', source_type: 'cash_out' },
    ]);

    // ৳5,000 float in; ৳50 posted at once; ৳1,500 by accounts; ৳1,500 approved.
    const visible = body<{ items: { id: string; balancePoisha: string }[] }>(
      await accounts.client.request('GET', '/v1/accounts/wallets'),
    );
    expect(visible.items.find((wallet) => wallet.id === till)?.balancePoisha).toBe('195000');
  });

  it('does not let the branch switch off its own daily count (the ledger audit, N8)', async () => {
    const response = await manager.client.request('PATCH', `/v1/accounts/wallets/${till}`, {
      body: { requiresDailyClosing: false },
    });
    expect(response.statusCode, response.body).toBe(403);
  });

  it('refuses a branch manager a transfer charge, the side door to the same expense', async () => {
    const response = await manager.client.request('POST', '/v1/accounts/transfers', {
      body: {
        transferId: randomUUID(),
        fromWalletId: till,
        toWalletId: drawer,
        amountPoisha: '1',
        chargePoisha: '50000',
        chargeAccountId: accountId('5710'),
      },
    });
    expect(response.statusCode, response.body).toBe(403);

    // A plain transfer between the branch's own wallets is still theirs to make.
    const plain = await manager.client.request('POST', '/v1/accounts/transfers', {
      body: {
        transferId: randomUUID(),
        fromWalletId: till,
        toWalletId: drawer,
        amountPoisha: '5000',
      },
    });
    expect(plain.statusCode, plain.body).toBe(201);

    const visible = body<{ items: { id: string; balancePoisha: string }[] }>(
      await accounts.client.request('GET', '/v1/accounts/wallets'),
    );
    expect(visible.items.find((wallet) => wallet.id === till)?.balancePoisha).toBe('190000');
    expect(visible.items.find((wallet) => wallet.id === drawer)?.balancePoisha).toBe('5000');
  });
});
