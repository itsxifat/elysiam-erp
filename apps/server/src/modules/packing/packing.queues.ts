import type { QueueDefinition } from '../../platform/jobs/queues.js';

/**
 * The packing module's jobs (M38b, §20).
 *
 * - `packing.purge_videos`: daily at 04:15 Asia/Dhaka, every brand's packing videos whose
 *   order ended seven Dhaka days ago are deleted (D-612): the record kept, the file's row
 *   removed and audited in one transaction per video, the bytes removed afterwards by
 *   `files.remove_object`. Idempotent: a deleted video is not looked at again.
 */
export const PACKING_QUEUES = {
  purgeVideos: {
    name: 'packing.purge_videos',
    scope: 'global',
    cron: '15 4 * * *',
    retryLimit: 2,
    retryDelaySeconds: 600,
    expireInSeconds: 1800,
  },
} as const satisfies Record<string, QueueDefinition>;

export const PACKING_QUEUE_DEFINITIONS: readonly QueueDefinition[] = Object.values(PACKING_QUEUES);
