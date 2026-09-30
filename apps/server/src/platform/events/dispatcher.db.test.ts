import { SEED_ORG_IDS, withOrg } from '@elysium/db';
import { startTestDatabase, stopSharedContainer, type TestDatabase } from '@elysium/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_ATTEMPTS, OutboxDispatcher, pendingFor, type DeliveredEvent } from './dispatcher.js';
import { emit } from './outbox.js';

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

afterAll(async () => {
  await database?.stop();
  await stopSharedContainer();
});

async function publish(orgId: string, ref: string): Promise<void> {
  await withOrg({ orgId, userId: 'usr_dispatcher_test' }, async (tx) => {
    await emit(tx, 'job.failed', { queue: 'test.queue', ref, code: 'TEST' }, { orgId });
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

  it('counts a failed attempt, retries it, and stops at the dead-letter threshold', async () => {
    const dispatcher = new OutboxDispatcher();
    let calls = 0;
    dispatcher.on('job.failed', () => {
      calls += 1;
      throw new Error('subscriber is down');
    });

    await publish(ORG_A, 'poison');

    // The attempt has to survive the transaction that made it: a rolled-back count
    // would retry this row for ever and never dead-letter it.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      expect(await dispatcher.drain(1)).toEqual({ delivered: 0, failed: 1 });
      expect(await pendingFor(ORG_A)).toEqual([{ name: 'job.failed', attempts: attempt }]);
    }

    // Spent: no longer claimed, still there for a person to find, and reported.
    expect(await dispatcher.drain()).toEqual({ delivered: 0, failed: 0 });
    expect(calls).toBe(MAX_ATTEMPTS);
    const dead = await dispatcher.deadLettered();
    expect(dead.map((event) => (event.payload as { ref: string }).ref)).toEqual(['poison']);
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
