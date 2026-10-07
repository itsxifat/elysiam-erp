import { Inject, Injectable } from '@nestjs/common';
import type { PackingVideoFileInput, PackingVideoStartInput } from '@elysium/contracts';
import { withGlobal, withOrg, type Tx } from '@elysium/db';
import { isPackingVideoExpired, packingVideoExpiry } from '@elysium/domain/packing';
import { sql } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service.js';
import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { FILES_API, type FilesApi } from '../files/files.api.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { mapPackingErrors, PackingError } from './station.errors.js';
import * as repo from './station.repository.js';

/** How far a browser's clock may claim a recording started from the server's. */
const START_SKEW_MS = 10 * 60_000;
/** How long after a session opened a part may still say it started (a reload days later). */
const START_WINDOW_MS = 3 * 24 * 60 * 60_000;

/**
 * The packing video (M38b, D-611 to D-614).
 *
 * The browser records; this service registers each recorded part against its session, attaches
 * the part's upload once the files module has finalized it (a stored, private `packing-video`
 * the caller uploaded), signs a short-lived URL to play it for a caller whose scope reaches
 * the order, and — every night — deletes the videos of orders that ended seven days ago.
 */
@Injectable()
export class PackingVideoService {
  constructor(
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    @Inject(FILES_API) private readonly files: FilesApi,
    private readonly audit: AuditService,
  ) {}

