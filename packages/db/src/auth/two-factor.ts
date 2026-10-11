import { createOTP } from '@better-auth/utils/otp';
import {
  DEFAULT_TWO_FACTOR_POLICY,
  readTwoFactorPolicy,
  TWO_FACTOR_POLICY_KEY,
  twoFactorRequirementFor,
  type BrandRole,
  type TwoFactorPolicy,
  type TwoFactorRequirement,
} from '@elysium/domain/iam';
import { generateRandomString, symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { sql } from 'drizzle-orm';

import { withGlobal, withOrg, withUser, type Tx } from '../client.js';

/**
 * Who must use two-step sign-in, read from each brand's own setting (M40, D-691).
 *
 * The one reader of the policy. The enrolment wall (`mustEnrolTwoFactor`), the scanner's
 * sign-in and device check, the Staff list and My account all come through here, so "is this
 * person required" has one answer however it is asked. The decision itself is the domain's
 * (`twoFactorRequirementFor`); this file only gathers the facts it needs.
 */

/**
 * A brand's policy, inside a transaction already scoped to that brand (`withOrg`).
 *
 * Checked, not assumed: `org.settings` is a tenant table, so a transaction scoped to another
 * brand, or to none, sees no row — which would read as the default and quietly let through a
 * role this brand had made required. A security control that fails that way looks like
 * protection, so this refuses to answer instead.
 */
export async function loadTwoFactorPolicy(tx: Tx, orgId: string): Promise<TwoFactorPolicy> {
  const [row] = await tx.execute<{ value: unknown; in_org: boolean }>(sql`
    select
      (select value from org.settings where org_id = ${orgId} and key = ${TWO_FACTOR_POLICY_KEY})
        as value,
      coalesce(nullif(current_setting('app.org_id', true), '') = ${orgId}, false) as in_org
  `);
  if (row?.in_org !== true) {
    throw new Error('loadTwoFactorPolicy() must run inside withOrg() for the same brand.');
  }
  return readTwoFactorPolicy(row.value ?? undefined);
}

/** A brand's policy, in a transaction of its own. */
export async function twoFactorPolicyFor(orgId: string, userId?: string): Promise<TwoFactorPolicy> {
  return withOrg({ orgId, ...(userId === undefined ? {} : { userId }) }, (tx) =>
    loadTwoFactorPolicy(tx, orgId),
  );
}

export interface TwoFactorStanding {
  /** No such user. Callers treat it as "required" (fail closed). */
  readonly missing: boolean;
  readonly enabled: boolean;
  readonly isOwner: boolean;
  readonly requirement: TwoFactorRequirement;
}

/**
 * Whether this person has two-step sign-in on, and whether anything requires it of them:
 * every active role they hold, each against its own brand's policy, plus super admin.
 *
 * Memberships are read through the person's own lens (the D-050 self policy, `withUser`), and
 * each brand's policy inside that brand (`withOrg`): a connection with no context would see
 * no rows at all, and read as "nothing required" for everyone.
 */
export async function twoFactorStanding(userId: string): Promise<TwoFactorStanding> {
  const [user] = await withGlobal(async (tx) =>
    tx.execute<{ two_factor_enabled: boolean; is_super_admin: boolean; is_owner: boolean }>(
      sql`select two_factor_enabled, is_super_admin, is_owner from iam.users where id = ${userId}`,
    ),
  );
  if (user === undefined) {
    return {
      missing: true,
      enabled: false,
      isOwner: false,
      requirement: { required: true, isSuperAdmin: false, requiredBy: [] },
    };
  }

  const held = await heldRoles(userId);
  const policies = new Map<string, TwoFactorPolicy>();
  for (const orgId of new Set(held.map((entry) => entry.orgId))) {
    policies.set(orgId, await twoFactorPolicyFor(orgId, userId));
  }
  return {
    missing: false,
    enabled: user.two_factor_enabled,
    isOwner: user.is_owner,
    requirement: twoFactorRequirementFor({
      isSuperAdmin: user.is_super_admin,
      held,
      policyFor: (orgId) => policies.get(orgId) ?? DEFAULT_TWO_FACTOR_POLICY,
    }),
  };
}

/** Every active role this person holds, in every brand, through their own lens (D-050). */
async function heldRoles(userId: string): Promise<BrandRole[]> {
  const rows = await withUser({ userId }, async (tx) =>
    tx.execute<{ org_id: string; role: string }>(sql`
      select org_id, role::text as role from iam.memberships
      where user_id = ${userId} and is_active
    `),
  );
  return [...rows].map((row) => ({ orgId: row.org_id, role: row.role }));
}

// --- the authenticator's secret, for My account's "set up on a new phone" (D-694) ------------

/**
 * The parts of Better Auth this needs: its encryption key and its name for the issuer. Typed
 * structurally so this file does not have to import the whole auth instance's type.
 */
export interface AuthSecrets {
  readonly $context: Promise<{
    readonly secretConfig: Parameters<typeof symmetricEncrypt>[0]['key'];
    readonly appName: string;
  }>;
}

/** Better Auth's own TOTP shape (`createAuth()`'s plugin): six digits, thirty seconds. */
const TOTP = { digits: 6, period: 30 } as const;

export interface PendingSecret {
  /** For the authenticator app: `otpauth://totp/...`, shown as a QR code and as text. */
  readonly totpURI: string;
  /** The new secret, encrypted the way Better Auth stores one. */
  readonly encryptedSecret: string;
}

/**
 * A new authenticator secret, the way Better Auth's own `/two-factor/enable` makes one: 32
 * random characters, encrypted with the auth secret. It replaces the old one only once a code
 * from it has been checked (`totpMatchesEncrypted`), so the old phone keeps working until then.
 */
export async function newAuthenticatorSecret(
  auth: AuthSecrets,
  account: string,
): Promise<PendingSecret> {
  const context = await auth.$context;
  const secret = generateRandomString(32);
  return {
    totpURI: createOTP(secret, TOTP).url(context.appName, account),
    encryptedSecret: await symmetricEncrypt({ key: context.secretConfig, data: secret }),
  };
}

/** Whether a six-digit code is current for an encrypted secret, allowing one step either way. */
export async function totpMatchesEncrypted(
  auth: AuthSecrets,
  encryptedSecret: string,
  code: string,
): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const context = await auth.$context;
  const secret = await symmetricDecrypt({ key: context.secretConfig, data: encryptedSecret });
  return createOTP(secret, TOTP).verify(code, { window: 1 });
}
