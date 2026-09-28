import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

import { env } from '../env.js';

/**
 * The console's end of M04's `/rt` gateway (architecture §19).
 *
 * Four facts about that gateway shape everything here, and getting any of them
 * wrong produces a socket that connects and then quietly does nothing:
 *
 * 1. **The namespace is `/rt`**, on the engine's default `/socket.io` path. A
 *    client that connects to the default namespace joins no rooms and receives
 *    nothing at all — with no error, because connecting is not the failure.
 * 2. **The handshake authenticates with the session cookie**, so the connection
 *    needs `withCredentials`. Without it the browser omits the cookie on the
 *    polling handshake and the gateway refuses with `REALTIME_UNAUTHENTICATED`.
 * 3. **The client may not emit.** The gateway refuses *any* inbound event by
 *    design — rooms are assigned server-side — so there is no `subscribe` call
 *    here and nothing to add one to. A hook that offered `emit` would be
 *    offering an error.
 * 4. **Payloads carry ids, not rows.** §19 is explicit that clients refetch over
 *    REST, where authorization is enforced. So an event's job here is to
 *    invalidate a query, never to patch a cache with what arrived — patching
 *    would put a payload shaped for the widest audience into a screen that
 *    believes it is showing a serialized-for-this-role row.
 *
 * The hook returns connection status as well as wiring the handler, because a
 * screen whose liveness is silent teaches operators to distrust it: an approvals
 * inbox that has stopped receiving events looks exactly like an empty one.
 */

export type RealtimeStatus = 'connecting' | 'connected' | 'disconnected';

export interface RealtimeOptions {
  /** Event names to listen for, e.g. `['approval.requested']`. */
  readonly events: readonly string[];
  /**
   * What to do when one arrives. Called with the event name and its payload;
   * almost always this invalidates a query rather than reading the payload.
   */
  readonly onEvent: (name: string, payload: unknown) => void;
  /** Skip connecting entirely — e.g. no active org yet. */
  readonly enabled?: boolean;
}

export function useRealtime({ events, onEvent, enabled = true }: RealtimeOptions): RealtimeStatus {
  const [socketStatus, setSocketStatus] = useState<RealtimeStatus>('connecting');

  /*
   * The handler is held in a ref, and this is not an optimization.
   *
   * `onEvent` is nearly always an inline closure, so it is a new function every
   * render. In the effect's dependency list it would tear the socket down and
   * build a new one on every render — a reconnect loop that also re-runs the
   * gateway's handshake, session lookup and room assignment each time. The ref
   * keeps the socket's lifetime tied to what actually changes: whether we should
   * be connected, and to what.
   */
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  }, [onEvent]);

  // Joined, so a changed event list reconnects but an equal one re-rendered does
  // not. An array in the dependency list is a new reference every render.
  const eventKey = events.join(',');

  useEffect(() => {
    if (!enabled) return;

    const socket: Socket = io(`${env.VITE_API_URL}/rt`, {
      withCredentials: true,
      // WebSocket first, with polling as the fallback the handshake needs behind
      // proxies that do not upgrade. Both are CORS-checked by the gateway.
      transports: ['websocket', 'polling'],
      // Reconnect, but do not hammer: a gateway that is down because the API is
      // deploying should not be receiving a connection attempt per 100ms per
      // open console.
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 15_000,
    });

    socket.on('connect', () => setSocketStatus('connected'));
    socket.on('disconnect', () => setSocketStatus('disconnected'));
    socket.on('connect_error', () => setSocketStatus('disconnected'));

    for (const name of eventKey === '' ? [] : eventKey.split(',')) {
      socket.on(name, (payload: unknown) => handler.current(name, payload));
    }

    return () => {
      // `off` before `close`: a handler still attached during teardown can fire
      // for the disconnect itself and call into a component that has unmounted.
      socket.removeAllListeners();
      socket.close();
    };
  }, [enabled, eventKey]);

  /*
   * Derived rather than stored, so a disabled hook does not have to *write* its
   * status into state from inside the effect — a cascading render, and one React's
   * own lint rule objects to. The socket's own status is only meaningful while we
   * are meant to be connected.
   */
  return enabled ? socketStatus : 'disconnected';
}
