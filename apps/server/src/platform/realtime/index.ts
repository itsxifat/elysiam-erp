/**
 * The realtime gateway (architecture §19).
 *
 * One entry point, so the composition root and the test harness import the same
 * names and a later module cannot reach past `deliver()` into the Socket.IO
 * server. `.claude/rules` says realtime events go only through the outbox, and
 * not exporting a broadcast helper is how that stays true.
 */
export {
  createRealtimeEmitter,
  createRealtimeGateway,
  RT_CODES,
  RT_ERROR,
  RT_NAMESPACE,
  RT_READY,
  type DeliverableEvent,
  type RealtimeEmitterOptions,
  type RealtimeGateway,
  type RealtimeGatewayOptions,
  type RealtimeNamespace,
  type SocketContext,
} from './gateway.js';
export { bridgeOutboxToRealtime } from './bridge.js';
export {
  EmissionThrottle,
  THROTTLED_EVENTS,
  type ThrottleOptions,
  type ThrottledEmission,
} from './throttle.js';
