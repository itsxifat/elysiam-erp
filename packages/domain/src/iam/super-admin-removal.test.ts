import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  isRemovableSuperAdmin,
  removalRefusal,
  removalTally,
  startRefusal,
  stepDownRefusal,
  type RemovalTarget,
} from './index.js';

/**
 * Removing a super admin (D-685 to D-689), as properties. The database holds the same rule
 * in `iam.demote_super_admin`; the server tests that one against real Postgres.
 */

const PEOPLE = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
const person = fc.constantFrom(...PEOPLE);
const people = fc.uniqueArray(person, { maxLength: PEOPLE.length });
const voters = fc.array(person, { maxLength: 10 });

const targets = fc.record({
  userId: person,
  isActive: fc.boolean(),
  isSuperAdmin: fc.boolean(),
  isOwner: fc.boolean(),
}) satisfies fc.Arbitrary<RemovalTarget>;

/** The facts as the database gives them: the first is the earliest super admin. */
const facts = people.map((superAdmins) => ({ superAdmins, first: superAdmins[0] ?? null }));

describe('removalTally', () => {
  it('is at once while at most one other super admin remains', () => {
    fc.assert(
      fc.property(people, person, voters, (superAdmins, target, cast) => {
        const others = superAdmins.filter((id) => id !== target);
        if (others.length > 1) return;
        expect(removalTally(superAdmins, target, cast)).toEqual({
          votes: 0,
          needed: 0,
          immediate: true,
          complete: true,
        });
      }),
    );
  });

  it('otherwise completes exactly when every other super admin has voted yes', () => {
    fc.assert(
      fc.property(people, person, voters, (superAdmins, target, cast) => {
        const others = superAdmins.filter((id) => id !== target);
        if (others.length < 2) return;
        const tally = removalTally(superAdmins, target, cast);
        expect(tally.immediate).toBe(false);
        expect(tally.needed).toBe(others.length);
        expect(tally.complete).toBe(others.every((id) => cast.includes(id)));
        expect(tally.votes).toBe(others.filter((id) => cast.includes(id)).length);
      }),
    );
  });

  it('never counts the target, an owner or a former super admin', () => {
    fc.assert(
      fc.property(people, person, voters, (superAdmins, target, cast) => {
        const tally = removalTally(superAdmins, target, cast);
        const outsiders = PEOPLE.filter((id) => id === target || !superAdmins.includes(id));
        expect(removalTally(superAdmins, target, [...cast, ...outsiders])).toEqual(tally);
        expect(tally.votes).toBeLessThanOrEqual(tally.needed);
      }),
    );
  });

  it('one missing vote holds a removal back', () => {
    fc.assert(
      fc.property(people, person, fc.nat(), (superAdmins, target, pick) => {
        const others = superAdmins.filter((id) => id !== target);
        if (others.length < 2) return;
        const missing = others[pick % others.length];
        const tally = removalTally(
          superAdmins,
          target,
          others.filter((id) => id !== missing),
        );
        expect(tally.complete).toBe(false);
        expect(tally.votes).toBe(others.length - 1);
      }),
    );
  });
});

describe('removalRefusal', () => {
  it('admits only a super admin removing another active, non-owner, non-first super admin', () => {
    fc.assert(
      fc.property(person, fc.boolean(), targets, facts, (actorId, isSuperAdmin, target, now) => {
        const refusal = removalRefusal({ userId: actorId, isSuperAdmin }, target, now);
        const allowed =
          isSuperAdmin &&
          actorId !== target.userId &&
          isRemovableSuperAdmin(target) &&
          target.userId !== now.first &&
          now.superAdmins.some((id) => id !== target.userId);
        expect(refusal === null).toBe(allowed);
        if (!isSuperAdmin) expect(refusal).toBe('not_super_admin');
        else if (actorId === target.userId) expect(refusal).toBe('self');
      }),
    );
  });

  it('never lets the others remove the first super admin', () => {
    fc.assert(
      fc.property(person, facts, (actorId, now) => {
        if (now.first === null || actorId === now.first) return;
        const first = { userId: now.first, isActive: true, isSuperAdmin: true, isOwner: false };
        expect(removalRefusal({ userId: actorId, isSuperAdmin: true }, first, now)).toBe(
          'first_super_admin',
        );
      }),
    );
  });

  it('never removes an owner', () => {
    fc.assert(
      fc.property(person, targets, facts, (actorId, target, now) => {
        const owner = { ...target, isOwner: true };
        expect(removalRefusal({ userId: actorId, isSuperAdmin: true }, owner, now)).not.toBeNull();
      }),
    );
  });
});

describe('who starts a removal (D-666)', () => {
  it('only the first super admin or an owner starts one', () => {
    fc.assert(
      fc.property(person, people, (actorId, starters) => {
        const refusal = startRefusal(actorId, new Set(starters));
        expect(refusal === null).toBe(starters.includes(actorId));
      }),
    );
  });
});

describe('stepDownRefusal', () => {
  it('lets any super admin but an owner step down, unless they are the last', () => {
    fc.assert(
      fc.property(
        person,
        fc.boolean(),
        fc.boolean(),
        facts,
        (actorId, isSuperAdmin, isOwner, now) => {
          const refusal = stepDownRefusal({ userId: actorId, isSuperAdmin, isOwner }, now);
          const others = now.superAdmins.filter((id) => id !== actorId);
          if (!isSuperAdmin) expect(refusal).toBe('not_super_admin');
          else if (isOwner) expect(refusal).toBe('not_removable');
          else if (others.length === 0) expect(refusal).toBe('last_super_admin');
          else expect(refusal).toBeNull();
        },
      ),
    );
  });

  it('the first may step down while another remains, who becomes the first', () => {
    fc.assert(
      fc.property(people, (superAdmins) => {
        const [first, next] = superAdmins;
        if (first === undefined || next === undefined) return;
        expect(
          stepDownRefusal({ userId: first, isSuperAdmin: true, isOwner: false }, { superAdmins }),
        ).toBeNull();
        // Read live: with the first gone, the earliest left is the first.
        const after = superAdmins.filter((id) => id !== first);
        expect(after[0]).toBe(next);
      }),
    );
  });
});
