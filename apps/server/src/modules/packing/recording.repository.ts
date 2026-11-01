import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * The SQL behind each lot's recording (M51, D-930 to D-933): started by the lot's label scan,
 * stopped once. Its own schema only (invariant 12); every statement runs inside the caller's
 * `withOrg()`.
 */

export type RecordingStopReason = 'label' | 'closed' | 'finished' | 'received' | 'timed_out';

export interface LotRecordingRow extends Record<string, unknown> {
  readonly id: string;
  readonly session_id: string;
  readonly lot_no: number;
  /** 1, or the next when a return's bag is reopened (D-934). */
  readonly take: number;
  readonly video_required: boolean;
  readonly camera_id: string | null;
  readonly idle_ms: number;
  readonly started_at: Date | string;
  readonly started_by: string;
  readonly stopped_at: Date | string | null;
  readonly stopped_by: string | null;
  readonly stop_reason: RecordingStopReason | null;
}

const COLUMNS = sql`id, session_id, lot_no, take, video_required, camera_id, idle_ms, started_at,
  started_by, stopped_at, stopped_by, stop_reason`;

/** A session's recordings, lot by lot. */
export async function recordingsOf(
  tx: Tx,
  orgId: string,
  sessionId: string,
): Promise<LotRecordingRow[]> {
  const rows = await tx.execute<LotRecordingRow>(sql`
    select ${COLUMNS} from packing.recordings
    where org_id = ${orgId} and session_id = ${sessionId}
    order by lot_no, take
  `);
  return [...rows];
}

export async function recordingById(
  tx: Tx,
  orgId: string,
  id: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<LotRecordingRow | undefined> {
  const rows = await tx.execute<LotRecordingRow>(sql`
    select ${COLUMNS} from packing.recordings where org_id = ${orgId} and id = ${id}
    ${options.forUpdate === true ? sql`for update` : sql``}
  `);
  return rows[0];
}

/** A lot's latest recording. */
export async function recordingOfLot(
  tx: Tx,
  orgId: string,
  sessionId: string,
  lot: number,
  options: { readonly forUpdate?: boolean } = {},
): Promise<LotRecordingRow | undefined> {
  const rows = await tx.execute<LotRecordingRow>(sql`
    select ${COLUMNS} from packing.recordings
    where org_id = ${orgId} and session_id = ${sessionId} and lot_no = ${lot}
    order by take desc
    limit 1
    ${options.forUpdate === true ? sql`for update` : sql``}
  `);
  return rows[0];
}

/**
 * A lot's recording, started by its label scan: its start and who started it are the scan's own
 * (read by id, so the instant is the database's, to the microsecond the trigger compares).
 */
export async function insertRecording(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly sessionId: string;
    readonly lot: number;
    readonly videoRequired: boolean;
    readonly cameraId: string | null;
    readonly idleMs: number;
    /** The label scan's row id. */
    readonly labelScanId: string;
  },
): Promise<LotRecordingRow | undefined> {
  const rows = await tx.execute<LotRecordingRow>(sql`
    insert into packing.recordings
      (org_id, session_id, lot_no, take, video_required, camera_id, idle_ms, started_at,
       started_by)
    select ${input.orgId}, ${input.sessionId}, ${input.lot},
           (select coalesce(max(r.take), 0) + 1 from packing.recordings r
             where r.org_id = ${input.orgId} and r.session_id = ${input.sessionId}
               and r.lot_no = ${input.lot}),
           ${input.videoRequired}, ${input.cameraId}::uuid, ${input.idleMs}, c.scanned_at,
           c.scanned_by
      from packing.scans c
     where c.org_id = ${input.orgId} and c.id = ${input.labelScanId}
    on conflict (org_id, session_id, lot_no, take) do nothing
    returning ${COLUMNS}
  `);
  return rows[0];
}

/**
 * The recording's stop, once: at the scan that stopped it (`scanId`, its own instant), else at
 * `at`, never past fifteen minutes from the start (D-611) and never before it. `by` is null
 * only for the fifteen minutes running out.
 */
