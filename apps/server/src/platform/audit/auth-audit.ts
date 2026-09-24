import { withGlobal, withOrg, withUser } from '@elysium/db';
import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

import type { AuditOperation } from './audit.service.js';
import { AuditService } from './audit.service.js';

/**
 * Audit for the credential endpoints Better Auth owns (architecture §25, D-066).
 *
 * `/api/auth/*` never reaches a Nest controller, so neither the interceptor nor
 * any service sees it — and it is where the events an investigator asks about
 * first actually happen: who signed in, who turned a second factor on or off,
 * who redeemed an invite and set a password. These are recorded here, from the
 * Fastify bridge, after Better Auth has answered.
 *
 * **Where the row goes.** `audit.audit_log` is tenant-scoped and a sign-in
 * belongs to no org, so the event is written once into every org the user
 * holds an active membership in. Each org's admin is the person who needs to
 * see that an account able to act in their org just signed in, and no org's
 * log gains a row about a user it has never had. A user with no membership
 * (a super admin with none, say) produces no row: the pino log line is the
 * record, as it is for everything else outside a tenant.
 *
 * **What goes in it.** The event, the path, the outcome and the request
 * metadata. Never the request body: every one of these carries a password, a
 * code or a token, and redaction is the second line of defence, not the first.
 *
 * Best-effort, like the interceptor: the auth response is already decided when
 * this runs, and failing a sign-in because its audit row failed would turn a
 * database hiccup into a lock-out. Failures are logged loudly.
 */

interface AuthEvent {
  readonly action: string;
  readonly operation: AuditOperation;
}

/** The auth endpoints worth a row, and what each one means. */
export const AUDITED_AUTH_PATHS: Readonly<Record<string, AuthEvent>> = {
  '/api/auth/sign-in/email': { action: 'auth.signed_in', operation: 'login' },
  '/api/auth/sign-in/phone-number': { action: 'auth.signed_in', operation: 'login' },
  '/api/auth/two-factor/verify-totp': { action: 'auth.second_factor_verified', operation: 'login' },
  '/api/auth/two-factor/verify-backup-code': {
    action: 'auth.backup_code_used',
    operation: 'login',
  },
  '/api/auth/two-factor/enable': { action: 'auth.two_factor_enabled', operation: 'update' },
  '/api/auth/two-factor/disable': { action: 'auth.two_factor_disabled', operation: 'update' },
  '/api/auth/two-factor/generate-backup-codes': {
    action: 'auth.backup_codes_regenerated',
    operation: 'update',
  },
  '/api/auth/reset-password': { action: 'auth.password_set', operation: 'update' },
  '/api/auth/change-password': { action: 'auth.password_changed', operation: 'update' },
  '/api/auth/update-user': { action: 'auth.profile_updated', operation: 'update' },
  '/api/auth/sign-out': { action: 'auth.signed_out', operation: 'logout' },
};

/**
 * Who a reset-password call is about, read *before* Better Auth consumes the
 * token. The endpoint has no session and its response carries no user, so this
 * is the only moment the answer exists.
 */
export async function resetTokenOwner(token: unknown): Promise<string | null> {
  if (typeof token !== 'string' || token === '') return null;
  const [row] = await withGlobal(async (tx) =>
    tx.execute<{ value: string }>(sql`
      select value from iam.verifications
      where identifier = ${`reset-password:${token}`} and expires_at > now()
      limit 1
    `),
  );
  return row?.value ?? null;
}

/** Who a sign-in was for, when the response has no user (the 2FA redirect). */
async function userByEmail(email: unknown): Promise<string | null> {
  if (typeof email !== 'string' || email === '') return null;
  const [row] = await withGlobal(async (tx) =>
    tx.execute<{ id: string }>(
      sql`select id from iam.users where lower(email) = lower(${email}) limit 1`,
    ),
  );
  return row?.id ?? null;
}

/** The user id in a Better Auth JSON response, if it carries one. */
function userIdFrom(responseBody: string): string | null {
  try {
    const parsed = JSON.parse(responseBody) as { user?: { id?: unknown } } | null;
    const id = parsed?.user?.id;
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null;
  }
}

function isTwoFactorRedirect(responseBody: string): boolean {
  try {
    return (JSON.parse(responseBody) as { twoFactorRedirect?: unknown }).twoFactorRedirect === true;
  } catch {
    return false;
  }
}

export async function recordAuthEvent(input: {
  readonly request: FastifyRequest;
  readonly path: string;
  readonly status: number;
  readonly responseBody: string;
  /** The session's user before the call, or the reset token's owner. */
  readonly knownUserId: string | null;
  readonly audit?: AuditService;
}): Promise<void> {
  const event = AUDITED_AUTH_PATHS[input.path];
  if (event === undefined || input.status < 200 || input.status >= 300) return;

  const audit = input.audit ?? new AuditService();
  const redirect = isTwoFactorRedirect(input.responseBody);

  try {
    const userId =
      input.knownUserId ??
      userIdFrom(input.responseBody) ??
      (redirect
        ? await userByEmail((input.request.body as { email?: unknown } | null)?.email)
        : null);
    if (userId === null) return;

    // The first factor alone is not a sign-in when a second one is owed.
    const action = redirect ? 'auth.first_factor_passed' : event.action;

    const orgs = await withUser({ userId }, async (tx) =>
      tx.execute<{ org_id: string }>(sql`
        select distinct org_id from iam.memberships
        where user_id = ${userId} and is_active
      `),
    );

    const requestId = (input.request as FastifyRequest & { requestId?: string }).requestId ?? null;

    for (const { org_id: orgId } of orgs) {
      await withOrg({ orgId, userId }, async (tx) => {
        await audit.record(tx, {
          orgId,
          actorUserId: userId,
          operation: event.operation,
          action,
          entityType: 'User',
          entityId: userId,
          before: null,
          after: { path: input.path, status: input.status },
          ip: input.request.ip,
          userAgent: input.request.headers['user-agent'] ?? null,
          requestId,
        });
      });
    }
  } catch (error) {
    input.request.log.error({ err: error, path: input.path }, 'auth audit failed to record');
  }
}
