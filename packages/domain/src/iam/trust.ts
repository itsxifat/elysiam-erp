/**
 * Trust votes (D-654 to D-656): the brand's admins vouch for one of their own.
 *
 * Approvals refuse a checker who is in the requester's grant lineage (D-077, D-410):
 * whoever granted your role could have set your password, so you never approve their
 * requests. In a brand where the owner invited one admin and that admin invited the rest,
 * nobody but the owner can ever approve the first admin's requests. A trust vote is the
 * admins' answer: when enough **independent** admins vouch for a person, that person may
 * approve a request from someone in their lineage. Nobody ever approves their own.
 *
 * Independence is what stops one admin minting the votes (D-656). An admin's vote counts for
 * a candidate only when neither invited the other, directly or through others, and they
 * share no inviter, directly or through others — every granter ever recorded, active or
 * not. Super admins (owners among them) are left out of the shared-inviter test, since the
 * owner invites everyone and nobody would be independent.
 *
 * A super admin is above these rules (D-657, the owner's decision of 2026-10-07): with
 * two-step sign-in on, a super admin may vouch for anyone, someone they invited included,
 * and one super admin's vote makes the candidate trusted on its own. A super admin already
 * decides every request without the lineage rule (D-655), so their vote grants nothing they
 * could not already do. The lineage rules above still bind every admin who is not one.
 *
 * Who counts is decided **now**, never stored: a voter who stops being an active admin,
 * turns off two-step sign-in, or becomes related to the candidate stops counting at once.
 */

/** Someone who may vouch in this brand now: an active org admin, or an active super admin. */
export interface TrustPoolMember {
  readonly userId: string;
  readonly isSuperAdmin: boolean;
  /** Enrolled in two-step sign-in, or an owner whose link was minted behind one (D-473). */
  readonly twoFactor: boolean;
}

/** One recorded grant: `grantedBy` gave `userId` a role or a password link here. */
export interface GrantEdge {
  readonly userId: string;
  readonly grantedBy: string;
}

export interface TrustGraphInput {
  /** The brand's active admins and active super admins. */
  readonly pool: readonly TrustPoolMember[];
  /** Every grant ever recorded in the brand. */
  readonly grants: readonly GrantEdge[];
  /** Everyone who is a super admin now, active or not: left out of the shared-inviter test. */
  readonly superAdminIds: readonly string[];
}

export type TrustRefusalCode =
  | 'self'
  | 'not_admin'
  | 'no_two_factor'
  | 'invited_candidate'
  | 'invited_by_candidate'
  | 'same_inviter';

export type VoteStanding =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: TrustRefusalCode; readonly reason: string };

export const TRUST_REFUSAL_REASONS: Readonly<Record<TrustRefusalCode, string>> = {
  self: 'Nobody vouches for themselves.',
  not_admin: 'Only an active admin can vote.',
  no_two_factor: 'Turn on two-step sign-in to vote.',
  invited_candidate: 'You invited this person.',
  invited_by_candidate: 'This person invited you.',
  same_inviter: 'You were both invited by the same person.',
};

/** At least this many independent votes, whatever the count of voters: one alone never does. */
export const TRUST_QUORUM = 2;

export interface TrustTally {
  /** Votes from independent voters eligible now. */
  readonly votes: number;
  /** Two thirds of the eligible, rounded up, and never fewer than the quorum. */
  readonly needed: number;
  /** How many independent voters there are now. */
  readonly eligible: number;
  /** At two thirds of the eligible, or on one super admin's vote (D-657). */
  readonly trusted: boolean;
}

/** Two thirds of `eligible`, rounded up, in integers, and never below the quorum. */
export function trustVotesNeeded(eligible: number): number {
  if (!Number.isInteger(eligible) || eligible < 0) {
    throw new RangeError(`eligible must be a non-negative integer, got ${eligible}`);
  }
  return Math.max(TRUST_QUORUM, Math.ceil((2 * eligible) / 3));
}

export interface TrustGraph {
  /** Everyone who granted `userId`, directly or through others. Never `userId` itself. */
  ancestors(userId: string): ReadonlySet<string>;
  /** Neither invited the other, and they share no inviter but a super admin. Symmetric. */
  independent(a: string, b: string): boolean;
  /**
   * Whether `voterId`'s vote for `candidateId` would count now, and if not, why. A super
   * admin's always does, with two-step sign-in on (D-657); an admin's only when independent.
   */
  standing(voterId: string, candidateId: string): VoteStanding;
  /** The candidate's tally from these recorded voters; only the ones who may vote count. */
  tally(candidateId: string, voterIds: readonly string[]): TrustTally;
}

export function trustGraph(input: TrustGraphInput): TrustGraph {
  const granters = new Map<string, Set<string>>();
  for (const edge of input.grants) {
    if (edge.userId === edge.grantedBy) continue;
    const set = granters.get(edge.userId) ?? new Set<string>();
    set.add(edge.grantedBy);
    granters.set(edge.userId, set);
  }
  const superAdmins = new Set(input.superAdminIds);
  const pool = new Map(input.pool.map((member) => [member.userId, member]));
  const memo = new Map<string, ReadonlySet<string>>();

  function ancestors(userId: string): ReadonlySet<string> {
    const cached = memo.get(userId);
    if (cached !== undefined) return cached;
    // Iterative, with a visited set: a re-grant can make the recorded graph a cycle.
    const found = new Set<string>();
    const stack = [...(granters.get(userId) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop();
      if (next === undefined || found.has(next)) continue;
      found.add(next);
      for (const above of granters.get(next) ?? []) stack.push(above);
    }
    found.delete(userId);
    memo.set(userId, found);
    return found;
  }

  function relation(a: string, b: string): TrustRefusalCode | null {
    if (a === b) return 'self';
    if (ancestors(b).has(a)) return 'invited_candidate';
    if (ancestors(a).has(b)) return 'invited_by_candidate';
    const mine = ancestors(a);
    for (const id of ancestors(b)) {
      if (!superAdmins.has(id) && mine.has(id)) return 'same_inviter';
    }
    return null;
  }

  function standing(voterId: string, candidateId: string): VoteStanding {
    const refuse = (code: TrustRefusalCode): VoteStanding => ({
      ok: false,
      code,
      reason: TRUST_REFUSAL_REASONS[code],
    });
    if (voterId === candidateId) return refuse('self');
    const member = pool.get(voterId);
    if (member === undefined) return refuse('not_admin');
    if (!member.twoFactor) return refuse('no_two_factor');
    // The owner's decision (2026-10-07, D-657): a super admin holds supreme authority and may
    // vouch for anyone; the lineage rules below apply to admins vouching for one another.
    if (member.isSuperAdmin) return { ok: true };
    const related = relation(voterId, candidateId);
    return related === null ? { ok: true } : refuse(related);
  }

  function tally(candidateId: string, voterIds: readonly string[]): TrustTally {
    const eligible = new Set([...pool.keys()].filter((id) => standing(id, candidateId).ok));
    const votes = new Set(voterIds.filter((id) => eligible.has(id))).size;
    const needed = trustVotesNeeded(eligible.size);
    // One super admin's vote is enough on its own (D-657).
    const bySuperAdmin = voterIds.some(
      (id) => eligible.has(id) && pool.get(id)?.isSuperAdmin === true,
    );
    return { votes, needed, eligible: eligible.size, trusted: bySuperAdmin || votes >= needed };
  }

  return {
    ancestors,
    independent: (a, b) => relation(a, b) === null,
    standing,
    tally,
  };
}
