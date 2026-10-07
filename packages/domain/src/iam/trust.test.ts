import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  trustGraph,
  trustVotesNeeded,
  TRUST_QUORUM,
  type GrantEdge,
  type TrustGraphInput,
} from './index.js';

/**
 * The trust rule (D-654 to D-657), as properties over small random invitation forests.
 * The server tests it again against real Postgres, inside an approval decision.
 */

const PEOPLE = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] as const;

/**
 * A forest (each person invited by at most one earlier person), plus a few extra grants
 * such as a re-grant by a second admin — which may point anywhere, cycles included.
 */
const graphs = fc
  .record({
    parents: fc.array(fc.option(fc.nat(PEOPLE.length - 1), { nil: undefined }), {
      minLength: PEOPLE.length,
      maxLength: PEOPLE.length,
    }),
    extra: fc.array(fc.tuple(fc.constantFrom(...PEOPLE), fc.constantFrom(...PEOPLE)), {
      maxLength: 3,
    }),
    superAdmin: fc.array(fc.boolean(), { minLength: PEOPLE.length, maxLength: PEOPLE.length }),
    inPool: fc.array(fc.boolean(), { minLength: PEOPLE.length, maxLength: PEOPLE.length }),
    twoFactor: fc.array(fc.boolean(), { minLength: PEOPLE.length, maxLength: PEOPLE.length }),
  })
  .map(({ parents, extra, superAdmin, inPool, twoFactor }): TrustGraphInput => {
    const grants: GrantEdge[] = [];
    PEOPLE.forEach((person, index) => {
      const parent = parents[index];
      if (parent !== undefined && parent < index) {
        grants.push({ userId: person, grantedBy: PEOPLE[parent] ?? person });
      }
    });
    for (const [userId, grantedBy] of extra) grants.push({ userId, grantedBy });
    return {
      grants,
      superAdminIds: PEOPLE.filter((_, index) => superAdmin[index] === true),
      pool: PEOPLE.flatMap((person, index) =>
        inPool[index] === true
          ? [
              {
                userId: person,
                isSuperAdmin: superAdmin[index] === true,
                twoFactor: twoFactor[index] === true,
              },
            ]
          : [],
      ),
    };
  });

const person = fc.constantFrom(...PEOPLE);
const voters = fc.array(person, { maxLength: 10 });

/** Reachability by brute force, the reference the memoised walk is checked against. */
function referenceAncestors(grants: readonly GrantEdge[], userId: string): Set<string> {
  let found = new Set<string>();
  let frontier = new Set([userId]);
  for (let step = 0; step < PEOPLE.length + 1; step += 1) {
    const next = new Set<string>();
    for (const edge of grants) {
      if (frontier.has(edge.userId) && edge.grantedBy !== edge.userId) next.add(edge.grantedBy);
    }
    found = new Set([...found, ...next]);
    frontier = next;
  }
  found.delete(userId);
  return found;
}

function related(input: TrustGraphInput, a: string, b: string): boolean {
  const ancA = referenceAncestors(input.grants, a);
  const ancB = referenceAncestors(input.grants, b);
  if (a === b || ancA.has(b) || ancB.has(a)) return true;
  const superAdmins = new Set(input.superAdminIds);
  return [...ancA].some((id) => ancB.has(id) && !superAdmins.has(id));
}

describe('trustVotesNeeded', () => {
  it('is two thirds rounded up, never below the quorum of two', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 9].map(trustVotesNeeded)).toEqual([2, 2, 2, 2, 3, 4, 4, 6]);
  });

  it('is the smallest n ≥ 2 with 3n ≥ 2 × eligible', () => {
    fc.assert(
      fc.property(fc.nat(1000), (eligible) => {
        const needed = trustVotesNeeded(eligible);
        expect(needed).toBeGreaterThanOrEqual(TRUST_QUORUM);
        expect(3 * needed).toBeGreaterThanOrEqual(2 * eligible);
        if (needed > TRUST_QUORUM) expect(3 * (needed - 1)).toBeLessThan(2 * eligible);
      }),
    );
  });

  it('refuses a negative or fractional count', () => {
    expect(() => trustVotesNeeded(-1)).toThrow(RangeError);
    expect(() => trustVotesNeeded(1.5)).toThrow(RangeError);
  });
});

