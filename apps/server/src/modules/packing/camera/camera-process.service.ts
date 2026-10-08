import { createHash } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { Inject, Injectable } from '@nestjs/common';
import { withGlobal, withOrg } from '@elysium/db';
import {
  PACKING_CAMERA_HORIZON_MS,
  PACKING_CAMERA_MAX_MS,
  cameraBufferKeepFromMs,
  cameraParts,
  cameraRecordingTimedOut,
  cutDecision,
  cutSpan,
  segmentsForWindow,
  segmentsToForget,
  windowCoverage,
  type CameraSegment,
} from '@elysium/domain/packing';
import { mimeRuleFor } from '@elysium/integrations';
import { sql } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service.js';
import { open as openSealed } from '../../../platform/crypto/sealed-box.js';
import { enqueue } from '../../../platform/jobs/enqueue.js';
import { FILES_API, type FilesApi } from '../../files/files.api.js';
import { cameraPasswordBinding } from '../camera-settings.service.js';
import * as cameras from '../camera.repository.js';
import { PACKING_QUEUES, type CameraCutPayload } from '../packing.queues.js';
import {
  CameraRecorder,
  type FfmpegCommand,
  type RecorderLog,
  type SpawnFn,
} from './camera-recorder.js';
import { cutSegments } from './cutter.js';
import type { CameraErrorCode } from './ffmpeg.js';
import { SegmentBuffer } from './segment-buffer.js';

/**
 * The largest part one cut makes: under the files module's ceiling for an MP4 packing video,
 * with room for the MP4's own index (the segments' MPEG-TS wrapping is larger than the MP4's).
 */
export const CAMERA_PART_MAX_BYTES = mimeRuleFor('video/mp4').maxBytes - 4 * 1024 * 1024;

/** What one cut did. */
export type CutOutcome = 'cut' | 'already' | 'nothing_to_cut' | 'no_footage';

export interface CameraProcessOptions {
  readonly bufferRoot: string;
  readonly ffmpeg: FfmpegCommand;
  readonly log: RecorderLog;
  /** A test's stand-ins: another input than the camera's RTSP, an encoder, a spawn, a clock. */
  readonly inputArgs?: (cameraId: string) => readonly string[] | undefined;
  readonly codecArgs?: readonly string[];
  readonly spawn?: SpawnFn;
  readonly now?: () => number;
  /** How long a cut sleeps between looks at the buffer while it waits for the end. */
  readonly cutPollMs?: number;
}

