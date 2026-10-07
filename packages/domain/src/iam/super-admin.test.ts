import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  startRefusal,
  isSuperAdminCandidate,
  nominationRefusal,
  nominationTally,
  type NominationCandidate,
} from './index.js';

/**
 * Super admins making super admins (D-659), as properties. The database holds the same rule
 * in `iam.promote_super_admin`; the server tests that one against real Postgres.
 */

const PEOPLE = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
const person = fc.constantFrom(...PEOPLE);
const people = fc.uniqueArray(person, { maxLength: PEOPLE.length });
const voters = fc.array(person, { maxLength: 10 });

const candidates = fc.record({
  userId: person,
  isActive: fc.boolean(),
  isSuperAdmin: fc.boolean(),
  isOwner: fc.boolean(),
  activeAdminHere: fc.boolean(),
}) satisfies fc.Arbitrary<NominationCandidate>;

describe('nominationTally', () => {
  it('promotes at once while the brand has one super admin or none', () => {
    fc.assert(
      fc.property(fc.uniqueArray(person, { maxLength: 1 }), voters, (superAdmins, cast) => {
        expect(nominationTally(superAdmins, cast)).toEqual({
          votes: 0,
          needed: 0,
          immediate: true,
          complete: true,
        });
      }),
    );
  });

  it('with two or more, completes exactly when every one of them has voted yes', () => {
    fc.assert(
      fc.property(people, voters, (superAdmins, cast) => {
        if (superAdmins.length < 2) return;
        const tally = nominationTally(superAdmins, cast);
        expect(tally.immediate).toBe(false);
        expect(tally.needed).toBe(superAdmins.length);
        expect(tally.complete).toBe(superAdmins.every((id) => cast.includes(id)));
        expect(tally.votes).toBe(superAdmins.filter((id) => cast.includes(id)).length);
      }),
    );
  });

  it('counts only the super admins whose vote is required, once each', () => {
    fc.assert(
      fc.property(people, voters, (superAdmins, cast) => {
        const tally = nominationTally(superAdmins, cast);
        expect(tally.votes).toBeLessThanOrEqual(tally.needed);
        // Votes from anyone else (an owner, a former super admin) change nothing.
        const outsiders = PEOPLE.filter((id) => !superAdmins.includes(id));
        expect(nominationTally(superAdmins, [...cast, ...outsiders])).toEqual(tally);
      }),
    );
  });

  it('one missing vote holds a nomination back', () => {
    fc.assert(
      fc.property(people, fc.nat(), (superAdmins, pick) => {
        if (superAdmins.length < 2) return;
        const missing = superAdmins[pick % superAdmins.length];
        const tally = nominationTally(
          superAdmins,
          superAdmins.filter((id) => id !== missing),
        );
        expect(tally.complete).toBe(false);
        expect(tally.votes).toBe(superAdmins.length - 1);
      }),
    );
  });

  it('the owner scenario: the second is immediate, the third waits for the first two', () => {
    expect(nominationTally(['first'], ['first']).immediate).toBe(true);
    expect(nominationTally(['first', 'second'], ['first'])).toEqual({
      votes: 1,
      needed: 2,
      immediate: false,
      complete: false,
    });
    expect(nominationTally(['first', 'second'], ['first', 'second']).complete).toBe(true);
  });
});

describe('nominationRefusal', () => {
  it('refuses anyone but a super admin, before anything else', () => {
    fc.assert(
      fc.property(person, candidates, (actor, candidate) => {
        expect(nominationRefusal({ userId: actor, isSuperAdmin: false }, candidate)).toBe(
          'not_super_admin',
        );
      }),
    );
  });

  it('nobody nominates themselves', () => {
    fc.assert(
      fc.property(candidates, (candidate) => {
        expect(nominationRefusal({ userId: candidate.userId, isSuperAdmin: true }, candidate)).toBe(
          'self',
        );
      }),
    );
  });

  it('a super admin may nominate exactly the active admins here who hold no supreme authority', () => {
    fc.assert(
      fc.property(person, candidates, (actor, candidate) => {
        if (actor === candidate.userId) return;
        const refusal = nominationRefusal({ userId: actor, isSuperAdmin: true }, candidate);
        expect(refusal === null).toBe(isSuperAdminCandidate(candidate));
        if (candidate.isSuperAdmin || candidate.isOwner)
          expect(refusal).toBe('already_super_admin');
      }),
    );
  });
});

describe('who starts a nomination (D-666)', () => {
  it('the first super admin or an owner, and nobody else', () => {
    const starters = new Set(['first', 'owner']);
    expect(startRefusal('first', starters)).toBeNull();
    expect(startRefusal('owner', starters)).toBeNull();
    expect(startRefusal('second', starters)).toBe('not_first_super_admin');
    expect(startRefusal('first', new Set())).toBe('not_first_super_admin');
  });
});
