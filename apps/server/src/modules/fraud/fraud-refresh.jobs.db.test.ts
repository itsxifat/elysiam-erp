import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SEED_ORG_IDS, withOrg, withSystem } from '@elysium/db';
import { startTestDatabase, stopSharedContainer, type TestDatabase } from '@elysium/db/testing';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JobsRuntime, type JobFailure } from '../../platform/jobs/jobs.runtime.js';
import { setServerTestEnvWithDatabase } from '../../testing/test-env.js';
import { FraudModule } from './fraud.module.js';
import { FRAUD_QUEUES, FRAUD_REFRESH_QUEUE } from './fraud.queues.js';
import { FraudService } from './fraud.service.js';
import { applyFraudMigrations, TEST_HASH_KEY } from './fraud.testing.js';
import { registerFraudJobs } from './fraud.worker.js';
import { PhoneHashService } from './phone-hash.js';
import { FakeFraudProvider } from './providers/fake.provider.js';
import { FRAUD_PROVIDERS } from './providers/fraud-signal.provider.js';

/**
 * M13's background refresh, through the job system (§10, §20, invariant 6).
 *
 * §10: the desk "shows the badge within 300 ms from cache and refreshes stale data in the
 * background". Two halves, and neither was tested as a job: `assess()` enqueues
 * `fraud.refresh_provider` on a cache miss — inside a `try` that swallows every failure,
 * on purpose, so the desk keeps working — and the fraud suite then called
 * `refreshProviders` directly. A refresh that was never enqueued, or enqueued and never
 * worked, passed both. The swallowing `catch` is exactly what makes that silent: a wrong
 * queue name, an unregistered queue or a missing runtime all degrade to "provider
 * unavailable" for ever, with nothing in any log a person reads.
 *
 * And when this suite was written the second half did not exist: no handler for the queue
 * anywhere, so every refresh job would have expired unworked.
 *
 * So the whole loop runs here through a real pg-boss: a cache miss inside a transaction
 * leaves a job in `pgboss.job` carrying the org and the number; the same miss in a
 * transaction that rolls back leaves none; the handler, once registered, fetches from the
 * provider and fills `fraud.provider_checks`; pg-boss marks the job completed; and the
 * next badge is served from that cache without enqueueing anything.
 *
 * The services come from `FraudModule`'s own context, with the provider list replaced by a
 * fake — the one seam the module offers for it — so the lookup is real code end to end
 * except the network.
 */

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const PHONE = '01712000456';
const OTHER_PHONE = '01712000457';

let database: TestDatabase;
let context: INestApplicationContext;
let runtime: JobsRuntime;
let fraud: FraudService;
let hasher: PhoneHashService;
const provider = new FakeFraudProvider('steadfast').returns({
  total: 20,
  delivered: 5,
  returnedOrCancelled: 15,
  ratio: 0.25,
  raw: { total: 20, status: 'checked' },
});
const failures: JobFailure[] = [];

