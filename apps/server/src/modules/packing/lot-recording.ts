import type { Tx } from '@elysium/db';
import {
  PACKING_IDLE_PAUSE_DEFAULT_MS,
  PACKING_RESUME_LEAD_MS,
  recordedMs,
  recordingSpans,
} from '@elysium/domain/packing';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import type { AuditService } from '../../platform/audit/audit.service.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import * as cameras from './camera.repository.js';
import { PACKING_QUEUES, type CameraCutPayload } from './packing.queues.js';
import * as rec from './recording.repository.js';
import type { ScanRow, SessionRow } from './station.repository.js';
import * as repo from './station.repository.js';

/**
 * A lot's recording, started and stopped (M51, D-930 to D-933), for the packing station, the
 * return station and the camera process's fifteen minutes. Each runs inside its caller's
 * transaction; a stop that an IP camera filmed enqueues the camera's cut there too
 * (invariant 6), along the recording's stretches (D-931).
 */

/** The brand's pause rule now: its setting, or ten seconds. */
export async function idlePauseMsOf(tx: Tx, orgId: string): Promise<number> {
  return (await repo.settingsOf(tx, orgId))?.idle_pause_ms ?? PACKING_IDLE_PAUSE_DEFAULT_MS;
}

/**
 * Start a lot's recording at its label scan. The IP camera the session chose films it while that
 * camera is on; otherwise this computer's camera does (the browser records, D-670). Null when the
 * lot already has one (two scans racing: the first wins).
 */
export async function startLotRecording(
  tx: Tx,
  audit: AuditService,
  input: {
    readonly orgId: string;
    readonly userId: string;
    readonly request: AuditableRequest;
    readonly session: SessionRow;
    readonly lot: number;
    readonly labelScan: ScanRow;
  },
): Promise<rec.LotRecordingRow | undefined> {
  const { session } = input;
  const camera =
    session.camera_id === null
      ? undefined
      : await cameras.cameraById(tx, input.orgId, session.camera_id);
  const cameraId = session.video_required && camera?.enabled === true ? camera.id : null;
  const row = await rec.insertRecording(tx, {
    orgId: input.orgId,
    sessionId: session.id,
    lot: input.lot,
    videoRequired: session.video_required,
    cameraId,
    idleMs: await idlePauseMsOf(tx, input.orgId),
    labelScanId: input.labelScan.id,
  });
  if (row === undefined) return undefined;
  await audit.record(tx, {
    orgId: input.orgId,
    actorUserId: input.userId,
    operation: 'create',
    action: 'packing.lot_recording_started',
    entityType: 'packing_session',
    entityId: session.id,
    after: {
      orderId: session.order_id,
      kind: session.kind,
      lot: input.lot,
      recordingId: row.id,
      cameraId,
      videoRequired: row.video_required,
      idleMs: row.idle_ms,
    },
    request: input.request,
  });
  return row;
}

/**
 * Stop a lot's recording, once: at the scan that stopped it, or now (Close lot, Finish, the
 * receipt), or at its fifteen minutes. An IP camera's recording has its cut enqueued here, for
 * its camera and the session's other cameras (D-804). False when it was already stopped.
 */
