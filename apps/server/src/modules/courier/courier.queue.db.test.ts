import { withOrg, withSystem } from '@elysium/db';
import { businessDate, poisha } from '@elysium/domain';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { attachScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import type { JobFailure } from '../../platform/jobs/jobs.runtime.js';
import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import type { QueueDefinition } from '../../platform/jobs/queues.js';
import { ORG_A, startHttpHarness, type HttpHarness } from '../../testing/http-harness.js';
import { CourierAccountsService } from './accounts.service.js';
import { COURIER_ADAPTERS, type CourierAdapterRegistry } from './adapters/courier-adapter.js';
import { FakeCourierAdapter } from './adapters/fake.adapter.js';
import { BookingService } from './booking.service.js';
import { resetCourierEnv } from './courier.config.js';
import { COURIER_QUEUE_DEFINITIONS, COURIER_QUEUES } from './courier.queues.js';
import * as repo from './courier.repository.js';
import {
  applyCourierMigrations,
  makeBankWallet,
  makeCourier,
  seedShippedOrder,
} from './courier.testing.js';
import { registerCourierJobs } from './courier.worker.js';
import { SettlementsService } from './settlements.service.js';
import { CourierSyncService } from './sync.service.js';

/**
 * The courier's jobs, through pg-boss for real (M12 check 6 and the poll cron; M15 check 4's
 * cron).
 *
 * M12's own suite drives every handler by calling it, which proves the handler and nothing
 * about the wiring — and the wiring is where this batch has twice shipped something that did
 * nothing: a poll cron that read a FORCE-RLS table with no org context, and a dead-letter
 * handler registered as a *second* worker on a queue the runtime already watched, so pg-boss
 * gave each dead letter to whichever fetched first. So here pg-boss runs against the test
 * database with the module's own handlers registered by `registerCourierJobs` — the function
 * `main.worker.ts` calls — and each test waits for the effect in the database:
 *
 * 1. **A booking that spends every retry** reaches the dead-letter queue, and *the courier's*
 *    handler flags the parcel `failed` and raises `delivery.booking_failed` — every time, not
 *    whenever it wins a race.
 * 2. **The poll cron** fans out a per-org job through pg-boss, and that job asks the courier
 *    and moves the parcel.
 * 3. **The settlement fetch cron** fans out per account and imports the statement.
 *
 * Retries are shortened (one retry, one second) so the dead-letter path takes seconds rather
 * than §20's fifteen minutes; everything else is the module's own queue definition.
 */

let harness: HttpHarness;
let jobs: JobsRuntime;
let fake: FakeCourierAdapter;
let booking: BookingService;
let accountId = '';
let courierId = '';
const reported: JobFailure[] = [];

const ACTOR = 'usr_courier_queue';
const WEBHOOK_SECRET = 'a-webhook-secret-of-sufficient-length';

function context(): ActiveContext {
  return {
    userId: ACTOR,
    orgId: ORG_A,
    roles: ['org_admin'],
    branchIds: [],
    isSuperAdmin: false,
    requestId: 'req-courier-queue',
  } as unknown as ActiveContext;
}

function request(): AuditableRequest {
  const carrier = { headers: {} } as unknown as AuditableRequest;
  attachScope(carrier, 'update', 'CourierSettlement', { kind: 'all' });
  return carrier;
}

/** Poll the database until `check` is satisfied, or fail with what was last seen. */
async function eventually<T>(
  read: () => Promise<T>,
  check: (value: T) => boolean,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!check(last)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting; last value: ${JSON.stringify(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await read();
  }
  return last;
}

async function consignment(id: string) {
  const row = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
    repo.consignmentById(tx, ORG_A, id),
  );
  if (row === undefined) throw new Error('no consignment');
  return row;
}

beforeAll(async () => {
  process.env.COURIER_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString('base64');
  resetCourierEnv();

  harness = await startHttpHarness('courier-queue');
  await applyCourierMigrations();

  // The module's own definitions, with the booking queue's retries shortened.
  const queues: QueueDefinition[] = COURIER_QUEUE_DEFINITIONS.map((definition) =>
    definition.name === COURIER_QUEUES.book
      ? { ...definition, retryLimit: 1, retryDelaySeconds: 1, retryDelayMaxSeconds: 1 }
      : definition,
  );
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues,
    logger: pino({ level: 'silent' }),
    pollingIntervalSeconds: 0.5,
  });

  booking = harness.app.get(BookingService);
  const registered = harness.app.get<CourierAdapterRegistry>(COURIER_ADAPTERS).get('fake');
  if (!(registered instanceof FakeCourierAdapter)) throw new Error('no fake adapter');
  fake = registered;

  // Exactly the call `main.worker.ts` makes, with a reporter that records instead of emitting.
  await registerCourierJobs({
    jobs,
    booking,
    sync: harness.app.get(CourierSyncService),
    settlements: harness.app.get(SettlementsService),
    report: (failure) => {
      reported.push(failure);
      return Promise.resolve();
    },
    logger: pino({ level: 'silent' }),
  });

  courierId = await makeCourier(ORG_A, 'fake', 'Fake Courier');
  const walletId = await makeBankWallet(ORG_A);
  const account = await harness.app.get(CourierAccountsService).upsert(context(), request(), {
    courierId,
    providerCode: 'fake',
    label: 'Fake (queue suite)',
    mode: 'sandbox',
    webhookSecret: WEBHOOK_SECRET,
    pollAfterHours: 1,
    settlementWalletId: walletId,
    isActive: true,
  });
  accountId = account.id;
}, 420_000);

