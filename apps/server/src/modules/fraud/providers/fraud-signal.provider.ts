/**
 * `FraudSignalProvider` (architecture §10, §21; D-010).
 *
 * The interface every courier fraud-check service is reached through. It is narrow
 * on purpose, and each of its three properties is a constraint on what an adapter is
 * allowed to be:
 *
 * 1. **It takes the E.164 number, and returns counts.** Not a score — scoring is a
 *    pure function in `@elysium/domain/fraud` that every provider feeds. A provider
 *    that returned its own 0–100 would put a third party in charge of whether we
 *    sell, and two providers would then disagree in a unit nothing can reconcile.
 * 2. **It returns `unavailable` rather than throwing.** A timeout, a 500, a
 *    throttle, a malformed body and a missing credential are all the same event to
 *    the order desk — "no provider answer, carry on with the internal score" (check
 *    3) — so the caller gets one branch instead of a try/catch that has to classify
 *    somebody else's failures.
 * 3. **`raw` is scalars only.** It lands in `fraud.provider_checks.raw`, which every
 *    org can read (§5 exception 1). An adapter that passed a provider's whole
 *    response through would put a customer's name or address in front of four brands
 *    the moment the provider added the field. So the adapter projects, and the
 *    projection is asserted by a test rather than promised in a comment.
 *
 * The number is passed in plaintext because a provider has to look it up; it is
 * hashed on the way into our own tables and never logged (invariant 10).
 */

/** What a provider found. Counts, and nothing that identifies anybody. */
export interface ProviderSignalCounts {
  /** Parcels this provider has records of. */
  readonly total: number;
  readonly delivered: number;
  readonly returnedOrCancelled: number;
  /**
   * The ratio the provider reports, when it reports one.
   *
   * Kept separate from the counts because some providers publish a ratio that is not
   * `delivered / total` — they exclude parcels still in flight — and recomputing it
   * would quietly contradict the figure on the provider's own dashboard, which is the
   * number a supervisor reads out on the phone.
   */
  readonly ratio: number | null;
  /**
   * The provider's answer reduced to scalars, for debugging a disagreement.
   *
   * Numbers, booleans and short enum-like strings only. Never a name, an address, an
   * order id or anything free-text — see the note above.
   */
  readonly raw: Readonly<Record<string, number | boolean | string>>;
}

export type ProviderResult =
  | { readonly status: 'ok'; readonly counts: ProviderSignalCounts }
  /**
   * The provider did not answer usefully.
   *
   * `reason` is a short code for the log and the badge, never the provider's own
   * error text: those routinely quote the request that caused them, and the request
   * contains a phone number (invariant 10).
   */
  | {
      readonly status: 'unavailable';
      readonly reason: 'timeout' | 'throttled' | 'unconfigured' | 'error' | 'unparsable';
    };

export interface FraudSignalProvider {
  /** Stable, lowercase, and the key half of `fraud.provider_checks`' primary key. */
  readonly name: string;
  /**
   * Whether this adapter has what it needs to be called at all.
   *
   * Separate from `lookup` returning `unconfigured` so the module can tell "no
   * provider is set up in this deployment" — in which case nothing is unavailable and
   * the badge says nothing about providers — from "a provider is set up and did not
   * answer", which the desk should see (check 3).
   */
  readonly configured: boolean;
  /** Look one number up. Never throws; see `ProviderResult`. */
  lookup(e164: string, options: { readonly timeoutMs: number }): Promise<ProviderResult>;
}

/** The DI token for the list of providers this deployment has. */
export const FRAUD_PROVIDERS = Symbol('FRAUD_PROVIDERS');

/**
 * A machine token: lowercase, no spaces, no punctuation but `_` and `-`, at most 32 long.
 *
 * This is the only string shape allowed into `provider_checks.raw`, and the rule was
 * tightened after a test found the obvious one was not enough. "Short enough to be a status
 * word" let `House 41, Road 7, Dhanmondi, Dhaka 1209` through — 39 characters, no long run
 * of digits, and a customer's address in a table every org reads.
 *
 * A token cannot be an address or a sentence, because both need spaces or commas, and it
 * cannot be a person's name, because a name is capitalised. What it *can* be is every
 * status word a provider in this market actually sends: `delivered`, `pending`,
 * `excellent_customer`, `low`. The cost of the rule is that a provider spelling its
 * statuses `Delivered` loses them from `raw` — and `raw` exists only for a human debugging
 * a disagreement, so the cost is a slightly thinner debug trail rather than a wrong answer.
 */
const TOKEN = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Reduce a provider payload to the scalars that may be stored.
 *
 * Shared by every adapter rather than trusted to each one, because the rule it enforces is
 * about the destination table and not about any particular provider: this value is read by
 * every org (§5 exception 1), so a provider that grew a `customer_name` field must not be
 * able to put one brand's buyer in front of the other four by adding it.
 *
 * Numbers, booleans and tokens. One level deep, so a nested object cannot smuggle a
 * document through, and no arrays.
 */
export function scalarsOnly(payload: unknown): Record<string, number | boolean | string> {
  const result: Record<string, number | boolean | string> = {};
  if (typeof payload !== 'object' || payload === null) return result;

  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (typeof value === 'boolean') result[key] = value;
    else if (typeof value === 'string' && TOKEN.test(value)) result[key] = value;
  }

  return result;
}
