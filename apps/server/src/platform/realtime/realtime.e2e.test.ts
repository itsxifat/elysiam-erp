import { randomUUID } from 'node:crypto';

import { roleRoom, userRoom, type EventName } from '@elysium/contracts';
import { withGlobal, withOrg } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket as ClientSocket } from 'socket.io-client';

import { OutboxDispatcher, type DeliveredEvent, type Subscriber } from '../events/dispatcher.js';
import { emit, markDispatched } from '../events/outbox.js';
import { createLogger } from '../logging/logger.js';
import {
  APP_DOMAIN,
  ORG_A,
  ORG_B,
  ORIGIN,
  createBranch,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import {
  RT_CODES,
  RT_ERROR,
  RT_READY,
  createRealtimeEmitter,
  createRealtimeGateway,
} from './index.js';
import type { RealtimeGateway } from './index.js';

/**
 * M04 acceptance check 3 — "Realtime rooms are enforced".
 *
 * Real sockets against the real gateway, on a real listening port, with the real
 * cookie the real sign-in flow issued, and with events travelling the real path:
 * `emit(tx, …)` into `events.outbox`, `OutboxDispatcher.drain()`, the bridge, the
 * Valkey adapter, the browser. A mocked socket would prove the mock; the thing
 * this check is actually about is whether §19's room assignment survives every
 * layer between a committed row and a frame on the wire.
 *
 * Negative assertions never sleep. Each one emits an event the client *is*
 * entitled to immediately after the one it is not, and waits for that: frames on
 * one socket are ordered, so "the barrier arrived and the forbidden event did
 * not" is a decision rather than a guess. A `setTimeout(300)` in its place would
 * pass on a laptop, fail in CI, and read as "the gateway leaked" when it failed.
 */

let harness: HttpHarness;
let gateway: RealtimeGateway;
let port: number;
let dispatcher: RecordingDispatcher;

/**
 * The worker's side of the gateway, on the same Valkey key.
 *
 * Emit-only, exactly as `main.worker.ts` builds it: the process that drains the
 * outbox has no HTTP surface, so every event it delivers has to cross Valkey to
 * reach a socket. Two checks ride on it — that the crossing happens at all, and
 * that the throttle sits in that path. `wallet.balance_changed` stands in for
 * §19's one throttled entry, which the catalog does not hold yet (M07 raises
 * `stock.available_changed`); the mechanism under test is the same either way.
 */
let worker: RealtimeGateway;
const THROTTLE_WINDOW_MS = 150;

let accountsA: RoleClient;
let salesA: RoleClient;
let accountsB: RoleClient;
let branchSalesA: RoleClient;
let branchOne: string;
let branchTwo: string;

const open: ClientSocket[] = [];

beforeAll(async () => {
  // Before the harness, because `serverEnv()` parses once and caches: the
  // gateway's own warnings would otherwise flood the suite's output.
  process.env.LOG_LEVEL = 'fatal';

  harness = await startHttpHarness('realtime-gateway');
  const logger = createLogger('realtime-test');

  /*
   * A namespace per run, on the shared dev Valkey.
   *
   * Two suites running in parallel under one adapter key deliver each other's
   * broadcasts, and because the room names come from the seeded org ids they
   * would genuinely match — a cross-suite leak that looks exactly like the
   * cross-org leak this file is meant to detect.
   */
  const adapterKey = `elysium:rt:test:${randomUUID()}`;
  const valkeyUrl = process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379';

  // Fastify's own `listen`, because the harness deliberately does not listen —
  // every other suite talks to it through `inject()`. A handshake cannot be
  // injected: it is a WebSocket upgrade.
  await harness.server.listen({ port: 0, host: '127.0.0.1' });
  const address = harness.server.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  port = address.port;

  gateway = createRealtimeGateway(harness.server.server, {
    auth: harness.auth.auth,
    logger,
    trustedOrigins: [ORIGIN],
    valkey: { url: valkeyUrl, key: adapterKey },
  });

  worker = createRealtimeEmitter({
    logger,
    valkey: { url: valkeyUrl, key: adapterKey },
    throttle: {
      windowMs: THROTTLE_WINDOW_MS,
      events: { 'wallet.balance_changed': ['accountId'] },
    },
  });

  // The real dispatcher and the real bridge, so what `publish()` invokes below
  // is the subscriber the bridge actually registered rather than a stand-in.
  dispatcher = new RecordingDispatcher();
  const { bridgeOutboxToRealtime } = await import('./bridge.js');
  bridgeOutboxToRealtime(dispatcher, gateway, logger);

  branchOne = await createBranch(ORG_A, 'RT1');
  branchTwo = await createBranch(ORG_A, 'RT2');

  accountsA = await harness.asRole('accounts', ORG_A);
  salesA = await harness.asRole('sales', ORG_A);
  accountsB = await harness.asRole('accounts', ORG_B);
  branchSalesA = await harness.asRole('sales', ORG_A, { branchIds: [branchOne] });
}, 180_000);

afterAll(async () => {
  for (const socket of open) socket.disconnect();
  await gateway.close();
  await worker.close();
  await harness.close();
});

/** Everything one socket was sent, in order. */
class Recorder {
  readonly frames: { name: string; payload: unknown }[] = [];

  constructor(socket: ClientSocket) {
    socket.onAny((name: string, payload: unknown) => {
      this.frames.push({ name, payload });
    });
  }

  names(): string[] {
    return this.frames.map((frame) => frame.name);
  }

  payloadsOf(name: string): unknown[] {
    return this.frames.filter((frame) => frame.name === name).map((frame) => frame.payload);
  }

  /**
   * Resolve once `name` has been seen `count` times.
   *
   * Polls its own already-recorded frames rather than adding a second listener,
   * so an event that arrived before the wait started still counts. A listener
   * registered late is the classic source of a "realtime test hangs sometimes".
   */
  async waitFor(name: string, count = 1, timeoutMs = 10_000): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const seen = this.payloadsOf(name);
      if (seen.length >= count) return seen[count - 1];
      if (Date.now() > deadline) {
        throw new Error(
          `waited ${String(timeoutMs)}ms for ${name}; saw ${this.names().join(', ')}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

interface Connected {
  readonly socket: ClientSocket;
  readonly recorder: Recorder;
  readonly rooms: string[];
}

/** A connected `/rt` socket carrying this client's session cookie. */
/** A short wait, for the handful of assertions that are about *not* receiving. */
async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function connect(
  client: RoleClient,
  options: { readonly origin?: string } = {},
): Promise<Connected> {
  const socket = io(`http://127.0.0.1:${String(port)}/rt`, {
    // Websocket only: the polling fallback would make each assertion depend on
    // which transport happened to win the upgrade race.
    transports: ['websocket'],
    extraHeaders: {
      cookie: client.client.cookieHeader(),
      origin: options.origin ?? ORIGIN,
      host: APP_DOMAIN,
    },
    reconnection: false,
  });
  open.push(socket);

  const recorder = new Recorder(socket);
  const rooms = await new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('handshake did not complete'));
    }, 15_000);
    socket.on(RT_READY, (payload: { rooms: string[] }) => {
      clearTimeout(timer);
      resolve(payload.rooms);
    });
    socket.on('connect_error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  return { socket, recorder, rooms };
}

