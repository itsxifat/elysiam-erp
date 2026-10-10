import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

import { Injectable } from '@nestjs/common';
import {
  PACKING_CAMERAS_MAX_ENABLED,
  type PackingCameraCreateInput,
  type PackingCameraUpdateInput,
} from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import { cameraState, previewDemandUntil, previewFrameFresh } from '@elysium/domain/packing';

import { AuditService } from '../../platform/audit/audit.service.js';
import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { seal, sealedBoxConfigured } from '../../platform/crypto/sealed-box.js';
import { serverEnv } from '../../platform/config/env.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { previewFile } from './camera/camera-preview.js';
import * as cameras from './camera.repository.js';
import { mapPackingErrors, PackingError } from './station.errors.js';

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

/** What the sealed password is bound to: this brand, this camera's row, this field. */
export function cameraPasswordBinding(orgId: string, cameraId: string) {
  return { orgId, row: `packing_camera:${cameraId}`, field: 'password' } as const;
}

/**
 * Where a camera address sends its password: the host and the port (RTSP's 554 when none is
 * written). A sealed password follows an address only while this stays the same (W2).
 */
export function cameraEndpoint(rtspUrl: string): string {
  const url = new URL(rtspUrl);
  return `${url.hostname.toLowerCase()}:${url.port === '' ? '554' : url.port}`;
}

/** A camera's settings as the audit records them: never the password, its fingerprint only. */
function auditFacts(row: cameras.CameraRow | undefined) {
  if (row === undefined) return null;
  return {
    name: row.name,
    rtspUrl: row.rtsp_url,
    username: row.username,
    enabled: row.enabled,
    sealedFingerprint: row.password_fingerprint,
  };
}

/**
 * Orders → Pack → Settings → IP cameras (M38c, D-668, D-669).
 *
 * Whoever packs reads the cameras' names and states (to choose one at the station); only an
 * org admin (`update PackingVideo`) sees their addresses and user names and adds or changes
 * them. The password is write-only: sealed with the brand's credentials key (the website's
 * and the marketplace's box, D-528), bound to the camera's row, and shown as "set" with a
 * fingerprint. Every change is audited with the fingerprint, never the password.
 */
@Injectable()
export class CameraSettingsService {
  constructor(private readonly audit: AuditService) {}

