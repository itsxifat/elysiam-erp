import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, withOrg } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { applyHrMigrations, defaultCalendarId, seedEmployee, seedStructure } from './hr.testing.js';

/**
 * How the route-matrix suite calls M19's routes (M02b's D-070 gate).
 *
 * `route-matrix.e2e.test.ts` asserts that its fixture keys, the manifest and the
 * application's live routes are the same three sets — so the moment `HrModule` is
 * registered in `app.module.ts`, that suite fails until these exist. They live here rather
 * than in the suite because the suite is one file shared by every milestone building in
 * parallel, and a second write to it silently discards the first; the integrator adds one
 * import and one spread.
 *
 * The fixtures deliberately do **not** try to succeed. The suite's question is which roles
 * the *guard* admits, so a 404 or a 409 from a handler is as good as a 200 — what matters
 * is that it is not a 403. The exceptions are the mutations, which the suite also checks
 * leave an audit row, so those are given real ids and bodies that get far enough to be
 * audited.
 *
 * `prepare()` is idempotent and cheap after the first call.
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';

interface Fixtures {
  readonly employeeId: string;
  readonly calendarId: string;
  readonly runId: string;
  readonly loanId: string;
  readonly inputId: string;
  /** M20: a target, a bonus rule and its first version, for the read routes. */
  readonly targetId: string;
  readonly ruleId: string;
  readonly versionId: string;
}

let prepared: Fixtures | undefined;

/** Called once from the route-matrix suite's `beforeAll`. */
export async function prepareHrFixtures(): Promise<void> {
  if (prepared !== undefined) return;
  await applyHrMigrations();

  const employee = await seedEmployee(ORG_A, {
    code: 'RM-EMP-01',
    fullName: 'Route Matrix Employee',
    joinDate: '2026-01-01',
  });
  await seedStructure(ORG_A, {
    employeeId: employee.id,
    effectiveFrom: '2026-01-01',
    basicPoisha: 2_000_000n,
  });
  const calendarId = await defaultCalendarId(ORG_A);

  /*
   * A draft run and a pending loan, written directly.
   *
   * The suite drives `POST /payroll/runs/:id/submit` and `POST /loans/:id/disburse` as
   * every role, and a route whose id does not exist answers 404 for everybody — which
   * would make the guard's decision invisible. These rows exist so the admitted roles get
   * past the handler far enough to be audited.
   *
   * The run is deliberately left as a draft for a month with no attendance: submitting it
   * computes a real payroll and raises a real approval, which is exactly what the suite
   * should see the guard admit or refuse.
   */
  const ids = await withOrg({ orgId: ORG_A, userId: 'usr_route_matrix' }, async (tx) => {
    const run = await tx.execute<{ id: string }>(sql`
      insert into hr.payroll_runs (org_id, month, status, created_by)
      values (${ORG_A}, '2026-02', 'draft', 'usr_route_matrix')
      -- The index is partial (D-191: a rejected or cancelled run must not consume the
      -- month), so the predicate has to be repeated here or Postgres cannot infer which
      -- index the conflict is on and answers 42P10.
      on conflict (org_id, month) where status not in ('cancelled', 'rejected')
        do update set memo = excluded.memo
      returning id
    `);
    const runId = run[0]?.id ?? '';

    const input = await tx.execute<{ id: string }>(sql`
      insert into hr.payroll_inputs
        (org_id, run_id, employee_id, kind, label, amount_poisha, created_by)
      values (${ORG_A}, ${runId}, ${employee.id}, 'bonus', 'Route matrix bonus', 10000,
              'usr_route_matrix')
      returning id
    `);

    const loan = await tx.execute<{ id: string }>(sql`
      insert into hr.employee_loans
        (org_id, employee_id, principal_poisha, instalment_count, first_month, status, created_by)
      values (${ORG_A}, ${employee.id}, 600000, 3, '2026-03', 'pending_disbursement',
              'usr_route_matrix')
      returning id
    `);
    await tx.execute(sql`
      insert into hr.loan_instalments (org_id, loan_id, seq, due_month, amount_poisha)
      values (${ORG_A}, ${loan[0]?.id ?? ''}, 1, '2026-03', 200000)
      on conflict (org_id, loan_id, seq) do nothing
    `);

    return { runId, inputId: input[0]?.id ?? '', loanId: loan[0]?.id ?? '' };
  });

  const targetId = await seedTarget(employee.id, calendarId, '2026-02');
  const rule = await seedRuleVersion();

  prepared = {
    employeeId: employee.id,
    calendarId,
    ...ids,
    targetId,
    ruleId: rule.ruleId,
    versionId: rule.versionId,
  };
}

