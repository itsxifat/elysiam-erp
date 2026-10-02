import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { poisha, type Poisha } from '../money/index.js';
import type { FraudDecision } from '../orders/state.js';
import {
  DECISION_SEVERITY,
  evaluateOrderRules,
  FRAUD_DECISIONS,
  FraudRuleError,
  ruleMatches,
  RULE_DECISIONS,
  stricter,
  validateOrderRule,
  type OrderFacts,
  type OrderRule,
} from './rules.js';
import { requiredAdvancePoisha } from './advance.js';

/**
 * M17 check 1: rule evaluation tests.
 *
 * Three layers, each answering a different doubt:
 *
 * 1. **Each condition, alone, on both sides of its edge.** A rule that matches at
 *    ৳3,000 and not at ৳2,999.99 is the thing a brand configures. An off-by-one there
 *    is a buyer asked for money they did not owe.
 * 2. **Worked policies,** the rules a brand would actually write, with the decision and
 *    the advance asked for.
 * 3. **Properties** of the engine as a whole. It never loosens the band, the order of
 *    the list does not matter, and a disabled rule is inert. These are D-232's promises,
 *    checked against random rule lists rather than the examples someone thought of.
 */

const ZONE_INSIDE = '11111111-1111-4111-8111-111111111111';
const ZONE_OUTSIDE = '22222222-2222-4222-8222-222222222222';

const NONE = {
  zoneIds: null,
  orderValueMinPoisha: null,
  orderValueMaxPoisha: null,
  trustBands: null,
  firstTimeBuyer: null,
  repeatReturnAddress: null,
} as const;

let nextId = 0;
function rule(overrides: Partial<OrderRule> = {}): OrderRule {
  nextId += 1;
  return {
    id: `00000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`,
    name: `rule ${nextId}`,
    enabled: true,
    decision: 'require_advance',
    advanceFixedPoisha: null,
    ...NONE,
    ...overrides,
  };
}

const FACTS: OrderFacts = {
  zoneId: ZONE_OUTSIDE,
  orderValuePoisha: poisha(300_000),
  band: 'allow',
  firstTimeBuyer: true,
  repeatReturnAddress: false,
};

describe('check 1: each condition, at its edge', () => {
  it('matches every order when it has no conditions', () => {
    expect(ruleMatches(rule(), FACTS)).toBe(true);
    expect(ruleMatches(rule(), { ...FACTS, zoneId: null })).toBe(true);
  });

  it('zone: in the list matches, outside or no zone does not', () => {
    const outside = rule({ zoneIds: [ZONE_OUTSIDE] });
    expect(ruleMatches(outside, FACTS)).toBe(true);
    expect(ruleMatches(outside, { ...FACTS, zoneId: ZONE_INSIDE })).toBe(false);
    // An order with no zone is not "in" any zone.
    expect(ruleMatches(outside, { ...FACTS, zoneId: null })).toBe(false);
    // Ids compare without regard to case, as Postgres prints them lower-case.
    expect(ruleMatches(outside, { ...FACTS, zoneId: ZONE_OUTSIDE.toUpperCase() })).toBe(true);
  });

  it('order value: both bounds are inclusive, to the poisha', () => {
    const band = rule({
      orderValueMinPoisha: poisha(300_000),
      orderValueMaxPoisha: poisha(500_000),
    });
    expect(ruleMatches(band, { ...FACTS, orderValuePoisha: poisha(299_999) })).toBe(false);
    expect(ruleMatches(band, { ...FACTS, orderValuePoisha: poisha(300_000) })).toBe(true);
    expect(ruleMatches(band, { ...FACTS, orderValuePoisha: poisha(500_000) })).toBe(true);
    expect(ruleMatches(band, { ...FACTS, orderValuePoisha: poisha(500_001) })).toBe(false);
  });

  it('trust band: matches the score’s own band', () => {
    const shaky = rule({ trustBands: ['warn'] });
    expect(ruleMatches(shaky, { ...FACTS, band: 'warn' })).toBe(true);
    expect(ruleMatches(shaky, { ...FACTS, band: 'allow' })).toBe(false);
  });

  it('first-time buyer: true, false and either', () => {
    expect(ruleMatches(rule({ firstTimeBuyer: true }), FACTS)).toBe(true);
    expect(ruleMatches(rule({ firstTimeBuyer: true }), { ...FACTS, firstTimeBuyer: false })).toBe(
      false,
    );
    expect(ruleMatches(rule({ firstTimeBuyer: false }), { ...FACTS, firstTimeBuyer: false })).toBe(
      true,
    );
  });

  it('repeat-return address: matches the address signal', () => {
    const door = rule({ repeatReturnAddress: true });
    expect(ruleMatches(door, FACTS)).toBe(false);
    expect(ruleMatches(door, { ...FACTS, repeatReturnAddress: true })).toBe(true);
  });

  it('ANDs its conditions: one miss is a miss', () => {
    const strict = rule({
      zoneIds: [ZONE_OUTSIDE],
      orderValueMinPoisha: poisha(300_000),
      firstTimeBuyer: true,
    });
    expect(ruleMatches(strict, FACTS)).toBe(true);
    expect(ruleMatches(strict, { ...FACTS, firstTimeBuyer: false })).toBe(false);
    expect(ruleMatches(strict, { ...FACTS, zoneId: ZONE_INSIDE })).toBe(false);
    expect(ruleMatches(strict, { ...FACTS, orderValuePoisha: poisha(299_999) })).toBe(false);
  });
});

