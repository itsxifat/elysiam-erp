import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, withOrg, type Tx } from '@elysium/db';
import { startTestDatabase, stopSharedContainer, type TestDatabase } from '@elysium/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultCalendarId, seedEmployee } from './hr.testing.js';
import * as repo from './performance.repository.js';

/**
 * What migration 0083 and the RLS in 0082 refuse, driven with raw SQL as the application
 * role (M20; ledger audit W6 and W7).
 *
 * Every rule here is also kept by a service, and the services' own suite is
 * `performance.e2e.test.ts`. This one goes around them, the way a repair script or a
 * future module would, and checks the database still says no: a target's terms and weekly
 * plan are fixed, its people are set once, a bonus rule version's JSON and approval link
 * cannot be forged, an award belongs to a draft run and to the input it made — and none of
 * it is visible or writable from another brand.
 */

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const ORG_B = SEED_ORG_IDS['oura-lifestyle'] ?? '';
const ACTOR = 'usr_perf_db';

let database: TestDatabase;
let calendarId = '';
let employeeE = '';
let employeeF = '';

const asA = <T>(fn: (tx: Tx) => Promise<T>) => withOrg({ orgId: ORG_A, userId: ACTOR }, fn);
const asB = <T>(fn: (tx: Tx) => Promise<T>) => withOrg({ orgId: ORG_B, userId: ACTOR }, fn);

/** The message Postgres raised, however the driver wraps it. */
async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
      if (/[A-Z_]{6,}:|row-level security/.test(current.message)) return current.message;
      current = current.cause;
    }
    return String(error);
  }
  return 'no error';
}

/** An employee target with its one member and one week, in one transaction. */
async function seedTarget(month: string): Promise<string> {
  return asA(async (tx) => {
    const id = await repo.insertTarget(tx, {
      orgId: ORG_A,
      month,
      metric: 'confirmed_orders',
      scope: 'employee',
      employeeId: employeeE,
      teamName: null,
      branchId: null,
      calendarId,
      targetValue: 10n,
      note: null,
      createdBy: ACTOR,
    });
    await repo.insertTargetMember(tx, ORG_A, id, employeeE);
    await repo.insertTargetWeek(tx, {
      orgId: ORG_A,
      targetId: id,
      weekNo: 1,
      startsOn: `${month}-01`,
      endsOn: `${month}-07`,
      workingDays: 6,
      planned: 10n,
    });
    return id;
  });
}

async function seedVersion(author: string): Promise<{ ruleId: string; versionId: string }> {
  return asA(async (tx) => {
    const ruleId = await repo.insertRule(tx, {
      orgId: ORG_A,
      name: `Rule ${randomUUID().slice(0, 8)}`,
      metric: 'confirmed_orders',
      createdBy: author,
    });
    const versionId = await repo.insertVersion(tx, {
      orgId: ORG_A,
      ruleId,
      definition: { metric: 'confirmed_orders', tiers: [{ gte_pct: 100, amount_poisha: '1000' }] },
      createdBy: author,
    });
    return { ruleId, versionId };
  });
}

