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
  /**
   * M46 (D-817): an order got its consignment; print each lot's parcel label (and its slip, if
   * the brand asks) on the label terminal for its location. Enqueued in the courier's booking
   * transaction. Idempotent: each job has its key (order, consignment, document, lot).
   */
  autoPrint: {
    name: 'labels.auto_print',
    scope: 'org',
    expireInSeconds: 300,
  },
  /**
   * M46 (D-813): send one print job to a network printer. Rendered (Gotenberg) and sent (IPP or
   * TCP 9100) with no transaction open; tried three times (now, +15 s, +30 s), then failed and
   * the label team told. Idempotent: a job no longer queued is not sent again.
   */
  send: {
    name: 'labels.send',
    scope: 'org',
    retryLimit: 2,
    retryDelaySeconds: 15,
    expireInSeconds: 300,
  },
  /**
   * M46 (D-815): every minute, ask each enabled network printer how it is (IPP printer-state, or
   * whether port 9100 answers). Global, one pass over the brands; a printer that does not answer
   * in three seconds is offline.
   */
  printerStatus: {
    name: 'labels.printer_status',
    scope: 'global',
    cron: '* * * * *',
    retryLimit: 0,
    expireInSeconds: 120,
  },
} as const satisfies Record<string, QueueDefinition>;

/** What a camera cut job carries: the session whose window closed, and which camera (M46). */
export interface CameraCutPayload {
  readonly sessionId: string;
  /** M46 (D-804): one of the session's other cameras; absent cuts its first camera. */
  readonly cameraId?: string;
}

/** M46: an order's parcel was booked. */
export interface AutoPrintPayload {
  readonly orderId: string;
  readonly consignmentNo: string;
}

/** M46: one print job to send. */
export interface SendPrintPayload {
  readonly jobId: string;
}

export const PACKING_QUEUE_DEFINITIONS: readonly QueueDefinition[] = Object.values(PACKING_QUEUES);