/** A handshake that is expected to fail, resolved to its error code. */
async function refusedHandshake(
  headers: Record<string, string>,
): Promise<{ code: unknown; message: string }> {
  const socket = io(`http://127.0.0.1:${String(port)}/rt`, {
    transports: ['websocket'],
    extraHeaders: headers,
    reconnection: false,
  });
  open.push(socket);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the handshake was not refused'));
    }, 15_000);
    socket.on('connect_error', (error: Error) => {
      clearTimeout(timer);
      resolve({
        code: (error as Error & { data?: { code?: unknown } }).data?.code,
        message: error.message,
      });
    });
    socket.on(RT_READY, () => {
      clearTimeout(timer);
      reject(new Error('the handshake succeeded and should not have'));
    });
  });
}

/**
 * The dispatcher, with the bridge's own subscribers kept where a test can reach
 * them.
 *
 * `OutboxDispatcher.on()` files subscribers in a private map and only `drain()`
 * calls them, so a test that wants to exercise *the registered subscriber* has
 * to intercept the registration. Overriding `on` is how, and it keeps the real
 * `bridgeOutboxToRealtime` in the path rather than a hand-rolled copy of it.
 */
class RecordingDispatcher extends OutboxDispatcher {
  readonly bridged = new Map<string, Subscriber[]>();

