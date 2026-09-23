import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { isTrustedOrigin } from './origins.js';

/**
 * CSRF for cookie-authenticated mutations (architecture §25).
 *
 * Two independent checks, because each covers the other's gap:
 *
 * 1. **Origin.** Browsers set it on every cross-site request and it cannot be
 *    forged by page script. It is the stronger check — but it is absent on
 *    some same-origin requests and on a few older clients, so it cannot be the
 *    only one.
 * 2. **Double-submit token.** A random value sent as both a readable cookie
 *    and a header. An attacker's page can cause the cookie to be *sent*, but
 *    cannot read it to echo it back in the header, because that would need to
 *    read a cookie from another origin.
 *
 * The session cookie is `SameSite=Lax`, which already blocks cross-site POSTs.
 * This is the layer underneath, for when that assumption fails: a browser bug,
 * a `<form>` navigation that Lax permits, or a future need to relax SameSite
 * for the Chatwoot iframe.
 */

export const CSRF_COOKIE = 'elysium_csrf';
export const CSRF_HEADER = 'x-elysium-csrf';

/** Methods that cannot change state, so cannot be the target of CSRF. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface CsrfOptions {
  /** Exact origins, brand hostnames already expanded (see origins.ts). */
  readonly trustedOrigins: readonly string[];
  /** Scoped to the parent domain, like the session cookie (§6). */
  readonly cookieDomain?: string | undefined;
  readonly secure?: boolean;
}

/**
 * Hand out a token on any safe request that arrives without one.
 *
 * Unconditional on purpose. It used to be issued only on *unauthenticated*
 * requests outside /api/auth, which left two holes: a client had no way to get
 * a token before its first sign-in POST, and a session that outlived its CSRF
 * cookie could never mutate again with no way to recover. Safe methods cannot
 * be the target of CSRF, so replenishing on one costs nothing.
 */
export function ensureCsrfToken(
  request: FastifyRequest,
  reply: FastifyReply,
  options: CsrfOptions,
): void {
  if (!SAFE_METHODS.has(request.method.toUpperCase())) return;

  const cookies = (request as FastifyRequest & { cookies?: Record<string, string | undefined> })
    .cookies;
  if (typeof cookies?.[CSRF_COOKIE] === 'string' && cookies[CSRF_COOKIE] !== '') return;

  issueCsrfToken(reply, options);
}

export function issueCsrfToken(reply: FastifyReply, options: CsrfOptions): string {
  const token = randomBytes(32).toString('base64url');

  reply.setCookie(CSRF_COOKIE, token, {
    // Readable by the client on purpose: the whole double-submit mechanism
    // depends on our own script being able to echo it into a header, which an
    // attacker's page on another origin cannot do.
    httpOnly: false,
    secure: options.secure ?? true,
    sameSite: 'lax',
    path: '/',
    ...(options.cookieDomain === undefined ? {} : { domain: options.cookieDomain }),
  });

  return token;
}

/** Constant-time compare, so a token cannot be discovered a character at a time. */
function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

export interface CsrfResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export function checkCsrf(request: FastifyRequest, options: CsrfOptions): CsrfResult {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return { ok: true };

  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    // Through the shared matcher, so CORS, Better Auth and this check cannot
    // disagree about which origins are ours (origins.ts).
    if (!isTrustedOrigin(origin, options)) {
      return { ok: false, reason: `origin ${origin} is not trusted` };
    }
  }

  const cookies = (request as FastifyRequest & { cookies?: Record<string, string | undefined> })
    .cookies;
  const cookieToken = cookies?.[CSRF_COOKIE];
  const headerToken = request.headers[CSRF_HEADER];

  if (typeof cookieToken !== 'string' || cookieToken === '') {
    return { ok: false, reason: 'no CSRF cookie' };
  }
  if (typeof headerToken !== 'string' || headerToken === '') {
    return { ok: false, reason: `no ${CSRF_HEADER} header` };
  }
  if (!tokensMatch(cookieToken, headerToken)) {
    return { ok: false, reason: 'CSRF token mismatch' };
  }

  return { ok: true };
}
