import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { describeUserAgent, maskAddress } from './index.js';

/** My account → Devices (M40, D-695): what a person sees of each of their sessions. */

describe('describeUserAgent', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      { browser: 'Chrome', system: 'Windows', kind: 'desktop' },
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.2792.79',
      { browser: 'Edge', system: 'Windows', kind: 'desktop' },
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
      { browser: 'Safari', system: 'macOS', kind: 'desktop' },
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
      { browser: 'Safari', system: 'iOS', kind: 'phone' },
    ],
    [
      'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
      { browser: 'Safari', system: 'iPadOS', kind: 'tablet' },
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
      { browser: 'Samsung Internet', system: 'Android', kind: 'phone' },
    ],
    [
      'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      { browser: 'Chrome', system: 'Android', kind: 'tablet' },
    ],
    [
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
      { browser: 'Firefox', system: 'Linux', kind: 'desktop' },
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0',
      { browser: 'Opera', system: 'Windows', kind: 'desktop' },
    ],
  ])('reads %s', (userAgent, expected) => {
    expect(describeUserAgent(userAgent)).toEqual(expected);
  });

  it('says nothing it does not know', () => {
    expect(describeUserAgent('')).toEqual({ browser: null, system: null, kind: 'unknown' });
    expect(describeUserAgent(null)).toEqual({ browser: null, system: null, kind: 'unknown' });
    expect(describeUserAgent('curl/8.4.0')).toEqual({
      browser: null,
      system: null,
      kind: 'unknown',
    });
  });

  it('never throws, whatever it is handed', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (value) => {
        const description = describeUserAgent(value);
        expect(['desktop', 'phone', 'tablet', 'unknown']).toContain(description.kind);
      }),
    );
  });
});

describe('maskAddress', () => {
  it('hides the last part of an IPv4 address', () => {
    expect(maskAddress('103.12.45.201')).toBe('103.12.45.x');
    expect(maskAddress('::ffff:10.2.0.7')).toBe('10.2.0.x');
  });

  it('keeps only the /48 of an IPv6 address', () => {
    expect(maskAddress('2001:0db8:0012:0034:0000:0000:0000:0001')).toBe('2001:db8:12::/48');
    expect(maskAddress('2001:db8::1')).toBe('2001:db8:0::/48');
    expect(maskAddress('::1')).toBe('0:0:0::/48');
  });

  it('answers nothing for something that is not an address', () => {
    for (const value of [
      '',
      null,
      undefined,
      'localhost',
      '1.2.3',
      '300.1.1.1',
      'a:b:c:d:e:f:g:h:i',
      '1::2::3',
    ]) {
      expect(maskAddress(value), String(value)).toBeNull();
    }
  });

  it('never shows the last octet of any IPv4 address', () => {
    fc.assert(
      fc.property(fc.ipV4(), (address) => {
        const masked = maskAddress(address);
        expect(masked).toBe(`${address.split('.').slice(0, 3).join('.')}.x`);
      }),
    );
  });

  it('never shows more than three groups of any IPv6 address', () => {
    fc.assert(
      fc.property(fc.ipV6(), (address) => {
        const masked = maskAddress(address);
        if (masked === null) return; // fast-check also writes the IPv4-suffixed forms
        expect(masked.endsWith('::/48') || masked.endsWith('.x')).toBe(true);
      }),
    );
  });
});
