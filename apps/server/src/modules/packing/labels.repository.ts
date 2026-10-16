import type { Tx } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * The SQL behind M46's terminals, printers, print queue, lots and handover (D-800 to D-826). The
 * packing schema only; orders, people and locations are asked through their interfaces
 * (invariant 12). Every statement runs inside the caller's `withOrg()`.
 */

type Instant = Date | string;

// --- terminals ----------------------------------------------------------------------------------

export interface TerminalRow extends Record<string, unknown> {
  readonly id: string;
  readonly kind: 'packing' | 'label';
  readonly name: string;
  readonly location_id: string | null;
  readonly active: boolean;
  readonly updated_at: Instant;
}

const TERMINAL_COLUMNS = sql`id, kind, name, location_id, active, updated_at`;

export async function terminalsOf(tx: Tx, orgId: string): Promise<TerminalRow[]> {
  const rows = await tx.execute<TerminalRow>(sql`
    select ${TERMINAL_COLUMNS} from packing.terminals where org_id = ${orgId}
    order by kind, name, id
  `);
  return [...rows];
}

export async function terminalById(
  tx: Tx,
  orgId: string,
  id: string,
  options: { readonly forUpdate?: boolean; readonly forShare?: boolean } = {},
): Promise<TerminalRow | undefined> {
  const lock =
    options.forUpdate === true
      ? sql`for update`
      : options.forShare === true
        ? sql`for share`
        : sql``;
  const rows = await tx.execute<TerminalRow>(sql`
    select ${TERMINAL_COLUMNS} from packing.terminals where org_id = ${orgId} and id = ${id} ${lock}
  `);
  return rows[0];
}

export async function insertTerminal(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly kind: 'packing' | 'label';
    readonly name: string;
    readonly locationId: string | null;
    readonly active: boolean;
    readonly userId: string;
  },
): Promise<TerminalRow> {
  const rows = await tx.execute<TerminalRow>(sql`
    insert into packing.terminals (org_id, kind, name, location_id, active, created_by, updated_by)
    values (${input.orgId}, ${input.kind}, ${input.name}, ${input.locationId}::uuid, ${input.active},
            ${input.userId}, ${input.userId})
    returning ${TERMINAL_COLUMNS}
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('a terminal was not written');
  return row;
}

export async function updateTerminal(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly name: string;
    readonly locationId: string | null;
    readonly active: boolean;
    readonly userId: string;
  },
): Promise<TerminalRow | undefined> {
  const rows = await tx.execute<TerminalRow>(sql`
    update packing.terminals
       set name = ${input.name}, location_id = ${input.locationId}::uuid, active = ${input.active},
           updated_by = ${input.userId}, updated_at = now()
     where org_id = ${input.orgId} and id = ${input.id}
    returning ${TERMINAL_COLUMNS}
  `);
  return rows[0];
}

export interface MemberRow extends Record<string, unknown> {
  readonly terminal_id: string;
  readonly user_id: string;
  readonly assigned_at: Instant;
}

export async function membersOf(tx: Tx, orgId: string): Promise<MemberRow[]> {
  const rows = await tx.execute<MemberRow>(sql`
    select terminal_id, user_id, assigned_at from packing.terminal_members
    where org_id = ${orgId} order by assigned_at, user_id
  `);
  return [...rows];
}

/** The terminal's people become exactly these; returns who was added and who was taken off. */
export async function replaceMembers(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly terminalId: string;
    readonly userIds: readonly string[];
    readonly by: string;
  },
): Promise<{ readonly added: string[]; readonly removed: string[] }> {
  const ids = [...new Set(input.userIds)];
  const removed = await tx.execute<{ user_id: string }>(sql`
    delete from packing.terminal_members
     where org_id = ${input.orgId} and terminal_id = ${input.terminalId}
       and not (user_id = any (${sql.param(ids)}::text[]))
    returning user_id
  `);
  const added: string[] = [];
  for (const userId of ids) {
    const rows = await tx.execute<{ user_id: string }>(sql`
      insert into packing.terminal_members (org_id, terminal_id, user_id, assigned_by)
      values (${input.orgId}, ${input.terminalId}, ${userId}, ${input.by})
      on conflict do nothing
      returning user_id
    `);
    if (rows.length === 1) added.push(userId);
  }
  return { added, removed: removed.map((row) => row.user_id) };
}

export async function isMember(
  tx: Tx,
  orgId: string,
  terminalId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await tx.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from packing.terminal_members
      where org_id = ${orgId} and terminal_id = ${terminalId} and user_id = ${userId}
    ) as found
  `);
  return row?.found === true;
}

// --- bound computers (D-803) --------------------------------------------------------------------

export interface DeviceRow extends Record<string, unknown> {
  readonly id: string;
  readonly terminal_id: string;
  readonly label: string;
  readonly bound_by: string;
  readonly last_seen_at: Instant | null;
  readonly last_user_id: string | null;
  readonly user_since: Instant | null;
  readonly revoked_at: Instant | null;
  readonly created_at: Instant;
}

