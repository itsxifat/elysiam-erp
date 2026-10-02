import type { QueueDefinition } from '../../platform/jobs/queues.js';

/**
 * M20's one job: recompute a brand's target progress after its orders moved (D-279).
 *
 * Enqueued by the worker's outbox subscriber for every status change that can move a
 * target, keyed by org and ten-second bucket and started after the bucket closes. So a
 * burst of confirmations is one recompute, and the recompute starts only once every event
 * of its bucket has committed — the last change of a burst is never the one left out.
 * `exclusive`, because the key is what collapses the burst (D-207).
 */
export const HR_QUEUES = {
  refreshProgress: 'hr.refresh_target_progress',
} as const;

export const HR_QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    name: HR_QUEUES.refreshProgress,
    scope: 'org',
    policy: 'exclusive',
    // Recomputes from the orders and overwrites, so a retry is harmless.
    retryLimit: 3,
    retryDelaySeconds: 30,
    expireInSeconds: 300,
  },
];

/** Ten seconds: how long a burst of order events is collected into one recompute. */
export const PROGRESS_BUCKET_MS = 10_000;

/** The bucket an instant falls in, its key, and when its recompute may start. */
export function progressBucket(
  orgId: string,
  now: Date,
): { readonly singletonKey: string; readonly startAfter: Date } {
  const bucket = Math.floor(now.getTime() / PROGRESS_BUCKET_MS);
  return {
    singletonKey: `progress:${orgId}:${String(bucket)}`,
    startAfter: new Date((bucket + 1) * PROGRESS_BUCKET_MS + 1_000),
  };
}
