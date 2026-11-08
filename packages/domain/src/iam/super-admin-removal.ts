import type { NominationActor } from './super-admin.js';

/**
 * Removing a super admin (D-954, replacing D-685 to D-689's votes and "first super admin").
 *
 * - **Stepping down.** A super admin gives up their own super admin power at once.
 * - **Removing another.** Any active super admin removes another at once. An owner is never
 *   removed here.
 * - **Never none.** The last active super admin (owners aside) can neither step down nor be
 *   removed: the brand is never left without one.
 *
 * Removal ends super admin power only: an admin role in the brand stays. The database holds
 * the same rule in `iam.demote_super_admin` (migration 0170), the only way the flag is
 * cleared, so a mistake here cannot remove a super admin there.
 */

export type RemovalRefusalCode = 'not_super_admin' | 'self' | 'not_removable' | 'last_super_admin';

export const REMOVAL_REFUSAL_REASONS: Readonly<Record<RemovalRefusalCode, string>> = {
  not_super_admin: 'Only a super admin can remove a super admin.',
  self: 'To give up your own super admin power, step down.',
  not_removable: 'Only an active super admin who is not an owner can be removed or step down.',
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
}

/** Whether a person is a super admin whom the removal rules reach at all. */
export function isRemovableSuperAdmin(target: RemovalTarget): boolean {
  return target.isActive && target.isSuperAdmin && !target.isOwner;
}

/** Why `actor` may not remove `target`, or null when they may. */
export function removalRefusal(
  actor: NominationActor,
  target: RemovalTarget,
  facts: RemovalFacts,
): RemovalRefusalCode | null {
  if (!actor.isSuperAdmin) return 'not_super_admin';
  if (actor.userId === target.userId) return 'self';
  if (!isRemovableSuperAdmin(target)) return 'not_removable';
  if (!facts.superAdmins.some((id) => id !== target.userId)) return 'last_super_admin';
  return null;
}

/** Why `actor` may not step down now, or null when they may. */
export function stepDownRefusal(
  actor: NominationActor & { readonly isOwner: boolean },
  facts: RemovalFacts,
): RemovalRefusalCode | null {
  if (!actor.isSuperAdmin) return 'not_super_admin';
  if (actor.isOwner) return 'not_removable';
  if (!facts.superAdmins.some((id) => id !== actor.userId)) return 'last_super_admin';
  return null;
}
