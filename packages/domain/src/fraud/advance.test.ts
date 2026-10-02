import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MoneyError, poisha } from '../money/index.js';
import { ADDRESS_SIMILARITY_THRESHOLD, addressNumbers, normalizeAddress } from './address.js';
import {
  advanceGate,
  allocateApplied,
  normalizeTransactionRef,
  remainingOf,
  requiredAdvancePoisha,
  settlementsFor,
  type HeldAdvance,
} from './advance.js';
import { REPEAT_RETURN_ADDRESS_PENALTY, trustScore } from './score.js';

/**
 * The arithmetic and the rules of an advance's life (M17, D-233 to D-236), and the
 * address normalisation the repeat-return signal stands on (D-231).
 *
 * The database tests prove the books. These prove the numbers the books are built from:
 * how much is required, how a delivery's applied amount is shared out, and what is left
 * to refund or keep.
 */

const advance = (id: string, amount: bigint, applied = 0n, settled = 0n): HeldAdvance => ({
  id,
  amountPoisha: poisha(amount),
  appliedPoisha: poisha(applied),
  settledPoisha: poisha(settled),
});

describe('what require_advance requires (D-233)', () => {
  it('is the delivery charge by default, and the largest ask when several apply', () => {
    expect(requiredAdvancePoisha([{ basis: 'delivery_charge' }], poisha(6_000))).toBe(6_000n);
    expect(
      requiredAdvancePoisha(
        [{ basis: 'delivery_charge' }, { basis: 'fixed', amountPoisha: poisha(50_000) }],
        poisha(6_000),
      ),
    ).toBe(50_000n);
    // Two rules asking for the delivery charge ask for the same money once.
    expect(
      requiredAdvancePoisha(
        [{ basis: 'delivery_charge' }, { basis: 'delivery_charge' }],
        poisha(6_000),
      ),
    ).toBe(6_000n);
    expect(requiredAdvancePoisha([], poisha(6_000))).toBe(0n);
  });

  it('holds a confirm until verified money covers it, and lets an override through', () => {
    const base = { decision: 'require_advance' as const, requiredPoisha: poisha(6_000) };
    expect(advanceGate({ ...base, verifiedPoisha: poisha(0), overrideReason: null })).toEqual({
      outcome: 'missing',
      shortPoisha: 6_000n,
    });
    expect(advanceGate({ ...base, verifiedPoisha: poisha(5_999), overrideReason: '  ' })).toEqual({
      outcome: 'missing',
      shortPoisha: 1n,
    });
    expect(advanceGate({ ...base, verifiedPoisha: poisha(6_000), overrideReason: null })).toEqual({
      outcome: 'satisfied',
    });
    expect(
      advanceGate({ ...base, verifiedPoisha: poisha(0), overrideReason: 'regular buyer, known' }),
    ).toEqual({ outcome: 'overridden' });
    for (const decision of ['allow', 'warn', 'block'] as const) {
      expect(
        advanceGate({ ...base, decision, verifiedPoisha: poisha(0), overrideReason: null }),
      ).toEqual({ outcome: 'not_required' });
    }
  });

  it('treats a free-delivery order as owing nothing up front', () => {
    expect(
      advanceGate({
        decision: 'require_advance',
        requiredPoisha: requiredAdvancePoisha([{ basis: 'delivery_charge' }], poisha(0)),
        verifiedPoisha: poisha(0),
        overrideReason: null,
      }),
    ).toEqual({ outcome: 'satisfied' });
  });
});

