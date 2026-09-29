import { type Poisha } from '../money/index.js';

/**
 * Which courier a parcel goes with (architecture §9 "Delivery zones and charges"; M15).
 *
 * §9 gives every zone a default courier, and the order desk copies it onto the order when
 * the order is taken. M15's rules sit on top of that default, because the decisions a brand
 * actually makes are finer than a zone: "inside Dhaka goes with Pathao, but anything over
 * ৳5,000 COD goes with Steadfast, whose riders carry more cash", or "RedX for the suburbs
 * until its account is live, then Pathao".
 *
 * ## What it decides: the order's courier, not the parcel's
 *
 * This answers "which courier *should* this order go with", and the answer is applied to the
 * **order** — by the desk from `GET /v1/courier/selection/preview`, or by the orders module
 * when it takes an order (see the INTEGRATION notes). Booking then uses the order's courier
 * and refuses any other, because §7's delivery journal books `courier_receivable` against the
 * order's courier while the settlement relieves the parcel's: a parcel booked with a courier
 * the order does not name splits one COD across two couriers' balances, and the org-wide total
 * still balancing is exactly why nobody notices.
 *
 * ## The order of precedence, and why it is this one
 *
 * 1. **A courier a person names** — at order entry, or when changing the order's courier.
 *    That is somebody deciding about this parcel, now.
 * 2. **The first matching rule**, by priority, whose courier can actually take a parcel
 *    (an active account on an enabled adapter). A rule whose courier cannot book is
 *    skipped rather than failing: the reason to have more than one rule for a zone is
 *    failover, and a rule that stopped the booking would defeat it.
 * 3. **The order's current courier** — the zone default, or whatever the desk put on it.
 *
 * Rule 2 above rule 3 is the decision worth stating (see decisions.md): once an org writes
 * rules, the rules are its policy for the order's courier. With no rules configured the
 * answer is the order's own courier, which is M12's behaviour.
 *
 * Pure, and in the domain, because it is a decision with money in it — a parcel sent with a
 * courier the brand has no settlement account with is COD nobody can reconcile — and it has
 * to answer identically in the desk's preview, in the orders module and in a test.
 */

export interface CourierSelectionRule {
  readonly id: string;
  /** Lower first. Ties are broken by id so the answer never depends on row order. */
  readonly priority: number;
  /** Null matches every zone. */
  readonly deliveryZoneId: string | null;
  /** Inclusive. Null means no lower bound. */
  readonly minCodPoisha: Poisha | null;
  /** Inclusive. Null means no upper bound. */
  readonly maxCodPoisha: Poisha | null;
  readonly courierId: string;
  readonly isActive: boolean;
}

export interface CourierSelectionInput {
  /** Named by a person at booking time. Wins outright. */
  readonly requestedCourierId: string | null;
  /** The zone default or the desk's choice, as it stands on the order. */
  readonly orderCourierId: string | null;
  readonly deliveryZoneId: string | null;
  readonly codAmountPoisha: Poisha;
}

export type CourierSelectionSource = 'requested' | 'rule' | 'order' | 'none';

export interface CourierSelection {
  readonly courierId: string | null;
  readonly source: CourierSelectionSource;
  /** The rule that decided it, when one did. */
  readonly ruleId: string | null;
  /**
   * Rules that matched the parcel but were passed over because their courier cannot take
   * a parcel right now. Reported so the desk's preview can say *why* the zone's usual
   * courier was not used, instead of leaving somebody to work it out from the account page.
   */
  readonly skippedRuleIds: readonly string[];
}

/** Whether a rule's conditions describe this parcel. Availability is a separate question. */
export function ruleMatches(rule: CourierSelectionRule, input: CourierSelectionInput): boolean {
  if (!rule.isActive) return false;
  if (rule.deliveryZoneId !== null && rule.deliveryZoneId !== input.deliveryZoneId) return false;
  if (rule.minCodPoisha !== null && input.codAmountPoisha < rule.minCodPoisha) return false;
  if (rule.maxCodPoisha !== null && input.codAmountPoisha > rule.maxCodPoisha) return false;
  return true;
}