/** M20: an active target written directly, for a month no suite sets one in. */
async function seedTarget(employeeId: string, calendarId: string, month: string): Promise<string> {
  return withOrg({ orgId: ORG_A, userId: 'usr_route_matrix' }, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      insert into hr.targets
        (org_id, month, metric, scope, employee_id, calendar_id, target_value, created_by)
      values (${ORG_A}, ${month}, 'confirmed_orders', 'employee', ${employeeId},
              ${calendarId}, 10, 'usr_route_matrix')
      returning id
    `);
    const id = rows[0]?.id ?? '';
    await tx.execute(sql`
      insert into hr.target_members (org_id, target_id, employee_id)
      values (${ORG_A}, ${id}, ${employeeId})
    `);
    return id;
  });
}

/** M20: a bonus rule with one draft version. A fresh one per call where a route consumes it. */
async function seedRuleVersion(): Promise<{ ruleId: string; versionId: string }> {
  return withOrg({ orgId: ORG_A, userId: 'usr_route_matrix' }, async (tx) => {
    const rule = await tx.execute<{ id: string }>(sql`
      insert into hr.bonus_rules (org_id, name, metric, created_by)
      values (${ORG_A}, ${`RM rule ${randomUUID().slice(0, 8)}`}, 'confirmed_orders',
              'usr_route_matrix')
      returning id
    `);
    const ruleId = rule[0]?.id ?? '';
    const version = await tx.execute<{ id: string }>(sql`
      insert into hr.bonus_rule_versions (org_id, rule_id, version, definition, created_by)
      values (${ORG_A}, ${ruleId}, 1,
              ${JSON.stringify(RULE_DEFINITION)}::jsonb, 'usr_route_matrix')
      returning id
    `);
    return { ruleId, versionId: version[0]?.id ?? '' };
  });
}

const RULE_DEFINITION = {
  metric: 'confirmed_orders',
  tiers: [{ gte_pct: 100, amount_poisha: '100000' }],
};

/** M20: a draft payroll run of its own, so applying bonuses never meets a submitted one. */
async function seedDraftRun(): Promise<string> {
  return withOrg({ orgId: ORG_A, userId: 'usr_route_matrix' }, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      insert into hr.payroll_runs (org_id, month, status, created_by)
      values (${ORG_A}, ${nextFutureMonth()}, 'draft', 'usr_route_matrix')
      returning id
    `);
    return rows[0]?.id ?? '';
  });
}

/**
 * A distinct far-future month, and the first of it, one per call.
 *
 * Far future so it cannot collide with any month the e2e suites use, and sequential
 * rather than random because a random collision makes the route-matrix suite flaky —
 * which is worse than not having one, since a flaky gate gets skipped.
 */
let futureCounter = 0;

function nextFuture(): { year: number; month: number } {
  futureCounter += 1;
  const total = futureCounter - 1;
  return { year: 2100 + Math.floor(total / 12), month: (total % 12) + 1 };
}

function nextFutureMonth(): string {
  const { year, month } = nextFuture();
  return `${String(year)}-${String(month).padStart(2, '0')}`;
}

function nextFutureFirst(): string {
  return `${nextFutureMonth()}-01`;
}

function state(): Fixtures {
  if (prepared === undefined) {
    throw new Error('call prepareHrFixtures() in the suite’s beforeAll first');
  }
  return prepared;
}

