import type { Server as HttpServer } from 'node:http';

import {
  parseEventPayload,
  roomsForContext,
  type EventName,
  type MembershipRole,
  type Room,
} from '@elysium/contracts';
import type { Logger } from 'pino';
import { Server, type DefaultEventsMap, type Namespace, type Socket } from 'socket.io';

import { isTrustedOrigin, type OriginPolicy } from '../http/origins.js';
import { resolveIdentity, type AuthPluginOptions } from '../http/auth-plugin.js';
import { attachValkeyAdapter, type AttachedAdapter } from './valkey-adapter.js';
import { EmissionThrottle, type ThrottleOptions } from './throttle.js';

/**
 * The realtime gateway at `/rt` (architecture §19).
 *
 * Three rules from §19 are enforced here and nowhere else, so this file is the
 * whole of the realtime trust boundary:
 *
 *   1. **The handshake authenticates with the session cookie**, through the same
 *      resolution the HTTP surface uses (`resolveIdentity`). A second copy would
 *      drift, and the copy that drifts is the one where a revoked membership
 *      keeps receiving another org's events.
 *   2. **The server assigns rooms.** `roomsForContext` is the only thing that
 *      puts a socket in a room, and a client that asks to join one is refused
 *      with an error rather than ignored — §19's rule only means something if
 *      trying is a failure a client author notices.
 *   3. **Payloads are validated before they leave.** A socket has no
 *      `serializeFor()` in front of it (invariant 5), so the `.strict()` schema
 *      in the event catalog is the only thing standing between a payload that
 *      grew a cost field and a reseller's browser.
 *
 * There is deliberately **no method here that an application service can call to
 * broadcast**. `.claude/rules` says realtime events go only through the outbox,
 * and the way to make that true rather than aspirational is to leave out the
 * shortcut: the only way in is `deliver()`, which the outbox dispatcher's bridge
 * calls after the originating transaction has committed.
 */

/** The namespace §19 names. The engine keeps its default `/socket.io` path. */
export const RT_NAMESPACE = '/rt';

/** Emitted to a socket the moment its rooms are assigned. */
export const RT_READY = 'rt:ready';
/** Emitted when the server refuses something the client did. */
export const RT_ERROR = 'rt:error';

/**
 * Stable codes a client can branch on.
 *
 * Not in `packages/contracts/src/errors.ts` because those are the codes an HTTP
 * problem+json body carries (§23); these travel in a socket error's `data`. See
 * the follow-up in progress.md if the two lists should be merged.
 */
export const RT_CODES = {
  unauthenticated: 'REALTIME_UNAUTHENTICATED',
  /** The handshake itself failed — retry, do not send the user to login. */
  unavailable: 'REALTIME_UNAVAILABLE',
  originUntrusted: 'REALTIME_ORIGIN_UNTRUSTED',
  enrolmentRequired: 'TWO_FACTOR_ENROLMENT_REQUIRED',
  clientEmitRefused: 'REALTIME_CLIENT_EMIT_REFUSED',
  /**
   * The session that opened this socket is no longer good enough to hold it.
   *
   * A distinct code from `unauthenticated`, because the client's correct
   * response differs: this one means "you were signed in and now you are not",
   * so reconnecting will fail the same way until the user signs in again.
   */
  revoked: 'REALTIME_SESSION_REVOKED',
} as const;

/** What the gateway hangs off each socket. Read by nothing else. */
export interface SocketContext {
  readonly userId: string;
  readonly orgId: string | null;
  readonly roles: readonly MembershipRole[];
  readonly isSuperAdmin: boolean;
  readonly rooms: readonly Room[];
  /**
   * The handshake's cookie, kept so the socket can be re-authorized.
   *
   * A WebSocket is authorized once, at the handshake, and then lives for hours.
   * Every other authority check in this system is deliberately per-request —
   * `resolveIdentity`'s own comment says the context is rebuilt every time
   * because "a session outlives a membership change, and this is the only place
   * that notices". A socket broke that: revoking a membership, deactivating a
   * user or signing out left the stream flowing, and a `branch_manager` demoted
   * to `sales` kept receiving the manager's rooms until they closed the tab.
   *
   * So the cookie is retained and the identity is re-resolved on an interval.
   * Holding it is not a new exposure — the socket already carries the session's
   * full authority, and the value never leaves this process.
   */
  readonly cookie: string | undefined;
}

