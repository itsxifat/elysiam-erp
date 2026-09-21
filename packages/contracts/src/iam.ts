import { z } from 'zod';

/**
 * Identity schemas (architecture §6).
 *
 * Shared between the console's forms and the server's edge validation on
 * purpose. Two definitions of "what a valid sign-in looks like" drift, and they
 * drift in the direction that matters: the client's copy gets relaxed to
 * unblock a test and nobody notices the server no longer agrees.
 */

/** The roles a membership can carry (§6). Mirrors the `iam.membership_role` enum. */
export const MEMBERSHIP_ROLES = [
  'org_admin',
  'sales',
  'accounts',
  'marketing',
  'hr',
  'branch_manager',
  'warehouse',
  'reseller',
  'investor',
] as const;

export const membershipRoleSchema = z.enum(MEMBERSHIP_ROLES);
export type MembershipRole = z.infer<typeof membershipRoleSchema>;

/**
 * Sign-in credentials.
 *
 * The password rule here is only "present". The real minimum lives where the
 * password is *set*, and repeating it at sign-in would tell an attacker which
 * accounts predate a policy change.
 */
export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});
export type Credentials = z.infer<typeof credentialsSchema>;

/** A TOTP code. Six digits, because that is what `createAuth()` configures. */
export const totpCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});
export type TotpCode = z.infer<typeof totpCodeSchema>;

/**
 * A recovery code.
 *
 * Ten characters, per the `backupCodeOptions` in `createAuth()`. Deliberately
 * not `\d{6}`: a user who pastes a recovery code into the TOTP field should be
 * told the format is wrong rather than have it silently fail verification.
 */
export const recoveryCodeSchema = z.object({
  code: z.string().trim().min(8).max(32),
});
export type RecoveryCode = z.infer<typeof recoveryCodeSchema>;

export const switchOrgSchema = z.object({ orgId: z.string().uuid() });
export type SwitchOrg = z.infer<typeof switchOrgSchema>;

export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(200),
  role: membershipRoleSchema,
  branchIds: z.array(z.string().uuid()).default([]),
});
export type CreateUser = z.infer<typeof createUserSchema>;
