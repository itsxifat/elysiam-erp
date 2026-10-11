import { randomUUID } from 'node:crypto';

import { maskEmail } from '@elysium/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { recordAudit } from '../audit/audit.js';
import { mustEnrolTwoFactor, type MotherAuth } from '../auth/auth.js';
import { motherSql } from '../db/client.js';
import { checkCsrf, ensureCsrfToken, type CsrfOptions } from './csrf.js';
import { instanceOf, PROBLEM_CONTENT_TYPE, problemFor } from './errors.js';
import { checkRate, MemoryRateLimiter, requestPath } from './rate-limit.js';

/**
 * Sign-in, the second-factor wall and who is asking, in the order that makes each one hold
 * (the brand's `auth-plugin.ts`, D-051, D-056; mother copy, D-487):
 *
 *   1. CSRF, before a cookie is read for authority.
 *   2. The credential limiter, once the body names the identifier being tried.
 *   3. The enrolment wall inside `/api/auth`: a session without a second factor may only
 *      enrol it (or sign out).
 *   4. Better Auth's handler, which audits each sign-in and strips the session token from
 *      every body.
 *   5. For every other route: the session, then the wall, then `request.owner`.
 */

export interface Owner {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  /** The session this request came from: My account's "this device" (D-704). */
  readonly sessionId: string;
}

export type OwnerRequest = FastifyRequest & {
  owner?: Owner;
  requestId?: string;
};

export interface AuthPluginOptions extends CsrfOptions {
  readonly auth: MotherAuth;
  readonly limiter?: MemoryRateLimiter;
  readonly rateLimitEnabled?: boolean;
}

const ENROLMENT_PATHS = new Set([
  '/api/auth/two-factor/enable',
  '/api/auth/two-factor/verify-totp',
  '/api/auth/two-factor/verify-backup-code',
  '/api/auth/get-session',
  '/api/auth/sign-out',
]);

/**
 * How stale a session's `last_active_at` may get (D-704): one write a minute per session
 * at most, however many requests it makes.
 */
const ACTIVITY_GRANULARITY_SECONDS = 60;

/**
 * Signing in again and the password links prove who the caller is afresh, so a half-enrolled
 * session left in the browser never walls them (the brand's lockout of 2026-10-07): the new
 * session is walled again until the factor is real.
 */
const CREDENTIAL_PATHS = new Set([
  '/api/auth/sign-in/email',
  '/api/auth/reset-password',
  '/api/auth/request-password-reset',
  '/api/auth/forget-password',
]);

/**
 * The second factor is asked at every sign-in (D-487): Better Auth's `trustDevice` would set
 * a 30-day cookie that skips it, renewed on each use, on a console holding every brand's keys.
 */
function withoutTrustDevice(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const { trustDevice: _ignored, ...rest } = body as Record<string, unknown>;
  return rest;
}

function enrolmentRequired(reply: FastifyReply, url: string): FastifyReply {
  return reply
    .status(403)
    .header('content-type', PROBLEM_CONTENT_TYPE)
    .send(
      problemFor({
        status: 403,
        code: 'TWO_FACTOR_ENROLMENT_REQUIRED',
        detail: 'Set up two-step sign-in before anything else.',
        instance: instanceOf(url),
      }),
    );
}

function headersOf(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(', '));
  }
  return headers;
}

/** Remove the session token from a Better Auth body: the cookie is httpOnly for a reason. */
export function withoutSessionToken(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return body;
  const record = { ...(parsed as Record<string, unknown>) };
  let changed = false;
  if ('token' in record) {
    delete record.token;
    changed = true;
  }
  const session = record.session;
  if (typeof session === 'object' && session !== null && 'token' in session) {
    const { token: _token, ...rest } = session as Record<string, unknown>;
    record.session = rest;
    changed = true;
  }
  return changed ? JSON.stringify(record) : body;
}

/** The audit row a credential call leaves (D-487). */
async function auditAuthCall(input: {
  readonly path: string;
  readonly status: number;
  readonly body: string;
  readonly attemptedEmail: string | null;
  readonly knownUserId: string | null;
  readonly ip: string;
  readonly requestId: string;
}): Promise<void> {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(input.body) as unknown;
    if (typeof value === 'object' && value !== null) parsed = value as Record<string, unknown>;
  } catch {
    // Not JSON: nothing to read the user from.
  }
  const user = parsed.user as { id?: unknown } | undefined;
  const userId = typeof user?.id === 'string' ? user.id : input.knownUserId;
  const ok = input.status >= 200 && input.status < 300;
  let action: string | null;
  const detail: Record<string, unknown> = {};
  switch (input.path) {
    case '/api/auth/sign-in/email':
      if (!ok) {
        action = 'auth.sign_in.failed';
        if (input.attemptedEmail !== null) detail.email = maskEmail(input.attemptedEmail);
      } else if (parsed.twoFactorRedirect === true) {
        action = 'auth.sign_in.password_accepted';
      } else {
        action = 'auth.sign_in.succeeded';
        detail.secondFactor = 'not_enrolled';
      }
      break;
    case '/api/auth/two-factor/verify-totp':
    case '/api/auth/two-factor/verify-backup-code':
      action = ok ? 'auth.sign_in.succeeded' : 'auth.two_factor.failed';
      detail.method = input.path.endsWith('backup-code') ? 'backup_code' : 'totp';
      break;
    case '/api/auth/two-factor/enable':
      action = ok ? 'auth.two_factor.enrolment_started' : null;
      break;
    case '/api/auth/two-factor/disable':
      action = ok ? 'auth.two_factor.disabled' : null;
      break;
    case '/api/auth/reset-password':
      action = ok ? 'auth.password_set' : 'auth.password_set.failed';
      break;
    case '/api/auth/sign-out':
      action = ok ? 'auth.signed_out' : null;
      break;
    default:
      action = null;
  }
  if (action === null) return;
  if (action === 'auth.sign_in.succeeded' && userId !== null) {
    await motherSql()`update auth.users set last_sign_in_at = now() where id = ${userId}`;
  }
  await recordAudit({
    actorUserId: userId,
    action,
    entityType: 'person',
    entityId: userId,
    detail,
    ipAddress: input.ip,
    requestId: input.requestId,
  });
}

