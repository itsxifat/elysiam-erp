import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `api.ts` reads the build-time environment on import; a unit test has none.
vi.mock('../env.js', () => ({ env: { VITE_API_URL: 'http://localhost:3000' } }));

import { api, ApiError, CSRF_COOKIE, CSRF_HEADER, NetworkError } from './api.js';

/**
 * The till's client and the CSRF token (architecture §25).
 *
 * The token is a session cookie: it dies with the browser while the sign-in
 * survives. A till reopened with a queue from the night before has a session and
 * no token, so the sync that replays that queue must fetch one first — otherwise
 * the server answers 403 and the queue would have to read a missing cookie as a
 * refusal of the sales. `.tsx` only so it runs in the DOM project, where
 * `document.cookie` exists.
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

let calls: Call[] = [];

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clearCookie(): void {
  document.cookie = `${CSRF_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
}

beforeEach(() => {
  calls = [];
  clearCookie();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(handler: (call: Call) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', (input: URL | string, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    return Promise.resolve(handler(call));
  });
}

describe('a mutation with no CSRF token in the browser', () => {
  it('fetches one first, then sends it as the header', async () => {
    stubFetch((call) => {
      if (call.method === 'GET') {
        // What the server does on any safe request with no token: issue one.
        document.cookie = `${CSRF_COOKIE}=fresh-token; path=/`;
        return respond(200, { userId: 'u', orgId: 'o' });
      }
      return respond(200, { results: [] });
    });

    await api.post('/v1/pos/sync', { documents: [] });

    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'GET /v1/me',
      'POST /v1/pos/sync',
    ]);
    expect(calls[1]?.headers[CSRF_HEADER]).toBe('fresh-token');
  });

  it('still gets its token when that first request answers 401', async () => {
    stubFetch((call) => {
      if (call.method === 'GET') {
        document.cookie = `${CSRF_COOKIE}=issued-anyway; path=/`;
        return respond(401, { code: 'UNAUTHENTICATED' });
      }
      return respond(200, {});
    });
    await api.post('/api/auth/sign-in/email', { email: 'a@b.c', password: 'x' });
    expect(calls[1]?.headers[CSRF_HEADER]).toBe('issued-anyway');
  });

  it('is a network failure, not a refusal, when even the token cannot be fetched', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(api.post('/v1/pos/sync', { documents: [] })).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('a mutation with a token already held', () => {
  it('sends it without an extra request', async () => {
    document.cookie = `${CSRF_COOKIE}=held-token; path=/`;
    stubFetch(() => respond(200, {}));
    await api.post('/v1/pos/shifts', { shiftId: 's' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers[CSRF_HEADER]).toBe('held-token');
  });
});

describe('a refusal', () => {
  it('carries the status and the problem code, so the queue can tell it from being offline', async () => {
    document.cookie = `${CSRF_COOKIE}=held-token; path=/`;
    stubFetch(() =>
      respond(409, { code: 'POS_SHIFT_ALREADY_OPEN', detail: 'A shift is already open.' }),
    );
    const error = await api.post('/v1/pos/shifts', {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'POS_SHIFT_ALREADY_OPEN' });
  });

  it('a safe request never carries the token', async () => {
    document.cookie = `${CSRF_COOKIE}=held-token; path=/`;
    stubFetch(() => respond(200, { items: [] }));
    await api.get('/v1/pos/registers');
    expect(calls[0]?.headers[CSRF_HEADER]).toBeUndefined();
  });
});
