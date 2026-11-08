import type { MembershipRole } from '@elysium/contracts';

import { api } from '../../api.js';

/**
 * The staff endpoints, typed to what the server returns (gaps-users-auth, §23).
 *
 * Hand-written against `users.controller.ts`, like the other sections' `api.ts`: the
 * generated client still types results as `unknown`. A link token is a string the admin
 * passes on; it is never logged, stored or put in a query string here.
 */

export type StaffStatus = 'active' | 'invited' | 'deactivated' | 'disabled';

export interface RoleGrant {
  readonly role: MembershipRole;
  readonly branchIds: readonly string[];
}

export interface StaffRow {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly status: StaffStatus;
  readonly roles: readonly RoleGrant[];
  readonly formerRoles: readonly MembershipRole[];
  readonly twoFactorEnabled: boolean;
  readonly twoFactorRequired: boolean;
  readonly lastSignInAt: string | null;
  readonly hasPassword: boolean;
  readonly linkExpiresAt: string | null;
  readonly isSuperAdmin: boolean;
  /** An owner, listed as a super admin (D-658); name and email are empty unless you are one. */
  readonly isOwner: boolean;
  /** Holds or held a role here: the Staff screen's actions reach them. */
  readonly hasRoleHere: boolean;
  readonly inOtherBrand: boolean;
  readonly isSelf: boolean;
  /** The viewer may make this person a super admin now (D-954). */
  readonly canMakeSuperAdmin: boolean;
  /** The viewer may remove this person's super admin power now (D-954). */
  readonly canRemoveSuperAdmin: boolean;
  /** The viewer's own row, and another super admin remains. */
  readonly canStepDown: boolean;
}

export interface NominationOutcome {
  readonly userId: string;
  readonly outcome: 'promoted';
}

export interface RemovalOutcome {
  readonly userId: string;
  readonly outcome: 'removed';
  readonly sessionsEnded: number;
}

export interface OpenReset {
  readonly id: string;
  readonly userId: string;
  readonly kind: 'password' | 'two_factor';
  readonly status: 'pending_approval' | 'approved';
  readonly requestedBy: string;
  /** Null for an owner unless the viewer is one too (D-473). */
  readonly requestedByName: string | null;
  readonly requestedByOwner?: boolean;
  readonly reason: string;
  readonly approvalRequestId: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly mine: boolean;
}

export type LinkOutcome =
  | {
      readonly outcome: 'issued';
      readonly kind: 'invite' | 'password';
      readonly token: string;
      readonly expiresAt: string;
    }
  | {
      readonly outcome: 'pending_approval';
      readonly resetId: string;
      readonly approvalRequestId: string;
    };

export type TwoFactorOutcome =
  | { readonly outcome: 'completed'; readonly resetId: string; readonly sessionsEnded: number }
  | {
      readonly outcome: 'pending_approval';
      readonly resetId: string;
      readonly approvalRequestId: string;
    };

export function listStaff(): Promise<{
  items: readonly StaffRow[];
  resets: readonly OpenReset[];
  /** Any super admin invites a super admin (D-954). */
  canStartSuperAdmin?: boolean;
}> {
  return api.get('/v1/users');
}

export function setRoles(userId: string, roles: readonly RoleGrant[]): Promise<StaffRow> {
  return api.put<StaffRow>(`/v1/users/${encodeURIComponent(userId)}/roles`, { roles });
}

export function deactivate(
  userId: string,
  reason: string,
): Promise<{ userId: string; sessionsEnded: number }> {
  return api.post(`/v1/users/${encodeURIComponent(userId)}/deactivate`, {
    ...(reason === '' ? {} : { reason }),
  });
}

export function passwordLink(userId: string, reason: string): Promise<LinkOutcome> {
  return api.post<LinkOutcome>(`/v1/users/${encodeURIComponent(userId)}/password-link`, {
    reason,
  });
}

export function resetTwoFactor(userId: string, reason: string): Promise<TwoFactorOutcome> {
  return api.post<TwoFactorOutcome>(`/v1/users/${encodeURIComponent(userId)}/two-factor/reset`, {
    reason,
  });
}

/** Turn two-step sign-in off where no role requires it (M40, D-697); a reset otherwise. */
export function turnOffTwoFactor(userId: string, reason: string): Promise<TwoFactorOutcome> {
  return api.post<TwoFactorOutcome>(`/v1/users/${encodeURIComponent(userId)}/two-factor/turn-off`, {
    reason,
  });
}

/** End every session a person has (M40, D-696). */
export function signOutEverywhere(
  userId: string,
): Promise<{ userId: string; sessionsEnded: number; scope: 'all' }> {
  return api.post(`/v1/users/${encodeURIComponent(userId)}/sign-out-everywhere`);
}

/** Make an active admin a super admin, at once (D-954). */
export function makeSuperAdmin(userId: string): Promise<NominationOutcome> {
  return api.post(`/v1/users/${encodeURIComponent(userId)}/super-admin`);
}

/** Remove a super admin's super admin power, at once (D-954). */
export function removeSuperAdmin(userId: string): Promise<RemovalOutcome> {
  return api.post(`/v1/users/${encodeURIComponent(userId)}/super-admin-removal`);
}

/** Give up your own super admin power; your sessions end, this one included (D-685). */
export function stepDown(): Promise<{ userId: string; sessionsEnded: number }> {
  return api.post('/v1/users/me/step-down');
}

export function invite(input: {
  email: string;
  name: string;
  role: MembershipRole;
  branchIds: readonly string[];
  /** Invite them as a super admin too (D-954); the role is then org_admin. */
  superAdmin?: boolean;
}): Promise<{
  userId: string;
  created: boolean;
  inviteToken?: string;
  inviteExpiresAt?: string;
  superAdmin?: NominationOutcome;
}> {
  return api.post('/v1/users', input);
}
