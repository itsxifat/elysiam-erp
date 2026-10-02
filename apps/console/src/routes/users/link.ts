import { MEMBERSHIP_ROLES, type MembershipRole } from '@elysium/contracts';

/**
 * The link an admin passes on, and the order roles are listed in (gaps-users-auth).
 *
 * The token goes in the fragment, which no browser sends to a server: the console's own
 * host never sees it in an access log, and neither does anything in between (D-402).
 */
export function passwordLinkUrl(
  origin: string,
  kind: 'invite' | 'password',
  token: string,
): string {
  const path = kind === 'invite' ? '/accept-invite' : '/reset-password';
  return `${origin}${path}#token=${encodeURIComponent(token)}`;
}

/** The roles in the order an admin thinks of them: the people who run things first. */
export const ROLE_ORDER: readonly MembershipRole[] = [
  'org_admin',
  'accounts',
  'hr',
  'branch_manager',
  'sales',
  'marketing',
  'warehouse',
  'reseller',
  'investor',
];

/** Every role, once, in `ROLE_ORDER`; a role added to the enum and not here still shows. */
export function orderedRoles(): readonly MembershipRole[] {
  return [...ROLE_ORDER, ...MEMBERSHIP_ROLES.filter((role) => !ROLE_ORDER.includes(role))];
}

/**
 * The roles an editor submits: one entry per ticked role with its branches. A branch
 * manager without a branch, and no role at all, are refused here before the server
 * refuses them in its own words.
 */
export function rolesToSubmit(ticked: ReadonlyMap<MembershipRole, readonly string[]>): {
  readonly roles: { role: MembershipRole; branchIds: string[] }[];
  readonly problem: 'none' | 'branch' | null;
} {
  const roles = orderedRoles()
    .filter((role) => ticked.has(role))
    .map((role) => ({ role, branchIds: [...(ticked.get(role) ?? [])] }));
  if (roles.length === 0) return { roles, problem: 'none' };
  if (roles.some((entry) => entry.role === 'branch_manager' && entry.branchIds.length === 0)) {
    return { roles, problem: 'branch' };
  }
  return { roles, problem: null };
}
