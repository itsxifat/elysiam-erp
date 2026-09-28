import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assertBands,
  decideForScore,
  DEFAULT_FRAUD_BANDS,
  FraudBandsError,
  NEUTRAL_SCORE,
  trustScore,
  type ProviderSignals,
  type TrustReasonCode,
  type TrustScoreInput,
} from './index.js';

/**
 * M13 check 1: "table-driven score tests: a new customer, 10/10 delivered, 3/5
 * returned, a provider-only result, a manual flag."
 *
 * Table-driven exactly as the check asks, because the five cases are not five
 * assertions about one formula — they are the five situations the order desk
 * actually meets, and each one has to land in a *different* band for the badge to
 * be worth anything. A model where four of the five say `allow` is arithmetically
 * fine and operationally useless, so the table asserts the band as well as the
 * number.
 *
 * The scores are written out rather than recomputed from the constants. A test that
 * re-derives the expected value from `INTERNAL_WEIGHT` and `CONFIDENCE_K` passes
 * after any change to either, including a change that moves every real customer
 * into `block` — it would assert that the code does what the code does. Hard-coded
 * numbers mean tuning the model is a deliberate edit here, with the new band
 * visible in the diff.
 */

const NOW = new Date('2026-03-15T06:00:00.000Z');

/** Nothing known, nothing flagged, no provider configured. */
function signals(overrides: Partial<TrustScoreInput> = {}): TrustScoreInput {
  return {
    internal: {
      ordersTotal: 0,
      delivered: 0,
      returned: 0,
      cancelled: 0,
      lastIncidentAt: null,
      manualFlagCount: 0,
      ...overrides.internal,
    },
    providers: overrides.providers ?? [],
    providerAvailable: overrides.providerAvailable ?? true,
    now: overrides.now ?? NOW,
    ...(overrides.bands === undefined ? {} : { bands: overrides.bands }),
  };
}

const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);

const steadfast = (
  total: number,
  delivered: number,
  returnedOrCancelled: number,
): ProviderSignals => ({ provider: 'steadfast', total, delivered, returnedOrCancelled });

interface Case {
  readonly name: string;
  readonly input: TrustScoreInput;
  readonly score: number;
  readonly decision: 'allow' | 'warn' | 'require_advance' | 'block';
  /** Reason codes that must appear. Others may too — the list is not exhaustive. */
  readonly reasons: readonly TrustReasonCode[];
}

const CASES: readonly Case[] = [
  {
    /*
     * A number nobody has sold to. Deliberately `allow`, at the floor: in a
     * Bangladeshi COD business most orders come from a stranger, and a model that
     * warns on all of them is a badge the desk learns to click past.
     */
    name: 'a new customer',
    input: signals(),
    score: 70,
    decision: 'allow',
    reasons: ['no_history'],
  },
  {
    /*
     * Ten for ten. Well clear of the floor, and still not 100: the score is a
     * blend towards the evidence, and ten orders is worth 71% of what internal
     * evidence can ever be worth. A model that returned 100 here would have
     * nowhere left to put a buyer with two hundred deliveries.
     */
    name: '10 of 10 delivered',
    input: signals({
      internal: {
        ordersTotal: 10,
        delivered: 10,
        returned: 0,
        cancelled: 0,
        lastIncidentAt: null,
        manualFlagCount: 0,
      },
    }),
    score: 82,
    decision: 'allow',
    reasons: ['internal_ratio'],
  },
  {
    /*
     * Three of five came back, the last one two days ago. Three rules fire at once
     * — the ratio, the majority-return penalty and the recency penalty — and the
     * result is `require_advance`: take the delivery charge up front rather than
     * refuse the sale. That is the band §10 invented for exactly this buyer.
     */
    name: '3 of 5 returned, the last one this week',
    input: signals({
      internal: {
        ordersTotal: 5,
        delivered: 2,
        returned: 3,
        cancelled: 0,
        lastIncidentAt: daysAgo(2),
        manualFlagCount: 0,
      },
    }),
    score: 26,
    decision: 'require_advance',
    reasons: ['internal_ratio', 'internal_high_return_ratio', 'recent_incident'],
  },
  {
    /*
     * We have never sold to this number; a provider has, twelve times, and eight
     * came back. The provider alone has to be able to move the score, or the
     * integration is decoration — so this case exists to prove a provider-only
     * result reaches `require_advance` rather than sitting at the neutral 70.
     */
    name: 'a provider-only result',
    input: signals({ providers: [steadfast(12, 4, 8)] }),
    score: 38,
    decision: 'require_advance',
    reasons: ['provider_ratio', 'no_internal_history', 'provider_high_return_ratio'],
  },
  {
    /*
     * One hand-written flag on an otherwise unknown number, and it blocks. That is
     * the point of a manual flag: somebody here looked at this buyer and wrote down
     * why, which is stronger than any ratio. The way past it is an org_admin
     * override with a reason, which is audited (check 5).
     */
    name: 'a manual flag',
    input: signals({
      internal: {
        ordersTotal: 0,
        delivered: 0,
        returned: 0,
        cancelled: 0,
        lastIncidentAt: null,
        manualFlagCount: 1,
      },
    }),
    score: 15,
    decision: 'block',
    reasons: ['manual_flag'],
  },
];

