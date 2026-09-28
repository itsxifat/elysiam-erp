import { Inject, Injectable } from '@nestjs/common';

import { FRAUD_CONFIG, type FraudConfig } from '../fraud.config.js';
import {
  scalarsOnly,
  type FraudSignalProvider,
  type ProviderResult,
} from './fraud-signal.provider.js';

/**
 * The Steadfast fraud-check adapter — **UNVERIFIED** (D-010, and a new decision row).
 *
 * ## Read this before trusting anything below
 *
 * CLAUDE.md says: build integrations only against official docs and real credentials,
 * never invent endpoints or fields. This adapter is built against **neither**, and
 * that is not an oversight — it is the honest state of D-010:
 *
 * * D-010 is still OPEN. It says the first provider wraps the user's `fraudjs`
 *   package "if they provide it". They have not: there is no `fraudjs` in the lockfile,
 *   in `node_modules`, or anywhere in the repository, and G2 in START-HERE.md lists
 *   the package and its courier credentials as a gate this milestone is waiting on.
 * * Steadfast's own documentation page (`steadfast.com.bd/user/api/documentation`)
 *   answers 404 to an unauthenticated fetch, so the endpoint could not be read. What is
 *   findable describes parcel creation, delivery status and balance; a phone fraud-check
 *   endpoint is not among them, and the one search result claiming otherwise is a third
 *   party's summary of an uploaded PDF, which is not a source an adapter may be built
 *   from.
 * * The widely used courier "fraud check" services in Bangladesh are aggregators rather
 *   than the couriers themselves. One of them, `fraudbd.com`, does publish a spec —
 *   `POST /api/check-courier-info`, an `api_key` header, and a body carrying
 *   `data.totalSummary { total, success, cancel, successRate, cancelRate }`. Those field
 *   names are in the lists below, so a verified adapter is a small step rather than a
 *   rewrite — but it is a different vendor from the one D-010 names and nobody has an
 *   account with it. A candidate, not an implementation.
 *
 * So there was a choice between inventing a URL and a JSON schema that look right, or
 * shipping the interface with an adapter that **cannot be enabled without somebody
 * supplying both**. This is the second. There is no default URL, no default key, and
 * `configured` is false until `FRAUD_STEADFAST_URL` and `FRAUD_STEADFAST_API_KEY` are
 * set — so on every deployment that exists today the module runs internal-only and the
 * badge says "provider unavailable", which is a state the desk already handles (check
 * 3) rather than a broken integration.
 *
 * ## What it assumes when it *is* switched on
 *
 * Exactly one thing, and it is deliberately shallow: an HTTP GET or POST to a
 * configured URL that answers with a JSON object of counters. The field names are read
 * from a small list of plausible spellings rather than one guess, and if none of them
 * is present the result is `unparsable` — not zero, which would read as "this buyer
 * has a clean record" and is the worst possible failure for a fraud check.
 *
 * When the real docs arrive this file is where they land: replace `parse()` and the
 * request shape, delete this comment, and write the contract test against recorded
 * fixtures the way M12's courier adapter does. Until then it is marked unverified in
 * decisions.md and nothing in the acceptance checks depends on it answering.
 */
@Injectable()
export class SteadfastFraudProvider implements FraudSignalProvider {
  readonly name = 'steadfast';

  constructor(@Inject(FRAUD_CONFIG) private readonly config: FraudConfig) {}

  get configured(): boolean {
    return (
      this.config.FRAUD_STEADFAST_URL !== undefined &&
      this.config.FRAUD_STEADFAST_API_KEY !== undefined
    );
  }

  async lookup(e164: string, options: { readonly timeoutMs: number }): Promise<ProviderResult> {
    const url = this.config.FRAUD_STEADFAST_URL;
    const apiKey = this.config.FRAUD_STEADFAST_API_KEY;
    if (url === undefined || apiKey === undefined) {
      return { status: 'unavailable', reason: 'unconfigured' };
    }

    /*
     * `AbortSignal.timeout` rather than a `Promise.race`: a race leaves the request
     * running, so a provider having a slow afternoon accumulates sockets in this
     * process until it falls over — the outage we were avoiding, arriving by a
     * different door. Aborting actually cancels it.
     */
    const controller = AbortSignal.timeout(options.timeoutMs);

    // The national form, because every courier API in §9's list wants the eleven
    // digits rather than E.164 (the same reason `normalizeBdPhone` exists).
    const national = `0${e164.slice(4)}`;

    let response: Response;
    try {
      response = await fetch(`${url.replace(/\/$/, '')}?phone=${encodeURIComponent(national)}`, {
        method: 'GET',
        signal: controller,
        headers: {
          'Api-Key': apiKey,
          ...(this.config.FRAUD_STEADFAST_SECRET_KEY === undefined
            ? {}
            : { 'Secret-Key': this.config.FRAUD_STEADFAST_SECRET_KEY }),
          accept: 'application/json',
        },
      });
    } catch (error) {
      /*
       * Classified, never logged. A fetch error's message quotes the URL it was
       * given, and this URL carries the customer's phone number in its query string
       * (invariant 10). The caller records the code.
       */
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return { status: 'unavailable', reason: timedOut ? 'timeout' : 'error' };
    }

    if (response.status === 429) return { status: 'unavailable', reason: 'throttled' };
    if (!response.ok) return { status: 'unavailable', reason: 'error' };

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { status: 'unavailable', reason: 'unparsable' };
    }