/**
 * How often a live socket's authority is re-checked.
 *
 * Thirty seconds is the trade: a revoked membership stops receiving events
 * within half a minute, and the cost is one session lookup per socket per
 * interval. Matching the HTTP surface exactly — re-checking per event — would
 * mean a database round trip per broadcast per recipient, which is the wrong
 * shape for a fan-out.
 */
const REVALIDATE_INTERVAL_MS = 30_000;

/**
 * Socket.IO's fourth generic, which is what makes `socket.data.context` typed.
 *
 * Spelled out rather than left at the default `any`, because the default is
 * where a typo in `socket.data.ctx` becomes `undefined` at runtime and the
 * room list silently comes out empty.
 */
export interface RealtimeSocketData {
  context: SocketContext;
}

export type RealtimeNamespace = Namespace<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  RealtimeSocketData
>;

type RealtimeSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  RealtimeSocketData
>;

/** One event as the outbox stored it, which is what the bridge hands over. */
export interface DeliverableEvent {
  readonly id?: string;
  readonly orgId: string;
  readonly name: string;
  readonly payload: unknown;
  readonly rooms: readonly string[];
}

/** What either end of the gateway needs: a log, a broker and the throttle. */
export interface RealtimeEmitterOptions {
  readonly logger: Logger;
  /** Omit to run single-process — see the warning in `attachAdapter`. */
  readonly valkey?: { readonly url: string; readonly key: string };
  readonly throttle?: ThrottleOptions;
}

export interface RealtimeGatewayOptions extends RealtimeEmitterOptions, OriginPolicy {
  readonly auth: AuthPluginOptions['auth'];
}

