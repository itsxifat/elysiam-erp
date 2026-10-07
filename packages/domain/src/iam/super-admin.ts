/**
 * Super admins making super admins (D-659): the owner's rule of 2026-10-07.
 *
 * "Super admin can add more super admin, and that will give him the supreme authority
 * immediately for the second supreme admin, but if there is a third one he needs the first
 * ones' votes."
 *
 * - Only an active super admin nominates or votes. Nobody nominates themselves, and an owner
 *   or someone who is a super admin already is never a candidate.
 * - The candidate is an active admin of this brand: an existing one promoted, or a new
 *   person invited as an admin in the same request. They meet the two-step wall at their
 *   next request, as every super admin does.
 * - While the brand has at most one active super admin, a nomination promotes at once.
 *   With two or more, it waits until **every** one of them has voted yes; the last vote
 *   promotes, in its own transaction. Until then the candidate has no super admin power.
 *
 * Owners (D-473) are left out of the count and of the votes required, as `admin:bootstrap`
 * leaves them out (D-477): they are not accounts of this brand, and an owner's visit must not
 * turn the brand's second super admin into a wait. An owner may still nominate and vote.
 *
 * The database holds the same rule in `iam.promote_super_admin` (migration 0128): the only
 * way the application sets the flag, so a mistake here cannot mint a super admin there.
 *
 * Only the first super admin starts a nomination (the owner's decision of 2026-10-07, D-666):
 * whoever invites a person receives their set-password link, so a second super admin invited
 * by anyone else could be a second account of the same person. The first is the earliest
 * active super admin of the brand (owners aside); an owner may start one too. Any super admin
 * still votes on a nomination already started.
 */

export type NominationRefusalCode =
  'not_super_admin' | 'not_first_super_admin' | 'self' | 'already_super_admin' | 'not_admin_here';

export const NOMINATION_REFUSAL_REASONS: Readonly<Record<NominationRefusalCode, string>> = {
  not_super_admin: 'Only a super admin can make a super admin.',
  not_first_super_admin:
    'Only the first super admin can add a super admin. You can vote on one they have started.',
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

/** Why `actor` may not nominate or vote for `candidate`, or null when they may. */
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

/**
 * Whether `actorId` may start a nomination nobody has voted for yet (D-666): the first super
 * admin, or an owner. `starters` are those people now.
 */
export function startRefusal(
  actorId: string,
  starters: ReadonlySet<string>,
): NominationRefusalCode | null {
  return starters.has(actorId) ? null : 'not_first_super_admin';
}

/** Whether a candidate can be nominated at all, whoever asks: for showing the action. */
export function isSuperAdminCandidate(candidate: NominationCandidate): boolean {
  return (
    candidate.isActive && !candidate.isSuperAdmin && !candidate.isOwner && candidate.activeAdminHere
  );
}

export interface NominationTally {
  /** Yes votes from the super admins whose vote is required. */
  readonly votes: number;
  /** How many super admins must vote yes: all of them, or none while there is one or none. */
  readonly needed: number;
  /** At most one super admin: a nomination promotes at once. */
  readonly immediate: boolean;
  /** Every required vote is in, or none is required: the next yes promotes. */
  readonly complete: boolean;
}

/**
 * Count a nomination. `superAdmins` are the brand's active super admins now, owners left out;
 * `voters` everyone with a yes recorded, counted or not. Counted live, never stored: a super
 * admin who leaves stops being required at once.
 */
export function nominationTally(
  superAdmins: readonly string[],
  voters: readonly string[],
): NominationTally {
  const required = new Set(superAdmins);
  const immediate = required.size <= 1;
  if (immediate) return { votes: 0, needed: 0, immediate, complete: true };
  const votes = new Set(voters.filter((id) => required.has(id))).size;
  return { votes, needed: required.size, immediate, complete: votes === required.size };
}
