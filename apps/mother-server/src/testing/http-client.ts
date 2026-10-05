import { base32 } from '@better-auth/utils/base32';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import type { MotherAuth } from '../auth/auth.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../http/csrf.js';

/**
 * A browser, for the HTTP tests: it keeps cookies, echoes the CSRF token, and speaks from
 * the mother's own origin through `inject` (no socket).
 */

export const PUBLIC_URL = 'https://mother.example.com';
export const PASSWORD = 'correct-horse-battery-staple';

let nextIp = 0;

export interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, unknown>;
}

export class Browser {
  private readonly cookies = new Map<string, string>();
  readonly ip: string;

  constructor(private readonly app: NestFastifyApplication) {
    nextIp += 1;
    this.ip = `10.9.${String(Math.floor(nextIp / 256) % 256)}.${String(nextIp % 256)}`;
  }

  private absorb(headers: Record<string, unknown>): void {
    const raw = headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    for (const entry of list) {
      const pair = String(entry).split(';')[0] ?? '';
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      const expired = /max-age=0\b/i.test(String(entry));
      if (value === '' || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    body?: unknown,
    options: { readonly csrf?: boolean; readonly origin?: string } = {},
  ): Promise<Answer> {
    const headers: Record<string, string> = {
      host: new URL(PUBLIC_URL).host,
      origin: options.origin ?? PUBLIC_URL,
      'x-forwarded-for': this.ip,
    };
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    const token = this.cookies.get(CSRF_COOKIE);
    if (token !== undefined && options.csrf !== false) headers[CSRF_HEADER] = token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await this.app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url,
        headers,
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
    this.absorb(response.headers);
    let parsed: unknown = null;
    try {
      parsed = response.body === '' ? null : JSON.parse(response.body);
    } catch {
      parsed = response.body;
    }
    return { status: response.statusCode, body: parsed, headers: response.headers };
  }

  get(url: string): Promise<Answer> {
    return this.request('GET', url);
  }

  async post(url: string, body?: unknown, options?: { csrf?: boolean; origin?: string }) {
    // A first safe request hands out the CSRF cookie, as the console's first GET does.
    if (!this.cookies.has(CSRF_COOKIE)) await this.get('/v1/health/live');
    return this.request('POST', url, body, options);
  }

  async patch(url: string, body?: unknown) {
    if (!this.cookies.has(CSRF_COOKIE)) await this.get('/v1/health/live');
    return this.request('PATCH', url, body);
  }

  cookieNames(): string[] {
    return [...this.cookies.keys()];
  }
}

/** The token from a link the mother hands out (`…#token=…`). */
export function tokenFromLink(link: string): string {
  return decodeURIComponent(new URL(link).hash.replace(/^#token=/, ''));
}

/** Redeem an invite, sign in, enrol TOTP and verify it. Returns the TOTP secret. */
export async function acceptAndEnrol(
  browser: Browser,
  auth: MotherAuth,
  input: { readonly link: string; readonly email: string },
): Promise<{ secret: string }> {
  const reset = await browser.post('/api/auth/reset-password', {
    newPassword: PASSWORD,
    token: tokenFromLink(input.link),
  });
  if (reset.status !== 200) throw new Error(`reset-password: ${JSON.stringify(reset.body)}`);
  const signIn = await browser.post('/api/auth/sign-in/email', {
    email: input.email,
    password: PASSWORD,
  });
  if (signIn.status !== 200) throw new Error(`sign-in: ${JSON.stringify(signIn.body)}`);
  const enabled = await browser.post('/api/auth/two-factor/enable', { password: PASSWORD });
  const { totpURI } = enabled.body as { totpURI: string };
  const secret = new TextDecoder().decode(
    base32.decode(new URL(totpURI).searchParams.get('secret') ?? ''),
  );
  const { code } = await auth.api.generateTOTP({ body: { secret } });
  const verified = await browser.post('/api/auth/two-factor/verify-totp', { code });
  if (verified.status !== 200) throw new Error(`verify-totp: ${JSON.stringify(verified.body)}`);
  return { secret };
}

/** A later sign-in for an enrolled owner: password, then the code. */
export async function signInWithCode(
  browser: Browser,
  auth: MotherAuth,
  input: { readonly email: string; readonly secret: string },
): Promise<Answer> {
  const first = await browser.post('/api/auth/sign-in/email', {
    email: input.email,
    password: PASSWORD,
  });
  if (first.status !== 200) return first;
  const { code } = await auth.api.generateTOTP({ body: { secret: input.secret } });
  return browser.post('/api/auth/two-factor/verify-totp', { code });
}