  async list(context: ActiveContext, canEdit: boolean) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await cameras.camerasOf(tx, context.orgId);
      return {
        cameras: rows.map((row) => this.present(row, canEdit)),
        canEdit,
        credentialsKey: sealedBoxConfigured(),
      };
    });
  }

  async create(context: ActiveContext, request: AuditableRequest, input: PackingCameraCreateInput) {
    return mapPackingErrors(async () => {
      this.assertKeyFor(input.password);
      return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        await cameras.lockCameraSettings(tx, context.orgId);
        if (input.enabled) await this.assertRoomFor(tx, context.orgId, null);
        const id = randomUUID();
        const row = await cameras.insertCamera(tx, {
          orgId: context.orgId,
          id,
          name: input.name,
          rtspUrl: input.rtspUrl,
          username: input.username,
          password: this.sealed(context.orgId, id, input.password),
          enabled: input.enabled,
          userId: context.userId,
        });
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'packing.camera_added',
          entityType: 'packing_camera',
          entityId: row.id,
          after: auditFacts(row),
          request,
        });
        return this.present(row, true);
      }).catch(nameTaken);
    });
  }

  async update(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    input: PackingCameraUpdateInput,
  ) {
    return mapPackingErrors(async () => {
      this.assertKeyFor(input.password);
      return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        await cameras.lockCameraSettings(tx, context.orgId);
        const before = await cameras.cameraById(tx, context.orgId, id, { forUpdate: true });
        if (before?.deleted_at !== null) {
          throw new PackingError('NOT_FOUND', 'No such camera.');
        }
        // A stored password goes only where it went before (ledger audit W2): an address on
        // another host or port asks for it again, so nobody points it at a machine of theirs.
        if (
          input.password === undefined &&
          before.password_fingerprint !== null &&
          cameraEndpoint(before.rtsp_url) !== cameraEndpoint(input.rtspUrl)
        ) {
          throw new PackingError(
            'PACKING_CAMERA_PASSWORD_REQUIRED',
            'The camera’s address moved to another host or port: enter its password again, or remove it.',
          );
        }
        if (input.enabled && !before.enabled) await this.assertRoomFor(tx, context.orgId, id);
        const after = await cameras.updateCamera(tx, {
          orgId: context.orgId,
          id,
          name: input.name,
          rtspUrl: input.rtspUrl,
          username: input.username,
          password:
            input.password === undefined
              ? undefined
              : this.sealed(context.orgId, id, input.password),
          enabled: input.enabled,
          userId: context.userId,
        });
        if (after === undefined) throw new PackingError('NOT_FOUND', 'No such camera.');
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'packing.camera_updated',
          entityType: 'packing_camera',
          entityId: id,
          before: auditFacts(before),
          after: auditFacts(after),
          request,
        });
        return this.present(after, true);
      }).catch(nameTaken);
    });
  }

  /**
   * Delete a camera from use (D-684): refused while a packing it films is still recording;
   * otherwise switched off for good, its password wiped, gone from every list and from the
   * station's choice. Open packings with no piece in the box fall back to the desk's own
   * camera. Past sessions and their videos keep naming it, and keep playing.
   */
  async remove(context: ActiveContext, request: AuditableRequest, id: string) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        await cameras.lockCameraSettings(tx, context.orgId);
        const before = await cameras.cameraById(tx, context.orgId, id, { forUpdate: true });
        if (before?.deleted_at !== null) {
          throw new PackingError('NOT_FOUND', 'No such camera.');
        }
        // The camera, then its open packings (W1): a first accepted scan in flight on one of
        // them commits first, so its recording is seen here and the delete refused; one that
        // comes after finds the camera deleted and never records.
        await cameras.lockOpenSessionsOfCamera(tx, context.orgId, id);
        if (await cameras.cameraRecordingOpen(tx, context.orgId, id)) {
          throw new PackingError(
            'PACKING_CAMERA_IN_USE',
            'This camera is recording a packing now. Finish that order (or wait up to fifteen minutes), then delete it.',
          );
        }
        const released = await cameras.releaseCameraFromIdleSessions(tx, context.orgId, id);
        if (
          !(await cameras.deleteCamera(tx, { orgId: context.orgId, id, userId: context.userId }))
        ) {
          throw new PackingError('CONFLICT', 'This camera changed; try again.');
        }
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'delete',
          action: 'packing.camera_deleted',
          entityType: 'packing_camera',
          entityId: id,
          before: auditFacts(before),
          after: {
            deleted: true,
            enabled: false,
            sealedFingerprint: null,
            sessionsReleased: released,
          },
          request,
        });
        return { id, deleted: true as const };
      }),
    );
  }

  /**
   * One frame of a camera's live preview (D-683), for whoever packs: the camera in use, its
   * demand written at most every five seconds (the camera process runs the preview while
   * someone looks), and the newest frame the camera process wrote, if it is under five
   * seconds old. A JPEG caught half-written is read again once.
   */
  async livePreview(context: ActiveContext, id: string): Promise<Buffer | null> {
    return mapPackingErrors(async () => {
      await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const camera = await cameras.cameraById(tx, context.orgId, id);
        if (camera?.deleted_at !== null || !camera.enabled) {
          throw new PackingError('NOT_FOUND', 'No such camera in use.');
        }
        const until = previewDemandUntil({
          wantedUntil:
            camera.preview_wanted_until === null ? null : new Date(camera.preview_wanted_until),
          now: new Date(),
        });
        if (until !== null) await cameras.wantPreview(tx, { orgId: context.orgId, id, until });
      });
      const file = previewFile(serverEnv().CAMERA_PREVIEW_DIR, context.orgId, id);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const frame = await freshFrame(file);
        if (frame !== null) return frame;
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      // No live frame is an ordinary answer (W2): the route says 204, nothing is logged.
      return null;
    });
  }

  /** At most `PACKING_CAMERAS_MAX_ENABLED` cameras record for a brand (ledger audit W6). */
  private async assertRoomFor(tx: Tx, orgId: string, exceptId: string | null): Promise<void> {
    if ((await cameras.countEnabledCameras(tx, orgId, exceptId)) >= PACKING_CAMERAS_MAX_ENABLED) {
      throw new PackingError(
        'PACKING_CAMERA_LIMIT',
        `This brand already records with ${String(PACKING_CAMERAS_MAX_ENABLED)} cameras. Switch one off first.`,
      );
    }
  }

  /** A password to keep needs the brand's credentials key; refused, never stored in the clear. */
  private assertKeyFor(password: string | null | undefined): void {
    if (typeof password === 'string' && !sealedBoxConfigured()) {
      throw new PackingError(
        'WEBSITE_CREDENTIALS_MISSING',
        'This server has no STOREFRONT_CREDENTIALS_KEY, so the camera’s password cannot be kept.',
      );
    }
  }

  private sealed(
    orgId: string,
    cameraId: string,
    password: string | null | undefined,
  ): cameras.SealedPassword | null {
    if (typeof password !== 'string') return null;
    const box = seal(password, cameraPasswordBinding(orgId, cameraId));
    return { sealed: box.ciphertext, fingerprint: box.fingerprint, keyId: box.keyId };
  }

  /** A camera as a screen shows it; its address and user name only to who may edit it. */
  private present(row: cameras.CameraRow, canEdit: boolean) {
    const lastSegmentAt = row.last_segment_at === null ? null : new Date(row.last_segment_at);
    const base = {
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      state: cameraState({ enabled: row.enabled, lastSegmentAt, now: new Date() }),
      lastSegmentAt: iso(row.last_segment_at),
      lastErrorCode: row.last_error_code,
      lastErrorAt: iso(row.last_error_at),
    };
    if (!canEdit) return base;
    return {
      ...base,
      rtspUrl: row.rtsp_url,
      username: row.username,
      passwordSet: row.password_fingerprint !== null,
      passwordFingerprint: row.password_fingerprint,
      updatedAt: iso(row.updated_at),
    };
  }
}

/** The largest preview frame served: a 640-wide JPEG is a few tens of kilobytes. */
const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The frame, if it is fresh and whole (a JPEG from its start marker to its end marker). Opened
 * without following a symbolic link, and judged and read through that one descriptor (N1), so
 * nothing swapped in between the look and the read is served.
 */
export async function freshFrame(file: string, now: Date = new Date()): Promise<Buffer | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > PREVIEW_MAX_BYTES) return null;
    if (!previewFrameFresh({ frameAt: info.mtime, now })) return null;
    const bytes = await handle.readFile();
    const whole =
      bytes.length > 4 &&
      bytes.length <= PREVIEW_MAX_BYTES &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[bytes.length - 2] === 0xff &&
      bytes[bytes.length - 1] === 0xd9;
    return whole ? bytes : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Two cameras of a brand never share a name: the station's list tells them apart by it. */
function nameTaken(error: unknown): never {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (
      (current as { code?: unknown }).code === '23505' &&
      (current as { constraint_name?: unknown }).constraint_name ===
        'packing_cameras_org_name_live_idx'
    ) {
      throw new PackingError('CONFLICT', 'Another camera already has that name.');
    }
  }
  throw error;
}
