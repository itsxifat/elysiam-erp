import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  checkPhoneNote,
  mergeNotes,
  mergeNumbersPlan,
  moveToRank,
  needsDetails,
  negateStats,
  orderStatsContribution,
  pickBuyer,
  placedForOf,
  rankCandidates,
  retirePlan,
  type BuyerCandidate,
} from './buyers.js';

/** M48 (D-870 to D-889): a buyer's numbers and the people one number names. */

const day = (n: number) => new Date(Date.UTC(2026, 9, n));

function candidate(overrides: Partial<BuyerCandidate> & { customerId: string }): BuyerCandidate {
  return { rank: 1, relation: 'own', lastOrderAt: null, addedAt: day(1), ...overrides };
}

describe('pickBuyer: the automatic path’s choice (D-876)', () => {
  it('names nobody for no candidate and the one person for one', () => {
    expect(pickBuyer([])).toEqual({ kind: 'none' });
    expect(pickBuyer([candidate({ customerId: 'a', relation: 'household', rank: 3 })])).toEqual({
      kind: 'one',
      customerId: 'a',
    });
  });

  it('takes the person whose primary own number it is, however recently the others ordered', () => {
    const pick = pickBuyer([
      candidate({ customerId: 'mother', rank: 2, relation: 'household', lastOrderAt: day(18) }),
      candidate({ customerId: 'father', rank: 1, relation: 'own', lastOrderAt: day(2) }),
      candidate({ customerId: 'son', rank: 1, relation: 'relative', lastOrderAt: day(19) }),
    ]);
    expect(pick).toEqual({ kind: 'several', customerId: 'father', by: 'primary_own' });
  });

  it('falls back to whoever ordered last when nobody’s primary own number it is', () => {
    const pick = pickBuyer([
      candidate({ customerId: 'a', rank: 2, relation: 'household', lastOrderAt: day(3) }),
      candidate({ customerId: 'b', rank: 3, relation: 'work', lastOrderAt: day(9) }),
      candidate({ customerId: 'c', rank: 2, relation: 'relative', lastOrderAt: null }),
    ]);
    expect(pick).toEqual({ kind: 'several', customerId: 'b', by: 'last_order' });
  });

  it('chooses among two primary own claims by the last order, not among everyone', () => {
    const pick = pickBuyer([
      candidate({ customerId: 'a', lastOrderAt: day(4) }),
      candidate({ customerId: 'b', lastOrderAt: day(6) }),
      candidate({ customerId: 'c', rank: 2, relation: 'household', lastOrderAt: day(20) }),
    ]);
    expect(pick).toEqual({ kind: 'several', customerId: 'b', by: 'last_order' });
  });

  it('breaks a tie by rank, then by who had the number first, then by id', () => {
    expect(
      pickBuyer([
        candidate({ customerId: 'a', rank: 3, relation: 'work' }),
        candidate({ customerId: 'b', rank: 2, relation: 'work' }),
      ]),
    ).toMatchObject({ customerId: 'b' });
    expect(
      pickBuyer([
        candidate({ customerId: 'a', rank: 2, relation: 'work', addedAt: day(5) }),
        candidate({ customerId: 'b', rank: 2, relation: 'work', addedAt: day(4) }),
      ]),
    ).toMatchObject({ customerId: 'b' });
  });

  it('always names one of the candidates, and the same one whatever order they come in', () => {
    const arbitrary = fc.array(
      fc.record({
        customerId: fc.constantFrom('a', 'b', 'c', 'd'),
        rank: fc.integer({ min: 1, max: 4 }),
        relation: fc.constantFrom('own', 'household', 'relative', 'work', 'someone_else', 'other'),
        lastOrderAt: fc.option(fc.integer({ min: 1, max: 28 }).map(day), { nil: null }),
        addedAt: fc.integer({ min: 1, max: 28 }).map(day),
      }),
      { maxLength: 8 },
    );
    fc.assert(
      fc.property(arbitrary, (candidates) => {
        const pick = pickBuyer(candidates);
        const people = new Set<string>(candidates.map((entry) => entry.customerId));
        if (people.size === 0) return pick.kind === 'none';
        if (pick.kind === 'none') return false;
        if (!people.has(pick.customerId)) return false;
        if ((people.size === 1) !== (pick.kind === 'one')) return false;
        const again = pickBuyer([...candidates].reverse());
        return again.kind !== 'none' && again.customerId === pick.customerId;
      }),
    );
  });

  it('lists the pick first for a screen', () => {
    const listed = rankCandidates([
      candidate({ customerId: 'a', rank: 2, relation: 'household', lastOrderAt: day(9) }),
      candidate({ customerId: 'b', rank: 1, relation: 'own', lastOrderAt: day(1) }),
    ]);
    expect(listed.map((entry) => entry.customerId)).toEqual(['b', 'a']);
  });
});

