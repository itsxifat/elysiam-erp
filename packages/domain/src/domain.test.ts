import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  changedFields,
  maskPhone,
  REDACTED,
  REDACTED_FIELD_PATTERNS,
  redact,
} from './audit/index.js';
import {
  canDecide,
  requiresApproval,
  withinCheckerLimit,
  type Threshold,
} from './approvals/index.js';

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

  it('redacts every pattern it declares, in every spelling a caller might use', () => {
    /*
     * Drawn from `REDACTED_FIELD_PATTERNS` rather than from four names picked
     * by hand, and then respelled.
     *
     * The old version sampled `constantFrom('password','token','secret','apiKey')`
     * — its own happy path — so it could not have failed for any of the
     * patterns that were actually broken. `x-api-key` and `private-key` both
     * went into an append-only table verbatim while it passed, because the
     * matcher compared substrings against the raw key and
     * `'api-key'.includes('apikey')` is false.
     */
    const respellings = (pattern: string): string[] => {
      const bare = pattern.replace(/[-_]/g, '');
      return [
        pattern,
        bare,
        bare.toUpperCase(),
        `${bare}Hash`,
        `new_${pattern}`,
        `x-${pattern}`,
        `user${bare.charAt(0).toUpperCase()}${bare.slice(1)}`,
      ];
    };

    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.constantFrom(...REDACTED_FIELD_PATTERNS),
        fc.integer({ min: 0, max: 6 }),
        (value, pattern, variant) => {
          const key = respellings(pattern)[variant] ?? pattern;
          const out = redact({ outer: { [key]: value } }) as { outer: Record<string, unknown> };
          expect(out.outer[key], `${key} survived redaction`).toBe(REDACTED);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('leaves alone a field that merely contains a short pattern as a substring', () => {
    /*
     * The other half, and the one over-redaction hides in.
     *
     * `'shipping'.includes('pin')` is true, so a plain substring rule redacted
     * `shippingAddress` and `shippingMethod` — and an audit trail that has
     * lost the delivery address is not much of an audit trail. Without this
     * test the fix could be reverted and every assertion above would still
     * pass, because over-redaction never shows up as a failing negative.
     */
    const innocent = {
      shippingAddress: '12 Gulshan Ave',
      shippingMethod: 'pathao',
      mapping: 'a->b',
      spinnerDelay: 300,
      description: 'a token of appreciation',
    };

    const out = redact(innocent) as Record<string, unknown>;
    for (const [key, value] of Object.entries(innocent)) {
      expect(out[key], `${key} was redacted and should not have been`).toEqual(value);
    }
  });

  it('redacts a hyphenated secret name, which substring matching missed', () => {
    const out = redact({
      'x-api-key': 'sk_live_1',
      'private-key': '-----BEGIN',
      Authorization: 'Bearer abc',
    }) as Record<string, unknown>;

    expect(out['x-api-key']).toBe(REDACTED);
    expect(out['private-key']).toBe(REDACTED);
    expect(out.Authorization).toBe(REDACTED);
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

  it('sees a phone change only where masking left digits visible', () => {
    // Masking keeps the first three and last two digits, so a change confined
    // to the middle is invisible to the diff. That is the trade invariant 10
    // asks for, and it is asserted here rather than left to be discovered.
    expect(changedFields({ phone: '01712345689' }, { phone: '01812345689' })).toEqual(['phone']);
    expect(changedFields({ phone: '01712345689' }, { phone: '01799999689' })).toEqual([]);
  });
});

describe('a phone is masked wherever it sits and whatever its type', () => {
  /*
   * Invariant 10 says mask phone numbers in logs, and the audit log is the
   * append-only copy of every other table — anything that lands there unmasked
   * stays. Every shape below reached that table verbatim at some point, and
   * none of them had a test.
   */
  it('masks a string under a phone-named key', () => {
    const out = redact({ customerPhone: '01712345689' }) as Record<string, string>;
    expect(out.customerPhone).toBe('017******89');
  });

  it('masks a number, which a JSON client will happily send', () => {
    const out = redact({ phone: 1712345689 }) as Record<string, string>;
    expect(out.phone).toBe('171*****89');
  });

  it('masks a bigint, which is what a bigint column deserializes to', () => {
    const out = redact({ phone: 1712345689n }) as Record<string, string>;
    expect(out.phone).toBe('171*****89');
  });

  it('masks every entry of a list of numbers', () => {
    const out = redact({ phones: ['01712345611', '01812345622'] }) as { phones: string[] };
    expect(out.phones).toEqual(['017******11', '018******22']);
    expect(out.phones.join()).not.toContain('2345');
  });

  it('masks a number nested under a phone-named object', () => {
    const out = redact({ phone: { number: '01712345689', verified: true } }) as {
      phone: Record<string, unknown>;
    };
    expect(out.phone.number).toBe('017******89');
    // Everything under a phone-named key is masked rather than dropped:
    // guessing which leaf holds the number is how one slips through.
    expect(out.phone.verified).toBeDefined();
  });

  it('matches mobile and msisdn, the other names the same value arrives under', () => {
    const out = redact({ mobileNumber: '01712345689', msisdn: '8801712345689' }) as Record<
      string,
      string
    >;
    expect(out.mobileNumber).not.toContain('2345');
    expect(out.msisdn).not.toContain('2345');
  });

  it('blanks a value too short to mask instead of returning it', () => {
    // A five-digit value under a phone-named key is not a phone, and handing
    // it back unchanged returns whatever it actually was — PIN-shaped.
    expect(maskPhone('12345')).toBe('*****');
    expect(maskPhone('')).toBe('*');
  });

  it('leaves the length legible but never the middle', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^01[3-9][0-9]{8}$/), (number) => {
        const masked = maskPhone(number);
        expect(masked.slice(0, 3)).toBe(number.slice(0, 3));
        expect(masked.slice(-2)).toBe(number.slice(-2));
        expect(masked.slice(3, -2)).toMatch(/^\*+$/);
      }),
      { numRuns: 200 },
    );
  });
});