describe('check 1: worked policies', () => {
  /*
   * "Outside Dhaka, ৳3,000 and over, first order with us: take the delivery charge."
   * The brand's commonest rule, and the reason the milestone exists.
   */
  const outsideFirstOrder = rule({
    name: 'Outside Dhaka first order',
    zoneIds: [ZONE_OUTSIDE],
    orderValueMinPoisha: poisha(300_000),
    firstTimeBuyer: true,
  });
  /* "A shaky score and a big basket: ৳500 up front." */
  const bigShaky = rule({
    name: 'Big basket, shaky score',
    trustBands: ['warn'],
    orderValueMinPoisha: poisha(500_000),
    advanceFixedPoisha: poisha(50_000),
  });
  /* "An address that keeps refusing: warn the agent." */
  const doorWarn = rule({ name: 'Refusing door', repeatReturnAddress: true, decision: 'warn' });

  const RULES = [outsideFirstOrder, bigShaky, doorWarn];

  const cases: readonly {
    readonly name: string;
    readonly facts: OrderFacts;
    readonly decision: FraudDecision;
    readonly matched: readonly string[];
    /** At a ৳60 delivery charge. */
    readonly requiredPoisha: bigint;
  }[] = [
    {
      name: 'an Outside Dhaka first order of ৳3,000 pays the delivery charge',
      facts: FACTS,
      decision: 'require_advance',
      matched: ['Outside Dhaka first order'],
      requiredPoisha: 6_000n,
    },
    {
      name: 'the same order from a returning buyer goes through',
      facts: { ...FACTS, firstTimeBuyer: false },
      decision: 'allow',
      matched: [],
      requiredPoisha: 0n,
    },
    {
      name: 'a ৳5,000 basket on a warn score pays the rule’s fixed ৳500, the larger ask',
      facts: { ...FACTS, band: 'warn', orderValuePoisha: poisha(500_000) },
      decision: 'require_advance',
      matched: ['Outside Dhaka first order', 'Big basket, shaky score'],
      requiredPoisha: 50_000n,
    },
    {
      name: 'a refusing door inside Dhaka is warned, not charged',
      facts: { ...FACTS, zoneId: ZONE_INSIDE, repeatReturnAddress: true },
      decision: 'warn',
      matched: ['Refusing door'],
      requiredPoisha: 0n,
    },
    {
      name: 'a score in the require-advance band asks for the delivery charge with no rule',
      facts: { ...FACTS, zoneId: ZONE_INSIDE, band: 'require_advance' },
      decision: 'require_advance',
      matched: [],
      requiredPoisha: 6_000n,
    },
    {
      name: 'a blocked score stays blocked, and nothing is asked: paying does not lift a block',
      facts: { ...FACTS, band: 'block' },
      decision: 'block',
      matched: ['Outside Dhaka first order'],
      requiredPoisha: 0n,
    },
  ];

  for (const entry of cases) {
    it(entry.name, () => {
      const result = evaluateOrderRules(RULES, entry.facts);
      expect(result.decision).toBe(entry.decision);
      expect(result.bandDecision).toBe(entry.facts.band);
      expect(result.matched.map((match) => match.name)).toEqual(entry.matched);
      expect(requiredAdvancePoisha(result.advance, poisha(6_000))).toBe(entry.requiredPoisha);
    });
  }

  it('ignores a disabled rule entirely', () => {
    const off = { ...outsideFirstOrder, enabled: false };
    const result = evaluateOrderRules([off], FACTS);
    expect(result.decision).toBe('allow');
    expect(result.matched).toEqual([]);
  });

  it('a block rule beats an advance rule on the same order', () => {
    const result = evaluateOrderRules(
      [outsideFirstOrder, rule({ name: 'No outside', zoneIds: [ZONE_OUTSIDE], decision: 'block' })],
      FACTS,
    );
    expect(result.decision).toBe('block');
    expect(result.advance).toEqual([]);
  });
});

