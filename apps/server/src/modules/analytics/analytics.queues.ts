import { addDays, businessDate } from '@elysium/domain';

import type { QueueDefinition } from '../../platform/jobs/queues.js';

/**
 * The analytics jobs (M24; architecture §18, §20). Crons are read in Asia/Dhaka time.
 *
 * One kind of work, recomputing an org's days, reached three ways (D-320):
 *
 * - **On events.** The worker's outbox subscriber hears `order.created` and
 *   `order.status_changed` and enqueues the event's Dhaka day, keyed by org and ten-second
 *   bucket and started after the bucket closes — the shape D-279 gave target progress, so
 *   a burst of orders is one recompute that starts after the burst's last commit.
 * - **Nightly.** `analytics.schedule_rollup` at 03:00 enqueues the last seven days for
 *   every active brand: late courier statuses, spend typed in for last week and campaign
 *   mappings changed since (D-250) all land here.
 * - **On request.** `POST /v1/analytics/rollups/refresh` recomputes a range inline, for a
 *   backfill after go-live.
 *
 * Every recompute deletes the org's days and inserts them again in one transaction, so a
 * retry, a duplicate and a rerun all leave the same rows.
 */
export const ANALYTICS_QUEUES = {
  rollup: 'analytics.rollup',
  schedule: 'analytics.schedule_rollup',
} as const;

export const ANALYTICS_QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    name: ANALYTICS_QUEUES.schedule,
    scope: 'global',
    // 03:00, after the CRM's 02:30 and the stock reconciliation's 02:00, before anyone
    // opens a dashboard.
    cron: '0 3 * * *',
    retryLimit: 2,
    retryDelaySeconds: 300,
    expireInSeconds: 300,
  },
  {
    name: ANALYTICS_QUEUES.rollup,
    scope: 'org',
    // `rollup:<org>:<bucket>` or `nightly:<org>:<date>`: the key is what collapses a burst
    // (D-207), and a rerun after it finished is harmless anyway.
    policy: 'exclusive',
    retryLimit: 3,
    retryDelaySeconds: 60,
    expireInSeconds: 900,
  },
];

/** How long a burst of order events is collected into one recompute (as D-279). */
export const ROLLUP_BUCKET_MS = 10_000;

/** The nightly recompute's reach: today and the six days before it. */
export const NIGHTLY_DAYS = 7;

export function rollupBucket(
  orgId: string,
  now: Date,
): { readonly singletonKey: string; readonly startAfter: Date } {
  const bucket = Math.floor(now.getTime() / ROLLUP_BUCKET_MS);
  return {
    singletonKey: `rollup:${orgId}:${String(bucket)}`,
    startAfter: new Date((bucket + 1) * ROLLUP_BUCKET_MS + 1_000),
  };
}

/** The most days one recompute covers: a quarter, as M18's dashboard caps a range. */
export const MAX_ROLLUP_DAYS = 92;

/**
 * The Dhaka days an order event's recompute covers: from the day it happened through today.
 * One day almost always; two when an event from just before midnight is dispatched just
 * after it. Never wider than one recompute may be: after a long outage the backlog's oldest
 * days are the nightly run's and a refresh's, not a job `recomputeIn` would refuse.
 */
export function eventRecomputeRange(
  occurredAt: Date,
  now: Date,
): { readonly from: string; readonly to: string } {
  const today = businessDate(now);
  const happened = businessDate(occurredAt);
  const earliest = addDays(today, -(MAX_ROLLUP_DAYS - 1));
  const from = happened < earliest ? earliest : happened < today ? happened : today;
  return { from, to: today };
}