/** A pending `bonus_rule` request, raised by `requestedBy`, naming `versionId`. */
async function seedRequest(requestedBy: string, versionId: string): Promise<string> {
  return asA(async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      insert into approvals.approval_requests (org_id, type, status, requested_by, payload)
      values (${ORG_A}, 'bonus_rule', 'pending', ${requestedBy},
              ${JSON.stringify({ ruleVersionId: versionId })}::jsonb)
      returning id
    `);
    return rows[0]?.id ?? '';
  });
}

/** Decided by `by`, acting as themselves: the approvals table stamps the actor. */
async function decide(requestId: string, decision: string, by: string): Promise<void> {
  await withOrg({ orgId: ORG_A, userId: by }, (tx) =>
    tx.execute(sql`
      update approvals.approval_requests
      set status = ${decision}::approvals.approval_status, decided_by = ${by}, decided_at = now()
      where org_id = ${ORG_A} and id = ${requestId}
    `),
  );
}

beforeAll(async () => {
  database = await startTestDatabase('performance-db');
  calendarId = await defaultCalendarId(ORG_A);
  employeeE = (await seedEmployee(ORG_A, { code: 'DB-E', fullName: 'E', joinDate: '2026-01-01' }))
    .id;
  employeeF = (await seedEmployee(ORG_A, { code: 'DB-F', fullName: 'F', joinDate: '2026-01-01' }))
    .id;
}, 300_000);

afterAll(async () => {
  await database?.stop();
  await stopSharedContainer();
}, 60_000);

describe('a target is what the agent was shown', () => {
  it('lets the rollup move achieved, and nothing else', async () => {
    const id = await seedTarget('2026-08');
    await asA((tx) => repo.setTargetAchieved(tx, ORG_A, id, 7n));
    await asA((tx) => repo.setWeekAchieved(tx, ORG_A, id, 1, 7n));

    expect(
      await refusal(
        asA((tx) => tx.execute(sql`update hr.targets set target_value = 1 where id = ${id}`)),
      ),
    ).toMatch(/^TARGET_FROZEN/);
    expect(
      await refusal(
        asA((tx) =>
          tx.execute(sql`update hr.target_weeks set planned = 1 where target_id = ${id}`),
        ),
      ),
    ).toMatch(/^TARGET_FROZEN/);
  });

  it('keeps a cancelled target final', async () => {
    const id = await seedTarget('2026-09');
    await asA((tx) => repo.cancelTarget(tx, ORG_A, id, ACTOR));
    expect(await refusal(asA((tx) => repo.setTargetAchieved(tx, ORG_A, id, 1n)))).toMatch(
      /^TARGET_FROZEN/,
    );
  });

  it('sets a target’s people once, and an employee target counts that employee alone', async () => {
    const id = await seedTarget('2026-10');
    expect(await refusal(asA((tx) => repo.insertTargetMember(tx, ORG_A, id, employeeF)))).toMatch(
      /^TARGET_FROZEN/,
    );

    expect(
      await refusal(
        asA(async (tx) => {
          const other = await repo.insertTarget(tx, {
            orgId: ORG_A,
            month: '2026-11',
            metric: 'confirmed_orders',
            scope: 'employee',
            employeeId: employeeE,
            teamName: null,
            branchId: null,
            calendarId,
            targetValue: 10n,
            note: null,
            createdBy: ACTOR,
          });
          await repo.insertTargetMember(tx, ORG_A, other, employeeF);
        }),
      ),
    ).toMatch(/^TARGET_INVALID/);
  });
});

describe('a bonus rule version is the JSON a checker approved', () => {
  it('never changes its definition', async () => {
    const { versionId } = await seedVersion('usr_author');
    expect(
      await refusal(
        asA((tx) =>
          tx.execute(sql`
            update hr.bonus_rule_versions set definition = '{"metric":"confirmed_orders"}'::jsonb
            where id = ${versionId}
          `),
        ),
      ),
    ).toMatch(/^BONUS_RULE_FROZEN/);
  });

  it('is submitted only with a bonus_rule request that names it', async () => {
    const { versionId } = await seedVersion('usr_author');
    const other = await seedVersion('usr_author');
    const elsewhere = await seedRequest('usr_author', other.versionId);
    expect(await refusal(asA((tx) => repo.markSubmitted(tx, ORG_A, versionId, elsewhere)))).toMatch(
      /^BONUS_RULE_FROZEN/,
    );
    expect(
      await refusal(asA((tx) => repo.setVersionStatus(tx, ORG_A, versionId, 'approved'))),
    ).toMatch(/^BONUS_RULE_FROZEN/);
  });

  it('goes into force only on its own approved request, decided by somebody but its author', async () => {
    // Raised by somebody else and approved by the author: the approvals table allows it,
    // because maker ≠ checker there is about the request; 0083 is about the terms.
    const forged = await seedVersion('usr_author');
    const forgedRequest = await seedRequest('usr_other', forged.versionId);
    expect(await asA((tx) => repo.markSubmitted(tx, ORG_A, forged.versionId, forgedRequest))).toBe(
      1,
    );
    expect(
      await refusal(asA((tx) => repo.setVersionStatus(tx, ORG_A, forged.versionId, 'approved'))),
    ).toMatch(/^BONUS_RULE_FROZEN/);
    await decide(forgedRequest, 'approved', 'usr_author');
    expect(
      await refusal(asA((tx) => repo.setVersionStatus(tx, ORG_A, forged.versionId, 'approved'))),
    ).toMatch(/^BONUS_RULE_FROZEN/);

    const honest = await seedVersion('usr_author');
    const honestRequest = await seedRequest('usr_author', honest.versionId);
    await asA((tx) => repo.markSubmitted(tx, ORG_A, honest.versionId, honestRequest));
    expect(
      await refusal(asA((tx) => repo.setVersionStatus(tx, ORG_A, honest.versionId, 'rejected'))),
    ).toMatch(/^BONUS_RULE_FROZEN/);
    await decide(honestRequest, 'approved', 'usr_checker');
    await asA((tx) => repo.setVersionStatus(tx, ORG_A, honest.versionId, 'approved'));
    const status = await asA((tx) => repo.versionById(tx, ORG_A, honest.versionId));
    expect(status?.status).toBe('approved');
  });
});

describe('an award belongs to a draft run and to the input it made', () => {
  it('refuses an award that does not match its input, and any change once the run is closed', async () => {
    const targetId = await seedTarget('2027-01');
    const { versionId } = await seedVersion('usr_author');
    const { runId, inputId } = await asA(async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into hr.payroll_runs (org_id, month, status, created_by)
        values (${ORG_A}, '2027-01', 'draft', ${ACTOR}) returning id
      `);
      const run = rows[0]?.id ?? '';
      const input = await tx.execute<{ id: string }>(sql`
        insert into hr.payroll_inputs (org_id, run_id, employee_id, kind, label, amount_poisha, created_by)
        values (${ORG_A}, ${run}, ${employeeE}, 'bonus', 'Target bonus', 1000, ${ACTOR})
        returning id
      `);
      return { runId: run, inputId: input[0]?.id ?? '' };
    });
    const award = (amountPoisha: bigint) =>
      asA((tx) =>
        repo.insertAward(tx, {
          orgId: ORG_A,
          runId,
          employeeId: employeeE,
          targetId,
          ruleVersionId: versionId,
          payrollInputId: inputId,
          targetValue: 10n,
          achieved: 10n,
          pctBps: 10_000,
          amountPoisha,
          createdBy: ACTOR,
        }),
      );

    expect(await refusal(award(999n))).toMatch(/^PAYROLL_INPUT_INVALID/);
    await award(1000n);

    await asA((tx) =>
      tx.execute(sql`update hr.payroll_runs set status = 'cancelled' where id = ${runId}`),
    );
    expect(
      await refusal(
        asA((tx) => tx.execute(sql`delete from hr.bonus_awards where run_id = ${runId}`)),
      ),
    ).toMatch(/^PAYROLL_RUN_FROZEN/);
  });
});

