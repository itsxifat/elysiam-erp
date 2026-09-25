/**
 * At most one of a thing per second (architecture §19, "Throttle high-frequency
 * events to at most one per second per key").
 *
 * The rule exists because one of §19's events is not an announcement but a
 * reading: `stock.available_changed` fires on every reservation, and a flash
 * sale on one SKU can produce hundreds a second. A socket has no backpressure a
 * browser can apply, so an unthrottled reading turns one hot SKU into a render
 * loop on every open order desk.
 *
 * **Coalescing, not dropping.** The naive leading-edge throttle — pass the
 * first, discard the rest of the window — is wrong for a reading: the value
 * everyone needs is the *last* one, and discarding it leaves a stale number on
 * screen with nothing scheduled to correct it. So the first event in a window
 * goes out immediately and the newest arrival is held and flushed when the
 * window closes. The rate is still one per second per key; the difference is
 * that the number on screen is eventually right.
 *
 * Which events this applies to is data, below, rather than a caller's choice:
 * an emitter deciding its own throttling is an emitter that can turn it off.
 */

/**
 * The payload fields that identify what an event is a reading *of*.
 *
 * "Per key" in §19 means per thing observed, not per event type: throttling
 * `stock.available_changed` globally would make a thousand-SKU import deliver
 * one SKU's number per second and hide the other 999. The catalog marks exactly
 * one entry throttled, and this is that entry.
 *
 * It sits here rather than in `packages/contracts/src/events.ts` because the
 * event itself is not in the catalog yet — M07 raises it — and a schema for an
 * event nobody publishes is a guess. When M07 adds the schema, this moves into
 * the catalog entry beside it, unchanged; see the follow-up in progress.md.
 */
export const THROTTLED_EVENTS: Readonly<Record<string, readonly string[]>> = {
  'stock.available_changed': ['skuId', 'locationId'],
};

/** One event, resolved down to what actually goes on the wire. */
export interface ThrottledEmission {
  readonly name: string;
  readonly payload: unknown;
  readonly rooms: readonly string[];
}

export type EmitFn = (emission: ThrottledEmission) => void;

export interface ThrottleOptions {
  readonly windowMs?: number;
  /**
   * Which events to throttle, keyed by name. Overridden by the integration
   * suites so the coalescing path is exercised against a real socket with an
   * event that exists today, rather than only unit-tested.
   */
  readonly events?: Readonly<Record<string, readonly string[]>>;
  /** Injected so a test can drive the clock instead of sleeping through it. */
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

interface Window {
  /** When the current window closes. */
  readonly openedAt: number;
  /** The newest emission held back, if any. */
  pending: ThrottledEmission | undefined;
  timer: unknown;
}

/**
 * The throttle, as a small object the gateway owns.
 *
 * State is per process. That is correct rather than a compromise: the Valkey
 * adapter fans an emission out to every instance, so each instance throttles
 * the emissions *it* publishes, and an event published once is published once.
 * A shared counter in Valkey would add a round trip to the hot path to solve a
 * problem — two instances each emitting the same reading — that the outbox
 * already prevents by handing each row to exactly one dispatcher.
 */
export class EmissionThrottle {
  private readonly windows = new Map<string, Window>();
  private readonly windowMs: number;
  private readonly events: Readonly<Record<string, readonly string[]>>;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(options: ThrottleOptions = {}) {
    this.windowMs = options.windowMs ?? 1000;
    this.events = options.events ?? THROTTLED_EVENTS;
    this.now = options.now ?? (() => Date.now());
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        // Without this an idle process with one held emission keeps the event
        // loop alive for a second past `close()`, which in a test run is a
        // suite that will not exit.
        handle.unref?.();
        return handle;
      });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));
  }

  /**
   * Offer one emission. Calls `emit` now, later, or — if a newer reading of the
   * same thing arrives first — never for this particular payload.
   */
  offer(emission: ThrottledEmission, emit: EmitFn): void {
    const fields = this.events[emission.name];
    if (fields === undefined) {
      // Not a reading. An announcement is delivered the moment it happens;
      // delaying `approval.decided` by up to a second to save bandwidth would
      // be a worse trade than the bandwidth.
      emit(emission);
      return;
    }

    const key = throttleKey(emission, fields);
    const existing = this.windows.get(key);
    const at = this.now();

    if (existing === undefined) {
      this.open(key, at, emit);
      emit(emission);
      return;
    }

    // Replaced, not queued. Two readings of the same SKU inside one window are
    // two versions of one number, and the older one is simply wrong by the time
    // the window closes.
    existing.pending = emission;
  }

  /** Drop every window and any held emission. Call on shutdown. */
  close(): void {
    for (const window of this.windows.values()) {
      if (window.timer !== undefined) this.clearTimer(window.timer);
    }
    this.windows.clear();
  }

  private open(key: string, at: number, emit: EmitFn): void {
    const window: Window = { openedAt: at, pending: undefined, timer: undefined };
    this.windows.set(key, window);
    window.timer = this.setTimer(() => {
      this.flush(key, emit);
    }, this.windowMs);
  }

  private flush(key: string, emit: EmitFn): void {
    const window = this.windows.get(key);
    if (window === undefined) return;

    const held = window.pending;
    if (held === undefined) {
      // Quiet window. The key is forgotten so a SKU touched once an hour costs
      // nothing — an entry per SKU ever seen would be an unbounded leak in a
      // process that runs for weeks.
      this.windows.delete(key);
      return;
    }

    // Something was held, so the next second may be busy too: a fresh window
    // opens around the flush rather than after it, which is what keeps the rate
    // at one per second through a sustained burst instead of two.
    window.pending = undefined;
    window.timer = this.setTimer(() => {
      this.flush(key, emit);
    }, this.windowMs);
    emit(held);
  }
}

/**
 * The key one emission throttles against.
 *
 * The room is part of it. §19 sends `stock.available_changed` both to staff
 * roles and to Beownz resellers, and those are different audiences with
 * different windows; keying on the payload alone would let a staff emission
 * swallow the reseller one. A field the payload does not carry contributes
 * `?`, so a payload that changes shape degrades to coarser throttling rather
 * than to a key collision between two different SKUs.
 */
function throttleKey(emission: ThrottledEmission, fields: readonly string[]): string {
  const payload = (
    typeof emission.payload === 'object' && emission.payload !== null ? emission.payload : {}
  ) as Record<string, unknown>;

  const identity = fields.map((field) => identify(payload[field])).join('|');
  return `${emission.name}\u0000${[...emission.rooms].sort().join(',')}\u0000${identity}`;
}

/**
 * One field's contribution to a key.
 *
 * Ids and numbers are what a reading actually carries, so anything else is a
 * payload nobody planned for. It contributes `?` rather than `[object Object]`,
 * which would be the same string for every such payload and would therefore
 * throttle two different SKUs against one window.
 */
function identify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  return '?';
}
