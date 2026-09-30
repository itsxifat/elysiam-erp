import { describe, expect, it } from 'vitest';

import {
  inQuietHours,
  nextSendTime,
  placeholdersOf,
  renderTemplate,
  smsSegments,
  TemplateError,
} from './index.js';

/** An instant given as Dhaka wall-clock time (UTC+6 all year). */
function dhaka(local: string): Date {
  return new Date(`${local}+06:00`);
}

describe('quiet hours, 21:00–09:00 Asia/Dhaka (M16 check 4)', () => {
  it('sends at once during the day', () => {
    const noon = dhaka('2026-10-01T12:00:00');
    expect(nextSendTime(noon, 'marketing')).toEqual(noon);
    expect(nextSendTime(noon, 'transactional')).toEqual(noon);
  });

  it('holds a late-evening message until 09:00 the next day', () => {
    expect(nextSendTime(dhaka('2026-10-01T22:30:00'), 'marketing')).toEqual(
      dhaka('2026-10-02T09:00:00'),
    );
  });

  it('holds an early-morning message until 09:00 the same day', () => {
    expect(nextSendTime(dhaka('2026-10-02T06:15:00'), 'transactional')).toEqual(
      dhaka('2026-10-02T09:00:00'),
    );
  });

  it('treats 21:00 as quiet and 09:00 as not', () => {
    expect(inQuietHours(dhaka('2026-10-01T21:00:00'))).toBe(true);
    expect(inQuietHours(dhaka('2026-10-01T20:59:59'))).toBe(false);
    expect(inQuietHours(dhaka('2026-10-02T09:00:00'))).toBe(false);
    expect(inQuietHours(dhaka('2026-10-02T08:59:59'))).toBe(true);
  });

  it('never holds a one-time code', () => {
    const midnight = dhaka('2026-10-02T00:30:00');
    expect(nextSendTime(midnight, 'otp')).toEqual(midnight);
  });

  it('crosses a month and a year end on the calendar', () => {
    expect(nextSendTime(dhaka('2026-12-31T23:00:00'), 'marketing')).toEqual(
      dhaka('2027-01-01T09:00:00'),
    );
  });
});

describe('templates', () => {
  it('fills named values, in Bangla as well as English', () => {
    expect(
      renderTemplate('শুভ জন্মদিন {name}! আপনার কোড {code}', { name: 'রহিম', code: 'BDAY50' }),
    ).toBe('শুভ জন্মদিন রহিম! আপনার কোড BDAY50');
  });

  it('refuses to send a template with a value missing', () => {
    expect(() => renderTemplate('Your code is {code}', {})).toThrow(TemplateError);
    expect(placeholdersOf('{a} {b} {a}')).toEqual(['a', 'b']);
  });

  it('counts SMS segments as the network bills them', () => {
    expect(smsSegments('a'.repeat(160))).toBe(1);
    expect(smsSegments('a'.repeat(161))).toBe(2);
    expect(smsSegments('ক'.repeat(70))).toBe(1);
    expect(smsSegments('ক'.repeat(71))).toBe(2);
  });
});
