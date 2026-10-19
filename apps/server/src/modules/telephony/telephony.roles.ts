import type { MembershipRole } from '@elysium/contracts';
import type { Tx } from '@elysium/db';

import type { BrandMember, IamApi } from '../iam/iam.api.js';

/** The roles that place calls (`create PhoneCall`, D-831). */
export const CALLING_ROLES: readonly MembershipRole[] = ['sales', 'branch_manager', 'org_admin'];

/**
 * The people who may hold an extension and place calls: the members with a calling role
 * (D-831) and the super admins, who hold no role in a brand but may do anything in it (D-864).
 */
export async function callingPeople(
  iam: IamApi,
  tx: Tx,
  orgId: string,
): Promise<readonly BrandMember[]> {
  const members = await iam.activeMembers(tx, orgId, { roles: CALLING_ROLES });
  const admins = await iam.activeSuperAdmins(tx);
  const seen = new Set(members.map((member) => member.userId));
  return [...members, ...admins.filter((admin) => !seen.has(admin.userId))];
}
