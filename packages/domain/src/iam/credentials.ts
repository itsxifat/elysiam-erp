/**
 * Staff sign-in resets: who may reset whose password or second factor, and how
 * (gaps-users-auth, D-402 to D-406).
 *
 * Pure: the server reads the facts (who is acting, who the person is, what they
 * hold) and this decides. The rules are the security boundary of the whole
 * feature, so they live where a property test can walk every combination rather
 * than inside a service where only the cases somebody thought of get exercised.
 */

export type ResetKind = 'password' | 'two_factor';

/** What a reset does once it is allowed. `invite` is a password link for someone who never set one. */
export type ResetEffect = 'invite' | 'password' | 'two_factor';

export type ResetRefusal =
  'USER_SELF_MANAGEMENT' | 'USER_PROTECTED' | 'USER_INACTIVE' | 'CREDENTIAL_NOTHING_TO_RESET';

export interface ResetActor {
  readonly userId: string;
  readonly isSuperAdmin: boolean;
}

export interface ResetTarget {
  readonly userId: string;
  readonly isSuperAdmin: boolean;
  /** Holds an active role in the acting brand, and the account itself is enabled. */
  readonly activeHere: boolean;
  /** Holds an active role in any other brand: a password link opens those too (D-405). */
  readonly inOtherBrand: boolean;
  /** Has a password account: they have redeemed an invite at least once. */
  readonly hasPasswordAccount: boolean;
  readonly twoFactorEnabled: boolean;
  /**
   * Their roles here can decide an approval at org tier (contracts'
   * `resetNeedsSecondPerson`), so a reset needs a second admin (D-404).
   */
  readonly needsSecondPerson: boolean;
}

export type ResetPlan =
  | { readonly decision: 'refuse'; readonly code: ResetRefusal; readonly reason: string }
  | { readonly decision: 'now'; readonly effect: ResetEffect }
  | { readonly decision: 'approval'; readonly effect: 'password' | 'two_factor' };

/**
 * Decide a reset (D-402 to D-406). In order, and each refusal is final:
 *
 * 1. **Never yourself.** An admin who could reset their own second factor could
 *    remove the factor §6 requires of them without anyone seeing it.
 * 2. **Only a super admin touches a super admin.**
 * 3. **Only someone still here.** A leaver is deactivated, not reset.
 * 4. **Only a super admin resets someone in more than one brand** (D-405): a password
 *    link opens every brand they work in, and an org admin of one brand must not be
 *    able to sign in as a colleague of another.
 * 5. **Nothing to reset** is said plainly, rather than "done".
 *
 * Then: a password link for someone who never set a password is a re-sent invite,
 * issued at once (D-406: the issuer is recorded as the granter instead). A super
 * admin acts alone. A person who can decide approvals at org tier needs a second
 * admin (D-404). Everyone else is reset at once.
 */
export function planCredentialReset(input: {
  readonly actor: ResetActor;
  readonly target: ResetTarget;
  readonly kind: ResetKind;
}): ResetPlan {
  const { actor, target, kind } = input;

  if (actor.userId === target.userId) {
    return refuse('USER_SELF_MANAGEMENT', 'Nobody resets their own sign-in. Ask another admin.');
  }
  if (target.isSuperAdmin && !actor.isSuperAdmin) {
    return refuse('USER_PROTECTED', 'Only a super admin can reset a super admin.');
  }
  if (!target.activeHere) {
    return refuse('USER_INACTIVE', 'This person is deactivated here. Give them a role first.');
  }
  if (target.inOtherBrand && !actor.isSuperAdmin) {
    return refuse(
      'USER_PROTECTED',
      'This person also belongs to another brand, so only a super admin can reset their sign-in.',
    );
  }
  if (kind === 'two_factor' && !target.twoFactorEnabled) {
    return refuse(
      'CREDENTIAL_NOTHING_TO_RESET',
      'This person has no two-step verification to reset.',
    );
  }

  if (kind === 'password' && !target.hasPasswordAccount)
    return { decision: 'now', effect: 'invite' };
  if (actor.isSuperAdmin) return { decision: 'now', effect: kind };
  if (target.needsSecondPerson) return { decision: 'approval', effect: kind };
  return { decision: 'now', effect: kind };
}