describe('a number’s note (D-871)', () => {
  it('is required when staff add a number, trimmed, and at most 500 characters', () => {
    expect(checkPhoneNote('  ', 'staff')).toEqual({ ok: false, reason: 'note_required' });
    expect(checkPhoneNote(' Her office line, after 10 am ', 'staff')).toEqual({
      ok: true,
      note: 'Her office line, after 10 am',
    });
    expect(checkPhoneNote('x'.repeat(501), 'staff')).toEqual({
      ok: false,
      reason: 'note_too_long',
    });
  });

  it('may be missing on a number an automatic path added, which then needs details', () => {
    expect(checkPhoneNote(undefined, 'order')).toEqual({ ok: true, note: null });
    expect(needsDetails({ note: null })).toBe(true);
    expect(needsDetails({ note: 'Shop phone' })).toBe(false);
  });
});

describe('ranks and retiring (D-872, D-873)', () => {
  it('moves a number to a rank, clamped to the list, and refuses one that is not there', () => {
    expect(moveToRank(['a', 'b', 'c'], 'c', 1)).toEqual(['c', 'a', 'b']);
    expect(moveToRank(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'a', 'c']);
    expect(moveToRank(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a']);
    expect(moveToRank(['a', 'b'], 'z', 1)).toBeNull();
  });

  it('keeps every number once whatever the move', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 6 }),
        fc.nat(),
        fc.integer({ min: -3, max: 10 }),
        (ids, pick, toRank) => {
          const id = ids[pick % ids.length] ?? '';
          const moved = moveToRank(ids, id, toRank);
          return (
            moved !== null &&
            moved.length === ids.length &&
            [...moved].sort().join() === [...ids].sort().join()
          );
        },
      ),
    );
  });

  it('retires any number but the last, the next one up becoming primary', () => {
    expect(retirePlan(['a', 'b', 'c'], 'a')).toEqual({ ok: true, remaining: ['b', 'c'] });
    expect(retirePlan(['a'], 'a')).toEqual({ ok: false, reason: 'last_number' });
    expect(retirePlan(['a', 'b'], 'z')).toEqual({ ok: false, reason: 'not_active' });
  });
});

describe('merging two records of one person (D-884)', () => {
  it('keeps the kept person’s numbers first, appends the other’s and retires a number both had', () => {
    const plan = mergeNumbersPlan(
      [
        { id: 'k1', phoneE164: '+8801711000001', rank: 1 },
        { id: 'k2', phoneE164: '+8801711000002', rank: 2 },
      ],
      [
        { id: 'm2', phoneE164: '+8801811000003', rank: 2 },
        { id: 'm1', phoneE164: '+8801711000002', rank: 1 },
      ],
    );
    expect(plan.ranks).toEqual([
      { id: 'k1', rank: 1 },
      { id: 'k2', rank: 2 },
      { id: 'm2', rank: 3 },
    ]);
    expect(plan.retire).toEqual(['m1']);
  });

  it('keeps both notes, kept first, once each, within the field', () => {
    expect(mergeNotes(null, 'Prefers evening calls')).toBe('Prefers evening calls');
    expect(mergeNotes('Size M', null)).toBe('Size M');
    expect(mergeNotes('Size M', 'Size M')).toBe('Size M');
    expect(mergeNotes('Size M', 'Evening calls')).toBe('Size M\n\nEvening calls');
    expect(mergeNotes('a'.repeat(1990), 'b'.repeat(50))?.length).toBe(2000);
    expect(mergeNotes(null, null)).toBeNull();
  });
});

describe('what an order counted on its buyer (D-883)', () => {
  it('counts as the transitions did', () => {
    expect(
      orderStatsContribution({
        reached: new Set(['pending', 'confirmed', 'packed', 'shipped', 'delivered']),
        deliveredNetPoisha: 150_000n,
      }),
    ).toEqual({ orders: 1, delivered: 1, returned: 0, cancelled: 0, ltvPoisha: 150_000n });
    expect(
      orderStatsContribution({
        reached: new Set(['shipped', 'return_in_transit', 'returned']),
        deliveredNetPoisha: 0n,
      }),
    ).toEqual({ orders: 1, delivered: 0, returned: 1, cancelled: 0, ltvPoisha: 0n });
    // A partly delivered order's return counted no second return (state.ts).
    expect(
      orderStatsContribution({
        reached: new Set(['shipped', 'partially_delivered', 'returned']),
        deliveredNetPoisha: 40_000n,
      }),
    ).toEqual({ orders: 1, delivered: 1, returned: 0, cancelled: 0, ltvPoisha: 40_000n });
    expect(
      orderStatsContribution({
        reached: new Set(['pending', 'cancelled']),
        deliveredNetPoisha: 0n,
      }),
    ).toEqual({ orders: 1, delivered: 0, returned: 0, cancelled: 1, ltvPoisha: 0n });
  });

  it('is taken back exactly by its negation', () => {
    const delta = orderStatsContribution({
      reached: new Set(['delivered']),
      deliveredNetPoisha: 99n,
    });
    const back = negateStats(delta);
    expect(delta.orders + back.orders).toBe(0);
    expect(delta.ltvPoisha + back.ltvPoisha).toBe(0n);
  });
});

describe('placedForOf (D-879)', () => {
  it('is someone else only when two different phones came', () => {
    expect(placedForOf('+8801711000001', null)).toBe('self');
    expect(placedForOf('+8801711000001', '+8801711000001')).toBe('self');
    expect(placedForOf('+8801711000001', '+8801811000002')).toBe('someone_else');
  });
});