describe('trustGraph', () => {
  it('finds every inviter, however far up, cycles included', () => {
    fc.assert(
      fc.property(graphs, person, (input, who) => {
        expect([...trustGraph(input).ancestors(who)].sort()).toEqual(
          [...referenceAncestors(input.grants, who)].sort(),
        );
      }),
    );
  });

  it('independence is symmetric', () => {
    fc.assert(
      fc.property(graphs, person, person, (input, a, b) => {
        const graph = trustGraph(input);
        expect(graph.independent(a, b)).toBe(graph.independent(b, a));
      }),
    );
  });

  it('independence is exactly: neither invited the other and no shared inviter but a super admin', () => {
    fc.assert(
      fc.property(graphs, person, person, (input, a, b) => {
        expect(trustGraph(input).independent(a, b)).toBe(!related(input, a, b));
      }),
    );
  });

  it('counts a super admin with two-step sign-in always, an admin only when unrelated', () => {
    fc.assert(
      fc.property(graphs, person, voters, (input, candidate, cast) => {
        const graph = trustGraph(input);
        const pool = new Map(input.pool.map((member) => [member.userId, member]));
        const counts = (voter: string): boolean => {
          const member = pool.get(voter);
          if (voter === candidate || member?.twoFactor !== true) return false;
          return member.isSuperAdmin || !related(input, voter, candidate);
        };
        expect(graph.tally(candidate, cast).votes).toBe(new Set(cast.filter(counts)).size);
        for (const voter of cast) expect(graph.standing(voter, candidate).ok).toBe(counts(voter));
      }),
    );
  });

  it('never counts an admin who is not a super admin and is related to the candidate', () => {
    fc.assert(
      fc.property(graphs, person, person, (input, voter, candidate) => {
        const member = input.pool.find((entry) => entry.userId === voter);
        if (member?.isSuperAdmin === true) return;
        if (related(input, voter, candidate)) {
          expect(trustGraph(input).standing(voter, candidate).ok).toBe(false);
        }
      }),
    );
  });

  it('trusts on one vote from a super admin, else exactly at two thirds and never on fewer than two', () => {
    fc.assert(
      fc.property(graphs, person, voters, (input, candidate, cast) => {
        const graph = trustGraph(input);
        const tally = graph.tally(candidate, cast);
        const bySuperAdmin = cast.some(
          (voter) =>
            graph.standing(voter, candidate).ok &&
            input.pool.some((member) => member.userId === voter && member.isSuperAdmin),
        );
        expect(tally.trusted).toBe(
          bySuperAdmin || (tally.votes >= TRUST_QUORUM && 3 * tally.votes >= 2 * tally.eligible),
        );
        if (tally.trusted && !bySuperAdmin) expect(tally.votes).toBeGreaterThanOrEqual(2);
        expect(tally.votes).toBeLessThanOrEqual(tally.eligible);
      }),
    );
  });

  it('admins alone, without a super admin, never make anyone trusted on one vote', () => {
    fc.assert(
      fc.property(graphs, person, voters, (input, candidate, cast) => {
        const admins = cast.filter(
          (voter) => !input.pool.some((member) => member.userId === voter && member.isSuperAdmin),
        );
        const tally = trustGraph(input).tally(candidate, admins);
        if (tally.votes < TRUST_QUORUM) expect(tally.trusted).toBe(false);
      }),
    );
  });

  it('a withdrawn vote never makes anyone more trusted', () => {
    fc.assert(
      fc.property(graphs, person, voters, fc.nat(), (input, candidate, cast, pick) => {
        if (cast.length === 0) return;
        const graph = trustGraph(input);
        const gone = cast[pick % cast.length];
        const before = graph.tally(candidate, cast);
        const after = graph.tally(
          candidate,
          cast.filter((id) => id !== gone),
        );
        expect(after.votes).toBeLessThanOrEqual(before.votes);
        if (!before.trusted) expect(after.trusted).toBe(false);
      }),
    );
  });

  it('an admin who is not a super admin never vouches for anyone they invited, however far down', () => {
    fc.assert(
      fc.property(graphs, person, (input, candidate) => {
        const graph = trustGraph(input);
        const superAdmins = new Set(
          input.pool.filter((member) => member.isSuperAdmin).map((member) => member.userId),
        );
        for (const ancestor of graph.ancestors(candidate)) {
          if (!superAdmins.has(ancestor)) {
            expect(graph.standing(ancestor, candidate).ok).toBe(false);
          }
        }
      }),
    );
  });

  it('a super admin with two-step sign-in may vouch for anyone else, and alone makes them trusted', () => {
    fc.assert(
      fc.property(graphs, person, (input, candidate) => {
        const graph = trustGraph(input);
        for (const member of input.pool) {
          if (!member.isSuperAdmin || member.userId === candidate) continue;
          expect(graph.standing(member.userId, candidate).ok).toBe(member.twoFactor);
          expect(graph.tally(candidate, [member.userId]).trusted).toBe(member.twoFactor);
        }
        expect(graph.standing(candidate, candidate)).toMatchObject({ ok: false, code: 'self' });
      }),
    );
  });
});

