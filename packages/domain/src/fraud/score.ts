import type { FraudDecision } from '../orders/state.js';
import { assertBands, decideForScore, DEFAULT_FRAUD_BANDS, type FraudBands } from './bands.js';

/**
 * The trust score (architecture §10, invariant 11).
 *
 * A pure function of the signals in and nothing else: no clock, no database, no
 * provider call. That is what makes the number reproducible — the desk, the
 * confirm guard and a test all reach the same score from the same row — and it is
 * why `now` is an argument rather than a `new Date()` inside. A score that depends
 * on the wall clock cannot be asserted, and "the badge said 62 yesterday" cannot
 * be answered.
 *
 * ## Why the arithmetic is floating point
 *
 * Invariant 1 is about money, and there is no money here. A trust score is a
 * *presentation* of evidence whose only job is to fall in one of four bands, and
 * the bands are integers ten points wide. Poisha-style integer arithmetic would
 * buy nothing and would make the weighting unreadable. The function rounds once,
 * at the end, so the score it returns is an integer and the band it produces is
 * therefore stable.
 *
 * ## The shape of the model
 *
 * §10 lists five inputs: internal delivery ratio weighted by volume, provider
 * ratios, recent returns, manual flags, and first-order status. The model is
 * therefore two parts, and the split matters for explaining a number to a person:
 *
 * 1. **A blend towards evidence.** A phone nobody has seen sits at
 *    `NEUTRAL_SCORE`. As completed orders accumulate, the score slides from that
 *    neutral point towards the observed delivery ratio, at a weight that grows
 *    with volume. One delivered order out of one is not proof of anything and must
 *    not read as a perfect customer; ten out of ten nearly is.
 * 2. **Penalties for the things a ratio hides.** A ratio cannot express "the last
 *    return was on Tuesday" or "an agent flagged this number by hand", and both are
 *    stronger evidence than the ratio they barely move. They subtract, after the
 *    blend, so each one appears as its own line on the badge with its own number.
 *
 * A new customer therefore lands at exactly `allow`'s floor rather than in `warn`.
 * That is a deliberate business decision, not an accident of the constants: this is
 * a COD business in Bangladesh where most orders are from a number nobody has seen
 * before, and a model that warns on every new buyer trains the desk to ignore the
 * badge — which costs more than the fraud it was built to catch. It is recorded as
 * a decision row, so a later milestone that wants new numbers treated as suspect
 * changes it on purpose.
 */

/** Where a phone with no evidence at all sits. D-011's `allow` floor, exactly. */
export const NEUTRAL_SCORE = 70;

/**
 * How much of the blend each source can claim at infinite volume.
 *
 * Internal evidence outweighs a provider's, but not by much. Our own delivery
 * ratio is first-hand and about this brand; a provider's covers every courier in
 * the country and so sees a buyer we have only met twice. The pair sums to 1, so
 * the blend can never overshoot past the observed ratios.
 */
export const INTERNAL_WEIGHT = 0.55;
export const PROVIDER_WEIGHT = 0.45;

/**
 * The volume at which a source claims half its weight.
 *
 * `decided / (decided + K)`: at four completed orders a source is worth half of
 * what it will ever be worth, at ten it is worth 71%. K=4 is chosen against the
 * size of a real COD history — most buyers have one to five orders, so a K large
 * enough to be statistically comfortable would make the score useless for
 * everybody the desk actually meets.
 */
export const CONFIDENCE_K = 4;

/** A return or cancellation this recently is worth more than the ratio it moved. */
export const RECENT_INCIDENT_DAYS = 7;
export const RECENT_INCIDENT_PENALTY = 20;
export const STALE_INCIDENT_DAYS = 30;
export const STALE_INCIDENT_PENALTY = 10;

/** Half the completed orders came back, with enough volume to mean it. */
export const HIGH_RETURN_MIN_DECIDED = 3;
export const HIGH_RETURN_RATIO = 0.5;
export const INTERNAL_HIGH_RETURN_PENALTY = 15;
export const PROVIDER_HIGH_RETURN_MIN_TOTAL = 5;
export const PROVIDER_HIGH_RETURN_PENALTY = 20;

