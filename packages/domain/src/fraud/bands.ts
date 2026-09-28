import type { FraudDecision } from '../orders/state.js';

/**
 * Score bands, and the decision each one produces (architecture §10, D-011).
 *
 * D-011's defaults are `≥70 allow, 40–69 warn, 20–39 require advance, <20 block`,
 * "configurable per org". So the bands are data, not constants in a `switch`: a
 * brand selling ৳400 kurtis and a brand selling ৳12,000 sarees do not want the
 * same tolerance, and the alternative to per-org rows is five forks of one
 * function.
 *
 * The rules are stored as three *floors* rather than four ranges. Four ranges can
 * overlap or leave a gap — a score of 55 matching both `warn` and
 * `require_advance`, or matching nothing — and either is a silent wrong answer at
 * the one moment the desk is asking whether to take somebody's money. Three
 * floors cannot: every score between 0 and 100 lands in exactly one band, and the
 * only thing that can be wrong is their order, which `assertBands` refuses up
 * front.
 */
export interface FraudBands {
  /** At or above this, `allow`. */
  readonly allowMin: number;
  /** At or above this and below `allowMin`, `warn`. */
  readonly warnMin: number;
  /** At or above this and below `warnMin`, `require_advance`. Below it, `block`. */
  readonly requireAdvanceMin: number;
}

/** D-011, as an org gets it with no row of its own. */
export const DEFAULT_FRAUD_BANDS: FraudBands = {
  allowMin: 70,
  warnMin: 40,
  requireAdvanceMin: 20,
};

export class FraudBandsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FraudBandsError';
  }
}

/**
 * Refuse bands that cannot produce four distinct answers.
 *
 * Called by the service before it writes an org's rules and again by
 * `decideForScore` before it reads them, because the row may predate a stricter
 * rule here and a corrupt row must fail loudly rather than quietly collapse
 * `block` into `require_advance`.
 *
 * Strictly decreasing, not merely non-increasing: `warnMin === allowMin` deletes
 * the `warn` band entirely, which reads in the admin screen as "warn is
 * configured" and behaves as "warn never happens".
 */
export function assertBands(bands: FraudBands): void {
  const values = [bands.allowMin, bands.warnMin, bands.requireAdvanceMin];
  for (const value of values) {
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      throw new FraudBandsError(`A band floor must be a whole number from 0 to 100, got ${value}.`);
    }
  }
  if (!(bands.allowMin > bands.warnMin && bands.warnMin > bands.requireAdvanceMin)) {
    throw new FraudBandsError(
      'Band floors must decrease strictly: allowMin > warnMin > requireAdvanceMin. ' +
        `Got ${bands.allowMin} / ${bands.warnMin} / ${bands.requireAdvanceMin}.`,
    );
  }
}

/** Which of §10's four decisions a score falls in. */
export function decideForScore(
  score: number,
  bands: FraudBands = DEFAULT_FRAUD_BANDS,
): FraudDecision {
  assertBands(bands);
  if (score >= bands.allowMin) return 'allow';
  if (score >= bands.warnMin) return 'warn';
  if (score >= bands.requireAdvanceMin) return 'require_advance';
  return 'block';
}
