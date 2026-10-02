import { withOrg, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { OutboxDispatcher } from '../../platform/events/dispatcher.js';
import { emit } from '../../platform/events/outbox.js';
import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import {
  createBranch,
  ORG_A,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { seedProductWithSkus, type SeededSku } from '../inventory/inventory.testing.js';
import { seedCustomer, seedOrder } from '../orders/orders.testing.js';
import { seedEmployee, seedStructure } from './hr.testing.js';
import { HR_QUEUE_DEFINITIONS, HR_QUEUES } from './performance.queues.js';
import { deskSubscriber, DESK_EVENT_NAMES } from './performance.worker.js';
import { TargetsService } from './targets.service.js';

/**
 * Targets, bonuses and productivity against real Postgres, through the real HTTP pipeline
 * (M20 checks 3 and 4, the progress rollup and the payroll feed).
 *
 * * **Check 3**, the integration half: order events go through the real outbox (`emit`
 *   inside a transaction that names its actor), the real dispatcher and the worker's own
 *   subscriber into `hr.desk_events`, and the productivity report reads them back over
 *   HTTP — reassignment included. The outbox stamps `created_at` itself, so the test pins
 *   each row's time before the dispatcher reads it: pickup is a difference of times, and a
 *   test that depended on how fast it ran would prove nothing. The arithmetic's own table
 *   of seeded streams is `packages/domain/src/targets/targets.test.ts`.
 * * **Check 4**: two agents, each an employee with a login and a target. Each sees their
 *   own target, their own productivity row and their own dashboard — and the other's
 *   target is a 404, not a 403, so its existence is not an oracle. A branch manager sees
 *   their branch's staff, and an agent cannot reach bonus rules at all.
 * * **The payroll feed**: a rule is created, previewed, approved by a second person and
 *   applied to a draft run as a bonus input the run's payslip carries; applying twice
 *   replaces rather than adds, and a submitted run refuses it.
 */

const MONTH = '2026-08';

let harness: HttpHarness;
let jobs: JobsRuntime;
let hr: RoleClient;
let secondHr: RoleClient;
let agentA: RoleClient;
let agentB: RoleClient;
let branchManager: RoleClient;
let supervisor: RoleClient;

let showroom = '';
let employeeA = '';
let employeeB = '';
let targetA = '';
let targetB = '';
let customerId = '';
let sku: SeededSku;

function body<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

interface Target {
  readonly id: string;
  readonly employeeId: string | null;
  readonly targetValue: string;
  readonly achieved: string;
  readonly pctBps: number;
  readonly weeks: readonly {
    weekNo: number;
    planned: string;
    achieved: string;
    workingDays: number;
  }[];
}

interface ProductivityRow {
  readonly employeeId: string;
  readonly pickups: number;
  readonly medianPickupSeconds: number | null;
  readonly p90PickupSeconds: number | null;
  readonly handledOrders: number;
  readonly activeHours: number;
  readonly ordersPerActiveHour: number | null;
}

/** An order confirmed by `agent` at `confirmedAt`, optionally delivered. */
async function seedDeskOrder(input: {
  readonly agent: string;
  readonly confirmedAt: string;
  readonly status?: string;
  readonly deliveredAt?: string;
  readonly qty?: number;
  readonly deliveredQty?: number;
  readonly unitPricePoisha?: bigint;
  readonly discountPoisha?: bigint;
}): Promise<string> {
  const { id } = await seedOrder(ORG_A, {
    status: input.status ?? 'confirmed',
    customerId,
    assignedTo: input.agent,
    discountPoisha: input.discountPoisha ?? 0n,
    lines: [
      {
        skuId: sku.id,
        skuCode: sku.code,
        productName: 'Desk kurta',
        qty: input.qty ?? 1,
        unitPricePoisha: input.unitPricePoisha ?? 100_000n,
        deliveredQty: input.deliveredQty ?? 0,
      },
    ],
  });
  await withSystem(
    (tx) =>
      tx.execute(sql`
        update sales.orders
        set confirmed_by = ${input.agent}, confirmed_at = ${input.confirmedAt}::timestamptz,
            delivered_at = ${input.deliveredAt ?? null}::timestamptz
        where org_id = ${ORG_A} and id = ${id}
      `),
    { orgId: ORG_A },
  );
  return id;
}

beforeAll(async () => {
  harness = await startHttpHarness('performance-e2e');
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues: HR_QUEUE_DEFINITIONS,
    logger: pino({ level: 'silent' }),
  });

  // The suite stands on 2 August 2026: August's targets may be set, July's may not (D-280).
  harness.app.get(TargetsService).now = () => new Date('2026-08-02T06:00:00Z');

  showroom = await createBranch(ORG_A, 'SHR-PERF');
  hr = await harness.asRole('hr', ORG_A);
  secondHr = await harness.asRole('hr', ORG_A);
  agentA = await harness.asRole('sales', ORG_A);
  agentB = await harness.asRole('sales', ORG_A);
  supervisor = await harness.asRole('sales', ORG_A);
  branchManager = await harness.asRole('branch_manager', ORG_A, { branchIds: [showroom] });

  employeeA = (
    await seedEmployee(ORG_A, {
      code: 'PERF-A',
      fullName: 'Agent Asha',
      joinDate: '2026-01-01',
      userId: agentA.userId,
    })
  ).id;
  employeeB = (
    await seedEmployee(ORG_A, {
      code: 'PERF-B',
      fullName: 'Agent Bashir',
      joinDate: '2026-01-01',
      userId: agentB.userId,
      branchId: showroom,
    })
  ).id;
  await seedStructure(ORG_A, {
    employeeId: employeeA,
    effectiveFrom: '2026-01-01',
    basicPoisha: 2_000_000n,
  });

  customerId = await seedCustomer(ORG_A, { phoneE164: '+8801700000777', name: 'Desk Buyer' });
  const product = await seedProductWithSkus(ORG_A, 'perfdesk', 1);
  const first = product.skus[0];
  if (first === undefined) throw new Error('no SKU seeded');
  sku = first;

  /*
   * August 2026 starts on a Saturday. Asha confirms five orders in week 1 and seven in
   * week 3 (12 against a target of 10, so 120%); Bashir confirms four. One of Asha's
   * would-be thirteenth was cancelled after confirming, and counts for nobody (D-272).
   */
  for (let index = 0; index < 5; index += 1) {
    await seedDeskOrder({ agent: agentA.userId, confirmedAt: '2026-08-03T10:00:00+06:00' });
  }
  for (let index = 0; index < 7; index += 1) {
    await seedDeskOrder({ agent: agentA.userId, confirmedAt: '2026-08-17T10:00:00+06:00' });
  }
  await seedDeskOrder({
    agent: agentA.userId,
    confirmedAt: '2026-08-17T11:00:00+06:00',
    status: 'cancelled',
  });
  for (let index = 0; index < 4; index += 1) {
    await seedDeskOrder({ agent: agentB.userId, confirmedAt: '2026-08-05T10:00:00+06:00' });
  }
}, 600_000);

