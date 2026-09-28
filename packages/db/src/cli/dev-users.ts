/**
 * Local sign-in users for driving the console by hand.
 *
 * `db:seed` creates organizations, branches and a chart of accounts but no people,
 * because in this system a person is created by an org_admin through an invite
 * (`POST /v1/users`) and redeems it to set their own password — self-service
 * sign-up is disabled on purpose (packages/db/src/auth/index.ts explains the
 * account pre-hijacking it once allowed). That leaves a fresh development database
 * with nobody who can sign in, and a console that can only be looked at through
 * mocked API responses.
 *
 * This walks the same invite flow the HTTP test harness does — request a reset,
 * redeem the token, done — but in-process through Better Auth's own API, so the
 * password is hashed by the library and never by hand-written code here.
 *
 * Deliberately limited:
 *
 * - **Local databases only.** It refuses unless the database host is
 *   `localhost`, `127.0.0.1` or `::1`, and refuses outright when
 *   `NODE_ENV=production`. A script that sets passwords is exactly the thing that
 *   must never be pointed at a real brand's data by a mistyped variable.
 * - **Roles that need no second factor.** §6 requires 2FA for org_admin, accounts,
 *   investor and super admin, and the enrolment wall would stop a browser session
 *   at the first screen. hr, warehouse, branch_manager and sales between them
 *   reach most of the console and show that navigation narrows per role.
 * - **No secret in the repository.** The password is random per run and written
 *   only to `packages/db/.dev-users.local.json`, which is gitignored (invariant 10).
 *   Re-running rotates it.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { sql } from 'drizzle-orm';

import { createAuth, RecordingSmsProvider } from '../auth/index.js';
import { currentDatabaseConfig, withGlobal, withSystem } from '../client.js';
import { grantMembership } from '../iam/fixtures.js';
import { SEED_ORG_IDS } from '../seed/orgs.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** One user per role, all in the first brand. The first brand is where the seed puts a branch. */
const PEOPLE = [
  { role: 'hr', email: 'dev.hr@elysium.test', name: 'Dev HR' },
  { role: 'warehouse', email: 'dev.warehouse@elysium.test', name: 'Dev Warehouse' },
  { role: 'branch_manager', email: 'dev.branch@elysium.test', name: 'Dev Branch Manager' },
  { role: 'sales', email: 'dev.sales@elysium.test', name: 'Dev Sales' },
] as const;

const OUTPUT = path.resolve(process.cwd(), '.dev-users.local.json');

function assertLocal(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('dev-users: refusing to run with NODE_ENV=production.');
  }
  const host = new URL(currentDatabaseConfig().DATABASE_URL).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`dev-users: refusing to run against ${host}; this sets passwords.`);
  }
}

async function main(): Promise<void> {
  assertLocal();

  const orgId = SEED_ORG_IDS['elysium-lifestyle-bd'];
  if (orgId === undefined) throw new Error('dev-users: run `pnpm db:seed` first.');

  const branchId = await withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        sql`select id from org.branches where org_id = ${orgId} order by code limit 1`,
      );
      return rows[0]?.id;
    },
    { orgId },
  );
  if (branchId === undefined) throw new Error('dev-users: the first brand has no branch.');

  // Captured in-process: this is the channel M16's email adapter will replace, and
  // until then it is how the harness redeems an invite too.
  const tokens = new Map<string, string>();
  const { auth } = createAuth({
    baseUrl: process.env.API_PUBLIC_URL ?? 'http://localhost:3000',
    secret: process.env.AUTH_SECRET ?? randomBytes(32).toString('hex'),
    trustedOrigins: ['http://localhost:5173'],
    sms: new RecordingSmsProvider(),
    onPasswordToken: ({ email, token }) => {
      tokens.set(email, token);
      return Promise.resolve();
    },
  });

  const password = randomBytes(18).toString('base64url');

  for (const person of PEOPLE) {
    const userId = await withGlobal(async (tx) => {
      const existing = await tx.execute<{ id: string }>(
        sql`select id from iam.users where email = ${person.email}`,
      );
      if (existing[0] !== undefined) return existing[0].id;
      const id = `usr_dev_${person.role}`;
      await tx.execute(sql`
        insert into iam.users (id, email, name, email_verified)
        values (${id}, ${person.email}, ${person.name}, true)
      `);
      return id;
    });

    const hasMembership = await withSystem(
      async (tx) => {
        const rows = await tx.execute<{ n: number }>(sql`
          select count(*)::int as n from iam.memberships
          where user_id = ${userId} and org_id = ${orgId} and role = ${person.role}
        `);
        return (rows[0]?.n ?? 0) > 0;
      },
      { orgId },
    );
    if (!hasMembership) {
      await grantMembership({
        userId,
        orgId,
        role: person.role,
        // A branch manager's reach *is* a branch; without one every screen would be
        // empty and would look like a bug rather than a scope.
        ...(person.role === 'branch_manager' ? { branchIds: [branchId] } : {}),
      });
    }

    await auth.api.requestPasswordReset({
      body: { email: person.email, redirectTo: '/accept-invite' },
    });
    const token = tokens.get(person.email);
    if (token === undefined) throw new Error(`dev-users: no reset token for ${person.email}.`);
    await auth.api.resetPassword({ body: { newPassword: password, token } });
  }

  writeFileSync(
    OUTPUT,
    `${JSON.stringify(
      {
        note: 'Local development sign-ins. Gitignored; regenerated on every run.',
        password,
        users: PEOPLE.map(({ role, email }) => ({ role, email })),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  // The path, never the password: this line lands in terminals and logs.
  console.log(`dev-users — ${PEOPLE.length} users ready; credentials in ${OUTPUT}`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
