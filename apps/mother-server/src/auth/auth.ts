import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins';

import { motherDb, motherSql } from '../db/client.js';
import { accounts, sessions, twoFactors, users, verifications } from '../db/schema.js';

/**
 * Who may sign in to the mother (D-487).
 *
 * Better Auth, as the brand uses it, with the mother's own tables and stricter settings:
 *
 * - **Email and password, and a second factor for everyone.** There is no role here that
 *   may work without one: every person is an owner who can see and open every brand. The
 *   factor is enforced as the brand's enrolment wall (D-051) — a session without an
 *   enrolled factor may do nothing but enrol — and, once enrolled, by the plugin itself,
 *   which issues no session until the code is right.
 * - **No sign-up.** `pnpm mother:bootstrap` makes the first owner; owners invite owners.
 * - **Eight-hour sessions that are never extended** (`disableSessionRefresh`): the mother
 *   holds the keys to every brand, so a session ends on a fixed clock.
 * - **No self-service reset.** A link comes from another owner (an invite) or from the
 *   operator on the server.
 * - **A removed owner holds no session** (D-489): refused at creation, as the brand's
 *   D-401 does.
 */

export const SESSION_SECONDS = 8 * 60 * 60;
export const INVITE_LINK_SECONDS = 72 * 60 * 60;

/** Better Auth's own per-address limits, a backstop under the mother's two-bucket limiter. */
export const LIBRARY_RATE_RULES = {
  '/sign-in/email': { window: 60, max: 20 },
  '/two-factor/verify-totp': { window: 60, max: 10 },
  '/two-factor/verify-backup-code': { window: 60, max: 10 },
} as const;

export interface MotherAuthOptions {
  readonly baseUrl: string;
  readonly secret: string;
  readonly trustedOrigins: readonly string[];
  readonly rateLimitEnabled?: boolean;
}

/** May this person hold a session at all? Read live; fails closed on an unknown id. */
export async function mayHoldSession(userId: string): Promise<boolean> {
  const [row] = await motherSql()<{ is_active: boolean }[]>`
    select is_active from auth.users where id = ${userId}
  `;
  return row?.is_active === true;
}

/** Must this person enrol a second factor before anything else? Everyone without one must. */
export async function mustEnrolTwoFactor(userId: string): Promise<boolean> {
  const [row] = await motherSql()<{ two_factor_enabled: boolean }[]>`
    select two_factor_enabled from auth.users where id = ${userId}
  `;
  return row?.two_factor_enabled !== true;
}

export function createMotherAuth(options: MotherAuthOptions) {
  const secure = new URL(options.baseUrl).protocol === 'https:';
  return betterAuth({
    appName: 'Owner console',
    baseURL: options.baseUrl,
    basePath: '/api/auth',
    secret: options.secret,
    trustedOrigins: [...options.trustedOrigins],
    database: drizzleAdapter(motherDb(), {
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
      disableSignUp: true,
      requireEmailVerification: false,
      minPasswordLength: 12,
      resetPasswordTokenExpiresIn: INVITE_LINK_SECONDS,
      revokeSessionsOnPasswordReset: true,
      // Every link is minted by the mother's own audited code (an invite, or the operator's
      // break-glass command); nothing is ever sent from here.
      sendResetPassword: () => Promise.resolve(),
    },
    disabledPaths: [
      '/request-password-reset',
      '/change-email',
      '/delete-user',
      '/update-user',
      '/list-accounts',
      '/unlink-account',
    ],
    session: {
      expiresIn: SESSION_SECONDS,
      disableSessionRefresh: true,
    },
    advanced: {
      cookiePrefix: 'owner',
      useSecureCookies: secure,
      defaultCookieAttributes: {
        httpOnly: true,
        secure,
        // The console and the API are one origin (D-491): no cross-site request needs it.
        sameSite: 'strict',
        path: '/',
      },
    },
    rateLimit: {
      enabled: options.rateLimitEnabled ?? true,
      window: 60,
      max: 100,
      customRules: { ...LIBRARY_RATE_RULES },
    },
    plugins: [
      twoFactor({
        issuer: 'Owner console',
        backupCodeOptions: { amount: 10, length: 10 },
      }),
    ],
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            if (!(await mayHoldSession(session.userId))) {
              throw new APIError('FORBIDDEN', {
                code: 'ACCOUNT_INACTIVE',
                message: 'This account is not active.',
              });
            }
            return { data: session };
          },
        },
      },
    },
  });
}

export type MotherAuth = ReturnType<typeof createMotherAuth>;