  override on(name: string, subscriber: Subscriber): void {
    super.on(name, subscriber);
    const existing = this.bridged.get(name) ?? [];
    existing.push(subscriber);
    this.bridged.set(name, existing);
  }
}

/**
 * Write one event through the real outbox, then hand the stored row to the
 * bridge.
 *
 * Every layer this slice owns is real: `emit()` validates the payload against
 * its `.strict()` schema and computes the rooms, PostgreSQL round-trips both
 * through `jsonb`, the row is read back exactly as a dispatcher would read it,
 * and the bridge's subscriber and the gateway take it from there.
 *
 * What is *not* used is `OutboxDispatcher.drain()`, and not by preference.
 * `drain()` claims with `withSystem()`, which connects as `erp_owner` and sets
 * no `app.org_id`; `events.outbox` is FORCE RLS and `erp_owner` is NOBYPASSRLS
 * (D-042), so the claim matches nothing and the dispatcher delivers zero rows —
 * verified here: one row visible inside `withOrg`, zero to `withSystem()`,
 * `drain()` returning `{delivered: 0, failed: 0}`. That is a bug in the events
 * slice, not in this one, and it is reported rather than worked around in
 * `dispatcher.ts`; claiming per org here would hide it. Once the claim is fixed
 * this function becomes `await drainOutbox(dispatcher)`.
 */
async function publish<TName extends EventName>(
  orgId: string,
  name: TName,
  payload: Parameters<typeof emit<TName>>[2],
): Promise<void> {
  await withOrg({ orgId, userId: 'usr_realtime_test' }, async (tx) => {
    await emit(tx, name, payload, { orgId });
  });

  const rows = await withOrg({ orgId, userId: 'usr_realtime_test' }, async (tx) => {
    const pending = await tx.execute<{
      id: string;
      org_id: string;
      name: string;
      payload: unknown;
      rooms: string[];
      attempts: number;
    }>(sql`
      select id, org_id, name, payload, rooms, attempts
      from events.outbox
      where dispatched_at is null
      order by created_at
    `);
    return [...pending];
  });

  for (const row of rows) {
    const event: DeliveredEvent = {
      id: row.id,
      orgId: row.org_id,
      name: row.name,
      payload: row.payload,
      rooms: row.rooms,
      attempts: row.attempts,
    };
    for (const subscriber of dispatcher.bridged.get(row.name) ?? []) await subscriber(event);
    await withOrg({ orgId, userId: 'usr_realtime_test' }, async (tx) => {
      await markDispatched(tx, row.id);
    });
  }
}

function walletPayload(branchId: string | null, balance: string) {
  return { accountId: randomUUID(), branchId, balancePoisha: balance };
}

