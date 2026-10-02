import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_ORG_IDS, withOrg, withSystem } from '@elysium/db';
import { startTestDatabase, stopSharedContainer, type TestDatabase } from '@elysium/db/testing';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';

import { enqueueWith } from './enqueue.js';
import { FailedJobsService } from './failed-jobs.service.js';
import { reportJobFailedThroughOutbox } from './job-failed.js';
import {
  DEFAULT_JOBS_SCHEMA,
  DHAKA_TZ,
  deadLetterNameFor,
  type QueueDefinition,
} from './queues.js';
import { JobsRuntime, type JobFailure } from './jobs.runtime.js';
import type { ActiveContext } from '../http/context.js';

/**
 * M04 acceptance checks 1 and 2, against a real PostgreSQL.
 *
 * Check 1: "A job enqueued inside a transaction that rolls back never runs.
 * After a commit it runs exactly once."
 * Check 2: "A job that keeps failing retries with backoff, lands in the
 * dead-letter queue and emits `job.failed`."
 *
 * Both are properties of the database and of pg-boss, so neither can be tested
 * against a fake: a mocked queue would demonstrate that the mock rolls back.
 *
 * The queues here are the suite's own rather than §20's. §20's queues belong to
 * the modules that will own them, and a test that borrowed `delivery.book_parcel`
 * would fail the day M12 gives it a different retry policy — for a reason that
 * has nothing to do with what is under test.
 */

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const ORG_B = SEED_ORG_IDS['oura-lifestyle'] ?? '';

/** A queue whose handler succeeds. Check 1's subject. */
const ECHO: QueueDefinition = { name: 'test.echo', scope: 'org' };

/**
 * A queue whose handler always throws. Check 2's subject.
 *
 * Two retries, not the house five, and a one-second base delay: with exponential
 * backoff the attempts land at roughly 0s, 1–2s and 2–4s, so the whole spend is
 * under ten seconds. Five retries at the default five seconds would be four
 * minutes of a test suite, and a suite people skip proves nothing.
 */
const FAILING: QueueDefinition = {
  name: 'test.always_fails',
  scope: 'org',
  retryLimit: 2,
  retryDelaySeconds: 1,
};

/** A global queue with a cron, to check the schedule is stored in Dhaka time. */
const NIGHTLY: QueueDefinition = {
  name: 'test.nightly',
  scope: 'global',
  cron: '0 2 * * *',
};

/**
 * Two queues with no handler, so their jobs stay queued and can be counted (D-207).
 *
 * The same singleton key goes into each twice. pg-boss only enforces a key under a
 * deduplicating policy, so on the default `standard` queue both jobs are written — which
 * was true of every `singletonKey` in this codebase until D-207 — and on an `exclusive`
 * queue the second is dropped.
 */
const KEYED_EXCLUSIVE: QueueDefinition = {
  name: 'test.keyed_exclusive',
  scope: 'org',
  policy: 'exclusive',
};
const KEYED_STANDARD: QueueDefinition = { name: 'test.keyed_standard', scope: 'org' };

const QUEUES = [ECHO, FAILING, NIGHTLY, KEYED_EXCLUSIVE, KEYED_STANDARD];

/** A named error, so `job.failed`'s code is something specific rather than `Error`. */
class CourierRefused extends Error {
  override name = 'CourierRefused';
}

let database: TestDatabase;
let runtime: JobsRuntime;

/** Every attempt at a job, in order, so backoff is measurable. */
const attempts: { queue: string; at: number }[] = [];
/** Every dead-letter report, so check 2 can assert on what `job.failed` carried. */
const reported: JobFailure[] = [];