const DEVICE_COLUMNS = sql`id, terminal_id, label, bound_by, last_seen_at, last_user_id, user_since,
  revoked_at, created_at`;

export async function insertDevice(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly terminalId: string;
    readonly label: string;
    readonly tokenSha256: string;
    readonly by: string;
  },
): Promise<DeviceRow> {
  const rows = await tx.execute<DeviceRow>(sql`
    insert into packing.terminal_devices (org_id, terminal_id, label, token_sha256, bound_by)
    values (${input.orgId}, ${input.terminalId}, ${input.label}, ${input.tokenSha256}, ${input.by})
    returning ${DEVICE_COLUMNS}
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('a terminal device was not written');
  return row;
}

export async function deviceByToken(
  tx: Tx,
  orgId: string,
  tokenSha256: string,
): Promise<DeviceRow | undefined> {
  const rows = await tx.execute<DeviceRow>(sql`
    select ${DEVICE_COLUMNS} from packing.terminal_devices
    where org_id = ${orgId} and token_sha256 = ${tokenSha256}
  `);
  return rows[0];
}

export async function devicesOf(tx: Tx, orgId: string): Promise<DeviceRow[]> {
  const rows = await tx.execute<DeviceRow>(sql`
    select ${DEVICE_COLUMNS} from packing.terminal_devices
    where org_id = ${orgId} and revoked_at is null
    order by created_at
  `);
  return [...rows];
}

/**
 * A check-in from a bound computer: seen now, with who is signed in there. `user_since` starts
 * again when someone else signs in, or after a gap of more than 90 seconds.
 */
export async function touchDevice(
  tx: Tx,
  input: { readonly orgId: string; readonly id: string; readonly userId: string },
): Promise<void> {
  await tx.execute(sql`
    update packing.terminal_devices
       set user_since = case
             when last_user_id is distinct from ${input.userId}
               or last_seen_at is null or last_seen_at < now() - interval '90 seconds'
             then now() else user_since end,
           last_user_id = ${input.userId}, last_seen_at = now()
     where org_id = ${input.orgId} and id = ${input.id} and revoked_at is null
  `);
}

export async function revokeDevice(
  tx: Tx,
  input: { readonly orgId: string; readonly id: string; readonly by: string },
): Promise<DeviceRow | undefined> {
  const rows = await tx.execute<DeviceRow>(sql`
    update packing.terminal_devices set revoked_at = now(), revoked_by = ${input.by},
           updated_at = now()
     where org_id = ${input.orgId} and id = ${input.id} and revoked_at is null
    returning ${DEVICE_COLUMNS}
  `);
  return rows[0];
}

// --- a packing terminal's cameras (D-804) -------------------------------------------------------

export interface TerminalCameraRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly terminal_id: string | null;
  readonly enabled: boolean;
  readonly last_segment_at: Instant | null;
  readonly last_error_code: string | null;
}

/** Every camera in use with the terminal it films (or none). */
export async function camerasWithTerminals(tx: Tx, orgId: string): Promise<TerminalCameraRow[]> {
  const rows = await tx.execute<TerminalCameraRow>(sql`
    select id, name, terminal_id, enabled, last_segment_at, last_error_code from packing.cameras
    where org_id = ${orgId} and deleted_at is null
    order by name, id
  `);
  return [...rows];
}

/** The terminal films with exactly these cameras (in use, of this brand); others are let go. */
export async function setTerminalCameras(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly terminalId: string;
    readonly cameraIds: readonly string[];
  },
): Promise<string[]> {
  const ids = [...new Set(input.cameraIds)];
  await tx.execute(sql`
    update packing.cameras set terminal_id = null, updated_at = now()
     where org_id = ${input.orgId} and terminal_id = ${input.terminalId}
       and not (id = any (${sql.param(ids)}::uuid[]))
  `);
  const rows = await tx.execute<{ id: string }>(sql`
    update packing.cameras set terminal_id = ${input.terminalId}, updated_at = now()
     where org_id = ${input.orgId} and id = any (${sql.param(ids)}::uuid[]) and deleted_at is null
    returning id
  `);
  return rows.map((row) => row.id);
}

/** The terminal's cameras that record now, by name: the first is the session's camera. */
export async function recordingCamerasOf(
  tx: Tx,
  orgId: string,
  terminalId: string,
): Promise<{ readonly id: string; readonly name: string }[]> {
  const rows = await tx.execute<{ id: string; name: string }>(sql`
    select id, name from packing.cameras
    where org_id = ${orgId} and terminal_id = ${terminalId} and enabled and deleted_at is null
    order by name, id
    for share
  `);
  return [...rows];
}

export async function insertSessionCameras(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly sessionId: string;
    readonly cameraIds: readonly string[];
  },
): Promise<void> {
  for (const cameraId of input.cameraIds) {
    await tx.execute(sql`
      insert into packing.session_cameras (org_id, session_id, camera_id)
      values (${input.orgId}, ${input.sessionId}, ${cameraId})
      on conflict do nothing
    `);
  }
}

export async function sessionCamerasOf(
  tx: Tx,
  orgId: string,
  sessionIds: readonly string[],
): Promise<{ readonly session_id: string; readonly camera_id: string }[]> {
  if (sessionIds.length === 0) return [];
  const rows = await tx.execute<{ session_id: string; camera_id: string }>(sql`
    select session_id, camera_id from packing.session_cameras
    where org_id = ${orgId} and session_id = any (${sql.param([...sessionIds])}::uuid[])
    order by session_id, camera_id
  `);
  return [...rows];
}

/** Packings completed at each terminal since an instant (today's orders per hour, D-823). */
export async function completedSince(
  tx: Tx,
  orgId: string,
  since: Date,
): Promise<Map<string, number>> {
  const rows = await tx.execute<{ terminal_id: string; n: number }>(sql`
    select terminal_id, count(*)::int as n from packing.sessions
    where org_id = ${orgId} and terminal_id is not null and status = 'completed'
      and completed_at >= ${since.toISOString()}::timestamptz
    group by terminal_id
  `);
  return new Map(rows.map((row) => [row.terminal_id, row.n]));
}

/** The order each terminal is packing now (an open session started there). */
export async function openSessionsAtTerminals(
  tx: Tx,
  orgId: string,
): Promise<
  { readonly terminal_id: string; readonly order_no: string; readonly started_by: string }[]
> {
  const rows = await tx.execute<{ terminal_id: string; order_no: string; started_by: string }>(sql`
    select distinct on (terminal_id) terminal_id, order_no, started_by from packing.sessions
    where org_id = ${orgId} and terminal_id is not null and status = 'open'
    order by terminal_id, started_at desc
  `);
  return [...rows];
}

// --- printers (D-810) ---------------------------------------------------------------------------

export interface PrinterRow extends Record<string, unknown> {
  readonly id: string;
  readonly terminal_id: string;
  readonly name: string;
  readonly connection: 'ipp' | 'ipps' | 'raw' | 'browser';
  readonly language: 'pdf' | 'tspl' | 'zpl' | 'escpos';
  readonly host: string | null;
  readonly port: number | null;
  readonly ipp_path: string;
  readonly dpi: number;
  readonly medium: '4x6' | '100x150' | 'a5' | 'a4' | 'custom';
  readonly width_um: number;
  readonly height_um: number;
  readonly documents: string[];
  readonly copies: number;
  readonly username: string;
  readonly password_fingerprint: string | null;
  readonly enabled: boolean;
  readonly status: 'unknown' | 'online' | 'offline' | 'error';
  readonly status_detail: string | null;
  readonly status_at: Instant | null;
  readonly deleted_at: Instant | null;
  readonly updated_at: Instant;
}

const PRINTER_COLUMNS = sql`id, terminal_id, name, connection, language, host, port, ipp_path, dpi,
  medium, width_um, height_um, documents, copies, username, password_fingerprint, enabled, status,
  status_detail, status_at, deleted_at, updated_at`;

/** The brand's printers in use (a deleted one is gone from every list). Never the password. */
export async function printersOf(tx: Tx, orgId: string): Promise<PrinterRow[]> {
  const rows = await tx.execute<PrinterRow>(sql`
    select ${PRINTER_COLUMNS} from packing.printers
    where org_id = ${orgId} and deleted_at is null
    order by name, id
  `);
  return [...rows];
}

export async function printerById(
  tx: Tx,
  orgId: string,
  id: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<PrinterRow | undefined> {
  const rows = await tx.execute<PrinterRow>(sql`
    select ${PRINTER_COLUMNS} from packing.printers where org_id = ${orgId} and id = ${id}
    ${options.forUpdate === true ? sql`for update` : sql``}
  `);
  return rows[0];
}

/** A printer with its sealed password: for the worker's sender only. */
export async function printerSecret(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<Buffer | Uint8Array | null> {
  const rows = await tx.execute<{ password_sealed: Buffer | Uint8Array | null }>(sql`
    select password_sealed from packing.printers where org_id = ${orgId} and id = ${id}
  `);
  return rows[0]?.password_sealed ?? null;
}

export interface SealedSecret {
  readonly sealed: Buffer;
  readonly fingerprint: string;
  readonly keyId: string;
}

export interface PrinterWrite {
  readonly orgId: string;
  readonly terminalId: string;
  readonly name: string;
  readonly connection: string;
  readonly language: string;
  readonly host: string | null;
  readonly port: number | null;
  readonly ippPath: string;
  readonly dpi: number;
  readonly medium: string;
  readonly widthUm: number;
  readonly heightUm: number;
  readonly documents: readonly string[];
  readonly copies: number;
  readonly username: string;
  readonly enabled: boolean;
  readonly userId: string;
}

export async function insertPrinter(
  tx: Tx,
  input: PrinterWrite & { readonly id: string; readonly password: SealedSecret | null },
): Promise<PrinterRow> {
  const rows = await tx.execute<PrinterRow>(sql`
    insert into packing.printers
      (id, org_id, terminal_id, name, connection, language, host, port, ipp_path, dpi, medium,
       width_um, height_um, documents, copies, username, password_sealed, password_fingerprint,
       key_id, enabled, created_by, updated_by)
    values (${input.id}, ${input.orgId}, ${input.terminalId}, ${input.name}, ${input.connection},
            ${input.language}, ${input.host}, ${input.port}, ${input.ippPath}, ${input.dpi},
            ${input.medium}, ${input.widthUm}, ${input.heightUm},
            ${sql.param([...input.documents])}::text[], ${input.copies}, ${input.username},
            ${input.password?.sealed ?? null}, ${input.password?.fingerprint ?? null},
            ${input.password?.keyId ?? null}, ${input.enabled}, ${input.userId}, ${input.userId})
    returning ${PRINTER_COLUMNS}
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('a printer was not written');
  return row;
}

/** A printer's settings changed. `password` undefined keeps the sealed one; null removes it. */
export async function updatePrinter(
  tx: Tx,
  input: PrinterWrite & { readonly id: string; readonly password: SealedSecret | null | undefined },
): Promise<PrinterRow | undefined> {
  const password =
    input.password === undefined
      ? sql``
      : sql`, password_sealed = ${input.password?.sealed ?? null},
             password_fingerprint = ${input.password?.fingerprint ?? null},
             key_id = ${input.password?.keyId ?? null}`;
  const rows = await tx.execute<PrinterRow>(sql`
    update packing.printers
       set terminal_id = ${input.terminalId}, name = ${input.name}, connection = ${input.connection},
           language = ${input.language}, host = ${input.host}, port = ${input.port},
           ipp_path = ${input.ippPath}, dpi = ${input.dpi}, medium = ${input.medium},
           width_um = ${input.widthUm}, height_um = ${input.heightUm},
           documents = ${sql.param([...input.documents])}::text[], copies = ${input.copies},
           username = ${input.username}, enabled = ${input.enabled},
           status = case when host is distinct from ${input.host} or port is distinct from ${input.port}
                         then 'unknown' else status end,
           updated_by = ${input.userId}, updated_at = now()
           ${password}
     where org_id = ${input.orgId} and id = ${input.id} and deleted_at is null
    returning ${PRINTER_COLUMNS}
  `);
  return rows[0];
}

export async function deletePrinter(
  tx: Tx,
  input: { readonly orgId: string; readonly id: string; readonly userId: string },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update packing.printers
       set deleted_at = now(), deleted_by = ${input.userId}, enabled = false,
           password_sealed = null, password_fingerprint = null, key_id = null,
           updated_by = ${input.userId}, updated_at = now()
     where org_id = ${input.orgId} and id = ${input.id} and deleted_at is null
    returning id
  `);
  return rows.length === 1;
}

/** The worker's probe (D-815). Never touches the settings or `updated_at`. */
export async function reportPrinterStatus(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly status: 'online' | 'offline' | 'error';
    readonly detail: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    update packing.printers
       set status = ${input.status}, status_detail = ${input.detail?.slice(0, 200) ?? null},
           status_at = now()
     where org_id = ${input.orgId} and id = ${input.id} and deleted_at is null
  `);
}

