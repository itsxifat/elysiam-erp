import { SEED_ORG_IDS, withOrg } from '@elysium/db';
import { startTestDatabase, stopSharedContainer, type TestDatabase } from '@elysium/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_ATTEMPTS, OutboxDispatcher, pendingFor, type DeliveredEvent } from './dispatcher.js';
import { emit, retryDelaySeconds } from './outbox.js';

/**
 * The dispatcher, through its own `drain()`.
 *
 * Nothing tested this before, and the omission hid a dispatcher that had never
 * delivered a single event: it claimed with no org context against a FORCE RLS table,
 * saw no rows, and reported `{delivered: 0}` for ever. The realtime suite noticed, said
 * so in a comment, and read the outbox by another route — so every suite was green while
 * no browser received an event and no subscriber ran. These tests go through `drain()`
 * and nothing else, for two brands at once, because "serves every org" is exactly the
 * property that was broken.
 */
const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const ORG_B = SEED_ORG_IDS['oura-lifestyle'] ?? '';

let database: TestDatabase;

beforeAll(async () => {
  database = await startTestDatabase('dispatcher');
}, 300_000);

// 60 s like the other database suites: dropping the database waits on the server, and
// under a full parallel run the default 10 s teardown timed out with every test passed.
afterAll(async () => {
  await database?.stop();
  await stopSharedContainer();
}, 60_000);

async function publish(orgId: string, ref: string): Promise<void> {
  await withOrg({ orgId, userId: 'usr_dispatcher_test' }, async (tx) => {
    await emit(tx, 'job.failed', { queue: 'test.queue', ref, code: 'TEST' }, { orgId });
  });
}

/** Seconds until the org's one failed row may be tried again, as the database sees it. */
async function secondsUntilRetry(orgId: string): Promise<number> {
  return withOrg({ orgId, userId: 'usr_dispatcher_test' }, async (tx) => {
    const rows = await tx.execute<{ seconds: string }>(sql`
      select extract(epoch from (next_attempt_at - now()))::text as seconds
      from events.outbox where dispatched_at is null and next_attempt_at is not null
    `);
    return Number(rows[0]?.seconds ?? Number.NaN);
  });
}

/** Wind the retry clock forward, standing in for the wait. */
async function makeDue(orgId: string): Promise<void> {
  await withOrg({ orgId, userId: 'usr_dispatcher_test' }, async (tx) => {
    await tx.execute(sql`
      update events.outbox set next_attempt_at = now() - interval '1 second'
      where dispatched_at is null
    `);
  });
}

describe('OutboxDispatcher.drain', () => {
  it('delivers events from every org, to the right subscriber, exactly once', async () => {
    const dispatcher = new OutboxDispatcher();
    const seen: DeliveredEvent[] = [];
    dispatcher.on('job.failed', (event) => {
      seen.push(event);
    });

    await publish(ORG_A, 'a-1');
    await publish(ORG_B, 'b-1');
    await publish(ORG_A, 'a-2');

    expect(await dispatcher.drain()).toEqual({ delivered: 3, failed: 0 });
    expect(
      seen.map((event) => [event.orgId, (event.payload as { ref: string }).ref]).sort(),
    ).toEqual(
      [
        [ORG_A, 'a-1'],
        [ORG_A, 'a-2'],
        [ORG_B, 'b-1'],
      ].sort(),
    );

    // Marked, so a second poll has nothing to do.
    expect(await dispatcher.drain()).toEqual({ delivered: 0, failed: 0 });
    expect(seen).toHaveLength(3);
    expect(await pendingFor(ORG_A)).toEqual([]);
    expect(await pendingFor(ORG_B)).toEqual([]);
  });

  it('waits before retrying a failed event, and dead-letters it after the fifth failure', async () => {
    const dispatcher = new OutboxDispatcher();
    let calls = 0;
    dispatcher.on('job.failed', () => {
      calls += 1;
      throw new Error('subscriber is down');
    });

    await publish(ORG_A, 'poison');

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      expect(await dispatcher.drain()).toEqual({ delivered: 0, failed: 1 });

      // The attempt survives the transaction that made it: a rolled-back count would
      // retry this row for ever and never dead-letter it.
      expect(await pendingFor(ORG_A)).toEqual([{ name: 'job.failed', attempts: attempt }]);

      // And it is not due again yet. Without the schedule the row is the oldest pending
      // one, so the very next claim takes it and all five attempts go in one pass.
      expect(await dispatcher.drain()).toEqual({ delivered: 0, failed: 0 });
      expect(await secondsUntilRetry(ORG_A)).toBeCloseTo(retryDelaySeconds(attempt), -1);

      await makeDue(ORG_A);
    }

    // Spent: no longer claimed, still there for a person to find.
    expect(await dispatcher.drain()).toEqual({ delivered: 0, failed: 0 });
    expect(calls).toBe(MAX_ATTEMPTS);

    // Reported once, and the table remembers — not the process. A second dispatcher is a
    // restarted worker, and it must not raise the same `job.failed` again.
    const reported: string[] = [];
    const report = (event: DeliveredEvent): Promise<void> => {
      reported.push((event.payload as { ref: string }).ref);
      return Promise.resolve();
    };
    expect(await dispatcher.reportDeadLetters(report)).toBe(1);
    expect(await new OutboxDispatcher().reportDeadLetters(report)).toBe(0);
    expect(reported).toEqual(['poison']);
  });

  it('spaces retries out: 5 s, 30 s, 2 min, 10 min', () => {
    expect([1, 2, 3, 4].map(retryDelaySeconds)).toEqual([5, 30, 120, 600]);
    // Past the table, the last delay holds rather than reading undefined.
    expect(retryDelaySeconds(9)).toBe(600);
  });

  it('does not let one failing event hold up the ones behind it', async () => {
    // The poison row from the test above is still in the table, spent.
    const dispatcher = new OutboxDispatcher();
    const seen: string[] = [];
    dispatcher.on('job.failed', (event) => {
      seen.push((event.payload as { ref: string }).ref);
    });

    await publish(ORG_A, 'after-poison');
    expect(await dispatcher.drain()).toEqual({ delivered: 1, failed: 0 });
    expect(seen).toEqual(['after-poison']);
  });
});
