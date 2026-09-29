import { randomUUID } from 'node:crypto';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SEED_ORG_IDS, withGlobal, withOrg, withSystem } from '@elysium/db';
import { startTestDatabase, stopSharedContainer, type TestDatabase } from '@elysium/db/testing';
import { poisha } from '@elysium/domain';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { enqueueWith } from '../../platform/jobs/enqueue.js';
import { JobsRuntime, type JobFailure } from '../../platform/jobs/jobs.runtime.js';
import { DHAKA_TZ } from '../../platform/jobs/queues.js';
import { setServerTestEnvWithDatabase } from '../../testing/test-env.js';
import { INVENTORY_API, type InventoryApi } from './inventory.api.js';
import { InventoryModule } from './inventory.module.js';
import { applyInventoryMigrations, seedProductWithSkus, warehouseId } from './inventory.testing.js';
import {
  RECONCILE_FAN_OUT_QUEUE,
  RECONCILE_ORG_QUEUE,
  registerInventoryJobs,
} from './inventory.worker.js';
import { INVENTORY_QUEUES, ReconcileService } from './reconcile.service.js';

/**
 * M07 check 5 through the job system: "drift injected by the owner role in a test is
 * detected by the reconciliation job, which raises an alert."
 *
 * `inventory.db.test.ts` proves `reconcileOrg` finds drift, by calling it. That leaves the
 * *job* untested — the cron, the fan-out, the per-org handler and the envelope that carries
 * the org between them — and the job is where this batch's failures actually were. The
 * courier's polling cron shipped reading a FORCE-RLS table with no org context, so its
 * policy saw `org_id = NULL`, matched nothing, and the cron enqueued nothing, forever, with
 * every test green. And when this suite was first written the reconciliation had no
 * handler at all: both queues were declared and nothing worked either one.
 *
 * So the whole path runs here through a real pg-boss against the test database, the way
 * the worker runs it: the cron is registered by the runtime, a tick of it is sent to the
 * fan-out queue, the fan-out enqueues through `enqueue(tx, …)`, pg-boss delivers each
 * per-org job to the registered handler, and the handler opens `withOrg` from the
 * envelope. The assertions are then made on what each org's *database* says — one
 * reconciliation row per active org, the drifted one flagged and alerted, the clean ones
 * not — and on pg-boss's own record that every per-org job completed.
 *
 * The drift is injected as `erp_owner` with 0033's trigger disabled for the statement, for
 * the reason `inventory.db.test.ts` gives: the damage this job exists to find is damage the
 * application cannot do.
 */

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const ORG_B = SEED_ORG_IDS['oura-lifestyle'] ?? '';
const ACTOR = { orgId: ORG_A, userId: 'usr_reconcile_jobs' };

let database: TestDatabase;
let context: INestApplicationContext;
let runtime: JobsRuntime;
const failures: JobFailure[] = [];

beforeAll(async () => {
  database = await startTestDatabase('inventory-jobs');
  setServerTestEnvWithDatabase(database.appUrl, 'https://erp.example.com', 'erp.example.com');
  await applyInventoryMigrations();
  context = await NestFactory.createApplicationContext(InventoryModule, { logger: false });

  runtime = await JobsRuntime.start({
    role: 'worker',
    // The owner, because pg-boss installs its own schema; the application role enqueues.
    connectionString: database.ownerUrl,
    appRole: 'erp_app',
    // The module's own definitions, so the cron below is the one production registers.
    queues: INVENTORY_QUEUES,
    logger: pino({ level: 'silent' }),
    pollingIntervalSeconds: 0.5,
  });

  await registerInventoryJobs({
    jobs: runtime,
    reconcile: context.get(ReconcileService),
    report: async (failure) => {
      failures.push(failure);
      await Promise.resolve();
    },
    logger: pino({ level: 'silent' }),
  });
}, 420_000);

afterAll(async () => {
  await runtime?.stop();
  await context?.close();
  await database?.stop();
  await stopSharedContainer();
}, 60_000);

