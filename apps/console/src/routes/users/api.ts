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
  readonly inOtherBrand: boolean;
  readonly isSelf: boolean;
  readonly resetNeedsApproval: boolean;
  /** For an active admin who is not a super admin: the admins' trust in them (D-654). */
  readonly trust: TrustView | null;
}

export type TrustRefusalCode =
  | 'self'
  | 'not_admin'
  | 'no_two_factor'
  | 'invited_candidate'
  | 'invited_by_candidate'
  | 'same_inviter';

/** The admins' trust in one admin, as this viewer sees it (D-654 to D-656). */
export interface TrustView {
  readonly votes: number;
  readonly needed: number;
  readonly trusted: boolean;
  /** This viewer has a vote recorded: theirs to withdraw. */
  readonly votedByMe: boolean;
  /** This viewer's vote would count. */
  readonly canVote: boolean;
  readonly reason: string | null;
  readonly reasonCode: TrustRefusalCode | null;
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

export function voteTrust(userId: string): Promise<{ userId: string; trust: TrustView }> {
  return api.post(`/v1/users/${encodeURIComponent(userId)}/trust`);
}

export function withdrawTrust(userId: string): Promise<{ userId: string; trust: TrustView }> {
  return api.delete(`/v1/users/${encodeURIComponent(userId)}/trust`);
}

export function invite(input: {
  email: string;
  name: string;
  role: MembershipRole;
  branchIds: readonly string[];
}): Promise<{
  userId: string;
  created: boolean;
  inviteToken?: string;
  inviteExpiresAt?: string;
}> {
  return api.post('/v1/users', input);
}
