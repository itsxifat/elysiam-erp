import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { changedFields, maskEmail, maskPhone, REDACTED, redact } from './audit/index.js';
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

  it('ignores every threshold when the caller says it is always required', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), (amount) => {
        expect(
          requiresApproval({
            type: 'wallet_adjustment',
            amountPoisha: amount,
            thresholds: [{ type: 'wallet_adjustment', thresholdPoisha: 10n ** 13n }],
            alwaysRequired: true,
          }),
        ).toBe(true);
      }),
      { numRuns: 100 },
    );
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

  it('masks an email down to its first letter and its domain (D-419)', () => {
    expect(maskEmail('rina.akter@elysium.test')).toBe('r***@elysium.test');
    // A one-letter local part keeps nothing of it: the letter would be the whole address.
    expect(maskEmail('r@elysium.test')).toBe('***@elysium.test');
    // Not an address at all: masked whole, never echoed.
    expect(maskEmail('not-an-address')).not.toContain('address');
    expect(maskEmail('@elysium.test')).not.toContain('elysium');
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

  describe('masks a phone that arrives as a value, not only under a phone key', () => {
    /** A Bangladeshi mobile in any of the three shapes the regex accepts. */
    const bdPhone = fc
      .tuple(
        fc.constantFrom('0', '880', '+880'),
        fc.integer({ min: 3, max: 9 }),
        fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 8, maxLength: 8 }),
      )
      .map(([prefix, operator, rest]) => `${prefix}1${String(operator)}${rest.join('')}`);

    /** Text that cannot glue extra digits onto the phone. */
    const words = fc.string({ maxLength: 20 }).map((text) => text.replace(/[0-9+]/g, 'x'));

    it('in free text, at any depth, under any key', () => {
      fc.assert(
        fc.property(
          bdPhone,
          words,
          words,
          fc.string({ minLength: 1 }),
          (phone, before, after, key) => {
            const text = `${before} ${phone} ${after}`;
            const out = redact({ note: text, nested: [{ [`k${key}`]: text }] });
            const json = JSON.stringify(out);

            // The personal part — the middle digits — must not survive anywhere.
            expect(json).not.toContain(phone.slice(-11));
            // The positive control: masked, not deleted. The prefix and the last
            // two digits are what keep an audit row about a COD customer useful.
            expect((out as { note: string }).note).toContain(phone.slice(-2));
            expect((out as { note: string }).note).toContain(before);
          },
        ),
        { numRuns: 300 },
      );
    });

    it('is idempotent, so a row redacted twice reads the same', () => {
      fc.assert(
        fc.property(bdPhone, words, (phone, text) => {
          const once = redact({ note: `${text}${phone}` });
          expect(redact(once)).toEqual(once);
        }),
        { numRuns: 200 },
      );
    });

    it('leaves a longer run of digits alone', () => {
      // An order number or a uuid segment is not a phone, and masking it would
      // make the row unanswerable to "which order was this".
      const out = redact({ orderNo: 'ORD-201712345689', id: '018712345678901' }) as Record<
        string,
        string
      >;
      expect(out.orderNo).toBe('ORD-201712345689');
      expect(out.id).toBe('018712345678901');
    });

    it('masks the example the security review used', () => {
      const out = redact({ reason: 'customer 01712345689 refused' }) as { reason: string };
      expect(out.reason).toBe('customer 017******89 refused');
    });
  });

  it('reports a field that appeared or disappeared', () => {
    expect(changedFields({ a: 1 }, { a: 1, b: 2 })).toEqual(['b']);
    expect(changedFields({ a: 1, b: 2 }, { a: 1 })).toEqual(['b']);
    expect(changedFields(null, { a: 1 })).toEqual(['a']);
    expect(changedFields({ a: 1 }, null)).toEqual(['a']);
  });
});

describe('a row that points back at itself', () => {
  /*
   * `redact` recurses, and a back-reference raised `RangeError: Maximum call
   * stack size exceeded`. That is worse here than in the serializer: the audit
   * write happens *after* the response has been sent, so the visible result is
   * a mutation that silently went unrecorded — the one outcome §25's
   * append-only log exists to make impossible.
   */
  it('does not overflow the stack', () => {
    const node: Record<string, unknown> = { passwordHash: 'argon2id$x' };
    node.self = node;

    expect(() => redact(node)).not.toThrow();
  });

  it('still redacts the secret sitting next to the cycle', () => {
    const node: Record<string, unknown> = { passwordHash: 'argon2id$x', phone: '01712345689' };
    node.self = node;

    const out = redact(node) as Record<string, unknown>;
    expect(out.passwordHash).toBe(REDACTED);
    expect(out.phone).toBe('017******89');
    expect(out.self, 'a back-reference is a fact about the row, so it is recorded').toBe(
      '[circular]',
    );
  });

  it('keeps a value that appears twice without being circular', () => {
    const shared = { note: 'hi' };
    const out = redact({ a: shared, b: shared }) as Record<string, unknown>;

    expect(out.a).toEqual({ note: 'hi' });
    expect(out.b, 'the second appearance was dropped as if it were a cycle').toEqual({
      note: 'hi',
    });
  });

  it('survives a cycle through an array', () => {
    const list: unknown[] = [{ apiKey: 'sk_live_1' }];
    list.push(list);

    const out = redact({ list }) as { list: unknown[] };
    expect(JSON.stringify(out)).not.toContain('sk_live_1');
  });
});

