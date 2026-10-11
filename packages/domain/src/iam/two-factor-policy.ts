/**
 * Who must use two-step sign-in, per brand (M40, D-691).
 *
 * A brand's super admin chooses, role by role, whether two-step sign-in is required. This is
 * the one place that turns that choice into an answer: the enrolment wall, the scanner sign-in,
 * the Staff list and the account page's "Turn off" all ask it through `packages/db`'s
 * `twoFactorRequirement`, which reads each brand's stored choice and hands it here.
 *
 * Pure, so a property test can walk every combination of roles and policies.
 */

/** The roles a brand's policy switches, in the order the setting lists them. */
export const TWO_FACTOR_POLICY_ROLES = [
  'org_admin',
  'accounts',
  'hr',
  'marketing',
  'branch_manager',
  'warehouse',
  'sales',
  'investor',
  'reseller',
] as const;

export type TwoFactorPolicyRole = (typeof TWO_FACTOR_POLICY_ROLES)[number];

/**
 * The roles that require it when a brand has chosen nothing: §6's list as it stood before
 * the setting existed (`TWO_FACTOR_REQUIRED_ROLES`). Super admins are not here because they
 * are not a role and are always required.
 */
export const DEFAULT_TWO_FACTOR_REQUIRED_ROLES: readonly TwoFactorPolicyRole[] = [
  'org_admin',
  'accounts',
  'investor',
];

/** The `org.settings` key a brand's choice is stored under. */
export const TWO_FACTOR_POLICY_KEY = 'security.two_factor';

export interface TwoFactorPolicy {
  /** The roles that require two-step sign-in in this brand, in `TWO_FACTOR_POLICY_ROLES` order. */
  readonly requiredRoles: readonly TwoFactorPolicyRole[];
  /** No choice stored (or one that could not be read): the default applies. */
  readonly isDefault: boolean;
}

export const DEFAULT_TWO_FACTOR_POLICY: TwoFactorPolicy = {
  requiredRoles: DEFAULT_TWO_FACTOR_REQUIRED_ROLES,
  isDefault: true,
};

export function isTwoFactorPolicyRole(value: unknown): value is TwoFactorPolicyRole {
  return (
    typeof value === 'string' && (TWO_FACTOR_POLICY_ROLES as readonly string[]).includes(value)
  );
}

/** A set of roles as the policy keeps it: known roles only, once each, in the setting's order. */
export function normaliseRequiredRoles(roles: readonly unknown[]): TwoFactorPolicyRole[] {
  const wanted = new Set(roles.filter(isTwoFactorPolicyRole));
  return TWO_FACTOR_POLICY_ROLES.filter((role) => wanted.has(role));
}

/**
 * A brand's stored choice, read safely.
 *
 * No row is the default. A row that is not `{ requiredRoles: string[] }` is also the default,
 * rather than "nothing required": only the security setting writes this row, through a
 * validated route, so a malformed one was edited by hand, and the safe reading of a value
 * nobody can vouch for is the one the product shipped with. Unknown role names are dropped.
 */
export function readTwoFactorPolicy(stored: unknown): TwoFactorPolicy {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return DEFAULT_TWO_FACTOR_POLICY;
  }
  const roles = (stored as { requiredRoles?: unknown }).requiredRoles;
  if (!Array.isArray(roles)) return DEFAULT_TWO_FACTOR_POLICY;
  return { requiredRoles: normaliseRequiredRoles(roles), isDefault: false };
}

/** What the setting stores for a choice. */
export function storedTwoFactorPolicy(roles: readonly unknown[]): {
  readonly requiredRoles: TwoFactorPolicyRole[];
} {
  return { requiredRoles: normaliseRequiredRoles(roles) };
}

/** The roles, of these, that require two-step sign-in under this policy. */
export function rolesRequiringTwoFactor(
  policy: TwoFactorPolicy,
  roles: readonly string[],
): TwoFactorPolicyRole[] {
  const held = new Set(roles);
  return policy.requiredRoles.filter((role) => held.has(role));
}

/** Whether a person holding these roles in one brand must use two-step sign-in there. */
export function requiresTwoFactorUnder(
  policy: TwoFactorPolicy,
  roles: readonly string[],
  isSuperAdmin: boolean,
): boolean {
  if (isSuperAdmin) return true;
  return rolesRequiringTwoFactor(policy, roles).length > 0;
}

/** One active role a person holds, and the brand it is in. */
export interface BrandRole {
  readonly orgId: string;
  readonly role: string;
}

export interface TwoFactorRequirement {
  /** They must use two-step sign-in: a super admin, or a role some brand requires it for. */
  readonly required: boolean;
  readonly isSuperAdmin: boolean;
  /** Each role, in each brand, that requires it. Empty for a super admin with none. */
  readonly requiredBy: readonly BrandRole[];
}

/**
 * Across every brand a person works in: required when they are a super admin, or when any
 * active role they hold is required by **that role's own brand's** policy. A brand's policy
 * never reaches a role held in another brand.
 */
export function twoFactorRequirementFor(input: {
  readonly isSuperAdmin: boolean;
  readonly held: readonly BrandRole[];
  readonly policyFor: (orgId: string) => TwoFactorPolicy;
}): TwoFactorRequirement {
  const requiredBy = input.held.filter((entry) =>
    input.policyFor(entry.orgId).requiredRoles.some((role) => role === entry.role),
  );
  return {
    required: input.isSuperAdmin || requiredBy.length > 0,
    isSuperAdmin: input.isSuperAdmin,
    requiredBy,
  };
}

export type TurnOffRefusal = 'TWO_FACTOR_NOT_ENABLED' | 'TWO_FACTOR_REQUIRED';

export type TurnOffPlan =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: TurnOffRefusal;
      /** Why, for the console: a super admin, an owner, or a role that requires it. */
      readonly because: 'not_enabled' | 'super_admin' | 'owner' | 'role';
    };

/**
 * May this person's two-step sign-in be turned off, by themselves or by an admin (D-694,
 * D-697)? Only when it is on, they are not a super admin or an owner, and no role they hold in
 * any brand requires it. A required person whose phone is lost is reset instead (D-403), and
 * meets the set-up screen at their next sign-in.
 */
export function planTurnOffTwoFactor(input: {
  readonly enabled: boolean;
  readonly isOwner: boolean;
  readonly requirement: TwoFactorRequirement;
}): TurnOffPlan {
  if (!input.enabled) {
    return { allowed: false, code: 'TWO_FACTOR_NOT_ENABLED', because: 'not_enabled' };
  }
  if (input.isOwner) return { allowed: false, code: 'TWO_FACTOR_REQUIRED', because: 'owner' };
  if (input.requirement.isSuperAdmin) {
    return { allowed: false, code: 'TWO_FACTOR_REQUIRED', because: 'super_admin' };
  }
  if (input.requirement.required) {
    return { allowed: false, code: 'TWO_FACTOR_REQUIRED', because: 'role' };
  }
  return { allowed: true };
}

/**
 * What changing a brand's policy does to the people in it: the roles it starts and stops
 * requiring. Nobody's factor is removed by a role being switched off (D-691).
 */
export function policyChange(
  before: TwoFactorPolicy,
  after: TwoFactorPolicy,
): { readonly added: TwoFactorPolicyRole[]; readonly removed: TwoFactorPolicyRole[] } {
  const was = new Set(before.requiredRoles);
  const now = new Set(after.requiredRoles);
  return {
    added: after.requiredRoles.filter((role) => !was.has(role)),
    removed: before.requiredRoles.filter((role) => !now.has(role)),
  };
}