export interface RealtimeGateway {
  readonly namespace: RealtimeNamespace;
  /**
   * Broadcast one committed event to the rooms the outbox recorded for it.
   *
   * Throws rather than returning false on a payload or a room the rules refuse,
   * so the dispatcher records the failure, retries and eventually dead-letters
   * it. A realtime delivery that swallowed its own errors would be a class of
   * bug nobody ever sees: the browser simply does not update.
   */
  deliver(event: DeliverableEvent): void;
  /** For tests and for `/health/ready`: how many sockets this instance holds. */
  connectionCount(): Promise<number>;
  /**
   * Re-check every connected socket's authority now, instead of on the interval.
   *
   * For tests, and for an operator who has just revoked something and does not
   * want to wait out the window. A test that slept for the real interval would
   * be a test nobody runs, and the interval is configuration while the
   * behaviour is the thing worth asserting.
   */
  revalidateNow(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The socket-serving half: this is the process browsers connect to.
 *
 * It does not deliver anything itself. The outbox dispatch loop runs in the
 * worker (§3 has api and worker as separate processes), so the worker holds the
 * emit-only half below and its broadcasts arrive here through Valkey. That is
 * not a workaround for the split — it is the reason §19 requires the adapter.
 */
export function createRealtimeGateway(
  httpServer: HttpServer,
  options: RealtimeGatewayOptions,
): RealtimeGateway {
  const io = new Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, RealtimeSocketData>(
    httpServer,
    {
      /*
       * CORS for the handshake, on the same enumerated list as everything else.
       *
       * The polling transport is a real cross-origin XHR with cookies, so without
       * this the console's very first handshake fails. `credentials` must be true
       * for the same reason it is on the HTTP surface: without it the browser
       * never sends the session cookie and every handshake looks anonymous.
       */
      cors: {
        origin: (origin, callback) => {
          if (origin === undefined) {
            callback(null, true);
            return;
          }
          callback(null, isTrustedOrigin(origin, options));
        },
        credentials: true,
      },
      // Anything larger than this is not an event we send; it is someone probing
      // for a way to make the process allocate.
      maxHttpBufferSize: 64 * 1024,
    },
  );

  const adapter = attachAdapter(io, options);
  const namespace = io.of(RT_NAMESPACE);

  /*
   * The handshake (§19).
   *
   * Origin first, and not as belt-and-braces: a WebSocket upgrade is **not**
   * subject to the same-origin policy, so `new WebSocket('wss://api/…')` from
   * any page carries the victim's cookies and the browser will not stop it. The
   * `cors` option above only covers the polling transport. Checking the Origin
   * header here is what closes cross-site WebSocket hijacking — an attacker page
   * that could hold an authenticated `/rt` socket would receive that user's
   * whole event stream.
   */
  namespace.use((socket, next) => {
    const origin = socket.handshake.headers.origin;
    if (origin !== undefined && !isTrustedOrigin(origin, options)) {
      next(refusal(RT_CODES.originUntrusted, 'This origin may not open a realtime connection.'));
      return;
    }

    void authenticate(socket, options)
      .then((result) => {
        if (result.error !== undefined) {
          next(result.error);
          return;
        }
        next();
      })
      .catch((error: unknown) => {
        /*
         * A distinct code, because the client's correct response differs.
         *
         * `unauthenticated` tells the console to send the user to the login
         * screen. A database hiccup while resolving the session is not that, and
         * reporting it as that would log people out during a blip. This says
         * "retry later" instead.
         */
        options.logger.error({ err: error }, 'realtime handshake failed');
        next(refusal(RT_CODES.unavailable, 'The realtime handshake could not be completed.'));
      });
  });

  namespace.on('connection', (socket) => {
    const context = socket.data.context;
    options.logger.debug(
      { userId: context.userId, orgId: context.orgId, rooms: context.rooms.length },
      'realtime socket connected',
    );

    socket.emit(RT_READY, { rooms: context.rooms });

    /*
     * Re-check this socket's authority for as long as it lives.
     *
     * The handshake is the only authorization a WebSocket gets by default, and
     * this connection outlives a membership change, a demotion and a sign-out.
     * Cleared on disconnect — an interval left behind would keep resolving a
     * session for a socket that has gone, once per socket, for the life of the
     * process.
     */
    const stopRevalidation = startRevalidation(socket, options);
    socket.on('disconnect', () => {
      stopRevalidation();
    });

    /*
     * Every inbound event is refused (§19).
     *
     * A client cannot call `socket.join` — that is server-side only — so "a
     * client asks to join a room" in practice means it emits something named
     * `join`, or `subscribe`, or whatever its author chose. An allow-list of
     * refused names would therefore miss the next name somebody invents, so the
     * rule is inverted: `/rt` is server-to-client, and *anything* a client emits
     * is an error. §19 already says clients refetch details over REST, where
     * authorization is enforced, so there is nothing legitimate to lose.
     *
     * Refused, not ignored, and both halves matter. The error goes back as an
     * `rt:error` frame and, when the client passed an acknowledgement callback,
     * through that callback too — a client that silently received nothing would
     * conclude the room was empty rather than that it had done something
     * forbidden.
     */
    socket.onAny((event: string, ...args: unknown[]) => {
      const detail = `The server assigns rooms; clients may not emit on ${RT_NAMESPACE}. Refused "${event}".`;
      options.logger.warn(
        { userId: context.userId, orgId: context.orgId, event },
        'realtime client emit refused',
      );

      const ack = args.at(-1);
      if (typeof ack === 'function') {
        (ack as (response: unknown) => void)({
          error: { code: RT_CODES.clientEmitRefused, detail },
        });
      }
      socket.emit(RT_ERROR, { code: RT_CODES.clientEmitRefused, event, detail });
    });
  });

  return buildGateway(io, namespace, adapter, options, { attached: true });
}

/**
 * The emit-only half: a Socket.IO server with nothing attached to it.
 *
 * This is what the worker holds. `new Server()` with no HTTP server accepts no
 * connections and needs no `auth` — it exists solely so `namespace.to(...).emit`
 * goes through the Valkey adapter and reaches the sockets the API processes are
 * holding. §19 puts delivery in the outbox dispatcher, the dispatch loop runs in
 * the worker, and the worker has no HTTP surface, so without this the bridge
 * would have nowhere to emit and every event would stop one step short of the
 * browser.
 *
 * `connectionCount()` therefore reports this process's own sockets, which is
 * always zero here — it is the count for `/health/ready` on the API, not a
 * cluster total.
 */
export function createRealtimeEmitter(options: RealtimeEmitterOptions): RealtimeGateway {
  const io = new Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, RealtimeSocketData>();
  const adapter = attachAdapter(io, options);
  const namespace = io.of(RT_NAMESPACE);
  return buildGateway(io, namespace, adapter, options, { attached: false });
}

/**
 * Put the Valkey adapter on the server, or say loudly that there is none.
 *
 * On the server rather than the namespace: `Server#adapter` is what
 * re-initializes each namespace's adapter, while `Namespace#adapter` is the live
 * instance. It is called before `io.of()` so the namespace is built once with
 * the right adapter instead of being re-initialized and discarding one.
 */
function attachAdapter(
  io: Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, RealtimeSocketData>,
  options: RealtimeEmitterOptions,
): AttachedAdapter | undefined {
  if (options.valkey === undefined) {
    /*
     * Single-process fan-out, and loudly so.
     *
     * §19 requires the adapter, and a missing one fails in the worst possible
     * way: everything works on one instance and delivers to a fraction of
     * clients behind a load balancer. For the worker's emitter it is worse still
     * — every broadcast goes nowhere at all. A warning at boot is the difference
     * between finding that in the log and finding it in a support ticket.
     */
    options.logger.warn(
      'realtime running without the Valkey adapter — broadcasts reach only this process',
    );
    return undefined;
  }

  return attachValkeyAdapter(io, {
    url: options.valkey.url,
    key: options.valkey.key,
    onError: (error) => {
      options.logger.error({ err: error }, 'realtime valkey adapter error');
    },
  });
}

/**
 * The delivery side, shared by both halves.
 *
 * One implementation on purpose: the payload check and the tenant check are the
 * realtime trust boundary, and the worker — which is the process that actually
 * delivers — must not get a weaker version of them than the API does.
 */
function buildGateway(
  io: Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, RealtimeSocketData>,
  namespace: RealtimeNamespace,
  adapter: AttachedAdapter | undefined,
  options: RealtimeEmitterOptions,
  shape: { readonly attached: boolean },
): RealtimeGateway {
  const throttle = new EmissionThrottle(options.throttle);

  return {
    namespace,

    async revalidateNow() {
      // `fetchSockets` rather than `namespace.sockets`, because with the Valkey
      // adapter the local map is this instance's share and the authority check
      // has to run where the socket lives — which is here, for each instance.
      const sockets = await namespace.local.fetchSockets();
      for (const remote of sockets) {
        const live = namespace.sockets.get(remote.id);
        if (live !== undefined && 'auth' in options) {
          await revalidate(live, options as RealtimeGatewayOptions);
        }
      }
    },

    deliver(event) {
      /*
       * Re-validated at delivery, against the same `.strict()` schema the emit
       * site used.
       *
       * It is not redundant. The row may have been written by an older build, or
       * by a future module that reached the table directly, and the schema is
       * the only guard §19's payload rule has on this side — there is no
       * `serializeFor()` between here and the browser. A payload that no longer
       * parses is refused and dead-lettered, which is the safe direction: a
       * stale dashboard is recoverable, a leaked cost figure is not.
       */
      const payload = parseEventPayload(event.name as EventName, event.payload);

      /*
       * Nothing addressed to another tenant, whatever the row says.
       *
       * `roomsForEvent` qualifies every org room with the event's own org, so
       * this can only fire if a row was written by something that bypassed it.
       * That is exactly the case worth catching: rooms are stored rather than
       * recomputed (see outbox.ts), so a bad row would otherwise be broadcast
       * verbatim for as long as it sat in the table.
       */
      for (const room of event.rooms) {
        if (room.startsWith('org:') && !room.startsWith(`org:${event.orgId}:`)) {
          throw new Error(
            `event ${event.name} in org ${event.orgId} is addressed to ${room}, which belongs to another org`,
          );
        }
      }

      if (event.rooms.length === 0) {
        // An event with no audience is a catalog bug, not a delivery failure:
        // failing it would dead-letter a row nobody was waiting for.
        options.logger.warn({ name: event.name }, 'realtime event has no rooms');
        return;
      }

      throttle.offer({ name: event.name, payload, rooms: event.rooms }, (emission) => {
        // `.to(rooms)` unions them and de-duplicates recipients, so a socket in
        // both `org:x:role:sales` and `org:x:role:accounts` receives one copy.
        namespace.to([...emission.rooms]).emit(emission.name, emission.payload);
      });
    },

    async connectionCount() {
      const sockets = await namespace.fetchSockets();
      return sockets.length;
    },

    async close() {
      throttle.close();

      /*
       * The sockets and the engine first, then Valkey: closing Valkey while
       * sockets are still attached makes the adapter log errors for broadcasts
       * it can no longer publish.
       *
       * `Server#close` is only safe on the attached half. It calls
       * `this.engine.close()` unconditionally, and `engine` is created by
       * `attach()` — so on the emit-only server it throws `Cannot read
       * properties of undefined (reading 'close')`, which is how this was found:
       * the suite's `afterAll` failed while every test passed. The emitter has no
       * engine and no listener, so closing it means closing the namespace's
       * adapter and nothing else.
       */
      if (shape.attached) await io.close();
      else await namespace.adapter.close();

      if (adapter !== undefined) await adapter.close();
    },
  };
}

/**
 * Authenticate one handshake and put the socket in its rooms.
 *
 * The rooms are joined here, inside the middleware, rather than in the
 * `connection` handler. That ordering is load-bearing: a broadcast that lands
 * between "connected" and "joined" would be missed, and the gap is wide enough
 * to matter because joining goes through the adapter.
 */
async function authenticate(
  socket: RealtimeSocket,
  options: RealtimeGatewayOptions,
): Promise<{ error?: Error }> {
  const identity = await resolveIdentity({
    auth: options.auth,
    cookie: socket.handshake.headers.cookie,
    requestId: socket.id,
  });

  if (identity.kind === 'anonymous') {
    return {
      error: refusal(RT_CODES.unauthenticated, 'A valid session cookie is required on /rt.'),
    };
  }

  if (identity.kind === 'enrolment_required') {
    // The same wall the HTTP surface puts up (§6). A privileged role with no
    // second factor holds a session and may do nothing with it — including
    // watch events go by.
    return {
      error: refusal(
        RT_CODES.enrolmentRequired,
        'This role requires a second factor before it can use the realtime gateway.',
      ),
    };
  }

  /*
   * A signed-in user with no active org still gets `user:{id}`.
   *
   * `roomsForContext` handles a null org by returning just the personal room,
   * and that is the behaviour we want: the org switcher is a screen the user
   * reaches while signed in, and a notification addressed to the person should
   * arrive there. What they must not get is a role or branch room, and with a
   * null org there is none to compute.
   */
  const context = identity.context;
  const rooms = roomsForContext({
    userId: identity.user.id,
    orgId: context?.orgId ?? null,
    roles: context?.roles ?? [],
    branchIds: context?.branchIds ?? [],
    isSuperAdmin: context?.isSuperAdmin ?? false,
  });

  const socketContext: SocketContext = {
    userId: identity.user.id,
    orgId: context?.orgId ?? null,
    roles: context?.roles ?? [],
    isSuperAdmin: context?.isSuperAdmin ?? false,
    rooms,
    cookie: socket.handshake.headers.cookie,
  };
  socket.data.context = socketContext;
  await socket.join([...rooms]);

  return {};
}

/**
 * Keep a live socket's authority current (§6, §19).
 *
 * The handshake authorizes once; this is what stops that being the only check.
 * Every other authority decision in this system is per-request, and
 * `resolveIdentity` says why in its own comment: a session outlives a membership
 * change, and rebuilding the context each time is the only place that notices.
 * A socket that skipped this kept streaming to a revoked membership, a
 * deactivated user and a signed-out tab, and kept a demoted `branch_manager` in
 * the manager's rooms until they closed the browser.
 *
 * Three outcomes, and the middle one is the reason this is not simply a
 * disconnect-on-change:
 *
 *  - the session is gone, or the enrolment wall now applies -> disconnect. The
 *    socket carries authority it no longer has.
 *  - the rooms changed -> leave what was removed, join what was added. A role
 *    change or an org switch is an ordinary thing that should not cost the user
 *    their connection.
 *  - nothing changed -> nothing happens, which is the common case and costs one
 *    session lookup.
 *
 * Returns a stop function so `connection` can clear the timer on disconnect; an
 * interval left behind would keep re-resolving a session for a socket that has
 * gone, once per socket, forever.
 */
export function startRevalidation(
  socket: RealtimeSocket,
  options: RealtimeGatewayOptions,
  intervalMs = REVALIDATE_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    void revalidate(socket, options).catch((error: unknown) => {
      /*
       * A failed re-check does not disconnect.
       *
       * A database blip would otherwise drop every socket in the installation at
       * once, and a reconnect storm is a worse outage than a few seconds of
       * stale authority. The next tick tries again.
       */
      options.logger.error({ err: error }, 'realtime revalidation failed');
    });
  }, intervalMs);

