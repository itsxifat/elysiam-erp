import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { phoneNumber, twoFactor } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { currentDatabaseConfig, withUser } from '../client.js';
import { requireUrl } from '../config.js';
import * as schema from '../schema/index.js';
import {
  accounts,
  memberships,
  sessions,
  twoFactors,
  users,
  verifications,
} from '../schema/iam/index.js';

/**
 * Authentication (architecture §6, §25).
 *
 * Better Auth owns the credential and session mechanics; we own the tables, so
 * that RLS, grants and the tenancy guard apply to them like everything else.
 * Its expected field names were read out of the library with `getAuthTables()`
 * rather than copied from documentation, and the Drizzle adapter maps its
 * camelCase models onto our snake_case columns.
 *
 * Two things here are ours rather than the library's, and both matter:
 *
 * - **2FA is required, not offered**, for super_admin, org_admin, accounts and
 *   investor (§6). Enforced when a session is issued, so a privileged user who
 *   has not enrolled cannot get a usable session at all.
 * - **Rate limits are per identifier as well as per IP** (§25). Per-IP alone is
 *   close to useless against a botnet, and actively harmful in Bangladesh where
 *   most mobile traffic shares a handful of carrier NAT addresses — one
 *   attacker would lock out a whole network.
 */

/** Roles that cannot hold a session without a second factor (§6). */
export const TWO_FACTOR_REQUIRED_ROLES = ['org_admin', 'accounts', 'investor'] as const;

export interface SmsProvider {
  /** M16 replaces this with a real BD gateway (D-012). */
  send(to: string, message: string): Promise<void>;
}

/**
 * The development and test provider.
 *
 * It records rather than sends, so a test can assert an OTP was issued without
 * a network. It deliberately does not log the code alongside the number: a
 * one-time code next to the phone it belongs to is exactly the pair that must
 * not reach a log (invariant 10).
 */
export class RecordingSmsProvider implements SmsProvider {
  readonly sent: { to: string; message: string }[] = [];

  send(to: string, message: string): Promise<void> {
    this.sent.push({ to, message });
    return Promise.resolve();
  }

  lastCodeFor(phone: string): string | undefined {
    const message = [...this.sent].reverse().find((entry) => entry.to === phone)?.message;
    return /\b(\d{4,8})\b/.exec(message ?? '')?.[1];
  }

  clear(): void {
    this.sent.length = 0;
  }
}

export interface AuthOptions {
  /** Cookies are scoped here so the console works inside the Chatwoot iframe (§16). */
  readonly cookieDomain?: string | undefined;
  readonly baseUrl: string;
  readonly secret: string;
  readonly trustedOrigins: readonly string[];
  readonly sms: SmsProvider;
  /** Off only in tests that need to drive many logins. */
  readonly rateLimitEnabled?: boolean;
}

/**
 * Build the auth instance.
 *
 * It connects as `erp_app` like the rest of the application: the auth tables
 * are global, but nothing else about them is special, and giving auth a more
 * privileged connection would quietly create a second way into the database.
 */
export function createAuth(options: AuthOptions) {
  // The configuration the pools are using, not the environment. A test
  // repoints the database with configureDatabase(); reading process.env here
  // would have auth writing to the developer's database while the test read a
  // throwaway one — which is exactly what happened before this line existed.
  const config = currentDatabaseConfig();
  const driver = postgres(config.DATABASE_URL, { max: 5, onnotice: () => undefined });
  const db = drizzle(driver, { schema });

  const auth = betterAuth({
    appName: 'Elysium ERP',
    baseURL: options.baseUrl,
    secret: options.secret,
    trustedOrigins: [...options.trustedOrigins],

    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
        twoFactor: twoFactors,
      },
    }),

    emailAndPassword: {
      enabled: true,
      // Verification is an M16 concern (it needs the real SMS/email adapters);
      // until then an org_admin creates users directly.
      requireEmailVerification: false,
      minPasswordLength: 12,
    },

    session: {
      expiresIn: 60 * 60 * 12,
      updateAge: 60 * 60,
      additionalFields: {
        activeOrgId: { type: 'string', required: false, input: false },
      },
    },

    advanced: {
      // httpOnly, Secure and SameSite=Lax, scoped to the parent domain (§6).
      // Lax rather than Strict: the console is loaded inside a Chatwoot iframe
      // on the same parent domain, and Strict would drop the cookie there.
      defaultCookieAttributes: {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        ...(options.cookieDomain === undefined ? {} : { domain: options.cookieDomain }),
      },
      useSecureCookies: true,
    },

    rateLimit: {
      enabled: options.rateLimitEnabled ?? true,
      window: 60,
      max: 100,
      customRules: {
        // Tight, because these are the endpoints worth guessing against.
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-in/phone-number': { window: 60, max: 5 },
        '/phone-number/send-otp': { window: 60, max: 3 },
        '/two-factor/verify-totp': { window: 60, max: 5 },
      },
    },

    plugins: [
      twoFactor({
        issuer: 'Elysium ERP',
        // A lost authenticator must not mean a lost account.
        backupCodeOptions: { amount: 10, length: 10 },
      }),
      phoneNumber({
        sendOTP: async ({ phoneNumber: to, code }) => {
          await options.sms.send(to, `Your Elysium verification code is ${code}`);
        },
        otpLength: 6,
        expiresIn: 300,
      }),
    ],

    databaseHooks: {
      session: {
        create: {
          /**
           * Refuse a session to a privileged user who has not enrolled 2FA.
           *
           * Enforced here rather than at the login route because this is the
           * one place every path to a session passes through — email, phone,
           * and anything added later.
           */
          before: async (session) => {
            const [user] = await db
              .select({
                twoFactorEnabled: users.twoFactorEnabled,
                isSuperAdmin: users.isSuperAdmin,
              })
              .from(users)
              .where(eq(users.id, session.userId));

            if (user?.twoFactorEnabled === true) return { data: session };

            // Through `withUser`, not this module's own connection.
            //
            // `iam.memberships` is RLS-protected, and a connection with no
            // context sees zero rows — so this check silently returned "not
            // privileged" for everyone and issued the session anyway. A
            // security control that fails open is worse than none, because it
            // reads like protection.
            //
            // The self policy (D-050) is exactly the right lens here: "does
            // this user hold a privileged role anywhere" is a question about
            // their own memberships, across orgs, before any org is chosen.
            const held = await withUser({ userId: session.userId }, async (tx) =>
              tx
                .select({ role: memberships.role })
                .from(memberships)
                .where(eq(memberships.userId, session.userId)),
            );

            const privileged =
              user?.isSuperAdmin === true ||
              held.some((row) =>
                (TWO_FACTOR_REQUIRED_ROLES as readonly string[]).includes(row.role),
              );

            if (privileged) {
              throw new Error(
                'TWO_FACTOR_REQUIRED: this role cannot hold a session without a second factor.',
              );
            }

            return { data: session };
          },
        },
      },
    },
  });

  return {
    auth,
    /** Closes the auth pool. The app owns its lifetime; tests close it per run. */
    async close(): Promise<void> {
      await driver.end({ timeout: 5 });
    },
  };
}

export type Auth = ReturnType<typeof createAuth>['auth'];

/** Whether a set of roles requires a second factor (§6). */
export function requiresTwoFactor(roles: readonly string[], isSuperAdmin: boolean): boolean {
  if (isSuperAdmin) return true;
  return roles.some((role) => (TWO_FACTOR_REQUIRED_ROLES as readonly string[]).includes(role));
}

export { requireUrl };
