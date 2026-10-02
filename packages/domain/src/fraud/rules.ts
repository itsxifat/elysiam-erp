import { MAX_POISHA, type Poisha } from '../money/index.js';
import type { FraudDecision } from '../orders/state.js';

/**
 * A brand's own order rules (architecture §10, M17, D-232).
 *
 * The trust score answers "how has this phone number behaved?". A brand also has policy
 * the score cannot express:
 *
 * - "Outside Dhaka, over ৳3,000, from somebody who has never taken a parcel from us:
 *   take the delivery charge first."
 * - "Anything sent to an address that keeps refusing parcels: warn the agent."
 *
 * These rules are that policy, as data a brand edits in the console.
 *
 * ## Rules escalate, and only escalate
 *
 * The result is the **most severe** of the score band's decision and every matching
 * enabled rule's decision. A rule can turn `allow` into `require_advance`. Nothing can
 * turn a `block` into an `allow`: the only way down is an org_admin's override, which
 * is audited (M13 check 5).
 *
 * The alternative, first match wins with rules able to relax the band, has two costs:
 *
 * - **Order matters.** Moving a rule up a list would silently change who gets blocked,
 *   and the list would need a priority model nobody can hold in their head.
 * - **A broad rule wins.** "Inside Dhaka → allow" would quietly un-block a number that
 *   five brands' returns and a manual flag have put in `block`.
 *
 * With escalation only, the answer does not depend on the order of the list, and a
 * property test says so.
 *
 * ## Why the conditions are these
 *
 * Milestone M17 names zone, COD amount, trust band and first-time buyer. The fifth,
 * repeat-return address, is M17's address signal (D-231), offered as a condition so a
 * brand can choose what to do with it.
 *
 * Conditions are ANDed, and a missing one (null) matches anything. A rule with no
 * conditions matches every order. That is deliberate: "everyone pays the delivery charge
 * first this week" is a real policy during a fraud wave.
 */

/** What a rule may decide. `allow` is absent because a rule can only escalate. */
export const RULE_DECISIONS = ['warn', 'require_advance', 'block'] as const;
export type RuleDecision = (typeof RULE_DECISIONS)[number];

/** §10's four bands, in the order of how much they hold an order back. */
export const DECISION_SEVERITY: Readonly<Record<FraudDecision, number>> = {
  allow: 0,
  warn: 1,
  require_advance: 2,
  block: 3,
};

export const FRAUD_DECISIONS: readonly FraudDecision[] = [
  'allow',
  'warn',
  'require_advance',
  'block',
];

/** The stricter of two decisions. */
export function stricter(a: FraudDecision, b: FraudDecision): FraudDecision {
  return DECISION_SEVERITY[b] > DECISION_SEVERITY[a] ? b : a;
}

/**
 * What an advance has to cover.
 *
 * §10 says `require_advance` means "collect the delivery charge in advance", so that is
 * the basis whenever a rule names no amount, and always when the score band alone asked.
 * A brand that wants more from a rule names a fixed amount on that rule.
 */
export type AdvanceRequirement =
  | { readonly basis: 'delivery_charge' }
  | { readonly basis: 'fixed'; readonly amountPoisha: Poisha };

export interface OrderRuleConditions {
  /** The order's delivery zone is one of these. Null: any zone, or none. */
  readonly zoneIds: readonly string[] | null;
  /** Order value (items − discount + delivery, before any advance) at least this. */
  readonly orderValueMinPoisha: Poisha | null;
  /** Order value at most this. */
  readonly orderValueMaxPoisha: Poisha | null;
  /** The score's own band is one of these. */
  readonly trustBands: readonly FraudDecision[] | null;
  /** True: only a buyer with no delivered order in this brand. False: only a returning one. */
  readonly firstTimeBuyer: boolean | null;
  /** True: only when the address matched earlier returns (D-231). False: only when it did not. */
  readonly repeatReturnAddress: boolean | null;
}

export interface OrderRule extends OrderRuleConditions {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly decision: RuleDecision;
  /** Only on `require_advance`. Null means the order's delivery charge (§10). */
  readonly advanceFixedPoisha: Poisha | null;
}

/** What is known about the order when the rules are asked. */
export interface OrderFacts {
  readonly zoneId: string | null;
  /**
   * Items − discount + delivery, **before** any advance.
   *
   * The COD figure would be the wrong input. An advance lowers the COD, so a rule like
   * "COD over ৳3,000 → require an advance" would stop matching the moment the advance
   * it asked for was paid. The rule would then be satisfied by its own effect rather
   * than by the money.
   */
  readonly orderValuePoisha: Poisha;
  /** The decision the trust score's band produced on its own. */
  readonly band: FraudDecision;
  readonly firstTimeBuyer: boolean;
  readonly repeatReturnAddress: boolean;
}

export interface MatchedRule {
  readonly id: string;
  readonly name: string;
  readonly decision: RuleDecision;
}

export interface RuleEvaluation {
  /** The decision that stands: the most severe of the band and every matched rule. */
  readonly decision: FraudDecision;
  /** The band's decision before any rule, so the desk can say what changed it. */
  readonly bandDecision: FraudDecision;
  /** Every enabled rule that matched, in the order given. */
  readonly matched: readonly MatchedRule[];
  /**
   * What an advance has to cover. One entry per source that asked for one: the band,
   * then each matched `require_advance` rule. The order must cover the largest
   * (`requiredAdvancePoisha`).
   *
   * Empty unless `decision` is `require_advance`. A `block` is not lifted by paying, so
   * a requirement under it would be a promise the confirm will not keep.
   */
  readonly advance: readonly AdvanceRequirement[];
}

export class FraudRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FraudRuleError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_RULE_ZONES = 50;
export const RULE_NAME_MIN = 3;
export const RULE_NAME_MAX = 80;