/** Priority, then id: a total order, so two rules at one priority still answer one way. */
export function orderRules(rules: readonly CourierSelectionRule[]): CourierSelectionRule[] {
  return [...rules].sort((left, right) =>
    left.priority !== right.priority
      ? left.priority - right.priority
      : left.id < right.id
        ? -1
        : left.id > right.id
          ? 1
          : 0,
  );
}

/**
 * Pick the courier for one parcel.
 *
 * `canBook` answers whether a courier has an active account on an enabled adapter. It is a
 * predicate rather than a list so the caller decides what "can book" means — the booking
 * job asks the database, a test passes a set.
 *
 * A requested courier is returned even when it cannot book. The person asked for it, and the
 * booking then fails with the account's own reason ("not active", "no adapter") — silently
 * substituting a different courier for the one a person named would be worse than refusing.
 */
export function selectCourier(
  input: CourierSelectionInput,
  rules: readonly CourierSelectionRule[],
  canBook: (courierId: string) => boolean,
): CourierSelection {
  if (input.requestedCourierId !== null) {
    return {
      courierId: input.requestedCourierId,
      source: 'requested',
      ruleId: null,
      skippedRuleIds: [],
    };
  }

  const skipped: string[] = [];
  for (const rule of orderRules(rules)) {
    if (!ruleMatches(rule, input)) continue;
    if (!canBook(rule.courierId)) {
      skipped.push(rule.id);
      continue;
    }
    return { courierId: rule.courierId, source: 'rule', ruleId: rule.id, skippedRuleIds: skipped };
  }

  if (input.orderCourierId !== null) {
    return {
      courierId: input.orderCourierId,
      source: 'order',
      ruleId: null,
      skippedRuleIds: skipped,
    };
  }

  return { courierId: null, source: 'none', ruleId: null, skippedRuleIds: skipped };
}

export interface RuleSetProblem {
  readonly index: number;
  readonly message: string;
}

/**
 * Refuse a rule set a person could not have meant.
 *
 * Checked before the set replaces the old one, because a bad set is not refused at booking
 * time — it silently routes parcels. A COD band with its bounds reversed matches nothing and
 * the parcel falls through to the zone default, which looks like the rule working.
 */
export function validateRuleSet(rules: readonly Omit<CourierSelectionRule, 'id'>[]): RuleSetProblem[] {
  const problems: RuleSetProblem[] = [];
  const seen = new Set<string>();
  rules.forEach((rule, index) => {
    if (!Number.isSafeInteger(rule.priority) || rule.priority < 0 || rule.priority > 10_000) {
      problems.push({ index, message: 'A priority is a whole number from 0 to 10000.' });
    }
    if (rule.minCodPoisha !== null && rule.minCodPoisha < 0n) {
      problems.push({ index, message: 'A COD lower bound cannot be negative.' });
    }
    if (rule.maxCodPoisha !== null && rule.maxCodPoisha < 0n) {
      problems.push({ index, message: 'A COD upper bound cannot be negative.' });
    }
    if (
      rule.minCodPoisha !== null &&
      rule.maxCodPoisha !== null &&
      rule.minCodPoisha > rule.maxCodPoisha
    ) {
      problems.push({ index, message: 'The COD lower bound is above the upper bound.' });
    }
    /*
     * Two active rules with the same priority and the same conditions are one rule stated
     * twice with different couriers, and which one wins would be decided by an id nobody
     * chose. Refused, so the person writing them picks.
     */
    const key = [
      rule.priority,
      rule.deliveryZoneId ?? '*',
      rule.minCodPoisha?.toString() ?? '-',
      rule.maxCodPoisha?.toString() ?? '-',
    ].join('|');
    if (rule.isActive) {
      if (seen.has(key)) {
        problems.push({
          index,
          message: 'Another active rule has the same priority and conditions.',
        });
      }
      seen.add(key);
    }
  });
  return problems;
}
