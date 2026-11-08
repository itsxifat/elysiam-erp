/**
 * Making a super admin (D-954, replacing D-659 and D-666's votes and "first super admin").
 *
 * The permission is the rule: an active super admin makes an active admin of this brand a
 * super admin, at once. Nobody makes themselves one (they would have to be one already),
 * and an owner or a super admin is never a candidate. There are no votes and no order among
 * super admins.
 *
 * The database holds the same rule in `iam.promote_super_admin` (migration 0170): the only
 * way the application sets the flag, so a mistake here cannot mint a super admin there.
 */

export type NominationRefusalCode =
  'not_super_admin' | 'self' | 'already_super_admin' | 'not_admin_here';

export const NOMINATION_REFUSAL_REASONS: Readonly<Record<NominationRefusalCode, string>> = {
  not_super_admin: 'Only a super admin can make a super admin.',
  self: 'Nobody makes themselves a super admin.',
  already_super_admin: 'This person holds super admin authority already.',
  not_admin_here: 'Only an active admin of this brand can be made a super admin.',
};

export interface NominationActor {
  readonly userId: string;
  /** An active super admin now, an owner included. */
  readonly isSuperAdmin: boolean;
}

export interface NominationCandidate {
  readonly userId: string;
  /** The account is switched on. */
  readonly isActive: boolean;
  readonly isSuperAdmin: boolean;
  readonly isOwner: boolean;
  /** Holds the org admin role here, switched on. */
  readonly activeAdminHere: boolean;
}

/** Why `actor` may not make `candidate` a super admin, or null when they may. */
export function nominationRefusal(
  actor: NominationActor,
  candidate: NominationCandidate,
): NominationRefusalCode | null {
  if (!actor.isSuperAdmin) return 'not_super_admin';
  if (actor.userId === candidate.userId) return 'self';
  if (candidate.isSuperAdmin || candidate.isOwner) return 'already_super_admin';
  if (!candidate.isActive || !candidate.activeAdminHere) return 'not_admin_here';
  return null;
}

/** Whether a candidate can be made a super admin at all, whoever asks: for showing the action. */
export function isSuperAdminCandidate(candidate: NominationCandidate): boolean {
  return (
    candidate.isActive && !candidate.isSuperAdmin && !candidate.isOwner && candidate.activeAdminHere
  );
}