describe('a phone-named key does not switch the secret list off beneath it', () => {
  /*
   * `redact` routes any key matching `phone`, `mobile` or `msisdn` into the
   * masker and never consulted `REDACTED_FIELD_PATTERNS` again for that
   * subtree. The match is a case-insensitive substring, so
   * `phoneVerification`, `customerMobile` and `msisdnRecord` all qualified —
   * and `maskPhone` keeps the first three digits and the last two, so a short
   * secret came out nearly intact:
   *
   *   { phoneVerification: { otp: '483920' } }   ->  '483*20'
   *   { customerMobile: { backupCodes: [...] } } ->  '123***78'
   *
   * A six-digit OTP with four digits shown has ten possibilities left. §6
   * issues ten single-use recovery codes, shown once, and `audit.audit_log` is
   * append-only, so anything that lands there is permanent.
   *
   * It is the same bug the `otp` pattern was added for, one level down.
   */
  it('redacts a secret nested under a phone-named key', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ phoneVerification: { otp: '483920' } }, 'otp'],
      [{ customerMobile: { backupCodes: '12345678' } }, 'backupCodes'],
      [{ phone: { nid: '1994785321456' } }, 'nid'],
      [{ msisdnRecord: { apiKey: 'sk-live-99887766' } }, 'apiKey'],
      [{ mobileLogin: { password: 'Winter2026!' } }, 'password'],
    ];

    for (const [payload, secret] of cases) {
      const outer = Object.keys(payload)[0] ?? '';
      const out = redact(payload) as Record<string, Record<string, unknown>>;
      expect(out[outer]?.[secret], `${outer}.${secret} survived`).toBe(REDACTED);
    }
  });

  it('leaks no digits of the secret, not even a masked prefix', () => {
    // The old behaviour did not fail this by returning the value — it failed
    // by returning most of it.
    const out = JSON.stringify(redact({ phoneVerification: { otp: '483920' } }));
    expect(out).not.toContain('483');
    expect(out).not.toContain('920');
  });

  it('still masks the phone number itself, which is the point of the branch', () => {
    const out = redact({ customerPhone: '01712345689', phone: { number: '01812345622' } }) as {
      customerPhone: string;
      phone: { number: string };
    };

    expect(out.customerPhone).toBe('017******89');
    expect(out.phone.number).toBe('018******22');
  });

  it('survives a cycle through an array under a phone-named key', () => {
    // The array branch of `maskPhonesIn` dropped the `seen` set, so a cycle
    // there raised the RangeError the guard exists to prevent — and in the
    // audit path that is a mutation silently unrecorded.
    const list: unknown[] = [{ password: 'hunter2' }];
    list.push(list);

    const out = redact({ phones: list }) as { phones: unknown[] };
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).toContain('[circular]');
  });
});

describe('a walker that never returns is a missing audit row', () => {
  /*
   * A JSON body nested about five thousand levels — thirty kilobytes, well
   * inside Fastify's one-megabyte limit — raised `RangeError: Maximum call
   * stack size exceeded` inside `redact`. The audit interceptor runs that
   * inside `withOrg`, catches the throw and logs it, so the mutation committed
   * and no audit row existed at all. `POST /v1/users` creating an org admin is
   * the route that matters.
   */
  const deep = (levels: number): unknown =>
    JSON.parse('{"a":'.repeat(levels) + '1' + '}'.repeat(levels));

  it('does not overflow on a body deep enough to fit in a request', () => {
    expect(() => redact(deep(5_000))).not.toThrow();
  });

  it('truncates past the bound rather than silently dropping the row', () => {
    expect(JSON.stringify(redact(deep(5_000)))).toContain('[too deep]');
  });

  it('leaves an ordinary row untouched, so the bound is not in the way', () => {
    expect(JSON.stringify(redact(deep(20)))).not.toContain('[too deep]');
  });

  it('still redacts what it reaches before the bound', () => {
    const out = redact({ a: { b: { c: { passwordHash: 'x', deep: deep(5_000) } } } });
    expect(JSON.stringify(out)).toContain(REDACTED);
    expect(JSON.stringify(out)).not.toContain('"x"');
  });
});