// --- the print queue and log (D-813, D-818) -----------------------------------------------------

export interface JobRow extends Record<string, unknown> {
  readonly id: string;
  readonly order_id: string | null;
  readonly order_no: string;
  readonly document: 'label' | 'packing_slip' | 'test';
  readonly lot_no: number;
  readonly lot_count: number;
  readonly printer_id: string;
  readonly terminal_id: string;
  readonly source: 'auto' | 'manual' | 'reprint' | 'test';
  readonly reason: string | null;
  readonly requested_by: string | null;
  readonly copies: number;
  readonly consignment_no: string | null;
  readonly state: 'queued' | 'sending' | 'printed' | 'failed' | 'cancelled';
  readonly attempts: number;
  readonly last_error: string | null;
  readonly created_at: Instant;
  readonly sending_at: Instant | null;
  readonly printed_at: Instant | null;
  readonly failed_at: Instant | null;
  readonly cancelled_at: Instant | null;
  readonly device_id: string | null;
  readonly confirmed_by: string | null;
}

const JOB_COLUMNS = sql`id, order_id, order_no, document, lot_no, lot_count, printer_id, terminal_id,
  source, reason, requested_by, copies, consignment_no, state, attempts, last_error, created_at,
  sending_at, printed_at, failed_at, cancelled_at, device_id, confirmed_by`;

