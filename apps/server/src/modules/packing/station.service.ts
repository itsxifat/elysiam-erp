import { Inject, Injectable } from '@nestjs/common';
import {
  MATRIX,
  type MembershipRole,
  type PackingOpenInput,
  type PackingRemovalInput,
  type PackingScanInput,
  type PackingSessionsQuery,
} from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import { normaliseScannedCode } from '@elysium/domain/barcode';
import {
  cameraRecordingFrom,
  cameraRecordingTo,
  isPackScanRefusal,
  judgeLotClose,
  judgeLotFinish,
  judgePackRemoval,
  judgePackScan,
  openLot,
  packNeeds,
  packProgress,
  packedCounts,
  packingVideoState,
  parseLotCode,
  piecesByLot,
  type PackScanOutcome,
} from '@elysium/domain/packing';
import { sql } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service.js';
import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { IAM_API, type IamApi } from '../iam/iam.api.js';
import { ORDERS_API, type OrdersApi, type PackingFacts } from '../orders/orders.api.js';
import * as cameras from './camera.repository.js';
import * as labels from './labels.repository.js';
import { PACKING_QUEUES, type CameraCutPayload } from './packing.queues.js';
import { ScannerService } from './scanner.service.js';
import { mapPackingErrors, PackingError } from './station.errors.js';
import * as repo from './station.repository.js';
import { TerminalsService, type AtTerminal } from './terminals.service.js';

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

const at = (value: Date | string | null): Date | null => (value === null ? null : new Date(value));

/** Words for a status a packer reads in a refusal. */
const STATUS_WORDS: Readonly<Record<string, string>> = {
  pending: 'not confirmed yet',
  on_hold: 'on hold',
  packed: 'already packed',
  shipped: 'already handed to the courier',
  delivered: 'delivered',
  partially_delivered: 'partly delivered',
  return_in_transit: 'on its way back',
  returned: 'returned',
  cancelled: 'cancelled',
  exchange: 'exchanged',
};

/** What a refused scan says at the table. */
const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  unknown_code: 'This code is no product of this brand. Scan the piece’s own sticker.',
  wrong_item: 'This product is not in this order.',
  wrong_variant: 'Wrong size or colour: this order has another variant of this product.',
  over: 'One too many: this order already has every piece of this item.',
};

/**
 * The packing station (M38b, D-610): one order at a time, every piece scanned against it.
 *
 * A session is opened for a confirmed order in the caller's `update Order` scope and lives on
 * the server, so a reload resumes it. Each scan is judged by `judgePackScan` (the domain's
 * rule, shared with the console) under the session's row lock and recorded, refusals included;
 * a scan retried under the same `scanId` is the same scan. Finishing moves the order to
 * `packed` through `OrdersApi.transition` — the state machine's `pack`, exactly the
 * transition the Pack button and bulk pack run — in the same transaction that marks the
 * session completed, so the order is packed once and the session says by whom.
 *
 * M38c (D-670, D-671): a session may be filmed by one of the brand's IP cameras, chosen when
 * the order is opened. The camera is then ready; the first scan the station **accepts** (the
 * piece belongs to the order) starts its recording two seconds before that scan, in the
 * scan's own transaction, and no refused scan ever does. Finishing ends the recording in the
 * finishing transaction and enqueues the cut of the camera's footage (invariant 6).
 */
@Injectable()
export class PackStationService {
  constructor(
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    @Inject(IAM_API) private readonly iam: IamApi,
    private readonly scanner: ScannerService,
    private readonly audit: AuditService,
    // M46 (D-802 to D-804): the packing terminal this computer is, its people and cameras.
    private readonly terminals: TerminalsService,
  ) {}

