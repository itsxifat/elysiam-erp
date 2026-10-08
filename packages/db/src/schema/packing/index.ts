import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { skus } from '../catalog/index.js';
import { primaryId, timestamps } from '../columns.js';
import { fileObjects } from '../files/index.js';
import { users } from '../iam/index.js';
import { orders } from '../orders/index.js';
import { organizations } from '../org/index.js';

/**
 * Packing (M35b, D-554): the scanner phones staff pack parcels with; M38b's packing station,
 * its scans, the packing videos and the brand's packing settings (D-610 to D-615); M38c's IP
 * cameras over the packing tables (D-668 to D-676).
 *
 * Tenant tables with the full treatment (invariant 4).
 */
export const packing = pgSchema('packing');

/**
 * A scanner device's sign-in (D-554): the old site's 30-day bearer token, kept as a SHA-256
 * and revocable, for one staff member in one brand. The token itself carries the brand's id
 * (`sdt_<org id>_…`) so it is looked up inside that brand only. The person's roles are read
 * again on every request, so a deactivated account or a role taken away stops the phone at
 * once; revoking ends the device whatever its expiry says.
 */
export const scannerDevices = packing.table(
  'scanner_devices',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    label: text('label').notNull(),
    tokenSha256: text('token_sha256').notNull(),
    /** `password` (signed in on the phone) or `console` (paired from a signed-in console). */
    via: text('via').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedBy: text('revoked_by'),
    ...timestamps,
  },
  (table) => [
    unique('scanner_devices_org_id_id_key').on(table.orgId, table.id),
    index('scanner_devices_org_idx').on(table.orgId),
    index('scanner_devices_org_user_idx').on(table.orgId, table.userId, table.createdAt),
    uniqueIndex('scanner_devices_token_idx').on(table.tokenSha256),
    check('scanner_devices_label_length', sql`length(${table.label}) between 1 and 80`),
    check('scanner_devices_token_shape', sql`${table.tokenSha256} ~ '^[0-9a-f]{64}$'`),
    check('scanner_devices_via', sql`${table.via} in ('password', 'console')`),
    check(
      'scanner_devices_revocation_complete',
      sql`(${table.revokedAt} is null) = (${table.revokedBy} is null)`,
    ),
    check('scanner_devices_expiry', sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

/**
 * A brand's packing settings (M38b, D-615): one row, written the first time an org admin
 * saves. No row reads as the defaults (video on).
 */
export const packingSettings = packing.table(
  'settings',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Whether the station records the packing on camera (D-611). */
    videoEnabled: boolean('video_enabled').notNull().default(true),
    updatedBy: text('updated_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (table) => [index('packing_settings_org_idx').on(table.orgId)],
);

/** AES-256-GCM ciphertext under `STOREFRONT_CREDENTIALS_KEY` (D-528's box), bound to its row. */
const sealedBytes = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
  fromDriver: (value) => Buffer.from(value as unknown as Uint8Array),
  toDriver: (value) => value,
});

/**
 * An IP camera over a packing table (M38c, D-668, D-669): the camera process records its RTSP
 * stream into a rolling buffer on the brand server and cuts each packing's video from it.
 *
 * The address carries no credentials (a check holds it): the user name is its own column and
 * the password is sealed with the brand's credentials key, bound to this row, write-only and
 * shown as a fingerprint. Never deleted (a session and a video name the camera that filmed
 * them); switched off instead. The recorder's last word is kept on the row (`last_segment_at`,
 * `last_error_code`, `status_at`), written by the camera process only, never by the settings.
 */
export const packingCameras = packing.table(
  'cameras',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** `rtsp://host[:port]/path`, never with a user name or password in it. */
    rtspUrl: text('rtsp_url').notNull(),
    username: text('username').notNull().default(''),
    passwordSealed: sealedBytes('password_sealed'),
    passwordFingerprint: text('password_fingerprint'),
    /** The installation key the password was sealed under. */
    keyId: text('key_id'),
    enabled: boolean('enabled').notNull().default(true),
    /** When the recorder last stored a piece of this camera's stream. */
    lastSegmentAt: timestamp('last_segment_at', { withTimezone: true, mode: 'date' }),
    /** Why the stream last stopped (`auth_failed`, `unreachable`, …), cleared once it flows. */
    lastErrorCode: text('last_error_code'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true, mode: 'date' }),
    /** When the recorder last reported on this camera at all. */
    statusAt: timestamp('status_at', { withTimezone: true, mode: 'date' }),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedBy: text('updated_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (table) => [
    unique('packing_cameras_org_id_id_key').on(table.orgId, table.id),
    unique('packing_cameras_org_name_key').on(table.orgId, table.name),
    index('packing_cameras_org_idx').on(table.orgId),
    check('packing_cameras_name_length', sql`length(${table.name}) between 1 and 60`),
    check(
      'packing_cameras_rtsp_url',
      sql`${table.rtspUrl} ~* '^rtsp://[^/@[:space:]]+(/[^[:space:]]*)?$' and length(${table.rtspUrl}) <= 500`,
    ),
    check(
      'packing_cameras_username',
      sql`length(${table.username}) <= 64 and position(':' in ${table.username}) = 0`,
    ),
    check(
      'packing_cameras_password_complete',
      sql`(${table.passwordSealed} is null) = (${table.passwordFingerprint} is null)
          and (${table.passwordSealed} is null or ${table.keyId} is not null)`,
    ),
    check(
      'packing_cameras_error_code',
      sql`${table.lastErrorCode} is null or ${table.lastErrorCode} ~ '^[a-z_]{1,40}$'`,
    ),
  ],
);