afterAll(async () => {
  await jobs?.stop();
  await harness?.close();
}, 60_000);

async function reserve(orderId: string): Promise<string> {
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        update sales.orders set courier_id = ${courierId} where org_id = ${ORG_A} and id = ${orderId}
      `);
    },
    { orgId: ORG_A },
  );
  // `enqueue(tx, …)` inside the reservation's transaction: the job exists iff this commits.
  const reserved = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
    booking.reserveConsignment(tx, { orgId: ORG_A, userId: ACTOR }, { orderId }),
  );
  return reserved.consignmentId;
}

describe('a booking that spends every retry (M12 check 6, through the real queue)', () => {
  it('reaches the dead-letter queue, flags the parcel and raises delivery.booking_failed', async () => {
    fake.failNextBookings = 1_000;
    try {
      const order = await seedShippedOrder(ORG_A, { status: 'packed' });
      const consignmentId = await reserve(order.orderId);

      const row = await eventually(
        () => consignment(consignmentId),
        (current) => current.booking_state === 'failed',
      );
      // Two attempts (the first and one retry), then the dead letter's own entry.
      expect(row.booking_attempts).toBeGreaterThanOrEqual(2);
      expect(row.booking_failure_code).toBe('COURIER_BOOKING_FAILED');

      const events = await withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
        const rows = await tx.execute<{ payload: Record<string, unknown> }>(sql`
          select payload from events.outbox
          where org_id = ${ORG_A} and name = 'delivery.booking_failed'
            and payload->>'consignmentId' = ${consignmentId}
        `);
        return [...rows];
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.payload.orderId).toBe(order.orderId);

      // And the generic `job.failed` report as well, for the failed-jobs view.
      await eventually(
        () => Promise.resolve(reported.filter((entry) => entry.ref === consignmentId)),
        (entries) => entries.length === 1,
      );
      expect(reported.find((entry) => entry.ref === consignmentId)).toMatchObject({
        queue: COURIER_QUEUES.book,
        orgId: ORG_A,
        code: 'COURIER_BOOKING_FAILED',
      });
    } finally {
      fake.failNextBookings = 0;
    }
  }, 90_000);

  it('does it for every dead letter, not only the ones it wins a race for', async () => {
    fake.failNextBookings = 1_000;
    try {
      const ids: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const order = await seedShippedOrder(ORG_A, { status: 'packed' });
        ids.push(await reserve(order.orderId));
      }
      const rows = await eventually(
        () => Promise.all(ids.map((id) => consignment(id))),
        (current) => current.every((row) => row.booking_state === 'failed'),
      );
      expect(rows.map((row) => row.booking_state)).toEqual(['failed', 'failed', 'failed', 'failed']);
    } finally {
      fake.failNextBookings = 0;
    }
  }, 120_000);

  it('books through the queue when the courier answers', async () => {
    const order = await seedShippedOrder(ORG_A, { status: 'packed' });
    const consignmentId = await reserve(order.orderId);
    const row = await eventually(
      () => consignment(consignmentId),
      (current) => current.booking_state === 'booked',
    );
    expect(row.consignment_no).toMatch(/^FK-/);
  }, 60_000);
});

describe('the status poll cron (through the real queue)', () => {
  it('fans out per org and moves a stale parcel the courier has news about', async () => {
    const order = await seedShippedOrder(ORG_A);
    const consignmentId = await reserve(order.orderId);
    const booked = await eventually(
      () => consignment(consignmentId),
      (current) => current.booking_state === 'booked',
    );

    // Quiet for longer than the account's one-hour poll window, and moved on at the courier.
    await withSystem(
      async (tx) => {
        await tx.execute(sql`
          update courier.consignments set
            last_status_at = now() - interval '3 hours', last_polled_at = null
          where org_id = ${ORG_A} and id = ${consignmentId}
        `);
      },
      { orgId: ORG_A },
    );
    fake.advance(booked.consignment_no ?? '', 'with_rider');

    // What the cron itself does at :00 and :30: one global job with an org-less envelope.
    await jobs.boss.send(COURIER_QUEUES.poll, {
      orgId: null,
      ref: null,
      requestId: null,
      payload: {},
    });

    const moved = await eventually(
      () => consignment(consignmentId),
      (current) => current.status === 'out_for_delivery',
    );
    expect(moved.last_polled_at).not.toBeNull();

    // The fan-out went through pg-boss as a tenant job for this org.
    const perOrg = await withSystem(async (tx) => {
      const rows = await tx.execute<{ count: string }>(sql`
        select count(*) as count from pgboss.job
        where name = ${COURIER_QUEUES.pollOrg} and data->>'orgId' = ${ORG_A}
      `);
      return Number(rows[0]?.count ?? 0);
    });
    expect(perOrg).toBeGreaterThanOrEqual(1);
  }, 90_000);
});

describe('the settlement fetch cron (M15 check 4, through the real queue)', () => {
  it('fans out per account and imports a fetched statement once', async () => {
    const order = await seedShippedOrder(ORG_A);
    const consignmentId = await reserve(order.orderId);
    const booked = await eventually(
      () => consignment(consignmentId),
      (current) => current.booking_state === 'booked',
    );

    // Deliver it through the webhook path so the receivable and the collection exist.
    const sync = harness.app.get(CourierSyncService);
    fake.advance(booked.consignment_no ?? '', 'handed_to_customer');
    const accepted = await sync.acceptWebhook({
      orgId: ORG_A,
      providerCode: 'fake',
      headers: { 'x-fake-courier-secret': WEBHOOK_SECRET },
      raw: Buffer.from(JSON.stringify(fake.webhookBody(booked.consignment_no ?? '')), 'utf8'),
    });
    // The webhook job runs in the registered worker too.
    await eventually(
      () => consignment(consignmentId),
      (current) => current.delivered_at !== null,
    );
    expect(accepted.duplicate).toBe(false);

    fake.issuedStatements.push({
      reference: 'QUEUE-S1',
      settlementDate: businessDate(new Date()),
      rows: [
        {
          consignmentNo: booked.consignment_no ?? '',
          reference: order.orderNo,
          codCollectedPoisha: poisha(order.codAmountPoisha),
          deliveryChargePoisha: poisha(6_000n),
          returnChargePoisha: poisha(0n),
          otherChargePoisha: poisha(0n),
          netPoisha: null,
          rowNo: 1,
        },
      ],
    });

    const batches = () =>
      withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
        const rows = await tx.execute<{ count: string }>(sql`
          select count(*) as count from courier.settlements
          where org_id = ${ORG_A} and courier_account_id = ${accountId}
            and reference = 'QUEUE-S1' and source = 'api'
        `);
        return Number(rows[0]?.count ?? 0);
      });

    const cron = { orgId: null, ref: null, requestId: null, payload: {} };
    await jobs.boss.send(COURIER_QUEUES.fetchSettlements, cron);
    await eventually(batches, (value) => value === 1);

    // The next morning's cron sees the same statement again, and imports nothing.
    await jobs.boss.send(COURIER_QUEUES.fetchSettlements, cron);
    await eventually(
      () =>
        withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
          const rows = await tx.execute<{ count: string }>(sql`
            select count(*) as count from courier.settlement_fetch_runs
            where org_id = ${ORG_A} and courier_account_id = ${accountId}
          `);
          return Number(rows[0]?.count ?? 0);
        }),
      (value) => value >= 2,
    );
    expect(await batches()).toBe(1);
  }, 120_000);
});
