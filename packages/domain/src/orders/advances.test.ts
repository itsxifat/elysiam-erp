import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MoneyError, poisha, type Poisha } from '../money/index.js';
import {
  acceptsAdvanceClaim,
  advanceVerification,
  allocateApplied,
  DEFAULT_ADVANCE_POLICY,
  normalizeTransactionRef,
  parseAdvanceDisposition,
  remainingOf,
  settlementsFor,
  totalOf,
  voidVerification,
  type HeldAdvance,
} from './advances.js';
import { ORDER_STATUSES, type OrderStatus } from './state.js';

/** Advances (M17, D-230 to D-233): the arithmetic and the rules, without a database. */

describe('a transaction reference, as stored', () => {
  it.each([
    ['8N7A6B5C4D', '8N7A6B5C4D'],
    [' 8n7a 6b5c-4d ', '8N7A6B5C4D'],
    ['৮N৭A৬B৫C৪D', '8N7A6B5C4D'],
    ['TXN-2026-000123', 'TXN2026000123'],
  ])('normalises %j to %s', (input, expected) => {
    expect(normalizeTransactionRef(input)).toBe(expected);
  });

  it.each(['', 'abc12', 'paid by bkash', 'ABCDEFGHIJ', '+8801711000000', 'x'.repeat(31) + '1'])(
    'refuses %j',
    (input) => {
      expect(normalizeTransactionRef(input)).toBeNull();
    },
  );
});

describe('where a verified advance goes (D-231)', () => {
  /*
   * Every one of §9's eleven statuses, with and without a live parcel. Written out rather than
   * derived, because the table is the decision and a derived table would agree with any bug.
   */
  const EXPECTED: Readonly<Record<OrderStatus, readonly [string, string]>> = {
    pending: ['apply', 'wait'],
    confirmed: ['apply', 'wait'],
    on_hold: ['apply', 'wait'],
    packed: ['apply', 'wait'],
    shipped: ['wait', 'wait'],
    return_in_transit: ['wait', 'wait'],
    partially_delivered: ['wait', 'wait'],
    cancelled: ['settle:refund', 'settle:refund'],
    returned: ['settle:forfeit', 'settle:forfeit'],
    delivered: ['settle:refund', 'settle:refund'],
    exchange: ['settle:refund', 'settle:refund'],
  };

  const label = (outcome: ReturnType<typeof advanceVerification>): string =>
    outcome.kind === 'settle' ? `settle:${outcome.disposition}` : outcome.kind;

  it('matches the table for every status, with and without a parcel booked', () => {
    for (const status of ORDER_STATUSES) {
      const [free, booked] = EXPECTED[status];
      expect(
        label(advanceVerification({ status, parcelLive: false, policy: DEFAULT_ADVANCE_POLICY })),
        status,
      ).toBe(free);
      expect(
        label(advanceVerification({ status, parcelLive: true, policy: DEFAULT_ADVANCE_POLICY })),
        `${status} booked`,
      ).toBe(booked);
    }
  });

  it('follows the brand’s policy for a cancel and a return, and never for a delivery', () => {
    const keepAll = { onCancel: 'forfeit', onReturn: 'forfeit' } as const;
    const refundAll = { onCancel: 'refund', onReturn: 'refund' } as const;
    expect(
      advanceVerification({ status: 'cancelled', parcelLive: false, policy: keepAll }),
    ).toEqual({
      kind: 'settle',
      disposition: 'forfeit',
    });
    expect(
      advanceVerification({ status: 'returned', parcelLive: false, policy: refundAll }),
    ).toEqual({ kind: 'settle', disposition: 'refund' });
    // Paid in full at the door: the advance is owed back whatever the policy.
    expect(
      advanceVerification({ status: 'delivered', parcelLive: false, policy: keepAll }),
    ).toEqual({ kind: 'settle', disposition: 'refund' });
  });

  it('takes a claim only before the parcel moves', () => {
    const open = ORDER_STATUSES.filter(acceptsAdvanceClaim);
    expect(open).toEqual(['pending', 'confirmed', 'on_hold', 'packed']);
  });

  it('reads a stored policy, and falls back on anything it does not recognise', () => {
    expect(parseAdvanceDisposition('forfeit', 'refund')).toBe('forfeit');
    expect(parseAdvanceDisposition('refund', 'forfeit')).toBe('refund');
    expect(parseAdvanceDisposition('keep', 'refund')).toBe('refund');
    expect(parseAdvanceDisposition(null, 'forfeit')).toBe('forfeit');
    expect(DEFAULT_ADVANCE_POLICY).toEqual({ onCancel: 'refund', onReturn: 'forfeit' });
  });
});

