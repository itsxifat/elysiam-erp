import { describe, expect, it } from 'vitest';

import { eventRecomputeRange, rollupBucket } from './analytics.queues.js';

/** Which days an order event recomputes, and how a burst collapses into one job (D-320). */
describe('the event-driven rollup', () => {
  it('recomputes the event’s own Dhaka day, through today', () => {
    // 23:59:50 Dhaka on the 1st, dispatched at 00:00:10 on the 2nd.
    const range = eventRecomputeRange(
      new Date('2026-09-01T17:59:50Z'),
      new Date('2026-09-01T18:00:10Z'),
    );
    expect(range).toEqual({ from: '2026-09-01', to: '2026-09-02' });
    expect(
      eventRecomputeRange(new Date('2026-09-02T04:00:00Z'), new Date('2026-09-02T04:00:05Z')),
    ).toEqual({ from: '2026-09-02', to: '2026-09-02' });
  });

  it('never asks for more than one recompute may cover, after a long outage', () => {
    const range = eventRecomputeRange(
      new Date('2026-01-01T06:00:00Z'),
      new Date('2026-09-30T06:00:00Z'),
    );
    expect(range).toEqual({ from: '2026-07-01', to: '2026-09-30' });
  });

  it('keys a burst to one job per brand per ten seconds, started after the bucket', () => {
    const at = new Date('2026-09-01T06:00:03Z');
    const later = new Date('2026-09-01T06:00:09Z');
    expect(rollupBucket('org', at).singletonKey).toBe(rollupBucket('org', later).singletonKey);
    expect(rollupBucket('org', at).startAfter.getTime()).toBeGreaterThan(later.getTime());
  });
});