export async function stopLotRecording(
  tx: Tx,
  audit: AuditService,
  input: {
    readonly orgId: string;
    readonly userId: string | null;
    readonly request?: AuditableRequest;
    readonly session: { readonly id: string; readonly order_id: string };
    readonly recording: rec.LotRecordingRow;
    readonly reason: rec.RecordingStopReason;
    readonly at: Date;
    readonly scanId?: string | null;
  },
): Promise<boolean> {
  const stopped = await rec.stopRecording(tx, {
    orgId: input.orgId,
    id: input.recording.id,
    at: input.at,
    scanId: input.scanId ?? null,
    by: input.userId,
    reason: input.reason,
  });
  if (stopped === undefined) return false;
  const filmed = stopped.video_required && stopped.camera_id !== null;
  if (filmed) {
    const payload: CameraCutPayload = {
      sessionId: input.session.id,
      recordingId: stopped.id,
    };
    await enqueue(tx, PACKING_QUEUES.cameraCut.name, payload, {
      orgId: input.orgId,
      ref: input.session.id,
    });
    for (const cameraId of await cameras.extraCamerasOf(tx, input.orgId, input.session.id)) {
      const extra: CameraCutPayload = {
        sessionId: input.session.id,
        recordingId: stopped.id,
        cameraId,
      };
      await enqueue(tx, PACKING_QUEUES.cameraCut.name, extra, {
        orgId: input.orgId,
        ref: input.session.id,
      });
    }
  }
  await audit.record(tx, {
    orgId: input.orgId,
    actorUserId: input.userId,
    operation: 'update',
    action: 'packing.lot_recording_stopped',
    entityType: 'packing_session',
    entityId: input.session.id,
    before: { stoppedAt: null },
    after: {
      orderId: input.session.order_id,
      lot: stopped.lot_no,
      recordingId: stopped.id,
      reason: input.reason,
      stoppedAt: new Date(stopped.stopped_at ?? input.at).toISOString(),
      cutQueued: filmed,
    },
    ...(input.request === undefined ? {} : { request: input.request }),
  });
  return true;
}

/** Stop the lot's recording if it runs (Close lot, Finish, the receipt). */
export async function stopLotIfRunning(
  tx: Tx,
  audit: AuditService,
  input: {
    readonly orgId: string;
    readonly userId: string;
    readonly request: AuditableRequest;
    readonly session: SessionRow;
    readonly lot: number;
    readonly reason: rec.RecordingStopReason;
    readonly scanId?: string | null;
  },
): Promise<void> {
  const recording = await rec.recordingOfLot(tx, input.orgId, input.session.id, input.lot, {
    forUpdate: true,
  });
  if (recording?.stopped_at !== null) return;
  await stopLotRecording(tx, audit, {
    orgId: input.orgId,
    userId: input.userId,
    request: input.request,
    session: input.session,
    recording,
    reason: input.reason,
    at: await cameras.transactionNow(tx),
    scanId: input.scanId ?? null,
  });
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

/**
 * What the stations and the order page show of each lot's recording: running or stopped, its
 * stretches (the video pauses between them, D-931), how long it holds, and the last event (the
 * station counts down to the pause from it).
 */
export function recordingViews(
  rows: readonly rec.LotRecordingRow[],
  scans: readonly ScanRow[],
  names: ReadonlyMap<string, string>,
  now: Date,
) {
  return rows.map((row) => {
    const startedMs = new Date(row.started_at).getTime();
    const stoppedMs = row.stopped_at === null ? null : new Date(row.stopped_at).getTime();
    const activityMs = scans
      .filter((scan) => scan.lot_no === row.lot_no)
      .map((scan) => new Date(scan.scanned_at).getTime())
      .filter((at) => at >= startedMs && (stoppedMs === null || at <= stoppedMs));
    const spans = recordingSpans({
      startedMs,
      activityMs,
      stoppedMs,
      nowMs: now.getTime(),
      idleMs: row.idle_ms,
      leadMs: row.camera_id === null ? 0 : PACKING_RESUME_LEAD_MS,
    });
    const lastActivityMs = Math.max(startedMs, ...activityMs);
    return {
      id: row.id,
      lot: row.lot_no,
      state: row.stopped_at === null ? ('recording' as const) : ('stopped' as const),
      videoRequired: row.video_required,
      source: row.camera_id === null ? ('browser' as const) : ('camera' as const),
      cameraId: row.camera_id,
      idleMs: row.idle_ms,
      startedAt: iso(row.started_at),
      startedBy: { id: row.started_by, name: names.get(row.started_by) ?? null },
      stoppedAt: iso(row.stopped_at),
      stopReason: row.stop_reason,
      lastActivityAt: new Date(lastActivityMs).toISOString(),
      spans: spans.map((span) => ({
        from: new Date(span.fromMs).toISOString(),
        to: new Date(span.toMs).toISOString(),
      })),
      recordedMs: recordedMs(spans),
    };
  });
}