/**
 * Refuse a rule that cannot mean what its editor thinks it means.
 *
 * Called by the service before every write, and the database has the same checks, so a
 * row written by any other path fails too.
 *
 * - **An empty list is refused**, never treated as "any". `zoneIds: []` reads as "no
 *   zone" to a person and as "match nothing" to a set test. Either way the rule could
 *   never fire, and an admin would believe it was protecting them.
 * - **min > max is refused.** That range is empty, so the rule is dead.
 * - **A fixed amount on a rule that does not require an advance is refused.** It would
 *   be stored and never read.
 */
export function validateOrderRule(rule: Omit<OrderRule, 'id'>): void {
  const name = rule.name.trim();
  if (name.length < RULE_NAME_MIN || name.length > RULE_NAME_MAX) {
    throw new FraudRuleError(
      `A rule needs a name of ${RULE_NAME_MIN} to ${RULE_NAME_MAX} characters.`,
    );
  }
  if (!(RULE_DECISIONS as readonly string[]).includes(rule.decision)) {
    throw new FraudRuleError(
      `A rule decides warn, require_advance or block, not ${rule.decision}.`,
    );
  }

  if (rule.zoneIds !== null) {
    if (rule.zoneIds.length === 0) {
      throw new FraudRuleError('A zone condition needs at least one zone; leave it out for any.');
    }
    if (rule.zoneIds.length > MAX_RULE_ZONES) {
      throw new FraudRuleError(`A rule can name at most ${MAX_RULE_ZONES} zones.`);
    }
    if (rule.zoneIds.some((id) => !UUID.test(id))) {
      throw new FraudRuleError('A zone condition names zones by id.');
    }
    if (new Set(rule.zoneIds.map((id) => id.toLowerCase())).size !== rule.zoneIds.length) {
      throw new FraudRuleError('A zone is named twice in the same rule.');
    }
  }

  for (const [label, value] of [
    ['minimum', rule.orderValueMinPoisha],
    ['maximum', rule.orderValueMaxPoisha],
  ] as const) {
    if (value !== null && (value < 0n || value > MAX_POISHA)) {
      throw new FraudRuleError(`The order value ${label} is out of range.`);
    }
  }
  if (
    rule.orderValueMinPoisha !== null &&
    rule.orderValueMaxPoisha !== null &&
    rule.orderValueMinPoisha > rule.orderValueMaxPoisha
  ) {
    throw new FraudRuleError('The order value minimum is above the maximum, so nothing matches.');
  }

  if (rule.trustBands !== null) {
    if (rule.trustBands.length === 0) {
      throw new FraudRuleError('A trust band condition needs at least one band.');
    }
    if (rule.trustBands.some((band) => !FRAUD_DECISIONS.includes(band))) {
      throw new FraudRuleError('A trust band is one of allow, warn, require_advance or block.');
    }
    if (new Set(rule.trustBands).size !== rule.trustBands.length) {
      throw new FraudRuleError('A trust band is named twice in the same rule.');
    }
  }

  if (rule.advanceFixedPoisha !== null) {
    if (rule.decision !== 'require_advance') {
      throw new FraudRuleError('Only a rule that requires an advance can name its amount.');
    }
    if (rule.advanceFixedPoisha <= 0n || rule.advanceFixedPoisha > MAX_POISHA) {
      throw new FraudRuleError('An advance amount must be more than zero.');
    }
  }
}

/** Whether one rule's conditions all hold for these facts. Ignores `enabled`. */
export function ruleMatches(rule: OrderRuleConditions, facts: OrderFacts): boolean {
  if (rule.zoneIds !== null) {
    const zone = facts.zoneId?.toLowerCase();
    if (zone === undefined || !rule.zoneIds.some((id) => id.toLowerCase() === zone)) return false;
  }
  if (rule.orderValueMinPoisha !== null && facts.orderValuePoisha < rule.orderValueMinPoisha) {
    return false;
  }
  if (rule.orderValueMaxPoisha !== null && facts.orderValuePoisha > rule.orderValueMaxPoisha) {
    return false;
  }
  if (rule.trustBands !== null && !rule.trustBands.includes(facts.band)) return false;
  if (rule.firstTimeBuyer !== null && rule.firstTimeBuyer !== facts.firstTimeBuyer) return false;
  if (rule.repeatReturnAddress !== null && rule.repeatReturnAddress !== facts.repeatReturnAddress) {
    return false;
  }
  return true;
}

/**
 * The decision that stands for this order, and why (check 1).
 *
 * Pure: the same rules and facts give the same answer in the confirm guard, in the
 * desk's preview, and in a test.
 */
export function evaluateOrderRules(rules: readonly OrderRule[], facts: OrderFacts): RuleEvaluation {
  let decision: FraudDecision = facts.band;
  const matched: MatchedRule[] = [];

  for (const rule of rules) {
    if (!rule.enabled || !ruleMatches(rule, facts)) continue;
    matched.push({ id: rule.id, name: rule.name, decision: rule.decision });
    decision = stricter(decision, rule.decision);
  }

  const advance: AdvanceRequirement[] = [];
  if (decision === 'require_advance') {
    if (facts.band === 'require_advance') advance.push({ basis: 'delivery_charge' });
    for (const rule of rules) {
      if (!rule.enabled || rule.decision !== 'require_advance' || !ruleMatches(rule, facts)) {
        continue;
      }
      advance.push(
        rule.advanceFixedPoisha === null
          ? { basis: 'delivery_charge' }
          : { basis: 'fixed', amountPoisha: rule.advanceFixedPoisha },
      );
    }
  }

  return { decision, bandDecision: facts.band, matched, advance };
}
