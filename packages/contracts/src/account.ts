import { z } from 'zod';

import { MEMBERSHIP_ROLES, membershipRoleSchema } from './iam.js';

/*
 * My account and the brand's two-step policy (M40, D-691 to D-697).
 *
 * The console's forms and the server's edge both validate with these.
 */

/** My account → Profile: the name a person goes by. The email address is not changed here. */
export const updateProfileSchema = z.object({ name: z.string().trim().min(1).max(200) }).strict();
export type UpdateProfile = z.infer<typeof updateProfileSchema>;

/**
 * Changing your own password, as the form holds it. `current` and `password` go to Better
 * Auth's `/change-password` (twelve to 128 characters, `createAuth()`'s rule); `confirm` lives
 * in the form only.
 */
export const changeOwnPasswordSchema = z
  .object({
    current: z.string().min(1).max(128),
    password: z.string().min(12).max(128),
    confirm: z.string(),
    signOutOthers: z.boolean(),
  })
  .refine((value) => value.password === value.confirm, {
    path: ['confirm'],
    message: 'The two passwords differ.',
  })
  .refine((value) => value.password !== value.current, {
    path: ['password'],
    message: 'The new password is the same as the current one.',
  });
export type ChangeOwnPassword = z.infer<typeof changeOwnPasswordSchema>;

/**
 * A change to your own two-step sign-in, confirmed with the password and a current code:
 * six digits from the authenticator, or one of the backup codes (D-694).
 */
export const confirmWithCodeSchema = z
  .object({
    password: z.string().min(1).max(128),
    code: z.string().trim().min(6).max(32),
  })
  .strict();
export type ConfirmWithCode = z.infer<typeof confirmWithCodeSchema>;

/** The six digits the new phone shows, which finish setting it up. */
export const replacementCodeSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/),
  })
  .strict();
export type ReplacementCode = z.infer<typeof replacementCodeSchema>;

/** A session id in a path. Better Auth's are 32 letters and digits. */
export const sessionIdParamSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'No such session.');

/** Settings → Security: the roles that require two-step sign-in in this brand (D-692). */
export const twoFactorPolicySchema = z
  .object({
    requiredRoles: z.array(membershipRoleSchema).max(MEMBERSHIP_ROLES.length),
  })
  .strict();
export type TwoFactorPolicyInput = z.infer<typeof twoFactorPolicySchema>;
