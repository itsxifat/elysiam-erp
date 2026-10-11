import { fastifyCors } from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CORS_METHODS, corsOptions } from './cors.js';
import { CSRF_HEADER } from './csrf.js';
import { IDEMPOTENCY_HEADER } from './idempotency.js';
import { OWNER_ACK_HEADER } from '@elysium/contracts';

/**
 * The preflight a browser sends, answered by the real plugin with the real
 * options.
 *
 * Every other server test uses `inject` without an `Origin`, which never
 * preflights — which is how a CORS policy allowing only `GET, HEAD, POST`
 * shipped while the console's PUTs and DELETEs failed in every browser. These
 * send the `OPTIONS` request the browser would, and read the answer the way the
 * browser does.
 */

const CONSOLE = 'https://console.example.test';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(fastifyCors, corsOptions({ trustedOrigins: [CONSOLE] }));
  for (const method of CORS_METHODS.filter((m) => m !== 'HEAD')) {
    app.route({ method, url: '/v1/thing', handler: () => ({ ok: true }) });
  }
  app.get('/v1/scanner/shipment', () => ({ found: false }));
  app.post('/v1/scanner/sign-in', () => ({ ok: true }));
  app.get('/api/admin/scanner/shipment', () => ({ found: false }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function preflight(origin: string, method: string, headers: string) {
  return app.inject({
    method: 'OPTIONS',
    url: '/v1/thing',
    headers: {
      origin,
      'access-control-request-method': method,
      'access-control-request-headers': headers,
    },
  });
}

describe('the CORS preflight', () => {
  it.each(['PUT', 'PATCH', 'DELETE', 'POST'])(
    'allows %s from a trusted origin, with the headers the clients send',
    async (method) => {
      const response = await preflight(
        CONSOLE,
        method,
        `content-type, ${CSRF_HEADER}, ${IDEMPOTENCY_HEADER}, ${OWNER_ACK_HEADER}`,
      );

      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(CONSOLE);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
      const methods = String(response.headers['access-control-allow-methods']).split(/,\s*/);
      expect(methods).toContain(method);
      const allowed = String(response.headers['access-control-allow-headers'])
        .toLowerCase()
        .split(/,\s*/);
      // M41: the owner acknowledgement rides on desk writes (D-710).
      for (const header of ['content-type', CSRF_HEADER, IDEMPOTENCY_HEADER, OWNER_ACK_HEADER]) {
        expect(allowed).toContain(header.toLowerCase());
      }
    },
  );

  it('gives an untrusted origin nothing to act on', async () => {
    const response = await preflight('https://elsewhere.example.test', 'PUT', 'content-type');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('echoes the origin exactly, never a wildcard', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/thing',
      headers: { origin: CONSOLE },
    });

    expect(response.headers['access-control-allow-origin']).toBe(CONSOLE);
  });
});

/**
 * The packing scanner app's routes (M35b, D-554): its WebView is an origin of its own and it
 * sends a bearer token, never a cookie. Any origin may call them, without credentials; every
 * other route keeps the exact-origin, credentialed policy.
 */
describe('the scanner device routes', () => {
  const APP = 'https://localhost';

  it('answers any origin, without credentials, with the bearer header allowed', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/v1/scanner/shipment?code=EL-1001',
      headers: {
        origin: APP,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(APP);
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(String(response.headers['access-control-allow-headers']).toLowerCase()).toContain(
      'authorization',
    );
  });

  it('lets the app post its sign-in from its own origin', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/scanner/sign-in',
      headers: { origin: APP, 'content-type': 'application/json' },
      payload: '{}',
    });

    expect(response.headers['access-control-allow-origin']).toBe(APP);
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('answers the app as it ships at the old address the same way', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/admin/scanner/shipment?code=EL-1001',
      headers: {
        origin: APP,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });

    expect(response.headers['access-control-allow-origin']).toBe(APP);
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('opens nothing else to that origin', async () => {
    const response = await preflight(APP, 'POST', 'content-type');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
