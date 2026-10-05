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

export const CSRF_COOKIE = 'erp_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** Methods that cannot change state, so cannot be the target of CSRF. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Routes whose authority is a signed token rather than a cookie (§22, M04).
 *
 * CSRF exists to stop *the session cookie* being used as authority by a page
 * the user did not intend to be acting for them. A route that never reads a
 * cookie has nothing for it to protect: `/v1/files/content` is reached with a
 * short-lived token the server minted for one storage key and one method, and
 * it acts as the bearer of that token, not as whoever happens to be signed in.
 * Requiring a CSRF header there would mean a presigned PUT — the request a
 * browser makes straight to object storage — could not be served by the local
 * driver at all, so development and tests would exercise a different upload
 * flow from the one production runs. That is the failure this list prevents.
 *
 * Keep it short, and keep the bar exact: a route belongs here only if it takes
 * no authority whatsoever from cookies. The moment one reads a session, it
 * needs the check back.
 */
const BEARER_TOKEN_PATHS: readonly string[] = ['/v1/files/content'];

function isBearerTokenRoute(url: string): boolean {
  // Compared against the path alone: the token travels in the query string,
  // and `startsWith` on the raw URL would let `/v1/files/contentious` through.
  const path = url.split('?')[0] ?? '';
  return BEARER_TOKEN_PATHS.includes(path);
}

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

/**
 * Routes called by another server, which authenticates with a signature and has no cookie.
 *
 * CSRF is an attack on cookie authority: a hostile page makes the victim's browser send
 * a request the victim's cookie authorises. These routes take no authority from a cookie
 * — the public intake is authenticated by a site key and an HMAC over the body (M11), a
 * courier webhook by the courier's shared secret (M12), the website's writes by a website
 * key's HMAC and SSLCommerz's IPN by nothing but the gateway's own validation (M34) — so
 * there is nothing for a forged
 * browser request to borrow, and a landing page's server or a courier has no way to
 * obtain the double-submit token at all. Without this both answered 403 to every real
 * caller while passing in their own harnesses.
 *
 * A prefix list, kept short and explicit: a handler under one of these prefixes must
 * never read the session. Both are `@Public`, which the route gate enforces.
 */
const SIGNED_MACHINE_PREFIXES = [
  '/public/v1/',
  '/v1/courier/webhooks/',
  // M34: the brand website's server, signed with a website key over the body (D-506), and
  // SSLCommerz's IPN, whose content is believed only after the gateway's validation API.
  '/storefront/v1/',
  '/storefront/ipn/',
  // M35b: ncom.bd's connector, order intake and webhook, signed with the brand's ncom secrets
  // over the raw body (D-553); and the packing scanner's device routes, which take their
  // authority from a bearer device token, never from a cookie (D-554).
  '/ncom/',
  '/v1/scanner/sign-in',
  '/v1/scanner/sign-out',
] as const;

function isSignedMachineRoute(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return SIGNED_MACHINE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function checkCsrf(request: FastifyRequest, options: CsrfOptions): CsrfResult {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return { ok: true };
  if (isBearerTokenRoute(request.url)) return { ok: true };
  if (isSignedMachineRoute(request.url)) return { ok: true };

  /*
   * Fetch metadata (M02a follow-up).
   *
   * A browser marks every request with `Sec-Fetch-Site`, and page script
   * cannot set it. `cross-site` means another registrable domain started this
   * request — and D-053 already requires every app of ours to share the API's
   * registrable domain, so none of ours is ever cross-site. It closes the case
   * the Origin check below cannot see: a browser request that arrives with no
   * Origin header at all. Absent (curl, a server, an old browser) falls through
   * to the checks below, which still hold.
   */
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') {
    return { ok: false, reason: 'cross-site request' };
  }

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