  /** A recording started: its part registered under the browser's own id. */
  async start(
    context: ActiveContext,
    request: AuditableRequest,
    sessionId: string,
    input: PackingVideoStartInput,
  ) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const session = await this.sessionInScope(tx, context.orgId, request, sessionId);
        const existing = await repo.videoById(tx, context.orgId, input.videoId);
        if (existing !== undefined) {
          if (existing.session_id !== sessionId) {
            throw new PackingError('PACKING_VIDEO_INVALID', 'That recording is another order’s.');
          }
          return this.part(existing);
        }
        const startedAt = new Date(input.startedAt);
        const now = Date.now();
        const opened = new Date(session.started_at).getTime();
        if (
          startedAt.getTime() > now + START_SKEW_MS ||
          startedAt.getTime() < opened - START_SKEW_MS ||
          startedAt.getTime() > opened + START_WINDOW_MS
        ) {
          throw new PackingError(
            'PACKING_VIDEO_INVALID',
            'That recording’s start does not match this packing session. Check the clock.',
          );
        }
        // A finished packing takes a late upload of a part filmed while it was open, never a
        // recording that began after the box was closed (M38b audit).
        if (
          session.status === 'completed' &&
          (session.completed_at === null ||
            startedAt.getTime() > new Date(session.completed_at).getTime())
        ) {
          throw new PackingError(
            'PACKING_VIDEO_INVALID',
            'This order’s packing finished before that recording started.',
          );
        }
        const row = await repo.insertVideo(tx, {
          orgId: context.orgId,
          id: input.videoId,
          sessionId,
          recordedBy: context.userId,
          startedAt,
          mime: input.mime,
        });
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'packing.video_started',
          entityType: 'packing_video',
          entityId: row.id,
          after: { sessionId, orderId: session.order_id, part: row.part, mime: row.mime },
          request,
        });
        return this.part(row);
      }),
    );
  }

  /** A part's finalized upload, attached once. */
  async attach(
    context: ActiveContext,
    request: AuditableRequest,
    sessionId: string,
    videoId: string,
    input: PackingVideoFileInput,
  ) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const session = await this.sessionInScope(tx, context.orgId, request, sessionId);
        const video = await repo.videoById(tx, context.orgId, videoId, { forUpdate: true });
        if (video?.session_id !== sessionId) {
          throw new PackingError('NOT_FOUND', 'No such recording.');
        }
        // The person who filmed it brings its file; an org admin may finish it for them.
        if (
          video.recorded_by !== context.userId &&
          !context.isSuperAdmin &&
          !context.roles.includes('org_admin')
        ) {
          throw new PackingError(
            'FORBIDDEN',
            'Only the person who recorded this video, or an org admin, attaches its file.',
          );
        }
        if (video.file_id === input.fileId) return this.part(video);
        if (video.file_id !== null || video.deleted_at !== null) {
          throw new PackingError('PACKING_VIDEO_INVALID', 'This recording already has its video.');
        }
        const file = await this.files.fileFacts(tx, context.orgId, input.fileId);
        if (
          file?.purpose !== 'packing-video' ||
          file.status !== 'stored' ||
          file.visibility !== 'private' ||
          file.ownerUserId !== context.userId ||
          file.mime !== video.mime ||
          file.sizeBytes === null
        ) {
          throw new PackingError(
            'PACKING_VIDEO_INVALID',
            'That file is not a packing video you uploaded for this recording.',
          );
        }
        if (
          !(await repo.attachVideoFile(tx, {
            orgId: context.orgId,
            id: videoId,
            fileId: input.fileId,
            durationMs: input.durationMs,
            sizeBytes: file.sizeBytes,
          }))
        ) {
          throw new PackingError('CONFLICT', 'This recording changed; try again.');
        }
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'packing.video_uploaded',
          entityType: 'packing_video',
          entityId: videoId,
          after: {
            sessionId,
            orderId: session.order_id,
            fileId: input.fileId,
            durationMs: input.durationMs,
            sizeBytes: file.sizeBytes,
          },
          request,
        });
        const after = await repo.videoById(tx, context.orgId, videoId);
        return this.part(after ?? video);
      }),
    );
  }

  /**
   * A short-lived URL to play one part, for a caller whose `read PackingVideo` scope (hung on
   * the request by the guard) reaches the order (D-614). The files module still checks the
   * purpose's ability before it signs anything.
   */
  async url(context: ActiveContext, request: object, videoId: string) {
    return mapPackingErrors(async () => {
      const found = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const video = await repo.videoById(tx, context.orgId, videoId);
        const session =
          video === undefined
            ? undefined
            : await repo.sessionById(tx, context.orgId, video.session_id);
        if (
          video === undefined ||
          session === undefined ||
          !(await this.orders.orderVisibleTo(tx, context.orgId, session.order_id, request))
        ) {
          if (session === undefined) {
            scopeWhere(request, {
              createdBy: sql`null`,
              assignedTo: sql`null`,
              branchId: sql`null`,
            });
          }
          throw new PackingError('NOT_FOUND', 'No such recording.');
        }
        return video;
      });
      if (found.file_id === null) {
        throw new PackingError(
          'PACKING_VIDEO_GONE',
          found.deleted_at === null
            ? 'This recording’s video has not arrived.'
            : 'This video was deleted seven days after the order ended.',
        );
      }
      const signed = await this.files.signCheckedDownload(context, found.file_id, 'packing-video');
      return {
        id: found.id,
        url: signed.url,
        expiresAt: signed.expiresAt.toISOString(),
        mime: signed.mime,
        durationMs: found.duration_ms,
      };
    });
  }

  // --- retention (D-612) ------------------------------------------------------------------

  /** Every brand's expired packing videos, deleted. The daily job. */
  async purgeAll(now: Date = new Date()): Promise<number> {
    const orgIds = await withGlobal(async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        sql`select id from org.organizations order by slug`,
      );
      return [...rows].map((row) => row.id);
    });
    let deleted = 0;
    for (const orgId of orgIds) deleted += await this.purgeOrg(orgId, now);
    return deleted;
  }

  /**
   * One brand's expired videos. Each is deleted in its own transaction: the part marked
   * deleted (which file, why), the file's row removed, the audit entry written and the bytes'
   * removal enqueued, together or not at all. The expiry is read again inside that
   * transaction, under the part's lock, so an order that changed since the first look is
   * judged as it is now.
   */
  async purgeOrg(orgId: string, now: Date = new Date()): Promise<number> {
    const candidates = await withOrg({ orgId }, async (tx) => {
      const attached = await repo.attachedVideos(tx, orgId);
      const facts = await this.orders.retentionFacts(
        tx,
        orgId,
        attached.map((row) => row.order_id),
      );
      const factOf = new Map(facts.map((fact) => [fact.orderId, fact]));
      return attached.filter((row) => {
        const fact = factOf.get(row.order_id);
        return fact !== undefined && isPackingVideoExpired(fact, now);
      });
    });

    let deleted = 0;
    for (const candidate of candidates) {
      const done = await withOrg({ orgId }, async (tx) => {
        const video = await repo.videoById(tx, orgId, candidate.id, { forUpdate: true });
        if (video?.file_id !== candidate.file_id) return false;
        const [fact] = await this.orders.retentionFacts(tx, orgId, [candidate.order_id]);
        const expiry = fact === undefined ? null : packingVideoExpiry(fact);
        if (fact === undefined || expiry === null || !isPackingVideoExpired(fact, now)) {
          return false;
        }
        await repo.markVideoDeleted(tx, { orgId, id: candidate.id, reason: expiry.reason });
        if (!(await this.files.forget(tx, orgId, candidate.file_id, 'packing-video'))) {
          throw new Error('a packing video’s file row was not there to delete');
        }
        await this.audit.record(tx, {
          orgId,
          actorUserId: null,
          operation: 'delete',
          action: 'packing.video_deleted',
          entityType: 'packing_video',
          entityId: candidate.id,
          before: {
            fileId: candidate.file_id,
            orderId: candidate.order_id,
            sessionId: candidate.session_id,
          },
          after: {
            reason: expiry.reason,
            orderStatusSince: fact.statusSince?.toISOString() ?? null,
            keepThrough: expiry.keepThrough,
            deleteFrom: expiry.deleteFrom,
          },
        });
        return true;
      });
      if (done) deleted += 1;
    }
    return deleted;
  }

  private async sessionInScope(
    tx: Tx,
    orgId: string,
    request: object,
    sessionId: string,
  ): Promise<repo.SessionRow> {
    // Locked: parts are numbered in order under the session's row.
    const session = await repo.sessionById(tx, orgId, sessionId, { forUpdate: true });
    if (session === undefined) {
      scopeWhere(request, { createdBy: sql`null`, assignedTo: sql`null`, branchId: sql`null` });
      throw new PackingError('NOT_FOUND', 'No such packing session.');
    }
    if (!(await this.orders.orderVisibleTo(tx, orgId, session.order_id, request))) {
      throw new PackingError('NOT_FOUND', 'No such packing session.');
    }
    return session;
  }

  private part(row: repo.VideoRow) {
    return {
      id: row.id,
      sessionId: row.session_id,
      part: row.part,
      mime: row.mime,
      state: row.deleted_at !== null ? 'deleted' : row.file_id !== null ? 'uploaded' : 'waiting',
      durationMs: row.duration_ms,
      sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
      uploadedAt: row.uploaded_at === null ? null : new Date(row.uploaded_at).toISOString(),
    };
  }
}
