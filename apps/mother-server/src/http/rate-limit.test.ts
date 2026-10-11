import { describe, expect, it } from 'vitest';

import { checkRate, MemoryRateLimiter, routedPath } from './rate-limit.js';

/**
 * The credential limiter reads a path the way the router does (the M40 audit's W2):
 * find-my-way decodes percent-escapes, so an escaped spelling of an account route must meet
 * that route's limit rather than none.
 */
describe('the credential limiter', () => {
  it('reads an escaped path as the router routes it', () => {
    expect(routedPath('/v1/account/%70assword?x=1')).toBe('/v1/account/password');
    expect(routedPath('/v1/account/%E0%A4')).toBe('/v1/account/%E0%A4');
  });

  it('limits an escaped account route like the plain one, per address', () => {
    const limiter = new MemoryRateLimiter(() => 0);
    const hit = (url: string) => checkRate(limiter, { url, ip: '10.0.0.1', body: {} });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(hit('/v1/account/password').allowed).toBe(true);
      expect(hit('/v1/account/%70assword').allowed).toBe(true);
    }
    expect(hit('/v1/account/%70assword')).toMatchObject({ allowed: false, bucket: 'ip' });
    // Another address has its own count.
    expect(
      checkRate(limiter, { url: '/v1/account/password', ip: '10.0.0.2', body: {} }).allowed,
    ).toBe(true);
  });

  it('leaves a path with no rule alone', () => {
    const limiter = new MemoryRateLimiter(() => 0);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(checkRate(limiter, { url: '/v1/account', ip: '10.0.0.1', body: {} }).allowed).toBe(
        true,
      );
    }
  });
});
