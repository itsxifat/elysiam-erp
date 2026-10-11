import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { phoneNumber, twoFactor } from 'better-auth/plugins';
import {
  DEFAULT_TWO_FACTOR_POLICY,
  DEFAULT_TWO_FACTOR_REQUIRED_ROLES,
  requiresTwoFactorUnder,
  type TwoFactorPolicy,
} from '@elysium/domain/iam';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { currentDatabaseConfig, withGlobal, withUser } from '../client.js';
import { requireUrl } from '../config.js';
import * as schema from '../schema/index.js';
import { accounts, sessions, twoFactors, users, verifications } from '../schema/iam/index.js';
import { ownerSession } from './owner-session.js';
import { twoFactorStanding } from './two-factor.js';

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
 * - **2FA is required, not offered**, for super admins and for the roles each brand's
 *   security setting names (§6, M40 D-691; org_admin, accounts and investor until a super
 *   admin changes it). Enforced as an enrolment wall on the request path
 *   (`mustEnrolTwoFactor`), not at session issue: enrolling needs a session, so
 *   refusing the session would leave a privileged user with no way in at all.
 * - **Rate limits are per identifier as well as per IP** (§25). Per-IP alone is
 *   close to useless against a botnet, and actively harmful in Bangladesh where
 *   most mobile traffic shares a handful of carrier NAT addresses — one
 *   attacker would lock out a whole network.
 */

/**
 * The roles that require a second factor in a brand whose super admin has chosen nothing
 * (§6). Each brand's own choice lives in its security setting (M40, D-691) and is read by
 * `twoFactorStanding`; this is only the default it falls back to.
 */
export const TWO_FACTOR_REQUIRED_ROLES = DEFAULT_TWO_FACTOR_REQUIRED_ROLES;

export interface SmsProvider {
  /** Bound to a recorder until a verified BD gateway carries OTPs too (D-012, D-212). */
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
  /**
   * The deployment's brand, as its staff know it (D-472, M31): the authenticator app's
   * issuer and the sign-in text's sender. Every brand runs its own ERP, so nothing here
   * may name another; without one (tests, local development) both stay neutral.
   */
  readonly brandName?: string | undefined;
  /** Off only in tests that need to drive many logins. */
  readonly rateLimitEnabled?: boolean;
  /**
   * Called with a freshly minted password-set token (invite or reset).
   *
   * A port, like `SmsProvider`. No email adapter exists yet (D-212), so the server
   * keeps the token and `POST /v1/users` hands it to the admin.
   */
  readonly onPasswordToken?: (issued: {
    userId: string;
    email: string;
    token: string;
  }) => Promise<void>;
}

/**
 * Better Auth's own limits on the endpoints worth guessing against, per address and
 * per minute (D-168).
 *
 * A backstop, never the binding limit. The API's limiter (`apps/server`'s
 * `rate-limit.ts`) counts two buckets: a generous one per address, because an office
 * or a carrier NAT puts many people behind one address, and a tight one per email
 * or phone, which is what makes guessing one account expensive. Better Auth can only
 * count per address. Its sign-in rule used to allow five a minute, so the sixth
 * person to sign in from a showroom in the same minute was refused, whatever the
 * API's own rules said. Each allowance here equals the API's per-address bucket, and
 * a server test keeps it from dropping below it.
 */
