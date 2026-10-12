import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  fillSavedReply,
  insertAtSlash,
  matchSavedReplies,
  nationalPhone,
  nextContactName,
  profileDisplayName,
  profileHandle,
  profilePictureUrl,
  profileRefreshDue,
  PROFILE_REFRESH_MS,
  quickReplies,
  slashQueryAt,
  type SavedReplyLike,
} from './index.js';

const reply = (overrides: Partial<SavedReplyLike> & { shortcut: string }): SavedReplyLike => ({
  id: overrides.shortcut,
  title: overrides.title ?? overrides.shortcut,
  body: overrides.body ?? 'Hello',
  category: overrides.category ?? null,
  usageCount: overrides.usageCount ?? 0,
  ...overrides,
});

describe('fillSavedReply (D-763)', () => {
  it('fills every placeholder the conversation knows', () => {
    const filled = fillSavedReply(
      'Hi {name}, order {order_number} is {total}. We will call {phone}.',
      {
        name: 'Rahim',
        orderNumber: 'EL-1042',
        totalPoisha: '125000',
        phoneE164: '+8801712345678',
      },
    );
    expect(filled.text).toBe('Hi Rahim, order EL-1042 is Tk 1,250.00. We will call 01712345678.');
    expect(filled.missing).toEqual([]);
  });

  it('keeps Bangla text as typed and fills around it', () => {
    const filled = fillSavedReply('আসসালামু আলাইকুম {name}, আপনার অর্ডার {order_number}', {
      name: 'করিম',
      orderNumber: 'EL-7',
    });
    expect(filled.text).toBe('আসসালামু আলাইকুম করিম, আপনার অর্ডার EL-7');
  });

  it('leaves a placeholder with nothing to fill it, and says which, once', () => {
    const filled = fillSavedReply('{name} {total} {name} {order_number}', { name: '  ' });
    expect(filled.text).toBe('{name} {total} {name} {order_number}');
    expect(filled.missing).toEqual(['name', 'total', 'order_number']);
  });

  it('never touches braces that are not placeholders', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const body = text.replace(/\{(name|order_number|total|phone)\}/g, '');
        expect(fillSavedReply(body, { name: 'X', phoneE164: '+8801712345678' }).text).toBe(body);
      }),
    );
  });

  it('writes a phone back in the national form', () => {
    expect(nationalPhone('+8801812345678')).toBe('01812345678');
    expect(nationalPhone('+447700900123')).toBe('+447700900123');
  });
});

describe('the slash token at the caret', () => {
  it('finds `/` at the start or after a space, up to the caret', () => {
    expect(slashQueryAt('/thx', 4)).toEqual({ start: 0, query: 'thx' });
    expect(slashQueryAt('ok /pri', 7)).toEqual({ start: 3, query: 'pri' });
    expect(slashQueryAt('ok /', 4)).toEqual({ start: 3, query: '' });
    expect(slashQueryAt('/দাম', 4)).toEqual({ start: 0, query: 'দাম' });
  });

  it('is not a link, a date or a finished word', () => {
    expect(slashQueryAt('http://x', 8)).toBeNull();
    expect(slashQueryAt('12/10', 5)).toBeNull();
    expect(slashQueryAt('/thx done', 9)).toBeNull();
  });

  it('replaces the token and puts the caret after the insert', () => {
    const text = 'ok /pri later';
    const token = slashQueryAt(text, 7);
    expect(token).not.toBeNull();
    const next = insertAtSlash(text, token?.start ?? 0, 7, 'Price is Tk 990');
    expect(next).toEqual({ text: 'ok Price is Tk 990 later', caret: 18 });
  });
});

describe('matching saved replies', () => {
  const replies = [
    reply({ shortcut: 'price', title: 'Price list', usageCount: 2 }),
    reply({ shortcut: 'pr2', title: 'Pre-order', usageCount: 9 }),
    reply({ shortcut: 'thanks', title: 'Thank you', usageCount: 30 }),
    reply({ shortcut: 'size', title: 'Size chart', body: 'চেস্ট মাপ দিন', category: 'sizes' }),
  ];

  it('puts an exact shortcut first, then shortcut prefixes by use', () => {
    expect(matchSavedReplies(replies, 'price').map((r) => r.shortcut)).toEqual(['price']);
    expect(matchSavedReplies(replies, 'pr').map((r) => r.shortcut)).toEqual(['pr2', 'price']);
  });

  it('finds by title, category and body, Bangla included', () => {
    expect(matchSavedReplies(replies, 'chart').map((r) => r.shortcut)).toEqual(['size']);
    expect(matchSavedReplies(replies, 'মাপ').map((r) => r.shortcut)).toEqual(['size']);
    expect(matchSavedReplies(replies, 'nothing')).toEqual([]);
  });

  it('lists everything by use with nothing typed', () => {
    expect(matchSavedReplies(replies, '').map((r) => r.shortcut)).toEqual([
      'thanks',
      'pr2',
      'price',
      'size',
    ]);
  });

  it('offers the five most used as quick replies, never an unused one', () => {
    expect(quickReplies(replies).map((r) => r.shortcut)).toEqual(['thanks', 'pr2', 'price']);
  });
});

describe('profiles from Meta (D-761)', () => {
  const now = new Date('2026-10-12T10:00:00Z');

  it('asks when never asked, and again once the photo may have expired', () => {
    expect(profileRefreshDue(null, now)).toBe(true);
    expect(profileRefreshDue(new Date(now.getTime() - PROFILE_REFRESH_MS + 1000), now)).toBe(false);
    expect(profileRefreshDue(new Date(now.getTime() - PROFILE_REFRESH_MS), now)).toBe(true);
  });

  it('names a person from either API', () => {
    expect(profileDisplayName({ firstName: 'Peter', lastName: 'Chang' })).toBe('Peter Chang');
    expect(profileDisplayName({ name: 'রহিম  উদ্দিন', username: 'rahim' })).toBe('রহিম উদ্দিন');
    expect(profileDisplayName({ name: null, username: 'peter_chang_live' })).toBe(
      'peter_chang_live',
    );
    expect(profileDisplayName({})).toBeNull();
  });

  it('keeps only https photos and plain usernames', () => {
    expect(profilePictureUrl('https://scontent.xx.fbcdn.net/p.jpg')).toBe(
      'https://scontent.xx.fbcdn.net/p.jpg',
    );
    expect(profilePictureUrl('http://example.com/p.jpg')).toBeNull();
    expect(profilePictureUrl('javascript:alert(1)')).toBeNull();
    expect(profileHandle('peter.chang_live')).toBe('peter.chang_live');
    expect(profileHandle('<script>')).toBeNull();
  });

  it('follows Meta for a name nobody typed, and keeps one a person did', () => {
    expect(nextContactName(null, null, 'Peter Chang')).toBe('Peter Chang');
    expect(nextContactName('Peter', 'Peter', 'Peter Chang')).toBe('Peter Chang');
    expect(nextContactName('Mr Chang (VIP)', 'Peter', 'Peter Chang')).toBe('Mr Chang (VIP)');
    expect(nextContactName('Peter', 'Peter', null)).toBe('Peter');
  });
});
