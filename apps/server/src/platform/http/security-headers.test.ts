import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerSecurityHeaders } from './security-headers.js';

/** The API's response headers (§25, M14b security review, D-349). */

async function serve(hsts: boolean) {
  const app = Fastify();
  registerSecurityHeaders(app, { hsts });
  app.get('/json', () => ({ ok: true }));
  app.get('/download', (_request, reply) => {
    void reply.header('cache-control', 'private, no-store');
    return 'bytes';
  });
  await app.ready();
  return app;
}

describe('registerSecurityHeaders', () => {
  it('marks every response as not to be sniffed, framed, referred or cached', async () => {
    const app = await serve(false);
    const response = await app.inject({ method: 'GET', url: '/json' });

    expect(response.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'cache-control': 'no-store',
    });
    expect(response.headers['strict-transport-security']).toBeUndefined();
    await app.close();
  });

  it("keeps a route's own cache-control, and adds HSTS when cookies are Secure", async () => {
    const app = await serve(true);
    const response = await app.inject({ method: 'GET', url: '/download' });

    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    );
    await app.close();
  });

  it('covers error responses too', async () => {
    const app = await serve(false);
    const response = await app.inject({ method: 'GET', url: '/missing' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    await app.close();
  });
});
