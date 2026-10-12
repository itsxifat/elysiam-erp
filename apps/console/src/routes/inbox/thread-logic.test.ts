import { describe, expect, it } from 'vitest';

import { messageConcerns } from '../../alive/concerns.js';
import { parseSoundPrefs } from '../../alive/sound-prefs.js';
import { titleWithCount } from '../../alive/title.js';
import { mayPlay, MIN_GAP_MS, TONES } from '../../alive/tones.js';
import type { MessageView } from './api.js';
import {
  dayLabel,
  dhakaDay,
  hasBangla,
  placeholderValues,
  relativeTime,
  stepConversation,
  threadItems,
  utf8Length,
} from './thread-logic.js';

const message = (
  id: string,
  at: string,
  direction: 'inbound' | 'outbound' = 'inbound',
  sentBy: string | null = null,
): MessageView => ({
  id,
  direction,
  text: id,
  attachments: [],
  status: direction === 'inbound' ? 'received' : 'sent',
  sentBy: sentBy === null ? null : { userId: sentBy, name: sentBy },
  at,
  sentAt: null,
  deliveredAt: null,
  readAt: null,
  error: null,
});

// 2026-10-12 16:00 in Dhaka (UTC+6).
const NOW = new Date('2026-10-12T10:00:00Z').getTime();

describe('times in Dhaka (D-765)', () => {
  it('reads an instant as its Dhaka calendar day', () => {
    // 23:30 UTC on the 11th is 05:30 on the 12th in Dhaka.
    expect(dhakaDay('2026-10-11T23:30:00Z')).toBe('2026-10-12');
  });

  it('says how long ago, in words that move on', () => {
    expect(relativeTime('2026-10-12T09:59:40Z', NOW)).toEqual({ key: 'alive.time.now' });
    expect(relativeTime('2026-10-12T09:58:00Z', NOW)).toEqual({ key: 'alive.time.minutes', n: 2 });
    expect(relativeTime('2026-10-12T07:00:00Z', NOW)).toEqual({ key: 'alive.time.hours', n: 3 });
    expect(relativeTime('2026-10-11T12:00:00Z', NOW)).toEqual({ key: 'alive.day.yesterday' });
    expect(relativeTime('2026-10-08T12:00:00Z', NOW)).toEqual({ text: 'Thu' });
    expect(relativeTime('2026-09-01T12:00:00Z', NOW)).toEqual({ text: '1 Sept' });
    expect(relativeTime('2025-09-01T12:00:00Z', NOW)).toEqual({ text: '1 Sept 2025' });
  });

  it('labels days Today, Yesterday, then by date', () => {
    expect(dayLabel('2026-10-12', NOW)).toEqual({ key: 'alive.day.today' });
    expect(dayLabel('2026-10-11', NOW)).toEqual({ key: 'alive.day.yesterday' });
    expect(dayLabel('2026-10-10', NOW)).toEqual({ text: 'Sat 10 Oct' });
  });
});

describe('the thread as drawn', () => {
  it('separates days and groups consecutive messages from one side within five minutes', () => {
    const items = threadItems([
      message('a', '2026-10-11T10:00:00Z'),
      message('b', '2026-10-12T09:00:00Z'),
      message('c', '2026-10-12T09:03:00Z'),
      message('d', '2026-10-12T09:04:00Z', 'outbound', 'u1'),
      message('e', '2026-10-12T09:05:00Z', 'outbound', 'u2'),
      message('f', '2026-10-12T09:20:00Z', 'outbound', 'u2'),
    ]);
    expect(
      items.map((item) =>
        item.kind === 'day' ? item.day : item.messages.map((one) => one.id).join(''),
      ),
    ).toEqual(['2026-10-11', 'a', '2026-10-12', 'bc', 'd', 'e', 'f']);
  });
});

describe('moving between chats with j and k', () => {
  const ids = ['x', 'y', 'z'];
  it('steps forward and back, stopping at the ends', () => {
    expect(stepConversation(ids, null, 1)).toBe('x');
    expect(stepConversation(ids, 'x', 1)).toBe('y');
    expect(stepConversation(ids, 'z', 1)).toBe('z');
    expect(stepConversation(ids, 'x', -1)).toBe('x');
    expect(stepConversation([], 'x', 1)).toBeNull();
  });
});

describe('Bangla in messages', () => {
  it('is recognised for its font and counted in bytes for Instagram', () => {
    expect(hasBangla('দাম কত?')).toBe(true);
    expect(hasBangla('price?')).toBe(false);
    expect(utf8Length('দাম')).toBe(9);
    expect(utf8Length('abc')).toBe(3);
  });
});

describe('placeholders from the conversation', () => {
  it('prefers the customer’s name and the saved phone, and takes the latest order', () => {
    const values = placeholderValues(
      { contact: { id: 'c', name: 'FB name', stage: 'lead', avatarUrl: null, handle: null } },
      {
        contact: { phone: '+8801712345678' },
        customer: {
          name: 'Rahim',
          phone: '+8801812345678',
          recentOrders: [{ orderNo: 'EL-9', codAmountPoisha: '99000' }],
        },
      } as never,
    );
    expect(values).toEqual({
      name: 'Rahim',
      phoneE164: '+8801712345678',
      orderNumber: 'EL-9',
      totalPoisha: '99000',
    });
  });
});

describe('the live layer (D-766)', () => {
  it('rings for my conversation and for nobody’s when my desk takes messages, never for an echo', () => {
    const base = { conversationId: 'c1', channel: 'messenger' };
    expect(messageConcerns({ ...base, assignedTo: 'me' }, 'me', false)).not.toBeNull();
    expect(messageConcerns({ ...base, assignedTo: 'other' }, 'me', true)).toBeNull();
    expect(messageConcerns({ ...base, assignedTo: null }, 'me', true)).not.toBeNull();
    expect(messageConcerns({ ...base, assignedTo: null }, 'me', false)).toBeNull();
    expect(
      messageConcerns({ ...base, assignedTo: 'me', direction: 'outbound' }, 'me', true),
    ).toBeNull();
  });

  it('puts the unread count in front of the title, and takes it away', () => {
    expect(titleWithCount('Brand · Console', 3)).toBe('(3) Brand · Console');
    expect(titleWithCount('(3) Brand · Console', 0)).toBe('Brand · Console');
    expect(titleWithCount('(3) Brand · Console', 120)).toBe('(99+) Brand · Console');
  });

  it('reads stored sound settings leniently', () => {
    expect(parseSoundPrefs(null)).toEqual({ muted: false, volume: 'medium' });
    expect(parseSoundPrefs('{"muted":true,"volume":"high"}')).toEqual({
      muted: true,
      volume: 'high',
    });
    expect(parseSoundPrefs('{"volume":"deafening"}')).toEqual({ muted: false, volume: 'medium' });
    expect(parseSoundPrefs('not json')).toEqual({ muted: false, volume: 'medium' });
  });

  it('rings a burst once, and every tone is short', () => {
    expect(mayPlay('message', undefined, 1000)).toBe(true);
    expect(mayPlay('message', 1000, 1000 + MIN_GAP_MS.message - 1)).toBe(false);
    expect(mayPlay('message', 1000, 1000 + MIN_GAP_MS.message)).toBe(true);
    for (const notes of Object.values(TONES)) {
      const end = Math.max(...notes.map((note) => note.at + note.seconds));
      expect(end).toBeLessThan(1.2);
    }
  });
});
