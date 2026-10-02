import { percentOf, poisha, type Poisha } from '../money/index.js';

import { TargetError } from './errors.js';
import { isCountMetric, isTargetMetric, pctBps, type TargetMetric } from './progress.js';

/**
 * The bonus rule DSL (architecture §12; M20 check 2).
 *
 * A rule is versioned JSON a person writes, a checker approves and payroll pays. §12's
 * example is the whole language in miniature:
 *
 * ```json
 * {
 *   "metric": "delivered_orders",
 *   "tiers": [
 *     { "gte_pct": 100, "amount_poisha": 200000 },
 *     { "gte_pct": 120, "per_unit_above_target_poisha": 5000 }
 *   ]
 * }
 * ```
 *
 * ## What it means (D-274)
 *
 * * **Tiers are cumulative.** Every tier whose threshold is met pays. Read the other way —
 *   only the highest tier reached pays — the example pays less at 121% than at 119%:
 *   ৳2,000 flat at 119%, and at 121% of a 100-order target only 21 × ৳50 = ৳1,050. A rule
 *   that punishes beating it is not what anybody wrote.
 * * **A threshold is compared exactly.** `achieved × 100 ≥ gte_pct × target`, in integers.
 *   A percentage rounded for display decides nothing: 99.995% is not 100%.
 * * **Three kinds of tier.** A flat `amount_poisha`; `per_unit_above_target_poisha` for
 *   the two count metrics, paid on every order above the target (not above the tier's
 *   threshold); and `bps_of_excess` for revenue, a share of the revenue above the target.
 *   A per-unit amount on revenue would be "per poisha" and a share of an order count is
 *   not money, so each is refused on the other's metric.
 * * **An optional `cap_poisha`** bounds the total, because an open-ended per-unit tier
 *   with a mistyped target of 1 is otherwise a payroll line nobody budgeted for.
 *
 * Amounts are integer poisha (invariant 1), as JSON integers or digit strings; the one
 * share is rounded by `percentOf`, the money module's single rounding rule.
 */

export type BonusTier =
  | { readonly gtePct: number; readonly kind: 'flat'; readonly amountPoisha: Poisha }
  | { readonly gtePct: number; readonly kind: 'per_unit'; readonly perUnitPoisha: Poisha }
  | { readonly gtePct: number; readonly kind: 'bps_of_excess'; readonly bps: number };

export interface BonusRule {
  readonly metric: TargetMetric;
  readonly tiers: readonly BonusTier[];
  readonly capPoisha: Poisha | null;
}

/** Ten tiers is a generous upper bound for a rule a checker has to read. */
export const MAX_BONUS_TIERS = 10;
/** 1000% of target is the highest threshold a rule may name. */
export const MAX_GTE_PCT = 1000;

const TIER_KEYS = ['amount_poisha', 'per_unit_above_target_poisha', 'bps_of_excess'] as const;
const ALLOWED_RULE_KEYS = new Set(['metric', 'tiers', 'cap_poisha']);
const ALLOWED_TIER_KEYS = new Set(['gte_pct', ...TIER_KEYS]);

function invalid(message: string): never {
  throw new TargetError('BONUS_RULE_INVALID', message);
}