export interface JobInsert {
  readonly orgId: string;
  readonly orderId: string | null;
  readonly orderNo: string;
  readonly document: 'label' | 'packing_slip' | 'test';
  readonly lotNo: number;
  readonly lotCount: number;
  readonly printerId: string;
  readonly terminalId: string;
  readonly source: 'auto' | 'manual' | 'reprint' | 'test';
  readonly reason: string | null;
  readonly requestedBy: string | null;
  readonly copies: number;
  readonly consignmentNo: string | null;
  readonly autoKey: string | null;
}

/** A job, or nothing when the auto-print rule already queued this one (its key). */
export async function insertJob(tx: Tx, input: JobInsert): Promise<JobRow | undefined> {
  const rows = await tx.execute<JobRow>(sql`
    insert into packing.print_jobs
      (org_id, order_id, order_no, document, lot_no, lot_count, printer_id, terminal_id, source,
       reason, requested_by, copies, consignment_no, auto_key)
    values (${input.orgId}, ${input.orderId}::uuid, ${input.orderNo}, ${input.document},
            ${input.lotNo}, ${input.lotCount}, ${input.printerId}, ${input.terminalId},
            ${input.source}, ${input.reason}, ${input.requestedBy}, ${input.copies},
            ${input.consignmentNo}, ${input.autoKey})
    on conflict (org_id, auto_key) do nothing
    returning ${JOB_COLUMNS}
  `);
  return rows[0];
}

