import type { Tx } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * The SQL behind the packing station and the packing video (M38b, D-610 to D-615). Its own
 * schema only; orders, the catalog and files are asked through their interfaces (invariant 12).
 * Every statement runs inside the caller's `withOrg()`.
 */

export interface SessionRow extends Record<string, unknown> {
  readonly id: string;
  readonly order_id: string;
  readonly order_no: string;
  readonly status: 'open' | 'completed';
  readonly video_required: boolean;
  readonly started_by: string;
  readonly started_at: Date | string;
  readonly completed_by: string | null;
  readonly completed_at: Date | string | null;
  /** M38c (D-670, D-671): the IP camera filming it, and the recording's window. */
  readonly camera_id: string | null;
  readonly recording_from: Date | string | null;
  readonly recording_to: Date | string | null;
  readonly recording_by: string | null;
}

const SESSION_COLUMNS = sql`id, order_id, order_no, status, video_required, started_by, started_at,
  completed_by, completed_at, camera_id, recording_from, recording_to, recording_by`;

export async function sessionById(
  tx: Tx,
  orgId: string,
  id: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<SessionRow | undefined> {
  const rows = await tx.execute<SessionRow>(sql`
    select ${SESSION_COLUMNS} from packing.sessions where org_id = ${orgId} and id = ${id}
    ${options.forUpdate === true ? sql`for update` : sql``}
  `);
  return rows[0];
}

export async function sessionByOrder(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<SessionRow | undefined> {
  const rows = await tx.execute<SessionRow>(sql`
    select ${SESSION_COLUMNS} from packing.sessions where org_id = ${orgId} and order_id = ${orderId}
  `);
  return rows[0];
}

/** Open the order's session, or find the one another packer opened a moment ago. */
export async function openSession(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly orderNo: string;
    readonly videoRequired: boolean;
    readonly startedBy: string;
  },
): Promise<{ readonly row: SessionRow; readonly created: boolean }> {
  const inserted = await tx.execute<SessionRow>(sql`
    insert into packing.sessions (org_id, order_id, order_no, video_required, started_by)
    values (${input.orgId}, ${input.orderId}, ${input.orderNo}, ${input.videoRequired},
            ${input.startedBy})
    on conflict (org_id, order_id) do nothing
    returning ${SESSION_COLUMNS}
  `);
  const row = inserted[0];
  if (row !== undefined) return { row, created: true };
  const existing = await sessionByOrder(tx, input.orgId, input.orderId);
  if (existing === undefined) throw new Error('a packing session was neither written nor found');
  return { row: existing, created: false };
}

export async function completeSession(
  tx: Tx,
  orgId: string,
  id: string,
  userId: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update packing.sessions
       set status = 'completed', completed_by = ${userId}, completed_at = now(), updated_at = now()
     where org_id = ${orgId} and id = ${id} and status = 'open'
    returning id
  `);
  return rows.length === 1;
}

export interface ScanRow extends Record<string, unknown> {
  readonly id: string;
  readonly scan_id: string;
  readonly code: string;
  readonly sku_id: string | null;
  readonly outcome: string;
  readonly scanned_by: string;
  readonly scanned_at: Date | string;
}

const SCAN_COLUMNS = sql`id, scan_id, code, sku_id, outcome, scanned_by, scanned_at`;

/** Every scan of a session, oldest first. */
export async function scansOf(tx: Tx, orgId: string, sessionId: string): Promise<ScanRow[]> {
  const rows = await tx.execute<ScanRow>(sql`
    select ${SCAN_COLUMNS} from packing.scans
    where org_id = ${orgId} and session_id = ${sessionId}
    order by scanned_at, id
  `);
  return [...rows];
}

export async function scanByScanId(
  tx: Tx,
  orgId: string,
  sessionId: string,
  scanId: string,
): Promise<ScanRow | undefined> {
  const rows = await tx.execute<ScanRow>(sql`
    select ${SCAN_COLUMNS} from packing.scans
    where org_id = ${orgId} and session_id = ${sessionId} and scan_id = ${scanId}
  `);
  return rows[0];
}

export async function insertScan(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly sessionId: string;
    readonly scanId: string;
    readonly code: string;
    readonly skuId: string | null;
    readonly outcome: string;
    readonly scannedBy: string;
  },
): Promise<ScanRow> {
  const rows = await tx.execute<ScanRow>(sql`
    insert into packing.scans (org_id, session_id, scan_id, code, sku_id, outcome, scanned_by)
    values (${input.orgId}, ${input.sessionId}, ${input.scanId}, ${input.code}, ${input.skuId},
            ${input.outcome}, ${input.scannedBy})
    returning ${SCAN_COLUMNS}
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('a packing scan was not written');
  return row;
}

/**
 * How many packing scans name any of these SKUs (M38b audit, D-621): a scan is the record of
 * what went into a box, so a SKU that was scanned keeps its row.
 */
export async function scansForSkus(
  tx: Tx,
  orgId: string,
  skuIds: readonly string[],
): Promise<number> {
  if (skuIds.length === 0) return 0;
  const rows = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from packing.scans
    where org_id = ${orgId} and sku_id = any (${sql.param([...skuIds])}::uuid[])
  `);
  return rows[0]?.n ?? 0;
}

export interface VideoRow extends Record<string, unknown> {
  readonly id: string;
  readonly session_id: string;
  readonly part: number;
  readonly recorded_by: string;
  readonly started_at: Date | string;
  readonly mime: string;
  readonly file_id: string | null;
  readonly duration_ms: number | null;
  readonly size_bytes: string | null;
  readonly uploaded_at: Date | string | null;
  readonly deleted_at: Date | string | null;
  readonly deleted_reason: string | null;
  readonly deleted_file_id: string | null;
  /** M38c (D-674): `browser` or `camera`, and which camera. */
  readonly source: 'browser' | 'camera';
  readonly camera_id: string | null;
}

const VIDEO_COLUMNS = sql`id, session_id, part, recorded_by, started_at, mime, file_id, duration_ms,
  size_bytes::text as size_bytes, uploaded_at, deleted_at, deleted_reason, deleted_file_id, source,
  camera_id`;

export async function videosOf(
  tx: Tx,
  orgId: string,
  sessionIds: readonly string[],
): Promise<VideoRow[]> {
  if (sessionIds.length === 0) return [];
  const rows = await tx.execute<VideoRow>(sql`
    select ${VIDEO_COLUMNS} from packing.videos
    where org_id = ${orgId} and session_id = any (${sql.param([...sessionIds])}::uuid[])
    order by session_id, part
  `);
  return [...rows];
}

export async function videoById(
  tx: Tx,
  orgId: string,
  id: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<VideoRow | undefined> {
  const rows = await tx.execute<VideoRow>(sql`
    select ${VIDEO_COLUMNS} from packing.videos where org_id = ${orgId} and id = ${id}
    ${options.forUpdate === true ? sql`for update` : sql``}
  `);
  return rows[0];
}

/** Register a part under the browser's id, numbered after the session's others. */
export async function insertVideo(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly sessionId: string;
    readonly recordedBy: string;
    readonly startedAt: Date;
    readonly mime: string;
  },
): Promise<VideoRow> {
  const rows = await tx.execute<VideoRow>(sql`
    insert into packing.videos (id, org_id, session_id, part, recorded_by, started_at, mime)
    values (
      ${input.id}, ${input.orgId}, ${input.sessionId},
      (select coalesce(max(part), 0) + 1 from packing.videos
        where org_id = ${input.orgId} and session_id = ${input.sessionId}),
      ${input.recordedBy}, ${input.startedAt.toISOString()}::timestamptz, ${input.mime}
    )
    returning ${VIDEO_COLUMNS}
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('a packing video was not registered');
  return row;
}

export async function attachVideoFile(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly fileId: string;
    readonly durationMs: number;
    readonly sizeBytes: number;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update packing.videos
       set file_id = ${input.fileId}, duration_ms = ${input.durationMs},
           size_bytes = ${input.sizeBytes}, uploaded_at = now(), updated_at = now()
     where org_id = ${input.orgId} and id = ${input.id} and file_id is null and deleted_at is null
    returning id
  `);
  return rows.length === 1;
}

/** The retention job's record: the file gone, which file and why (D-612). */
export async function markVideoDeleted(
  tx: Tx,
  input: { readonly orgId: string; readonly id: string; readonly reason: string },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update packing.videos
       set deleted_file_id = file_id, file_id = null, deleted_at = now(),
           deleted_reason = ${input.reason}, updated_at = now()
     where org_id = ${input.orgId} and id = ${input.id} and file_id is not null
    returning id
  `);
  return rows.length === 1;
}

