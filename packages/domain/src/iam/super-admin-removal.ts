import { nominationTally, type NominationActor, type NominationTally } from './super-admin.js';

/**
 * Removing a super admin (D-685 to D-689), the other half of D-659.
 *
 * - **Stepping down.** A super admin gives up their own super admin power at once. The last
 *   active super admin (owners aside) cannot: the brand is never left without one. When the
 *   first super admin steps down, the next earliest becomes the first, since "the first" is
 *   read live (D-666).
 * - **Removing another.** Started only by the first super admin or an owner, like a
 *   nomination (D-666); it needs a yes from every other active super admin except the one
 *   being removed. With two super admins the first removes the second at once. The first
 *   super admin is never removed by the others, only by stepping down; an owner is never
 *   removed here at all.
 *
 * Owners are left out of the count and of the votes required, as for nominations (D-660).
 * Removal ends super admin power only: an admin role in the brand stays.
 *
 * The database holds the same rule in `iam.demote_super_admin` (migration 0139), the only
 * way the flag is cleared, so a mistake here cannot remove a super admin there.
 */

export type RemovalRefusalCode =
  | 'not_super_admin'
  | 'not_first_super_admin'
  | 'self'
  | 'not_removable'
  | 'first_super_admin'
  | 'last_super_admin';

export const REMOVAL_REFUSAL_REASONS: Readonly<Record<RemovalRefusalCode, string>> = {
  not_super_admin: 'Only a super admin can remove a super admin.',
  not_first_super_admin:
    'Only the first super admin can start removing a super admin. You can vote on one they have started.',
  self: 'To give up your own super admin power, step down.',
  not_removable: 'Only an active super admin who is not an owner can be removed or step down.',
  first_super_admin: 'The first super admin is removed only by stepping down.',
  last_super_admin: 'The last super admin cannot step down or be removed.',
};

export interface RemovalTarget {
  readonly userId: string;
  /** The account is switched on. */
  readonly isActive: boolean;
  readonly isSuperAdmin: boolean;
  readonly isOwner: boolean;
}

export interface RemovalFacts {
  /** The brand's active super admins now, owners left out. */
  readonly superAdmins: readonly string[];
  /** The first super admin now: the earliest of them, or null when there is none. */
  readonly first: string | null;
}

/** Whether a person is a super admin whom the removal rules reach at all. */
export function isRemovableSuperAdmin(target: RemovalTarget): boolean {
  return target.isActive && target.isSuperAdmin && !target.isOwner;
}

/**
 * Why `actor` may not start or vote for removing `target`, or null when they may. Whether
 * they may *start* one nobody has voted for yet is `startRefusal` (D-666) on top of this.
 */
export function removalRefusal(
  actor: NominationActor,
  target: RemovalTarget,
  facts: RemovalFacts,
): RemovalRefusalCode | null {
  if (!actor.isSuperAdmin) return 'not_super_admin';
  if (actor.userId === target.userId) return 'self';
  if (!isRemovableSuperAdmin(target)) return 'not_removable';
  if (target.userId === facts.first) return 'first_super_admin';
  if (!facts.superAdmins.some((id) => id !== target.userId)) return 'last_super_admin';
  return null;
}

/** Why `actor` may not step down now, or null when they may. */
export function stepDownRefusal(
  actor: NominationActor & { readonly isOwner: boolean },
  facts: Pick<RemovalFacts, 'superAdmins'>,
): RemovalRefusalCode | null {
  if (!actor.isSuperAdmin) return 'not_super_admin';
  if (actor.isOwner) return 'not_removable';
  if (!facts.superAdmins.some((id) => id !== actor.userId)) return 'last_super_admin';
  return null;
}

/**
 * Count a removal. The yes votes required are those of every active super admin but the
 * one being removed (owners aside); while that leaves at most one, the removal is at once,
 * as a nomination is while the brand has one super admin. Counted live, never stored: a
 * voter who stops being a super admin stops counting, and the target's own vote never does.
 */
export function removalTally(
  superAdmins: readonly string[],
  targetId: string,
  voters: readonly string[],
): NominationTally {
  return nominationTally(
    superAdmins.filter((id) => id !== targetId),
    voters,
  );
}