describe('sharing a delivery’s applied amount across advances (D-234)', () => {
  it('applies oldest first, and only what each still holds', () => {
    const shares = allocateApplied(
      [advance('a', 6_000n), advance('b', 10_000n, 4_000n), advance('c', 5_000n)],
      poisha(14_000),
    );
    expect(shares).toEqual([
      { id: 'a', appliedPoisha: 6_000n },
      { id: 'b', appliedPoisha: 6_000n },
      { id: 'c', appliedPoisha: 2_000n },
    ]);
  });

  it('refuses to apply more than the advances hold', () => {
    expect(() => allocateApplied([advance('a', 6_000n)], poisha(6_001))).toThrow(MoneyError);
  });

  it('refuses a row that has used more than was paid', () => {
    expect(() => remainingOf(advance('a', 6_000n, 4_000n, 3_000n))).toThrow(MoneyError);
  });

  it('property: shares sum to the applied amount and never exceed what each held', () => {
    const held = fc.array(
      fc
        .tuple(fc.bigInt({ min: 1n, max: 1_000_000n }), fc.bigInt({ min: 0n, max: 1_000_000n }))
        .map(([amount, used]) => ({ amount, applied: used > amount ? amount : used })),
      { minLength: 1, maxLength: 6 },
    );
    fc.assert(
      fc.property(held, fc.integer({ min: 0, max: 100 }), (rows, percent) => {
        const advances = rows.map((row, index) => advance(`a${index}`, row.amount, row.applied));
        const available = advances.reduce((acc, row) => acc + remainingOf(row), 0n);
        const applied = poisha((available * BigInt(percent)) / 100n);
        const shares = allocateApplied(advances, applied);
        expect(shares.reduce((acc, share) => acc + share.appliedPoisha, 0n)).toBe(applied);
        for (const share of shares) {
          const row = advances.find((candidate) => candidate.id === share.id);
          expect(row).toBeDefined();
          expect(share.appliedPoisha).toBeGreaterThan(0n);
          expect(share.appliedPoisha <= remainingOf(row!)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('settling what is left on a cancel or a return (D-235, D-236)', () => {
  it('owes each advance its remainder, and nothing for one fully applied', () => {
    expect(
      settlementsFor(
        [advance('a', 6_000n, 6_000n), advance('b', 10_000n, 4_000n), advance('c', 5_000n)],
        'refund',
      ),
    ).toEqual([
      { id: 'b', disposition: 'refund', amountPoisha: 6_000n },
      { id: 'c', disposition: 'refund', amountPoisha: 5_000n },
    ]);
  });

  it('property: applied + settled always equals what was paid, once both have happened', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 1_000_000n }), { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 0, max: 100 }),
        fc.constantFrom('refund', 'forfeit'),
        (amounts, percent, disposition) => {
          const advances = amounts.map((amount, index) => advance(`a${index}`, amount));
          const paid = amounts.reduce((acc, amount) => acc + amount, 0n);
          const applied = poisha((paid * BigInt(percent)) / 100n);
          const shares = allocateApplied(advances, applied);
          const after = advances.map((row) => {
            const share = shares.find((entry) => entry.id === row.id)?.appliedPoisha ?? 0n;
            return advance(row.id, row.amountPoisha, share);
          });
          const settled = settlementsFor(after, disposition).reduce(
            (acc, entry) => acc + entry.amountPoisha,
            0n,
          );
          expect(applied + settled).toBe(paid);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('a transaction reference, as stored', () => {
  it('upper-cases, drops spaces and dashes, and reads Bangla digits', () => {
    expect(normalizeTransactionRef('8n7a 6d5c-4b')).toBe('8N7A6D5C4B');
    expect(normalizeTransactionRef('৮N৭A৬D৫C৪B')).toBe('8N7A6D5C4B');
  });

  it('refuses something that is not a reference', () => {
    expect(normalizeTransactionRef('12345')).toBeNull();
    expect(normalizeTransactionRef('+8801712345678')).toBeNull();
    expect(normalizeTransactionRef('paid by bkash')).toBeNull();
  });
});

describe('address normalisation for the repeat-return signal (D-231)', () => {
  it('spells one door the same way however it was typed', () => {
    const forms = [
      'House# 12, Road-5, Block C, Mirpur-10',
      'h 12 rd 5 blk c mirpur10',
      'HOUSE NO. 12, ROAD NO 5, BLOCK-C, MIRPUR 10',
      'বাসা ১২, রোড ৫, block c, mirpur 10',
    ];
    const normalised = forms.map((form) => normalizeAddress(form));
    expect(new Set(normalised).size).toBe(1);
    expect(normalised[0]).toBe('house 12 road 5 block c mirpur 10');
  });

  it('joins the area onto the line', () => {
    expect(normalizeAddress('House 12, Road 5', 'Dhanmondi')).toBe('house 12 road 5 dhanmondi');
  });

  it('extracts the numbers that tell neighbours apart', () => {
    expect(addressNumbers('house 12 road 5 block c mirpur 10')).toBe('10 12 5');
    expect(addressNumbers('house 14 road 5 block c mirpur 10')).not.toBe(
      addressNumbers('house 12 road 5 block c mirpur 10'),
    );
    expect(addressNumbers('house 012 road 05')).toBe(addressNumbers('house 12 road 5'));
    expect(addressNumbers('village kashipur post bhanga')).toBe('');
  });

  it('keeps the threshold strict enough that a search-grade match is not enough', () => {
    expect(ADDRESS_SIMILARITY_THRESHOLD).toBeGreaterThan(0.3);
  });
});

describe('the score with an address signal (D-231)', () => {
  const NOW = new Date('2026-03-15T06:00:00.000Z');
  const internal = {
    ordersTotal: 0,
    delivered: 0,
    returned: 0,
    cancelled: 0,
    lastIncidentAt: null,
    manualFlagCount: 0,
  };

  it('costs a newcomer at a refusing door 20 points: warned, not blocked', () => {
    const scored = trustScore({
      internal,
      providers: [],
      providerAvailable: true,
      now: NOW,
      address: { returns: 2, minReturns: 2 },
    });
    expect(scored.score).toBe(70 - REPEAT_RETURN_ADDRESS_PENALTY);
    expect(scored.decision).toBe('warn');
    expect(scored.reasons.map((reason) => reason.code)).toContain('repeat_return_address');
  });

  it('costs nothing below the brand’s threshold, or with no address', () => {
    const below = trustScore({
      internal,
      providers: [],
      providerAvailable: true,
      now: NOW,
      address: { returns: 1, minReturns: 2 },
    });
    const without = trustScore({ internal, providers: [], providerAvailable: true, now: NOW });
    expect(below.score).toBe(70);
    expect(without.score).toBe(70);
    expect(below.reasons.map((reason) => reason.code)).not.toContain('repeat_return_address');
  });

  it('refuses a nonsense threshold', () => {
    expect(() =>
      trustScore({
        internal,
        providers: [],
        providerAvailable: true,
        now: NOW,
        address: { returns: 1, minReturns: 0 },
      }),
    ).toThrow(TypeError);
  });

  it('property: the score stays in 0–100 with any address signal', () => {
    fc.assert(
      fc.property(fc.nat(50), fc.integer({ min: 1, max: 20 }), (returns, minReturns) => {
        const scored = trustScore({
          internal,
          providers: [],
          providerAvailable: true,
          now: NOW,
          address: { returns, minReturns },
        });
        expect(scored.score).toBeGreaterThanOrEqual(0);
        expect(scored.score).toBeLessThanOrEqual(100);
      }),
    );
  });
});