export const HR_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/hr/employees': () => ({ url: '/v1/hr/employees' }),
  'GET /v1/hr/employees/:id': () => ({ url: `/v1/hr/employees/${state().employeeId}` }),
  'POST /v1/hr/employees': () => ({
    url: '/v1/hr/employees',
    // A fresh code per call: the suite runs each fixture once per role, and a duplicate
    // code would answer 400 for the second admitted role.
    body: {
      code: `RM-${randomUUID().slice(0, 6).toUpperCase()}`,
      fullName: 'Route Matrix Hire',
      joinDate: '2026-01-01',
      payoutMethod: 'cash',
    },
  }),
  'PATCH /v1/hr/employees/:id': () => ({
    url: `/v1/hr/employees/${state().employeeId}`,
    body: { designation: 'Packer' },
  }),
  'GET /v1/hr/employees/:id/payout-ref': () => ({
    url: `/v1/hr/employees/${state().employeeId}/payout-ref`,
  }),
  'GET /v1/hr/employees/:id/salary': () => ({
    url: `/v1/hr/employees/${state().employeeId}/salary`,
  }),
  'POST /v1/hr/employees/:id/salary': () => ({
    url: `/v1/hr/employees/${state().employeeId}/salary`,
    // A fresh effective date per call, because there is one structure per employee per
    // date. A counter rather than a random date: a random one collides eventually, and a
    // flaky route-matrix suite is worse than no route-matrix suite.
    body: { effectiveFrom: nextFutureFirst(), basicPoisha: '2500000' },
  }),
  'GET /v1/hr/calendars': () => ({ url: '/v1/hr/calendars' }),
  'POST /v1/hr/calendars': () => ({
    url: '/v1/hr/calendars',
    body: {
      code: `RM${randomUUID().slice(0, 4).toUpperCase()}`,
      name: 'Route matrix',
      weeklyOff: [5],
    },
  }),
  'POST /v1/hr/calendars/:id/holidays': () => ({
    url: `/v1/hr/calendars/${state().calendarId}/holidays`,
    // Upserts on (org, calendar, date), so repeating it per role is fine.
    body: { holidayDate: '2026-02-21', label: 'Route matrix holiday' },
  }),
  'GET /v1/hr/attendance': () => ({ url: '/v1/hr/attendance?month=2026-02' }),
  'PUT /v1/hr/attendance': () => ({
    url: '/v1/hr/attendance',
    body: {
      entries: [{ employeeId: state().employeeId, businessDate: '2026-02-02', status: 'present' }],
    },
  }),
  'GET /v1/hr/attendance/imports': () => ({ url: '/v1/hr/attendance/imports' }),
  'POST /v1/hr/attendance/imports': () => ({
    url: '/v1/hr/attendance/imports',
    // A preview, so it writes an import row and no attendance. `apply` defaults to false
    // and is left off on purpose: the guard's answer is the same either way.
    body: {
      month: '2026-02',
      csv: 'code,day,status\nRM-EMP-01,03/02/2026,P\n',
      mapping: { employeeCode: 'code', date: 'day', status: 'status' },
    },
  }),
  'GET /v1/hr/payroll/runs': () => ({ url: '/v1/hr/payroll/runs' }),
  'GET /v1/hr/payroll/runs/:id': () => ({ url: `/v1/hr/payroll/runs/${state().runId}` }),
  'POST /v1/hr/payroll/runs': () => ({
    url: '/v1/hr/payroll/runs',
    // One run per org per month, so each call needs its own month: a second run for the
    // same month answers 400 for everybody after the first admitted role.
    body: { month: nextFutureMonth() },
  }),
  'GET /v1/hr/payroll/runs/:id/preview': () => ({
    url: `/v1/hr/payroll/runs/${state().runId}/preview`,
  }),
  'GET /v1/hr/payroll/runs/:id/inputs': () => ({
    url: `/v1/hr/payroll/runs/${state().runId}/inputs`,
  }),
  'POST /v1/hr/payroll/runs/:id/inputs': () => ({
    url: `/v1/hr/payroll/runs/${state().runId}/inputs`,
    body: {
      employeeId: state().employeeId,
      kind: 'bonus',
      label: 'Route matrix',
      amountPoisha: '10000',
    },
  }),
  'DELETE /v1/hr/payroll/runs/:id/inputs/:inputId': () => ({
    url: `/v1/hr/payroll/runs/${state().runId}/inputs/${state().inputId}`,
  }),
  'POST /v1/hr/payroll/runs/:id/submit': () => ({
    url: `/v1/hr/payroll/runs/${state().runId}/submit`,
    body: { reason: 'Route matrix' },
  }),
  'POST /v1/hr/payroll/runs/:id/cancel': () => ({
    url: `/v1/hr/payroll/runs/${state().runId}/cancel`,
  }),
  'GET /v1/hr/payroll/wallets': () => ({ url: '/v1/hr/payroll/wallets' }),
  'POST /v1/hr/payroll/runs/:id/pay': () => ({
    url: `/v1/hr/payroll/runs/${state().runId}/pay`,
    // A random wallet id: the run is a draft, so this is a 409 for every admitted role,
    // which is exactly as informative about the guard as a 200 would be.
    body: { walletAccountId: randomUUID() },
  }),
  'GET /v1/hr/payroll/runs/:id/payslips': () => ({
    url: `/v1/hr/payroll/runs/${state().runId}/payslips`,
  }),
  'GET /v1/hr/payroll/runs/:id/payslips/:employeeId/pdf': () => ({
    url: `/v1/hr/payroll/runs/${state().runId}/payslips/${state().employeeId}/pdf`,
  }),
  'GET /v1/hr/loans': () => ({ url: '/v1/hr/loans' }),
  'GET /v1/hr/loans/:id': () => ({ url: `/v1/hr/loans/${state().loanId}` }),
  'POST /v1/hr/loans': () => ({
    url: '/v1/hr/loans',
    body: {
      employeeId: state().employeeId,
      principalPoisha: '600000',
      instalmentCount: 3,
      firstMonth: '2026-04',
    },
  }),
  'POST /v1/hr/loans/:id/disburse': () => ({
    url: `/v1/hr/loans/${state().loanId}/disburse`,
    body: { walletAccountId: randomUUID() },
  }),
  // --- M20: targets, bonus rules, productivity ---------------------------------------
  'GET /v1/hr/targets': () => ({ url: '/v1/hr/targets' }),
  'GET /v1/hr/targets/:id': () => ({ url: `/v1/hr/targets/${state().targetId}` }),
  'POST /v1/hr/targets': () => ({
    url: '/v1/hr/targets',
    // One live target per employee, metric and month, so each call takes its own month.
    body: {
      scope: 'employee',
      month: nextFutureMonth(),
      metric: 'confirmed_orders',
      employeeId: state().employeeId,
      targetValue: '10',
    },
  }),
  'POST /v1/hr/targets/refresh': () => ({ url: '/v1/hr/targets/refresh' }),
  'POST /v1/hr/targets/:id/cancel': async () => ({
    // A cancelled target is final, so each admitted role cancels one of its own.
    url: `/v1/hr/targets/${await seedTarget(state().employeeId, state().calendarId, nextFutureMonth())}/cancel`,
  }),
  'GET /v1/hr/performance/me': () => ({ url: '/v1/hr/performance/me?month=2026-02' }),
  'GET /v1/hr/productivity': () => ({ url: '/v1/hr/productivity?from=2026-02-01&to=2026-02-28' }),
  'GET /v1/hr/bonus-rules': () => ({ url: '/v1/hr/bonus-rules' }),
  'POST /v1/hr/bonus-rules': () => ({
    url: '/v1/hr/bonus-rules',
    // Names are unique per brand (case-insensitively), so each call names its own.
    body: { name: `RM ${randomUUID().slice(0, 8)}`, definition: RULE_DEFINITION },
  }),
  'POST /v1/hr/bonus-rules/:id/versions': () => ({
    url: `/v1/hr/bonus-rules/${state().ruleId}/versions`,
    body: { definition: RULE_DEFINITION },
  }),
  'GET /v1/hr/bonus-rules/versions/:versionId/preview': () => ({
    url: `/v1/hr/bonus-rules/versions/${state().versionId}/preview?month=2026-02`,
  }),
  'POST /v1/hr/bonus-rules/versions/:versionId/submit': async () => ({
    // A submitted version cannot be submitted again, so each call gets a fresh draft.
    url: `/v1/hr/bonus-rules/versions/${(await seedRuleVersion()).versionId}/submit`,
    body: { reason: 'Route matrix' },
  }),
  'GET /v1/hr/payroll/runs/:id/bonuses': () => ({
    url: `/v1/hr/payroll/runs/${state().runId}/bonuses`,
  }),
  'POST /v1/hr/payroll/runs/:id/bonuses': async () => ({
    url: `/v1/hr/payroll/runs/${await seedDraftRun()}/bonuses`,
  }),
};

/** The manifest entries the integrator appends, derived from the fixtures. */
export const HR_ROUTE_KEYS: readonly string[] = Object.keys(HR_ROUTE_FIXTURES);