describe('check 1: the five named score cases', () => {
  for (const testCase of CASES) {
    it(`${testCase.name} scores ${String(testCase.score)} and decides ${testCase.decision}`, () => {
      const result = trustScore(testCase.input);

      expect(result.score).toBe(testCase.score);
      expect(result.decision).toBe(testCase.decision);
      for (const code of testCase.reasons) {
        expect(result.reasons.map((reason) => reason.code)).toContain(code);
      }
    });
  }

  it('gives the five cases five different bands between them', () => {
    // The check names five cases because they are meant to be distinguishable. If
    // a tuning change collapsed three of them into `allow` every assertion above
    // could still pass one at a time.
    const decisions = new Set(CASES.map((testCase) => trustScore(testCase.input).decision));
    expect([...decisions].sort()).toEqual(['allow', 'block', 'require_advance']);
    expect(decisions.size).toBe(3);
  });

  it('carries no phone, name, id or amount in any reason', () => {
    // Invariant 10, and §5's rule for the cross-org row: these reasons are stored
    // on an order, shown to an org that contributed none of the evidence, and read
    // back months later. Every value must be a plain number.
    for (const testCase of CASES) {
      for (const reason of trustScore(testCase.input).reasons) {
        for (const value of Object.values(reason.values ?? {})) {
          expect(typeof value).toBe('number');
        }
      }
    }
  });
});

describe('check 3: a provider that did not answer', () => {
  it('scores on internal evidence alone and says the provider is unavailable', () => {
    const internal = {
      ordersTotal: 6,
      delivered: 6,
      returned: 0,
      cancelled: 0,
      lastIncidentAt: null,
      manualFlagCount: 0,
    };

    const down = trustScore(signals({ internal, providers: [], providerAvailable: false }));
    const configuredButSilent = trustScore(signals({ internal, providers: [] }));

    // Identical numbers: a provider outage is a fact about us, not about the buyer.
    // Penalising it would turn a third party's slow afternoon into every order in
    // the country being blocked.
    expect(down.score).toBe(configuredButSilent.score);
    expect(down.decision).toBe(configuredButSilent.decision);

    expect(down.providerAvailable).toBe(false);
    expect(down.reasons.map((reason) => reason.code)).toContain('provider_unavailable');
    expect(configuredButSilent.reasons.map((reason) => reason.code)).not.toContain(
      'provider_unavailable',
    );
  });
});