/** Every part that still holds a file, with its session's order: what retention looks at. */
export async function attachedVideos(
  tx: Tx,
  orgId: string,
): Promise<
  { readonly id: string; readonly file_id: string; readonly order_id: string; session_id: string }[]
> {
  const rows = await tx.execute<{
    id: string;
    file_id: string;
    order_id: string;
    session_id: string;
  }>(sql`
    select v.id, v.file_id, s.order_id, v.session_id
    from packing.videos v
    join packing.sessions s on s.org_id = v.org_id and s.id = v.session_id
    where v.org_id = ${orgId} and v.file_id is not null
    order by v.created_at
  `);
  return [...rows];
}

/**
 * Of these files, the ones a part still names: attached, or deleted by retention (M38b audit,
 * the orphan sweep). Whatever is not returned belongs to no recording.
 */
export async function referencedFileIds(
  tx: Tx,
  orgId: string,
  fileIds: readonly string[],
): Promise<Set<string>> {
  if (fileIds.length === 0) return new Set();
  const ids = sql`(${sql.param([...fileIds])}::uuid[])`;
  const rows = await tx.execute<{ id: string }>(sql`
    select file_id as id from packing.videos
    where org_id = ${orgId} and file_id = any ${ids}
    union
    select deleted_file_id as id from packing.videos
    where org_id = ${orgId} and deleted_file_id = any ${ids}
  `);
  return new Set(rows.map((row) => row.id));
}

