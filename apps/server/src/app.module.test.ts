import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Auth } from '@elysium/db';
import { beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from './app.module.js';
import { PasswordTokenStore } from './modules/iam/iam.service.js';
import { describeRoutes } from './platform/auth/route-map.js';

/**
 * What the composition root mounts, and what it deliberately does not (§3).
 *
 * `demo.costed_items` exists so the matrix suite has something real to run
 * against — the same RLS, the same guard and the same serializer as everything
 * that comes after, rather than a mock that proves the mock. That makes it
 * worth having and does not make it worth deploying: a writable endpoint
 * carrying `unit_cost_poisha`, with no business behind it, reachable in
 * production until M06 replaces it.
 *
 * No database: the modules are constructed and their metadata read, and no
 * handler is ever called.
 */

/** Shaped right rather than working; nothing here reaches Better Auth. */
const auth = { api: {} } as unknown as Auth;

/*
 * Enough environment to construct the module graph.
 *
 * M04's modules read `serverEnv()` when they are constructed — the storage
 * driver needs to know which bucket it is, the flags helper needs its cache TTL
 * — so building the graph now requires a valid environment even though nothing
 * here opens a connection. Deliberately minimal and obviously fake: if a value
 * below ever has to be real, something in the graph is doing I/O at
 * construction time, which is the thing to fix rather than the value.
 */
beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://erp_app:x@127.0.0.1:5432/unused';
  process.env.APP_DOMAIN ??= 'localhost';
  process.env.API_PUBLIC_URL ??= 'http://127.0.0.1:3000';
  process.env.AUTH_SECRET ??= 'app-module-test-secret-at-least-32-chars';
  process.env.TRUSTED_ORIGINS ??= 'http://localhost:5173';
});

async function routesOf(demo?: boolean): Promise<string[]> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      auth,
      tokens: new PasswordTokenStore(),
      ...(demo === undefined ? {} : { demo }),
    }),
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  );
  await app.init();

  const paths = describeRoutes(app).map((route) => `${route.method} ${route.path}`);
  await app.close();
  return paths;
}

describe('the demo resource is mounted where it is useful and nowhere else', () => {
  it('is absent when it is turned off', async () => {
    expect((await routesOf(false)).filter((route) => route.includes('/v1/demo/'))).toEqual([]);
  });

  it('is present when it is turned on', async () => {
    // The positive control: the assertion above has to be about the flag
    // rather than about the module having quietly stopped registering.
    const routes = await routesOf(true);
    expect(routes).toContain('GET /v1/demo/costed-items');
    expect(routes).toContain('POST /v1/demo/costed-items');
  });

  it('defaults to off under NODE_ENV=production', async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const routes = await routesOf();
      expect(routes.filter((route) => route.includes('/v1/demo/'))).toEqual([]);
      // And the rest of the API is still there, so "absent" is the demo module
      // and not a failure to build anything at all.
      expect(routes).toContain('GET /v1/approvals');
      expect(routes).toContain('GET /health/live');
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
  });

  it('defaults to on everywhere else, which is where the matrix suite runs', async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      expect(await routesOf()).toContain('GET /v1/demo/costed-items');
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
  });
});

describe('every module §3 expects at this point is mounted', () => {
  it('registers health, identity, approvals and the ledger', async () => {
    // A module dropped from the imports array is invisible: the app still
    // boots, the routes are simply gone, and the route-coverage gate cannot
    // miss a route that no longer exists — it checks declarations, not
    // presence.
    const routes = await routesOf(false);

    for (const expected of [
      'GET /health/live',
      'GET /v1/me',
      'POST /v1/users',
      'GET /v1/approvals',
      'POST /v1/approvals',
      'PUT /v1/approvals/thresholds',
    ]) {
      expect(routes, `${expected} is not mounted`).toContain(expected);
    }

    expect(
      routes.filter((route) => route.includes('/v1/ledger')).length,
      'the ledger module is not mounted',
    ).toBeGreaterThan(0);
  });
});
