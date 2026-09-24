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

export const createUserSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    name: z.string().trim().min(1).max(200),
    role: membershipRoleSchema,
    branchIds: z.array(z.string().uuid()).default([]),
  })
  /*
   * A branch manager must be given branches.
   *
   * §6 says "empty branch scope means the whole org, not 'no branches'", and
   * that reading is right for a role that is *deliberately* org-wide. It is
   * the wrong thing to get by leaving a field out. `branchIds` defaults to
   * `[]`, so the shortest valid call —
   *
   *   POST /v1/users { email, name, role: 'branch_manager' }
   *
   * — produced a branch manager whose every `branch`-scoped grant evaluated to
   * the whole org: `update Wallet`, `create/update Order` and `Employee`,
   * `read LedgerReport`, and `approve ApprovalRequest`. The branch-tier cap on
   * stock write-offs, gains and closing variances measures against that same
   * scope, so it admitted every branch's till.
   *
   * Refused at the edge rather than reinterpreted deeper down, because §6's
   * sentence is correct and the caller's silence is what is not.
   */
  .superRefine((value, ctx) => {
    if (value.role === 'branch_manager' && value.branchIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['branchIds'],
        message: 'A branch manager needs at least one branch. Empty means the whole organization.',
      });
    }
  });
export type CreateUser = z.infer<typeof createUserSchema>;
