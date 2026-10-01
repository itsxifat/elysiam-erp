import { Inject, Injectable } from '@nestjs/common';
import { withGlobal, withOrg } from '@elysium/db';
import { businessDate } from '@elysium/domain';
import {
  isParcelStatus,
  lastFourMatches,
  parseTrackingQuery,
  trackingLadder,
  trackingStage,
  type TrackingStage,
  type TrackingStepView,
} from '@elysium/domain/courier';

import type { RateLimitStore } from '../../platform/http/rate-limit.js';
import * as repo from './courier.repository.js';
import { ORDERS_PORT, type OrdersPort } from './ports/orders.port.js';

/**
 * The public tracking page's server side (M15: "order number plus the last 4 digits of the
 * phone").
 *
 * The only route in the ERP a stranger reaches without signing in that reads tenant data,
 * so it is written around what it must not say.
 *
 * ## One negative answer
 *
 * `TRACKING_NOT_FOUND` is a single frozen object, and every way of not answering returns it:
 * an unknown brand, a malformed order number, an order that does not exist, an order not yet
 * with a courier, and wrong digits. Same status, same bytes. A page that said "wrong digits"
 * where it could have said "no such order" would be an oracle for which order numbers are
 * real — and order numbers are sequential, so from one real number the rest are guesses away.
 *
 * ## The same work either way
 *
 * The answer being identical is not enough if the *time* it takes is not. A real order costs
 * two more queries than a missing one, so a missing one runs the same two queries against a
 * sentinel id that matches nothing, and the digit comparison runs over the same number of
 * candidates whatever was found (`lastFourMatches` compares every character of every one).
 * This narrows the timing difference to noise rather than proving it zero — network jitter
 * dwarfs it, and the rate limit caps how many samples anybody gets.
 *
 * ## Rate limited, on two buckets
 *
 * Per address, generous, because Bangladeshi mobile traffic shares carrier NAT; and per
 * (brand, order number), tight, because that is the bucket an enumeration of one order's four
 * digits has to spend — five tries in fifteen minutes makes ten thousand candidates a month's
 * work for one order. Both are counted before either is judged, as `checkRateLimit` does, so
 * one cannot be kept cold behind the other. The cost is that somebody can lock one order's
 * tracking for fifteen minutes by guessing at it; the order's owner still has the SMS and the
 * courier's own page.
 */

export const TRACKING_RATE_LIMITER = Symbol('TrackingRateLimiter');

let sharedStore: RateLimitStore | undefined;

/**
 * Give the tracking route the API's shared counters (the Valkey store `main.api.ts` already
 * builds for the credential endpoints), before the application is created.
 *
 * A module-level hand-off rather than a provider override, because the store is built by the
 * entrypoint, outside Nest, and `CourierModule` is imported by both the API and the worker.
 * Without it the limit is per API replica, in memory — still a limit, just one that multiplies
 * by the replica count (the INTEGRATION notes carry the one line that calls this).
 */
export function useTrackingRateLimitStore(store: RateLimitStore): void {
  sharedStore = store;
}

/** The store the provider hands out: the shared one when set, else a per-process one. */
export function trackingRateLimitStore(fallback: () => RateLimitStore): RateLimitStore {
  return sharedStore ?? fallback();
}

/** The answer for everything that is not a match. Frozen, so no path can decorate it. */
export const TRACKING_NOT_FOUND = Object.freeze({ found: false as const });

export const TRACKING_LIMITS = {
  perIp: { limit: 20, windowSeconds: 600 },
  perOrder: { limit: 5, windowSeconds: 900 },
} as const;

/**
 * A uuid that is valid for `withOrg` and matches no row, so a miss costs what a hit costs.
 * Version 4 and variant 8 so the uuid check `withOrg` applies accepts it.
 */
const NO_SUCH_ID = '00000000-0000-4000-8000-000000000000';

export interface TrackingFound {
  readonly found: true;
  readonly orderNo: string;
  readonly stage: TrackingStage;
  readonly steps: readonly TrackingStepView[];
  /** The courier and the code a customer types into its site, once the parcel is with one. */
  readonly courier: { readonly name: string; readonly trackingCode: string | null } | null;
  /** Asia/Dhaka date of the courier's latest word, when there is one. */
  readonly lastUpdateOn: string | null;
  /** What the rider will ask for at the door. Decimal string, integer poisha (invariant 1). */
  readonly codAmountPoisha: string;
}