/**
 * A manual flag, and why the first one is so heavy.
 *
 * Somebody who works here looked at this number and wrote down why. That is the
 * strongest signal in the model and the only one a ratio can never produce, so one
 * flag alone must be able to reach `block` from a neutral start — 70 − 55 = 15,
 * below D-011's `block` ceiling of 20. Anything softer makes the flag a note
 * nobody acts on, and the escape hatch for a flag that was wrong is an org_admin
 * override with a reason, which is audited (check 5).
 */
export const FIRST_MANUAL_FLAG_PENALTY = 55;

/**
 * An address that keeps refusing parcels from other numbers (M17, D-231).
 *
 * Worth less than a manual flag and as much as a recent incident. The signal is about a
 * door, not a person: a new tenant moves into a flat that a fraudster used. The penalty
 * moves a neutral newcomer from 70 to 50, so they are warned rather than blocked. A
 * brand that wants an advance from such an address says so with a rule.
 */
export const REPEAT_RETURN_ADDRESS_PENALTY = 20;
export const FURTHER_MANUAL_FLAG_PENALTY = 25;
export const MANUAL_FLAG_PENALTY_CAP = 80;

/**
 * Why a score is what it is, as a code plus its numbers.
 *
 * Codes, never sentences. The badge is rendered in Bangla and English (D-036), the
 * reasons are stored on the order and read back months later, and a sentence
 * written here would be an English string in a Bangla UI and a translation that
 * silently changes meaning when somebody rewords it. `values` carries the figures
 * the message interpolates, so `fraud.reason.internalRatio` can read "8 of 10
 * delivered" in either language from one row.
 */
export const TRUST_REASON_CODES = [
  /** Nothing is known about this number, here or at any provider. */
  'no_history',
  /** We have never sold to this number, but a provider has seen it. */
  'no_internal_history',
  /** Our own delivered-to-completed ratio, and the volume behind it. */
  'internal_ratio',
  /** A provider's delivered-to-completed ratio, and the volume behind it. */
  'provider_ratio',
  /** At least half of our completed orders came back. */
  'internal_high_return_ratio',
  /** At least half of a provider's completed orders came back. */
  'provider_high_return_ratio',
  /** A return or cancellation inside the last week. */
  'recent_incident',
  /** A return or cancellation inside the last month. */
  'incident_this_month',
  /** Somebody here flagged this number by hand. */
  'manual_flag',
  /**
   * Parcels to a similar address, from other numbers, kept coming back (M17, D-231).
   * Only on an order's assessment: a bare phone lookup has no address.
   */
  'repeat_return_address',
  /**
   * No provider answered: timed out, throttled, unconfigured or switched off.
   *
   * Worth **zero** points, deliberately (check 3). A provider being down is a fact
   * about us, not about the buyer, and penalising it would turn our outage into
   * the customer's problem — every order in the country blocked because a third
   * party is slow. It appears as a reason so the desk can see the score is
   * internal-only, and `providerAvailable` says the same thing in a field a UI can
   * branch on.
   */
  'provider_unavailable',
] as const;

export type TrustReasonCode = (typeof TRUST_REASON_CODES)[number];

export interface TrustReason {
  readonly code: TrustReasonCode;
  /** What this reason did to the score, rounded. Zero for a purely informational one. */
  readonly delta: number;
  /** Figures the message interpolates. Never a phone number, a name or an id. */
  readonly values?: Readonly<Record<string, number>>;
}

/** Our own counts for this phone, across every brand (the cross-org row). */
export interface InternalSignals {
  readonly ordersTotal: number;
  readonly delivered: number;
  readonly returned: number;
  readonly cancelled: number;
  /** The most recent return or cancellation, anywhere. Null if there has never been one. */
  readonly lastIncidentAt: Date | null;
  /** How many hand-written flags stand against this number. */
  readonly manualFlagCount: number;
}

/** One provider's cached answer. Counts only — see `fraud.provider_checks`. */
export interface ProviderSignals {
  readonly provider: string;
  readonly total: number;
  readonly delivered: number;
  readonly returnedOrCancelled: number;
}

