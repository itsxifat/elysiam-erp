import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { changedFields, maskPhone, REDACTED, redact } from './audit/index.js';
import { canDecide, requiresApproval, type Threshold } from './approvals/index.js';

/**
 * The pure rules behind maker-checker and the audit log (invariant 11).
 *
 * Property-tested rather than example-tested where the rule is arithmetic,
 * because the interesting cases here are boundaries and signs — exactly the
 * places a hand-picked example misses.
 */

const THRESHOLDS: readonly Threshold[] = [
  { type: 'wallet_adjustment', thresholdPoisha: 500_000n },
  { type: 'supplier_payment', thresholdPoisha: 10_000_000n },
];

describe('check 5: requests below and above a threshold behave differently', () => {
  it('needs approval at or above the threshold', () => {
    expect(
      requiresApproval({
        type: 'wallet_adjustment',
        amountPoisha: 500_000n,
        thresholds: THRESHOLDS,
      }),
    ).toBe(true);

    expect(
      requiresApproval({
        type: 'wallet_adjustment',
        amountPoisha: 500_001n,
        thresholds: THRESHOLDS,
      }),
    ).toBe(true);
  });

  it('does not below it', () => {
    expect(
      requiresApproval({
        type: 'wallet_adjustment',
        amountPoisha: 499_999n,
        thresholds: THRESHOLDS,
      }),
    ).toBe(false);
  });

  it('puts the boundary on the safe side', () => {
    // "Above" alone would let an org set a threshold at exactly the amount
    // someone routinely moves, and never be asked once.
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 12n }), (limit) => {
        const thresholds = [{ type: 't', thresholdPoisha: limit }];
        expect(requiresApproval({ type: 't', amountPoisha: limit, thresholds })).toBe(true);
        expect(requiresApproval({ type: 't', amountPoisha: limit - 1n, thresholds })).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('treats a negative amount as just as material as a positive one', () => {
    // A refund or a reversal of 50,000 poisha moves exactly as much money as a
    // payment of 50,000. Comparing signed values would wave every negative
    // straight through, which is the direction an attacker would choose.
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 12n }), (amount) => {
        const thresholds = [{ type: 't', thresholdPoisha: amount }];
        expect(requiresApproval({ type: 't', amountPoisha: -amount, thresholds })).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('fails closed when no threshold is configured', () => {
    // The alternative — no threshold means no approval — is indistinguishable
    // from the control working, right up until an audit finds a year of
    // unapproved adjustments.
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), (amount) => {
        expect(
          requiresApproval({
            type: 'never_configured',
            amountPoisha: amount,
            thresholds: THRESHOLDS,
          }),
        ).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('always needs approval when there is no amount to compare', () => {
    expect(
      requiresApproval({ type: 'wallet_adjustment', amountPoisha: null, thresholds: THRESHOLDS }),
    ).toBe(true);
  });

  it('reads the threshold for its own type and not another', () => {
    // One shared threshold across types would make a 6,000,000 supplier
    // payment need approval because wallet adjustments are capped lower.
    expect(
      requiresApproval({
        type: 'supplier_payment',
        amountPoisha: 600_000n,
        thresholds: THRESHOLDS,
      }),
    ).toBe(false);
    expect(
      requiresApproval({
        type: 'wallet_adjustment',
        amountPoisha: 600_000n,
        thresholds: THRESHOLDS,
      }),
    ).toBe(true);
  });
});

describe('check 4: the requester cannot be the approver', () => {
  it('refuses self-approval', () => {
    expect(canDecide({ requestedBy: 'u1', decidedBy: 'u1', status: 'pending' })).toMatchObject({
      ok: false,
    });
  });

  it('allows anyone else', () => {
    expect(canDecide({ requestedBy: 'u1', decidedBy: 'u2', status: 'pending' }).ok).toBe(true);
  });

  it('refuses a second decision on a decided request', () => {
    expect(canDecide({ requestedBy: 'u1', decidedBy: 'u2', status: 'approved' }).ok).toBe(false);
  });
});

describe('check 3: redaction', () => {
  it('removes a credential wherever it sits', () => {
    const row = {
      email: 'a@b.test',
      passwordHash: 'argon2id$...',
      nested: { apiKey: 'sk_live_x', deeper: [{ totpSecret: 'JBSWY3DPEHPK3PXP' }] },
    };

    const out = redact(row) as Record<string, unknown>;
    const json = JSON.stringify(out);

    expect(json).not.toContain('argon2id');
    expect(json).not.toContain('sk_live_x');
    expect(json).not.toContain('JBSWY3DPEHPK3PXP');
    // The positive control: it redacted rather than emptied.
    expect(out).toMatchObject({ email: 'a@b.test' });
  });

  it('masks a phone rather than dropping it', () => {
    // A COD audit trail that cannot say which customer an action was about is
    // not much of an audit trail — but the middle digits are the personal part.
    expect(maskPhone('+8801712345689')).toMatch(/^\d{3}\*+\d{2}$/);
    expect(maskPhone('01712345689')).toContain('017');
    expect(maskPhone('01712345689')).toMatch(/89$/);
  });

  it('keeps two numbers on the same prefix distinguishable', () => {
    expect(maskPhone('01712345611')).not.toBe(maskPhone('01712345622'));
  });

  it('does not mutate the row it was given', () => {
    const row = { passwordHash: 'secret-value' };
    redact(row);
    expect(row.passwordHash).toBe('secret-value');
  });

  it('catches a sensitive field under any spelling', () => {
    const spellings = [
      'password',
      'passwordHash',
      'password_hash',
      'newPassword',
      'PASSWORD',
      'userSecret',
      'refresh_token',
      'apiKey',
      'backupCodes',
      'nationalId',
      'bkashNumber',
    ];

    for (const key of spellings) {
      const out = redact({ [key]: 'sensitive' }) as Record<string, unknown>;
      expect(out[key], `${key} was not redacted`).toBe(REDACTED);
    }
  });

  it('never lets a value named like a secret through, for any payload', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.constantFrom('password', 'token', 'secret', 'apiKey'),
        (value, key) => {
          const out = redact({ outer: { [key]: value } }) as { outer: Record<string, unknown> };
          expect(out.outer[key]).toBe(REDACTED);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('diffs redacted values, not raw ones', () => {
    // Diffing raw rows and redacting afterwards leaks through the comparison:
    // "passwordHash changed" is only knowable if you compared the real values.
    const changed = changedFields(
      { name: 'A', passwordHash: 'old' },
      { name: 'B', passwordHash: 'new' },
    );

    expect(changed).toEqual(['name']);
  });

  it('reports a field that appeared or disappeared', () => {
    expect(changedFields({ a: 1 }, { a: 1, b: 2 })).toEqual(['b']);
    expect(changedFields({ a: 1, b: 2 }, { a: 1 })).toEqual(['b']);
    expect(changedFields(null, { a: 1 })).toEqual(['a']);
    expect(changedFields({ a: 1 }, null)).toEqual(['a']);
  });
});
