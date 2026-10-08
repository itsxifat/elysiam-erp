import type { QueueDefinition } from '../../platform/jobs/queues.js';

/**
 * The packing module's jobs (M38b, §20).
 *
 * - `packing.purge_videos`: daily at 04:15 Asia/Dhaka, every brand's packing videos whose
 *   order ended seven Dhaka days ago are deleted (D-612): the record kept, the file's row
 *   removed and audited in one transaction per video, the bytes removed afterwards by
 *   `files.remove_object`. Idempotent: a deleted video is not looked at again. The same run
 *   forgets every `packing-video` upload a day old that no part refers to (an attach that
 *   never arrived, a retry's second copy), audited, its bytes removed the same way. One
 *   video or brand failing is logged and the rest are still done; the run then fails.
 * - `packing.camera_cut` (M38c, D-672): one packing's IP camera recording, cut from the
 *   camera's buffer once its window closed (the order packed, or fifteen minutes up). Enqueued
 *   in the transaction that closes the window; worked by the **camera process**
 *   (`main.camera.ts`), which owns the buffer, never by the worker. Idempotent: a session whose
 *   camera parts are filed is done. Retried five times over about three minutes, inside the
 *   buffer's half hour.
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
  cameraCut: {
    name: 'packing.camera_cut',
    scope: 'org',
    expireInSeconds: 600,
  },
} as const satisfies Record<string, QueueDefinition>;

/** What a camera cut job carries: the session whose window closed. */
export interface CameraCutPayload {
  readonly sessionId: string;
}

export const PACKING_QUEUE_DEFINITIONS: readonly QueueDefinition[] = Object.values(PACKING_QUEUES);