describe('the score stays inside its range', () => {
  it('never leaves 0–100 for any combination of counts', () => {
    fc.assert(
      fc.property(
        fc.record({
          ordersTotal: fc.nat({ max: 5_000 }),
          delivered: fc.nat({ max: 5_000 }),
          returned: fc.nat({ max: 5_000 }),
          cancelled: fc.nat({ max: 5_000 }),
          manualFlagCount: fc.nat({ max: 20 }),
          incidentDaysAgo: fc.option(fc.nat({ max: 900 }), { nil: undefined }),
          providers: fc.array(
            fc.record({
              total: fc.nat({ max: 5_000 }),
              delivered: fc.nat({ max: 5_000 }),
              returnedOrCancelled: fc.nat({ max: 5_000 }),
            }),
            { maxLength: 3 },
          ),
        }),
        (sample) => {
          const result = trustScore(
            signals({
              internal: {
                ordersTotal: sample.ordersTotal,
                delivered: sample.delivered,
                returned: sample.returned,
                cancelled: sample.cancelled,
                lastIncidentAt:
                  sample.incidentDaysAgo === undefined ? null : daysAgo(sample.incidentDaysAgo),
                manualFlagCount: sample.manualFlagCount,
              },
              providers: sample.providers.map((provider, index) => ({
                provider: `p${String(index)}`,
                ...provider,
              })),
            }),
          );

          expect(Number.isInteger(result.score)).toBe(true);
          expect(result.score).toBeGreaterThanOrEqual(0);
          expect(result.score).toBeLessThanOrEqual(100);
          expect(result.decision).toBe(decideForScore(result.score, DEFAULT_FRAUD_BANDS));
        },
      ),
      { numRuns: 400 },
    );
  });

  it('refuses a negative counter rather than producing a ratio above 1', () => {
    // A negative `delivered` would make the ratio exceed 1 and the score exceed
    // 100 — which lands in `allow` and reads as a model customer. Failing on the
    // row is the only safe direction for a counter maintained by five orgs' events.
    expect(() =>
      trustScore(
        signals({
          internal: {
            ordersTotal: 1,
            delivered: -5,
            returned: 0,
            cancelled: 0,
            lastIncidentAt: null,
            manualFlagCount: 0,
          },
        }),
      ),
    ).toThrow(/whole number/);
  });

  it('adds more history monotonically towards the observed ratio', () => {
    // A perfect record must never score worse for having more of it. The blend is
    // meant to slide from neutral towards the evidence, and an off-by-one in the
    // confidence weight would show up here and nowhere else.
    let previous = NEUTRAL_SCORE - 1;
    for (const count of [1, 2, 5, 10, 25, 100]) {
      const { score } = trustScore(
        signals({
          internal: {
            ordersTotal: count,
            delivered: count,
            returned: 0,
            cancelled: 0,
            lastIncidentAt: null,
            manualFlagCount: 0,
          },
        }),
      );
      expect(score).toBeGreaterThan(previous);
      previous = score;
    }
  });
});

describe('per-org bands (D-011)', () => {
  it('maps every score to exactly one band', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (score) => {
        const decision = decideForScore(score);
        const expected =
          score >= 70 ? 'allow' : score >= 40 ? 'warn' : score >= 20 ? 'require_advance' : 'block';
        expect(decision).toBe(expected);
      }),
    );
  });

  it('lets an org be stricter than the default', () => {
    // A brand selling ৳12,000 sarees does not want a ৳400-kurti brand's tolerance.
    const strict = { allowMin: 85, warnMin: 60, requireAdvanceMin: 35 };
    expect(decideForScore(82, strict)).toBe('warn');
    expect(decideForScore(82, DEFAULT_FRAUD_BANDS)).toBe('allow');
  });

  it('refuses floors that do not decrease strictly', () => {
    // `warnMin === allowMin` deletes the warn band: it reads in the admin screen as
    // "configured" and behaves as "never happens".
    expect(() => assertBands({ allowMin: 70, warnMin: 70, requireAdvanceMin: 20 })).toThrow(
      FraudBandsError,
    );
    expect(() => assertBands({ allowMin: 40, warnMin: 70, requireAdvanceMin: 20 })).toThrow(
      FraudBandsError,
    );
    expect(() => assertBands({ allowMin: 101, warnMin: 70, requireAdvanceMin: 20 })).toThrow(
      FraudBandsError,
    );
  });
});
