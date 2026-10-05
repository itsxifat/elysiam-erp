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

/*
 * Staff management (gaps-users-auth, D-400 to D-409).
 *
 * The console's forms and the server's edge both validate with these, so a rule
 * relaxed in one place is a type error in the other rather than a silent drift.
 */

/** A user id in a path. Ours are `usr_<uuid>`; anything else is a 404 before a query. */
export const userIdParamSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'No such person in this organization.');

/** One role a person holds in a brand, and the branches it reaches. Empty means the whole org. */
export const roleGrantSchema = z.object({
  role: membershipRoleSchema,
  branchIds: z.array(z.string().uuid()).max(100).default([]),
});
export type RoleGrant = z.infer<typeof roleGrantSchema>;

/**
 * A person's whole set of roles in the active brand, replacing what they hold.
 *
 * At least one: taking every role away is a deactivation, which has its own route,
 * its own audit action and its own effect on sessions. One entry per role, because
 * a membership is unique per (org, user, role). A branch manager names a branch for
 * the reason `createUserSchema` gives.
 */
export const setRolesSchema = z
  .object({
    roles: z.array(roleGrantSchema).min(1).max(MEMBERSHIP_ROLES.length),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.roles.forEach((grant, index) => {
      if (seen.has(grant.role)) {
        ctx.addIssue({
          code: 'custom',
          path: ['roles', index, 'role'],
          message: 'Each role appears once.',
        });
      }
      seen.add(grant.role);
      if (grant.role === 'branch_manager' && grant.branchIds.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['roles', index, 'branchIds'],
          message:
            'A branch manager needs at least one branch. Empty means the whole organization.',
        });
      }
    });
  });
export type SetRoles = z.infer<typeof setRolesSchema>;

/** Deactivating a leaver. The reason goes to the audit log only. */
export const deactivateUserSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});
export type DeactivateUser = z.infer<typeof deactivateUserSchema>;

/**
 * Asking for a new password link or a second-factor reset (D-402, D-403).
 *
 * A reason is required: it is what the second admin reads before approving a
 * privileged reset (D-404), and what an investigator reads afterwards.
 */
export const credentialResetSchema = z.object({
  reason: z.string().trim().min(3).max(300),
});
export type CredentialResetInput = z.infer<typeof credentialResetSchema>;

/**
 * Setting a password from an invite or reset link.
 *
 * Twelve characters is `minPasswordLength` in `createAuth()`; 128 is Better Auth's
 * default maximum. The confirmation lives only in the form, so it is checked here
 * and never sent.
 */
export const setPasswordSchema = z
  .object({
    password: z.string().min(12).max(128),
    confirm: z.string(),
  })
  .refine((value) => value.password === value.confirm, {
    path: ['confirm'],
    message: 'The two passwords differ.',
  });
export type SetPassword = z.infer<typeof setPasswordSchema>;

/**
 * `POST /v1/auth/owner-link` (M31, D-473): an owner sign-in link's token, as the console
 * reads it from the URL fragment. The format is `packages/domain/src/iam/owner-link.ts`;
 * 2,048 characters is its ceiling.
 */
export const ownerLinkSignInSchema = z.object({ token: z.string().min(1).max(2048) }).strict();
export type OwnerLinkSignIn = z.infer<typeof ownerLinkSignInSchema>;
