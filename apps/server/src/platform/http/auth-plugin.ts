import { randomUUID } from 'node:crypto';

import { mustEnrolTwoFactor, resolveContext, withSystem } from '@elysium/db';
import type { createAuth, RequestContext } from '@elysium/db';
import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { checkCsrf, ensureCsrfToken, type CsrfOptions } from './csrf.js';

/**
 * Mount authentication and build the request context (architecture §6, §25).
 *
 * Order matters and is the whole point of this file:
 *
 *   1. CSRF, before anything reads a cookie for authority.
 *   2. Better Auth's own handler on /api/auth/*, which owns sign-in, 2FA and
 *      OTP.
 *   3. Session resolution, then the 2FA enrolment wall, then the context.
 *
 * Step 2 sits above step 3 on purpose: /api/auth is the one prefix the wall
 * must not cover, because enrolling the missing second factor happens there.
 *
 * The context is rebuilt per request from the session's `active_org_id` rather
 * than cached, because a membership can be revoked while a session lives.
 */
export interface AuthPluginOptions extends CsrfOptions {
  readonly auth: ReturnType<typeof createAuth>['auth'];
}

export function registerAuth(app: FastifyInstance, options: AuthPluginOptions): void {
  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done) => {
    // One id per request, carried into the database as app.request_id so a
    // slow query can be traced back to the request that caused it (§26).
    (request as FastifyRequest & { requestId?: string }).requestId = randomUUID();

    const csrf = checkCsrf(request, options);
    if (!csrf.ok) {
      void reply.status(403).send({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: `CSRF check failed: ${csrf.reason ?? 'unknown'}`,
      });
      return;
    }

    // Replenish here, not in the session hook: the very first request a client
    // makes is a GET it has no token for, and that is exactly where it must be
    // able to pick one up.
    ensureCsrfToken(request, reply, options);
    done();
  });

  // Better Auth speaks Fetch Request/Response; Fastify speaks its own. This is
  // the only place the two meet.
  app.all('/api/auth/*', async (request, reply) => {
    const url = new URL(
      request.url,
      `${request.protocol}://${request.headers.host ?? 'localhost'}`,
    );
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(', '));
    }

    const response = await options.auth.handler(
      new Request(url, {
        method: request.method,
        headers,
        ...(request.method === 'GET' || request.method === 'HEAD'
          ? {}
          : { body: JSON.stringify(request.body ?? {}) }),
      }),
    );

    void reply.status(response.status);
    response.headers.forEach((value, key) => {
      void reply.header(key, value);
    });
    return reply.send(await response.text());
  });

  /** Resolve the session, then the context, for everything that is not /api/auth. */
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.startsWith('/api/auth')) return;

    const headers = new Headers();
    const cookie = request.headers.cookie;
    if (typeof cookie === 'string') headers.set('cookie', cookie);

    const session = await options.auth.api.getSession({ headers });
    if (session === null) {
      // Unauthenticated is not an error here: the login-branding and health
      // routes are deliberately open. The route decides.
      return;
    }

    const typed = request as FastifyRequest & {
      authUser?: { id: string; email: string };
      authSessionId?: string;
      context?: RequestContext;
      requestId?: string;
    };

    typed.authUser = { id: session.user.id, email: session.user.email };
    typed.authSessionId = session.session.id;

    // The enrolment wall (§6). A privileged role holds a session but may do
    // nothing with it until a second factor exists — everything outside
    // /api/auth, which this hook already skipped, is refused. No context is
    // built either, so even a route that forgot its guard sees no org.
    if (await mustEnrolTwoFactor(session.user.id)) {
      return reply.status(403).send({
        type: 'about:blank',
        title: 'Two-factor enrolment required',
        status: 403,
        code: 'TWO_FACTOR_ENROLMENT_REQUIRED',
        detail:
          'This role requires a second factor. Enrol at /api/auth/two-factor/enable, then verify it, before using the API.',
      });
    }

    const [row] = await withSystem(async (tx) =>
      tx.execute<{ active_org_id: string | null }>(
        sql`select active_org_id from iam.sessions where id = ${session.session.id}`,
      ),
    );

    const orgId = row?.active_org_id ?? null;
    if (orgId !== null) {
      // Re-read per request. A session outlives a membership change, and this
      // is the only place that notices.
      const context = await resolveContext({
        userId: session.user.id,
        orgId,
        requestId: typed.requestId ?? randomUUID(),
      });
      if (context !== null) typed.context = context;
    }
  });
}
