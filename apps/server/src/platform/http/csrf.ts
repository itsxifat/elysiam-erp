import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

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
 *
 * **The token is signed, and that is not decoration.** Plain double-submit
 * assumes an attacker cannot set our cookie — and on this domain that
 * assumption does not hold. Cookies ignore ports and are scoped by *domain*,
 * so any host under `<APP_DOMAIN>` can write a `elysium_csrf` cookie for the
 * parent, and "same-site" includes subdomains, so `SameSite=Lax` still sends
 * the session cookie on a form POST from one. That is the exact threat D-054
 * describes — landing sites on Vercel (D-026), Chatwoot on the parent (§16),
 * and a dangling CNAME turning a subdomain takeover into an ERP takeover. CORS
 * does not help here, because a form POST is not a CORS request.
 *
 * Signing closes it: an attacker can plant a cookie and echo it in a header,
 * but cannot produce `HMAC(AUTH_SECRET, value)`, so the pair is rejected
 * before the two are even compared.
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
  /**
   * The key the token is signed with — `AUTH_SECRET`.
   *
   * Required. An optional signing key is one that is absent in the environment
   * that matters, and "unsigned" is indistinguishable from "signed" at a
   * glance in a log or a test.
   */
  readonly secret: string;
}

/** `<random>.<hmac>`; both halves base64url, neither of use without the other. */
function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

/**
 * Is this a token we issued?
 *
 * Checked before the cookie and header are compared, because a planted cookie
 * matches a planted header perfectly — the comparison is only meaningful once
 * both are known to be ours.
 */
function isSigned(token: string, secret: string): boolean {
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return false;

  const value = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  return tokensMatch(signature, sign(value, secret));
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
  const value = randomBytes(32).toString('base64url');
  const token = `${value}.${sign(value, options.secret)}`;

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

  /*
   * `Sec-Fetch-Site`, which closes the gap a missing `Origin` leaves.
   *
   * The origin check above is skipped entirely when the header is absent, and
   * a form navigation is one of the cases where a browser may omit it. Every
   * browser that omits it in that case sends this one instead, and page script
   * cannot set either — both are forbidden header names.
   *
   * Only `cross-site` is refused. `same-origin` and `same-site` are ours by
   * definition, and `none` means the user typed the URL or used a bookmark,
   * which is not an attack. An absent header means an older client, and the
   * signed double-submit below still applies.
   */
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') {
    return { ok: false, reason: 'cross-site request' };
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

  // Ours, before equal. A cookie planted by a sibling host under this domain
  // matches a header the same page set perfectly, so comparing first and
  // authenticating second would accept the pair.
  if (!isSigned(cookieToken, options.secret)) {
    return { ok: false, reason: 'CSRF cookie was not issued by this server' };
  }

  if (!tokensMatch(cookieToken, headerToken)) {
    return { ok: false, reason: 'CSRF token mismatch' };
  }

  return { ok: true };
}