export const LIBRARY_RATE_RULES = {
  '/sign-in/email': { window: 60, max: 20 },
  '/sign-in/phone-number': { window: 60, max: 20 },
  '/phone-number/send-otp': { window: 60, max: 10 },
  '/two-factor/verify-totp': { window: 60, max: 10 },
} as const satisfies Readonly<Record<string, { window: number; max: number }>>;

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
  const brand = options.brandName?.trim() ?? '';
  const issuer = brand === '' ? 'ERP' : brand;

  const auth = betterAuth({
    appName: issuer,
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

      /**
       * No self-service registration.
       *
       * This is a staff ERP: there is no such thing as a member of the public
       * who should be able to create an account in it. Better Auth defaults
       * `disableSignUp` to false, so `/api/auth/sign-up/email` was open to the
       * internet — verified, an anonymous POST returned 200 and wrote rows into
       * `iam.users` and `iam.accounts`.
       *
       * Worse than the unbounded writes was what it enabled: an attacker could
       * register the address of someone about to be hired, and when an admin
       * later invited that address, `createUserWithMembership` reused the
       * existing row and attached the role to the attacker's password. Account
       * pre-hijacking, reproduced end to end.
       *
       * Users are created by an org_admin through `POST /v1/users`, which
       * issues an invite the recipient redeems to set their own password.
       */
      disableSignUp: true,

      // Verification is an M16 concern (it needs the real email adapter). Until
      // then the invite token is the proof of address: it is handed to the
      // admin who requested it and redeemed once.
      requireEmailVerification: false,
      minPasswordLength: 12,

      /**
       * A reset link works for an hour (D-402). An invite is minted the same way and then
       * given three days by the iam module, which writes the longer expiry onto the row:
       * Better Auth has one lifetime for both, and a new hire who opens their link the
       * next morning should not find it dead.
       */
      resetPasswordTokenExpiresIn: PASSWORD_LINK_SECONDS,

      /**
       * Redeeming a link ends every session the person had (D-402). Whoever holds a
       * session from before the reset — a stolen laptop, a colleague who watched them
       * type — is exactly who the reset is for.
       */
      revokeSessionsOnPasswordReset: true,

      /**
       * Where an invite or reset token goes.
       *
       * There is no email adapter yet (D-012, D-212), so the
       * token is handed back to the admin who created the user, which is how
       * onboarding works in a business that has not wired email yet: the admin
       * passes it on out of band.
       */
      sendResetPassword: async (data) => {
        await options.onPasswordToken?.({
          userId: data.user.id,
          email: data.user.email,
          token: data.token,
        });
      },
    },

    /**
     * No public "send me a reset link" (D-402).
     *
     * There is no email adapter (D-212), so a link Better Auth mints has nowhere to go
     * but the token store, from which the next admin action would collect it. Every link
     * now comes from an audited admin action in the iam module, which writes the
     * verification row Better Auth's `/reset-password` consumes inside its own transaction;
     * this closes the HTTP door, which let anyone on the internet mint reset rows for any
     * address.
     */
    // The phone-number plugin's own reset pair is closed for the same reason (the ledger
    // audit's W2): an OTP reset with no audit, no limits and no second admin, and the day
    // SMS is wired it would let anyone with a phone take over the account behind it.
    // `/two-factor/disable` too (M40, D-694): it switched the factor off on the password
    // alone, whatever the brand's policy said. Turning it off is `POST
    // /v1/account/two-factor/turn-off` now, which asks for a current code as well and refuses
    // while any role requires it.
    disabledPaths: [
      '/request-password-reset',
      '/phone-number/request-password-reset',
      '/phone-number/reset-password',
      '/two-factor/disable',
    ],

    /**
     * A text-message code never signs anyone in (M30's A3, D-411).
     *
     * The phone-number plugin's `/phone-number/verify` creates a session for whoever owns
     * the number once the code matches, and the two-factor plugin only guards the
     * credential sign-ins (`/sign-in/email`, `/sign-in/phone-number`): the day SMS is
     * switched on, an org admin or an accountant with a phone on file could be signed in
     * by an SMS code alone, past the second factor §6 requires of them. So the endpoint
     * answers only its other use: a person already signed in confirming a new number on
     * their own account (`updatePhoneNumber`, which needs a session). Phone and password
     * sign-in stays, behind the two-factor hook.
     */
    hooks: {
      before: createAuthMiddleware((ctx) => {
        if (ctx.path !== '/phone-number/verify') return Promise.resolve();
        const body = ctx.body as { updatePhoneNumber?: unknown } | undefined;
        if (body?.updatePhoneNumber === true) return Promise.resolve();
        return Promise.reject(
          new APIError('FORBIDDEN', {
            code: 'PHONE_CODE_SIGN_IN_DISABLED',
            message: 'A text-message code does not sign you in. Use your email and password.',
          }),
        );
      }),
    },

    session: {
      expiresIn: 60 * 60 * 12,
      updateAge: 60 * 60,
      additionalFields: {
        activeOrgId: { type: 'string', required: false, input: false },
        // Opened by an owner sign-in link (M31, D-473): set by `ownerSession()` only.
        ownerLink: { type: 'boolean', required: false, input: false, defaultValue: false },
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
      customRules: { ...LIBRARY_RATE_RULES },
    },

    plugins: [
      twoFactor({
        issuer,
        // A lost authenticator must not mean a lost account.
        backupCodeOptions: { amount: 10, length: 10 },
      }),
      phoneNumber({
        sendOTP: async ({ phoneNumber: to, code }) => {
          await options.sms.send(to, verificationText(brand, code));
        },
        otpLength: 6,
        expiresIn: 300,
      }),
      // The owner sign-in link's session (M31, D-473). Server-only: no HTTP path reaches it.
      ownerSession(),
    ],

    databaseHooks: {
      session: {
        create: {
          /**
           * Deliberately NOT a refusal.
           *
           * The obvious enforcement — "throw if a privileged user has no
           * second factor" — was here, and it deadlocked the product:
           * enrolling TOTP needs a session (Better Auth's
           * `/two-factor/enable` runs behind `sessionMiddleware`), so an
           * org_admin created by another org_admin could never enrol, and so
           * could never sign in. A control nobody can satisfy is a control
           * nobody ships with.
           *
           * §6 is therefore enforced one step later, as an *enrolment wall*:
           * the session exists, but `mustEnrolTwoFactor()` blocks every route
           * except the enrolment endpoints until the factor is real. See
           * `apps/server/src/platform/http/auth-plugin.ts`.
           *
           * Once enrolled, the second factor is enforced by the plugin itself:
           * sign-in returns `twoFactorRedirect` and no session at all, and the
           * session is created only by verify-totp / verify-backup-code.
           */
          before: async (session) => {
            /*
             * But an account that may not be used at all is refused here (D-401).
             *
             * Deactivating a leaver switches their memberships off and ends their
             * sessions. Without this, they could simply sign in again: a session
             * with no org reaches nothing tenant-scoped, but it is still a live
             * credential, and it can enrol a second factor and call every
             * `/api/auth` endpoint. Fails closed only on the two facts that mean
             * "nobody should be signed in as this": the account disabled, or no
             * active role in any brand. Super admins hold no membership by design.
             */
            if (!(await mayHoldSession(session.userId))) {
              throw new APIError('FORBIDDEN', {
                code: 'ACCOUNT_INACTIVE',
                message: 'This account is not active. Ask your admin for access.',
              });
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

/** The sign-in code's text, signed with the brand's own name when the deployment has one. */
export function verificationText(brandName: string, code: string): string {
  return brandName === ''
    ? `Your verification code is ${code}`
    : `Your ${brandName} verification code is ${code}`;
}

/**
 * Must this user enrol a second factor before they may act? (§6)
 *
 * The enrolment wall. Read per request rather than cached on the session,
 * because the answer changes the moment a role is granted or a brand's security
 * setting starts requiring a role (M40, D-691) — and the direction that matters
 * (unprivileged becoming privileged) must take effect at once, not at next sign-in.
 *
 * Short-circuits on `two_factor_enabled`, so the membership and policy reads only
 * happen for users who have not enrolled — which is exactly the set being walled.
 * An unknown user id is walled: not "no second factor needed" but a caller bug,
 * and it fails closed.
 */
export async function mustEnrolTwoFactor(userId: string): Promise<boolean> {
  const [user] = await withGlobal(async (tx) =>
    tx.execute<{ two_factor_enabled: boolean; is_super_admin: boolean }>(
      sql`select two_factor_enabled, is_super_admin from iam.users where id = ${userId}`,
    ),
  );
  if (user === undefined) return true;
  if (user.two_factor_enabled) return false;
  if (user.is_super_admin) return true;

  // Each role against its own brand's policy, through the person's own lens (D-050) and
  // each brand's own context — `twoFactorStanding` explains why neither may be skipped.
  return (await twoFactorStanding(userId)).requirement.required;
}

/** How long a password reset link works, in seconds (D-402). */
export const PASSWORD_LINK_SECONDS = 60 * 60;

/** How long an invite link works, in seconds (D-402). Written onto the row after minting. */
export const INVITE_LINK_SECONDS = 72 * 60 * 60;

/**
 * May this user hold a session at all? (D-401)
 *
 * An enabled account with an active role in at least one active brand, or a super
 * admin. Read through the same lenses as `mustEnrolTwoFactor`, for the same reason:
 * `iam.memberships` is RLS-protected, and a connection with no user context sees no
 * rows — which here would refuse everyone, and a control that fails that way gets
 * switched off.
 */
export async function mayHoldSession(userId: string): Promise<boolean> {
  const [user] = await withGlobal(async (tx) =>
    tx.execute<{ is_active: boolean; is_super_admin: boolean }>(
      sql`select is_active, is_super_admin from iam.users where id = ${userId}`,
    ),
  );
  if (user?.is_active !== true) return false;
  if (user.is_super_admin) return true;

  const [held] = await withUser({ userId }, async (tx) =>
    tx.execute<{ found: boolean }>(sql`
      select exists (
        select 1 from iam.memberships m
        join org.organizations o on o.id = m.org_id
        where m.user_id = ${userId} and m.is_active and o.is_active
      ) as found
    `),
  );
  return held?.found === true;
}

/**
 * Whether a set of roles held in one brand requires a second factor there (§6), under that
 * brand's policy (`loadTwoFactorPolicy`); the default policy when none is given.
 */
export function requiresTwoFactor(
  roles: readonly string[],
  isSuperAdmin: boolean,
  policy: TwoFactorPolicy = DEFAULT_TWO_FACTOR_POLICY,
): boolean {
  return requiresTwoFactorUnder(policy, roles, isSuperAdmin);
}

export { requireUrl };