export interface SessionSummaryRow extends SessionRow {
  readonly scans: number;
  readonly accepted: number;
  readonly removed: number;
  readonly mismatches: number;
}

/**
 * The newest sessions with their scan counts, for the recent list, of orders `orderInScope`
 * admits: the orders module's condition on `s.order_id` (the caller's scope), applied before
 * the limit so a sales agent sees their own newest, not their share of everyone's.
 */
export async function recentSessions(
  tx: Tx,
  orgId: string,
  options: {
    readonly limit: number;
    readonly status: 'open' | 'completed' | undefined;
    readonly orderInScope: SQL;
  },
): Promise<SessionSummaryRow[]> {
  const rows = await tx.execute<SessionSummaryRow>(sql`
    select s.id, s.order_id, s.order_no, s.status, s.video_required, s.started_by, s.started_at,
           s.completed_by, s.completed_at, s.camera_id, s.recording_from, s.recording_to,
           s.recording_by,
           count(c.id)::int as scans,
           count(c.id) filter (where c.outcome = 'accepted')::int as accepted,
           count(c.id) filter (where c.outcome = 'removed')::int as removed,
           count(c.id) filter (
             where c.outcome in ('unknown_code', 'wrong_item', 'wrong_variant', 'over')
           )::int as mismatches
    from packing.sessions s
    left join packing.scans c on c.org_id = s.org_id and c.session_id = s.id
    where s.org_id = ${orgId}
      and ${options.orderInScope}
      ${options.status === undefined ? sql`` : sql`and s.status = ${options.status}`}
    group by s.id
    order by s.started_at desc, s.id
    limit ${options.limit}
  `);
  return [...rows];
}

export interface SettingsRow extends Record<string, unknown> {
  readonly video_enabled: boolean;
  readonly updated_by: string;
  readonly updated_at: Date | string;
}

export async function settingsOf(tx: Tx, orgId: string): Promise<SettingsRow | undefined> {
  const rows = await tx.execute<SettingsRow>(sql`
    select video_enabled, updated_by, updated_at from packing.settings where org_id = ${orgId}
  `);
  return rows[0];
}

export async function saveSettings(
  tx: Tx,
  input: { readonly orgId: string; readonly videoEnabled: boolean; readonly userId: string },
): Promise<SettingsRow> {
  const rows = await tx.execute<SettingsRow>(sql`
    insert into packing.settings (org_id, video_enabled, updated_by)
    values (${input.orgId}, ${input.videoEnabled}, ${input.userId})
    on conflict (org_id) do update
       set video_enabled = excluded.video_enabled, updated_by = excluded.updated_by,
           updated_at = now()
    returning video_enabled, updated_by, updated_at
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('the packing settings were not saved');
  return row;
}

/** Whether `userId` scanned any piece in this session (a participant of its packing). */
export async function scannedInSession(
  tx: Tx,
  orgId: string,
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await tx.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from packing.scans
      where org_id = ${orgId} and session_id = ${sessionId} and scanned_by = ${userId}
    ) as found
  `);
  return row?.found === true;
}
