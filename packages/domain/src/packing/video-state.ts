/**
 * Where a packing session's video stands (M38b, D-611), for the order page and the recent list.
 *
 * - `off`: recording was switched off for the brand when the session opened;
 * - `pending`: a part is still recording or uploading (the session is open, or finished less
 *   than {@link PACKING_VIDEO_GRACE_MS} ago);
 * - `uploaded`: every part arrived;
 * - `missing`: a video was expected and some part never arrived (a camera that failed, a
 *   browser closed with the recording in it and never opened again);
 * - `deleted`: the retention job removed it (seven days after delivery, D-612).
 */
export type PackingVideoState = 'off' | 'pending' | 'uploaded' | 'missing' | 'deleted';

/**
 * How long after a session is finished its video may still be on its way: two hours, enough
 * for a slow upload and a retry on the next visit to the station the same shift (ASSUMED,
 * D-611).
 */
export const PACKING_VIDEO_GRACE_MS = 2 * 60 * 60_000;

export interface PackingVideoPartFacts {
  readonly attached: boolean;
  readonly deleted: boolean;
}

export function packingVideoState(input: {
  readonly videoRequired: boolean;
  readonly sessionOpen: boolean;
  /** When the session was finished; null while it is open. */
  readonly completedAt: Date | null;
  readonly parts: readonly PackingVideoPartFacts[];
  readonly now: Date;
}): PackingVideoState {
  const { parts } = input;
  const late =
    !input.sessionOpen &&
    input.completedAt !== null &&
    input.now.getTime() - input.completedAt.getTime() > PACKING_VIDEO_GRACE_MS;
  const waiting = parts.some((part) => !part.attached && !part.deleted);
  if (parts.length === 0) {
    if (!input.videoRequired) return 'off';
    return late ? 'missing' : 'pending';
  }
  if (waiting) return late ? 'missing' : 'pending';
  if (parts.every((part) => part.deleted)) return 'deleted';
  return 'uploaded';
}