describe('check 1: what a brand may not save', () => {
  const base = {
    name: 'a rule',
    enabled: true,
    decision: 'require_advance' as const,
    advanceFixedPoisha: null,
    ...NONE,
  };

  const refused: readonly [string, Partial<Omit<OrderRule, 'id'>>, RegExp][] = [
    ['a two-letter name', { name: 'ab' }, /name/],
    ['an empty zone list, which would match nothing', { zoneIds: [] }, /at least one zone/],
    ['a zone that is not an id', { zoneIds: ['inside-dhaka'] }, /by id/],
    ['the same zone twice', { zoneIds: [ZONE_INSIDE, ZONE_INSIDE] }, /twice/],
    [
      'a minimum above the maximum',
      { orderValueMinPoisha: poisha(5), orderValueMaxPoisha: poisha(4) },
      /above the maximum/,
    ],
    ['a negative minimum', { orderValueMinPoisha: -1n as Poisha }, /out of range/],
    ['an empty band list', { trustBands: [] }, /at least one band/],
    ['a band twice', { trustBands: ['warn', 'warn'] }, /twice/],
    [
      'an amount on a rule that does not ask for an advance',
      { decision: 'warn', advanceFixedPoisha: poisha(100) },
      /Only a rule that requires an advance/,
    ],
    ['a zero advance', { advanceFixedPoisha: poisha(0) }, /more than zero/],
    ['allow as a decision', { decision: 'allow' as never }, /warn, require_advance or block/],
  ];

  for (const [label, change, message] of refused) {
    it(`refuses ${label}`, () => {
      expect(() => validateOrderRule({ ...base, ...change })).toThrow(FraudRuleError);
      expect(() => validateOrderRule({ ...base, ...change })).toThrowError(message);
    });
  }

  it('accepts a rule with no conditions at all: "everyone pays first this week"', () => {
    expect(() => validateOrderRule(base)).not.toThrow();
  });
});

// --- properties ------------------------------------------------------------------

const decisionArb = fc.constantFrom<FraudDecision>(...FRAUD_DECISIONS);
const zoneArb = fc.constantFrom(ZONE_INSIDE, ZONE_OUTSIDE);
const amountArb = fc.bigInt({ min: 0n, max: 2_000_000n }).map((value) => poisha(value));