export async function jobById(
  tx: Tx,
  orgId: string,
  id: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<JobRow | undefined> {
  const rows = await tx.execute<JobRow>(sql`
    select ${JOB_COLUMNS} from packing.print_jobs where org_id = ${orgId} and id = ${id}
    ${options.forUpdate === true ? sql`for update` : sql``}
  `);
  return rows[0];
}

/** A send begins: one more attempt, from queued (or a `sending` a dead worker left). */
export async function markSending(
  tx: Tx,
  input: { readonly orgId: string; readonly id: string; readonly staleBefore: Date },
): Promise<JobRow | undefined> {
  const rows = await tx.execute<JobRow>(sql`
    update packing.print_jobs
       set state = 'sending', attempts = attempts + 1, sending_at = now(), updated_at = now()
     where org_id = ${input.orgId} and id = ${input.id}
       and (state = 'queued'
            or (state = 'sending' and sending_at < ${input.staleBefore.toISOString()}::timestamptz))
       and attempts < 20
    returning ${JOB_COLUMNS}
  `);
  return rows[0];
}

export async function markPrinted(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly deviceId?: string | null;
    readonly confirmedBy?: string | null;
  },
): Promise<JobRow | undefined> {
  const rows = await tx.execute<JobRow>(sql`
    update packing.print_jobs
       set state = 'printed', printed_at = now(), last_error = null,
           device_id = coalesce(${input.deviceId ?? null}::uuid, device_id),
           confirmed_by = coalesce(${input.confirmedBy ?? null}, confirmed_by), updated_at = now()
     where org_id = ${input.orgId} and id = ${input.id} and state in ('sending', 'queued')
    returning ${JOB_COLUMNS}
  `);
  return rows[0];
}

/** An attempt failed: back to queued for the next try, or failed for good. */
export async function markAttemptFailed(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly error: string;
    readonly final: boolean;
    readonly deviceId?: string | null;
    readonly confirmedBy?: string | null;
  },
): Promise<JobRow | undefined> {
  const rows = await tx.execute<JobRow>(sql`
    update packing.print_jobs
       set state = ${input.final ? 'failed' : 'queued'},
           failed_at = case when ${input.final} then now() else failed_at end,
           last_error = ${input.error.slice(0, 300)},
           device_id = coalesce(${input.deviceId ?? null}::uuid, device_id),
           confirmed_by = coalesce(${input.confirmedBy ?? null}, confirmed_by), updated_at = now()
     where org_id = ${input.orgId} and id = ${input.id} and state in ('sending', 'queued')
    returning ${JOB_COLUMNS}
  `);
  return rows[0];
}