const held = (id: string, amount: bigint, applied = 0n): HeldAdvance => ({
  id,
  amountPoisha: poisha(amount),
  appliedPoisha: poisha(applied),
});

describe('applied on delivery (D-233)', () => {
  it('spreads the applied amount oldest first', () => {
    const shares = allocateApplied([held('a', 6_000n), held('b', 10_000n)], poisha(12_000n));
    expect(shares).toEqual([
      { id: 'a', appliedPoisha: 6_000n },
      { id: 'b', appliedPoisha: 6_000n },
    ]);
  });

  it('takes an exchange credit first, so the cash advance is what is left over', () => {
    // 20,000 of credit and a 6,000 advance on the order; the delivery applied 22,000.
    const shares = allocateApplied([held('a', 6_000n)], poisha(22_000n), poisha(20_000n));
    expect(shares).toEqual([{ id: 'a', appliedPoisha: 2_000n }]);
    expect(allocateApplied([held('a', 6_000n)], poisha(15_000n), poisha(20_000n))).toEqual([]);
  });

  it('refuses to apply more than the advances hold', () => {
    expect(() => allocateApplied([held('a', 6_000n)], poisha(6_001n))).toThrow(MoneyError);
  });

  it('never gives an advance more than it holds, and the shares sum to what was applied', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 1_000_000n }), { minLength: 1, maxLength: 6 }),
        fc.bigInt({ min: 0n, max: 2_000_000n }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (amounts, credit, fraction) => {
          const advances = amounts.map((amount, index) => held(String(index), amount));
          const capacity = totalOf(advances) + credit;
          // Some share of what the order holds, as a whole number of poisha.
          const applied = (capacity * BigInt(Math.floor(fraction * 1000))) / 1000n;
          const shares = allocateApplied(advances, poisha(applied), poisha(credit));
          const given = shares.reduce((total, share) => total + share.appliedPoisha, 0n);
          expect(given).toBe(applied > credit ? applied - credit : 0n);
          for (const share of shares) {
            const advance = advances.find((entry) => entry.id === share.id);
            expect(share.appliedPoisha).toBeGreaterThan(0n);
            expect(share.appliedPoisha).toBeLessThanOrEqual(advance?.amountPoisha ?? 0n);
          }
        },
      ),
    );
  });
});