const ruleArb: fc.Arbitrary<OrderRule> = fc
  .record({
    enabled: fc.boolean(),
    decision: fc.constantFrom(...RULE_DECISIONS),
    zoneIds: fc.option(fc.uniqueArray(zoneArb, { minLength: 1, maxLength: 2 }), { nil: null }),
    min: fc.option(amountArb, { nil: null }),
    span: fc.option(amountArb, { nil: null }),
    trustBands: fc.option(fc.uniqueArray(decisionArb, { minLength: 1, maxLength: 4 }), {
      nil: null,
    }),
    firstTimeBuyer: fc.option(fc.boolean(), { nil: null }),
    repeatReturnAddress: fc.option(fc.boolean(), { nil: null }),
    fixed: fc.option(fc.bigInt({ min: 1n, max: 100_000n }), { nil: null }),
  })
  .map((r) => {
    const min = r.min;
    const max = r.span === null ? null : poisha((min ?? 0n) + r.span);
    return rule({
      enabled: r.enabled,
      decision: r.decision,
      zoneIds: r.zoneIds,
      orderValueMinPoisha: min,
      orderValueMaxPoisha: max,
      trustBands: r.trustBands,
      firstTimeBuyer: r.firstTimeBuyer,
      repeatReturnAddress: r.repeatReturnAddress,
      advanceFixedPoisha:
        r.decision === 'require_advance' && r.fixed !== null ? poisha(r.fixed) : null,
    });
  });

const factsArb: fc.Arbitrary<OrderFacts> = fc.record({
  zoneId: fc.option(zoneArb, { nil: null }),
  orderValuePoisha: amountArb,
  band: decisionArb,
  firstTimeBuyer: fc.boolean(),
  repeatReturnAddress: fc.boolean(),
});

describe('check 1: properties of the engine (D-232)', () => {
  it('every generated rule is one a brand could save', () => {
    fc.assert(
      fc.property(ruleArb, (generated) => {
        validateOrderRule(generated);
      }),
      { numRuns: 300 },
    );
  });

  it('never decides anything milder than the score’s own band', () => {
    fc.assert(
      fc.property(fc.array(ruleArb, { maxLength: 8 }), factsArb, (rules, facts) => {
        const result = evaluateOrderRules(rules, facts);
        expect(DECISION_SEVERITY[result.decision]).toBeGreaterThanOrEqual(
          DECISION_SEVERITY[facts.band],
        );
      }),
      { numRuns: 500 },
    );
  });

  it('is the most severe of the band and every matching enabled rule', () => {
    fc.assert(
      fc.property(fc.array(ruleArb, { maxLength: 8 }), factsArb, (rules, facts) => {
        const expected = rules
          .filter((candidate) => candidate.enabled && ruleMatches(candidate, facts))
          .reduce<FraudDecision>((acc, candidate) => stricter(acc, candidate.decision), facts.band);
        expect(evaluateOrderRules(rules, facts).decision).toBe(expected);
      }),
      { numRuns: 500 },
    );
  });

  it('does not depend on the order of the list', () => {
    fc.assert(
      fc.property(fc.array(ruleArb, { maxLength: 8 }), factsArb, (rules, facts) => {
        const forward = evaluateOrderRules(rules, facts);
        const backward = evaluateOrderRules([...rules].reverse(), facts);
        expect(backward.decision).toBe(forward.decision);
        expect(requiredAdvancePoisha(backward.advance, poisha(6_000))).toBe(
          requiredAdvancePoisha(forward.advance, poisha(6_000)),
        );
      }),
      { numRuns: 300 },
    );
  });

  it('a disabled rule changes nothing', () => {
    fc.assert(
      fc.property(fc.array(ruleArb, { maxLength: 6 }), ruleArb, factsArb, (rules, extra, facts) => {
        const without = evaluateOrderRules(rules, facts);
        const withDisabled = evaluateOrderRules([...rules, { ...extra, enabled: false }], facts);
        expect(withDisabled).toEqual(without);
      }),
      { numRuns: 300 },
    );
  });

  it('asks for an advance exactly when the decision is require_advance', () => {
    fc.assert(
      fc.property(fc.array(ruleArb, { maxLength: 8 }), factsArb, (rules, facts) => {
        const result = evaluateOrderRules(rules, facts);
        expect(result.advance.length > 0).toBe(result.decision === 'require_advance');
      }),
      { numRuns: 300 },
    );
  });
});