describe('realtime gateway /rt — rooms are server-assigned (§19, M04 check 3)', () => {
  it('joins exactly the rooms the caller is entitled to, and no others', async () => {
    const connected = await connect(accountsA);

    // `roomsForContext` and nothing else. An `accounts` member with no branch
    // scope is in their personal room and their role room — not `super`, not
    // another role's room, not a branch room.
    expect([...connected.rooms].sort()).toEqual(
      [userRoom(accountsA.userId), roleRoom(ORG_A, 'accounts')].sort(),
    );
  });

  it('delivers an event to its role room in its own org', async () => {
    const watcher = await connect(accountsA);

    await publish(ORG_A, 'wallet.balance_changed', walletPayload(null, '125000'));

    const payload = await watcher.recorder.waitFor('wallet.balance_changed');
    expect(payload).toMatchObject({ balancePoisha: '125000' });
  });

  it('withholds an event from a role in the same org that is not in its audience', async () => {
    const sales = await connect(salesA);

    // `job.failed` goes to org_admin and super; `wallet.balance_changed` to
    // accounts. Neither is addressed to sales.
    await publish(ORG_A, 'job.failed', { queue: 'delivery.book_parcel', ref: null, code: 'E_RT' });
    await publish(ORG_A, 'wallet.balance_changed', walletPayload(null, '1'));
    // The barrier: sales's own personal room, which it certainly is in.
    await publish(ORG_A, 'approval.decided', {
      id: randomUUID(),
      decision: 'approved',
      requestedBy: salesA.userId,
    });

    await sales.recorder.waitFor('approval.decided');
    expect(sales.recorder.names()).not.toContain('job.failed');
    expect(sales.recorder.names()).not.toContain('wallet.balance_changed');
  });

  it('a client from another org receives nothing', async () => {
    const other = await connect(accountsB);

    await publish(ORG_A, 'wallet.balance_changed', walletPayload(null, '999999'));
    // Same event, same role room name shape, different tenant — the barrier and
    // the proof that the socket is working at all.
    await publish(ORG_B, 'wallet.balance_changed', walletPayload(null, '4242'));

    await other.recorder.waitFor('wallet.balance_changed');
    const balances = other.recorder
      .payloadsOf('wallet.balance_changed')
      .map((payload) => (payload as { balancePoisha: string }).balancePoisha);

    expect(balances).toEqual(['4242']);
    expect(balances).not.toContain('999999');
  });

  it('scopes a branch room to the branches the membership names', async () => {
    const scoped = await connect(branchSalesA);
    expect([...scoped.rooms].sort()).toEqual(
      [userRoom(branchSalesA.userId), roleRoom(ORG_A, 'sales'), `org:${ORG_A}:branch:${branchOne}`]
        .slice()
        .sort(),
    );

    // Reaches this socket only through the branch room: `wallet.balance_changed`
    // is addressed to accounts, and this membership is sales.
    await publish(ORG_A, 'wallet.balance_changed', walletPayload(branchOne, '100'));
    await publish(ORG_A, 'wallet.balance_changed', walletPayload(branchTwo, '200'));
    await publish(ORG_A, 'approval.decided', {
      id: randomUUID(),
      decision: 'rejected',
      requestedBy: branchSalesA.userId,
    });

    await scoped.recorder.waitFor('approval.decided');
    const balances = scoped.recorder
      .payloadsOf('wallet.balance_changed')
      .map((payload) => (payload as { balancePoisha: string }).balancePoisha);

    expect(balances).toEqual(['100']);
  });
});

describe('realtime gateway /rt — clients cannot join rooms (§19)', () => {
  it('refuses a join attempt with an error rather than ignoring it', async () => {
    const other = await connect(accountsB);

    const ack = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('the join attempt was neither acknowledged nor refused'));
      }, 10_000);
      other.socket.emit('join', { room: roleRoom(ORG_A, 'accounts') }, (response: unknown) => {
        clearTimeout(timer);
        resolve(response);
      });
    });

    expect(ack).toMatchObject({ error: { code: RT_CODES.clientEmitRefused } });
    const errors = await other.recorder.waitFor(RT_ERROR);
    expect(errors).toMatchObject({ code: RT_CODES.clientEmitRefused, event: 'join' });
  });

  it('refuses every inbound name, not a list of guessed ones', async () => {
    const other = await connect(accountsB);

    // The point of the inverted rule: `subscribe` was never named anywhere, and
    // is refused for the same reason `join` is.
    for (const name of ['subscribe', 'rooms', 'watch:org', 'enter']) {
      other.socket.emit(name, { room: roleRoom(ORG_A, 'accounts') });
    }

    await other.recorder.waitFor(RT_ERROR, 4);
    expect(other.recorder.payloadsOf(RT_ERROR).map((p) => (p as { event: string }).event)).toEqual([
      'subscribe',
      'rooms',
      'watch:org',
      'enter',
    ]);
  });

  it('a refused join buys nothing: the other org stays invisible afterwards', async () => {
    const other = await connect(accountsB);

    other.socket.emit('join', { room: roleRoom(ORG_A, 'accounts') });
    await other.recorder.waitFor(RT_ERROR);

    await publish(ORG_A, 'wallet.balance_changed', walletPayload(null, '777777'));
    await publish(ORG_B, 'wallet.balance_changed', walletPayload(null, '8'));

    await other.recorder.waitFor('wallet.balance_changed');
    const balances = other.recorder
      .payloadsOf('wallet.balance_changed')
      .map((payload) => (payload as { balancePoisha: string }).balancePoisha);
    expect(balances).toEqual(['8']);
  });
});