function positiveAmount(value: unknown, where: string): Poisha {
  const text =
    typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === 'string' && /^\d{1,16}$/.test(value)
        ? value
        : null;
  if (text === null) invalid(`${where} must be a whole number of poisha.`);
  const amount = poisha(text);
  if (amount <= 0n) invalid(`${where} must be more than zero.`);
  return amount;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a rule from its JSON, or say exactly what is wrong with it.
 *
 * Strict: an unknown key is refused rather than ignored, because a misspelt
 * `amount_poisa` that was silently dropped would leave a tier that pays nothing and a
 * checker who approved a rule that looked like it paid ৳2,000.
 */
export function parseBonusRule(input: unknown): BonusRule {
  if (!isRecord(input)) invalid('A bonus rule is a JSON object.');
  for (const key of Object.keys(input)) {
    if (!ALLOWED_RULE_KEYS.has(key)) invalid(`"${key}" is not part of a bonus rule.`);
  }

  const metric = input.metric;
  if (typeof metric !== 'string' || !isTargetMetric(metric)) {
    invalid('The metric is confirmed_orders, delivered_orders or delivered_revenue.');
  }

  const rawTiers = input.tiers;
  if (!Array.isArray(rawTiers) || rawTiers.length === 0) {
    invalid('A bonus rule needs at least one tier.');
  }
  if (rawTiers.length > MAX_BONUS_TIERS) {
    invalid(`A bonus rule has at most ${String(MAX_BONUS_TIERS)} tiers.`);
  }

  const tiers: BonusTier[] = [];
  let previous = 0;
  for (const [index, raw] of rawTiers.entries()) {
    const where = `Tier ${String(index + 1)}`;
    if (!isRecord(raw)) invalid(`${where} is not an object.`);
    for (const key of Object.keys(raw)) {
      if (!ALLOWED_TIER_KEYS.has(key)) invalid(`${where}: "${key}" is not part of a tier.`);
    }

    const gtePct = raw.gte_pct;
    if (
      typeof gtePct !== 'number' ||
      !Number.isInteger(gtePct) ||
      gtePct < 1 ||
      gtePct > MAX_GTE_PCT
    ) {
      invalid(`${where}: gte_pct is a whole percentage from 1 to ${String(MAX_GTE_PCT)}.`);
    }
    if (gtePct <= previous) {
      invalid(`${where}: thresholds must rise from one tier to the next.`);
    }
    previous = gtePct;

    const kinds = TIER_KEYS.filter((key) => raw[key] !== undefined);
    const kind = kinds[0];
    if (kind === undefined || kinds.length !== 1) {
      invalid(
        `${where} names exactly one of amount_poisha, per_unit_above_target_poisha or bps_of_excess.`,
      );
    }

    if (kind === 'amount_poisha') {
      tiers.push({ gtePct, kind: 'flat', amountPoisha: positiveAmount(raw[kind], where) });
    } else if (kind === 'per_unit_above_target_poisha') {
      if (!isCountMetric(metric)) {
        invalid(`${where}: a per-unit amount pays per order; use bps_of_excess for revenue.`);
      }
      tiers.push({ gtePct, kind: 'per_unit', perUnitPoisha: positiveAmount(raw[kind], where) });
    } else {
      if (isCountMetric(metric)) {
        invalid(`${where}: bps_of_excess is a share of revenue; use a per-unit amount.`);
      }
      const bps = raw[kind];
      if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 1 || bps > 10_000) {
        invalid(`${where}: bps_of_excess is whole basis points from 1 to 10000.`);
      }
      tiers.push({ gtePct, kind: 'bps_of_excess', bps });
    }
  }

  const capPoisha =
    input.cap_poisha === undefined || input.cap_poisha === null
      ? null
      : positiveAmount(input.cap_poisha, 'The cap');

  return { metric, tiers, capPoisha };
}

/** The rule back in its own JSON shape, for storage and for the screen. */
export function bonusRuleToJson(rule: BonusRule): Record<string, unknown> {
  return {
    metric: rule.metric,
    tiers: rule.tiers.map((tier) => {
      switch (tier.kind) {
        case 'flat':
          return { gte_pct: tier.gtePct, amount_poisha: tier.amountPoisha.toString() };
        case 'per_unit':
          return {
            gte_pct: tier.gtePct,
            per_unit_above_target_poisha: tier.perUnitPoisha.toString(),
          };
        case 'bps_of_excess':
          return { gte_pct: tier.gtePct, bps_of_excess: tier.bps };
      }
    }),
    ...(rule.capPoisha === null ? {} : { cap_poisha: rule.capPoisha.toString() }),
  };
}

export interface BonusEvaluation {
  readonly amountPoisha: Poisha;
  readonly pctBps: number;
  readonly tiers: readonly {
    readonly gtePct: number;
    readonly met: boolean;
    readonly amountPoisha: Poisha;
  }[];
  /** True when the cap took something off. */
  readonly capped: boolean;
}

/**
 * What a rule pays for one target's result.
 *
 * Pure, so the preview HR looks at, the figure a checker approves inside the payroll run
 * and the bonus that posts are one computation.
 */
export function evaluateBonus(
  rule: BonusRule,
  result: { readonly targetValue: bigint; readonly achieved: bigint },
): BonusEvaluation {
  const { targetValue, achieved } = result;
  if (targetValue <= 0n) invalid('A bonus is evaluated against a target greater than zero.');
  if (achieved < 0n) invalid('An achieved figure cannot be negative.');

  const excess = achieved > targetValue ? achieved - targetValue : 0n;

  const tiers = rule.tiers.map((tier) => {
    const met = achieved * 100n >= BigInt(tier.gtePct) * targetValue;
    if (!met) return { gtePct: tier.gtePct, met, amountPoisha: poisha(0) };
    switch (tier.kind) {
      case 'flat':
        return { gtePct: tier.gtePct, met, amountPoisha: tier.amountPoisha };
      case 'per_unit':
        return { gtePct: tier.gtePct, met, amountPoisha: poisha(tier.perUnitPoisha * excess) };
      case 'bps_of_excess':
        return { gtePct: tier.gtePct, met, amountPoisha: percentOf(poisha(excess), tier.bps) };
    }
  });

  const uncapped = tiers.reduce((total, tier) => total + tier.amountPoisha, 0n);
  const capped = rule.capPoisha !== null && uncapped > rule.capPoisha;
  const amountPoisha = poisha(capped && rule.capPoisha !== null ? rule.capPoisha : uncapped);

  return { amountPoisha, pctBps: pctBps(achieved, targetValue), tiers, capped };
}
