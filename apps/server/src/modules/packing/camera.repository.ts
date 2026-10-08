import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * The SQL behind the packing table's IP cameras (M38c, D-668 to D-676): the cameras, the
 * recorder's status on them, a session's recording window, and the camera's parts of a
 * packing video. Its own schema only (invariant 12); every statement runs inside the caller's
 * `withOrg()`.
 */

export interface CameraRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly rtsp_url: string;
  readonly username: string;
  readonly password_fingerprint: string | null;
  readonly enabled: boolean;
  readonly last_segment_at: Date | string | null;
  readonly last_error_code: string | null;
  readonly last_error_at: Date | string | null;
  readonly status_at: Date | string | null;
  readonly updated_at: Date | string;
}

const CAMERA_COLUMNS = sql`id, name, rtsp_url, username, password_fingerprint, enabled,
  last_segment_at, last_error_code, last_error_at, status_at, updated_at`;

/** The brand's cameras, by name. Never the sealed password. */
export async function camerasOf(tx: Tx, orgId: string): Promise<CameraRow[]> {
  const rows = await tx.execute<CameraRow>(sql`
    select ${CAMERA_COLUMNS} from packing.cameras where org_id = ${orgId} order by name, id
  `);
  return [...rows];
}

export async function cameraById(
  tx: Tx,
  orgId: string,
  id: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<CameraRow | undefined> {
  const rows = await tx.execute<CameraRow>(sql`
    select ${CAMERA_COLUMNS} from packing.cameras where org_id = ${orgId} and id = ${id}
    ${options.forUpdate === true ? sql`for update` : sql``}
  `);
  return rows[0];
}

/**
 * One change to a brand's cameras at a time (M38c ledger audit, W6): the count of enabled
 * cameras is read and acted on under this lock, so two admins cannot pass the cap together.
 */
export async function lockCameraSettings(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`packing.cameras:${orgId}`}, 0))`,
  );
}

/** How many of the brand's cameras are switched on, leaving one out (the one being changed). */
export async function countEnabledCameras(
  tx: Tx,
  orgId: string,
  exceptId: string | null,
): Promise<number> {
  const [row] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from packing.cameras
    where org_id = ${orgId} and enabled
      ${exceptId === null ? sql`` : sql`and id <> ${exceptId}`}
  `);
  return row?.n ?? 0;
}

/** A sealed password as the settings write it: the ciphertext, its fingerprint and key. */
export interface SealedPassword {
  readonly sealed: Buffer;
  readonly fingerprint: string;
  readonly keyId: string;
}

export async function insertCamera(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly name: string;
    readonly rtspUrl: string;
    readonly username: string;
    readonly password: SealedPassword | null;
    readonly enabled: boolean;
    readonly userId: string;
  },
): Promise<CameraRow> {
  const rows = await tx.execute<CameraRow>(sql`
    insert into packing.cameras
      (id, org_id, name, rtsp_url, username, password_sealed, password_fingerprint, key_id,
       enabled, created_by, updated_by)
    values (${input.id}, ${input.orgId}, ${input.name}, ${input.rtspUrl}, ${input.username},
            ${input.password?.sealed ?? null}, ${input.password?.fingerprint ?? null},
            ${input.password?.keyId ?? null}, ${input.enabled}, ${input.userId}, ${input.userId})
    returning ${CAMERA_COLUMNS}
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('a camera was not written');
  return row;
}

/**
 * A camera's settings changed. `password` undefined keeps the sealed one; null removes it.
 * The recorder's status columns are not touched.
 */
export async function updateCamera(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly name: string;
    readonly rtspUrl: string;
    readonly username: string;
    readonly password: SealedPassword | null | undefined;
    readonly enabled: boolean;
    readonly userId: string;
  },
): Promise<CameraRow | undefined> {
  const password =
    input.password === undefined
      ? sql``
      : sql`, password_sealed = ${input.password?.sealed ?? null},
             password_fingerprint = ${input.password?.fingerprint ?? null},
             key_id = ${input.password?.keyId ?? null}`;
  const rows = await tx.execute<CameraRow>(sql`
    update packing.cameras
       set name = ${input.name}, rtsp_url = ${input.rtspUrl}, username = ${input.username},
           enabled = ${input.enabled}, updated_by = ${input.userId}, updated_at = now()
           ${password}
     where org_id = ${input.orgId} and id = ${input.id}
    returning ${CAMERA_COLUMNS}
  `);
  return rows[0];
}

/** What the recorder needs to open one camera's stream: its address and sealed password. */
export interface RecorderCameraRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly rtsp_url: string;
  readonly username: string;
  readonly password_sealed: Buffer | Uint8Array | null;
  readonly password_fingerprint: string | null;
  readonly updated_at: Date | string;
}

/** The brand's enabled cameras, with their sealed passwords: for the recorder only. */
export async function enabledCamerasForRecorder(
  tx: Tx,
  orgId: string,
): Promise<RecorderCameraRow[]> {
  const rows = await tx.execute<RecorderCameraRow>(sql`
    select id, name, rtsp_url, username, password_sealed, password_fingerprint, updated_at
    from packing.cameras
    where org_id = ${orgId} and enabled
    order by id
  `);
  return [...rows];
}

/**
 * The recorder's report on a camera: footage arrived (`segmentAt`), or the stream failed
 * (`errorCode`). Footage clears the error. Never touches the settings or `updated_at`.
 */
export async function reportCameraStatus(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly segmentAt: Date | null;
    readonly errorCode: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    update packing.cameras
       set status_at = now(),
           last_segment_at = coalesce(${input.segmentAt?.toISOString() ?? null}::timestamptz,
                                      last_segment_at),
           last_error_code = case
             when ${input.errorCode}::text is not null then ${input.errorCode}::text
             when ${input.segmentAt?.toISOString() ?? null}::timestamptz is not null then null
             else last_error_code end,
           last_error_at = case
             when ${input.errorCode}::text is not null then now() else last_error_at end
     where org_id = ${input.orgId} and id = ${input.id}
  `);
}