export interface TrustScoreInput {
  readonly internal: InternalSignals;
  /** Every provider that answered. Empty is normal and is not a penalty. */
  readonly providers: readonly ProviderSignals[];
  /**
   * Whether every configured provider answered.
   *
   * Separate from `providers` being empty because the two mean different things: no
   * provider is *configured* (nothing to report) versus one is configured and did
   * not answer (say so on the badge). The caller knows which; this function cannot.
   */
  readonly providerAvailable: boolean;
  readonly bands?: FraudBands;
  /** The instant the score is being computed for. Explicit, so the score is reproducible. */
  readonly now: Date;
  /**
   * The order's address signal (M17, D-231), when there is an order to ask about.
   *
   * `returns` counts earlier returns from *other* numbers to a matching address in this
   * brand. `minReturns` is the brand's threshold. Absent for a phone lookup with no
   * address, which scores exactly as M13 did.
   */
  readonly address?: { readonly returns: number; readonly minReturns: number } | null;
}

export interface TrustAssessment {
  /** 0–100, integer. */
  readonly score: number;
  readonly decision: FraudDecision;
  readonly reasons: readonly TrustReason[];
  /** False when a configured provider did not answer (check 3). */
  readonly providerAvailable: boolean;
}

const DAY_MS = 86_400_000;

/** `delivered / (delivered + returned + cancelled)`, and the volume behind it. */
function ratioOf(delivered: number, returned: number, cancelled: number) {
  const decided = delivered + returned + cancelled;
  return { decided, ratio: decided === 0 ? 0 : delivered / decided };
}

/** `decided / (decided + K)` — how much a source of this volume is worth. */
function confidence(decided: number): number {
  return decided / (decided + CONFIDENCE_K);
}

function nonNegativeInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`trustScore(): ${field} must be a whole number ≥ 0, got ${value}.`);
  }
  return value;
}

/**
 * Score one phone's signals, 0–100, with the reasons that got it there.
 *
 * The inputs are validated rather than trusted. These counters come off a table
 * every org writes to, and a negative `delivered` would produce a ratio above 1
 * and a score above 100 — which lands in `allow` and looks like a healthy
 * customer. Failing on the row is the only safe direction.
 */