beforeAll(async () => {
  database = await startTestDatabase('jobs');

  runtime = await JobsRuntime.start({
    role: 'worker',
    // The owner, because pg-boss installs and migrates its own schema.
    connectionString: database.ownerUrl,
    // The role the enqueue below runs as, inside `withOrg`. Without this grant
    // the insert fails with a permission error, which is the whole reason
    // `grantAppAccess` exists.
    appRole: 'erp_app',
    queues: QUEUES,
    logger: pino({ level: 'silent' }),
    // The floor pg-boss allows. Waiting is this suite's dominant cost.
    pollingIntervalSeconds: 0.5,
  });

  await runtime.work(
    ECHO.name,
    async (job) => {
      attempts.push({ queue: job.queue, at: Date.now() });
      // Asserting the envelope inside the handler rather than after: this is the
      // only place that sees what the wrapper actually handed over.
      expect(job.orgId).toBe(ORG_A);
      await Promise.resolve();
    },
    async (failure) => {
      reported.push(failure);
      await Promise.resolve();
    },
  );

  // The real reporter, not a spy: check 2 says the dead-lettered job *emits*
  // `job.failed`, and the only proof of that is a row in `events.outbox` with the
  // right org and the right audience. The spy runs alongside it so a failure in
  // the assertion can say which half broke.
  const toOutbox = reportJobFailedThroughOutbox(pino({ level: 'silent' }));
  await runtime.work(
    FAILING.name,
    async (job) => {
      attempts.push({ queue: job.queue, at: Date.now() });
      await Promise.resolve();
      throw new CourierRefused('the courier refused 01712345678');
    },
    async (failure) => {
      reported.push(failure);
      await toOutbox(failure);
    },
  );
}, 180_000);

afterAll(async () => {
  await runtime.stop();
  await database.stop();
  await stopSharedContainer();
}, 60_000);

describe('check 1: enqueueing inside the caller transaction', () => {
  it('never runs a job whose transaction rolled back', async () => {
    const before = await jobCount(ECHO.name);

    await expect(
      withOrg({ orgId: ORG_A }, async (tx) => {
        await enqueueWith(runtime, tx, ECHO.name, { note: 'rolled back' }, { orgId: ORG_A });
        // The business change fails after the enqueue, which is the ordering that
        // matters: the job row exists inside this transaction and must not
        // outlive it.
        throw new Error('the business change failed');
      }),
    ).rejects.toThrow('the business change failed');

    // Read on a different connection, so this is what the queue can see rather
    // than what the rolled-back transaction could.
    expect(await jobCount(ECHO.name)).toBe(before);

    // And the handler is never woken. Two polls' worth of grace, because "it has
    // not run yet" and "it will never run" are only distinguishable by waiting.
    const ran = attempts.filter((attempt) => attempt.queue === ECHO.name).length;
    await sleep(1_500);
    expect(attempts.filter((attempt) => attempt.queue === ECHO.name).length).toBe(ran);
  }, 60_000);

  it('runs a committed job exactly once', async () => {
    const jobId = await withOrg({ orgId: ORG_A }, async (tx) =>
      enqueueWith(runtime, tx, ECHO.name, { note: 'committed' }, { orgId: ORG_A, ref: 'ord_1' }),
    );
    expect(jobId).not.toBeNull();

    await waitFor(() => attempts.some((attempt) => attempt.queue === ECHO.name));

    // Then keep watching. "Exactly once" is not provable by the first delivery —
    // a queue that redelivers does so on its next poll, so the assertion has to
    // outlive one.
    await sleep(2_000);
    expect(attempts.filter((attempt) => attempt.queue === ECHO.name)).toHaveLength(1);

    await expect(completedCount(ECHO.name)).resolves.toBe(1);
  }, 60_000);

  it('refuses a tenant job with no org, before it reaches the database', async () => {
    // The check that stands in for RLS on `pgboss.job`, which has none. A job
    // with no org is a job whose handler has no tenant to open `withOrg` for,
    // and finding that out in the handler means finding it out after the retries.
    await expect(
      withOrg({ orgId: ORG_A }, async (tx) => enqueueWith(runtime, tx, ECHO.name, {})),
    ).rejects.toThrow(/needs an orgId/);
  });

  it('refuses poisha that arrived as a bigint', async () => {
    // Invariant 1: JSON has no integer wide enough, and `JSON.stringify` would
    // throw a message that says nothing about what to do instead.
    await expect(
      withOrg({ orgId: ORG_A }, async (tx) =>
        enqueueWith(runtime, tx, ECHO.name, { amountPoisha: 500n }, { orgId: ORG_A }),
      ),
    ).rejects.toThrow(/decimal string/);
  });
});