// --- the recording window (D-671) -----------------------------------------------------------

/**
 * The transaction's own `now()`: the moment a finish stamps on `completed_at`, so the window
 * it ends is measured by the same clock.
 */
export async function transactionNow(tx: Tx): Promise<Date> {
  const [row] = await tx.execute<{ now: Date | string }>(sql`select now() as now`);
  if (row === undefined) throw new Error('the database did not say what time it is');
  return new Date(row.now);
}

export interface RecordingRow extends Record<string, unknown> {
  readonly id: string;
  readonly order_id: string;
  readonly order_no: string;
  readonly status: 'open' | 'completed';
  readonly video_required: boolean;
  readonly camera_id: string | null;
  readonly recording_from: Date | string | null;
  readonly recording_to: Date | string | null;
  readonly recording_by: string | null;
}

const RECORDING_COLUMNS = sql`id, order_id, order_no, status, video_required, camera_id,
  recording_from, recording_to, recording_by`;

export async function recordingOf(
  tx: Tx,
  orgId: string,
  sessionId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<RecordingRow | undefined> {
  const rows = await tx.execute<RecordingRow>(sql`
    select ${RECORDING_COLUMNS} from packing.sessions where org_id = ${orgId} and id = ${sessionId}
    ${options.forUpdate === true ? sql`for update` : sql``}
  `);
  return rows[0];
}

/** Choose the session's camera (or none) while it has not started recording. */
export async function chooseSessionCamera(
  tx: Tx,
  orgId: string,
  sessionId: string,
  cameraId: string | null,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update packing.sessions set camera_id = ${cameraId}, updated_at = now()
     where org_id = ${orgId} and id = ${sessionId} and status = 'open' and recording_from is null
       and camera_id is distinct from ${cameraId}
    returning id
  `);
  return rows.length === 1;
}

/**
 * The window's start, once: at the first accepted scan, from that scan's own time. The scan's
 * row is read back by id so the start is the database's clock, not the caller's.
 */
export async function startRecording(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly sessionId: string;
    readonly from: Date;
    readonly by: string;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update packing.sessions s
       set recording_from = ${input.from.toISOString()}::timestamptz,
           recording_by = ${input.by}, updated_at = now()
     where s.org_id = ${input.orgId} and s.id = ${input.sessionId} and s.status = 'open'
       and s.camera_id is not null and s.recording_from is null
       -- Only a camera that is switched on records (ledger audit N4).
       and exists (
         select 1 from packing.cameras c
          where c.org_id = s.org_id and c.id = s.camera_id and c.enabled
       )
    returning s.id
  `);
  return rows.length === 1;
}