beforeAll(async () => {
  process.env.FRAUD_PHONE_HASH_KEY = TEST_HASH_KEY;
  database = await startTestDatabase('fraud-jobs');
  setServerTestEnvWithDatabase(database.appUrl, 'https://erp.example.com', 'erp.example.com');
  await applyFraudMigrations();

  const module = await Test.createTestingModule({ imports: [FraudModule] })
    .overrideProvider(FRAUD_PROVIDERS)
    .useValue([provider])
    .compile();
  context = await module.init();
  fraud = context.get(FraudService);
  hasher = context.get(PhoneHashService);

  runtime = await JobsRuntime.start({
    role: 'worker',
    connectionString: database.ownerUrl,
    appRole: 'erp_app',
    queues: FRAUD_QUEUES,
    logger: pino({ level: 'silent' }),
    pollingIntervalSeconds: 0.5,
  });

  // Providers are opt-in per org (§10), and off by default; this org has switched them on.
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into fraud.rules (org_id, provider_enabled) values (${ORG_A}, true)
        on conflict (org_id) do update set provider_enabled = true
      `);
    },
    { orgId: ORG_A },
  );
}, 420_000);

afterAll(async () => {
  await runtime?.stop();
  await context?.close();
  await database?.stop();
  await stopSharedContainer();
}, 60_000);

interface JobRow extends Record<string, unknown> {
  readonly state: string;
  readonly org_id: string | null;
  readonly phone: string | null;
  readonly providers: string[] | null;
  readonly singleton_key: string | null;
}

async function refreshJobs(): Promise<JobRow[]> {
  return withSystem(async (tx) => {
    const rows = await tx.execute<JobRow>(sql`
      select state::text as state, data->>'orgId' as org_id,
             data->'payload'->>'phone' as phone, data->'payload'->'providers' as providers,
             singleton_key
      from pgboss.job
      where name = ${FRAUD_REFRESH_QUEUE.name}
      order by created_on
    `);
    return [...rows];
  });
}

async function cachedRows(phone: string): Promise<{ provider: string; total: number }[]> {
  return withOrg({ orgId: ORG_A, userId: 'usr_fraud_jobs' }, async (tx) => {
    const rows = await tx.execute<{ provider: string; total: number }>(sql`
      select provider, total from fraud.provider_checks where phone_hash = ${hasher.hash(phone)}
    `);
    return [...rows];
  });
}

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

const assess = (phone: string) =>
  withOrg({ orgId: ORG_A, userId: 'usr_fraud_jobs' }, (tx) =>
    fraud.assess(tx, { orgId: ORG_A, phone }),
  );

describe('fraud.refresh_provider, through pg-boss', () => {
  it('enqueues nothing when the badge’s transaction rolls back', async () => {
    await expect(
      withOrg({ orgId: ORG_A, userId: 'usr_fraud_jobs' }, async (tx) => {
        await fraud.assess(tx, { orgId: ORG_A, phone: OTHER_PHONE });
        throw new Error('the order this badge was for was never saved');
      }),
    ).rejects.toThrow(/never saved/);

    // Invariant 6's shape: the job is written through the caller's transaction, so a
    // rolled-back confirm leaves no metered provider lookup behind it.
    expect((await refreshJobs()).filter((job) => job.phone === OTHER_PHONE)).toEqual([]);
  });

  it('enqueues a refresh on a cache miss, works it, and serves the next badge from cache', async () => {
    const first = await assess(PHONE);
    // A miss: no provider row yet, so the badge says so and does not wait for one.
    expect(first.providerAvailable).toBe(false);
    expect(first.providers).toEqual([]);

    /*
     * The job is really there, in the org's name, carrying what the handler needs.
     *
     * Asserted before any handler is registered, so what is seen is what `assess()` left
     * behind and not something a fast worker already consumed. The singleton key is the
     * hash, not the number, which is what keeps the number out of pg-boss's indexed
     * columns.
     */
    const queued = await refreshJobs();
    expect(queued).toEqual([
      expect.objectContaining({
        state: 'created',
        org_id: ORG_A,
        phone: PHONE,
        providers: ['steadfast'],
        singleton_key: `fraud:${hasher.hash(PHONE)}`,
      }),
    ]);
    expect(provider.calls, 'no lookup happens on the request path').toEqual([]);

    await registerFraudJobs({
      jobs: runtime,
      fraud,
      report: async (failure) => {
        failures.push(failure);
        await Promise.resolve();
      },
    });

    // pg-boss's record that the handler finished it, and the cache it filled.
    await eventually(
      refreshJobs,
      (jobs) => jobs.length === 1 && jobs[0]?.state === 'completed',
      'the refresh job to complete',
    );
    expect(await cachedRows(PHONE)).toEqual([{ provider: 'steadfast', total: 20 }]);
    // Looked up once, in E.164: the adapter is asked about the number the hash was
    // computed from.
    expect(provider.calls).toEqual(['+8801712000456']);

    // The next badge comes from the cache, carries the provider's counts, and enqueues
    // nothing — a warm number must not cost a metered lookup per view.
    const second = await assess(PHONE);
    expect(second.providerAvailable).toBe(true);
    expect(second.providers).toEqual([
      expect.objectContaining({ name: 'steadfast', total: 20, returnedOrCancelled: 15 }),
    ]);
    expect(second.trustScore).toBeLessThan(first.trustScore);
    expect(await refreshJobs()).toHaveLength(1);

    expect(failures, 'nothing was dead-lettered').toEqual([]);
  }, 120_000);
});