export async function stopRecording(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly at: Date;
    readonly scanId?: string | null;
    readonly by: string | null;
    readonly reason: RecordingStopReason;
  },
): Promise<LotRecordingRow | undefined> {
  const stoppedAt = sql`coalesce(
    (select c.scanned_at from packing.scans c
      where c.org_id = ${input.orgId} and c.id = ${input.scanId ?? null}::uuid),
    ${input.at.toISOString()}::timestamptz)`;
  const rows = await tx.execute<LotRecordingRow>(sql`
    update packing.recordings
       set stopped_at = greatest(started_at, least(${stoppedAt}, started_at + interval '15 minutes')),
           stopped_by = ${input.by}, stop_reason = ${input.reason}, updated_at = now()
     where org_id = ${input.orgId} and id = ${input.id} and stopped_at is null
    returning ${COLUMNS}
  `);
  return rows[0];
}

/** Every event at the table in one lot of a session (the scans of the lot), oldest first. */
export async function activityOf(
  tx: Tx,
  orgId: string,
  sessionId: string,
  lot: number,
): Promise<Date[]> {
  const rows = await tx.execute<{ scanned_at: Date | string }>(sql`
    select scanned_at from packing.scans
    where org_id = ${orgId} and session_id = ${sessionId} and lot_no = ${lot}
    order by scanned_at, id
  `);
  return rows.map((row) => new Date(row.scanned_at));
}

/** Running recordings an IP camera films that started at or before `startedBefore`. */
export async function timedOutCameraRecordings(
  tx: Tx,
  orgId: string,
  startedBefore: Date,
): Promise<LotRecordingRow[]> {
  const rows = await tx.execute<LotRecordingRow>(sql`
    select ${COLUMNS} from packing.recordings
    where org_id = ${orgId} and stopped_at is null and camera_id is not null
      and started_at <= ${startedBefore.toISOString()}::timestamptz
    order by started_at
    limit 100
  `);
  return [...rows];
}

/**
 * The starts of this camera's recordings its buffer must still hold: started after `since`
 * (running, or stopped and not yet cut for this camera).
 */
export async function pendingRecordingStarts(
  tx: Tx,
  orgId: string,
  cameraId: string,
  since: Date,
): Promise<Date[]> {
  const rows = await tx.execute<{ started_at: Date | string }>(sql`
    select r.started_at from packing.recordings r
    where r.org_id = ${orgId} and r.video_required
      and (r.camera_id = ${cameraId}
           or (r.camera_id is not null and exists (
                 select 1 from packing.session_cameras c
                  where c.org_id = r.org_id and c.session_id = r.session_id
                    and c.camera_id = ${cameraId})))
      and r.started_at >= ${since.toISOString()}::timestamptz
      and not exists (
        select 1 from packing.videos v
        where v.org_id = r.org_id and v.recording_id = r.id and v.source = 'camera'
          and v.camera_id = ${cameraId}
      )
  `);
  return rows.map((row) => new Date(row.started_at));
}

/** Whether a recording this camera films is running now. */
export async function cameraRecordingRunning(
  tx: Tx,
  orgId: string,
  cameraId: string,
): Promise<boolean> {
  const [row] = await tx.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from packing.recordings r
      where r.org_id = ${orgId} and r.stopped_at is null
        and (r.camera_id = ${cameraId}
             or (r.camera_id is not null and exists (
                   select 1 from packing.session_cameras c
                    where c.org_id = r.org_id and c.session_id = r.session_id
                      and c.camera_id = ${cameraId})))
    ) as found
  `);
  return row?.found === true;
}

/** The camera parts already filed for one recording (and camera). */
export async function cameraPartsOfRecording(
  tx: Tx,
  orgId: string,
  recordingId: string,
  cameraId: string,
): Promise<{ readonly id: string; readonly part: number }[]> {
  const rows = await tx.execute<{ id: string; part: number }>(sql`
    select id, part from packing.videos
    where org_id = ${orgId} and recording_id = ${recordingId} and source = 'camera'
      and camera_id = ${cameraId}
    order by part
  `);
  return [...rows];
}
