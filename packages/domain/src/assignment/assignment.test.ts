import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  PRESENCE_AWAY_AFTER_MS,
  PRESENCE_IDLE_AFTER_MS,
  WORK_TYPES,
  defaultWorkTypes,
  ineligibility,
  lastActiveFrom,
  pickAssignee,
  presenceState,
  type AssignmentCandidate,
  type PresenceState,
  type WorkKind,
} from './index.js';

/**
 * M41 acceptance check 3's rule, as a pure function: auto-assign offers to the least-loaded
 * active person and never to an idle or away one (D-713, D-716).
 */

const NOW = new Date('2026-10-11T10:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function candidate(overrides: Partial<AssignmentCandidate> = {}): AssignmentCandidate {
  return {
    userId: 'usr_a',
    presence: 'active',
    paused: false,
    workTypes: WORK_TYPES,
    openLoad: 0,
    maxLoad: 25,
    lastOfferedAt: null,
    hasLiveOffer: false,
    ...overrides,
  };
}

describe('presenceState', () => {
  it('is away with no report, or none for longer than 90 seconds', () => {
    expect(presenceState({ lastSeenAt: null, lastActiveAt: null, paused: false }, NOW).state).toBe(
      'away',
    );
    expect(
      presenceState(
        { lastSeenAt: ago(PRESENCE_AWAY_AFTER_MS + 1), lastActiveAt: ago(1000), paused: false },
        NOW,
      ).state,
    ).toBe('away');
  });

  it('is active with input within two minutes, idle after', () => {
    const seen = ago(5_000);
    expect(
      presenceState(
        { lastSeenAt: seen, lastActiveAt: ago(PRESENCE_IDLE_AFTER_MS), paused: false },
        NOW,
      ),
    ).toEqual({ state: 'active', paused: false, available: true });
    expect(
      presenceState(
        { lastSeenAt: seen, lastActiveAt: ago(PRESENCE_IDLE_AFTER_MS + 1), paused: false },
        NOW,
      ).state,
    ).toBe('idle');
    expect(presenceState({ lastSeenAt: seen, lastActiveAt: null, paused: false }, NOW).state).toBe(
      'idle',
    );
  });

  it('keeps a paused person active but never available', () => {
    expect(
      presenceState({ lastSeenAt: ago(1_000), lastActiveAt: ago(1_000), paused: true }, NOW),
    ).toEqual({ state: 'active', paused: true, available: false });
  });
});

describe('lastActiveFrom', () => {
  it('ignores a hidden tab and never moves backwards or into the future', () => {
    const previous = ago(30_000);
    expect(lastActiveFrom({ previous, visible: false, idleSeconds: 0, now: NOW })).toBe(previous);
    expect(lastActiveFrom({ previous, visible: true, idleSeconds: 5, now: NOW })).toEqual(
      ago(5_000),
    );
    expect(lastActiveFrom({ previous, visible: true, idleSeconds: 600, now: NOW })).toBe(previous);
    expect(lastActiveFrom({ previous: null, visible: true, idleSeconds: -40, now: NOW })).toEqual(
      NOW,
    );
  });
});

describe('pickAssignee', () => {
  it('offers to the least loaded active person', () => {
    const picked = pickAssignee({
      kind: 'order',
      declinedBy: new Set(),
      candidates: [
        candidate({ userId: 'usr_a', openLoad: 3 }),
        candidate({ userId: 'usr_b', openLoad: 1 }),
        candidate({ userId: 'usr_c', openLoad: 2 }),
      ],
    });
    expect(picked).toBe('usr_b');
  });

  it('never offers to an idle, away, paused, over-cap, declined or busy person', () => {
    const declined = new Set(['usr_declined']);
    const blocked = [
      candidate({ userId: 'usr_idle', presence: 'idle' }),
      candidate({ userId: 'usr_away', presence: 'away' }),
      candidate({ userId: 'usr_paused', paused: true }),
      candidate({ userId: 'usr_full', openLoad: 25, maxLoad: 25 }),
      candidate({ userId: 'usr_declined' }),
      candidate({ userId: 'usr_busy', hasLiveOffer: true }),
      candidate({ userId: 'usr_messages', workTypes: ['messages'] }),
    ];
    expect(pickAssignee({ kind: 'order', candidates: blocked, declinedBy: declined })).toBeNull();
    expect(blocked.map((one) => ineligibility(one, 'order', declined))).toEqual([
      'not_active',
      'not_active',
      'paused',
      'at_capacity',
      'declined',
      'busy_with_offer',
      'no_work_type',
    ]);
    // The messages person is who a conversation goes to (M42).
    expect(pickAssignee({ kind: 'conversation', candidates: blocked, declinedBy: declined })).toBe(
      'usr_messages',
    );
  });

  it('breaks a tie by the longest wait since an offer, then by id', () => {
    expect(
      pickAssignee({
        kind: 'order',
        declinedBy: new Set(),
        candidates: [
          candidate({ userId: 'usr_a', lastOfferedAt: ago(10_000) }),
          candidate({ userId: 'usr_b', lastOfferedAt: ago(60_000) }),
        ],
      }),
    ).toBe('usr_b');
    expect(
      pickAssignee({
        kind: 'order',
        declinedBy: new Set(),
        candidates: [candidate({ userId: 'usr_z' }), candidate({ userId: 'usr_m' })],
      }),
    ).toBe('usr_m');
  });

  it('gives sales both work types by default and nobody else any', () => {
    expect(defaultWorkTypes(['sales'])).toEqual(['orders', 'messages']);
    expect(defaultWorkTypes(['warehouse'])).toEqual([]);
    expect(defaultWorkTypes(['org_admin'])).toEqual([]);
  });
});