export async function requeueFailed(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<JobRow | undefined> {
  const rows = await tx.execute<JobRow>(sql`
    update packing.print_jobs
       set state = 'queued', attempts = 0, failed_at = null, updated_at = now()
     where org_id = ${orgId} and id = ${id} and state = 'failed'
    returning ${JOB_COLUMNS}
  `);
  return rows[0];
}

export async function cancelJob(tx: Tx, orgId: string, id: string): Promise<JobRow | undefined> {
  const rows = await tx.execute<JobRow>(sql`
    update packing.print_jobs set state = 'cancelled', cancelled_at = now(), updated_at = now()
     where org_id = ${orgId} and id = ${id} and state in ('queued', 'failed')
    returning ${JOB_COLUMNS}
  `);
  return rows[0];
}

/** Jobs queued or sending on each terminal: the queue the auto-print rule balances (D-817). */
export async function openJobsByTerminal(tx: Tx, orgId: string): Promise<Map<string, number>> {
  const rows = await tx.execute<{ terminal_id: string; n: number }>(sql`
    select terminal_id, count(*)::int as n from packing.print_jobs
    where org_id = ${orgId} and state in ('queued', 'sending')
    group by terminal_id
  `);
  return new Map(rows.map((row) => [row.terminal_id, row.n]));
}

/** The browser station's work: its terminal's queued jobs on browser printers, oldest first. */
export async function stationJobs(
  tx: Tx,
  orgId: string,
  terminalId: string,
  orderInScope: SQL,
): Promise<JobRow[]> {
  const rows = await tx.execute<JobRow>(sql`
    select j.id, j.order_id, j.order_no, j.document, j.lot_no, j.lot_count, j.printer_id,
           j.terminal_id, j.source, j.reason, j.requested_by, j.copies, j.consignment_no, j.state,
           j.attempts, j.last_error, j.created_at, j.sending_at, j.printed_at, j.failed_at,
           j.cancelled_at, j.device_id, j.confirmed_by
    from packing.print_jobs j
    join packing.printers p on p.org_id = j.org_id and p.id = j.printer_id
    where j.org_id = ${orgId} and j.terminal_id = ${terminalId} and p.connection = 'browser'
      and j.state in ('queued', 'sending')
      and (j.order_id is null or ${orderInScope})
    order by j.created_at
    limit 50
  `);
  return [...rows];
}

export interface JobFilters {
  readonly view: 'queue' | 'log';
  readonly state?: string | undefined;
  readonly source?: string | undefined;
  readonly orderId?: string | undefined;
  readonly terminalId?: string | undefined;
  readonly printerId?: string | undefined;
  readonly q?: string | undefined;
  /** Asia/Dhaka calendar dates (invariant 8). */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly limit: number;
  readonly offset: number;
  /** The orders module's condition on `j.order_id` (the caller's scope), or test pages. */
  readonly orderInScope: SQL;
}

function jobWhere(orgId: string, filters: JobFilters): SQL {
  const pattern = filters.q === undefined ? undefined : `%${filters.q.replace(/[\\%_]/g, '\\$&')}%`;
  return sql`j.org_id = ${orgId}
    and (j.order_id is null or ${filters.orderInScope})
    and ${filters.view === 'queue' ? sql`j.state in ('queued', 'sending', 'failed')` : sql`true`}
    and ${filters.state === undefined ? sql`true` : sql`j.state = ${filters.state}`}
    and ${filters.source === undefined ? sql`true` : sql`j.source = ${filters.source}`}
    and ${filters.orderId === undefined ? sql`true` : sql`j.order_id = ${filters.orderId}::uuid`}
    and ${filters.terminalId === undefined ? sql`true` : sql`j.terminal_id = ${filters.terminalId}::uuid`}
    and ${filters.printerId === undefined ? sql`true` : sql`j.printer_id = ${filters.printerId}::uuid`}
    and ${pattern === undefined ? sql`true` : sql`j.order_no ilike ${pattern}`}
    and ${
      filters.from === undefined
        ? sql`true`
        : sql`(j.created_at at time zone 'Asia/Dhaka')::date >= ${filters.from}::date`
    }
    and ${
      filters.to === undefined
        ? sql`true`
        : sql`(j.created_at at time zone 'Asia/Dhaka')::date <= ${filters.to}::date`
    }`;
}

export async function jobsPage(
  tx: Tx,
  orgId: string,
  filters: JobFilters,
): Promise<{ readonly rows: JobRow[]; readonly total: number }> {
  const where = jobWhere(orgId, filters);
  const rows = await tx.execute<JobRow>(sql`
    select j.id, j.order_id, j.order_no, j.document, j.lot_no, j.lot_count, j.printer_id,
           j.terminal_id, j.source, j.reason, j.requested_by, j.copies, j.consignment_no, j.state,
           j.attempts, j.last_error, j.created_at, j.sending_at, j.printed_at, j.failed_at,
           j.cancelled_at, j.device_id, j.confirmed_by
    from packing.print_jobs j
    where ${where}
    order by j.created_at desc, j.id
    limit ${filters.limit} offset ${filters.offset}
  `);
  const [count] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from packing.print_jobs j where ${where}
  `);
  return { rows: [...rows], total: count?.n ?? 0 };
}

/** Every print of these orders, oldest first: the order's and each lot's history (D-818). */
export async function jobsOfOrders(
  tx: Tx,
  orgId: string,
  orderIds: readonly string[],
): Promise<JobRow[]> {
  if (orderIds.length === 0) return [];
  const rows = await tx.execute<JobRow>(sql`
    select ${JOB_COLUMNS} from packing.print_jobs
    where org_id = ${orgId} and order_id = any (${sql.param([...orderIds])}::uuid[])
    order by created_at, id
  `);
  return [...rows];
}

/** How many times each order's document and lot has printed. */
export async function printedCounts(
  tx: Tx,
  orgId: string,
  orderIds: readonly string[],
): Promise<Map<string, number>> {
  if (orderIds.length === 0) return new Map();
  // A page printed for another lot count ("Lot 1 of 2" when there are now 3) is not this
  // order's page any more: only prints at the order's current count are counted (D-805).
  const rows = await tx.execute<{
    order_id: string;
    document: string;
    lot_no: number;
    n: number;
  }>(sql`
    select j.order_id, j.document, j.lot_no, count(*)::int as n from packing.print_jobs j
    left join packing.order_lots ol on ol.org_id = j.org_id and ol.order_id = j.order_id
    where j.org_id = ${orgId} and j.order_id = any (${sql.param([...orderIds])}::uuid[])
      and j.state = 'printed' and j.lot_count = coalesce(ol.lot_count, 1)
    group by j.order_id, j.document, j.lot_no
  `);
  return new Map(
    rows.map((row) => [`${row.order_id}:${row.document}:${String(row.lot_no)}`, row.n]),
  );
}

// --- the auto-print rule and the orders ready for a label (D-817) -------------------------------

export interface LabelSettingsRow extends Record<string, unknown> {
  readonly auto_print: boolean | null;
  readonly auto_slip: boolean;
  readonly updated_at: Instant;
}

export async function labelSettingsOf(
  tx: Tx,
  orgId: string,
): Promise<LabelSettingsRow | undefined> {
  const rows = await tx.execute<LabelSettingsRow>(sql`
    select auto_print, auto_slip, updated_at from packing.label_settings where org_id = ${orgId}
  `);
  return rows[0];
}

export async function saveLabelSettings(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly autoPrint: boolean;
    readonly autoSlip: boolean;
    readonly userId: string;
  },
): Promise<LabelSettingsRow> {
  const rows = await tx.execute<LabelSettingsRow>(sql`
    insert into packing.label_settings (org_id, auto_print, auto_slip, updated_by)
    values (${input.orgId}, ${input.autoPrint}, ${input.autoSlip}, ${input.userId})
    on conflict (org_id) do update
       set auto_print = excluded.auto_print, auto_slip = excluded.auto_slip,
           updated_by = excluded.updated_by, updated_at = now()
    returning auto_print, auto_slip, updated_at
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('the label settings were not saved');
  return row;
}

export async function upsertLabelOrder(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly consignmentNo: string;
    readonly at: Date;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into packing.label_orders (org_id, order_id, consignment_no, booked_at)
    values (${input.orgId}, ${input.orderId}, ${input.consignmentNo.slice(0, 120)},
            ${input.at.toISOString()}::timestamptz)
    on conflict (org_id, order_id) do update
       set consignment_no = excluded.consignment_no, booked_at = excluded.booked_at,
           updated_at = now()
  `);
}

export async function fillLabelOrder(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly orderNo: string;
    readonly locationId: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    update packing.label_orders set order_no = ${input.orderNo},
           location_id = ${input.locationId}::uuid, updated_at = now()
     where org_id = ${input.orgId} and order_id = ${input.orderId}
  `);
}

