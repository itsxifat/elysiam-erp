import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';

/**
 * The session an owner sign-in link opens (M31, D-473).
 *
 * The link itself — its signature, audience, expiry and single use — is checked by the
 * server's owner-link route before it gets here. This is only the last step, made inside
 * Better Auth so the session row and its cookie are exactly what a password sign-in makes:
 * the same signed `session_token` cookie with the same domain, `Secure` and `SameSite`, and
 * the same `session.create` hook (`mayHoldSession`) on the way in.
 *
 * Two things differ, and both are the point:
 *
 * - **Two hours, never extended.** The row expires two hours after it is made, and the
 *   cookie is a "don't remember me" one, which Better Auth never refreshes. The server
 *   also refuses an owner-link session older than two hours whatever its row says
 *   (`resolveIdentity`), so a client that drops the "don't remember" cookie to win a
 *   refresh gains nothing.
 * - **`ownerLink`.** The second factor was checked where the link was minted; the
 *   enrolment wall reads this flag and lets the session through.
 *
 * The endpoint is **server-only** (`SERVER_ONLY`): Better Auth's router never mounts it, so
 * no HTTP request can reach it. It is called as `auth.api.createOwnerSession` by the owner
 * link route, and nowhere else.
 */

export const OWNER_SESSION_SECONDS = 2 * 60 * 60;

const bodySchema = z.object({
  userId: z.string().min(1),
  /** The brand the owner arrives in, so the console opens on it. */
  activeOrgId: z.string().uuid().nullable(),
});

export function ownerSession() {
  return {
    id: 'owner-session',
    endpoints: {
      createOwnerSession: createAuthEndpoint(
        '/owner-session',
        { method: 'POST', body: bodySchema, metadata: { SERVER_ONLY: true } },
        async (ctx) => {
          const user = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
          if (user === null) throw new APIError('UNAUTHORIZED');
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
            // "Don't remember me": a browser-session cookie that Better Auth never refreshes.
            true,
            {
              expiresAt: new Date(Date.now() + OWNER_SESSION_SECONDS * 1000),
              ownerLink: true,
              activeOrgId: ctx.body.activeOrgId,
            },
            // Without it the library's own expiry and defaults would overwrite these.
            true,
          );
          await setSessionCookie(ctx, { session, user }, true);
          return ctx.json({ sessionId: session.id, expiresAt: session.expiresAt.toISOString() });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