// --- properties -------------------------------------------------------------------

const presenceArb = fc.constantFrom<PresenceState>('active', 'idle', 'away');
const kindArb = fc.constantFrom<WorkKind>('order', 'conversation');

const candidatesArb = fc
  .uniqueArray(fc.integer({ min: 0, max: 40 }), { minLength: 0, maxLength: 12 })
  .chain((ids) =>
    fc.tuple(
      ...ids.map((id) =>
        fc.record({
          userId: fc.constant(`usr_${String(id).padStart(2, '0')}`),
          presence: presenceArb,
          paused: fc.boolean(),
          workTypes: fc.subarray([...WORK_TYPES]),
          openLoad: fc.integer({ min: 0, max: 30 }),
          maxLoad: fc.integer({ min: 1, max: 30 }),
          lastOfferedAt: fc.option(
            fc.integer({ min: 0, max: 3_600_000 }).map((ms) => ago(ms)),
            { nil: null },
          ),
          hasLiveOffer: fc.boolean(),
        }),
      ),
    ),
  );

describe('pickAssignee, for any team', () => {
  it('picks only an eligible person, and the least loaded of them', () => {
    fc.assert(
      fc.property(
        candidatesArb,
        kindArb,
        fc.subarray([...Array.from({ length: 41 }, (_, i) => `usr_${String(i).padStart(2, '0')}`)]),
        (candidates, kind, declined) => {
          const declinedBy = new Set(declined);
          const picked = pickAssignee({ kind, candidates, declinedBy });
          const eligible = candidates.filter(
            (one) => ineligibility(one, kind, declinedBy) === null,
          );
          if (eligible.length === 0) {
            expect(picked).toBeNull();
            return;
          }
          const chosen = candidates.find((one) => one.userId === picked);
          expect(chosen).toBeDefined();
          if (chosen === undefined) return;
          // Never idle, away, paused, over the cap, declined or busy.
          expect(chosen.presence).toBe('active');
          expect(chosen.paused).toBe(false);
          expect(chosen.openLoad).toBeLessThan(chosen.maxLoad);
          expect(declinedBy.has(chosen.userId)).toBe(false);
          expect(chosen.hasLiveOffer).toBe(false);
          expect(chosen.workTypes).toContain(kind === 'order' ? 'orders' : 'messages');
          // The least loaded among the eligible.
          expect(chosen.openLoad).toBe(Math.min(...eligible.map((one) => one.openLoad)));
        },
      ),
      { numRuns: 500 },
    );
  });

  it('does not depend on the order the candidates were read in', () => {
    fc.assert(
      fc.property(candidatesArb, kindArb, (candidates, kind) => {
        const forward = pickAssignee({ kind, candidates, declinedBy: new Set() });
        const backward = pickAssignee({
          kind,
          candidates: [...candidates].reverse(),
          declinedBy: new Set(),
        });
        expect(backward).toBe(forward);
      }),
      { numRuns: 300 },
    );
  });

  it('spreads a run of accepted offers evenly: loads never differ by more than one', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 60 }),
        (people, orders) => {
          const loads = new Map<string, number>();
          const offeredAt = new Map<string, Date>();
          for (let i = 0; i < people; i += 1) loads.set(`usr_${String(i)}`, 0);
          for (let n = 0; n < orders; n += 1) {
            const picked = pickAssignee({
              kind: 'order',
              declinedBy: new Set(),
              candidates: [...loads.entries()].map(([userId, openLoad]) =>
                candidate({
                  userId,
                  openLoad,
                  maxLoad: 1_000,
                  lastOfferedAt: offeredAt.get(userId) ?? null,
                }),
              ),
            });
            expect(picked).not.toBeNull();
            if (picked === null) return;
            loads.set(picked, (loads.get(picked) ?? 0) + 1);
            offeredAt.set(picked, new Date(NOW.getTime() + n));
          }
          const values = [...loads.values()];
          expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });
});
