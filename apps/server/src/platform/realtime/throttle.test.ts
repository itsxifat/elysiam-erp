import { describe, expect, it } from 'vitest';

import { EmissionThrottle, THROTTLED_EVENTS, type ThrottledEmission } from './throttle.js';

/**
 * The §19 throttle, on a clock the test owns.
 *
 * Driven by an injected timer rather than by `setTimeout` and a sleep, because
 * a throttle test that sleeps is a throttle test that fails on a loaded CI box
 * — and the failure reads as "the throttle dropped an event", which is the one
 * message that must be trustworthy here.
 */

/** A timer wheel: nothing fires until the test says so. */
function clock(): {
  readonly options: { setTimer: (fn: () => void, ms: number) => unknown; now: () => number };
  advance(): void;
  pending(): number;
} {
  let timers: (() => void)[] = [];
  return {
    options: {
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      now: () => 0,
    },
    advance() {
      const due = timers;
      timers = [];
      for (const fire of due) fire();
    },
    pending: () => timers.length,
  };
}

const READING = 'stock.available_changed';

function reading(skuId: string, available: number, room = 'org:a:role:sales'): ThrottledEmission {
  return { name: READING, payload: { skuId, locationId: 'loc-1', available }, rooms: [room] };
}

describe('EmissionThrottle', () => {
  it('passes an event that is not a reading straight through', () => {
    const time = clock();
    const throttle = new EmissionThrottle(time.options);
    const out: ThrottledEmission[] = [];

    for (let i = 0; i < 5; i += 1) {
      throttle.offer(
        { name: 'approval.decided', payload: { id: String(i) }, rooms: ['user:u1'] },
        (e) => out.push(e),
      );
    }

    // An announcement delayed to save bandwidth is a worse trade than the
    // bandwidth, so none of these is held back.
    expect(out).toHaveLength(5);
    expect(time.pending()).toBe(0);
  });

  it('emits the first reading immediately and coalesces the rest of the window', () => {
    const time = clock();
    const throttle = new EmissionThrottle(time.options);
    const out: ThrottledEmission[] = [];
    const emit = (e: ThrottledEmission): void => {
      out.push(e);
    };

    throttle.offer(reading('sku-1', 10), emit);
    throttle.offer(reading('sku-1', 9), emit);
    throttle.offer(reading('sku-1', 8), emit);

    expect(out).toHaveLength(1);
    expect(out[0]?.payload).toMatchObject({ available: 10 });

    time.advance();

    // The *last* reading, not the second. This is the property the naive
    // leading-edge throttle gets wrong: dropping the tail leaves 10 on screen
    // when the truth is 8, with nothing scheduled to correct it.
    expect(out).toHaveLength(2);
    expect(out[1]?.payload).toMatchObject({ available: 8 });
  });

  it('forgets a key after a quiet window rather than growing a map per SKU', () => {
    const time = clock();
    const throttle = new EmissionThrottle(time.options);
    const out: ThrottledEmission[] = [];
    const emit = (e: ThrottledEmission): void => {
      out.push(e);
    };

    throttle.offer(reading('sku-1', 10), emit);
    time.advance();
    expect(out).toHaveLength(1);
    // Nothing was held, so no follow-up window was opened: a SKU touched once
    // an hour must not cost a live timer for the life of the process.
    expect(time.pending()).toBe(0);

    // And the next reading of the same SKU is immediate again rather than held.
    throttle.offer(reading('sku-1', 11), emit);
    expect(out).toHaveLength(2);
  });

  it('opens a fresh window around a flush so a sustained burst stays at one per window', () => {
    const time = clock();
    const throttle = new EmissionThrottle(time.options);
    const out: ThrottledEmission[] = [];
    const emit = (e: ThrottledEmission): void => {
      out.push(e);
    };

    throttle.offer(reading('sku-1', 10), emit);
    throttle.offer(reading('sku-1', 9), emit);
    time.advance();
    // Still inside a window, because something was held: an implementation that
    // closed the window on flush would let the very next offer through and
    // deliver two in one window.
    throttle.offer(reading('sku-1', 8), emit);
    expect(out.map((e) => (e.payload as { available: number }).available)).toEqual([10, 9]);

    time.advance();
    expect(out.map((e) => (e.payload as { available: number }).available)).toEqual([10, 9, 8]);
  });

  it('throttles per thing observed, not per event type', () => {
    const time = clock();
    const throttle = new EmissionThrottle(time.options);
    const out: ThrottledEmission[] = [];
    const emit = (e: ThrottledEmission): void => {
      out.push(e);
    };

    // A thousand-SKU import must not deliver one SKU's number per second and
    // hide the other 999.
    throttle.offer(reading('sku-1', 1), emit);
    throttle.offer(reading('sku-2', 2), emit);
    throttle.offer(reading('sku-3', 3), emit);

    expect(out).toHaveLength(3);
  });

  it('keeps separate windows per room, so a staff emission cannot swallow a reseller one', () => {
    const time = clock();
    const throttle = new EmissionThrottle(time.options);
    const out: ThrottledEmission[] = [];
    const emit = (e: ThrottledEmission): void => {
      out.push(e);
    };

    throttle.offer(reading('sku-1', 5, 'org:a:role:sales'), emit);
    throttle.offer(reading('sku-1', 5, 'reseller:r1'), emit);

    expect(out).toHaveLength(2);
  });

  it('names the one catalog entry §19 marks throttled', () => {
    // A guard against the set quietly widening: every extra entry here is an
    // event somebody may see up to a second late.
    expect(Object.keys(THROTTLED_EVENTS)).toEqual(['stock.available_changed']);
  });
});
