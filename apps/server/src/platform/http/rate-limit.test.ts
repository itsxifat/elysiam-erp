import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';

import {
  checkRateLimit,
  identifierFrom,
  MemoryRateLimiter,
  type RateLimitRule,
} from './rate-limit.js';

/**
 * Check 5's unit half (architecture §25).
 *
 * The thing being proved is specifically that the two buckets are *independent*:
 * a limiter that only counts per IP passes a naive "does it ever return 429"
 * test, which is exactly what the previous test did and why it proved nothing.
 * So every case below varies one axis while holding the other fixed.
 */

const RULES: Readonly<Record<string, RateLimitRule>> = {
  '/api/auth/sign-in/email': { windowSeconds: 60, perIp: 20, perIdentifier: 5 },
  '/api/auth/two-factor/verify-totp': { windowSeconds: 60, perIp: 10 },
};

/** A clock the test drives, so nothing here waits on real time. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
  };
}

function request(options: { ip: string; url?: string; body?: unknown }): FastifyRequest {
  return {
    ip: options.ip,
    url: options.url ?? '/api/auth/sign-in/email',
    body: options.body,
  } as FastifyRequest;
}

describe('the identifier bucket', () => {
  it('stops stuffing one account however many addresses it comes from', async () => {
    // The attack the per-IP limiter cannot see: one victim, a fresh IP each
    // time. Better Auth's built-in limiter allows this indefinitely.
    const limiter = new MemoryRateLimiter(fakeClock().now);
    const victim = { email: 'victim@example.invalid' };

    const statuses = await Promise.all(
      Array.from(
        { length: 8 },
        async (_, attempt) =>
          await checkRateLimit(request({ ip: `203.0.113.${String(attempt)}`, body: victim }), {
            limiter,
            rules: RULES,
          }),
      ),
    );

    expect(statuses.slice(0, 5).every((d) => d.allowed)).toBe(true);
    expect(statuses.slice(5).every((d) => !d.allowed)).toBe(true);
    expect(statuses[5]?.bucket).toBe('identifier');
  });

  it('does not punish a different account on the same address', async () => {
    // The other half of the same coin: a shared NAT address is most of
    // Bangladesh's mobile traffic, so one user exhausting their own attempts
    // must not lock out their neighbour.
    const limiter = new MemoryRateLimiter(fakeClock().now);
    const ip = '203.0.113.9';

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await checkRateLimit(request({ ip, body: { email: 'noisy@example.invalid' } }), {
        limiter,
        rules: RULES,
      });
    }

    const neighbour = await checkRateLimit(
      request({ ip, body: { email: 'quiet@example.invalid' } }),
      {
        limiter,
        rules: RULES,
      },
    );

    expect(neighbour.allowed).toBe(true);
  });

  it('treats the same address in different cases as one account', async () => {
    const limiter = new MemoryRateLimiter(fakeClock().now);

    for (const email of [
      'victim@example.invalid',
      'Victim@Example.Invalid',
      ' VICTIM@EXAMPLE.INVALID ',
      'victim@example.invalid',
      'Victim@example.invalid',
    ]) {
      await checkRateLimit(request({ ip: '203.0.113.1', body: { email } }), {
        limiter,
        rules: RULES,
      });
    }

    const sixth = await checkRateLimit(
      request({ ip: '203.0.113.2', body: { email: 'VICTIM@example.invalid' } }),
      { limiter, rules: RULES },
    );

    expect(sixth.allowed, 'case must not buy a fresh bucket').toBe(false);
  });
});

describe('the IP bucket', () => {
  it('stops one address walking a list of accounts', async () => {
    const limiter = new MemoryRateLimiter(fakeClock().now);
    const ip = '198.51.100.4';

    const statuses = await Promise.all(
      Array.from(
        { length: 22 },
        async (_, attempt) =>
          await checkRateLimit(
            request({ ip, body: { email: `user${String(attempt)}@example.invalid` } }),
            {
              limiter,
              rules: RULES,
            },
          ),
      ),
    );

    // Each identifier is fresh, so only the IP bucket can catch this.
    expect(statuses.slice(0, 20).every((d) => d.allowed)).toBe(true);
    expect(statuses[20]?.allowed).toBe(false);
    expect(statuses[20]?.bucket).toBe('ip');
  });

  it('applies where there is no identifier to count', async () => {
    // verify-totp names its user with a signed cookie, not the body.
    const limiter = new MemoryRateLimiter(fakeClock().now);
    const url = '/api/auth/two-factor/verify-totp';

    const statuses = await Promise.all(
      Array.from(
        { length: 12 },
        async () =>
          await checkRateLimit(request({ ip: '198.51.100.5', url, body: { code: '000000' } }), {
            limiter,
            rules: RULES,
          }),
      ),
    );

    expect(statuses[9]?.allowed).toBe(true);
    expect(statuses[10]?.allowed).toBe(false);
  });
});

describe('the window', () => {
  it('lets the attempts back after it passes', async () => {
    const clock = fakeClock();
    const limiter = new MemoryRateLimiter(clock.now);
    const body = { email: 'victim@example.invalid' };

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await checkRateLimit(request({ ip: '203.0.113.1', body }), { limiter, rules: RULES });
    }
    expect(
      (await checkRateLimit(request({ ip: '203.0.113.1', body }), { limiter, rules: RULES }))
        .allowed,
    ).toBe(false);

    clock.advance(61);
    expect(
      (await checkRateLimit(request({ ip: '203.0.113.1', body }), { limiter, rules: RULES }))
        .allowed,
    ).toBe(true);
  });

  it('reports a retry-after inside the window', async () => {
    const clock = fakeClock();
    const limiter = new MemoryRateLimiter(clock.now);
    const body = { email: 'victim@example.invalid' };

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await checkRateLimit(request({ ip: '203.0.113.1', body }), { limiter, rules: RULES });
    }

    clock.advance(20);
    const decision = await checkRateLimit(request({ ip: '203.0.113.1', body }), {
      limiter,
      rules: RULES,
    });

    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    expect(decision.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('does not grow without bound as identifiers accumulate', async () => {
    // An unbounded map keyed by attacker-supplied email is a memory-exhaustion
    // vector handed to the very attacker the limiter exists to stop.
    const clock = fakeClock();
    const limiter = new MemoryRateLimiter(clock.now);

    for (let attempt = 0; attempt < 500; attempt += 1) {
      await checkRateLimit(
        request({ ip: '203.0.113.1', body: { email: `u${String(attempt)}@example.invalid` } }),
        { limiter, rules: RULES },
      );
      clock.advance(1);
    }

    const counters = (limiter as unknown as { counters: Map<string, unknown> }).counters;
    expect(counters.size, 'expired counters must be swept').toBeLessThan(200);
  });
});

describe('what is not limited', () => {
  it('leaves an unlisted route alone', async () => {
    const limiter = new MemoryRateLimiter(fakeClock().now);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const decision = await checkRateLimit(request({ ip: '203.0.113.1', url: '/v1/orders' }), {
        limiter,
        rules: RULES,
      });
      expect(decision.allowed).toBe(true);
    }
  });

  it('is not fooled by a query string on a limited route', async () => {
    const limiter = new MemoryRateLimiter(fakeClock().now);
    const body = { email: 'victim@example.invalid' };

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await checkRateLimit(
        request({ ip: '203.0.113.1', url: `/api/auth/sign-in/email?x=${String(attempt)}`, body }),
        { limiter, rules: RULES },
      );
    }

    const next = await checkRateLimit(
      request({ ip: '203.0.113.1', url: '/api/auth/sign-in/email?x=99', body }),
      { limiter, rules: RULES },
    );
    expect(next.allowed).toBe(false);
  });

  it('can be switched off wholesale for tests that drive many logins', async () => {
    const limiter = new MemoryRateLimiter(fakeClock().now);
    const body = { email: 'victim@example.invalid' };

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const decision = await checkRateLimit(request({ ip: '203.0.113.1', body }), {
        limiter,
        rules: RULES,
        enabled: false,
      });
      expect(decision.allowed).toBe(true);
    }
  });
});

describe('identifierFrom', () => {
  it.each([
    [{ email: 'a@b.test' }, 'a@b.test'],
    [{ email: '  A@B.TEST ' }, 'a@b.test'],
    [{ phoneNumber: '+8801700000000' }, '+8801700000000'],
    [{ email: '', phoneNumber: '+8801700000000' }, '+8801700000000'],
  ])('reads %o as %s', (body, expected) => {
    expect(identifierFrom(body)).toBe(expected);
  });

  it.each([[null], [undefined], ['a string'], [{}], [{ email: 42 }], [{ email: '   ' }]])(
    'reads %o as no identifier',
    (body) => {
      expect(identifierFrom(body)).toBeNull();
    },
  );
});