  /**
   * Open the station on an order, or resume its session. M46: at a bound packing terminal the
   * session is the terminal's (D-802) and is filmed by every camera of the terminal (D-804); a
   * lot code (`…-L2`) opens its order.
   */
  async open(
    context: ActiveContext,
    request: AuditableRequest,
    input: PackingOpenInput,
    token: string | null = null,
  ) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const here = await this.terminals.resolve(tx, context, token, 'packing');
        const orderId = await this.findOrder(tx, context.orgId, request, input);
        let session = await repo.sessionByOrder(tx, context.orgId, orderId);
        if (session === undefined) {
          const [facts] = await this.orders.packingFacts(tx, context.orgId, [orderId]);
          if (facts === undefined) throw new PackingError('NOT_FOUND', 'No such order.');
          this.assertPackable(facts);
          const settings = await repo.settingsOf(tx, context.orgId);
          const { row, created } = await repo.openSession(tx, {
            orgId: context.orgId,
            orderId,
            orderNo: facts.orderNo,
            videoRequired: settings?.video_enabled ?? true,
            startedBy: context.userId,
            terminalId: here?.terminal.id ?? null,
          });
          if (created) {
            await this.audit.record(tx, {
              orgId: context.orgId,
              actorUserId: context.userId,
              operation: 'create',
              action: 'packing.session_opened',
              entityType: 'packing_session',
              entityId: row.id,
              after: { orderId, orderNo: facts.orderNo, videoRequired: row.video_required },
              request,
            });
          }
          session = row;
        }
        if (here !== null && input.cameraId === undefined) {
          session = await this.terminalCameras(tx, context, request, session, here);
        } else if (input.cameraId !== undefined) {
          session = await this.chooseCamera(tx, context, request, session, input.cameraId);
        }
        return this.view(tx, context.orgId, session, context.userId);
      }),
    );
  }

  /** A session as the station shows it. */
  async get(context: ActiveContext, request: object, sessionId: string) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        this.assertStaff(context);
        const session = await this.sessionInScope(tx, context.orgId, request, sessionId, false);
        return this.view(tx, context.orgId, session, context.userId);
      }),
    );
  }

  /** One piece scanned: taken, or refused and recorded. */
  async scan(
    context: ActiveContext,
    request: AuditableRequest,
    sessionId: string,
    input: PackingScanInput,
  ) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const session = await this.sessionInScope(tx, context.orgId, request, sessionId, true);
        const again = await repo.scanByScanId(tx, context.orgId, sessionId, input.scanId);
        if (again !== undefined) {
          return this.scanAnswer(again.outcome as PackScanOutcome, again.sku_id, {
            view: await this.view(tx, context.orgId, session, context.userId),
            repeated: true,
          });
        }
        this.assertOpen(session);
        const facts = await this.lockedFacts(tx, context.orgId, session.order_id);
        this.assertPackable(facts);

        const code = normaliseScannedCode(input.code);
        const found =
          code === '' ? undefined : await this.catalog.lookupCode(tx, context.orgId, code);
        const needs = await this.needsOf(tx, context.orgId, facts);
        const earlier = await repo.scansOf(tx, context.orgId, sessionId);
        const packed = packedCounts(
          earlier.map((row) => ({
            skuId: row.sku_id,
            outcome: row.outcome as PackScanOutcome,
          })),
        );
        const outcome = judgePackScan({
          needs,
          packed,
          scanned: found === undefined ? null : { skuId: found.skuId, productId: found.productId },
        });
        // M46 (D-807): the piece goes into the open lot; M38b's checks still judge the order.
        const lot = await this.openLotOf(tx, context.orgId, session);
        const written = await repo.insertScan(tx, {
          orgId: context.orgId,
          sessionId,
          scanId: input.scanId,
          code: code.slice(0, 120),
          skuId: found?.skuId ?? null,
          outcome,
          scannedBy: context.userId,
          lotNo: lot,
        });
        // The owner's catch (D-671): only a piece the order needs starts the camera, two
        // seconds before the scan, by the scan's own clock, once. Under the session's lock.
        const camera =
          session.camera_id === null
            ? undefined
            : await cameras.cameraById(tx, context.orgId, session.camera_id);
        const recordingFrom = session.video_required
          ? cameraRecordingFrom({
              cameraId: session.camera_id,
              cameraEnabled: camera?.enabled === true,
              recordingFrom: at(session.recording_from),
              earlierAccepted: earlier.some((row) => row.outcome === 'accepted'),
              outcome,
              scannedAt: new Date(written.scanned_at),
            })
          : null;
        const started =
          recordingFrom !== null &&
          (await cameras.startRecording(tx, {
            orgId: context.orgId,
            sessionId,
            from: recordingFrom,
            by: context.userId,
          }));
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: outcome === 'accepted' ? 'packing.scanned' : 'packing.scan_refused',
          entityType: 'packing_session',
          entityId: sessionId,
          after: {
            orderId: session.order_id,
            skuId: found?.skuId ?? null,
            outcome,
            ...(started
              ? { cameraId: session.camera_id, recordingFrom: recordingFrom.toISOString() }
              : {}),
          },
          request,
        });
        const current = started
          ? ((await repo.sessionById(tx, context.orgId, sessionId)) ?? session)
          : session;
        return this.scanAnswer(outcome, found?.skuId ?? null, {
          view: await this.view(tx, context.orgId, current, context.userId),
          repeated: false,
        });
      }),
    );
  }

  /** Take one piece of a SKU back out of the box. */
  async remove(
    context: ActiveContext,
    request: AuditableRequest,
    sessionId: string,
    input: PackingRemovalInput,
  ) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const session = await this.sessionInScope(tx, context.orgId, request, sessionId, true);
        const again = await repo.scanByScanId(tx, context.orgId, sessionId, input.scanId);
        if (again !== undefined) return this.view(tx, context.orgId, session, context.userId);
        this.assertOpen(session);
        const facts = await this.lockedFacts(tx, context.orgId, session.order_id);
        this.assertPackable(facts);
        // M46 (D-807): a piece comes out of the open lot only; a closed bag stays closed.
        const lot = await this.openLotOf(tx, context.orgId, session);
        const packed = packedCounts(
          (await repo.scansOf(tx, context.orgId, sessionId))
            .filter((row) => row.lot_no === lot)
            .map((row) => ({
              skuId: row.sku_id,
              outcome: row.outcome as PackScanOutcome,
            })),
        );
        if (judgePackRemoval(packed, input.skuId) === 'nothing_to_remove') {
          throw new PackingError(
            'PACKING_NOTHING_TO_REMOVE',
            lot > 1
              ? `There is no piece of that item in lot ${String(lot)} to take out.`
              : 'There is no piece of that item in the box to take out.',
          );
        }
        await repo.insertScan(tx, {
          orgId: context.orgId,
          sessionId,
          scanId: input.scanId,
          code: '',
          skuId: input.skuId,
          outcome: 'removed',
          scannedBy: context.userId,
          lotNo: lot,
        });
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'packing.piece_removed',
          entityType: 'packing_session',
          entityId: sessionId,
          after: { orderId: session.order_id, skuId: input.skuId },
          request,
        });
        return this.view(tx, context.orgId, session, context.userId);
      }),
    );
  }

  /**
   * Finish: every piece is in the box, so the order moves to `packed` through the state
   * machine, once. Finishing a finished session answers with it again and moves nothing.
   */
  async complete(context: ActiveContext, request: AuditableRequest, sessionId: string) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const session = await this.sessionInScope(tx, context.orgId, request, sessionId, true);
        if (session.status === 'completed') {
          return {
            ...(await this.view(tx, context.orgId, session, context.userId)),
            alreadyCompleted: true,
          };
        }
        const facts = await this.lockedFacts(tx, context.orgId, session.order_id);
        this.assertPackable(facts);
        const needs = await this.needsOf(tx, context.orgId, facts);
        const progress = packProgress(
          needs,
          packedCounts(
            (await repo.scansOf(tx, context.orgId, sessionId)).map((row) => ({
              skuId: row.sku_id,
              outcome: row.outcome as PackScanOutcome,
            })),
          ),
        );
        if (!progress.complete) {
          throw new PackingError(
            'PACKING_INCOMPLETE',
            progress.unitsPacked < progress.unitsRequired
              ? `${String(progress.unitsRequired - progress.unitsPacked)} of ${String(progress.unitsRequired)} pieces are still to scan.`
              : 'The box holds a piece this order does not need. Take it out first.',
          );
        }
        // M46 (D-807): an order in several lots is packed only with every lot closed; Finish
        // closes the last one.
        const lotCount = await labels.lotCountOf(tx, context.orgId, session.order_id);
        const closures = await labels.closuresOf(tx, context.orgId, sessionId);
        if (lotCount > 1 && closures.length < lotCount) {
          const lot = closures.length + 1;
          const inLot =
            piecesByLot(
              (await repo.scansOf(tx, context.orgId, sessionId)).map((row) => ({
                lot: row.lot_no,
                outcome: row.outcome,
              })),
            ).get(lot) ?? 0;
          const verdict = judgeLotFinish({
            lotCount,
            closedLots: closures.length,
            piecesInLot: inLot,
          });
          if (verdict === 'lots_open') {
            throw new PackingError(
              'PACKING_INCOMPLETE',
              `This order goes in ${String(lotCount)} lots: close lot ${String(lot)} and fill the rest first.`,
            );
          }
          if (verdict === 'empty') {
            throw new PackingError(
              'PACKING_INCOMPLETE',
              `Lot ${String(lot)} of ${String(lotCount)} is empty: every lot holds at least one piece.`,
            );
          }
          await labels.insertClosure(tx, {
            orgId: context.orgId,
            sessionId,
            lotNo: lot,
            by: context.userId,
          });
        }
        // M38c (D-671, D-672): the camera's recording ends with the finish (at most fifteen
        // minutes after it began), set before the session completes (a completed session never
        // changes), and its cut is enqueued in this same transaction (invariant 6).
        const recordingTo = cameraRecordingTo({
          recordingFrom: at(session.recording_from),
          recordingTo: at(session.recording_to),
          endedAt: await cameras.transactionNow(tx),
        });
        const cutQueued =
          recordingTo !== null &&
          (await cameras.endRecording(tx, {
            orgId: context.orgId,
            sessionId,
            to: recordingTo,
          }));
        if (cutQueued) {
          const payload: CameraCutPayload = { sessionId };
          await enqueue(tx, PACKING_QUEUES.cameraCut.name, payload, {
            orgId: context.orgId,
            ref: sessionId,
          });
          // M46 (D-804): the terminal's other cameras, each cut from the same window.
          for (const cameraId of await cameras.extraCamerasOf(tx, context.orgId, sessionId)) {
            const extra: CameraCutPayload = { sessionId, cameraId };
            await enqueue(tx, PACKING_QUEUES.cameraCut.name, extra, {
              orgId: context.orgId,
              ref: sessionId,
            });
          }
        }
        // §9's `pack`, through the machine: the order's own lock, effects and history.
        const moved = await this.orders.transition(
          tx,
          { orgId: context.orgId, userId: context.userId },
          session.order_id,
          'pack',
        );
        if (!(await repo.completeSession(tx, context.orgId, sessionId, context.userId))) {
          throw new PackingError('CONFLICT', 'This packing session changed; open it again.');
        }
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'packing.session_completed',
          entityType: 'packing_session',
          entityId: sessionId,
          before: { status: 'open', orderStatus: moved.from },
          after: {
            status: 'completed',
            orderStatus: moved.to,
            units: progress.unitsPacked,
            ...(cutQueued
              ? { cameraId: session.camera_id, recordingTo: recordingTo.toISOString() }
              : {}),
          },
          request,
        });
        const done = await repo.sessionById(tx, context.orgId, sessionId);
        return {
          ...(await this.view(tx, context.orgId, done ?? session, context.userId)),
          alreadyCompleted: false,
        };
      }),
    );
  }

  /**
   * Close the open lot (M46, D-807): the bag is sealed and the next scans go into the next one.
   * At least one piece must be in it, and enough must be left for the lots after it to hold one
   * each. The last lot is closed by Finish.
   */
  async closeLot(context: ActiveContext, request: AuditableRequest, sessionId: string) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const session = await this.sessionInScope(tx, context.orgId, request, sessionId, true);
        this.assertOpen(session);
        const facts = await this.lockedFacts(tx, context.orgId, session.order_id);
        this.assertPackable(facts);
        const lotCount = await labels.lotCountOf(tx, context.orgId, session.order_id);
        const closures = await labels.closuresOf(tx, context.orgId, sessionId);
        const scans = await repo.scansOf(tx, context.orgId, sessionId);
        const needs = await this.needsOf(tx, context.orgId, facts);
        const progress = packProgress(
          needs,
          packedCounts(
            scans.map((row) => ({ skuId: row.sku_id, outcome: row.outcome as PackScanOutcome })),
          ),
        );
        const lot = closures.length + 1;
        const verdict = judgeLotClose({
          lotCount,
          closedLots: closures.length,
          piecesInLot:
            piecesByLot(scans.map((row) => ({ lot: row.lot_no, outcome: row.outcome }))).get(lot) ??
            0,
          unitsRequired: progress.unitsRequired,
          unitsPacked: progress.unitsPacked,
        });
        if (verdict !== 'ok') {
          const refusals: Readonly<Record<typeof verdict, string>> = {
            all_closed: 'Every lot of this order is closed.',
            last_lot: `Lot ${String(lot)} is the last: put the remaining pieces in and press Finish packing.`,
            empty: `Lot ${String(lot)} is empty: put at least one piece in it first.`,
            too_few_left: `Too few pieces are left for the ${String(lotCount - lot)} lots after this one. Put fewer in lot ${String(lot)}, or make fewer lots.`,
          };
          throw new PackingError('LOT_CLOSE_REFUSED', refusals[verdict]);
        }
        await labels.insertClosure(tx, {
          orgId: context.orgId,
          sessionId,
          lotNo: lot,
          by: context.userId,
        });
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'packing.lot_closed',
          entityType: 'packing_session',
          entityId: sessionId,
          after: { orderId: session.order_id, lot, lotCount },
          request,
        });
        return this.view(tx, context.orgId, session, context.userId);
      }),
    );
  }

  /**
   * The newest sessions of orders the caller may see (D-617). The order's scope is part of
   * the query, before its limit (M38b audit): a sales agent sees their own newest sessions,
   * however many colleagues packed since.
   */
  async list(context: ActiveContext, request: object, query: PackingSessionsQuery) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        this.assertStaff(context);
        const shown = await repo.recentSessions(tx, context.orgId, {
          limit: query.limit,
          status: query.status,
          orderInScope: this.orders.orderInScopeSql(context.orgId, sql`s.order_id`, request),
        });
        const [videos, names, statuses] = await Promise.all([
          repo.videosOf(
            tx,
            context.orgId,
            shown.map((row) => row.id),
          ),
          this.names(tx, context.orgId),
          this.orders.retentionFacts(
            tx,
            context.orgId,
            shown.map((row) => row.order_id),
          ),
        ]);
        const statusOf = new Map(statuses.map((fact) => [fact.orderId, fact.status]));
        const now = new Date();
        return {
          items: shown.map((row) => {
            const parts = videos.filter((video) => video.session_id === row.id);
            const startedAt = new Date(row.started_at);
            const completedAt = at(row.completed_at);
            return {
              id: row.id,
              orderId: row.order_id,
              orderNo: row.order_no,
              orderStatus: statusOf.get(row.order_id) ?? null,
              status: row.status,
              startedAt: startedAt.toISOString(),
              startedBy: { id: row.started_by, name: names.get(row.started_by) ?? null },
              completedAt: iso(row.completed_at),
              completedBy:
                row.completed_by === null
                  ? null
                  : { id: row.completed_by, name: names.get(row.completed_by) ?? null },
              durationMs: completedAt === null ? null : completedAt.getTime() - startedAt.getTime(),
              pieces: row.accepted - row.removed,
              scans: row.scans,
              mismatches: row.mismatches,
              video: packingVideoState({
                videoRequired: row.video_required,
                sessionOpen: row.status === 'open',
                completedAt,
                parts: parts.map((part) => ({
                  attached: part.file_id !== null,
                  deleted: part.deleted_at !== null,
                })),
                now,
              }),
            };
          }),
        };
      }),
    );
  }

  /** The order page's packing record: its session, every scan and its video parts. */
  async forOrder(context: ActiveContext, request: object, orderId: string, canPlay: boolean) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        this.assertStaff(context);
        if (!(await this.orders.orderVisibleTo(tx, context.orgId, orderId, request))) {
          throw new PackingError('NOT_FOUND', 'No such order.');
        }
        const session = await repo.sessionByOrder(tx, context.orgId, orderId);
        if (session === undefined) return { session: null, canPlay };
        return { ...(await this.view(tx, context.orgId, session, context.userId)), canPlay };
      }),
    );
  }

  // --- the brand's settings (D-615) -----------------------------------------------------

  async settings(context: ActiveContext, canEdit: boolean) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const row = await repo.settingsOf(tx, context.orgId);
      return {
        videoEnabled: row?.video_enabled ?? true,
        updatedAt: row === undefined ? null : iso(row.updated_at),
        canEdit,
      };
    });
  }

  async saveSettings(
    context: ActiveContext,
    request: AuditableRequest,
    input: { readonly videoEnabled: boolean },
  ) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const before = await repo.settingsOf(tx, context.orgId);
      const row = await repo.saveSettings(tx, {
        orgId: context.orgId,
        videoEnabled: input.videoEnabled,
        userId: context.userId,
      });
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'packing.settings_saved',
        entityType: 'packing_settings',
        entityId: context.orgId,
        before: { videoEnabled: before?.video_enabled ?? true },
        after: { videoEnabled: row.video_enabled },
        request,
      });
      return { videoEnabled: row.video_enabled, updatedAt: iso(row.updated_at), canEdit: true };
    });
  }

  // --- the parts --------------------------------------------------------------------------

  /**
   * A session opened at a packing terminal is filmed by the terminal's cameras (D-804): the
   * first by name is its camera (M38c's window and choice rules), the others are kept beside it
   * and cut from the same window. Only before a piece is in the box, as M38c's own choice.
   */
  private async terminalCameras(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    session: repo.SessionRow,
    here: AtTerminal,
  ): Promise<repo.SessionRow> {
    if (session.status !== 'open' || !session.video_required || session.recording_from !== null) {
      return session;
    }
    const filming = await labels.recordingCamerasOf(tx, context.orgId, here.terminal.id);
    const [first, ...others] = filming;
    if (first === undefined) return session;
    const chosen =
      session.camera_id === null
        ? await this.chooseCamera(tx, context, request, session, first.id)
        : session;
    if (chosen.camera_id === first.id && others.length > 0) {
      await labels.insertSessionCameras(tx, {
        orgId: context.orgId,
        sessionId: session.id,
        cameraIds: others.map((camera) => camera.id),
      });
    }
    return chosen;
  }

  /** The lot the station is filling (D-807): after the closed ones, or the last when all are. */
  private async openLotOf(tx: Tx, orgId: string, session: repo.SessionRow): Promise<number> {
    const lotCount = await labels.lotCountOf(tx, orgId, session.order_id);
    const closed = (await labels.closuresOf(tx, orgId, session.id)).length;
    return openLot(lotCount, closed) ?? lotCount;
  }

  /**
   * The recording source this packing desk chose (D-670): one of the brand's enabled IP
   * cameras, or none (the desk's own camera, recorded by the browser). Changed only while the
   * session is open, records, and has not started recording; after that the camera that began
   * filming the box keeps it, whatever a desk asks.
   */
  private async chooseCamera(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    session: repo.SessionRow,
    cameraId: string | null,
  ): Promise<repo.SessionRow> {
    if (session.camera_id === cameraId) return session;
    if (cameraId !== null) {
      // Shared, before the session's lock (W1): a delete holds the camera first and then its
      // sessions, so choosing waits for it and then sees the camera gone.
      const camera = await cameras.cameraById(tx, context.orgId, cameraId, { forShare: true });
      if (camera?.enabled !== true) {
        throw new PackingError(
          'PACKING_CAMERA_INVALID',
          'That camera is not one of this brand’s cameras in use. Choose another recording source.',
        );
      }
    }
    const locked = await repo.sessionById(tx, context.orgId, session.id, { forUpdate: true });
    if (locked === undefined) return session;
    // Fixed once a piece is in the box (ledger audit N1): a camera chosen after the first
    // correct piece would start at the second.
    if (
      locked.status !== 'open' ||
      !locked.video_required ||
      locked.recording_from !== null ||
      locked.camera_id === cameraId ||
      (await cameras.hasAcceptedScan(tx, context.orgId, session.id))
    ) {
      return locked;
    }
    if (await cameras.chooseSessionCamera(tx, context.orgId, session.id, cameraId)) {
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'packing.session_camera_chosen',
        entityType: 'packing_session',
        entityId: session.id,
        before: { cameraId: locked.camera_id },
        after: { cameraId },
        request,
      });
    }
    return (await repo.sessionById(tx, context.orgId, session.id)) ?? locked;
  }

  /** The order a code or id names, inside the caller's scope; one answer for none and hidden. */
  private async findOrder(
    tx: Tx,
    orgId: string,
    request: object,
    input: PackingOpenInput,
  ): Promise<string> {
    // M46 (D-806): a lot's code opens its order.
    const code = 'orderId' in input ? '' : normaliseScannedCode(input.code);
    const candidates =
      'orderId' in input
        ? [input.orderId]
        : await this.orders.orderIdsForShipmentCode(
            tx,
            orgId,
            parseLotCode(code)?.orderCode ?? code,
          );
    for (const id of candidates) {
      if (await this.orders.orderVisibleTo(tx, orgId, id, request)) return id;
    }
    // Nothing, or nothing the caller may see: the scope has nothing left to narrow.
    scopeWhere(request, { createdBy: sql`null`, assignedTo: sql`null`, branchId: sql`null` });
    throw new PackingError('SHIPMENT_NOT_FOUND', 'No order you can pack has this code.');
  }

  /** A session of an order inside the caller's scope, locked when it is about to change. */
  private async sessionInScope(
    tx: Tx,
    orgId: string,
    request: object,
    sessionId: string,
    forUpdate: boolean,
  ): Promise<repo.SessionRow> {
    const session = await repo.sessionById(tx, orgId, sessionId, { forUpdate });
    if (
      session === undefined ||
      !(await this.orders.orderVisibleTo(tx, orgId, session.order_id, request))
    ) {
      if (session === undefined) {
        scopeWhere(request, { createdBy: sql`null`, assignedTo: sql`null`, branchId: sql`null` });
      }
      throw new PackingError('NOT_FOUND', 'No such packing session.');
    }
    return session;
  }

  /**
   * The order's packing facts with the order row locked for this transaction: an edit of its
   * lines waits until the scan or the finish has been judged against the lines it read.
   */
  private async lockedFacts(tx: Tx, orgId: string, orderId: string): Promise<PackingFacts> {
    await this.orders.bookingSnapshot(tx, orgId, orderId, { forUpdate: true });
    const [facts] = await this.orders.packingFacts(tx, orgId, [orderId]);
    if (facts === undefined) throw new PackingError('NOT_FOUND', 'No such order.');
    return facts;
  }

  private assertPackable(facts: PackingFacts): void {
    if (facts.status !== 'confirmed') {
      throw new PackingError(
        'PACKING_NOT_PACKABLE',
        `Order ${facts.orderNo} is ${STATUS_WORDS[facts.status] ?? facts.status}, so it is not packed now.`,
      );
    }
  }

  /**
   * The packing record (who packed, every scan, the staff's names, the video's parts) is the
   * brand's own working record: a reseller holds `read Order` for their own orders and still
   * does not read it (D-665).
   */
  private assertStaff(context: ActiveContext): void {
    // A staff role that reads orders itself (the M38b re-check): not "any role but reseller",
    // or a reseller who is also an investor, whose role reads no order, would pass on the
    // reseller's own-orders grant.
    if (context.isSuperAdmin || context.roles.some(staffReadsOrders)) return;
    throw new PackingError('FORBIDDEN', 'The packing record is for the brand’s staff.');
  }

  private assertOpen(session: repo.SessionRow): void {
    if (session.status !== 'open') {
      throw new PackingError(
        'PACKING_NOT_PACKABLE',
        `Order ${session.order_no} is already packed; its packing is finished.`,
      );
    }
  }

  /** What the order needs, per SKU, with each SKU's product (to tell a wrong size). */
  private async needsOf(tx: Tx, orgId: string, facts: PackingFacts) {
    const skuFacts = await this.catalog.webSkuFacts(
      tx,
      orgId,
      facts.lines.map((line) => line.skuId),
    );
    const productOf = new Map(skuFacts.map((fact) => [fact.id, fact.productId]));
    return packNeeds(
      facts.lines.map((line) => ({
        skuId: line.skuId,
        productId: productOf.get(line.skuId) ?? null,
        qty: line.qty,
      })),
    );
  }

  private scanAnswer<T>(
    outcome: PackScanOutcome,
    skuId: string | null,
    rest: { readonly view: T; readonly repeated: boolean },
  ) {
    const refused = isPackScanRefusal(outcome);
    return {
      outcome,
      accepted: outcome === 'accepted',
      skuId,
      message: refused ? (REFUSAL_WORDS[outcome] ?? null) : null,
      repeated: rest.repeated,
      view: rest.view,
    };
  }

  private async names(tx: Tx, orgId: string): Promise<Map<string, string>> {
    return new Map(await this.iam.nameBook(tx, orgId));
  }

  /** Everything the station and the order page show about one session. */
  private async view(tx: Tx, orgId: string, session: repo.SessionRow, callerId: string) {
    const [facts] = await this.orders.packingFacts(tx, orgId, [session.order_id]);
    if (facts === undefined) throw new PackingError('NOT_FOUND', 'No such order.');
    const [list, scans, videos, names] = await Promise.all([
      this.scanner.packingList(tx, orgId, facts),
      repo.scansOf(tx, orgId, session.id),
      repo.videosOf(tx, orgId, [session.id]),
      this.names(tx, orgId),
    ]);
    const needs = await this.needsOf(tx, orgId, facts);
    const packed = packedCounts(
      scans.map((row) => ({ skuId: row.sku_id, outcome: row.outcome as PackScanOutcome })),
    );
    const progress = packProgress(needs, packed);

    // Names for every SKU a scan named, in the order or not.
    const scannedSkuIds = [
      ...new Set(scans.map((row) => row.sku_id).filter((id): id is string => id !== null)),
    ];
    const scannedFacts = await this.catalog.stickerData(tx, orgId, scannedSkuIds);
    const skuWords = new Map(
      scannedFacts.map((fact) => [
        fact.skuId,
        { sku: fact.skuCode, name: fact.productName, variant: fact.variantLabel },
      ]),
    );

    const itemOf = new Map(list.items.map((item) => [item.skuId, item]));
    const completedAt = at(session.completed_at);
    // M46 (D-807, D-804): the lots, the terminal and every camera filming it.
    const [lotCount, closures, extraCameras, terminal] = await Promise.all([
      labels.lotCountOf(tx, orgId, session.order_id),
      labels.closuresOf(tx, orgId, session.id),
      cameras.extraCamerasOf(tx, orgId, session.id),
      session.terminal_id === null
        ? Promise.resolve(undefined)
        : labels.terminalById(tx, orgId, session.terminal_id),
    ]);
    const lotPieces = piecesByLot(scans.map((row) => ({ lot: row.lot_no, outcome: row.outcome })));
    const open = session.status === 'open' ? openLot(lotCount, closures.length) : null;
    return {
      lots: {
        count: lotCount,
        open,
        closed: closures.map((closure) => ({
          lot: closure.lot_no,
          at: iso(closure.closed_at),
          by: { id: closure.closed_by, name: names.get(closure.closed_by) ?? null },
        })),
        pieces: Array.from({ length: lotCount }, (_, index) => ({
          lot: index + 1,
          pieces: lotPieces.get(index + 1) ?? 0,
        })),
      },
      terminal: terminal === undefined ? null : { id: terminal.id, name: terminal.name },
      cameraIds: [...(session.camera_id === null ? [] : [session.camera_id]), ...extraCameras],
      /** Who is asking: the name the station draws onto the video. */
      you: { id: callerId, name: names.get(callerId) ?? null },
      session: {
        id: session.id,
        orderId: session.order_id,
        orderNo: session.order_no,
        status: session.status,
        videoRequired: session.video_required,
        startedAt: iso(session.started_at),
        startedBy: { id: session.started_by, name: names.get(session.started_by) ?? null },
        completedAt: iso(session.completed_at),
        completedBy:
          session.completed_by === null
            ? null
            : { id: session.completed_by, name: names.get(session.completed_by) ?? null },
        // M38c (D-670, D-671): the IP camera filming it, and its recording's window. The
        // source is fixed once recording started or a piece is in the box (ledger audit N1).
        cameraId: session.camera_id,
        cameraLocked:
          session.recording_from !== null || scans.some((row) => row.outcome === 'accepted'),
        recordingFrom: iso(session.recording_from),
        recordingTo: iso(session.recording_to),
        recordingBy:
          session.recording_by === null
            ? null
            : { id: session.recording_by, name: names.get(session.recording_by) ?? null },
      },
      order: {
        id: list.id,
        orderNumber: list.orderNumber,
        status: list.status,
        channel: list.channel,
        paid: list.paid,
        cod: list.cod,
        notes: list.notes,
        courier: list.courier,
        consignmentId: list.consignmentId,
        trackingCode: list.trackingCode,
        recipient: { name: list.recipient.name, address: list.recipient.address },
      },
      lines: progress.lines.map((line) => {
        const item = itemOf.get(line.skuId);
        return {
          skuId: line.skuId,
          name: item?.name ?? skuWords.get(line.skuId)?.name ?? '',
          image: item?.image ?? '',
          sku: item?.sku ?? skuWords.get(line.skuId)?.sku ?? '',
          barcode: item?.barcode ?? null,
          size: item?.size ?? '',
          color: item?.color ?? '',
          required: line.required,
          packed: line.packed,
          state: line.state,
        };
      }),
      extra: progress.extra.map((entry) => ({
        skuId: entry.skuId,
        packed: entry.packed,
        sku: skuWords.get(entry.skuId)?.sku ?? '',
        name: skuWords.get(entry.skuId)?.name ?? '',
        variant: skuWords.get(entry.skuId)?.variant ?? '',
      })),
      progress: {
        unitsRequired: progress.unitsRequired,
        unitsPacked: progress.unitsPacked,
        complete: progress.complete,
      },
      scans: [...scans].reverse().map((row) => ({
        id: row.id,
        scanId: row.scan_id,
        code: row.code,
        skuId: row.sku_id,
        sku: row.sku_id === null ? null : (skuWords.get(row.sku_id)?.sku ?? null),
        name: row.sku_id === null ? null : (skuWords.get(row.sku_id)?.name ?? null),
        variant: row.sku_id === null ? null : (skuWords.get(row.sku_id)?.variant ?? null),
        outcome: row.outcome,
        at: iso(row.scanned_at),
        by: { id: row.scanned_by, name: names.get(row.scanned_by) ?? null },
        lot: row.lot_no,
      })),
      videos: videos.map((video) => ({
        id: video.id,
        part: video.part,
        state:
          video.deleted_at !== null
            ? ('deleted' as const)
            : video.file_id !== null
              ? ('uploaded' as const)
              : ('waiting' as const),
        mime: video.mime,
        startedAt: iso(video.started_at),
        durationMs: video.duration_ms,
        sizeBytes: video.size_bytes === null ? null : Number(video.size_bytes),
        uploadedAt: iso(video.uploaded_at),
        deletedAt: iso(video.deleted_at),
        deletedReason: video.deleted_reason,
        recordedBy: { id: video.recorded_by, name: names.get(video.recorded_by) ?? null },
        source: video.source,
        cameraId: video.camera_id,
      })),
      video: packingVideoState({
        videoRequired: session.video_required,
        sessionOpen: session.status === 'open',
        completedAt,
        parts: videos.map((video) => ({
          attached: video.file_id !== null,
          deleted: video.deleted_at !== null,
        })),
        now: new Date(),
      }),
    };
  }
}

/** A role other than reseller whose own grants read orders (D-665). */
function staffReadsOrders(role: MembershipRole): boolean {
  if (role === 'reseller') return false;
  return (MATRIX[role] ?? []).some(
    (rule) =>
      rule.subject === 'Order' &&
      (rule.action === 'read' || (Array.isArray(rule.action) && rule.action.includes('read'))),
  );
}