interface Running {
  readonly orgId: string;
  readonly recorder: CameraRecorder;
  readonly signature: string;
  reported: { segmentAt: number | null; errorCode: string | null; at: number };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** A deterministic id for a session's n-th camera part: a retried cut files the same part. */
export function cameraPartId(sessionId: string, index: number): string {
  const hex = createHash('sha256')
    .update(`packing-camera-part:${sessionId}:${String(index)}`)
    .digest('hex');
  // Shaped as a version-5-style UUID (the database only asks for a uuid).
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/**
 * The camera process (M38c, D-672 to D-676): records every enabled IP camera of the brand
 * into its rolling buffer, keeps the buffer to what a waiting window needs, reports each
 * camera's state, closes recordings left open past fifteen minutes, and cuts each packing's
 * video from the buffer when its window closes.
 *
 * It owns the buffer, so the cut runs here (`packing.camera_cut`), never in the worker. No
 * transaction is ever open across ffmpeg or storage: the cut reads the window, waits, joins
 * the segments and stores the file each on its own, then files the part in one short
 * transaction under the session's lock.
 */
@Injectable()
export class CameraProcessService {
  private options: CameraProcessOptions | null = null;
  private readonly running = new Map<string, Running>();
  private readonly buffers = new Map<string, SegmentBuffer>();

  constructor(
    @Inject(FILES_API) private readonly files: FilesApi,
    private readonly audit: AuditService,
  ) {}

  configure(options: CameraProcessOptions): void {
    this.options = options;
  }

  private get config(): CameraProcessOptions {
    if (this.options === null) throw new Error('the camera process is not configured');
    return this.options;
  }

  private now(): number {
    return (this.config.now ?? Date.now)();
  }

  /** One camera's buffer: `<root>/<org>/<camera>`. */
  bufferFor(orgId: string, cameraId: string): SegmentBuffer {
    const key = `${orgId}/${cameraId}`;
    let buffer = this.buffers.get(key);
    if (buffer === undefined) {
      buffer = new SegmentBuffer(path.join(this.config.bufferRoot, orgId, cameraId));
      this.buffers.set(key, buffer);
    }
    return buffer;
  }

  /** The cameras recording now, for the tests and the boot log. */
  recording(): readonly string[] {
    return [...this.running.keys()];
  }

  // --- the cameras ---------------------------------------------------------------------------

  /**
   * Bring the recorders in line with the settings: every enabled camera of every brand in this
   * database recorded, a changed one (address, user name, password, switch) restarted, a
   * switched-off or removed one stopped. Run every ten seconds (D-673).
   */
  async reload(): Promise<void> {
    const orgIds = await withGlobal(async (tx) =>
      (await tx.execute<{ id: string }>(sql`select id from org.organizations order by slug`)).map(
        (row) => row.id,
      ),
    );
    const wanted = new Map<
      string,
      { orgId: string; row: cameras.RecorderCameraRow; password: string | null; signature: string }
    >();
    for (const orgId of orgIds) {
      const rows = await withOrg({ orgId }, (tx) => cameras.enabledCamerasForRecorder(tx, orgId));
      for (const row of rows) {
        let password: string | null = null;
        if (row.password_sealed !== null) {
          try {
            password = openSealed(
              Buffer.from(row.password_sealed),
              cameraPasswordBinding(orgId, row.id),
            );
          } catch {
            // Sealed under another key, or tampered with: say so on the camera, never guess.
            await this.report(orgId, row.id, null, 'credentials_unreadable');
            continue;
          }
        }
        const signature = [
          row.rtsp_url,
          row.username,
          row.password_fingerprint ?? '',
          new Date(row.updated_at).toISOString(),
        ].join('|');
        wanted.set(row.id, { orgId, row, password, signature });
      }
    }

    for (const [cameraId, running] of [...this.running]) {
      const next = wanted.get(cameraId);
      if (next?.signature !== running.signature) {
        this.running.delete(cameraId);
        await running.recorder.stop();
        this.config.log.info({ cameraId }, 'camera recording stopped (settings changed)');
      }
    }
    for (const [cameraId, next] of wanted) {
      if (this.running.has(cameraId)) continue;
      const inputArgs = this.config.inputArgs?.(cameraId);
      const recorder = new CameraRecorder({
        cameraId,
        stream: {
          rtspUrl: next.row.rtsp_url,
          username: next.row.username,
          password: next.password,
        },
        buffer: this.bufferFor(next.orgId, cameraId),
        ffmpeg: this.config.ffmpeg,
        log: this.config.log,
        ...(inputArgs === undefined ? {} : { inputArgs }),
        ...(this.config.codecArgs === undefined ? {} : { codecArgs: this.config.codecArgs }),
        ...(this.config.spawn === undefined ? {} : { spawn: this.config.spawn }),
        ...(this.config.now === undefined ? {} : { now: this.config.now }),
      });
      this.running.set(cameraId, {
        orgId: next.orgId,
        recorder,
        signature: next.signature,
        reported: { segmentAt: null, errorCode: null, at: 0 },
      });
      await recorder.start();
    }
  }

  /** Every recorder's state written to its camera: footage arriving, or why it stopped. */
  async reportAll(): Promise<void> {
    for (const [cameraId, running] of this.running) {
      const status = running.recorder.status();
      const segmentAt = status.lastSegmentAt?.getTime() ?? null;
      const changed =
        segmentAt !== running.reported.segmentAt || status.errorCode !== running.reported.errorCode;
      // A heartbeat at least every half minute, so "offline" is never a stale "ready".
      if (!changed && this.now() - running.reported.at < 30_000) continue;
      await this.report(running.orgId, cameraId, status.lastSegmentAt, status.errorCode);
      running.reported = { segmentAt, errorCode: status.errorCode, at: this.now() };
    }
  }

  private async report(
    orgId: string,
    cameraId: string,
    segmentAt: Date | null,
    errorCode: CameraErrorCode | null,
  ): Promise<void> {
    await withOrg({ orgId }, (tx) =>
      cameras.reportCameraStatus(tx, { orgId, id: cameraId, segmentAt, errorCode }),
    );
  }

  /**
   * Keep each buffer to what it must hold (`cameraBufferKeepFromMs`): the last minute, and
   * every window still waiting to be cut back to its start, never more than half an hour.
   * The buffers of cameras no longer recording keep only what a waiting window needs.
   */
  async prune(): Promise<number> {
    const nowMs = this.now();
    const since = new Date(nowMs - PACKING_CAMERA_HORIZON_MS);
    let removed = 0;
    for (const [key, buffer] of this.buffers) {
      const [orgId = '', cameraId = ''] = key.split('/');
      const pending = await withOrg({ orgId }, (tx) =>
        cameras.pendingWindowStarts(tx, orgId, cameraId, since),
      );
      const keepFrom = cameraBufferKeepFromMs({
        nowMs,
        pendingFromMs: pending.map((from) => from.getTime()),
      });
      removed += await buffer.forget(segmentsToForget(await buffer.segments(), keepFrom));
      await buffer.forgetStale(nowMs - PACKING_CAMERA_HORIZON_MS, null);
    }
    return removed;
  }

  /** A buffer directory left from a camera this process never opened: tidied like the others. */
  async adoptBuffers(): Promise<void> {
    let orgs: string[];
    try {
      orgs = await readdir(this.config.bufferRoot);
    } catch {
      return;
    }
    for (const orgId of orgs) {
      let cameraIds: string[];
      try {
        cameraIds = await readdir(path.join(this.config.bufferRoot, orgId));
      } catch {
        continue;
      }
      for (const cameraId of cameraIds) {
        if (/^[0-9a-f-]{36}$/i.test(orgId) && /^[0-9a-f-]{36}$/i.test(cameraId)) {
          this.bufferFor(orgId, cameraId);
        }
      }
    }
  }

  /**
   * Close every recording left open fifteen minutes after it started (an order left on the
   * station): its end set at the fifteen minutes, its cut enqueued in that transaction.
   */
  async closeTimedOut(): Promise<number> {
    const now = new Date(this.now());
    const orgIds = await withGlobal(async (tx) =>
      (await tx.execute<{ id: string }>(sql`select id from org.organizations`)).map(
        (row) => row.id,
      ),
    );
    let closed = 0;
    for (const orgId of orgIds) {
      const due = await withOrg({ orgId }, (tx) =>
        cameras.timedOutRecordings(tx, orgId, new Date(now.getTime() - PACKING_CAMERA_MAX_MS)),
      );
      for (const candidate of due) {
        const done = await withOrg({ orgId }, async (tx) => {
          const session = await cameras.recordingOf(tx, orgId, candidate.id, { forUpdate: true });
          if (session?.status !== 'open') return false;
          const to = cameraRecordingTimedOut({
            recordingFrom:
              session.recording_from === null ? null : new Date(session.recording_from),
            recordingTo: session.recording_to === null ? null : new Date(session.recording_to),
            now,
          });
          if (to === null) return false;
          if (!(await cameras.endRecording(tx, { orgId, sessionId: session.id, to }))) return false;
          const payload: CameraCutPayload = { sessionId: session.id };
          await enqueue(tx, PACKING_QUEUES.cameraCut.name, payload, { orgId, ref: session.id });
          await this.audit.record(tx, {
            orgId,
            actorUserId: null,
            operation: 'update',
            action: 'packing.camera_recording_timed_out',
            entityType: 'packing_session',
            entityId: session.id,
            before: { recordingTo: null },
            after: {
              orderId: session.order_id,
              cameraId: session.camera_id,
              recordingTo: to.toISOString(),
            },
          });
          return true;
        });
        if (done) closed += 1;
      }
    }
    return closed;
  }

  // --- the cut (packing.camera_cut) ------------------------------------------------------------

  /**
   * Cut one packing's video from its camera's buffer and file it as the session's part(s).
   * Idempotent: a session whose camera parts are filed is done; a part is filed under a
   * deterministic id. Waits up to a few seconds for the footage to reach the window's end,
   * then cuts what there is; with no footage at all, it says so in the audit and stops (the
   * order's video then reads "missing").
   */
  async cut(orgId: string, sessionId: string): Promise<CutOutcome> {
    const found = await withOrg({ orgId }, async (tx) => ({
      session: await cameras.recordingOf(tx, orgId, sessionId),
      parts: await cameras.cameraPartsOf(tx, orgId, sessionId),
    }));
    const session = found.session;
    if (session === undefined) return 'nothing_to_cut';
    if (
      session.camera_id === null ||
      session.recording_from === null ||
      session.recording_to === null ||
      session.recording_by === null
    ) {
      return 'nothing_to_cut';
    }
    if (found.parts.length > 0) return 'already';
    const cameraId = session.camera_id;
    const recordedBy = session.recording_by;
    const window = {
      fromMs: new Date(session.recording_from).getTime(),
      toMs: new Date(session.recording_to).getTime(),
    };
    const span = cutSpan(window);
    const buffer = this.bufferFor(orgId, cameraId);
    const recorder = this.running.get(cameraId)?.recorder;

    const since = this.now();
    let chosen: CameraSegment[];
    for (;;) {
      if (recorder === undefined) await buffer.settle(null);
      else await recorder.settleNow();
      chosen = segmentsForWindow(await buffer.segments(), span);
      const decision = cutDecision({ chosen, span, nowMs: this.now(), sinceMs: since });
      if (decision === 'cut') break;
      if (decision === 'none') {
        await withOrg({ orgId }, (tx) =>
          this.audit.record(tx, {
            orgId,
            actorUserId: null,
            operation: 'update',
            action: 'packing.camera_footage_missing',
            entityType: 'packing_session',
            entityId: sessionId,
            after: {
              orderId: session.order_id,
              cameraId,
              recordingFrom: new Date(window.fromMs).toISOString(),
              recordingTo: new Date(window.toMs).toISOString(),
            },
          }),
        );
        this.config.log.warn({ cameraId, sessionId }, 'camera cut found no footage');
        return 'no_footage';
      }
      await sleep(this.config.cutPollMs ?? 1_000);
    }
    const coverage = windowCoverage(chosen, span);

    // Join and store each part, no transaction open (invariant 6).
    const stored: {
      index: number;
      fileId: string;
      sizeBytes: number;
      durationMs: number;
      startedAt: Date;
    }[] = [];
    const workDir = path.join(this.config.bufferRoot, '.cuts');
    for (const [index, part] of cameraParts(chosen, CAMERA_PART_MAX_BYTES).entries()) {
      const result = await cutSegments({
        ffmpeg: this.config.ffmpeg,
        segments: part,
        pathOf: (segment) => buffer.pathOf(segment),
        workDir,
        ...(this.config.spawn === undefined ? {} : { spawn: this.config.spawn }),
      });
      try {
        const bytes = await readFile(result.file);
        const file = await this.files.storeProduced({
          orgId,
          ownerUserId: recordedBy,
          purpose: 'packing-video',
          mime: 'video/mp4',
          originalName: `${session.order_no}-camera-${String(index + 1)}.mp4`,
          bytes,
        });
        stored.push({
          index,
          fileId: file.fileId,
          sizeBytes: file.sizeBytes,
          durationMs: result.durationMs,
          startedAt: result.startedAt,
        });
      } finally {
        await rm(result.file, { force: true });
      }
    }

    // File the parts in one short transaction, under the session's lock.
    const outcome = await withOrg({ orgId, userId: recordedBy }, async (tx) => {
      await cameras.recordingOf(tx, orgId, sessionId, { forUpdate: true });
      if ((await cameras.cameraPartsOf(tx, orgId, sessionId)).length > 0) {
        // Another cut filed it first: these copies go, their bytes after the commit.
        for (const part of stored) {
          await this.files.forget(tx, orgId, part.fileId, 'packing-video');
        }
        return 'already' as const;
      }
      const filed = [];
      for (const part of stored) {
        filed.push(
          await cameras.insertCameraPart(tx, {
            orgId,
            id: cameraPartId(sessionId, part.index),
            sessionId,
            cameraId,
            recordedBy,
            startedAt: part.startedAt,
            fileId: part.fileId,
            durationMs: Math.min(part.durationMs, 3_600_000),
            sizeBytes: part.sizeBytes,
          }),
        );
      }
      await this.audit.record(tx, {
        orgId,
        actorUserId: null,
        operation: 'create',
        action: 'packing.camera_video_cut',
        entityType: 'packing_session',
        entityId: sessionId,
        after: {
          orderId: session.order_id,
          cameraId,
          recordedBy,
          recordingFrom: new Date(window.fromMs).toISOString(),
          recordingTo: new Date(window.toMs).toISOString(),
          parts: filed.map((row, index) => ({
            videoId: row.id,
            part: row.part,
            fileId: stored[index]?.fileId ?? null,
            durationMs: stored[index]?.durationMs ?? null,
            sizeBytes: stored[index]?.sizeBytes ?? null,
          })),
          startCovered: coverage.startCovered,
          endCovered: coverage.endCovered,
          gapMs: coverage.gapMs,
        },
      });
      return 'cut' as const;
    });
    if (outcome === 'cut') {
      this.config.log.info(
        { cameraId, sessionId, parts: stored.length, gapMs: coverage.gapMs },
        'camera video cut',
      );
    }
    return outcome;
  }

  /** Stop every recorder (the process is going down). */
  async stopAll(): Promise<void> {
    for (const [cameraId, running] of [...this.running]) {
      this.running.delete(cameraId);
      await running.recorder.stop();
    }
  }
}
