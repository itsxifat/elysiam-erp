import type { QueueDefinition } from '../../platform/jobs/queues.js';

/**
 * The files module's jobs (§20, §22).
 *
 * - `files.remove_object` (M38b, D-612): delete the stored bytes of a file whose row a
 *   transaction already deleted (the packing video's retention). Enqueued in that transaction,
 *   so the bytes go only once the row's deletion has committed, and never inside it (an object
 *   store is outside the database, invariant 6's rule). Idempotent: an object already gone is
 *   success.
 */
export const FILES_QUEUES = {
  removeObject: {
    name: 'files.remove_object',
    scope: 'org',
    retryLimit: 5,
    retryDelaySeconds: 60,
    expireInSeconds: 300,
  },
} as const satisfies Record<string, QueueDefinition>;

export const FILES_QUEUE_DEFINITIONS: readonly QueueDefinition[] = Object.values(FILES_QUEUES);