describe('the endings (D-232)', () => {
  it('refunds each advance’s remainder, and nothing for one fully applied', () => {
    const owed = settlementsFor(
      [held('a', 6_000n, 6_000n), held('b', 10_000n, 4_000n), held('c', 3_000n)],
      'refund',
      poisha(6_000n),
    );
    expect(owed).toEqual([
      { id: 'b', keptPoisha: 0n, refundPoisha: 6_000n },
      { id: 'c', keptPoisha: 0n, refundPoisha: 3_000n },
    ]);
  });

  it('keeps at most the cap, oldest first, and gives the rest back', () => {
    // A ৳60 delivery charge, paid as two advances of ৳40, then the parcel was refused.
    expect(
      settlementsFor([held('a', 4_000n), held('b', 4_000n)], 'forfeit', poisha(6_000n)),
    ).toEqual([
      { id: 'a', keptPoisha: 4_000n, refundPoisha: 0n },
      { id: 'b', keptPoisha: 2_000n, refundPoisha: 2_000n },
    ]);
    // A whole order paid ahead and refused: the brand keeps the trip, not the goods.
    expect(settlementsFor([held('x', 106_000n)], 'forfeit', poisha(6_000n))).toEqual([
      { id: 'x', keptPoisha: 6_000n, refundPoisha: 100_000n },
    ]);
    // Part of the parcel delivered: the charge is earned already, so the cap is zero.
    expect(settlementsFor([held('y', 106_000n, 56_000n)], 'forfeit', poisha(0n))).toEqual([
      { id: 'y', keptPoisha: 0n, refundPoisha: 50_000n },
    ]);
  });

  it('applied, kept and refunded always add up to exactly what was paid, and keep ≤ the cap', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .tuple(
              fc.bigInt({ min: 1n, max: 1_000_000n }),
              fc.double({ min: 0, max: 1, noNaN: true }),
            )
            .map(([amount, fraction]) => [
              amount,
              (amount * BigInt(Math.floor(fraction * 100))) / 100n,
            ]),
          { maxLength: 6 },
        ),
        fc.constantFrom('refund' as const, 'forfeit' as const),
        fc.bigInt({ min: 0n, max: 2_000_000n }),
        (rows, disposition, cap) => {
          const advances = rows.map(([amount, applied], index) =>
            held(String(index), amount ?? 1n, applied ?? 0n),
          );
          const owed = settlementsFor(advances, disposition, poisha(cap));
          const kept = owed.reduce<bigint>((total, entry) => total + entry.keptPoisha, 0n);
          const refunded = owed.reduce<bigint>((total, entry) => total + entry.refundPoisha, 0n);
          const applied = advances.reduce<bigint>(
            (total, entry) => total + entry.appliedPoisha,
            0n,
          );
          expect(applied + kept + refunded).toBe(totalOf(advances));
          expect(kept).toBeLessThanOrEqual(disposition === 'forfeit' ? cap : 0n);
          for (const entry of owed) {
            expect(entry.keptPoisha).toBeGreaterThanOrEqual(0n);
            expect(entry.refundPoisha).toBeGreaterThanOrEqual(0n);
          }
        },
      ),
    );
  });

  it('refuses a row that used more than it was paid, and counts what was kept', () => {
    expect(() => remainingOf(held('x', 100n, 101n))).toThrow(MoneyError);
    expect(remainingOf(held('x', 100n, 40n))).toBe(60n as Poisha);
    expect(remainingOf({ ...held('x', 100n, 40n), keptPoisha: poisha(10n) })).toBe(50n as Poisha);
    expect(() => settlementsFor([], 'forfeit', poisha(-1n))).toThrow(MoneyError);
  });
});

describe('undoing a verification (D-236)', () => {
  it('is allowed only on an unused verified advance, before the parcel moves', () => {
    const base = {
      advanceStatus: 'verified',
      appliedPoisha: poisha(0n),
      orderStatus: 'confirmed',
      parcelLive: false,
    } as const;
    expect(voidVerification(base)).toBe('ok');
    expect(voidVerification({ ...base, parcelLive: true })).toBe('parcel_in_flight');
    expect(voidVerification({ ...base, orderStatus: 'shipped' })).toBe('parcel_in_flight');
    expect(voidVerification({ ...base, orderStatus: 'delivered' })).toBe('parcel_in_flight');
    expect(voidVerification({ ...base, appliedPoisha: poisha(1n) })).toBe('not_verified');
    for (const advanceStatus of [
      'pending',
      'rejected',
      'applied',
      'refund_due',
      'voided',
    ] as const) {
      expect(voidVerification({ ...base, advanceStatus })).toBe('not_verified');
    }
  });
});