    return parse(body);
  }
}

/**
 * Field names, in the order they are tried.
 *
 * Several spellings rather than one because the shape is unverified, and a single
 * guess that turns out wrong fails as `unparsable` — which is correct but useless.
 * Trying the handful of names these services actually use gives the adapter a chance
 * of working on the day credentials appear, without pretending any one of them is
 * documented.
 */
const TOTAL_KEYS = ['total_parcel', 'total_order', 'total_orders', 'total'] as const;
const DELIVERED_KEYS = ['total_delivered', 'delivered', 'success_parcel', 'success'] as const;
const RETURNED_KEYS = [
  'total_cancelled',
  'cancelled',
  'returned',
  'cancel_parcel',
  'cancel',
] as const;
const RATIO_KEYS = ['success_ratio', 'success_rate', 'successRate', 'ratio'] as const;

/** A plain object, or `null` — so a caller can tell "not there" from "there and empty". */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pick(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
    // Providers in this market commonly send integers as strings.
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  }
  return undefined;
}

/**
 * Turn a response body into counts, or say it could not be read.
 *
 * Exported for the adapter's test, which is the only thing that can exercise it
 * without a live endpoint.
 *
 * Absent counters are `unparsable`, never zero. Zero reads as "this buyer has a clean
 * record", which would turn a provider changing its field names into every flagged
 * number quietly passing the check — the worst possible direction for a fraud signal
 * to fail in.
 */
export function parse(body: unknown): ProviderResult {
  /*
   * Unwrap `data`, then `totalSummary`, and no further.
   *
   * Two named levels rather than a recursive search: the aggregator spec found above nests
   * its counters at `data.totalSummary`, and beside them at `data.Summaries` it carries a
   * per-courier breakdown with its own `total`. A recursive hunt for the first `total` it
   * could find would happily pick one courier's figure and present it as the whole
   * market's — a wrong answer that looks right, which is worse than no answer.
   */
  const outer = asRecord(body) ?? {};
  const level = asRecord(outer.data) ?? outer;
  const inner = asRecord(level.totalSummary) ?? level;

  const total = pick(inner, TOTAL_KEYS);
  const delivered = pick(inner, DELIVERED_KEYS);
  const returnedOrCancelled = pick(inner, RETURNED_KEYS);

  if (total === undefined || delivered === undefined || returnedOrCancelled === undefined) {
    return { status: 'unavailable', reason: 'unparsable' };
  }

  let ratio: number | null = null;
  for (const key of RATIO_KEYS) {
    ratio = normaliseRatio(inner[key]);
    if (ratio !== null) break;
  }

  return {
    status: 'ok',
    counts: {
      total,
      delivered,
      returnedOrCancelled,
      ratio,
      // Projected to scalars before it can reach `provider_checks.raw`, which every
      // org reads. Doing it here rather than at the call site means an adapter cannot
      // forget.
      raw: scalarsOnly(inner),
    },
  };
}

/**
 * A ratio as a fraction of one.
 *
 * These services report success as a percentage about as often as a fraction, and
 * `0.85` and `85` are both plausible readings of "85%". Anything above 1 is treated as
 * a percentage; anything outside 0–100 is discarded rather than clamped, because a
 * value that far out means the field was not the ratio at all.
 */
function normaliseRatio(value: unknown): number | null {
  /*
   * `Number(...)` rather than `parseFloat`, and the repository's `no-float-money` lint rule
   * is right to ask: a float is never money here. A delivery ratio is a proportion between
   * 0 and 1 that feeds a 0–100 presentational score, and rounding it to poisha would be
   * meaningless. `Number` also refuses a partially numeric string outright, where
   * `parseFloat('0.9abc')` would happily return 0.9 — and a field that is only partly a
   * number is a field that is not the ratio.
   */
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) return null;
  return numeric > 1 ? numeric / 100 : numeric;
}
