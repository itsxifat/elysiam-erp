import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { describeUserAgent, maskAddress } from './devices.js';
import {
  brandUpdateSchema,
  currentCodeSchema,
  newAuthenticatorSchema,
  passwordChangeSchema,
  totpCodeSchema,
} from './schemas.js';

/** My account's devices (D-704) and its forms' schemas (D-700 to D-703). */

describe('describeUserAgent', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Chrome',
      'Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
      'Edge',
      'Windows',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      'Safari',
      'macOS',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'Safari',
      'iPhone',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1',
      'Chrome',
      'iPhone',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
      'Samsung Internet',
      'Android',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox', 'Linux'],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0',
      'Opera',
      'Windows',
    ],
  ])('reads %s', (agent, browser, os) => {
    expect(describeUserAgent(agent)).toEqual({ browser, os });
  });

  it('says nothing it does not know', () => {
    expect(describeUserAgent(null)).toEqual({ browser: null, os: null });
    expect(describeUserAgent('curl/8.5.0')).toEqual({ browser: null, os: null });
  });
});

describe('maskAddress', () => {
  it('keeps the first half of an address', () => {
    expect(maskAddress('103.129.209.29')).toBe('103.129.*.*');
    expect(maskAddress('::ffff:10.9.0.7')).toBe('10.9.*.*');
    expect(maskAddress('2001:DB8:85a3:0:0:8a2e:370:7334')).toBe('2001:db8:85a3:*');
    expect(maskAddress('fe80::1')).toBe('fe80:*');
  });

  it('shows nothing for what is not an address', () => {
    for (const value of [null, undefined, '', 'unknown', '::1', '300.1.1.1', 'a.b.c.d']) {
      expect(maskAddress(value)).toBeNull();
    }
  });

  it('never shows the last two parts of an IPv4 address', () => {
    const octet = fc.integer({ min: 0, max: 255 });
    fc.assert(
      fc.property(octet, octet, octet, octet, (a, b, c, d) => {
        const masked = maskAddress(`${String(a)}.${String(b)}.${String(c)}.${String(d)}`);
        expect(masked).toBe(`${String(a)}.${String(b)}.*.*`);
      }),
    );
  });
});

describe('account and brand schemas', () => {
  it('refuses a read connection in a brand change: that is the server’s (D-700)', () => {
    expect(brandUpdateSchema.safeParse({ displayName: 'Oura' }).success).toBe(true);
    expect(
      brandUpdateSchema.safeParse({
        displayName: 'Oura',
        readConnection: 'postgres://erp_analytics:x@127.0.0.1:5501/elysium',
      }).success,
    ).toBe(false);
  });

  it('asks for a new password of 12 or more that differs from the current one', () => {
    const base = { currentPassword: 'old-password-1234', newPassword: 'new-password-1234' };
    expect(passwordChangeSchema.parse(base)).toEqual({ ...base, signOutOtherDevices: true });
    expect(passwordChangeSchema.safeParse({ ...base, newPassword: 'short' }).success).toBe(false);
    expect(
      passwordChangeSchema.safeParse({ ...base, newPassword: base.currentPassword }).success,
    ).toBe(false);
  });

  it('reads an app code with spaces, and a recovery code as typed', () => {
    expect(totpCodeSchema.parse(' 123 456 ')).toBe('123456');
    expect(totpCodeSchema.safeParse('12345').success).toBe(false);
    expect(currentCodeSchema.parse('123 456')).toBe('123456');
    expect(currentCodeSchema.parse(' AbC12-dE345 ')).toBe('AbC12-dE345');
    expect(newAuthenticatorSchema.safeParse({ password: 'x', code: '12' }).success).toBe(false);
  });
});