describe('an amount-limited checker: §6 branch items under threshold', () => {
  /*
   * Without this rule a showroom manager could approve a stock write-off of
   * any size — the cheapest way to make inventory disappear in a company where
   * the branch is also the till. Both edge cases fail closed, which costs a
   * branch manager an approval they could have made and never costs the
   * company an unapproved one.
   */
  it('allows an amount below the threshold', () => {
    expect(withinCheckerLimit({ amountPoisha: 499_999n, thresholdPoisha: 500_000n }).ok).toBe(true);
  });

  it('refuses the threshold itself, so the boundary is on the safe side', () => {
    expect(withinCheckerLimit({ amountPoisha: 500_000n, thresholdPoisha: 500_000n }).ok).toBe(
      false,
    );
  });

  it('refuses an amount above it', () => {
    expect(withinCheckerLimit({ amountPoisha: 900_000n, thresholdPoisha: 500_000n }).ok).toBe(
      false,
    );
  });

  it('compares magnitude, so a negative write-off is not waved through', () => {
    expect(withinCheckerLimit({ amountPoisha: -900_000n, thresholdPoisha: 500_000n }).ok).toBe(
      false,
    );
    expect(withinCheckerLimit({ amountPoisha: -1n, thresholdPoisha: 500_000n }).ok).toBe(true);
  });

  it('refuses when no threshold is configured, rather than assuming one', () => {
    const verdict = withinCheckerLimit({ amountPoisha: 1n, thresholdPoisha: null });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('threshold');
  });

  it('refuses a request with no amount at all', () => {
    // A period reopen or a bonus rule has no number to be under.
    expect(withinCheckerLimit({ amountPoisha: null, thresholdPoisha: 500_000n }).ok).toBe(false);
  });

  it('agrees with requiresApproval about where the line falls', () => {
    // The two read the same number from opposite sides: anything
    // `requiresApproval` says needs a second person is, by construction,
    // outside a limited checker's authority. If they ever disagreed there
    // would be a band of amounts a branch manager could clear alone.
    const thresholds: Threshold[] = [{ type: 'stock_write_off', thresholdPoisha: 500_000n }];
    fc.assert(
      fc.property(fc.bigInt({ min: -2_000_000n, max: 2_000_000n }), (amount) => {
        const needsSecond = requiresApproval({
          type: 'stock_write_off',
          amountPoisha: amount,
          thresholds,
        });
        const branchMayDecide = withinCheckerLimit({
          amountPoisha: amount,
          thresholdPoisha: 500_000n,
        }).ok;
        expect(needsSecond).toBe(!branchMayDecide);
      }),
      { numRuns: 300 },
    );
  });
});