describe('check 2: retries, backoff, dead letter and job.failed', () => {
  it('retries with growing delays, dead-letters, and emits job.failed', async () => {
    await withOrg({ orgId: ORG_A }, async (tx) =>
      enqueueWith(runtime, tx, FAILING.name, { parcel: 'p1' }, { orgId: ORG_A, ref: 'ord_99' }),
    );

    // retryLimit 2 means three attempts in total: the first, and two retries.
    await waitFor(
      () => attempts.filter((attempt) => attempt.queue === FAILING.name).length >= 3,
      40_000,
    );

    const times = attempts
      .filter((attempt) => attempt.queue === FAILING.name)
      .map((attempt) => attempt.at);
    const firstGap = times[1]! - times[0]!;
    const secondGap = times[2]! - times[1]!;

    // Backoff, asserted against the floors rather than against each other.
    // pg-boss jitters each delay across `[d, 2d)`, so the two windows are 1–2s
    // and 2–4s: they touch at 2s, and polling adds up to another 500 ms to
    // either. Comparing the gaps directly would therefore be a coin flip roughly
    // never — but "roughly never" in CI is a flake somebody spends an afternoon
    // on. The floors separate a doubling delay from a fixed one, which is what
    // the acceptance check is about.
    expect(firstGap).toBeGreaterThanOrEqual(900);
    expect(secondGap).toBeGreaterThanOrEqual(1_900);

    // The dead-letter queue got the job, and its handler reported it.
    await waitFor(() => reported.some((failure) => failure.queue === FAILING.name), 30_000);

    const failure = reported.find((entry) => entry.queue === FAILING.name);
    expect(failure).toMatchObject({
      queue: FAILING.name,
      orgId: ORG_A,
      // The envelope's ref, not the payload: §19 allows ids, and `job.failed`
      // reaches every org_admin and every super admin.
      ref: 'ord_99',
      code: 'CourierRefused',
    });

    /*
     * The event itself, through the outbox.
     *
     * Waited for by polling *the outbox*, not by the spy above. The spy is
     * pushed before `toOutbox` is awaited, so waiting on it and then querying
     * immediately is a race — and it lost: the row was not there yet and the
     * assertion read an empty set. Watching the thing being asserted is the
     * only version of this that cannot be fast enough to pass and slow enough
     * to fail.
     */
    const readEvents = async () =>
      withSystem(
        async (tx) =>
          tx.execute<{
            name: string;
            payload: { queue: string; ref: string; code: string };
            rooms: string[];
          }>(sql`
            select name, payload, rooms from events.outbox
            where org_id = ${ORG_A} and name = 'job.failed'
          `),
        { orgId: ORG_A },
      );

    await waitFor(async () => [...(await readEvents())].length >= 1, 30_000);
    const events = await readEvents();
    expect([...events]).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      queue: FAILING.name,
      ref: 'ord_99',
      code: 'CourierRefused',
    });
    expect(events[0]?.rooms).toContain('super');

    // And the failure is on the row, where the admin endpoint reads it.
    const failed = await withSystem(async (tx) =>
      tx.execute<{ output: unknown; retry_count: number }>(sql`
        select output, retry_count
        from ${sql.raw(`${DEFAULT_JOBS_SCHEMA}.job`)}
        where name = ${FAILING.name} and state = 'failed'
      `),
    );
    expect([...failed]).toHaveLength(1);
    expect(failed[0]?.retry_count).toBe(2);

    // Invariant 10: pg-boss persists the rejection, and the handler's message
    // quoted a customer's phone number. It must be masked on the way in, because
    // the admin endpoint reads this column back.
    expect(JSON.stringify(failed[0]?.output)).not.toContain('01712345678');
  }, 90_000);

  it('a dead-lettered job is not run again as an ordinary job', async () => {
    // The dead-letter queue takes `retryLimit: 0`. A retrying dead-letter
    // handler would put one identical `job.failed` per retry in front of one
    // org_admin, which is how a notification surface stops being read.
    const deadLetter = await withSystem(async (tx) =>
      tx.execute<{ retry_limit: number }>(sql`
        select retry_limit
        from ${sql.raw(`${DEFAULT_JOBS_SCHEMA}.queue`)}
        where name = ${deadLetterNameFor(FAILING.name)}
      `),
    );
    expect([...deadLetter][0]?.retry_limit).toBe(0);
  });
});

