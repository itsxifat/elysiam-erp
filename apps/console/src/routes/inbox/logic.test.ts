import { describe, expect, it } from 'vitest';

import {
  displayPhone,
  districtsOf,
  failureKey,
  fill,
  inboxSearchSchema,
  isAckRequired,
  ownerToAcknowledge,
  parseTags,
  priceRange,
  stageTone,
  thanasOf,
} from './logic.js';

describe('the inbox screen’s rules (M42)', () => {
  it('reads the address bar, falling back on anything hand-edited', () => {
    expect(inboxSearchSchema.parse({})).toEqual({ view: 'all' });
    expect(
      inboxSearchSchema.parse({ view: 'mine', channel: 'whatsapp', stage: 'fraud', unread: true }),
    ).toMatchObject({
      view: 'mine',
      channel: 'whatsapp',
      stage: 'fraud',
      unread: true,
    });
    expect(
      inboxSearchSchema.parse({ view: 'everything', channel: 'sms', c: 'not-a-uuid' }),
    ).toEqual({
      view: 'all',
    });
  });

  it('asks to acknowledge only someone else’s conversation (D-737)', () => {
    expect(ownerToAcknowledge({ assignedTo: null }, 'usr_me')).toBeNull();
    expect(
      ownerToAcknowledge({ assignedTo: { userId: 'usr_me', name: 'Me' } }, 'usr_me'),
    ).toBeNull();
    expect(
      ownerToAcknowledge({ assignedTo: { userId: 'usr_b', name: 'Rahim' } }, 'usr_me'),
    ).toEqual({
      userId: 'usr_b',
      name: 'Rahim',
    });
    expect(isAckRequired({ status: 409, code: 'INBOX_OWNER_ACK_REQUIRED' })).toBe(true);
    expect(isAckRequired({ status: 409, code: 'INBOX_WINDOW_CLOSED' })).toBe(false);
    expect(isAckRequired(new Error('x'))).toBe(false);
  });

  it('parses tags as the server takes them', () => {
    expect(parseTags(' vip, eid ,VIP,, wholesale  buyer ')).toEqual([
      'vip',
      'eid',
      'wholesale buyer',
    ]);
    expect(parseTags('')).toEqual([]);
    expect(parseTags(Array.from({ length: 30 }, (_, n) => `t${String(n)}`).join(','))).toHaveLength(
      20,
    );
  });

  it('fills placeholders, shows phones the local way, and colours stages', () => {
    expect(fill('{name} has this', { name: 'Rahim' })).toBe('Rahim has this');
    expect(fill('{missing} stays', {})).toBe('{missing} stays');
    expect(displayPhone('+8801712345678')).toBe('01712-345678');
    expect(displayPhone('+16505551234')).toBe('+16505551234');
    expect(stageTone('fraud')).toBe('danger');
    expect(stageTone('customer')).toBe('success');
    expect(stageTone('visitor')).toBe('neutral');
  });

  it('names why a reply failed', () => {
    expect(failureKey('window_closed')).toEqual({ key: 'inbox.error.window_closed' });
    expect(failureKey('meta:190')).toEqual({ key: 'inbox.error.meta', code: '190' });
    expect(failureKey('meta_refused')).toEqual({ key: 'inbox.error.meta_refused' });
  });

  it('builds the district and thana pickers from the desk’s areas', () => {
    const areas = [
      { districtId: 2, districtEn: 'Gazipur', thanaId: 21, thanaEn: 'Tongi' },
      { districtId: 1, districtEn: 'Dhaka', thanaId: 12, thanaEn: 'Savar' },
      { districtId: 1, districtEn: 'Dhaka', thanaId: 11, thanaEn: 'Mirpur' },
    ];
    expect(districtsOf(areas)).toEqual([
      { id: 1, name: 'Dhaka' },
      { id: 2, name: 'Gazipur' },
    ]);
    expect(thanasOf(areas, 1).map((thana) => thana.name)).toEqual(['Mirpur', 'Savar']);
    expect(thanasOf(areas, null)).toEqual([]);
    expect(priceRange('120000', '120000')).toEqual({ min: '120000', max: null });
    expect(priceRange('120000', '150000')).toEqual({ min: '120000', max: '150000' });
    expect(priceRange(null, null)).toBeNull();
  });
});