async function activeOrgIds(): Promise<string[]> {
  return withGlobal(async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      select id from org.organizations where is_active order by slug
    `);
    return rows.map((row) => row.id);
  });
}

/** The latest reconciliation an org can see of itself, through its own RLS. */
async function latestReconciliation(orgId: string) {
  return withOrg({ orgId, userId: 'usr_reconcile_jobs' }, async (tx) => {
    const rows = await tx.execute<{
      id: string;
      drift_count: number;
      cost_drift_count: number;
      details: {
        kind: string;
        skuId: string;
        locationId?: string;
        expected: number;
        found: number;
      }[];
    }>(sql`
      select id, drift_count, cost_drift_count, details from inventory.reconciliations
      where org_id = ${orgId}
      order by ran_at desc
      limit 1
    `);
    return rows[0];
  });
}

/** pg-boss's record of the per-org jobs, read as the owner that owns its schema. */
async function orgJobs(): Promise<{ state: string; org_id: string | null }[]> {
  return withSystem(async (tx) => {
    const rows = await tx.execute<{ state: string; org_id: string | null }>(sql`
      select state::text as state, data->>'orgId' as org_id
      from pgboss.job
      where name = ${RECONCILE_ORG_QUEUE}
    `);
    return [...rows];
  });
}

/** Poll until `check` holds, or fail with what was last seen. */
async function eventually<T>(
  read: () => Promise<T>,
  check: (value: T) => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!check(last)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await read();
  }
  return last;
}

describe('the nightly reconciliation, through pg-boss', () => {
  it('registers its cron at 02:00 in Asia/Dhaka', async () => {
    // 02:00 in UTC is 08:00 in Dhaka: the job would run in the middle of the working day
    // and report every in-flight transaction as drift.
    const schedules = await runtime.boss.getSchedules(RECONCILE_FAN_OUT_QUEUE);
    expect([...schedules]).toHaveLength(1);
    expect(schedules[0]?.cron).toBe('0 2 * * *');
    expect(schedules[0]?.timezone).toBe(DHAKA_TZ);
  });

  it('fans a cron tick out to every active org, and the handler finds the injected drift', async () => {
    const api = context.get<InventoryApi>(INVENTORY_API);
    const warehouse = await warehouseId(ORG_A);
    const { skus } = await seedProductWithSkus(ORG_A, 'recjob', 1);
    const target = skus[0]?.id ?? '';

    await withOrg(ACTOR, (tx) =>
      api.receiveSupply(tx, ACTOR, {
        supplyId: randomUUID(),
        supplierId: randomUUID(),
        locationId: warehouse,
        branchId: null,
        occurredAt: new Date(),
        lines: [{ skuId: target, qty: 7, unitCostPoisha: poisha(10_000) }],
      }),
    );

    await withSystem(
      async (tx) => {
        await tx.execute(sql`alter table inventory.stock_levels disable trigger user`);
        await tx.execute(sql`
          update inventory.stock_levels set on_hand = on_hand + 3
          where org_id = ${ORG_A} and sku_id = ${target} and location_id = ${warehouse}
        `);
        await tx.execute(sql`alter table inventory.stock_levels enable trigger user`);
      },
      { orgId: ORG_A },
    );

    const orgs = await activeOrgIds();
    // Five brands. Fewer would mean the seed changed, and one would let a fan-out that only
    // ever reached the first org pass.
    expect(orgs.length).toBeGreaterThanOrEqual(2);
    expect(orgs).toContain(ORG_B);

    /*
     * One tick of the cron: exactly the envelope `registerQueues` schedules — global, no
     * org, empty payload — sent through the same `enqueue` path, because waiting for 02:00
     * is not a test. Everything after this line is pg-boss and the handlers.
     */
    await withGlobal((tx) => enqueueWith(runtime, tx, RECONCILE_FAN_OUT_QUEUE, {}));

    // Every per-org job ran to completion — pg-boss's record, not the handler's word.
    const jobs = await eventually(
      orgJobs,
      (rows) => rows.length >= orgs.length && rows.every((row) => row.state === 'completed'),
      `${String(orgs.length)} completed ${RECONCILE_ORG_QUEUE} jobs`,
    );
    expect(new Set(jobs.map((row) => row.org_id))).toEqual(new Set(orgs));

    // And each org holds a reconciliation of its own, visible through its own RLS.
    for (const orgId of orgs) {
      expect(await latestReconciliation(orgId), `a reconciliation for ${orgId}`).toBeDefined();
    }

    const found = await latestReconciliation(ORG_A);
    expect(found?.drift_count).toBeGreaterThanOrEqual(1);
    expect(found?.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'level',
          skuId: target,
          locationId: warehouse,
          expected: 7,
          found: 10,
        }),
      ]),
    );
    // The basis drifted with the level, which is the drift that compounds.
    expect(found?.cost_drift_count).toBeGreaterThanOrEqual(1);

    // The alert: an outbox row naming this reconciliation, written by the job's own
    // transaction, attributed to the system actor rather than to a person.
    const alerts = await withOrg(ACTOR, async (tx) => {
      const rows = await tx.execute<{ payload: { reconciliationId: string } }>(sql`
        select payload from events.outbox
        where org_id = ${ORG_A} and name = 'stock.drift_detected'
      `);
      return rows.map((row) => row.payload.reconciliationId);
    });
    expect(alerts).toContain(found?.id);

    // The other brands were reconciled and found clean — so the handler really did open
    // each job's own org, rather than reconciling ORG_A five times.
    const clean = await latestReconciliation(ORG_B);
    expect(clean?.drift_count).toBe(0);
    expect(clean?.cost_drift_count).toBe(0);

    expect(failures, 'nothing was dead-lettered').toEqual([]);
  }, 120_000);
});