/**
 * The admin read, against a database that actually has pg-boss in it.
 *
 * Deliberately not an HTTP test. `startHttpHarness` boots the API without a
 * worker, so pg-boss's schema is absent there and every response is the empty
 * list — which is the right behaviour and proves nothing about the filter. The
 * guard on the route is covered by the route matrix; what needs a real
 * `pgboss.job` is the tenancy predicate, because `pgboss.job` has no RLS and
 * that predicate is the only thing standing between two brands.
 *
 * Runs after check 2, which is what put a failed job in the table.
 */
describe('the failed-jobs admin read', () => {
  const service = new FailedJobsService();

  function contextFor(orgId: string, isSuperAdmin = false): ActiveContext {
    return {
      orgId,
      userId: 'usr_test',
      isSuperAdmin,
      roles: ['org_admin'],
      branchIds: [],
      branchIdsByRole: {},
      requestId: 'req_test',
    };
  }

  it('shows an org its own failed jobs and no other org anything', async () => {
    await waitFor(async () => (await failedCount(FAILING.name)) === 1, 30_000);

    const mine = await service.list(contextFor(ORG_A), { limit: 50 });
    expect(mine.jobs.map((job) => job.queue)).toContain(FAILING.name);
    expect(mine.jobs[0]).toMatchObject({ ref: 'ord_99', code: 'CourierRefused', attempts: 3 });

    // Oura has failed nothing. Elysium's dead parcel booking is not its business,
    // and `pgboss.job` has no policy that would have said so on its own.
    const theirs = await service.list(contextFor(ORG_B), { limit: 50 });
    expect(theirs.jobs).toEqual([]);
  }, 60_000);

  it('shows a super admin every org, per §5 exception 3', async () => {
    // The org id in the context is Oura, and the job belongs to Elysium: a super
    // admin's cross-org read must not depend on which org they last entered.
    const all = await service.list(contextFor(ORG_B, true), { limit: 50 });
    expect(all.jobs.map((job) => job.queue)).toContain(FAILING.name);
  }, 60_000);

  it('never returns the error message, only its code', async () => {
    // The handler's message quoted a phone number and pg-boss stored it. Invariant
    // 10 aside, an error message is also where a purchase cost would travel
    // (invariant 5), and `serializeFor` cannot prune a field that is prose inside
    // one string.
    const mine = await service.list(contextFor(ORG_A), { limit: 50 });
    expect(JSON.stringify(mine)).not.toContain('courier refused');
    expect(JSON.stringify(mine)).not.toContain('01712345678');
  }, 60_000);
});

describe('cron', () => {
  it('stores the schedule in Asia/Dhaka, not UTC', async () => {
    // §20: "Cron schedules run in Asia/Dhaka time." `0 2 * * *` in UTC is 08:00
    // in Dhaka, so the nightly reconciliation would run in the middle of the
    // working day against stock that is moving.
    const schedules = await runtime.boss.getSchedules(NIGHTLY.name);
    expect([...schedules]).toHaveLength(1);
    expect(schedules[0]?.cron).toBe('0 2 * * *');
    expect(schedules[0]?.timezone).toBe(DHAKA_TZ);
  });

  it('refuses a cron on a tenant-scoped queue', async () => {
    // A cron fires once, not once per tenant. The org id such a job would need
    // could only be invented, and the one it would get is whichever org the seed
    // happens to list first.
    await expect(
      JobsRuntime.start({
        role: 'client',
        connectionString: database.appUrl,
        queues: [{ name: 'test.bad', scope: 'org', cron: '0 2 * * *' }],
        logger: pino({ level: 'silent' }),
      }),
    ).rejects.toThrow(/must be global/);
  });
});

