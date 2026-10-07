import { containerOf, uploadDue } from './pack-logic.js';
import type { VideoPartAnswer, VideoUploadTicket } from './pack-station-api.js';
import type { StoredRecording, VideoStore } from './pack-video-store.js';

/**
 * Sending recorded packing videos to the server (M38b, D-611): each through the files module's
 * own upload (ticket, PUT, finalize, §22), then attached to its part of the session. A
 * recording stays in this browser until the attach succeeds; a failure is tried again later
 * (30 s, 1, 2, 5, then every 10 minutes), on the next visit to the station, or when the
 * connection comes back. Nothing here is discarded on an error: a video is evidence.
 */

export interface UploadApi {
  register(
    sessionId: string,
    input: { videoId: string; startedAt: string; mime: 'video/webm' | 'video/mp4' },
  ): Promise<VideoPartAnswer>;
  ticket(input: {
    contentType: string;
    sizeBytes: number;
    originalName: string;
  }): Promise<VideoUploadTicket>;
  put(ticket: VideoUploadTicket, blob: Blob, onProgress: (fraction: number) => void): Promise<void>;
  finalize(fileId: string): Promise<unknown>;
  attach(
    sessionId: string,
    videoId: string,
    input: { fileId: string; durationMs: number },
  ): Promise<VideoPartAnswer>;
}

/** How long a recording ran: to its stop, or to its last kept chunk after a reload. */
export function recordedMs(recording: StoredRecording): number {
  const end = recording.endedAt ?? recording.lastChunkAt ?? recording.startedAt;
  return Math.max(0, Math.round(end - recording.startedAt));
}

export type UploadResult = 'uploaded' | 'already' | 'empty';

/** Upload one finished recording and attach it; the store keeps it until this resolves. */
export async function uploadRecording(
  recording: StoredRecording,
  store: VideoStore,
  api: UploadApi,
  onProgress: (fraction: number) => void = () => undefined,
): Promise<UploadResult> {
  const mime = containerOf(recording.mime);
  // Registered when the recording started; again here, harmlessly, in case that call failed.
  const part = await api.register(recording.sessionId, {
    videoId: recording.videoId,
    startedAt: new Date(recording.startedAt).toISOString(),
    mime,
  });
  if (part.state !== 'waiting') {
    // A previous attempt got this far and the page closed before the copy here was dropped.
    await store.remove(recording.videoId);
    return 'already';
  }
  const blob = await store.blob(recording.videoId);
  if (blob === null || blob.size === 0) {
    await store.remove(recording.videoId);
    return 'empty';
  }
  const extension = mime === 'video/mp4' ? 'mp4' : 'webm';
  const ticket = await api.ticket({
    contentType: mime,
    sizeBytes: blob.size,
    originalName: `${recording.orderNo}-part-${String(part.part)}.${extension}`,
  });
  // The recorder's own format names its codec; the stored type is the container's.
  await api.put(ticket, new Blob([blob], { type: mime }), onProgress);
  await api.finalize(ticket.fileId);
  await api.attach(recording.sessionId, recording.videoId, {
    fileId: ticket.fileId,
    durationMs: recordedMs(recording),
  });
  await store.remove(recording.videoId);
  return 'uploaded';
}

export interface QueueSummary {
  readonly uploaded: number;
  readonly failed: number;
  /** Recordings still kept here, the one being recorded included. */
  readonly waiting: number;
}

/**
 * Try every recording that is due: those finished, and those left recording by an earlier page
 * (a reload or a crash; `activeVideoId` is this page's own, still running). One at a time, so a
 * slow connection carries one video, not five.
 */
export async function runUploadQueue(options: {
  readonly store: VideoStore;
  readonly api: UploadApi;
  readonly activeVideoId: string | null;
  readonly now?: () => number;
  readonly force?: boolean;
  readonly onProgress?: (videoId: string, fraction: number) => void;
}): Promise<QueueSummary> {
  const { api } = options;
  const now = options.now ?? Date.now;
  let uploaded = 0;
  let failed = 0;
  for (const recording of await options.store.list()) {
    if (recording.videoId === options.activeVideoId) continue;
    if (recording.endedAt === null) {
      // An earlier page's recording, cut short: what was kept is the video.
      await options.store.finish(recording.videoId, recording.lastChunkAt ?? recording.startedAt);
    }
    if (options.force !== true && !uploadDue(recording, now())) continue;
    try {
      const current = (await options.store.list()).find(
        (entry) => entry.videoId === recording.videoId,
      );
      if (current === undefined) continue;
      await uploadRecording(current, options.store, api, (fraction) =>
        options.onProgress?.(recording.videoId, fraction),
      );
      uploaded += 1;
    } catch (error) {
      failed += 1;
      await options.store.update(recording.videoId, {
        attempts: recording.attempts + 1,
        lastAttemptAt: now(),
        lastError: error instanceof Error ? error.message : 'upload failed',
      });
    }
  }
  const waiting = (await options.store.list()).length;
  return { uploaded, failed, waiting };
}