describe('an input waits for a run that is being closed (ledger re-check W1)', () => {
  it('refuses the input once the closing transaction commits, rather than slipping past it', async () => {
    const runId = await asA(async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into hr.payroll_runs (org_id, month, status, created_by)
        values (${ORG_A}, '2027-03', 'draft', ${ACTOR}) returning id
      `);
      return rows[0]?.id ?? '';
    });

    /*
     * Transaction A holds the run as a submit does — locked, its status changed, not yet
     * committed. Transaction B adds a bonus meanwhile. Reading the run without a lock, B's
     * guard saw `draft`; its foreign key's key-share lock then waited for A and succeeded
     * once A committed, because the run's key never changes, so the bonus landed on a run
     * that was no longer a draft. With `for share` B's guard waits for A and then refuses.
     */
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const closing = asA(async (tx) => {
      await tx.execute(sql`select id from hr.payroll_runs where id = ${runId} for update`);
      await tx.execute(sql`update hr.payroll_runs set status = 'cancelled' where id = ${runId}`);
      locked();
      await held;
    });
    await isLocked;

    let settled = false;
    const adding = refusal(
      asA((tx) =>
        tx.execute(sql`
          insert into hr.payroll_inputs
            (org_id, run_id, employee_id, kind, label, amount_poisha, created_by)
          values (${ORG_A}, ${runId}, ${employeeE}, 'bonus', 'Slipped in', 1000, ${ACTOR})
        `),
      ),
    ).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled, 'the input waited for the closing transaction').toBe(false);

    release();
    await closing;
    expect(await adding).toMatch(/^PAYROLL_RUN_FROZEN/);
  });
});

/**
 * Transaction A takes the run as a submit does and makes `change` without committing;
 * `release` lets it commit.
 */
async function holdRun(
  runId: string,
  change: (tx: Tx) => Promise<unknown>,
): Promise<{ release: () => Promise<void> }> {
  let letGo: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  let locked: () => void = () => undefined;
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const closing = asA(async (tx) => {
    await tx.execute(sql`select id from hr.payroll_runs where id = ${runId} for update`);
    await change(tx);
    locked();
    await held;
  });
  await isLocked;
  return {
    release: async () => {
      letGo();
      await closing;
    },
  };
}

/** Whether `work` is still waiting after a pause long enough for it to have finished. */
async function stillWaiting(work: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void work.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  return !settled;
}

/** A draft run for `month` with one bonus input and its award on a fresh target. */
async function seedAwardedRun(month: string): Promise<{
  runId: string;
  inputId: string;
  targetId: string;
  versionId: string;
}> {
  const targetId = await seedTarget(month);
  const { versionId } = await seedVersion('usr_author');
  return asA(async (tx) => {
    const runs = await tx.execute<{ id: string }>(sql`
      insert into hr.payroll_runs (org_id, month, status, created_by)
      values (${ORG_A}, ${month}, 'draft', ${ACTOR}) returning id
    `);
    const runId = runs[0]?.id ?? '';
    const inputs = await tx.execute<{ id: string }>(sql`
      insert into hr.payroll_inputs (org_id, run_id, employee_id, kind, label, amount_poisha, created_by)
      values (${ORG_A}, ${runId}, ${employeeE}, 'bonus', 'Target bonus', 1000, ${ACTOR})
      returning id
    `);
    const inputId = inputs[0]?.id ?? '';
    await repo.insertAward(tx, {
      orgId: ORG_A,
      runId,
      employeeId: employeeE,
      targetId,
      ruleVersionId: versionId,
      payrollInputId: inputId,
      targetValue: 10n,
      achieved: 10n,
      pctBps: 10_000,
      amountPoisha: 1000n,
      createdBy: ACTOR,
    });
    return { runId, inputId, targetId, versionId };
  });
}

describe('a run is locked before its inputs (ledger confirmation of 4215f61)', () => {
  it('makes a removal wait for a run being closed, then refuses it (W1, the delete side)', async () => {
    const { runId, inputId } = await seedAwardedRun('2027-04');
    const hold = await holdRun(runId, (tx) =>
      tx.execute(sql`update hr.payroll_runs set status = 'cancelled' where id = ${runId}`),
    );
    const removing = refusal(
      asA((tx) => tx.execute(sql`delete from hr.payroll_inputs where id = ${inputId}`)),
    );
    expect(await stillWaiting(removing), 'the delete waited for the closing run').toBe(true);
    await hold.release();
    expect(await removing).toMatch(/^PAYROLL_RUN_FROZEN/);
  });

  it('lets a target cancel see the run a submit left pending, not the draft it was (W-1)', async () => {
    const month = '2027-05';
    const { runId, targetId } = await seedAwardedRun(month);
    const requestId = await asA(async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into approvals.approval_requests
          (org_id, type, status, requested_by, payload, amount_poisha, amount_derived_by_server)
        values (${ORG_A}, 'payroll_run', 'pending', ${ACTOR}, '{}'::jsonb, 0, true)
        returning id
      `);
      return rows[0]?.id ?? '';
    });
    const hold = await holdRun(runId, (tx) =>
      tx.execute(sql`
        update hr.payroll_runs
        set status = 'pending_approval', approval_request_id = ${requestId}
        where id = ${runId}
      `),
    );
    // What the cancel does before it decides: lock the month's runs, then look.
    const checking = asA(async (tx) => {
      await repo.lockRunsForMonth(tx, ORG_A, month);
      return repo.pendingRunPaying(tx, ORG_A, targetId);
    });
    expect(await stillWaiting(checking), 'the cancel waited for the submit').toBe(true);
    await hold.release();
    expect(await checking).toBe(month);
  });

  it('leaves alone a run whose submit commits while a removal waits for it (N-4)', async () => {
    const { runId, versionId } = await seedAwardedRun('2027-06');
    const hold = await holdRun(runId, (tx) =>
      tx.execute(sql`update hr.payroll_runs set status = 'cancelled' where id = ${runId}`),
    );
    // A supersede's removal: no error from 0055's guard, and nothing removed.
    const removing = asA((tx) =>
      repo.deleteDraftAwardInputs(tx, ORG_A, { ruleVersionId: versionId }),
    );
    expect(await stillWaiting(removing), 'the removal waited for the run').toBe(true);
    await hold.release();
    expect(await removing).toBe(0);
  });
});

