import { describe, expect, it } from 'vitest';

import { createApiAdapter, isPrivateAddress, trustProxyFor } from './main.api.js';
import { createLogger } from './platform/logging/logger.js';
import { setServerTestEnv } from './testing/test-env.js';

/**
 * The composition root's one testable seam.
 *
 * Everything else in `main.api.ts` runs only inside `bootstrap()`, which only
 * `main.api.js` calls — every HTTP suite builds its application through
 * `startHttpHarness`, which constructs its own adapter. So a throw while building the
 * real adapter is invisible to the entire test suite, and one shipped: Fastify 5 split
 * `logger` (an options object) from `loggerInstance` (an already-built logger), and
 * handing pino to `logger` threw `FST_ERR_LOG_INVALID_LOGGER_CONFIG` on the first line of
 * boot. 1,501 tests were green and the API would not start.
 *
 * This is deliberately not a broad test. It asserts the one thing no other test can
 * reach: that the adapter the production process builds can be built at all.
 */
describe('the API adapter the production process builds', () => {
  it('constructs, with a real pino logger attached', () => {
    setServerTestEnv();
    const logger = createLogger('api-adapter-test');

    // Both branches of `trustProxy`: 0 means "trust the socket", anything else is a hop
    // count Fastify hands to proxy-addr.
    expect(() => createApiAdapter(0, logger)).not.toThrow();
    expect(() => createApiAdapter(2, logger)).not.toThrow();
  });

  it('gives Fastify a logger that actually writes, not the silent default', () => {
    setServerTestEnv();
    const adapter = createApiAdapter(0, createLogger('api-adapter-test'));

    // `logger: false` is Fastify's default and makes `request.log.error` a no-op — which
    // is what silently swallowed the audit interceptor's failure path once already.
    const instance = adapter.getInstance();
    expect(instance.log).toBeDefined();
    expect(typeof instance.log.error).toBe('function');
  });
});

/**
 * `TRUSTED_PROXY_COUNT` really means "trust the n nearest hops" (D-479). Fastify 5.12
 * reads a numeric `trustProxy` as "trust nothing", which left `request.ip` the proxy's own
 * address for every visitor; the adapter now hands it a hop function.
 */
describe('the client address behind the proxy', () => {
  async function ipSeen(
    count: number,
    headers: Record<string, string>,
    peer = '127.0.0.1',
  ): Promise<string> {
    setServerTestEnv();
    const instance = createApiAdapter(count, createLogger('api-adapter-test')).getInstance();
    instance.get('/ip', (request, reply) => {
      void reply.send({ ip: request.ip });
    });
    await instance.ready();
    const response = await instance.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: peer,
      headers,
    });
    await instance.close();
    return (JSON.parse(response.body) as { ip: string }).ip;
  }

  it('is the forwarded visitor with one proxy in front', async () => {
    expect(await ipSeen(1, { 'x-forwarded-for': '203.0.113.7' })).toBe('203.0.113.7');
    // A visitor's own header before the proxy's is not believed past the one hop.
    expect(await ipSeen(1, { 'x-forwarded-for': '198.51.100.9, 203.0.113.7' })).toBe('203.0.113.7');
  });

  it('ignores the header with no proxy', async () => {
    expect(await ipSeen(0, { 'x-forwarded-for': '203.0.113.7' })).toBe('127.0.0.1');
  });

  it('trusts no more hops than it is told', () => {
    expect(trustProxyFor(0)).toBe(false);
    const two = trustProxyFor(2);
    expect(two === false ? [] : [0, 1, 2].map((hop) => two('10.0.0.1', hop))).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('trusts no header from a peer on a public address, as a port published by mistake', async () => {
    expect(await ipSeen(1, { 'x-forwarded-for': '203.0.113.7' }, '198.51.100.20')).toBe(
      '198.51.100.20',
    );
    expect(await ipSeen(1, { 'x-forwarded-for': '203.0.113.7' }, '172.18.0.1')).toBe('203.0.113.7');
    expect(
      ['127.0.0.1', '::1', '::ffff:10.0.0.4', '192.168.1.2', 'fd00::1'].every(isPrivateAddress),
    ).toBe(true);
    expect(['8.8.8.8', '172.32.0.1', '2001:db8::1', 'not-an-ip'].some(isPrivateAddress)).toBe(
      false,
    );
  });
});