afterAll(async () => {
  await jobs?.stop();
  await harness?.close();
}, 120_000);

describe('targets: the split, the rollup and target.progress', () => {
  it('splits a target by working days with largest remainder and opens with progress', async () => {
    const created = await hr.client.request('POST', '/v1/hr/targets', {
      body: {
        scope: 'employee',
        month: MONTH,
        metric: 'confirmed_orders',
        employeeId: employeeA,
        targetValue: '10',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const target = body<Target>(created);
    targetA = target.id;

    // Fridays off: weeks of 6, 6, 6, 6 and 3 working days. 10 × 6/27 = 2.22 four times and
    // 1.11 once; the floors leave one order over, and the tie goes to the earliest week.
    expect(target.weeks.map((week) => week.workingDays)).toEqual([6, 6, 6, 6, 3]);
    expect(target.weeks.map((week) => week.planned)).toEqual(['3', '2', '2', '2', '1']);
    expect(target.achieved).toBe('12');
    expect(target.pctBps).toBe(12_000);
    expect(target.weeks.map((week) => week.achieved)).toEqual(['5', '0', '7', '0', '0']);

    const second = await hr.client.request('POST', '/v1/hr/targets', {
      body: {
        scope: 'employee',
        month: MONTH,
        metric: 'confirmed_orders',
        employeeId: employeeB,
        targetValue: '10',
      },
    });
    expect(second.statusCode, second.body).toBe(201);
    targetB = body<Target>(second).id;
    expect(body<Target>(second).achieved).toBe('4');
  });

  it('refuses a target for a month that has already ended', async () => {
    const late = await hr.client.request('POST', '/v1/hr/targets', {
      body: {
        scope: 'employee',
        month: '2026-07',
        metric: 'confirmed_orders',
        employeeId: employeeA,
        targetValue: '1',
      },
    });
    expect(late.statusCode).toBe(400);
    expect(body<{ code: string }>(late).code).toBe('TARGET_INVALID');
  });

  it('refuses a second live target on the same metric and month', async () => {
    const again = await hr.client.request('POST', '/v1/hr/targets', {
      body: {
        scope: 'employee',
        month: MONTH,
        metric: 'confirmed_orders',
        employeeId: employeeA,
        targetValue: '20',
      },
    });
    expect(again.statusCode, again.body).toBe(409);
    expect(body<{ code: string }>(again).code).toBe('TARGET_CONFLICT');
  });

  it('recomputes when orders move, and tells the agent and HR with target.progress', async () => {
    await seedDeskOrder({ agent: agentB.userId, confirmedAt: '2026-08-24T10:00:00+06:00' });
    const targets = harness.app.get(TargetsService);
    const moved = await targets.refreshOrg(
      ORG_A,
      'usr_perf_test',
      new Date('2026-08-25T06:00:00Z'),
    );
    expect(moved).toBe(1);

    const events = await withOrg({ orgId: ORG_A, userId: 'usr_perf_test' }, (tx) =>
      tx.execute<{
        payload: { targetId: string; achieved: string; pctBps: number };
        rooms: string[];
      }>(
        sql`select payload, rooms from events.outbox
            where org_id = ${ORG_A} and name = 'target.progress'
              and payload->>'targetId' = ${targetB}
            order by created_at desc limit 1`,
      ),
    );
    const event = events[0];
    expect(event?.payload).toMatchObject({ targetId: targetB, achieved: '5', pctBps: 5_000 });
    expect(event?.rooms).toContain(`user:${agentB.userId}`);
    expect(event?.rooms).toContain(`org:${ORG_A}:role:hr`);

    // Nothing moved since: a second refresh emits nothing.
    expect(await targets.refreshOrg(ORG_A, 'usr_perf_test', new Date('2026-08-25T06:00:00Z'))).toBe(
      0,
    );
  });

  it('counts delivered revenue net of the order discount, partial deliveries in part', async () => {
    // 2 × ৳1,000 less a ৳200 order discount, delivered in full: ৳1,800 of goods.
    await seedDeskOrder({
      agent: agentB.userId,
      confirmedAt: '2026-08-04T10:00:00+06:00',
      deliveredAt: '2026-08-06T10:00:00+06:00',
      status: 'delivered',
      qty: 2,
      deliveredQty: 2,
      discountPoisha: 20_000n,
    });
    // 3 × ৳500, one delivered: ৳500 recognised, the rest coming back.
    await seedDeskOrder({
      agent: agentB.userId,
      confirmedAt: '2026-08-04T11:00:00+06:00',
      deliveredAt: '2026-08-09T10:00:00+06:00',
      status: 'partially_delivered',
      qty: 3,
      deliveredQty: 1,
      unitPricePoisha: 50_000n,
    });

    const created = await hr.client.request('POST', '/v1/hr/targets', {
      body: {
        scope: 'employee',
        month: MONTH,
        metric: 'delivered_revenue',
        employeeId: employeeB,
        targetValue: '1000000',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const target = body<Target>(created);
    expect(target.achieved).toBe('230000');
    expect(target.weeks.map((week) => week.achieved)).toEqual(['180000', '50000', '0', '0', '0']);
  });
});

describe('an agent sees only their own stats (check 4)', () => {
  it('lists only the targets that count the caller', async () => {
    const mine = body<{ items: Target[] }>(await agentA.client.request('GET', '/v1/hr/targets'));
    expect(mine.items.map((target) => target.id)).toEqual([targetA]);

    const all = body<{ items: Target[] }>(await hr.client.request('GET', '/v1/hr/targets'));
    expect(all.items.map((target) => target.id)).toEqual(
      expect.arrayContaining([targetA, targetB]),
    );
  });

  it('answers 404 for another agent’s target, and 200 for their own', async () => {
    const other = await agentA.client.request('GET', `/v1/hr/targets/${targetB}`);
    expect(other.statusCode).toBe(404);
    const own = await agentA.client.request('GET', `/v1/hr/targets/${targetA}`);
    expect(own.statusCode, own.body).toBe(200);
  });

  it('gives the agent one productivity row, theirs', async () => {
    const response = await agentA.client.request(
      'GET',
      '/v1/hr/productivity?from=2026-08-01&to=2026-08-31',
    );
    expect(response.statusCode, response.body).toBe(200);
    const { items } = body<{ items: ProductivityRow[] }>(response);
    expect(items.map((row) => row.employeeId)).toEqual([employeeA]);
  });

  it('gives a branch manager their branch’s staff only', async () => {
    const response = await branchManager.client.request(
      'GET',
      '/v1/hr/productivity?from=2026-08-01&to=2026-08-31',
    );
    expect(response.statusCode, response.body).toBe(200);
    const { items } = body<{ items: ProductivityRow[] }>(response);
    expect(items.map((row) => row.employeeId)).toEqual([employeeB]);

    const targets = body<{ items: Target[] }>(
      await branchManager.client.request('GET', '/v1/hr/targets'),
    );
    expect(new Set(targets.items.map((target) => target.employeeId))).toEqual(new Set([employeeB]));
  });

  it('shows the agent their own dashboard and nobody else’s', async () => {
    const response = await agentA.client.request('GET', `/v1/hr/performance/me?month=${MONTH}`);
    expect(response.statusCode, response.body).toBe(200);
    const me = body<{ employee: { id: string } | null; targets: Target[] }>(response);
    expect(me.employee?.id).toBe(employeeA);
    expect(me.targets.map((target) => target.id)).toEqual([targetA]);
  });

  it('keeps agents out of bonus rules and target setting', async () => {
    expect((await agentA.client.request('GET', '/v1/hr/bonus-rules')).statusCode).toBe(403);
    const create = await agentA.client.request('POST', '/v1/hr/targets', {
      body: {
        scope: 'employee',
        month: '2026-09',
        metric: 'confirmed_orders',
        employeeId: employeeA,
        targetValue: '1',
      },
    });
    expect(create.statusCode).toBe(403);
  });
});

describe('pickup time from the real outbox (check 3)', () => {
  /** Emit one order event as `actor`, then pin its outbox time. */
  async function orderEvent(
    actor: string | null,
    name: 'order.created' | 'order.assigned' | 'order.claimed' | 'order.status_changed',
    payload: Record<string, unknown>,
    at: string,
  ): Promise<void> {
    await withOrg({ orgId: ORG_A, userId: actor ?? '' }, async (tx) => {
      await emit(tx, name, payload as never, { orgId: ORG_A });
    });
    await withSystem(
      (tx) =>
        tx.execute(sql`
          update events.outbox set created_at = ${at}::timestamptz
          where id = (select id from events.outbox where org_id = ${ORG_A} and name = ${name}
                      order by created_at desc, id desc limit 1)
        `),
      { orgId: ORG_A },
    );
  }

  const created = (id: string, assignedTo: string | null) => ({
    id,
    orderNo: `PERF-${id.slice(0, 4)}`,
    channel: 'phone',
    codAmountPoisha: '100000',
    assignedTo,
    createdAt: '2026-08-10T04:00:00.000Z',
  });
  const status = (id: string, to: string) => ({
    id,
    orderNo: `PERF-${id.slice(0, 4)}`,
    from: 'pending',
    to,
    at: '2026-08-10T04:00:00.000Z',
    resellerId: null,
    branchId: null,
  });

  it('times claims, reassignments and confirmations per agent', async () => {
    const one = '00000000-0000-4000-8000-0000000000a1';
    const two = '00000000-0000-4000-8000-0000000000a2';
    const three = '00000000-0000-4000-8000-0000000000a3';
    const T = (minutes: number, seconds = 0) =>
      new Date(
        Date.parse('2026-08-10T10:00:00+06:00') + minutes * 60_000 + seconds * 1000,
      ).toISOString();

    // One: from the web into the queue; Asha claims it four minutes later. 240 s.
    await orderEvent(null, 'order.created', created(one, null), T(0));
    await orderEvent(
      agentA.userId,
      'order.claimed',
      { id: one, orderNo: 'PERF-1', assignedTo: agentA.userId },
      T(4),
    );
    // Two: the supervisor gives it to Asha, then to Bashir after a minute; Bashir confirms
    // two minutes after that. 120 s for Bashir, nothing for Asha.
    await orderEvent(supervisor.userId, 'order.created', created(two, agentA.userId), T(0));
    await orderEvent(
      supervisor.userId,
      'order.assigned',
      { id: two, orderNo: 'PERF-2', assignedTo: agentB.userId },
      T(1),
    );
    await orderEvent(agentB.userId, 'order.status_changed', status(two, 'confirmed'), T(3));
    // Three: given to Bashir at creation, confirmed by him 30 s later.
    await orderEvent(supervisor.userId, 'order.created', created(three, agentB.userId), T(0));
    await orderEvent(agentB.userId, 'order.status_changed', status(three, 'confirmed'), T(0, 30));

    const dispatcher = new OutboxDispatcher();
    // A fixed clock, so both confirmations fall in one bucket whatever the wall time is.
    const subscriber = deskSubscriber(
      harness.app.get(TargetsService),
      () => new Date('2026-08-10T04:00:05Z'),
    );
    for (const name of DESK_EVENT_NAMES) dispatcher.on(name, subscriber);
    await dispatcher.drain(500);

    // Delivered again (the dispatcher is at least once): still one desk row per event.
    const [row] = await withOrg({ orgId: ORG_A, userId: 'usr_perf_test' }, (tx) =>
      tx.execute<{
        id: string;
        name: string;
        payload: unknown;
        rooms: string[];
        created_at: Date;
        actor_user_id: string | null;
      }>(
        sql`select id, name, payload, rooms, created_at, actor_user_id from events.outbox
            where org_id = ${ORG_A} and name = 'order.claimed' order by created_at desc limit 1`,
      ),
    );
    if (row === undefined) throw new Error('no claim in the outbox');
    await subscriber({
      id: row.id,
      orgId: ORG_A,
      name: row.name,
      payload: row.payload,
      rooms: row.rooms,
      attempts: 1,
      occurredAt: new Date(row.created_at),
      actorUserId: row.actor_user_id,
    });
    const deskRows = await withOrg({ orgId: ORG_A, userId: 'usr_perf_test' }, (tx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n from hr.desk_events
        where org_id = ${ORG_A} and order_id in (${one}, ${two}, ${three})
      `),
    );
    expect(deskRows[0]?.n).toBe(7);

    const response = await hr.client.request(
      'GET',
      '/v1/hr/productivity?from=2026-08-10&to=2026-08-10',
    );
    expect(response.statusCode, response.body).toBe(200);
    const items = body<{ items: ProductivityRow[] }>(response).items;
    const asha = items.find((item) => item.employeeId === employeeA);
    const bashir = items.find((item) => item.employeeId === employeeB);
    expect(asha).toMatchObject({
      pickups: 1,
      medianPickupSeconds: 240,
      p90PickupSeconds: 240,
      handledOrders: 1,
    });
    expect(bashir).toMatchObject({
      pickups: 2,
      medianPickupSeconds: 30,
      p90PickupSeconds: 120,
      handledOrders: 2,
    });
    expect(bashir?.activeHours).toBe(1);
    expect(bashir?.ordersPerActiveHour).toBe(2);
  });

  it('queues one progress recompute for a burst of status changes', async () => {
    const jobsQueued = await withSystem((tx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n from pgboss.job where name = ${HR_QUEUES.refreshProgress}
      `),
    );
    // Two confirmations in one dispatch pass, one bucket: one job.
    expect(jobsQueued[0]?.n).toBe(1);
  });
});

describe('bonus rules feed payroll', () => {
  const definition = {
    metric: 'confirmed_orders',
    tiers: [
      { gte_pct: 100, amount_poisha: 200000 },
      { gte_pct: 120, per_unit_above_target_poisha: 5000 },
    ],
  };
  let ruleId = '';
  let versionId = '';
  let runId = '';

  it('creates a rule as a draft and previews what it would pay', async () => {
    const created = await hr.client.request('POST', '/v1/hr/bonus-rules', {
      body: { name: 'Desk confirmations', definition },
    });
    expect(created.statusCode, created.body).toBe(201);
    const rule = body<{ id: string; versions: { id: string; status: string }[] }>(created);
    ruleId = rule.id;
    versionId = rule.versions[0]?.id ?? '';
    expect(rule.versions[0]?.status).toBe('draft');

    const preview = body<{
      items: { employeeId: string; amountPoisha: string }[];
      totalPoisha: string;
    }>(
      await hr.client.request(
        'GET',
        `/v1/hr/bonus-rules/versions/${versionId}/preview?month=${MONTH}`,
      ),
    );
    // Asha: 12 of 10 is 120% — ৳2,000 flat plus 2 × ৳50 above target. Bashir: 5 of 10.
    expect(preview.items.find((item) => item.employeeId === employeeA)?.amountPoisha).toBe(
      '210000',
    );
    expect(preview.items.find((item) => item.employeeId === employeeB)?.amountPoisha).toBe('0');
    expect(preview.totalPoisha).toBe('210000');
  });

  it('refuses a rule the DSL cannot read', async () => {
    const bad = await hr.client.request('POST', '/v1/hr/bonus-rules', {
      body: {
        name: 'Misspelt',
        definition: { metric: 'confirmed_orders', tiers: [{ gte_pct: 100, amount_poisa: 1 }] },
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(body<{ code: string }>(bad).code).toBe('BONUS_RULE_INVALID');
  });

  it('lets only the version’s author send it for approval', async () => {
    const notTheirs = await secondHr.client.request(
      'POST',
      `/v1/hr/bonus-rules/versions/${versionId}/submit`,
      { body: {} },
    );
    expect(notTheirs.statusCode).toBe(403);
  });

  it('pays nothing until a second person approves the version', async () => {
    const run = await hr.client.request('POST', '/v1/hr/payroll/runs', { body: { month: MONTH } });
    expect(run.statusCode, run.body).toBe(201);
    runId = body<{ id: string }>(run).id;

    const before = body<{ items: unknown[] }>(
      await hr.client.request('POST', `/v1/hr/payroll/runs/${runId}/bonuses`),
    );
    expect(before.items).toEqual([]);

    const submitted = await hr.client.request(
      'POST',
      `/v1/hr/bonus-rules/versions/${versionId}/submit`,
      {
        body: {},
      },
    );
    expect(submitted.statusCode, submitted.body).toBe(201);
    const version = body<{ versions: { id: string; status: string; approvalId: string | null }[] }>(
      submitted,
    ).versions.find((one) => one.id === versionId);
    expect(version?.status).toBe('pending_approval');

    // The maker is not their own checker.
    const own = await hr.client.request(
      'POST',
      `/v1/approvals/${version?.approvalId ?? ''}/decide`,
      {
        body: { decision: 'approved' },
      },
    );
    expect(own.statusCode).toBe(403);

    const decided = await secondHr.client.request(
      'POST',
      `/v1/approvals/${version?.approvalId ?? ''}/decide`,
      { body: { decision: 'approved' } },
    );
    expect(decided.statusCode, decided.body).toBe(201);

    const rules = body<{ items: { id: string; versions: { id: string; status: string }[] }[] }>(
      await hr.client.request('GET', '/v1/hr/bonus-rules'),
    );
    expect(rules.items.find((rule) => rule.id === ruleId)?.versions[0]?.status).toBe('approved');
  });

  it('a bonus_rule request raised by hand activates nothing', async () => {
    const raised = await hr.client.request('POST', '/v1/approvals', {
      body: { type: 'bonus_rule', amountPoisha: null },
    });
    expect(raised.statusCode, raised.body).toBe(201);
    const { id } = body<{ id: string }>(raised);
    const decided = await secondHr.client.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved' },
    });
    expect(decided.statusCode, decided.body).toBe(201);
    const rules = body<{ items: { id: string; versions: { status: string }[] }[] }>(
      await hr.client.request('GET', '/v1/hr/bonus-rules'),
    );
    expect(rules.items.find((rule) => rule.id === ruleId)?.versions.map((v) => v.status)).toEqual([
      'approved',
    ]);
  });

  it('applies the approved rule to the draft run as a bonus input, once however often', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const applied = await hr.client.request('POST', `/v1/hr/payroll/runs/${runId}/bonuses`);
      expect(applied.statusCode, applied.body).toBe(201);
      const result = body<{
        items: { employeeId: string; amountPoisha: string }[];
        totalPoisha: string;
      }>(applied);
      expect(result.items).toEqual([
        expect.objectContaining({ employeeId: employeeA, amountPoisha: '210000' }),
      ]);
      expect(result.totalPoisha).toBe('210000');
    }

    const inputs = body<{ items: { employeeId: string; kind: string; amountPoisha: string }[] }>(
      await hr.client.request('GET', `/v1/hr/payroll/runs/${runId}/inputs`),
    );
    expect(inputs.items.filter((input) => input.kind === 'bonus')).toEqual([
      expect.objectContaining({ employeeId: employeeA, amountPoisha: '210000' }),
    ]);

    // M19's own preview carries it into Asha's payslip.
    const preview = body<{ payslips: { employeeId: string; bonusPoisha: string }[] }>(
      await hr.client.request('GET', `/v1/hr/payroll/runs/${runId}/preview`),
    );
    expect(preview.payslips.find((line) => line.employeeId === employeeA)?.bonusPoisha).toBe(
      '210000',
    );
  });

  it('awards nobody the run will not pay, and says who was left out', async () => {
    // The supervisor is staff with no salary structure, confirming ten August orders
    // against a target of ten: the rule would pay ৳2,000, the run would pay nothing.
    const supervisorEmployee = await seedEmployee(ORG_A, {
      code: 'PERF-S',
      fullName: 'Supervisor Sumi',
      joinDate: '2026-01-01',
      userId: supervisor.userId,
    });
    for (let index = 0; index < 10; index += 1) {
      await seedDeskOrder({ agent: supervisor.userId, confirmedAt: '2026-08-12T10:00:00+06:00' });
    }
    const target = await hr.client.request('POST', '/v1/hr/targets', {
      body: {
        scope: 'employee',
        month: MONTH,
        metric: 'confirmed_orders',
        employeeId: supervisorEmployee.id,
        targetValue: '10',
      },
    });
    expect(target.statusCode, target.body).toBe(201);

    const applied = body<{
      items: { employeeId: string }[];
      skipped: { employeeId: string; amountPoisha: string }[];
    }>(await hr.client.request('POST', `/v1/hr/payroll/runs/${runId}/bonuses`));
    expect(applied.items.map((item) => item.employeeId)).toEqual([employeeA]);
    expect(applied.skipped).toEqual([
      expect.objectContaining({ employeeId: supervisorEmployee.id, amountPoisha: '200000' }),
    ]);
  });

  it('takes a cancelled target’s bonus off the draft run', async () => {
    const cancelled = await hr.client.request('POST', `/v1/hr/targets/${targetA}/cancel`);
    expect(cancelled.statusCode, cancelled.body).toBe(201);
    const after = body<{ items: unknown[] }>(
      await hr.client.request('GET', `/v1/hr/payroll/runs/${runId}/bonuses`),
    );
    expect(after.items).toEqual([]);

    // Set again, applied again: the bonus is back, once.
    const again = await hr.client.request('POST', '/v1/hr/targets', {
      body: {
        scope: 'employee',
        month: MONTH,
        metric: 'confirmed_orders',
        employeeId: employeeA,
        targetValue: '10',
      },
    });
    expect(again.statusCode, again.body).toBe(201);
    targetA = body<{ id: string }>(again).id;
    const reapplied = body<{ totalPoisha: string }>(
      await hr.client.request('POST', `/v1/hr/payroll/runs/${runId}/bonuses`),
    );
    expect(reapplied.totalPoisha).toBe('210000');
  });

  it('refuses a submit whose bonuses changed while it was being submitted', async () => {
    /*
     * The window W2 found: submit computes the payslips, commits, raises the approval, then
     * freezes what it computed. A bonus written in between would be on the run and not on
     * the frozen payslips. The approval request is the moment in the middle, so the test
     * writes the bonus there.
     */
    const approvals = harness.app.get(ApprovalsService);
    const original = approvals.request.bind(approvals);
    const spy = vi.spyOn(approvals, 'request').mockImplementationOnce(async (...args) => {
      await withSystem(
        (tx) =>
          tx.execute(sql`
            insert into hr.payroll_inputs
              (org_id, run_id, employee_id, kind, label, amount_poisha, created_by)
            values (${ORG_A}, ${runId}, ${employeeA}, 'bonus', 'Late Eid bonus', 50000,
                    'usr_perf_test')
          `),
        { orgId: ORG_A },
      );
      return original(...args);
    });
    try {
      const raced = await hr.client.request('POST', `/v1/hr/payroll/runs/${runId}/submit`, {
        body: { reason: 'August' },
      });
      expect(raced.statusCode, raced.body).toBe(409);
      expect(body<{ code: string }>(raced).code).toBe('PAYROLL_TRANSITION_INVALID');
    } finally {
      spy.mockRestore();
    }
    const run = body<{ status: string }>(
      await hr.client.request('GET', `/v1/hr/payroll/runs/${runId}`),
    );
    expect(run.status).toBe('draft');
  });

  it('refuses to change a submitted run’s bonuses', async () => {
    const submitted = await hr.client.request('POST', `/v1/hr/payroll/runs/${runId}/submit`, {
      body: { reason: 'August' },
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const again = await hr.client.request('POST', `/v1/hr/payroll/runs/${runId}/bonuses`);
    expect(again.statusCode).toBe(409);
    expect(body<{ code: string }>(again).code).toBe('PAYROLL_RUN_FROZEN');
  });
});
