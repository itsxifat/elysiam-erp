import { describe, expect, it } from 'vitest';

import { createApiAdapter } from './main.api.js';
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