export interface LabelOrderRow extends Record<string, unknown> {
  readonly order_id: string;
  readonly order_no: string;
  readonly consignment_no: string;
  readonly location_id: string | null;
  readonly booked_at: Instant;
  readonly lot_count: number;
  readonly labels_printed: number;
}

/**
 * Booked orders with a lot whose label has not printed yet, oldest booking first, inside the
 * caller's scope (`orderInScope` on `lo.order_id`). The order's status is the caller's to check.
 */
export async function labelOrdersReady(
  tx: Tx,
  orgId: string,
  options: {
    readonly locationId: string | undefined;
    readonly limit: number;
    readonly orderInScope: SQL;
  },
): Promise<LabelOrderRow[]> {
  const rows = await tx.execute<LabelOrderRow>(sql`
    select lo.order_id, lo.order_no, lo.consignment_no, lo.location_id, lo.booked_at,
           coalesce(ol.lot_count, 1) as lot_count,
           (select count(distinct j.lot_no)::int from packing.print_jobs j
             where j.org_id = lo.org_id and j.order_id = lo.order_id and j.document = 'label'
               and j.state = 'printed' and j.lot_count = coalesce(ol.lot_count, 1)) as labels_printed
    from packing.label_orders lo
    left join packing.order_lots ol on ol.org_id = lo.org_id and ol.order_id = lo.order_id
    where lo.org_id = ${orgId}
      and ${options.orderInScope}
      and ${
        options.locationId === undefined
          ? sql`true`
          : sql`(lo.location_id = ${options.locationId}::uuid or lo.location_id is null)`
      }
      and (select count(distinct j.lot_no) from packing.print_jobs j
            where j.org_id = lo.org_id and j.order_id = lo.order_id and j.document = 'label'
              and j.state = 'printed' and j.lot_count = coalesce(ol.lot_count, 1))
          < coalesce(ol.lot_count, 1)
    order by lo.booked_at, lo.order_id
    limit ${options.limit}
  `);
  return [...rows];
}

