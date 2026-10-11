import { OWNER_ACK_HEADER } from '@elysium/contracts';
import { en } from '@elysium/i18n/locales/sections/workflow.en';
import { describe, expect, it } from 'vitest';

import {
  actKey,
  addToHandover,
  beatFor,
  callBackIsDue,
  localInputToIso,
  offerShareLeft,
  secondsLeft,
} from './workflow-logic.js';
import { OWNER_ACK, ackHeaders } from './owner-ack.js';

/** M41's console logic: the heartbeat, the offer countdown, call-backs and the hand-over list. */

const NOW = Date.parse('2026-10-11T10:00:00.000Z');

describe('the owner acknowledgement', () => {
  it('is the contract’s header, sent only after go ahead', () => {
    expect(OWNER_ACK).toBe(OWNER_ACK_HEADER);
    expect(ackHeaders(true)).toEqual({ [OWNER_ACK_HEADER]: '1' });
    expect(ackHeaders(false)).toBeUndefined();
    expect(ackHeaders(undefined)).toBeUndefined();
  });
});

describe('the heartbeat', () => {
  it('reports only whether this tab is visible and the seconds since its last input', () => {
    expect(beatFor({ visible: true, lastInputMs: NOW - 4_500, nowMs: NOW })).toEqual({
      visible: true,
      idleSeconds: 4,
    });
    expect(beatFor({ visible: false, lastInputMs: NOW + 9_000, nowMs: NOW })).toEqual({
      visible: false,
      idleSeconds: 0,
    });
    expect(beatFor({ visible: true, lastInputMs: 0, nowMs: NOW }).idleSeconds).toBe(86_400);
  });
});

describe('the offer countdown', () => {
  it('counts whole seconds down to zero and the bar from full to empty', () => {
    const offered = new Date(NOW - 15_000).toISOString();
    const expires = new Date(NOW + 30_000).toISOString();
    expect(secondsLeft(expires, NOW)).toBe(30);
    expect(secondsLeft(expires, NOW + 29_100)).toBe(1);
    expect(secondsLeft(expires, NOW + 60_000)).toBe(0);
    expect(offerShareLeft(offered, expires, NOW)).toBeCloseTo(2 / 3);
    expect(offerShareLeft(offered, expires, NOW + 90_000)).toBe(0);
    expect(offerShareLeft(offered, offered, NOW)).toBe(0);
  });
});

describe('call-backs', () => {
  it('reads a datetime-local value and knows when a call-back is due', () => {
    expect(localInputToIso('')).toBeNull();
    expect(localInputToIso('not a time')).toBeNull();
    expect(localInputToIso('2026-10-11T16:30')).toMatch(/^2026-10-11T\d\d:30:00\.000Z$/);
    expect(callBackIsDue(new Date(NOW - 1).toISOString(), NOW)).toBe(true);
    expect(callBackIsDue(new Date(NOW + 60_000).toISOString(), NOW)).toBe(false);
  });
});

describe('what somebody did to your order', () => {
  it('has words for every act and a fallback for anything else', () => {
    for (const act of ['edit', 'confirm', 'hold', 'cancel', 'call', 'reassign', 'release']) {
      expect(en[actKey(act)]).not.toBe(en['wf.act.other']);
    }
    expect(actKey('something new')).toBe('wf.act.other');
    expect(actKey(42)).toBe('wf.act.other');
  });
});

describe('the courier hand-over list', () => {
  const packed = [
    { id: 'a', orderNo: 'ELY-2610-00001' },
    { id: 'b', orderNo: 'ELY-2610-00002' },
  ];

  it('adds a packed order once, matched on its number whatever the case', () => {
    const first = addToHandover([], ' ely-2610-00001 ', packed);
    expect(first).toMatchObject({ ok: true, added: { id: 'a' } });
    if (!first.ok) return;
    expect(addToHandover(first.list, 'ELY-2610-00001', packed)).toMatchObject({
      ok: false,
      reason: 'already',
    });
    expect(addToHandover(first.list, 'ELY-2610-00099', packed)).toMatchObject({
      ok: false,
      reason: 'not_packed',
    });
  });
});