export function trustScore(input: TrustScoreInput): TrustAssessment {
  const bands = input.bands ?? DEFAULT_FRAUD_BANDS;
  assertBands(bands);

  const internal = input.internal;
  nonNegativeInt(internal.ordersTotal, 'internal.ordersTotal');
  nonNegativeInt(internal.delivered, 'internal.delivered');
  nonNegativeInt(internal.returned, 'internal.returned');
  nonNegativeInt(internal.cancelled, 'internal.cancelled');
  nonNegativeInt(internal.manualFlagCount, 'internal.manualFlagCount');

  const reasons: TrustReason[] = [];

  // Part one: blend from neutral towards whatever evidence exists.
  const own = ratioOf(internal.delivered, internal.returned, internal.cancelled);
  const internalWeight = confidence(own.decided) * INTERNAL_WEIGHT;

  /*
   * Several providers are summed rather than averaged. Each one reports the same
   * kind of fact — parcels this number took and parcels it sent back — so two
   * providers are two samples of one population, and averaging their ratios would
   * give a provider with three records the same say as one with three hundred.
   */
  let providerDelivered = 0;
  let providerReturned = 0;
  let providerTotal = 0;
  for (const provider of input.providers) {
    nonNegativeInt(provider.total, `providers[${provider.provider}].total`);
    nonNegativeInt(provider.delivered, `providers[${provider.provider}].delivered`);
    nonNegativeInt(
      provider.returnedOrCancelled,
      `providers[${provider.provider}].returnedOrCancelled`,
    );
    providerDelivered += provider.delivered;
    providerReturned += provider.returnedOrCancelled;
    providerTotal += provider.total;
  }
  const theirs = ratioOf(providerDelivered, providerReturned, 0);
  const providerWeight = confidence(theirs.decided) * PROVIDER_WEIGHT;

  const evidenceWeight = internalWeight + providerWeight;
  const blended =
    NEUTRAL_SCORE * (1 - evidenceWeight) +
    own.ratio * 100 * internalWeight +
    theirs.ratio * 100 * providerWeight;

  if (own.decided > 0) {
    reasons.push({
      code: 'internal_ratio',
      delta: Math.round(own.ratio * 100 * internalWeight - NEUTRAL_SCORE * internalWeight),
      values: {
        delivered: internal.delivered,
        completed: own.decided,
        orders: internal.ordersTotal,
      },
    });
  }

  if (theirs.decided > 0) {
    reasons.push({
      code: 'provider_ratio',
      delta: Math.round(theirs.ratio * 100 * providerWeight - NEUTRAL_SCORE * providerWeight),
      values: {
        delivered: providerDelivered,
        completed: theirs.decided,
        total: providerTotal,
        providers: input.providers.length,
      },
    });
    if (own.decided === 0) reasons.push({ code: 'no_internal_history', delta: 0 });
  }

  if (own.decided === 0 && theirs.decided === 0 && internal.manualFlagCount === 0) {
    reasons.push({ code: 'no_history', delta: 0 });
  }

  // Part two: the penalties a ratio cannot express.
  let penalty = 0;

  if (own.decided >= HIGH_RETURN_MIN_DECIDED && 1 - own.ratio >= HIGH_RETURN_RATIO) {
    penalty += INTERNAL_HIGH_RETURN_PENALTY;
    reasons.push({
      code: 'internal_high_return_ratio',
      delta: -INTERNAL_HIGH_RETURN_PENALTY,
      values: { returned: internal.returned + internal.cancelled, completed: own.decided },
    });
  }

  if (theirs.decided >= PROVIDER_HIGH_RETURN_MIN_TOTAL && 1 - theirs.ratio >= HIGH_RETURN_RATIO) {
    penalty += PROVIDER_HIGH_RETURN_PENALTY;
    reasons.push({
      code: 'provider_high_return_ratio',
      delta: -PROVIDER_HIGH_RETURN_PENALTY,
      values: { returned: providerReturned, completed: theirs.decided },
    });
  }

  if (internal.lastIncidentAt !== null) {
    // Floored, so "23 hours ago" is nought days rather than one: the boundary
    // belongs to the more recent bucket, because that is the side a wrong answer
    // is safe on.
    const days = Math.floor((input.now.getTime() - internal.lastIncidentAt.getTime()) / DAY_MS);
    if (days <= RECENT_INCIDENT_DAYS) {
      penalty += RECENT_INCIDENT_PENALTY;
      reasons.push({
        code: 'recent_incident',
        delta: -RECENT_INCIDENT_PENALTY,
        values: { days: Math.max(0, days) },
      });
    } else if (days <= STALE_INCIDENT_DAYS) {
      penalty += STALE_INCIDENT_PENALTY;
      reasons.push({
        code: 'incident_this_month',
        delta: -STALE_INCIDENT_PENALTY,
        values: { days },
      });
    }
  }

  if (internal.manualFlagCount > 0) {
    const raw =
      FIRST_MANUAL_FLAG_PENALTY + (internal.manualFlagCount - 1) * FURTHER_MANUAL_FLAG_PENALTY;
    const flagPenalty = Math.min(raw, MANUAL_FLAG_PENALTY_CAP);
    penalty += flagPenalty;
    reasons.push({
      code: 'manual_flag',
      delta: -flagPenalty,
      values: { flags: internal.manualFlagCount },
    });
  }

  if (input.address !== undefined && input.address !== null) {
    nonNegativeInt(input.address.returns, 'address.returns');
    if (!Number.isInteger(input.address.minReturns) || input.address.minReturns < 1) {
      throw new TypeError(
        `trustScore(): address.minReturns must be a whole number ≥ 1, got ${input.address.minReturns}.`,
      );
    }
    if (input.address.returns >= input.address.minReturns) {
      penalty += REPEAT_RETURN_ADDRESS_PENALTY;
      reasons.push({
        code: 'repeat_return_address',
        delta: -REPEAT_RETURN_ADDRESS_PENALTY,
        values: { returns: input.address.returns },
      });
    }
  }

  if (!input.providerAvailable) reasons.push({ code: 'provider_unavailable', delta: 0 });

  const score = Math.min(100, Math.max(0, Math.round(blended - penalty)));

  return {
    score,
    decision: decideForScore(score, bands),
    reasons,
    providerAvailable: input.providerAvailable,
  };
}