describe('the Riya scenario', () => {
  // The owner invited Riya; Riya invited Faisal and two puppets. Sam is a second super
  // admin; Nadia an admin nobody here invited.
  const input: TrustGraphInput = {
    grants: [
      { userId: 'riya', grantedBy: 'owner' },
      { userId: 'faisal', grantedBy: 'riya' },
      { userId: 'puppet1', grantedBy: 'riya' },
      { userId: 'puppet2', grantedBy: 'riya' },
      { userId: 'nadia', grantedBy: 'sam' },
    ],
    superAdminIds: ['owner', 'sam'],
    pool: ['owner', 'sam']
      .map((userId) => ({ userId, isSuperAdmin: true, twoFactor: true }))
      .concat(
        ['riya', 'faisal', 'puppet1', 'puppet2', 'nadia'].map((userId) => ({
          userId,
          isSuperAdmin: false,
          twoFactor: true,
        })),
      ),
  };
  const graph = trustGraph(input);

  it('refuses the inviter and the puppets, each with its reason', () => {
    expect(graph.standing('riya', 'faisal')).toMatchObject({
      ok: false,
      code: 'invited_candidate',
    });
    expect(graph.standing('puppet1', 'faisal')).toMatchObject({ ok: false, code: 'same_inviter' });
    expect(graph.standing('faisal', 'riya')).toMatchObject({
      ok: false,
      code: 'invited_by_candidate',
    });
    expect(graph.standing('faisal', 'faisal')).toMatchObject({ ok: false, code: 'self' });
  });

  it('lets the owner vouch for someone down their own chain (D-657)', () => {
    expect(graph.standing('owner', 'faisal')).toEqual({ ok: true });
    expect(graph.standing('owner', 'riya')).toEqual({ ok: true });
  });

  it('the puppets cannot make Faisal trusted', () => {
    expect(graph.tally('faisal', ['riya', 'puppet1', 'puppet2']).trusted).toBe(false);
  });

  it('one vote from a super admin does, on its own', () => {
    expect(graph.tally('faisal', ['owner']).trusted).toBe(true);
    expect(graph.tally('faisal', ['sam']).trusted).toBe(true);
    expect(graph.tally('riya', ['owner']).trusted).toBe(true);
  });

  it('an independent admin alone does not; with a second voter they do', () => {
    // The owner, Sam and Nadia may vote for Faisal: two of the three are needed.
    expect(graph.tally('faisal', ['nadia'])).toEqual({
      votes: 1,
      needed: 2,
      eligible: 3,
      trusted: false,
    });
    expect(graph.tally('faisal', ['sam', 'nadia'])).toEqual({
      votes: 2,
      needed: 2,
      eligible: 3,
      trusted: true,
    });
  });
});
