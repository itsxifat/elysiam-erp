import { describe, expect, it } from 'vitest';

import { isTrustedOrigin, withBrandOrigins } from './origins.js';

/**
 * The origin rule is the single place three separate controls agree — CORS, the
 * CSRF origin check and Better Auth. A hole here is a hole in all three.
 *
 * This file previously tested a wildcard rule that trusted any single-label
 * subdomain of APP_DOMAIN. An audit showed why that was wrong: CORS is the
 * control that stops a sibling subdomain *using* the CSRF token it can already
 * read, and wildcarding removed it. The list is enumerated now, and the tests
 * below are mostly about proving that nothing outside the enumeration gets in.
 */

const SLUGS = ['elysium-lifestyle-bd', 'oura-lifestyle', 'orvo', 'wear-x-clothing', 'beownz'];

const PRODUCTION = {
  trustedOrigins: withBrandOrigins(['https://console.erp.example.com'], 'erp.example.com', SLUGS),
};

describe('the enumerated list', () => {
  it('trusts each configured origin', () => {
    expect(isTrustedOrigin('https://console.erp.example.com', PRODUCTION)).toBe(true);
  });

  it('trusts each brand on the same scheme and port', () => {
    for (const slug of SLUGS) {
      expect(isTrustedOrigin(`https://${slug}.erp.example.com`, PRODUCTION)).toBe(true);
    }
  });

  it('carries scheme and port across rather than assuming them', () => {
    const development = {
      trustedOrigins: withBrandOrigins(['http://localhost:5173'], 'localhost', SLUGS),
    };

    expect(isTrustedOrigin('http://orvo.localhost:5173', development)).toBe(true);
    expect(isTrustedOrigin('http://orvo.localhost:5174', development)).toBe(false);
    expect(isTrustedOrigin('https://orvo.localhost:5173', development)).toBe(false);
  });
});

describe('everything outside the enumeration is refused', () => {
  it.each([
    ['https://evil.erp.example.com', 'the subdomain-takeover case the wildcard allowed'],
    ['https://chatwoot.erp.example.com', 'a real sibling host, §16 — still not the API'],
    ['https://landing.erp.example.com', 'a Puck-editable landing site, D-026'],
    ['https://a.b.erp.example.com', 'nested labels'],
    ['https://www.erp.example.com', 'www'],
    ['https://erp.example.com', 'the bare apex was not configured'],
    ['http://oura-lifestyle.erp.example.com', 'a scheme nobody configured'],
    ['https://oura-lifestyle.erp.example.com:8443', 'a port nobody configured'],
    ['https://erp.example.com.evil.test', 'the classic suffix attack'],
    ['https://oura-lifestyle.erp.example.com.evil.test', 'a brand name plus a suffix'],
    ['null', 'the literal null origin a sandboxed iframe sends'],
    ['', 'no origin at all'],
    ['not a url', 'unparseable'],
  ])('refuses %s: %s', (origin) => {
    expect(isTrustedOrigin(origin, PRODUCTION)).toBe(false);
  });

  it('refuses everything when nothing is configured', () => {
    expect(isTrustedOrigin('https://oura-lifestyle.erp.example.com', { trustedOrigins: [] })).toBe(
      false,
    );
  });
});

describe('withBrandOrigins', () => {
  it('produces exact origins and no patterns', () => {
    const origins = withBrandOrigins(['https://console.erp.example.com'], 'erp.example.com', [
      'orvo',
    ]);

    expect(origins).toEqual(['https://console.erp.example.com', 'https://orvo.erp.example.com']);
    expect(origins.some((origin) => origin.includes('*'))).toBe(false);
  });

  it('refuses a slug that is not a plain DNS label', () => {
    // Slugs come out of the database. A slug like `evil.test/..` concatenated
    // into an origin string would be a trusted-origin injection.
    const origins = withBrandOrigins(['https://console.erp.example.com'], 'erp.example.com', [
      'evil.test',
      'has space',
      'UPPER',
      '-leading',
      'trailing-',
      '',
      'ok-brand',
    ]);

    expect(origins).toEqual([
      'https://console.erp.example.com',
      'https://ok-brand.erp.example.com',
    ]);
  });

  it('survives a malformed configured origin rather than failing to boot', () => {
    const origins = withBrandOrigins(
      ['https://console.erp.example.com', 'not a url'],
      'erp.example.com',
      ['orvo'],
    );

    expect(origins).toContain('https://orvo.erp.example.com');
    expect(origins).toContain('https://console.erp.example.com');
  });

  it('does not duplicate when a brand origin is also configured explicitly', () => {
    const origins = withBrandOrigins(
      ['https://console.erp.example.com', 'https://orvo.erp.example.com'],
      'erp.example.com',
      ['orvo'],
    );

    expect(origins.filter((o) => o === 'https://orvo.erp.example.com')).toHaveLength(1);
  });
});