/** The window's end, once (the finish, or fifteen minutes): only on a window that started. */
export async function endRecording(
  tx: Tx,
  input: { readonly orgId: string; readonly sessionId: string; readonly to: Date },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update packing.sessions
       set recording_to = ${input.to.toISOString()}::timestamptz, updated_at = now()
     where org_id = ${input.orgId} and id = ${input.sessionId}
       and recording_from is not null and recording_to is null
    returning id
  `);
  return rows.length === 1;
}

/** Open sessions whose recording started fifteen minutes or more ago and never ended. */
export async function timedOutRecordings(
  tx: Tx,
  orgId: string,
  startedBefore: Date,
): Promise<RecordingRow[]> {
  const rows = await tx.execute<RecordingRow>(sql`
    select ${RECORDING_COLUMNS} from packing.sessions
    where org_id = ${orgId} and status = 'open' and recording_from is not null
      and recording_to is null and recording_from <= ${startedBefore.toISOString()}::timestamptz
    order by recording_from
    limit 100
  `);
  return [...rows];
}

/**
 * The starts of the windows a camera's buffer must still hold: recordings that started after
 * `since` and have no camera part yet (recording, or waiting to be cut).
 */
export async function pendingWindowStarts(
  tx: Tx,
  orgId: string,
  cameraId: string,
  since: Date,
): Promise<Date[]> {
  const rows = await tx.execute<{ recording_from: Date | string }>(sql`
    select s.recording_from from packing.sessions s
    where s.org_id = ${orgId} and s.camera_id = ${cameraId}
      and s.recording_from >= ${since.toISOString()}::timestamptz
      and not exists (
        select 1 from packing.videos v
        where v.org_id = s.org_id and v.session_id = s.id and v.source = 'camera'
      )
  `);
  return rows.map((row) => new Date(row.recording_from));
}

/** Whether a piece is in the box: once one is, the packing's camera stays (ledger audit N1). */
export async function hasAcceptedScan(tx: Tx, orgId: string, sessionId: string): Promise<boolean> {
  const [row] = await tx.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from packing.scans
      where org_id = ${orgId} and session_id = ${sessionId} and outcome = 'accepted'
    ) as found
  `);
  return row?.found === true;
}

/** Whether the camera's parts of this session are already filed (the cut is done). */
export async function cameraPartsOf(
  tx: Tx,
  orgId: string,
  sessionId: string,
): Promise<{ readonly id: string; readonly part: number }[]> {
  const rows = await tx.execute<{ id: string; part: number }>(sql`
    select id, part from packing.videos
    where org_id = ${orgId} and session_id = ${sessionId} and source = 'camera'
    order by part
  `);
  return [...rows];
}

/**
 * File one part cut from the camera's buffer: registered and attached in the caller's
 * transaction (the triggers of 0130 and 0135 still hold: a stored, private packing video of
 * this brand, on a packing this camera filmed, its window closed).
 */
export async function insertCameraPart(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly sessionId: string;
    readonly cameraId: string;
    readonly recordedBy: string;
    readonly startedAt: Date;
    /** The part's video, or null for a part that could not be filed (it reads as missing). */
    readonly file: {
      readonly fileId: string;
      readonly durationMs: number;
      readonly sizeBytes: number;
    } | null;
  },
): Promise<{ readonly id: string; readonly part: number }> {
  const inserted = await tx.execute<{ id: string; part: number }>(sql`
    insert into packing.videos
      (id, org_id, session_id, part, recorded_by, started_at, mime, source, camera_id)
    values (
      ${input.id}, ${input.orgId}, ${input.sessionId},
      (select coalesce(max(part), 0) + 1 from packing.videos
        where org_id = ${input.orgId} and session_id = ${input.sessionId}),
      ${input.recordedBy}, ${input.startedAt.toISOString()}::timestamptz, 'video/mp4', 'camera',
      ${input.cameraId}
    )
    returning id, part
  `);
  const row = inserted[0];
  if (row === undefined) throw new Error('a camera part was not registered');
  if (input.file === null) return row;
  const attached = await tx.execute<{ id: string }>(sql`
    update packing.videos
       set file_id = ${input.file.fileId}, duration_ms = ${input.file.durationMs},
           size_bytes = ${input.file.sizeBytes}, uploaded_at = now(), updated_at = now()
     where org_id = ${input.orgId} and id = ${input.id} and file_id is null
    returning id
  `);
  if (attached.length !== 1) throw new Error('a camera part’s file was not attached');
  return row;
}
