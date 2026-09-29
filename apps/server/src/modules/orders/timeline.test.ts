import { describe, expect, it } from 'vitest';

import { orderTimeline } from './timeline.js';

/**
 * The order detail's timeline (M11 Build list). The two properties that matter: nothing is
 * said twice, and it reads in the order things happened.
 */
describe('orderTimeline', () => {
  const history = [
    {
      id: 'e1',
      from: null,
      to: 'pending',
      trigger: 'create',
      reason: null,
      actorUserId: 'usr_a',
      occurredAt: '2026-09-28T10:00:00.000Z',
    },
    {
      id: 'e2',
      from: 'pending',
      to: 'confirmed',
      trigger: 'confirm',
      reason: null,
      actorUserId: 'usr_a',
      occurredAt: '2026-09-28T10:05:00.000Z',
    },
  ];
  const audited = [
    {
      id: 'a1',
      action: 'order.created',
      actor_user_id: 'usr_a',
      created_at: '2026-09-28 10:00:00.1+00',
    },
    {
      id: 'a2',
      action: 'order.claimed',
      actor_user_id: 'usr_b',
      created_at: '2026-09-28 10:02:00+00',
    },
    {
      id: 'a3',
      action: 'order.confirm',
      actor_user_id: 'usr_a',
      created_at: '2026-09-28 10:05:00+00',
    },
    {
      id: 'a4',
      action: 'courier.booking.queued',
      actor_user_id: 'usr_a',
      created_at: '2026-09-28 10:05:00+00',
    },
  ];

  it('drops the audit rows that restate a status change', () => {
    const entries = orderTimeline(history, audited);
    expect(entries.map((entry) => entry.id)).toEqual(['e1', 'a2', 'e2', 'a4']);
  });

  it('puts the status change first when an activity shares its instant', () => {
    const entries = orderTimeline(history, audited);
    expect(entries[2]?.kind).toBe('status');
    expect(entries[3]).toMatchObject({ kind: 'activity', action: 'courier.booking.queued' });
  });

  it('normalises the database’s timestamps to ISO 8601', () => {
    const activity = orderTimeline(history, audited).find((entry) => entry.id === 'a2');
    expect(activity?.at).toBe('2026-09-28T10:02:00.000Z');
  });
});