describe('realtime gateway /rt — the handshake (§19, §25)', () => {
  it('refuses a connection with no session cookie', async () => {
    const refused = await refusedHandshake({ origin: ORIGIN, host: APP_DOMAIN });
    expect(refused.code).toBe(RT_CODES.unauthenticated);
  });

  it('refuses a connection from an untrusted origin', async () => {
    /*
     * The cross-site WebSocket hijacking case, and the reason the gateway checks
     * `Origin` itself: a WebSocket upgrade is not subject to the same-origin
     * policy, so without this check an attacker's page could hold an
     * authenticated `/rt` socket and read the victim's entire event stream. The
     * cookie here is a valid one — that is the whole point.
     */
    const refused = await refusedHandshake({
      cookie: accountsA.client.cookieHeader(),
      origin: 'https://attacker.example',
      host: APP_DOMAIN,
    });
    expect(refused.code).toBe(RT_CODES.originUntrusted);
  });
});

describe('realtime gateway /rt — delivery discipline (§19, invariant 5)', () => {
  it('refuses to broadcast a payload the catalog does not accept', () => {
    // §19 allows ids plus the display fields every recipient role may see, and
    // the schemas are `.strict()` so that an unplanned field is an error rather
    // than a leak. There is no `serializeFor()` in front of a socket.
    expect(() => {
      gateway.deliver({
        orgId: ORG_A,
        name: 'ledger.posted',
        payload: {
          journalId: randomUUID(),
          sourceType: 'cash_in',
          businessDate: '2026-09-25',
          unitCostPoisha: '9900',
        },
        rooms: [roleRoom(ORG_A, 'accounts')],
      });
    }).toThrow(/invalid payload/i);
  });

  it('refuses a row addressed to another org, whatever the row says', () => {
    expect(() => {
      gateway.deliver({
        orgId: ORG_B,
        name: 'ledger.posted',
        payload: { journalId: randomUUID(), sourceType: 'cash_in', businessDate: '2026-09-25' },
        rooms: [roleRoom(ORG_A, 'accounts')],
      });
    }).toThrow(/belongs to another org/);
  });

  it('throttles a reading to one per window per thing observed, keeping the last value', async () => {
    /*
     * §19: "throttle high-frequency events to at most one per second per key".
     *
     * Five readings of one account inside one window leave two frames: the first,
     * immediately, and the *last*, when the window closes. Keeping the last is
     * the part worth asserting — a leading-edge throttle that dropped the tail
     * would leave the first number on screen with nothing scheduled to correct
     * it, which for a cash position is worse than a slow update.
     */
    const watcher = await connect(accountsA);
    const accountId = randomUUID();

    for (const balance of ['1000', '2000', '3000', '4000', '5000']) {
      worker.deliver({
        orgId: ORG_A,
        name: 'wallet.balance_changed',
        payload: { accountId, branchId: null, balancePoisha: balance },
        rooms: [roleRoom(ORG_A, 'accounts')],
      });
    }

    await watcher.recorder.waitFor('wallet.balance_changed', 2);
    // A third would mean the window closed early; the wait above already proves
    // a second one arrived, so this is the "no more than one per window" half.
    await new Promise((resolve) => setTimeout(resolve, THROTTLE_WINDOW_MS * 2));

    const balances = watcher.recorder
      .payloadsOf('wallet.balance_changed')
      .filter((payload) => (payload as { accountId: string }).accountId === accountId)
      .map((payload) => (payload as { balancePoisha: string }).balancePoisha);

    expect(balances).toEqual(['1000', '5000']);
  });

  it('reaches a socket held by a different instance, through the Valkey adapter', async () => {
    /*
     * §19 requires the adapter "so it works across multiple instances", and
     * without it the failure is load-dependent rather than absent: §3 runs
     * replicas, the dispatcher hands each row to exactly one of them, and a
     * single-process gateway would deliver a fraction of events to any given
     * browser. So the event is published from the instance that does *not* hold
     * the socket.
     */
    const watcher = await connect(accountsA);
    const marker = '31415926';

    worker.deliver({
      orgId: ORG_A,
      name: 'wallet.balance_changed',
      payload: walletPayload(null, marker),
      rooms: [roleRoom(ORG_A, 'accounts')],
    });

    const payload = await watcher.recorder.waitFor('wallet.balance_changed');
    expect(payload).toMatchObject({ balancePoisha: marker });
  });
});

