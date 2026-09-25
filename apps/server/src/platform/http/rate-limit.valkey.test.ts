import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';

import { checkRateLimit, MemoryRateLimiter, type RateLimitRule } from './rate-limit.js';
import { ValkeyRateLimiter, type ValkeyScriptClient } from './rate-limit.valkey.js';
import type { FastifyRequest } from 'fastify';

/**
 * The Valkey-backed counters (D-056's exit), against a real Valkey.
 *
 * A fake would prove the TypeScript and nothing about the thing that actually
 * matters: whether the Lua script increments, expires and reports a TTL the way
 * Valkey implements those. The one bug this store can have — a key left with no
 * expiry, which is a permanent lockout — is a property of the server's execution
 * of the script, so it is tested there.
 *
 * Valkey comes from `infra/docker-compose.dev.yml`, at the same URL the realtime
 * suite uses.
 */

const URL = process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379';

const client = new Redis(URL, { maxRetriesPerRequest: 2, lazyConnect: true });

afterAll(async () => {
  await client.quit();
});

/** A fresh namespace per test, so nothing here can see another test's counters. */
function limiter(overrides: { fallback?: MemoryRateLimiter; onError?: (e: unknown) => void } = {}) {
  return new ValkeyRateLimiter({
    client,
    keyPrefix: `test:${randomUUID()}`,
    ...overrides,
  });
}

describe('the Valkey counter', () => {
  it('allows up to the limit and refuses past it', async () => {
    const store = limiter();
    const results = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      results.push(await store.hit('k', 3, 60));
    }

    expect(results.slice(0, 3).every((decision) => decision.allowed)).toBe(true);
    expect(results.slice(3).every((decision) => !decision.allowed)).toBe(true);
  });

  it('reports a retry-after inside the window, never zero', async () => {
    // `retry-after: 0` invites an immediate retry, which is a busy loop against
    // the endpoint the limiter is protecting.
    const store = limiter();
    await store.hit('k', 1, 30);
    const refused = await store.hit('k', 1, 30);

    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(30);
  });

  it('always leaves the key with an expiry', async () => {
    // The failure this guards is rare, permanent and undiagnosable: an INCR
    // whose EXPIRE never ran leaves a counter that never resets, and that IP or
    // account can never sign in again. The script is atomic so it cannot happen;
    // this asserts the atomicity is real rather than intended.
    const prefix = `test:${randomUUID()}`;
    const store = new ValkeyRateLimiter({ client, keyPrefix: prefix });
    await store.hit('expiring', 10, 45);

    const ttl = await client.pttl(`${prefix}:expiring`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(45_000);
  });

  it('repairs a key that somehow has no expiry', async () => {
    const prefix = `test:${randomUUID()}`;
    const store = new ValkeyRateLimiter({ client, keyPrefix: prefix });
    // A manual SET, or a snapshot restored mid-window.
    await client.set(`${prefix}:orphan`, '1');
    expect(await client.pttl(`${prefix}:orphan`)).toBe(-1);

    await store.hit('orphan', 10, 20);
    expect(await client.pttl(`${prefix}:orphan`)).toBeGreaterThan(0);
  });

  it('counts the same key from two limiter instances, which is the whole point', async () => {
    // Two instances stand for two API replicas. Before M04 each had its own map,
    // so the published limit was N times looser than the real one.
    const prefix = `test:${randomUUID()}`;
    const replicaA = new ValkeyRateLimiter({ client, keyPrefix: prefix });
    const replicaB = new ValkeyRateLimiter({ client, keyPrefix: prefix });

    await replicaA.hit('shared', 2, 60);
    await replicaB.hit('shared', 2, 60);
    const third = await replicaA.hit('shared', 2, 60);

    expect(third.allowed).toBe(false);
  });

  it('keeps two namespaces apart', async () => {
    // Staging's load test must not lock production's users out: the counters are
    // keyed by path and email, which are identical across environments.
    const staging = limiter();
    const production = limiter();

    await staging.hit('same', 1, 60);
    await staging.hit('same', 1, 60);

    expect((await production.hit('same', 1, 60)).allowed).toBe(true);
  });
});

describe('when Valkey will not answer', () => {
  /** A client whose every command fails, standing in for an outage. */
  const broken: ValkeyScriptClient = {
    eval: () => Promise.reject(new Error('ECONNREFUSED')),
  };

  it('degrades to per-process counters rather than failing open or closed', async () => {
    // Failing closed would make a cache outage an authentication outage; failing
    // open would turn the limiter off exactly when monitoring is noisiest.
    const errors: unknown[] = [];
    const fallback = new MemoryRateLimiter();
    const store = new ValkeyRateLimiter({
      client: broken,
      fallback,
      onError: (error) => errors.push(error),
    });

    expect((await store.hit('k', 1, 60)).allowed).toBe(true);
    expect((await store.hit('k', 1, 60)).allowed).toBe(false);
    // Loud, because the limits have silently become per process.
    expect(errors).toHaveLength(2);
  });

  it('treats a reply it cannot read as an outage, not as an allowance', async () => {
    const errors: unknown[] = [];
    const store = new ValkeyRateLimiter({
      // A different server, or a proxy rewriting replies.
      client: { eval: () => Promise.resolve('OK') },
      onError: (error) => errors.push(error),
    });

    expect((await store.hit('k', 1, 60)).allowed).toBe(true);
    expect((await store.hit('k', 1, 60)).allowed).toBe(false);
    expect(errors).toHaveLength(2);
  });
});

describe('the policy on top of it', () => {
  const RULES: Readonly<Record<string, RateLimitRule>> = {
    '/api/auth/sign-in/email': { windowSeconds: 60, perIp: 4, perIdentifier: 2 },
  };

  const request = (ip: string, body: unknown): FastifyRequest =>
    ({ url: '/api/auth/sign-in/email', ip, body }) as FastifyRequest;

  it('still counts both buckets, and either can reject', async () => {
    // D-056's policy is unchanged by the store swap: the identifier bucket is
    // what makes stuffing one account expensive from a botnet, and the IP bucket
    // is what stops one host walking a list of accounts.
    const store = limiter();
    const victim = { email: 'victim@example.invalid' };

    const first = await checkRateLimit(request('203.0.113.1', victim), {
      limiter: store,
      rules: RULES,
    });
    const second = await checkRateLimit(request('203.0.113.2', victim), {
      limiter: store,
      rules: RULES,
    });
    const third = await checkRateLimit(request('203.0.113.3', victim), {
      limiter: store,
      rules: RULES,
    });

    expect([first.allowed, second.allowed]).toEqual([true, true]);
    expect(third.allowed).toBe(false);
    expect(third.bucket).toBe('identifier');
  });

  it('does not punish a neighbour behind the same carrier NAT', async () => {
    const store = limiter();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await checkRateLimit(request('203.0.113.9', { email: 'noisy@example.invalid' }), {
        limiter: store,
        rules: RULES,
      });
    }

    const neighbour = await checkRateLimit(
      request('203.0.113.9', { email: 'quiet@example.invalid' }),
      { limiter: store, rules: RULES },
    );
    expect(neighbour.allowed).toBe(true);
  });
});