describe('another brand sees none of it (invariant 4)', () => {
  it('reads nothing of brand A’s targets, rules, awards or desk events', async () => {
    await asA((tx) =>
      repo.insertDeskEvent(tx, {
        orgId: ORG_A,
        eventId: randomUUID(),
        orderId: randomUUID(),
        kind: 'created',
        assigneeUserId: null,
        actorUserId: null,
        occurredAt: new Date('2026-08-10T04:00:00Z'),
      }),
    );
    const count = (tx: Tx, table: string) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.raw(table)}`);

    for (const table of [
      'hr.targets',
      'hr.target_members',
      'hr.target_weeks',
      'hr.bonus_rules',
      'hr.bonus_rule_versions',
      'hr.bonus_awards',
      'hr.desk_events',
    ]) {
      expect((await asA((tx) => count(tx, table)))[0]?.n, `${table} in A`).toBeGreaterThan(0);
      expect((await asB((tx) => count(tx, table)))[0]?.n, `${table} from B`).toBe(0);
    }
  });

  it('cannot write a row into brand A from brand B', async () => {
    const writes: [string, (tx: Tx) => Promise<unknown>][] = [
      [
        'a bonus rule',
        (tx) =>
          repo.insertRule(tx, {
            orgId: ORG_A,
            name: 'Smuggled',
            metric: 'confirmed_orders',
            createdBy: ACTOR,
          }),
      ],
      [
        'a target',
        (tx) =>
          repo.insertTarget(tx, {
            orgId: ORG_A,
            month: '2027-02',
            metric: 'confirmed_orders',
            scope: 'employee',
            employeeId: employeeE,
            teamName: null,
            branchId: null,
            calendarId,
            targetValue: 1n,
            note: null,
            createdBy: ACTOR,
          }),
      ],
      [
        'a desk event',
        (tx) =>
          repo.insertDeskEvent(tx, {
            orgId: ORG_A,
            eventId: randomUUID(),
            orderId: randomUUID(),
            kind: 'created',
            assigneeUserId: null,
            actorUserId: null,
            occurredAt: new Date('2026-08-10T04:00:00Z'),
          }),
      ],
    ];
    for (const [what, write] of writes) {
      // From brand B's context a brand-A row is refused by the policy's WITH CHECK, which
      // runs before any foreign key is checked (and a foreign-key check ignores RLS anyway).
      expect(await refusal(asB(write)), what).toMatch(/row-level security/);
    }
  });

  it('writes one desk row per outbox event, however often it is delivered', async () => {
    const eventId = randomUUID();
    const orderId = randomUUID();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await asA((tx) =>
        repo.insertDeskEvent(tx, {
          orgId: ORG_A,
          eventId,
          orderId,
          kind: 'claimed',
          assigneeUserId: 'usr_a',
          actorUserId: 'usr_a',
          occurredAt: new Date('2026-08-10T04:00:00Z'),
        }),
      );
    }
    const rows = await asA((tx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n from hr.desk_events where order_id = ${orderId}
      `),
    );
    expect(rows[0]?.n).toBe(1);
  });
});
