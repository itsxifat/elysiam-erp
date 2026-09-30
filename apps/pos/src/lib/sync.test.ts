import { describe, expect, it, vi } from 'vitest';

// `api.ts` reads the build-time environment on import; a unit test has none.
vi.mock('../env.js', () => ({ env: { VITE_API_URL: 'http://localhost:3000' } }));

import { ApiError, NetworkError, type SyncResult } from './api.js';
import type { OutboxEntry } from './store.js';
import { SyncEngine, type SyncState, type SyncStore } from './sync.js';

/**
 * The queue's rules (M23 checks 1 and 2, the till's half): offline is not an error,
 * a lost reply sends the same documents again, and a refusal never removes a sale.
 *
 * The outbox is a plain in-memory double here, because the rules are the engine's
 * and IndexedDB is the browser's — the Playwright spec drives the real one.
 */

function entry(id: string, seq: number): OutboxEntry {
  return {
    id,
    seq,
    kind: 'sale',
    document: { id },
    status: 'queued',
    createdAt: '2026-09-29T06:00:00.000Z',
    attempts: 0,
    outcome: null,
    reasons: [],
    error: null,
    receipt: null,
  };
}

function memoryStore(initial: OutboxEntry[]): SyncStore & { all(): OutboxEntry[] } {
  let entries = initial;
  return {
    all: () => entries,
    queued: () =>
      Promise.resolve(entries.filter((e) => e.status === 'queued').sort((a, b) => a.seq - b.seq)),
    updateEntries: (updates) => {
      entries = entries.map((e) => {
        const update = updates.find((u) => u.id === e.id);
        return update === undefined ? e : { ...e, ...update.patch };
      });
      return Promise.resolve();
    },
  };
}

const posted = (id: string, replayed = false): SyncResult => ({
  id,
  kind: 'sale',
  outcome: 'posted',
  replayed,
  reviewItemId: null,
  reasons: [],
  error: null,
});

const idsOf = (documents: readonly unknown[]) => documents.map((d) => (d as { id: string }).id);

function states(engine: SyncEngine): SyncState['kind'][] {
  const seen: SyncState['kind'][] = [];
  engine.subscribe((state) => seen.push(state.kind));
  return seen;
}

describe('the sync engine', () => {
  it('sends the queue oldest first and marks each document as the server answers', async () => {
    const store = memoryStore([entry('c', 3), entry('a', 1), entry('b', 2)]);
    const sent: string[][] = [];
    const engine = new SyncEngine(
      (documents) => {
        sent.push(idsOf(documents));
        return Promise.resolve({
          results: [
            posted('a'),
            { ...posted('b'), outcome: 'held', reasons: ['stock_shortfall'], reviewItemId: 'r1' },
            {
              ...posted('c'),
              outcome: 'rejected',
              error: { code: 'POS_SALE_INVALID', message: 'totals disagree' },
            },
          ],
        });
      },
      store,
      () => true,
    );
    await engine.flush();
    expect(sent).toEqual([['a', 'b', 'c']]);
    expect(store.all().map((e) => [e.id, e.status, e.outcome])).toEqual([
      ['c', 'failed', 'rejected'],
      ['a', 'synced', 'posted'],
      ['b', 'synced', 'held'],
    ]);
    // Refused, not removed: it stays in the outbox with the server's reason.
    expect(store.all().find((e) => e.id === 'c')?.error).toBe('totals disagree');
  });

  it('leaves the queue alone while offline, without calling the server', async () => {
    const store = memoryStore([entry('a', 1)]);
    let calls = 0;
    const engine = new SyncEngine(
      () => {
        calls += 1;
        return Promise.resolve({ results: [] });
      },
      store,
      () => false,
    );
    const seen = states(engine);
    await engine.flush();
    expect(calls).toBe(0);
    expect(seen.at(-1)).toBe('offline');
    expect(store.all()[0]?.status).toBe('queued');
  });

  it('keeps every document queued when the request never arrives, and sends the same ones again', async () => {
    const store = memoryStore([entry('a', 1), entry('b', 2)]);
    const sent: string[][] = [];
    let fail = true;
    const engine = new SyncEngine(
      (documents) => {
        sent.push(idsOf(documents));
        if (fail) return Promise.reject(new NetworkError(new Error('connection reset')));
        // The first attempt did reach the server; its reply was lost.
        return Promise.resolve({ results: [posted('a', true), posted('b', true)] });
      },
      store,
      () => true,
    );
    await engine.flush();
    expect(store.all().map((e) => [e.status, e.attempts])).toEqual([
      ['queued', 1],
      ['queued', 1],
    ]);

    fail = false;
    await engine.flush();
    expect(sent).toEqual([
      ['a', 'b'],
      ['a', 'b'],
    ]);
    expect(store.all().map((e) => e.status)).toEqual(['synced', 'synced']);
  });

  it('keeps every document queued when a proxy answers 5xx after the server applied them', async () => {
    const store = memoryStore([entry('a', 1)]);
    let first = true;
    const engine = new SyncEngine(
      () => {
        if (first) {
          first = false;
          return Promise.reject(new ApiError(504, 'SERVICE_UNAVAILABLE', 'upstream timed out'));
        }
        return Promise.resolve({ results: [posted('a', true)] });
      },
      store,
      () => true,
    );
    const seen = states(engine);
    await engine.flush();
    expect(seen.at(-1)).toBe('error');
    expect(store.all()[0]).toMatchObject({ status: 'queued', attempts: 1 });
    await engine.flush();
    expect(store.all()[0]).toMatchObject({ status: 'synced', outcome: 'posted' });
  });

  it('keeps the queue and says so when the session has ended', async () => {
    const store = memoryStore([entry('a', 1)]);
    const engine = new SyncEngine(
      () => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'signed out')),
      store,
      () => true,
    );
    const seen = states(engine);
    await engine.flush();
    expect(seen.at(-1)).toBe('signedOut');
    expect(store.all()[0]?.status).toBe('queued');
  });

  it('runs one pass at a time however often it is kicked', async () => {
    const store = memoryStore([entry('a', 1)]);
    let calls = 0;
    const engine = new SyncEngine(
      async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { results: [posted('a')] };
      },
      store,
      () => true,
    );
    await Promise.all([engine.flush(), engine.flush(), engine.flush()]);
    expect(calls).toBe(1);
  });

  it('drains more than one batch', async () => {
    const store = memoryStore(Array.from({ length: 120 }, (_, i) => entry(`d${String(i)}`, i)));
    const sizes: number[] = [];
    const engine = new SyncEngine(
      (documents) => {
        sizes.push(documents.length);
        return Promise.resolve({ results: idsOf(documents).map((id) => posted(id)) });
      },
      store,
      () => true,
    );
    await engine.flush();
    expect(sizes).toEqual([50, 50, 20]);
    expect(store.all().every((e) => e.status === 'synced')).toBe(true);
  });
});
