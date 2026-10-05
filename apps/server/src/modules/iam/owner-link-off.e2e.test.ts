import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHttpHarness, type HttpHarness } from '../../testing/http-harness.js';

/**
 * The owner sign-in link with no public key configured (M31 check 4, D-473): the feature
 * is off and the route answers 404 to anything, a well-formed link included.
 */

let harness: HttpHarness;

beforeAll(async () => {
  delete process.env.OWNER_LINK_PUBLIC_KEY;
  harness = await startHttpHarness('owner-link-off');
}, 300_000);

afterAll(async () => {
  await harness?.close();
}, 120_000);

describe('without OWNER_LINK_PUBLIC_KEY', () => {
  it('answers 404 and sets no cookie', async () => {
    const client = harness.client();
    await client.request('GET', '/v1/auth/login-branding');
    const response = await client.request('POST', '/v1/auth/owner-link', {
      body: { token: `${'A'.repeat(200)}.${'B'.repeat(86)}` },
    });
    expect(response.statusCode).toBe(404);
    const raw: unknown = response.headers['set-cookie'];
    const cookies = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
    expect(cookies.some((cookie) => cookie.includes('session_token='))).toBe(false);
  });
});