  // Node keeps the process alive for a pending timer; a gateway should not be
  // the reason the worker will not exit.
  timer.unref?.();

  return () => {
    clearInterval(timer);
  };
}

async function revalidate(socket: RealtimeSocket, options: RealtimeGatewayOptions): Promise<void> {
  const previous = socket.data.context;
  if (previous === undefined) return;

  const identity = await resolveIdentity({
    auth: options.auth,
    cookie: previous.cookie,
    requestId: socket.id,
  });

  if (identity.kind === 'anonymous' || identity.kind === 'enrolment_required') {
    const code = identity.kind === 'anonymous' ? RT_CODES.revoked : RT_CODES.enrolmentRequired;
    socket.emit(RT_ERROR, {
      code,
      detail: 'This session may no longer hold a realtime connection.',
    });
    socket.disconnect(true);
    return;
  }

  const context = identity.context;
  const rooms = roomsForContext({
    userId: identity.user.id,
    orgId: context?.orgId ?? null,
    roles: context?.roles ?? [],
    branchIds: context?.branchIds ?? [],
    isSuperAdmin: context?.isSuperAdmin ?? false,
  });

  const before = new Set(previous.rooms);
  const after = new Set(rooms);
  const gone = [...before].filter((room) => !after.has(room));
  const added = [...after].filter((room) => !before.has(room));

  if (gone.length === 0 && added.length === 0) return;

  // Leave first. If the process dies between the two, the socket is in fewer
  // rooms than it is entitled to, which loses an event; the other order leaves
  // it in a room it has lost the right to, which leaks one.
  for (const room of gone) await socket.leave(room);
  if (added.length > 0) await socket.join(added);

  socket.data.context = {
    userId: identity.user.id,
    orgId: context?.orgId ?? null,
    roles: context?.roles ?? [],
    isSuperAdmin: context?.isSuperAdmin ?? false,
    rooms,
    cookie: previous.cookie,
  };

  options.logger.debug(
    { userId: identity.user.id, gone, added },
    'realtime rooms re-resolved for a live socket',
  );
}

/** A handshake refusal the client can read a code off. */
function refusal(code: string, detail: string): Error {
  const error = new Error(detail);
  // Socket.IO forwards `err.data` to the client's `connect_error` handler;
  // `err.message` alone would leave a client matching on English prose.
  (error as Error & { data?: unknown }).data = { code };
  return error;
}