describe('realtime gateway /rt — a live socket keeps being re-authorized (§6, §19)', () => {
  /*
   * A WebSocket is authorized once, at the handshake, and then lives for hours.
   * Every other authority check in this system is per-request on purpose:
   * `resolveIdentity` says a session outlives a membership change and rebuilding
   * the context each time is the only place that notices. A socket skipped that
   * entirely, so revoking a membership, deactivating a user or signing out left
   * the event stream flowing, and a demoted `branch_manager` kept the manager's
   * rooms until the tab closed.
   *
   * These drive the revalidation directly rather than waiting out the 30-second
   * interval: a test that sleeps for half a minute is a test nobody runs, and
   * the interval length is configuration while the behaviour is the control.
   */
  it('drops a socket whose session has gone', async () => {
    const actor = await harness.asRole('accounts', ORG_A);
    const connected = await connect(actor);

    // Delete the session the socket was opened with. This is what a sign-out,
    // a revocation and an admin deactivation all look like from here.
    await withGlobal(async (tx) => {
      await tx.execute(sql`delete from iam.sessions where user_id = ${actor.userId}`);
    });

    const closed = new Promise<void>((resolve) => {
      connected.socket.on('disconnect', () => {
        resolve();
      });
    });

    await gateway.revalidateNow();
    await closed;

    expect(connected.socket.connected).toBe(false);
  });

  it('keeps a socket whose session is still good', async () => {
    // The positive control. Without it the assertion above passes on a gateway
    // that drops every socket on every tick.
    const actor = await harness.asRole('accounts', ORG_A);
    const connected = await connect(actor);

    await gateway.revalidateNow();
    await pause(200);

    expect(connected.socket.connected).toBe(true);
  });

  it('moves a socket out of a room the caller has lost', async () => {
    /*
     * The case that argues against simply disconnecting on any change: a role
     * change is an ordinary event and should not cost the user their connection,
     * but it must cost them the room.
     */
    const actor = await harness.asRole('accounts', ORG_A);
    const connected = await connect(actor);
    expect(connected.rooms).toContain(roleRoom(ORG_A, 'accounts'));

    await withGlobal(async (tx) => {
      await tx.execute(sql`
        update iam.memberships set role = 'marketing'
        where user_id = ${actor.userId} and org_id = ${ORG_A}
      `);
    });

    await gateway.revalidateNow();
    await pause(300);

    // Still connected, and no longer receiving what accounts receives.
    expect(connected.socket.connected).toBe(true);

    const seen: string[] = [];
    connected.socket.onAny((event: string) => seen.push(event));

    await withOrg({ orgId: ORG_A, userId: actor.userId }, async (tx) => {
      await emit(
        tx,
        'ledger.posted',
        { journalId: randomUUID(), sourceType: 'probe', businessDate: '2026-09-25' },
        { orgId: ORG_A },
      );
    });
    await dispatcher.drain();
    await pause(300);

    expect(seen, 'the socket still received an accounts-room event').toEqual([]);
  });
});