/**
 * One order at the packing station (M38b, D-610): opened by the first person to bring the
 * order up, resumed by anyone after a reload, completed once, in the transaction that moves
 * the order to `packed` through the state machine. One per order: a packed order never
 * returns to `confirmed`, so it is never packed twice.
 *
 * `order_no` is the order's number as it was opened (numbers never change), so the recent
 * list needs no read across the module boundary for it.
 */
export const packingSessions = packing.table(
  'sessions',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').notNull(),
    orderNo: text('order_no').notNull(),
    /** `open` → `completed`, once (a trigger holds it). */
    status: text('status').notNull().default('open'),
    /** The brand's video setting when the session opened: whether a video is expected. */
    videoRequired: boolean('video_required').notNull(),
    startedBy: text('started_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    completedBy: text('completed_by').references(() => users.id, { onDelete: 'restrict' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    /**
     * The IP camera filming this packing (M38c, D-670), or null for the desk's own camera
     * recorded by the browser. Chosen when the order is opened; fixed once recording starts.
     */
    cameraId: uuid('camera_id'),
    /**
     * The camera recording's window (D-671): from two seconds before the first scan the
     * station accepted, to the finish (at most fifteen minutes), each set once. `recording_by`
     * is who made that first accepted scan: the packer the video is filed under.
     */
    recordingFrom: timestamp('recording_from', { withTimezone: true, mode: 'date' }),
    recordingTo: timestamp('recording_to', { withTimezone: true, mode: 'date' }),
    recordingBy: text('recording_by').references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (table) => [
    unique('packing_sessions_org_id_id_key').on(table.orgId, table.id),
    unique('packing_sessions_org_order_key').on(table.orgId, table.orderId),
    index('packing_sessions_org_idx').on(table.orgId),
    index('packing_sessions_org_started_idx').on(table.orgId, table.startedAt),
    foreignKey({
      name: 'packing_sessions_org_id_order_id_fk',
      columns: [table.orgId, table.orderId],
      foreignColumns: [orders.orgId, orders.id],
    }).onDelete('restrict'),
    check('packing_sessions_status', sql`${table.status} in ('open', 'completed')`),
    check(
      'packing_sessions_completion',
      sql`(${table.status} = 'completed') = (${table.completedAt} is not null and ${table.completedBy} is not null)`,
    ),
    check('packing_sessions_order_no_shape', sql`length(${table.orderNo}) between 1 and 64`),
    index('packing_sessions_camera_window_idx').on(
      table.orgId,
      table.cameraId,
      table.recordingFrom,
    ),
    foreignKey({
      name: 'packing_sessions_org_id_camera_id_fk',
      columns: [table.orgId, table.cameraId],
      foreignColumns: [packingCameras.orgId, packingCameras.id],
    }).onDelete('restrict'),
    check(
      'packing_sessions_recording_camera',
      sql`${table.recordingFrom} is null or ${table.cameraId} is not null`,
    ),
    check(
      'packing_sessions_recording_by',
      sql`(${table.recordingFrom} is null) = (${table.recordingBy} is null)`,
    ),
    check(
      'packing_sessions_recording_window',
      sql`${table.recordingTo} is null
          or (${table.recordingFrom} is not null
              and ${table.recordingTo} >= ${table.recordingFrom}
              and ${table.recordingTo} <= ${table.recordingFrom} + interval '15 minutes')`,
    ),
  ],
);

/**
 * Every scan at the station (M38b, D-610), refused ones included: the record of what went
 * into the parcel and what was caught at the table. Append-only (INSERT and SELECT only).
 *
 * `scan_id` is the browser's key for one press of the scanner: a scan retried after a
 * dropped connection is the same row, so a piece is never counted twice. `removed` is a piece
 * taken back out ("Take one out"), counted against the SKU's packed pieces.
 */
export const packingScans = packing.table(
  'scans',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    sessionId: uuid('session_id').notNull(),
    scanId: uuid('scan_id').notNull(),
    /** What the scanner typed, or `''` for a removal chosen from the list. */
    code: text('code').notNull(),
    /** The SKU the code named, or null for a code that names none. */
    skuId: uuid('sku_id'),
    outcome: text('outcome').notNull(),
    scannedBy: text('scanned_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    scannedAt: timestamp('scanned_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('packing_scans_org_id_id_key').on(table.orgId, table.id),
    unique('packing_scans_session_scan_key').on(table.orgId, table.sessionId, table.scanId),
    index('packing_scans_org_idx').on(table.orgId),
    index('packing_scans_session_idx').on(table.orgId, table.sessionId, table.scannedAt),
    foreignKey({
      name: 'packing_scans_org_id_session_id_fk',
      columns: [table.orgId, table.sessionId],
      foreignColumns: [packingSessions.orgId, packingSessions.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'packing_scans_org_id_sku_id_fk',
      columns: [table.orgId, table.skuId],
      foreignColumns: [skus.orgId, skus.id],
    }).onDelete('restrict'),
    check(
      'packing_scans_outcome',
      sql`${table.outcome} in ('accepted', 'removed', 'unknown_code', 'wrong_item', 'wrong_variant', 'over')`,
    ),
    check(
      'packing_scans_sku_named',
      sql`(${table.skuId} is null) = (${table.outcome} = 'unknown_code')`,
    ),
    check('packing_scans_code_length', sql`length(${table.code}) <= 120`),
  ],
);

/**
 * One recorded part of a session's packing video (M38b, D-611, D-612). Registered by the
 * browser when the camera starts (its own id, so a retry is the same row), the file attached
 * once the upload is finalized, and kept as a record after the retention job deletes the file
 * (`deleted_at`, `deleted_reason`, `deleted_file_id`). A reload mid-recording uploads what was
 * recorded as one part and starts the next.
 */
export const packingVideos = packing.table(
  'videos',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    sessionId: uuid('session_id').notNull(),
    /** 1, 2, … in the order the parts were started. */
    part: integer('part').notNull(),
    recordedBy: text('recorded_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** What the browser recorded: `video/webm` or `video/mp4`. */
    mime: text('mime').notNull(),
    fileId: uuid('file_id'),
    durationMs: integer('duration_ms'),
    sizeBytes: bigint('size_bytes', { mode: 'bigint' }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true, mode: 'date' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    /** The order's state that started the seven days (`packingVideoExpiry`). */
    deletedReason: text('deleted_reason'),
    deletedFileId: uuid('deleted_file_id'),
    /**
     * Who filmed it (M38c, D-674): `browser` (the desk's camera, uploaded by the station) or
     * `camera` (an IP camera, cut on the server from its buffer), with that camera.
     */
    source: text('source').notNull().default('browser'),
    cameraId: uuid('camera_id'),
    ...timestamps,
  },
  (table) => [
    unique('packing_videos_org_id_id_key').on(table.orgId, table.id),
    unique('packing_videos_session_part_key').on(table.orgId, table.sessionId, table.part),
    uniqueIndex('packing_videos_file_idx').on(table.orgId, table.fileId),
    index('packing_videos_org_idx').on(table.orgId),
    index('packing_videos_session_idx').on(table.orgId, table.sessionId),
    foreignKey({
      name: 'packing_videos_org_id_session_id_fk',
      columns: [table.orgId, table.sessionId],
      foreignColumns: [packingSessions.orgId, packingSessions.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'packing_videos_org_id_file_id_fk',
      columns: [table.orgId, table.fileId],
      foreignColumns: [fileObjects.orgId, fileObjects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'packing_videos_org_id_camera_id_fk',
      columns: [table.orgId, table.cameraId],
      foreignColumns: [packingCameras.orgId, packingCameras.id],
    }).onDelete('restrict'),
    check('packing_videos_source', sql`${table.source} in ('browser', 'camera')`),
    check(
      'packing_videos_source_camera',
      sql`(${table.source} = 'camera') = (${table.cameraId} is not null)`,
    ),
    check('packing_videos_part', sql`${table.part} between 1 and 99`),
    check('packing_videos_mime', sql`${table.mime} in ('video/webm', 'video/mp4')`),
    check(
      'packing_videos_upload_complete',
      sql`(${table.fileId} is null or (${table.uploadedAt} is not null and ${table.durationMs} is not null and ${table.sizeBytes} is not null))`,
    ),
    check(
      'packing_videos_duration',
      sql`${table.durationMs} is null or ${table.durationMs} between 0 and 3600000`,
    ),
    check(
      'packing_videos_deletion_complete',
      sql`(${table.deletedAt} is null and ${table.deletedReason} is null and ${table.deletedFileId} is null)
       or (${table.deletedAt} is not null and ${table.fileId} is null and ${table.deletedFileId} is not null
           and ${table.deletedReason} in ('delivered', 'partially_delivered', 'returned', 'cancelled', 'exchange'))`,
    ),
  ],
);
