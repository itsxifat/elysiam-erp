import { randomUUID } from 'node:crypto';

import { INVITE_LINK_SECONDS, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { AuditService } from '../../platform/audit/audit.service.js';
import { mintLink } from './users.repository.js';

/**
 * The first super admin on a brand-new database (M30).
 *
 * Every other person is invited by someone who is already an admin (D-057, D-402), so the
 * first one has to come from somewhere else. Before this the deploy runbook said "create
 * the first super admin with the invite flow", which needs an admin, and `db:dev-users`
 * refuses anything but a local database. Production had no supported way in.
 *
 * This is that way, run by the operator on the server (`pnpm admin:bootstrap`):
 *
 * * **Once.** It refuses if any super admin exists, active or not, under a transaction-level
 *   advisory lock, so two operators running it at once make one person. A second admin is
 *   invited from the Staff screen like everyone else.
 * * **Through the invite path.** The person row, the flag and a one-time link are written in
 *   one transaction as the owner role. The owner role is the only one that may set the flag
 *   (D-094's trigger). The link is the same kind `POST /v1/users` mints: a Better Auth
 *   password token, valid 72 hours (D-402), redeemed at `/accept-invite`. No password ever
 *   passes through this process or its arguments.
 * * **Audited** in every brand's log, because a super admin reaches every brand.
 * * **Refusing a known address.** An existing account is not promoted. Making a person a
 *   super admin is a decision with its own audit trail, not a side effect of a typo.
 */

export const BOOTSTRAP_ACTOR = 'system:admin-bootstrap';

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(200),
  consoleUrl: z.string().url(),
});

export type BootstrapInput = z.input<typeof inputSchema>;

export interface BootstrapResult {
  readonly userId: string;
  readonly email: string;
  /** `<console>/accept-invite#token=…`: one use, until `expiresAt`. */
  readonly link: string;
  readonly expiresAt: Date;
  readonly auditedOrgs: number;
}

export class BootstrapRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapRefused';
  }
}

/**
 * Where the console is, for the link: `--console-url`, else `CONSOLE_PUBLIC_URL`, else the
 * first trusted origin (the console is listed first in every deploy file), else the API's
 * own origin (the preview serves both from one host).
 */
export function consoleUrlFrom(
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const candidates = [
    flag,
    env.CONSOLE_PUBLIC_URL,
    env.TRUSTED_ORIGINS?.split(',')[0]?.trim(),
    env.API_PUBLIC_URL === undefined ? undefined : new URL(env.API_PUBLIC_URL).origin,
  ];
  const found = candidates.find((value) => value !== undefined && value !== '');
  if (found === undefined) {
    throw new BootstrapRefused(
      'No console address: pass --console-url, or set CONSOLE_PUBLIC_URL or TRUSTED_ORIGINS.',
    );
  }
  return found;
}

/** The link the person opens. The token rides in the fragment, which no server logs. */
export function inviteLink(consoleUrl: string, token: string): string {
  const base = consoleUrl.replace(/\/+$/, '');
  return `${base}/accept-invite#token=${encodeURIComponent(token)}`;
}

export async function bootstrapSuperAdmin(raw: BootstrapInput): Promise<BootstrapResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BootstrapRefused(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  const input = parsed.data;
  const audit = new AuditService();

  return withSystem(async (tx) => {
    // One at a time, so "no super admin exists" cannot be true for two runs at once.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('iam.admin-bootstrap'))`);

    const admins = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from iam.users where is_super_admin`,
    );
    if ((admins[0]?.n ?? 0) > 0) {
      throw new BootstrapRefused(
        'A super admin already exists. Invite people from the Staff screen instead; a lost ' +
          'super admin is reset by another one (D-405).',
      );
    }
    const taken = await tx.execute<{ id: string }>(
      sql`select id from iam.users where lower(email) = ${input.email}`,
    );
    if (taken.length > 0) {
      throw new BootstrapRefused(
        'An account with that email already exists. Choose another address: this command ' +
          'does not promote an existing account.',
      );
    }
    const orgs = await tx.execute<{ id: string }>(
      sql`select id from org.organizations order by slug`,
    );
    if (orgs.length === 0) {
      throw new BootstrapRefused('No brands yet. Run `pnpm db:seed` first.');
    }

    const userId = `usr_${randomUUID()}`;
    await tx.execute(sql`
      insert into iam.users (id, email, name, email_verified, is_super_admin)
      values (${userId}, ${input.email}, ${input.name}, true, true)
    `);
    const minted = await mintLink(tx, userId, INVITE_LINK_SECONDS);

    for (const org of orgs) {
      await tx.execute(sql`select set_config('app.org_id', ${org.id}, true)`);
      await audit.record(tx, {
        orgId: org.id,
        actorUserId: null,
        operation: 'create',
        action: 'iam.super_admin.bootstrapped',
        entityType: 'User',
        entityId: userId,
        before: null,
        after: {
          email: input.email,
          name: input.name,
          isSuperAdmin: true,
          by: BOOTSTRAP_ACTOR,
          inviteExpiresAt: minted.expiresAt.toISOString(),
        },
        requestId: null,
      });
    }
    await tx.execute(sql`select set_config('app.org_id', '', true)`);

    return {
      userId,
      email: input.email,
      link: inviteLink(input.consoleUrl, minted.token),
      expiresAt: minted.expiresAt,
      auditedOrgs: orgs.length,
    };
  });
}