export function registerAuth(app: FastifyInstance, options: AuthPluginOptions): void {
  const limiter = options.limiter ?? new MemoryRateLimiter();

  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done) => {
    (request as OwnerRequest).requestId = randomUUID();
    const csrf = checkCsrf(request, options);
    if (!csrf.ok) {
      void reply
        .status(403)
        .header('content-type', PROBLEM_CONTENT_TYPE)
        .send(
          problemFor({
            status: 403,
            code: 'FORBIDDEN',
            detail: `CSRF check failed: ${csrf.reason ?? 'unknown'}`,
            instance: instanceOf(request.url),
          }),
        );
      return;
    }
    ensureCsrfToken(request, reply, options);
    done();
  });

  // Every response: nothing here is a page to frame, sniff or cache (the brand's D-349).
  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('x-frame-options', 'DENY');
    void reply.header('referrer-policy', 'no-referrer');
    void reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store');
    if (options.secure) {
      void reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    done(null, payload);
  });

  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (options.rateLimitEnabled === false) return;
    const decision = checkRate(limiter, { url: request.url, ip: request.ip, body: request.body });
    if (decision.allowed) return;
    request.log.warn({ path: requestPath(request.url), bucket: decision.bucket }, 'rate limited');
    return reply
      .status(429)
      .header('retry-after', String(decision.retryAfterSeconds ?? 60))
      .header('content-type', PROBLEM_CONTENT_TYPE)
      .send(
        problemFor({
          status: 429,
          code: 'RATE_LIMITED',
          detail: 'Too many attempts. Wait a minute and try again.',
          instance: instanceOf(request.url),
        }),
      );
  });

  // The wall inside /api/auth: a session without a factor may only enrol it.
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = requestPath(request.url);
    if (!path.startsWith('/api/auth/') || ENROLMENT_PATHS.has(path)) return;
    if (CREDENTIAL_PATHS.has(path)) return;
    const session = await options.auth.api.getSession({ headers: headersOf(request) });
    if (session === null) return;
    if (await mustEnrolTwoFactor(session.user.id)) return enrolmentRequired(reply, request.url);
  });

  app.all('/api/auth/*', async (request, reply) => {
    const url = new URL(
      request.url,
      `${request.protocol}://${request.headers.host ?? 'localhost'}`,
    );
    // The router and Better Auth must read one path the same way (the brand's M30 lesson).
    if ((request.url.split('?')[0] ?? '') !== url.pathname) {
      return reply
        .status(404)
        .header('content-type', PROBLEM_CONTENT_TYPE)
        .send(problemFor({ status: 404, code: 'NOT_FOUND', instance: url.pathname }));
    }
    const headers = headersOf(request);
    // Better Auth's own limiter and session rows see the address Fastify resolved.
    headers.set('x-forwarded-for', request.ip);
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    if (hasBody) headers.set('content-type', 'application/json');

    // Who a sign-out or an enrolment is about, before Better Auth acts on it.
    let knownUserId: string | null = null;
    if (url.pathname !== '/api/auth/sign-in/email' && url.pathname !== '/api/auth/reset-password') {
      const session = await options.auth.api.getSession({ headers: headersOf(request) });
      knownUserId = session?.user.id ?? null;
    }
    const attempted = (request.body as { email?: unknown } | null)?.email;

    const response = await options.auth.handler(
      new Request(url, {
        method: request.method,
        headers,
        ...(hasBody ? { body: JSON.stringify(withoutTrustDevice(request.body ?? {})) } : {}),
      }),
    );
    const text = await response.text();
    if (request.method === 'POST') {
      await auditAuthCall({
        path: url.pathname,
        status: response.status,
        body: text,
        attemptedEmail: typeof attempted === 'string' ? attempted.trim().toLowerCase() : null,
        knownUserId,
        ip: request.ip,
        requestId: (request as OwnerRequest).requestId ?? '',
      });
    }
    void reply.status(response.status);
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'content-length') return;
      void reply.header(key, value);
    });
    return reply.send(withoutSessionToken(text));
  });

  // Everything else: the session, the wall, the owner.
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = requestPath(request.url);
    if (path === '/api/auth' || path.startsWith('/api/auth/')) return;
    const session = await options.auth.api.getSession({ headers: headersOf(request) });
    if (session === null) return;
    if (await mustEnrolTwoFactor(session.user.id)) return enrolmentRequired(reply, request.url);
    (request as OwnerRequest).owner = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      sessionId: session.session.id,
    };
    await motherSql()`
      update auth.sessions set last_active_at = now()
      where id = ${session.session.id}
        and last_active_at < now() - make_interval(secs => ${ACTIVITY_GRANULARITY_SECONDS})
    `;
  });
}
