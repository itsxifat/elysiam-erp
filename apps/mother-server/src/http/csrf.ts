import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * CSRF for the mother's cookie-authenticated writes (D-491), the brand's two checks (§25):
 *
 * 1. **Origin** (and `Sec-Fetch-Site`): a browser sets them and page script cannot. The
 *    console and the API are one origin, so a write from anywhere else is refused.
 * 2. **Double submit**: a random token in a readable cookie, echoed by the console in a
 *    header. A page on another origin can make the browser send the cookie but cannot read
 *    it to echo it.
 */

export const CSRF_COOKIE = 'owner_csrf';
export const CSRF_HEADER = 'x-owner-csrf';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface CsrfOptions {
  readonly trustedOrigins: readonly string[];
  readonly secure: boolean;
}

type WithCookies = FastifyRequest & { cookies?: Record<string, string | undefined> };

export function ensureCsrfToken(
  request: FastifyRequest,
  reply: FastifyReply,
  options: CsrfOptions,
): void {
  if (!SAFE_METHODS.has(request.method.toUpperCase())) return;
  const existing = (request as WithCookies).cookies?.[CSRF_COOKIE];
  if (typeof existing === 'string' && existing !== '') return;
  reply.setCookie(CSRF_COOKIE, randomBytes(32).toString('base64url'), {
    httpOnly: false,
    secure: options.secure,
    sameSite: 'strict',
    path: '/',
  });
}

function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export function checkCsrf(
  request: FastifyRequest,
  options: CsrfOptions,
): { readonly ok: boolean; readonly reason?: string } {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return { ok: true };
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    return { ok: false, reason: 'cross-site request' };
  }
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== '' && !options.trustedOrigins.includes(origin)) {
    return { ok: false, reason: 'untrusted origin' };
  }
  const cookie = (request as WithCookies).cookies?.[CSRF_COOKIE];
  const header = request.headers[CSRF_HEADER];
  if (typeof cookie !== 'string' || cookie === '') return { ok: false, reason: 'no CSRF cookie' };
  if (typeof header !== 'string' || header === '') return { ok: false, reason: 'no CSRF header' };
  if (!tokensMatch(cookie, header)) return { ok: false, reason: 'CSRF token mismatch' };
  return { ok: true };
}
