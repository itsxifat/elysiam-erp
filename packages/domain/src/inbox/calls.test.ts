import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CALL_STATUSES,
  callAfter,
  callLength,
  isCallFinished,
  keptMediaKind,
  mediaExpired,
  needsCallBack,
  ringTargets,
  statusAfterTermination,
  voiceFormatFor,
  type CallAction,
  type CallStatus,
  type RingCandidate,
} from './index.js';

const NOW = new Date('2026-10-12T10:00:00.000Z');
const active = { lastSeenAt: NOW, lastActiveAt: NOW, paused: false };
const away = {
  lastSeenAt: new Date(NOW.getTime() - 10 * 60_000),
  lastActiveAt: null,
  paused: false,
};

function person(userId: string, overrides: Partial<RingCandidate> = {}): RingCandidate {
  return {
    userId,
    holdsInboxRole: true,
    workTypes: ['orders', 'messages'],
    presence: active,
    ...overrides,
  };
}

const ACTIONS: readonly CallAction[] = [
  'claim',
  'release',
  'connect',
  'decline',
  'hang_up',
  'time_out',
];

describe('a call’s life (D-784)', () => {
  it('rings, is claimed, connects and completes; Meta’s terminate keeps the outcome', () => {
    let status: CallStatus = 'ringing';
    status = callAfter(status, 'claim') ?? status;
    expect(status).toBe('answering');
    status = callAfter(status, 'connect') ?? status;
    expect(status).toBe('connected');
    expect(statusAfterTermination(status, { status: 'completed', durationSeconds: 95 })).toBe(
      'completed',
    );
    expect(statusAfterTermination(status, { status: 'failed', durationSeconds: 3 })).toBe('failed');
  });

  it('is missed when Meta ends it while it rings, and only then leaves a call-back item', () => {
    const missed = statusAfterTermination('ringing', {
      status: 'completed',
      durationSeconds: null,
    });
    expect(missed).toBe('missed');
    expect(needsCallBack(missed, 'inbound')).toBe(true);
    expect(needsCallBack('declined', 'inbound')).toBe(false);
    expect(needsCallBack('missed', 'outbound')).toBe(false);
    expect(needsCallBack('completed', 'inbound')).toBe(false);
  });

  it('only one claim wins: a claimed call cannot be claimed again', () => {
    expect(callAfter('answering', 'claim')).toBeNull();
    expect(callAfter('connected', 'claim')).toBeNull();
    // A browser that could not connect gives it back to everyone.
    expect(callAfter('answering', 'release')).toBe('ringing');
  });

  it('never moves a finished call, whatever arrives after', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CALL_STATUSES.filter(isCallFinished)),
        fc.constantFrom(...ACTIONS),
        fc.record({
          status: fc.constantFrom('completed' as const, 'failed' as const, null),
          durationSeconds: fc.option(fc.nat(7200), { nil: null }),
        }),
        (status, action, termination) => {
          expect(callAfter(status, action)).toBeNull();
          expect(statusAfterTermination(status, termination)).toBe(status);
        },
      ),
    );
  });

  it('always ends finished after Meta’s terminate, from any state', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CALL_STATUSES),
        fc.record({
          status: fc.constantFrom('completed' as const, 'failed' as const, null),
          durationSeconds: fc.option(fc.nat(7200), { nil: null }),
        }),
        (status, termination) => {
          expect(isCallFinished(statusAfterTermination(status, termination))).toBe(true);
        },
      ),
    );
  });

  it('formats a call’s length', () => {
    expect(callLength(null)).toBe('0:00');
    expect(callLength(5)).toBe('0:05');
    expect(callLength(125)).toBe('2:05');
  });
});

describe('who rings (D-785)', () => {
  it('rings only the owner when they are at their desk', () => {
    const candidates = [person('a'), person('owner'), person('b')];
    expect(ringTargets({ ownerUserId: 'owner', candidates, now: NOW })).toEqual(['owner']);
  });

  it('rings everyone active whose desk takes messages when nobody has it, or the owner is away', () => {
    const candidates = [
      person('c'),
      person('a'),
      person('orders-only', { workTypes: ['orders'] }),
      person('away', { presence: away }),
      person('paused', { presence: { ...active, paused: true } }),
      person('warehouse', { holdsInboxRole: false }),
      person('owner', { presence: away }),
    ];
    expect(ringTargets({ ownerUserId: null, candidates, now: NOW })).toEqual(['a', 'c']);
    expect(ringTargets({ ownerUserId: 'owner', candidates, now: NOW })).toEqual(['a', 'c']);
  });

  it('rings nobody when nobody can hear it', () => {
    expect(
      ringTargets({ ownerUserId: null, candidates: [person('x', { presence: away })], now: NOW }),
    ).toEqual([]);
  });
});

describe('voice and kept media (D-780 to D-783)', () => {
  it('sends Ogg/Opus voice notes to WhatsApp and M4A to Messenger and Instagram', () => {
    expect(voiceFormatFor('whatsapp')).toMatchObject({ mime: 'audio/ogg', voiceNote: true });
    expect(voiceFormatFor('messenger')).toMatchObject({ mime: 'audio/mp4', extension: 'm4a' });
    expect(voiceFormatFor('instagram')).toMatchObject({ mime: 'audio/mp4', voiceNote: false });
  });

  it('keeps audio and pictures, and nothing else', () => {
    expect(keptMediaKind('audio')).toBe('audio');
    expect(keptMediaKind('image')).toBe('image');
    for (const type of ['video', 'file', 'sticker', 'share', 'unsupported']) {
      expect(keptMediaKind(type)).toBeNull();
    }
  });

  it('expires kept media a year after the message', () => {
    const at = new Date('2025-10-01T00:00:00.000Z');
    expect(mediaExpired(at, new Date('2026-09-30T00:00:00.000Z'))).toBe(false);
    expect(mediaExpired(at, new Date('2026-10-02T00:00:00.000Z'))).toBe(true);
  });
});
