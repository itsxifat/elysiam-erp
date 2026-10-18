import type { MembershipRole } from '@elysium/contracts';

/** The roles that place calls (`create PhoneCall`, D-831): the only people given an extension. */
export const CALLING_ROLES: readonly MembershipRole[] = ['sales', 'branch_manager', 'org_admin'];
