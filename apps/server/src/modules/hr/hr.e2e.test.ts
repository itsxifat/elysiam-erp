import { randomUUID } from 'node:crypto';

import { withOrg, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { GotenbergClient } from '../files/pdf/gotenberg.client.js';
import { HrModule } from './hr.module.js';
import { applyHrMigrations, seedHoliday, setThreshold } from './hr.testing.js';
import { ensureDefaultCalendar } from './hr.repository.js';

/**
 * Payroll over HTTP (M19 acceptance checks 1, 2 and 4).
 *
 * Check 1 is the one with teeth: *3 employees, 1 loan and some absences produce exact net
 * pay and journals*. It is asserted end to end — employees and salary structures created
 * through the real endpoints, attendance imported from a real CSV, the run submitted, the
 * approval decided by a second person, and then the numbers read back out of
 * `ledger.journal_lines` and compared to figures computed by hand in the comment below.
 * A payroll test that only checks its own arithmetic against itself proves nothing.
 *
 * Check 2 — *a payroll run cannot be posted twice* — is asserted through the HTTP path
 * here (a second approval of the same request is refused, and a second run for the same
 * month is refused) and through the triggers in `hr.db.test.ts`.
 *
 * Check 4 — *HR and accounts permissions follow the matrix* — is the last block: hr runs
 * payroll and cannot pay it, accounts pays it and cannot create an employee, a branch
 * manager sees only their branch's staff, and a sales agent sees their own record and
 * nobody's payslip.
 *
 * Everything runs through the real HTTP pipeline: the ability guard, the scope
 * interceptor, the serializer and the audit net, in the order `main.api.ts` mounts them.
 */

let harness: HttpHarness;

let hr: RoleClient;
let secondHr: RoleClient;
let accounts: RoleClient;
let admin: RoleClient;
let sales: RoleClient;
let branchManager: RoleClient;

let hqBranch = '';
let otherBranch = '';

/*
 * March 2026, Fridays off: 27 working days, 54 half-day units.
 *
 * Asha     ৳30,000 basic + ৳5,000 house rent, present every day, ৳2,000 Eid bonus.
 *          gross 3,500,000 + 200,000 = 3,700,000; nothing docked; net 3,700,000.
 * Bashir   ৳20,000 basic, three days absent (6 of 54 units).
 *          2,000,000 over 54 units is 54 × 37,037 + 2, so the two earliest units carry the
 *          spare poisha and the six forfeited ones are the cheap ones: 6 × 37,037 =
 *          222,222 docked. net 1,777,778.
 * Chameli  ৳25,000 basic, one half day (1 unit), a ৳6,000 loan in three instalments from
 *          March. 2,500,000 over 54 units is 54 × 46,296 + 16, and the one forfeited unit
 *          is a cheap one: 46,296 docked. available 2,453,704; the March instalment of
 *          200,000 comes out in full. net 2,253,704.
 *
 * Run totals: gross 8,200,000 (the bonus is in it), absence 268,518 + loan 200,000 =
 *           deductions 468,518, net 7,731,482.
 * Journal:  Dr salary expense 7,531,482 + Dr bonus expense 200,000
 *           Cr salary payable 7,731,482 + Cr employee loan receivable 200,000.
 */
const MONTH = '2026-03';
const ASHA_NET = 3_700_000n;
const BASHIR_NET = 1_777_778n;
const CHAMELI_NET = 2_253_704n;
const RUN_NET = ASHA_NET + BASHIR_NET + CHAMELI_NET;
const LOAN_INSTALMENT = 200_000n;
const BONUS = 200_000n;

interface Employee {
  readonly id: string;
  readonly code: string;
}

let asha: Employee;
let bashir: Employee;
let chameli: Employee;
let runId = '';
let approvalId = '';

beforeAll(async () => {
  harness = await startHttpHarness('hr-e2e', { extraModules: [HrModule] });
  await applyHrMigrations();

  ({ hqBranch, otherBranch } = await branches());

  hr = await harness.asRole('hr', ORG_A);
  secondHr = await harness.asRole('hr', ORG_A);
  accounts = await harness.asRole('accounts', ORG_A);
  admin = await harness.asRole('org_admin', ORG_A);
  sales = await harness.asRole('sales', ORG_A);
  branchManager = await harness.asRole('branch_manager', ORG_A, { branchIds: [otherBranch] });

  // Fridays off is the seeded default; one holiday is added and deliberately placed on a
  // Friday, so the count stays 27 — a holiday that lands on a weekly off is both, and
  // counting it twice is the mistake `workingDays` is written to avoid.
  const calendar = await withOrg({ orgId: ORG_A, userId: 'usr_hr_e2e' }, (tx) =>
    ensureDefaultCalendar(tx, ORG_A),
  );
  await seedHoliday(ORG_A, {
    calendarId: calendar.id,
    date: '2026-03-06',
    label: 'Friday holiday',
  });
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

// --- helpers ------------------------------------------------------------------

function body<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

async function branches(): Promise<{ hqBranch: string; otherBranch: string }> {
  return withSystem(
    async (tx) => {
      const hq = await tx.execute<{ id: string }>(sql`
        select id from org.branches where org_id = ${ORG_A} and code = 'HQ'
      `);
      const other = await tx.execute<{ id: string }>(sql`
        insert into org.branches (org_id, code, name, kind)
        values (${ORG_A}, 'SHR-HR', 'HR Showroom', 'showroom')
        on conflict (org_id, code) do update set name = excluded.name
        returning id
      `);
      return { hqBranch: hq[0]?.id ?? '', otherBranch: other[0]?.id ?? '' };
    },
    { orgId: ORG_A },
  );
}

/** The wallet account payroll is paid from: the org's bKash, from the seeded chart. */
async function bkashAccount(): Promise<string> {
  return withOrg({ orgId: ORG_A, userId: 'usr_hr_e2e' }, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      select id from ledger.accounts
      where org_id = ${ORG_A} and subtype = 'wallet_bkash' and is_active
      limit 1
    `);
    return rows[0]?.id ?? '';
  });
}

async function journalLines(
  journalId: string,
): Promise<{ subtype: string; debit: bigint; credit: bigint; party: string | null }[]> {
  return withOrg({ orgId: ORG_A, userId: 'usr_hr_e2e' }, async (tx) => {
    const rows = await tx.execute<{
      subtype: string;
      debit_poisha: string;
      credit_poisha: string;
      party_id: string | null;
    }>(sql`
      select a.subtype::text as subtype, l.debit_poisha::text as debit_poisha,
             l.credit_poisha::text as credit_poisha, l.party_id
      from ledger.journal_lines l
      join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
      where l.org_id = ${ORG_A} and l.journal_id = ${journalId}
      order by l.line_no
    `);
    return rows.map((row) => ({
      subtype: row.subtype,
      debit: BigInt(row.debit_poisha),
      credit: BigInt(row.credit_poisha),
      party: row.party_id,
    }));
  });
}

async function createEmployee(
  client: RoleClient,
  input: Record<string, unknown>,
): Promise<Employee> {
  const response = await client.client.request('POST', '/v1/hr/employees', { body: input });
  expect(response.statusCode, response.body).toBe(201);
  const created = body<{ id: string; code: string }>(response);
  return { id: created.id, code: created.code };
}

async function setSalary(
  employeeId: string,
  basicPoisha: string,
  components: unknown[] = [],
): Promise<void> {
  const response = await hr.client.request('POST', `/v1/hr/employees/${employeeId}/salary`, {
    body: { effectiveFrom: '2026-01-01', basicPoisha, components },
  });
  expect(response.statusCode, response.body).toBe(201);
}

// --- check 1: the scenario ----------------------------------------------------

describe('the payroll scenario (check 1)', () => {
  it('creates three employees with masked personal data and no plaintext in the response', async () => {
    asha = await createEmployee(hr, {
      code: 'EMP-001',
      fullName: 'Asha Rahman',
      designation: 'Merchandiser',
      joinDate: '2025-06-01',
      branchId: hqBranch,
      payoutMethod: 'bkash',
      payoutRef: '01712345678',
      nationalId: '1990123456789',
      phone: '01712345678',
    });
    bashir = await createEmployee(hr, {
      code: 'EMP-002',
      fullName: 'Bashir Uddin',
      joinDate: '2025-06-01',
      branchId: hqBranch,
      payoutMethod: 'cash',
    });
    chameli = await createEmployee(hr, {
      code: 'EMP-003',
      fullName: 'Chameli Akter',
      joinDate: '2025-06-01',
      branchId: otherBranch,
      payoutMethod: 'cash',
    });

    const response = await hr.client.request('GET', `/v1/hr/employees/${asha.id}`);
    expect(response.statusCode).toBe(200);
    const view = body<Record<string, unknown>>(response);

    // Masks, and nothing else. Invariant 10: a national ID and a bKash number never leave
    // the server, so there is no field on this response that could carry one.
    expect(view.payoutRefMasked).toBe('*******5678');
    expect(view.phoneMasked).toBe('017******78');
    expect(JSON.stringify(view)).not.toContain('1990123456789');
    expect(JSON.stringify(view)).not.toContain('01712345678');
  });

  it('records the salary structures', async () => {
    await setSalary(asha.id, '3000000', [
      { direction: 'earning', code: 'house_rent', label: 'House rent', amountPoisha: '500000' },
    ]);
    await setSalary(bashir.id, '2000000');
    await setSalary(chameli.id, '2500000');
  });

  it('imports March attendance from a device CSV, previewing first', async () => {
    /*
     * Bashir is absent on the 3rd, 4th and 5th; Chameli takes a half day on the 10th.
     * Everybody else's days are unrecorded, which under the default policy counts as
     * present (D-186) — which is the realistic case: a device file carries the exceptions
     * an office cares about, not 27 rows per person.
     */
    const csv = [
      'Emp ID,Date,Status',
      'EMP-002,03/03/2026,A',
      'EMP-002,04/03/2026,A',
      'EMP-002,05/03/2026,A',
      'EMP-003,10/03/2026,HD',
      'EMP-999,10/03/2026,P',
    ].join('\n');
    const mapping = { employeeCode: 'Emp ID', date: 'Date', status: 'Status' };

    const preview = await hr.client.request('POST', '/v1/hr/attendance/imports', {
      body: { month: MONTH, csv, mapping, fileName: 'march.csv' },
    });
    expect(preview.statusCode, preview.body).toBe(201);
    const previewed = body<{
      status: string;
      acceptedCount: number;
      rejectedCount: number;
      unknownCodes: string[];
      rejected: { line: number; reason: string }[];
    }>(preview);

    // A preview by default, and the unknown employee code is a *rejection with a line
    // number* rather than a silent skip: the person fixing it needs to know which row.
    expect(previewed.status).toBe('parsed');
    expect(previewed.acceptedCount).toBe(4);
    expect(previewed.rejectedCount).toBe(1);
    expect(previewed.unknownCodes).toEqual(['EMP-999']);
    expect(previewed.rejected[0]?.line).toBe(6);

    // Nothing was written.
    const beforeApply = await hr.client.request('GET', `/v1/hr/attendance?month=${MONTH}`);
    expect(body<{ items: unknown[] }>(beforeApply).items).toHaveLength(0);

    const applied = await hr.client.request('POST', '/v1/hr/attendance/imports', {
      body: { month: MONTH, csv, mapping, fileName: 'march.csv', apply: true },
    });
    expect(applied.statusCode, applied.body).toBe(201);
    expect(body<{ status: string }>(applied).status).toBe('applied');

    const after = await hr.client.request('GET', `/v1/hr/attendance?month=${MONTH}`);
    const days = body<{ items: { status: string; source: string }[] }>(after).items;
    expect(days).toHaveLength(4);
    expect(days.every((day) => day.source === 'csv_import')).toBe(true);
  });

  it('gives Chameli a loan, and deducts nothing until it is disbursed', async () => {
    const created = await hr.client.request('POST', '/v1/hr/loans', {
      body: {
        employeeId: chameli.id,
        principalPoisha: '600000',
        instalmentCount: 3,
        firstMonth: MONTH,
        note: 'Six-month staff loan',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const loan = body<{
      id: string;
      status: string;
      instalments: { dueMonth: string; amountPoisha: string }[];
    }>(created);

    expect(loan.status).toBe('pending_disbursement');
    // Largest remainder: the three instalments are the principal, exactly.
    expect(loan.instalments.map((one) => one.amountPoisha)).toEqual(['200000', '200000', '200000']);
    expect(loan.instalments.map((one) => one.dueMonth)).toEqual(['2026-03', '2026-04', '2026-05']);

    /*
     * `update Payroll`, which §6's matrix gives hr as well as accounts.
     *
     * The matrix has one `Payroll` subject and gives hr read/create/update at org scope,
     * so there is no ability that separates "prepares the payroll" from "moves the cash"
     * — see the follow-up in M19's report. What the design actually separates is maker
     * from checker on the run itself, which the approval below enforces. A sales agent,
     * a branch manager and a warehouse packer all hold nothing here.
     */
    const bySales = await sales.client.request('POST', `/v1/hr/loans/${loan.id}/disburse`, {
      body: { walletAccountId: await bkashAccount() },
    });
    expect(bySales.statusCode).toBe(403);

    // No `disbursedOn`: the cash leaves today. §7 bounds a chosen date to today or
    // yesterday, so a fixture that names a month in the past is refused — correctly, and the
    // test for that refusal is at the bottom of this file.
    const disbursed = await accounts.client.request('POST', `/v1/hr/loans/${loan.id}/disburse`, {
      body: { walletAccountId: await bkashAccount() },
    });
    expect(disbursed.statusCode, disbursed.body).toBe(201);
    const active = body<{ status: string; journalId: string }>(disbursed);
    expect(active.status).toBe('active');

    // §7: Dr Employee loan receivable (party: the employee) / Cr W.
    const lines = await journalLines(active.journalId);
    expect(lines).toHaveLength(2);
    const receivable = lines.find((line) => line.subtype === 'employee_loan_receivable');
    expect(receivable?.debit).toBe(600_000n);
    expect(receivable?.party).toBe(chameli.id);
    expect(lines.find((line) => line.subtype === 'wallet_bkash')?.credit).toBe(600_000n);
  });

  it('previews the run with the exact net pay per employee', async () => {
    const created = await hr.client.request('POST', '/v1/hr/payroll/runs', {
      body: { month: MONTH, memo: 'March 2026' },
    });
    expect(created.statusCode, created.body).toBe(201);
    runId = body<{ id: string }>(created).id;

    const bonus = await hr.client.request('POST', `/v1/hr/payroll/runs/${runId}/inputs`, {
      body: {
        employeeId: asha.id,
        kind: 'bonus',
        label: 'Eid bonus',
        amountPoisha: BONUS.toString(),
      },
    });
    expect(bonus.statusCode, bonus.body).toBe(201);

    const preview = await hr.client.request('GET', `/v1/hr/payroll/runs/${runId}/preview`);
    expect(preview.statusCode, preview.body).toBe(200);
    const previewed = body<{
      totals: Record<string, string | number>;
      payslips: { employeeCode: string; netPoisha: string; workingDays: number }[];
      warnings: string[];
    }>(preview);

    const net = new Map(previewed.payslips.map((one) => [one.employeeCode, one.netPoisha]));
    expect(previewed.payslips[0]?.workingDays).toBe(27);
    expect(net.get('EMP-001')).toBe(ASHA_NET.toString());
    expect(net.get('EMP-002')).toBe(BASHIR_NET.toString());
    expect(net.get('EMP-003')).toBe(CHAMELI_NET.toString());
    expect(previewed.totals.netPoisha).toBe(RUN_NET.toString());
    expect(previewed.totals.grossPoisha).toBe('8200000');
    expect(previewed.totals.loanDeductionPoisha).toBe(LOAN_INSTALMENT.toString());
    // The checker is told which employees have working days nobody recorded (D-186).
    expect(previewed.warnings.join(' ')).toMatch(/no attendance recorded/);
  });

  it('freezes the payslips, raises a server-derived approval, and posts nothing yet', async () => {
    const submitted = await hr.client.request('POST', `/v1/hr/payroll/runs/${runId}/submit`, {
      body: { reason: 'March 2026 payroll' },
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const run = body<{
      status: string;
      approvalId: string;
      netPoisha: string;
      journalId: string | null;
    }>(submitted);

    approvalId = run.approvalId;
    expect(run.status).toBe('pending_approval');
    expect(run.netPoisha).toBe(RUN_NET.toString());
    // The whole point of maker-checker: a pending run has posted nothing.
    expect(run.journalId).toBeNull();

    const request = await hr.client.request('GET', `/v1/approvals/${approvalId}`);
    const approval = body<{ type: string; status: string; amountPoisha: string }>(request);
    expect(approval.type).toBe('payroll_run');
    expect(approval.status).toBe('pending');
    // The amount the checker sees is the one the server computed (D-072).
    expect(approval.amountPoisha).toBe(RUN_NET.toString());

    // Nothing in the loan has moved either.
    const loans = await hr.client.request('GET', `/v1/hr/loans?employeeId=${chameli.id}`);
    const outstanding = body<{ items: { outstandingPoisha: string }[] }>(loans).items[0];
    expect(outstanding?.outstandingPoisha).toBe('600000');
  });

  it('refuses a second run while one is waiting for a checker', async () => {
    const created = await hr.client.request('POST', '/v1/hr/payroll/runs', {
      body: { month: '2026-04' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const secondRun = body<{ id: string }>(created).id;

    const submitted = await hr.client.request('POST', `/v1/hr/payroll/runs/${secondRun}/submit`);
    expect(submitted.statusCode).toBe(409);
    expect(submitted.body).toMatch(/still waiting for approval/);
  });

  it('refuses the maker as their own checker', async () => {
    const decided = await hr.client.request('POST', `/v1/approvals/${approvalId}/decide`, {
      body: { decision: 'approved' },
    });
    expect(decided.statusCode).toBe(403);
  });

  it('posts §7’s payroll journal on approval, to the poisha', async () => {
    const decided = await secondHr.client.request('POST', `/v1/approvals/${approvalId}/decide`, {
      body: { decision: 'approved', note: 'Checked against the attendance register' },
    });
    expect(decided.statusCode, decided.body).toBe(201);

    const run = body<{ status: string; journalId: string; netPoisha: string }>(
      await hr.client.request('GET', `/v1/hr/payroll/runs/${runId}`),
    );
    expect(run.status).toBe('posted');
    expect(run.netPoisha).toBe(RUN_NET.toString());

    const lines = await journalLines(run.journalId);
    const sumOf = (subtype: string, side: 'debit' | 'credit') =>
      lines
        .filter((line) => line.subtype === subtype)
        .reduce((total, line) => total + line[side], 0n);

    // Dr Salary expense + Dr Bonus expense / Cr Salary payable + Cr Employee loan
    // receivable — and the expense is split by branch, so Chameli's showroom carries hers.
    expect(sumOf('salary_expense', 'debit')).toBe(RUN_NET + LOAN_INSTALMENT - BONUS);
    expect(sumOf('bonus_expense', 'debit')).toBe(BONUS);
    expect(sumOf('salary_payable', 'credit')).toBe(RUN_NET);
    expect(sumOf('employee_loan_receivable', 'credit')).toBe(LOAN_INSTALMENT);
    expect(lines.filter((line) => line.subtype === 'salary_expense')).toHaveLength(2);
    expect(lines.find((line) => line.subtype === 'employee_loan_receivable')?.party).toBe(
      chameli.id,
    );

    // Balanced, which the database also checked at commit.
    const debits = lines.reduce((total, line) => total + line.debit, 0n);
    const credits = lines.reduce((total, line) => total + line.credit, 0n);
    expect(debits).toBe(credits);

    // The loan instalment is marked deducted only now, when the run actually posted.
    const loan = body<{ items: { outstandingPoisha: string }[] }>(
      await hr.client.request('GET', `/v1/hr/loans?employeeId=${chameli.id}`),
    ).items[0];
    expect(loan?.outstandingPoisha).toBe('400000');
  });

  it('cannot be posted twice (check 2)', async () => {
    // The approval is spent: deciding it again is refused, so the executor cannot run
    // twice.
    const again = await admin.client.request('POST', `/v1/approvals/${approvalId}/decide`, {
      body: { decision: 'approved' },
    });
    expect(again.statusCode).toBe(409);

    // And there is no second run for the month to post.
    const duplicate = await hr.client.request('POST', '/v1/hr/payroll/runs', {
      body: { month: MONTH },
    });
    // 409, not 400: the request was well-formed and the state of the world disagreed.
    expect(duplicate.statusCode).toBe(409);
  });

  it('pays the run once, out of a wallet, for exactly the approved amount', async () => {
    const wallet = await bkashAccount();

    // Paying needs `update Payroll`, which the matrix gives accounts, hr and org_admin and
    // nobody else. A branch manager holds no Payroll grant at all.
    const byManager = await branchManager.client.request(
      'POST',
      `/v1/hr/payroll/runs/${runId}/pay`,
      { body: { walletAccountId: wallet } },
    );
    expect(byManager.statusCode).toBe(403);

    /*
     * The two refusals before the one that works, because paying closes the run.
     *
     * Both exist to keep two different answers apart, which is the whole reason the
     * ledger hands this module a wallet carrying `isActive` instead of filtering the
     * closed ones out (D-199): "no such wallet in this brand" is a wrong request, and
     * "that wallet is deactivated" is a right request about an account the wallet picker
     * still lists on purpose. Without these, a narrowed select that dropped `is_active`
     * would make every payment refuse, or pay salary out of a closed bank account, and
     * nothing in CI would notice.
     */
    const unknown = await accounts.client.request('POST', `/v1/hr/payroll/runs/${runId}/pay`, {
      body: { walletAccountId: randomUUID() },
    });
    expect(unknown.statusCode, unknown.body).toBe(404);
    expect(body<{ code: string }>(unknown).code).toBe('HR_NOT_FOUND');

    const closed = await withSystem(
      async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`
          insert into ledger.accounts (org_id, code, name, class, subtype, normal_balance, is_active)
          values (${ORG_A}, '1115-SHUT', 'Closed bKash', 'asset',
                  'wallet_bkash'::ledger.account_subtype, 'debit', false)
          on conflict (org_id, code) do update set is_active = false
          returning id
        `);
        return rows[0]?.id ?? '';
      },
      { orgId: ORG_A },
    );
    const deactivated = await accounts.client.request('POST', `/v1/hr/payroll/runs/${runId}/pay`, {
      body: { walletAccountId: closed },
    });
    expect(deactivated.statusCode, deactivated.body).toBe(409);
    expect(body<{ code: string }>(deactivated).code).toBe('WALLET_INACTIVE');

    const paid = await accounts.client.request('POST', `/v1/hr/payroll/runs/${runId}/pay`, {
      body: { walletAccountId: wallet, memo: 'March salaries' },
    });
    expect(paid.statusCode, paid.body).toBe(201);
    const run = body<{ status: string; paymentJournalId: string }>(paid);
    expect(run.status).toBe('paid');

    const lines = await journalLines(run.paymentJournalId);
    expect(lines.find((line) => line.subtype === 'salary_payable')?.debit).toBe(RUN_NET);
    expect(lines.find((line) => line.subtype === 'wallet_bkash')?.credit).toBe(RUN_NET);

    const twice = await accounts.client.request('POST', `/v1/hr/payroll/runs/${runId}/pay`, {
      body: { walletAccountId: wallet },
    });
    expect(twice.statusCode).toBe(409);
  });

  it('issues a payslip whose rows add up to the net that was posted', async () => {
    const response = await hr.client.request('GET', `/v1/hr/payroll/runs/${runId}/payslips`);
    expect(response.statusCode).toBe(200);
    const payslips = body<{
      items: {
        employeeCode: string;
        grossPoisha: string;
        deductionsPoisha: string;
        netPoisha: string;
        components: { direction: string; code: string; amountPoisha: string }[];
      }[];
    }>(response).items;

    expect(payslips).toHaveLength(3);
    for (const payslip of payslips) {
      const earnings = payslip.components
        .filter((one) => one.direction === 'earning')
        .reduce((total, one) => total + BigInt(one.amountPoisha), 0n);
      const deductions = payslip.components
        .filter((one) => one.direction === 'deduction')
        .reduce((total, one) => total + BigInt(one.amountPoisha), 0n);
      expect(earnings, payslip.employeeCode).toBe(BigInt(payslip.grossPoisha));
      expect(deductions, payslip.employeeCode).toBe(BigInt(payslip.deductionsPoisha));
      expect(earnings - deductions).toBe(BigInt(payslip.netPoisha));
    }

    const chameliSlip = payslips.find((one) => one.employeeCode === 'EMP-003');
    expect(chameliSlip?.components.map((one) => one.code).sort()).toEqual([
      'absence',
      'basic',
      'loan_instalment',
    ]);
  });

  it('renders the Bangla payslip PDF for the employee it is about', async () => {
    const client = new GotenbergClient(process.env.GOTENBERG_URL ?? 'http://localhost:3030');
    /*
     * Skipped rather than failed when Gotenberg is not up, and the skip is loud — the same
     * choice `invoice-pdf.test.ts` makes, and for the same reason: a red suite on a machine
     * without the compose stack running trains people to ignore the file.
     */
    if (!(await client.isReady())) {
      console.warn(
        'Gotenberg is not reachable. Start it with ' +
          '`docker compose -f infra/docker-compose.dev.yml up -d gotenberg` ' +
          'to exercise the Bangla payslip.',
      );
      expect(true).toBe(true);
      return;
    }

    const response = await hr.client.request(
      'GET',
      `/v1/hr/payroll/runs/${runId}/payslips/${asha.id}/pdf`,
    );
    expect(response.statusCode, response.body.slice(0, 200)).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(String(response.headers['content-disposition'])).toContain('payslip-EMP-001-2026-03');
    // Never cached by a proxy: it is one person's salary.
    expect(String(response.headers['cache-control'])).toContain('no-store');
    expect(response.body.slice(0, 5)).toBe('%PDF-');
  });
});

// --- check 4: the permission matrix -------------------------------------------

describe('HR and accounts permissions follow the matrix (check 4)', () => {
  it('lets hr run payroll and refuses everyone the matrix does not name', async () => {
    for (const [name, client, expected] of [
      ['hr', hr, 200],
      ['accounts', accounts, 200],
      ['org_admin', admin, 200],
      ['sales', sales, 403],
      ['branch_manager', branchManager, 403],
    ] as const) {
      const response = await client.client.request('GET', '/v1/hr/payroll/runs');
      expect(response.statusCode, `${name} reading payroll runs`).toBe(expected);
    }
  });

  it('refuses accounts the power to create an employee or set a salary', async () => {
    const created = await accounts.client.request('POST', '/v1/hr/employees', {
      body: { code: 'EMP-ACC', fullName: 'Nope', joinDate: '2026-01-01' },
    });
    expect(created.statusCode).toBe(403);

    const salary = await accounts.client.request('POST', `/v1/hr/employees/${asha.id}/salary`, {
      body: { effectiveFrom: '2026-07-01', basicPoisha: '9900000' },
    });
    expect(salary.statusCode).toBe(403);
  });

  it('gives a branch manager only their own branch’s staff', async () => {
    const response = await branchManager.client.request('GET', '/v1/hr/employees');
    expect(response.statusCode).toBe(200);
    const codes = body<{ items: { code: string }[] }>(response).items.map((one) => one.code);
    // Chameli is at the showroom this manager runs; Asha and Bashir are at HQ.
    expect(codes).toContain('EMP-003');
    expect(codes).not.toContain('EMP-001');

    // And a row outside their branch is a 404, not a 403: a row you may not see should be
    // indistinguishable from one that does not exist.
    const other = await branchManager.client.request('GET', `/v1/hr/employees/${asha.id}`);
    expect(other.statusCode).toBe(404);
  });

  it('keeps the check-in and check-out times a day is recorded with', async () => {
    /*
     * Every entry with a time answered 500: the instants were bound into raw SQL as `Date`
     * objects, which Drizzle's postgres-js driver refuses, and read back with
     * `.toISOString()` on what the driver returns as text. No test sent a time; the preview
     * seed did (2026-10-02).
     */
    const recorded = await hr.client.request('PUT', '/v1/hr/attendance', {
      body: {
        entries: [
          {
            employeeId: chameli.id,
            businessDate: '2026-07-06',
            // Present, so the time changes nothing a later payroll test computes for July.
            status: 'present',
            checkIn: '10:40',
            checkOut: '19:05',
          },
        ],
      },
    });
    expect(recorded.statusCode, recorded.body).toBe(200);

    const month = await hr.client.request(
      'GET',
      `/v1/hr/attendance?month=2026-07&employeeId=${chameli.id}`,
    );
    expect(month.statusCode, month.body).toBe(200);
    const day = body<{
      items: { businessDate: string; status: string; checkInAt: string; checkOutAt: string }[];
    }>(month).items.find((row) => row.businessDate === '2026-07-06');
    // Asia/Dhaka is UTC+6 all year, so 10:40 there is 04:40 UTC.
    expect(day).toMatchObject({
      status: 'present',
      checkInAt: '2026-07-06T04:40:00.000Z',
      checkOutAt: '2026-07-06T13:05:00.000Z',
    });
  });

  it('keeps the times an attendance file brings in', async () => {
    // The import path used the same binding as the manual one (D-389).
    const csv = ['code,day,in,out', 'EMP-003,08/07/2026,09:15,18:20'].join('\n');
    const imported = await hr.client.request('POST', '/v1/hr/attendance/imports', {
      body: {
        month: '2026-07',
        csv,
        mapping: { employeeCode: 'code', date: 'day', checkIn: 'in', checkOut: 'out' },
        apply: true,
      },
    });
    expect(imported.statusCode, imported.body).toBe(201);
    expect(body<{ acceptedCount: number }>(imported).acceptedCount).toBe(1);

    const month = await hr.client.request(
      'GET',
      `/v1/hr/attendance?month=2026-07&employeeId=${chameli.id}`,
    );
    expect(month.statusCode, month.body).toBe(200);
    const day = body<{
      items: { businessDate: string; source: string; checkInAt: string; checkOutAt: string }[];
    }>(month).items.find((row) => row.businessDate === '2026-07-08');
    expect(day).toMatchObject({
      source: 'csv_import',
      checkInAt: '2026-07-08T03:15:00.000Z',
      checkOutAt: '2026-07-08T12:20:00.000Z',
    });
  });

  it('confines a branch manager’s attendance writes to their own branch', async () => {
    /*
     * `update Employee` at branch scope (§6), which is what lets a showroom manager mark
     * their own floor's attendance without emailing head office. The two halves below are the
     * two ways that grant leaks if the handler forgets to apply the scope: a named employee in
     * another branch, and a CSV that quietly covers the whole brand.
     */
    const ownBranch = await branchManager.client.request('PUT', '/v1/hr/attendance', {
      body: {
        entries: [{ employeeId: chameli.id, businessDate: '2026-07-01', status: 'present' }],
      },
    });
    expect(ownBranch.statusCode, ownBranch.body).toBe(200);

    // Asha is at HQ. 404, not 403: a row outside the scope is indistinguishable from one that
    // does not exist.
    const otherBranchEmployee = await branchManager.client.request('PUT', '/v1/hr/attendance', {
      body: {
        entries: [{ employeeId: asha.id, businessDate: '2026-07-01', status: 'absent' }],
      },
    });
    expect(otherBranchEmployee.statusCode).toBe(404);

    // And a file naming HQ's codes imports nothing: the lookup is scoped in SQL, so EMP-001
    // comes back as a code this caller has no employee for.
    const imported = await branchManager.client.request('POST', '/v1/hr/attendance/imports', {
      body: {
        month: '2026-07',
        csv: ['code,day', 'EMP-001,02/07/2026', 'EMP-003,02/07/2026'].join('\n'),
        mapping: { employeeCode: 'code', date: 'day' },
        apply: true,
      },
    });
    expect(imported.statusCode, imported.body).toBe(201);
    const outcome = body<{ acceptedCount: number; unknownCodes: string[] }>(imported);
    expect(outcome.acceptedCount).toBe(1);
    expect(outcome.unknownCodes).toEqual(['EMP-001']);
  });

  it('gives a sales agent their own record and nobody’s payslip', async () => {
    // `read Employee` at `own` scope: a sales agent with no employee row sees an empty list
    // rather than the whole brand's staff.
    const list = await sales.client.request('GET', '/v1/hr/employees');
    expect(list.statusCode).toBe(200);
    expect(body<{ items: unknown[] }>(list).items).toHaveLength(0);

    // The payslip route is guarded by `read Employee`, so the guard admits them — and the
    // row-level check refuses, as a 404.
    const payslip = await sales.client.request(
      'GET',
      `/v1/hr/payroll/runs/${runId}/payslips/${asha.id}/pdf`,
    );
    expect(payslip.statusCode).toBe(404);

    // The payslip list needs `read Payroll`, which a sales agent does not hold at all.
    const list2 = await sales.client.request('GET', `/v1/hr/payroll/runs/${runId}/payslips`);
    expect(list2.statusCode).toBe(403);
  });

  it('lets an employee read their own payslip and nobody else’s', async () => {
    const staff = await harness.asRole('warehouse', ORG_A);

    /*
     * The login is linked to an employee who *already has a payslip in the posted run*, which
     * is the case that matters: the route declares `read Employee`, which for a warehouse
     * packer is `own` scope — a filter rather than a blanket grant — and `ScopeInterceptor`
     * refuses to send a response for a scoped caller whose handler applied nothing. It does
     * that after the handler succeeded, so an employee with *no* payslip gets a correct 404
     * either way and the bug is invisible. This test is the one that sees it.
     */
    const linked = await hr.client.request('PATCH', `/v1/hr/employees/${chameli.id}`, {
      body: { userId: staff.userId },
    });
    expect(linked.statusCode, linked.body).toBe(200);

    const mine = await staff.client.request(
      'GET',
      `/v1/hr/payroll/runs/${runId}/payslips/${chameli.id}/pdf`,
    );
    /*
     * A real 200 with real bytes, when Gotenberg is up.
     *
     * Skipped loudly otherwise, like the render test above — but the *scope* half of this is
     * asserted either way by the two refusals below, and a scope failure would be a 500 whose
     * body is an internal error rather than a PDF.
     */
    const renderer = new GotenbergClient(process.env.GOTENBERG_URL ?? 'http://localhost:3030');
    if (await renderer.isReady()) {
      expect(mine.statusCode, mine.body.slice(0, 300)).toBe(200);
      expect(mine.body.slice(0, 5)).toBe('%PDF-');
    } else {
      console.warn('Gotenberg is not reachable; the own-payslip render was not exercised.');
      expect(mine.statusCode).not.toBe(403);
    }

    // Somebody else's payslip is a 404, not a 403: a payslip you may not read should be
    // indistinguishable from one that does not exist.
    const theirs = await staff.client.request(
      'GET',
      `/v1/hr/payroll/runs/${runId}/payslips/${asha.id}/pdf`,
    );
    expect(theirs.statusCode).toBe(404);

    // And they can see their own employee record, but not Asha's.
    const own = await staff.client.request('GET', `/v1/hr/employees/${chameli.id}`);
    expect(own.statusCode).toBe(200);
    const others = await staff.client.request('GET', `/v1/hr/employees/${asha.id}`);
    expect(others.statusCode).toBe(404);
  });

  it('keeps a bank account number behind update Payroll, and audits every look', async () => {
    // `update Payroll`, which the matrix gives accounts, hr and org_admin. A branch
    // manager holds `update Employee` for their branch and no Payroll grant, so the
    // staff records they can edit are records whose bank details they cannot read.
    const byManager = await branchManager.client.request(
      'GET',
      `/v1/hr/employees/${chameli.id}/payout-ref`,
    );
    expect(byManager.statusCode).toBe(403);

    const byAccounts = await accounts.client.request(
      'GET',
      `/v1/hr/employees/${asha.id}/payout-ref`,
    );
    expect(byAccounts.statusCode, byAccounts.body).toBe(200);
    expect(body<{ payoutRef: string }>(byAccounts).payoutRef).toBe('01712345678');

    const audited = await withOrg({ orgId: ORG_A, userId: 'usr_hr_e2e' }, async (tx) => {
      const rows = await tx.execute<{ n: string }>(sql`
        select count(*)::text as n from audit.audit_log
        where org_id = ${ORG_A} and action = 'hr.employee.payout_ref.revealed'
          and entity_id = ${asha.id}
      `);
      return rows[0]?.n;
    });
    expect(audited).toBe('1');
  });

  it('posts a run that falls under the org’s threshold instead of stranding the month', async () => {
    /*
     * `payroll_run` is not in `NEVER_AUTO_APPROVE_TYPES` and `thresholdSchema` accepts a
     * threshold for it, and this module raises the request with `amountDerivedByServer` —
     * which is exactly what lets that threshold decide (D-068, D-072). So below-threshold is
     * reachable by design, and the approvals module decides the request *before* the run can
     * point at it: the executor runs, finds no run, and correctly shrugs.
     *
     * Without `submit` handling that, the run would sit in `pending_approval` naming a spent
     * request — unpostable, uncancellable to anything but `rejected`, and with the month's
     * unique index blocking a replacement. One threshold setting would make a month's payroll
     * impossible through the system, which is how staff get paid outside the ledger.
     */
    await setThreshold(ORG_A, 'payroll_run', '100000000');

    const created = await hr.client.request('POST', '/v1/hr/payroll/runs', {
      body: { month: '2026-05' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = body<{ id: string }>(created).id;

    const submitted = await hr.client.request('POST', `/v1/hr/payroll/runs/${id}/submit`);
    expect(submitted.statusCode, submitted.body).toBe(201);
    const run = body<{ status: string; journalId: string | null; netPoisha: string }>(submitted);

    // Posted in the same request, from the frozen payslips, with a real journal behind it.
    expect(run.status).toBe('posted');
    expect(run.journalId).not.toBeNull();

    const lines = await journalLines(run.journalId ?? '');
    const debits = lines.reduce((total, line) => total + line.debit, 0n);
    const credits = lines.reduce((total, line) => total + line.credit, 0n);
    expect(debits).toBe(credits);
    expect(
      lines
        .filter((line) => line.subtype === 'salary_payable')
        .reduce((total, line) => total + line.credit, 0n),
    ).toBe(BigInt(run.netPoisha));

    // Cleared, so the threshold does not leak into whatever runs next.
    await setThreshold(ORG_A, 'payroll_run', '0');
  });

  it('lets a rejected month be run again (the month is not consumed)', async () => {
    /*
     * The ordinary maker-checker loop: the checker refuses because the attendance was wrong,
     * HR fixes it and submits again. An unconditional `unique (org_id, month)` would make that
     * impossible — the rejected row would consume June forever — so the index is partial.
     */
    const first = body<{ id: string }>(
      await hr.client.request('POST', '/v1/hr/payroll/runs', { body: { month: '2026-06' } }),
    ).id;
    const submitted = await hr.client.request('POST', `/v1/hr/payroll/runs/${first}/submit`);
    expect(submitted.statusCode, submitted.body).toBe(201);
    const approvalToReject = body<{ approvalId: string }>(submitted).approvalId;

    const rejected = await secondHr.client.request(
      'POST',
      `/v1/approvals/${approvalToReject}/decide`,
      { body: { decision: 'rejected', note: 'March attendance looks wrong' } },
    );
    expect(rejected.statusCode, rejected.body).toBe(201);

    // The run is still waiting until somebody closes it: the approvals module runs an executor
    // on approval and nothing on rejection (a follow-up).
    const closed = await hr.client.request('POST', `/v1/hr/payroll/runs/${first}/cancel`);
    expect(closed.statusCode, closed.body).toBe(201);
    expect(body<{ status: string }>(closed).status).toBe('rejected');

    // And June can be run again.
    const second = body<{ id: string }>(
      await hr.client.request('POST', '/v1/hr/payroll/runs', { body: { month: '2026-06' } }),
    ).id;
    const again = await hr.client.request('POST', `/v1/hr/payroll/runs/${second}/submit`);
    expect(again.statusCode, again.body).toBe(201);
    expect(body<{ status: string }>(again).status).toBe('pending_approval');

    /*
     * Closed again, so this test leaves no run waiting.
     *
     * Only one run may be pending at a time — two could freeze payslips naming the same loan
     * instalment — so a test that walked away from a pending run would break whichever test
     * happened to submit next, for a reason in a different file.
     */
    const secondApproval = body<{ approvalId: string }>(again).approvalId;
    await secondHr.client.request('POST', `/v1/approvals/${secondApproval}/decide`, {
      body: { decision: 'rejected' },
    });
    const closedAgain = await hr.client.request('POST', `/v1/hr/payroll/runs/${second}/cancel`);
    expect(closedAgain.statusCode, closedAgain.body).toBe(201);
  });

  it('refuses a payment or a disbursement dated outside the posting window', async () => {
    /*
     * §7: today or yesterday, anything earlier needs a `back_dated_entry` approval — and the
     * forward half matters as much, because the period lock only refuses dates in or before a
     * *closed* month. A payment dated 2030 would sit in every cash book until the calendar
     * reached it.
     */
    const wallet = await bkashAccount();

    /*
     * Its own run, posted under a threshold rather than reusing the scenario's — that one has
     * already been paid, and a second payment is refused for a different reason. A test that
     * depends on the state its neighbours left behind fails for a reason nobody can find.
     */
    await setThreshold(ORG_A, 'payroll_run', '100000000');
    const ownRun = body<{ id: string }>(
      await hr.client.request('POST', '/v1/hr/payroll/runs', { body: { month: '2026-08' } }),
    ).id;
    const posted = await hr.client.request('POST', `/v1/hr/payroll/runs/${ownRun}/submit`);
    expect(posted.statusCode, posted.body).toBe(201);
    expect(body<{ status: string }>(posted).status).toBe('posted');
    await setThreshold(ORG_A, 'payroll_run', '0');

    const future = await accounts.client.request('POST', `/v1/hr/payroll/runs/${ownRun}/pay`, {
      body: { walletAccountId: wallet, paidOn: '2030-01-01' },
    });
    expect(future.statusCode, future.body).toBe(409);
    expect(future.body).toMatch(/posting window/);

    const loan = body<{ id: string }>(
      await hr.client.request('POST', '/v1/hr/loans', {
        body: {
          employeeId: bashir.id,
          principalPoisha: '300000',
          instalmentCount: 3,
          firstMonth: '2026-09',
        },
      }),
    ).id;
    const backdated = await accounts.client.request('POST', `/v1/hr/loans/${loan}/disburse`, {
      body: { walletAccountId: wallet, disbursedOn: '2020-01-01' },
    });
    expect(backdated.statusCode).toBe(409);
    expect(backdated.body).toMatch(/posting window/);
  });

  it('refuses a salary component whose code the payslip generates', async () => {
    /*
     * `bonus`, `absence`, `other_deduction` and `loan_instalment` are emitted by
     * `computePayrollLine`, and the payslip's component rows are unique on `(line, code)`. A
     * structure carrying an earning coded `bonus` — a fixed monthly bonus allowance, an
     * ordinary thing to type — would collide the moment that employee also got a bonus input,
     * and the whole month's submit would die pointing at nothing.
     */
    for (const code of ['basic', 'bonus', 'absence', 'loan_instalment']) {
      const response = await hr.client.request('POST', `/v1/hr/employees/${bashir.id}/salary`, {
        body: {
          effectiveFrom: '2027-01-01',
          basicPoisha: '2000000',
          components: [{ direction: 'earning', code, label: 'Nope', amountPoisha: '100000' }],
        },
      });
      expect(response.statusCode, `component code ${code}`).toBe(400);
    }
  });
});

/*
 * M30 security review, C2 and C3 (D-363). One person must not both type a staff loan and
 * hand over the cash, nor point somebody's salary at an account of their choosing.
 */
describe('M30: payroll money needs a second person and the payroll grant', () => {
  it('refuses to let whoever recorded a staff loan also disburse it', async () => {
    const loan = body<{ id: string }>(
      await hr.client.request('POST', '/v1/hr/loans', {
        body: {
          employeeId: bashir.id,
          principalPoisha: '100000',
          instalmentCount: 2,
          firstMonth: '2026-11',
        },
      }),
    ).id;

    const byMaker = await hr.client.request('POST', `/v1/hr/loans/${loan}/disburse`, {
      body: { walletAccountId: await bkashAccount() },
    });
    expect(byMaker.statusCode, byMaker.body).toBe(403);
    expect(byMaker.body).toContain('PAYROLL_SELF_DEALING');

    // A second hr user is a second person: the split is people, not roles.
    const bySecond = await secondHr.client.request('POST', `/v1/hr/loans/${loan}/disburse`, {
      body: { walletAccountId: await bkashAccount() },
    });
    expect(bySecond.statusCode, bySecond.body).toBe(201);
  });

  it('refuses a staff loan to yourself, and its disbursal by you', async () => {
    const self = await createEmployee(admin, {
      code: `M30-${randomUUID().slice(0, 6).toUpperCase()}`,
      fullName: 'HR Officer',
      joinDate: '2026-01-01',
      payoutMethod: 'cash',
      userId: hr.userId,
    });

    const toSelf = await hr.client.request('POST', '/v1/hr/loans', {
      body: { employeeId: self.id, principalPoisha: '100000', instalmentCount: 2, firstMonth: '2026-11' },
    });
    expect(toSelf.statusCode, toSelf.body).toBe(403);
    expect(toSelf.body).toContain('PAYROLL_SELF_DEALING');

    const recorded = await secondHr.client.request('POST', '/v1/hr/loans', {
      body: { employeeId: self.id, principalPoisha: '100000', instalmentCount: 2, firstMonth: '2026-11' },
    });
    expect(recorded.statusCode, recorded.body).toBe(201);
    const byBorrower = await hr.client.request(
      'POST',
      `/v1/hr/loans/${body<{ id: string }>(recorded).id}/disburse`,
      { body: { walletAccountId: await bkashAccount() } },
    );
    expect(byBorrower.statusCode, byBorrower.body).toBe(403);
    expect(byBorrower.body).toContain('PAYROLL_SELF_DEALING');

    // And nobody re-points their own salary.
    const ownPayout = await hr.client.request('PATCH', `/v1/hr/employees/${self.id}`, {
      body: { payoutMethod: 'bkash', payoutRef: '01700000000' },
    });
    expect(ownPayout.statusCode, ownPayout.body).toBe(403);
    expect(ownPayout.body).toContain('PAYROLL_SELF_DEALING');
  });

  it('keeps a branch manager to the showroom’s record, not where the salary goes', async () => {
    const payout = await branchManager.client.request('PATCH', `/v1/hr/employees/${chameli.id}`, {
      body: { payoutMethod: 'bkash', payoutRef: '01799999999' },
    });
    expect(payout.statusCode, payout.body).toBe(403);

    const link = await branchManager.client.request('PATCH', `/v1/hr/employees/${chameli.id}`, {
      body: { userId: branchManager.userId },
    });
    expect(link.statusCode, link.body).toBe(403);

    // The record a showroom keeps is still theirs to edit.
    const designation = await branchManager.client.request(
      'PATCH',
      `/v1/hr/employees/${chameli.id}`,
      { body: { designation: 'Senior sales associate' } },
    );
    expect(designation.statusCode, designation.body).toBe(200);

    // A hire with an account number, or linked to a login, is HR's to add.
    const withAccount = await branchManager.client.request('POST', '/v1/hr/employees', {
      body: {
        code: `M30-${randomUUID().slice(0, 6).toUpperCase()}`,
        fullName: 'New Hire',
        joinDate: '2026-01-01',
        branchId: otherBranch,
        payoutMethod: 'bkash',
        payoutRef: '01788888888',
      },
    });
    expect(withAccount.statusCode, withAccount.body).toBe(403);
    const cashHire = await createEmployee(branchManager, {
      code: `M30-${randomUUID().slice(0, 6).toUpperCase()}`,
      fullName: 'New Hire',
      joinDate: '2026-01-01',
      branchId: otherBranch,
      payoutMethod: 'cash',
    });

    // Marking someone resigned is ordinary; bringing them back is HR's.
    const resigned = await branchManager.client.request(
      'PATCH',
      `/v1/hr/employees/${cashHire.id}`,
      { body: { status: 'resigned', leaveDate: '2026-02-01' } },
    );
    expect(resigned.statusCode, resigned.body).toBe(200);
    const back = await branchManager.client.request('PATCH', `/v1/hr/employees/${cashHire.id}`, {
      body: { status: 'active', leaveDate: null },
    });
    expect(back.statusCode, back.body).toBe(403);
    const byHr = await hr.client.request('PATCH', `/v1/hr/employees/${cashHire.id}`, {
      body: { status: 'active', leaveDate: null },
    });
    expect(byHr.statusCode, byHr.body).toBe(200);
  });
});
