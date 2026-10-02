import type { FastifyInstance } from 'fastify';

import { CSRF_COOKIE, CSRF_HEADER } from '../platform/http/csrf.js';

/**
 * A browser, as far as the API can tell: a cookie jar, the CSRF header the console
 * sends, and an address of its own.
 *
 * The preview seed drives the application through `server.inject()` — the real routes,
 * the real guard, the real serializer and audit interceptor — rather than calling
 * services, so every row it leaves behind was written the way a person's click writes
 * it. This is the same shape as the HTTP test harness's `Client`, kept separate because
 * the harness imports `@elysium/db/testing`, which needs Testcontainers, and this runs
 * in a server image that has no dev dependencies.
 */

/** Where the seed's requests say they come from. Trusted only by the seed's own app. */
export const SEED_HOST = 'localhost';
export const SEED_ORIGIN = 'http://preview-seed.localhost';

let nextIp = 0;
function freshIp(): string {
  nextIp += 1;
  return `10.9.${String(Math.floor(nextIp / 256) % 256)}.${String(nextIp % 256)}`;
}

export interface Reply {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Record<string, unknown>;
}

/** A refused call, with what the API said. The body is a problem+json document. */
export class PreviewCallError extends Error {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly statusCode: number,
    readonly body: string,
  ) {
    super(`${method} ${url} answered ${String(statusCode)}: ${body.slice(0, 600)}`);
    this.name = 'PreviewCallError';
  }
}

export class PreviewClient {
  private readonly cookies = new Map<string, string>();

  constructor(
    private readonly server: FastifyInstance,
    private readonly ip: string = freshIp(),
  ) {}

  private absorb(headers: Record<string, unknown>): void {
    const raw = headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    for (const entry of list) {
      const pair = String(entry).split(';')[0] ?? '';
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  /** One request, whatever it answers. */
  async request(
    method: string,
    url: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Reply> {
    const headers: Record<string, string> = {
      host: SEED_HOST,
      origin: SEED_ORIGIN,
      'x-forwarded-for': this.ip,
      ...options.headers,
    };
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie !== '') headers.cookie = cookie;
    const token = this.cookies.get(CSRF_COOKIE);
    if (token !== undefined) headers[CSRF_HEADER] = token;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const response = await this.server.inject({
      method: method as 'GET',
      url,
      headers,
      ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }),
    });
    this.absorb(response.headers);
    return { statusCode: response.statusCode, body: response.body, headers: response.headers };
  }

  /** A request that must succeed; its JSON body, typed by the caller. */
  async call<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
    const reply = await this.request(method, url, body === undefined ? {} : { body });
    if (reply.statusCode >= 300) {
      throw new PreviewCallError(method, url, reply.statusCode, reply.body);
    }
    return (reply.body === '' ? undefined : JSON.parse(reply.body)) as T;
  }

  get<T = unknown>(url: string): Promise<T> {
    return this.call<T>('GET', url);
  }

  post<T = unknown>(url: string, body: unknown = {}): Promise<T> {
    return this.call<T>('POST', url, body);
  }

  put<T = unknown>(url: string, body: unknown): Promise<T> {
    return this.call<T>('PUT', url, body);
  }

  patch<T = unknown>(url: string, body: unknown): Promise<T> {
    return this.call<T>('PATCH', url, body);
  }
}