async function jobCount(queue: string): Promise<number> {
  const rows = await withSystem(async (tx) =>
    tx.execute<{ count: string }>(sql`
      select count(*) as count
      from ${sql.raw(`${DEFAULT_JOBS_SCHEMA}.job`)}
      where name = ${queue}
    `),
  );
  return Number(rows[0]?.count ?? 0);
}

async function failedCount(queue: string): Promise<number> {
  const rows = await withSystem(async (tx) =>
    tx.execute<{ count: string }>(sql`
      select count(*) as count
      from ${sql.raw(`${DEFAULT_JOBS_SCHEMA}.job`)}
      where name = ${queue} and state = 'failed'
    `),
  );
  return Number(rows[0]?.count ?? 0);
}

async function completedCount(queue: string): Promise<number> {
  const rows = await withSystem(async (tx) =>
    tx.execute<{ count: string }>(sql`
      select count(*) as count
      from ${sql.raw(`${DEFAULT_JOBS_SCHEMA}.job`)}
      where name = ${queue} and state = 'completed'
    `),
  );
  return Number(rows[0]?.count ?? 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until a condition holds.
 *
 * A fixed `sleep` long enough for CI is too long for a laptop, and one short
 * enough for a laptop is a flake in CI that reads as "the job never ran". This
 * repo has been bitten by exactly that before, which is why `drainOutbox` exists
 * next door.
 */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition did not hold in time');
    await sleep(100);
  }
}

describe('a singleton key (D-207)', () => {
  async function enqueueTwice(queue: string): Promise<{ ids: (string | null)[]; rows: number }> {
    const key = `same-${queue}`;
    const ids: (string | null)[] = [];
    // Two transactions, as two code paths meaning "make sure this happens" would be.
    for (const n of [1, 2]) {
      ids.push(
        await withOrg({ orgId: ORG_A, userId: 'usr_jobs_test' }, (tx) =>
          enqueueWith(runtime, tx, queue, { n }, { orgId: ORG_A, singletonKey: key }),
        ),
      );
    }
    const rows = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ n: number }>(sql`
            select count(*)::int as n from pgboss.job
            where name = ${queue} and singleton_key = ${key}
          `)
        )[0]?.n ?? -1,
      { orgId: ORG_A },
    );
    return { ids, rows };
  }

  it('drops the duplicate on an exclusive queue: one job, and null for the second', async () => {
    const { ids, rows } = await enqueueTwice(KEYED_EXCLUSIVE.name);
    expect(ids[0]).not.toBeNull();
    expect(ids[1]).toBeNull();
    expect(rows).toBe(1);
  });

  it('reports a queue whose stored policy is older than its definition (W7)', async () => {
    // `test.keyed_standard` exists as `standard`. A release that makes it `exclusive`
    // cannot change it in place, and must say so rather than carry on as if it had.
    const later = await JobsRuntime.start({
      role: 'worker',
      connectionString: database.ownerUrl,
      appRole: 'erp_app',
      queues: [{ ...KEYED_STANDARD, policy: 'exclusive' }],
      logger: pino({ level: 'silent' }),
    });
    try {
      expect(later.policyDrift()).toEqual([KEYED_STANDARD.name]);
    } finally {
      await later.stop();
    }
    expect(runtime.policyDrift()).toEqual([]);
  });

  it('enforces nothing on a standard queue: both jobs are written', async () => {
    // Not a behaviour anybody wants — the reason `policy` exists. Kept as a test so the
    // day a pg-boss upgrade changes it, the comments that rely on it are found.
    const { ids, rows } = await enqueueTwice(KEYED_STANDARD.name);
    expect(ids[0]).not.toBeNull();
    expect(ids[1]).not.toBeNull();
    expect(rows).toBe(2);
  });
});