export async function labelOrderOf(
  tx: Tx,
  orgId: string,
  orderIds: readonly string[],
): Promise<Map<string, { readonly consignmentNo: string; readonly bookedAt: Date }>> {
  if (orderIds.length === 0) return new Map();
  const rows = await tx.execute<{
    order_id: string;
    consignment_no: string;
    booked_at: Instant;
  }>(sql`
    select order_id, consignment_no, booked_at from packing.label_orders
    where org_id = ${orgId} and order_id = any (${sql.param([...orderIds])}::uuid[])
  `);
  return new Map(
    rows.map((row) => [
      row.order_id,
      { consignmentNo: row.consignment_no, bookedAt: new Date(row.booked_at) },
    ]),
  );
}

// --- lots (D-805 to D-808) ----------------------------------------------------------------------

/** One change to an order's lots at a time: its count, its handover scans (D-805). */
export async function lockOrderLots(tx: Tx, orgId: string, orderId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`packing.lots:${orgId}:${orderId}`}, 0))`,
  );
}

export async function lotCounts(
  tx: Tx,
  orgId: string,
  orderIds: readonly string[],
): Promise<Map<string, number>> {
  if (orderIds.length === 0) return new Map();
  const rows = await tx.execute<{ order_id: string; lot_count: number }>(sql`
    select order_id, lot_count from packing.order_lots
    where org_id = ${orgId} and order_id = any (${sql.param([...orderIds])}::uuid[])
  `);
  return new Map(rows.map((row) => [row.order_id, row.lot_count]));
}

export async function lotCountOf(tx: Tx, orgId: string, orderId: string): Promise<number> {
  return (await lotCounts(tx, orgId, [orderId])).get(orderId) ?? 1;
}

export async function setLotCount(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly count: number;
    readonly by: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into packing.order_lots (org_id, order_id, lot_count, set_by)
    values (${input.orgId}, ${input.orderId}, ${input.count}, ${input.by})
    on conflict (org_id, order_id) do update
       set lot_count = excluded.lot_count, set_by = excluded.set_by, updated_at = now()
  `);
}

export interface ClosureRow extends Record<string, unknown> {
  readonly lot_no: number;
  readonly closed_by: string;
  readonly closed_at: Instant;
}

export async function closuresOf(tx: Tx, orgId: string, sessionId: string): Promise<ClosureRow[]> {
  const rows = await tx.execute<ClosureRow>(sql`
    select lot_no, closed_by, closed_at from packing.lot_closures
    where org_id = ${orgId} and session_id = ${sessionId}
    order by lot_no
  `);
  return [...rows];
}

export async function closureCountsOfOrders(
  tx: Tx,
  orgId: string,
  orderIds: readonly string[],
): Promise<Map<string, number>> {
  if (orderIds.length === 0) return new Map();
  const rows = await tx.execute<{ order_id: string; n: number }>(sql`
    select s.order_id, count(c.lot_no)::int as n
    from packing.sessions s
    join packing.lot_closures c on c.org_id = s.org_id and c.session_id = s.id
    where s.org_id = ${orgId} and s.order_id = any (${sql.param([...orderIds])}::uuid[])
    group by s.order_id
  `);
  return new Map(rows.map((row) => [row.order_id, row.n]));
}

export async function insertClosure(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly sessionId: string;
    readonly lotNo: number;
    readonly by: string;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ lot_no: number }>(sql`
    insert into packing.lot_closures (org_id, session_id, lot_no, closed_by)
    values (${input.orgId}, ${input.sessionId}, ${input.lotNo}, ${input.by})
    on conflict do nothing
    returning lot_no
  `);
  return rows.length === 1;
}

export interface HandoverScanRow extends Record<string, unknown> {
  readonly order_id: string;
  readonly lot_no: number;
  readonly scanned_by: string;
  readonly scanned_at: Instant;
}

export async function handoverScansOf(
  tx: Tx,
  orgId: string,
  orderIds: readonly string[],
): Promise<HandoverScanRow[]> {
  if (orderIds.length === 0) return [];
  const rows = await tx.execute<HandoverScanRow>(sql`
    select order_id, lot_no, scanned_by, scanned_at from packing.handover_scans
    where org_id = ${orgId} and order_id = any (${sql.param([...orderIds])}::uuid[])
    order by scanned_at, lot_no
  `);
  return [...rows];
}

export async function insertHandoverScan(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly lotNo: number;
    readonly code: string;
    readonly by: string;
    readonly terminalId: string | null;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ lot_no: number }>(sql`
    insert into packing.handover_scans (org_id, order_id, lot_no, code, scanned_by, terminal_id)
    values (${input.orgId}, ${input.orderId}, ${input.lotNo}, ${input.code.slice(0, 120)},
            ${input.by}, ${input.terminalId}::uuid)
    on conflict do nothing
    returning lot_no
  `);
  return rows.length === 1;
}

/** Orders with a handover scan in the last day: the handover's list until they ship. */
export async function recentHandoverOrders(tx: Tx, orgId: string): Promise<string[]> {
  const rows = await tx.execute<{ order_id: string }>(sql`
    select order_id from packing.handover_scans
    where org_id = ${orgId} and scanned_at > now() - interval '1 day'
    group by order_id
    order by min(scanned_at)
    limit 300
  `);
  return rows.map((row) => row.order_id);
}