export type TrackingAnswer = TrackingFound | typeof TRACKING_NOT_FOUND;

@Injectable()
export class TrackingService {
  constructor(
    @Inject(ORDERS_PORT) private readonly orders: OrdersPort,
    @Inject(TRACKING_RATE_LIMITER) private readonly limiter: RateLimitStore,
  ) {}

  async track(input: {
    readonly brand: string;
    readonly orderNo: string;
    readonly phoneLast4: string;
    readonly ip: string;
  }): Promise<
    { limited: true; retryAfterSeconds: number } | { limited: false; answer: TrackingAnswer }
  > {
    const query = parseTrackingQuery({ orderNo: input.orderNo, phoneLast4: input.phoneLast4 });
    const brand = input.brand.trim().toLowerCase().slice(0, 80);
    const orderKey = query?.orderNo ?? input.orderNo.trim().toUpperCase().slice(0, 40);

    const [ipDecision, orderDecision] = await Promise.all([
      this.limiter.hit(
        `track:ip:${input.ip}`,
        TRACKING_LIMITS.perIp.limit,
        TRACKING_LIMITS.perIp.windowSeconds,
      ),
      this.limiter.hit(
        `track:order:${brand}:${orderKey}`,
        TRACKING_LIMITS.perOrder.limit,
        TRACKING_LIMITS.perOrder.windowSeconds,
      ),
    ]);
    if (!ipDecision.allowed || !orderDecision.allowed) {
      return {
        limited: true,
        retryAfterSeconds: Math.max(
          ipDecision.retryAfterSeconds ?? 0,
          orderDecision.retryAfterSeconds ?? 0,
          1,
        ),
      };
    }

    const orgId = await withGlobal((tx) => repo.organizationBySlug(tx, brand));

    // The same queries on every path; a miss runs them against an id that matches nothing.
    const outcome = await withOrg(
      { orgId: orgId ?? NO_SUCH_ID, userId: 'system:tracking' },
      async (tx) => {
        const parcel =
          orgId === undefined || query === null
            ? undefined
            : await repo.trackingByReference(tx, orgId, query.orderNo);
        const orderId = parcel?.order_id ?? NO_SUCH_ID;
        const scopeOrg = orgId ?? NO_SUCH_ID;
        const facts = await this.orders.summary(tx, scopeOrg, orderId);
        const snapshot = await this.orders.bookingSnapshot(tx, scopeOrg, orderId);
        // The courier's name from M10, which owns the row (invariant 12). Always one
        // lookup, with a known-absent id when there is no parcel: every other read on
        // this path is shaped to do the same work whether or not the order exists, and
        // a lookup that were skipped would time the difference out loud.
        const [party] = await this.orders.courierParties(tx, scopeOrg, [
          parcel?.courier_id ?? NO_SUCH_ID,
        ]);
        return { parcel, facts, snapshot, courierName: party?.name ?? '' };
      },
    );

    const digits = query?.phoneLast4 ?? '####';
    const matches = lastFourMatches(digits, [
      outcome.facts?.customerPhoneE164 ?? null,
      outcome.snapshot?.recipientPhoneE164 ?? null,
    ]);

    if (
      !matches ||
      query === null ||
      outcome.parcel === undefined ||
      // The order number on the order must be the one asked about: `reference` is our copy,
      // and a parcel rebooked under a renumbered order must not answer for the old number.
      outcome.facts?.orderNo !== query.orderNo
    ) {
      return { limited: false, answer: TRACKING_NOT_FOUND };
    }

    const parcelStatus = isParcelStatus(outcome.parcel.status) ? outcome.parcel.status : null;
    const stage = trackingStage(outcome.facts.status, parcelStatus);
    const shipped = stage !== 'received' && stage !== 'processing' && stage !== 'cancelled';
    return {
      limited: false,
      answer: {
        found: true,
        orderNo: outcome.facts.orderNo,
        stage,
        steps: trackingLadder(stage),
        courier: shipped
          ? { name: outcome.courierName, trackingCode: outcome.parcel.tracking_code }
          : null,
        lastUpdateOn:
          outcome.parcel.last_status_at === null
            ? null
            : businessDate(new Date(outcome.parcel.last_status_at)),
        codAmountPoisha: outcome.facts.codAmountPoisha,
      },
    };
  }
}