function refuse(code: ResetRefusal, reason: string): ResetPlan {
  return { decision: 'refuse', code, reason };
}

/** How long an approved password reset waits for the admin who asked to collect its link (D-404). */
export const COLLECT_WINDOW_SECONDS = 24 * 60 * 60;

export function isCollectable(approvedAt: Date, now: Date): boolean {
  const age = now.getTime() - approvedAt.getTime();
  return age >= 0 && age <= COLLECT_WINDOW_SECONDS * 1000;
}

/**
 * The reset limits (D-402), per brand: an admin may ask for 20 resets an hour, and
 * one person may be reset 5 times a day. Counted from the reset log rather than in
 * memory, so every API replica agrees and a restart forgives nothing.
 */
export const RESET_LIMITS = {
  perActorPerHour: 20,
  perTargetPerDay: 5,
} as const;

export function resetAllowedByLimits(counts: {
  readonly byActorLastHour: number;
  readonly forTargetLastDay: number;
}): boolean {
  return (
    counts.byActorLastHour < RESET_LIMITS.perActorPerHour &&
    counts.forTargetLastDay < RESET_LIMITS.perTargetPerDay
  );
}

export type ResetStatus =
  'pending_approval' | 'approved' | 'completed' | 'rejected' | 'cancelled' | 'expired';

/**
 * The reset log's lifecycle, which migration 0099's trigger enforces as well.
 *
 * A reset waiting for approval is approved, rejected or cancelled (the person was
 * deactivated); a second-factor reset is carried out by its approval, so it may go
 * straight to completed. An approved password reset is collected, cancelled or left
 * to expire. Every other status is final.
 */
const NEXT: Readonly<Record<ResetStatus, readonly ResetStatus[]>> = {
  pending_approval: ['approved', 'completed', 'rejected', 'cancelled'],
  approved: ['completed', 'cancelled', 'expired'],
  completed: [],
  rejected: [],
  cancelled: [],
  expired: [],
};

export function canMoveReset(from: ResetStatus, to: ResetStatus): boolean {
  return NEXT[from].includes(to);
}

export const OPEN_RESET_STATUSES: readonly ResetStatus[] = ['pending_approval', 'approved'];

// --- roles ---------------------------------------------------------------------------

export interface HeldRole<Role extends string = string> {
  readonly role: Role;
  readonly active: boolean;
  readonly branchIds: readonly string[];
}

export interface WantedRole<Role extends string = string> {
  readonly role: Role;
  readonly branchIds: readonly string[];
}

export interface RoleChange<Role extends string = string> {
  /** Not held, or held and switched off: granted now. */
  readonly grant: readonly Role[];
  /** Held and active, with a different branch scope: granted again with the new one. */
  readonly reshape: readonly Role[];
  /** Held, active and unchanged. */
  readonly keep: readonly Role[];
  /** Held and active, and no longer wanted: switched off, history kept. */
  readonly revoke: readonly Role[];
}

function sameBranches(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a.map((id) => id.toLowerCase()));
  const right = new Set(b.map((id) => id.toLowerCase()));
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

/**
 * What replacing a person's roles in a brand changes (D-400).
 *
 * Every grant and every reshape is written with the acting admin as the granter, so
 * D-077's rule — nobody approves for whoever granted their role — follows the
 * person's role as it now stands. A role kept exactly as it was keeps its granter.
 */
export function planRoleChange<Role extends string>(
  held: readonly HeldRole<Role>[],
  wanted: readonly WantedRole<Role>[],
): RoleChange<Role> {
  const grant: Role[] = [];
  const reshape: Role[] = [];
  const keep: Role[] = [];
  const revoke: Role[] = [];

  for (const want of wanted) {
    const current = held.find((entry) => entry.role === want.role);
    if (current?.active !== true) grant.push(want.role);
    else if (sameBranches(current.branchIds, want.branchIds)) keep.push(want.role);
    else reshape.push(want.role);
  }
  for (const current of held) {
    if (current.active && !wanted.some((want) => want.role === current.role)) {
      revoke.push(current.role);
    }
  }
  return { grant, reshape, keep, revoke };
}
