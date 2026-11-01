import { Inject, Injectable } from '@nestjs/common';
import {
  type ErrorCode,
  type PackingRemovalInput,
  type PackingScanInput,
  type PackingSessionsQuery,
} from '@elysium/contracts';
import type {
  PackingReturnOpenInput,
  PackingReturnReceiveInput,
} from '@elysium/contracts/packing-returns';
import { withOrg, type Tx } from '@elysium/db';
import { isReturnReasonCode } from '@elysium/domain';
import { normaliseScannedCode } from '@elysium/domain/barcode';
import {
  isLabelReread,
  isPackScanRefusal,
  judgePackRemoval,
  judgePackScan,
  judgeReturnLabelScan,
  packNeeds,
  packedCounts,
  packingVideoState,
  piecesByLot,
  readOrderLabel,
  type LabelVerdict,
  type PackScanOutcome,
} from '@elysium/domain/packing';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { COURIER_API, type CourierApi } from '../courier/courier.api.js';
import { IAM_API, type IamApi } from '../iam/iam.api.js';
import { ORDERS_API, type OrdersApi, type PackingFacts } from '../orders/orders.api.js';
import * as cameras from './camera.repository.js';
import * as labels from './labels.repository.js';
import {
  recordingViews,
  startLotRecording,
  idlePauseMsOf,
  stopLotIfRunning,
} from './lot-recording.js';
import * as rec from './recording.repository.js';
import { ordersForScannedCode, ScannerService } from './scanner.service.js';
import { mapPackingErrors, PackingError } from './station.errors.js';
import * as repo from './station.repository.js';
import {
  labelFactsOf,
  labelRefusalWords,
  lastLabelOf,
  PackStationService,
} from './station.service.js';
import { TerminalsService } from './terminals.service.js';

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

/** The orders a returned parcel is received from: on its way back, or partly delivered. */
const RETURNABLE: readonly string[] = ['return_in_transit', 'partially_delivered'];

const STATUS_WORDS: Readonly<Record<string, string>> = {
  pending: 'not confirmed yet',
  confirmed: 'not sent yet',
  on_hold: 'on hold',
  packed: 'packed and not sent yet',
  shipped: 'still with the courier, not marked as returning',
  delivered: 'delivered',
  returned: 'already received back',
  cancelled: 'cancelled',
  exchange: 'exchanged',
};

/** What a refused piece says at the return table. */
const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  unknown_code: 'This code is no product of this brand. Scan the piece’s own sticker.',
  wrong_item: 'This product did not go out in this parcel.',
  wrong_variant: 'Wrong size or colour: this parcel went out with another variant of this product.',
  over: 'One too many: every piece of this item that went out is already scanned back.',
};

/** What a label scan did at the return table (D-934). */
export interface ReturnLabelAnswer {
  /** `ignored`: the scanner read the same label again at once; nothing changed. */
  readonly action: 'started' | 'stopped' | 'refused' | 'ignored';
  readonly lot: number | null;
  readonly message: string | null;
}

/**
 * The return station (M51, D-934): a parcel that came back is opened on camera, label to label,
 * every piece scanned against what went out, and received into stock in one transaction.
 *
 * A return is a packing session of kind `return` (one per order): its label scan starts a lot's
 * recording, which pauses after the brand's idle time with no scan (D-931) and stops at the
 * label scanned again; the bags of a multi-lot order come back in any order, one recording each
 * (D-932). The pieces are judged by M38b's own rule against what can still come back (no more of
 * a SKU than went out). Receive books the courier module's receipt (`COURIER_API.receiveReturn`:
 * the receipt, `receive_return`, the stock back at the dispatch cost and the journal) and
 * completes the session, all in one transaction (invariants 2, 3, 6, 12). No cost field reaches
 * the station (invariant 5).
 */
@Injectable()
export class ReturnStationService {
  constructor(
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    @Inject(IAM_API) private readonly iam: IamApi,
    @Inject(COURIER_API) private readonly courier: CourierApi,
    private readonly scanner: ScannerService,
    private readonly audit: AuditService,
    private readonly terminals: TerminalsService,
    private readonly station: PackStationService,
  ) {}

  /** Open the return station on a parcel that came back, or resume its inspection. */
  async open(
    context: ActiveContext,
    request: AuditableRequest,
    input: PackingReturnOpenInput,
    token: string | null = null,
  ) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const here = await this.terminals.resolve(tx, context, token, 'packing');
        const orderId = await this.findOrder(tx, context.orgId, request, input);
        let session = await repo.sessionByOrder(tx, context.orgId, orderId, 'return');
        if (session === undefined) {
          const [facts] = await this.orders.packingFacts(tx, context.orgId, [orderId]);
          if (facts === undefined) throw new PackingError('NOT_FOUND', 'No such order.');
          this.assertReturnable(facts);
          if ((await this.courier.parcelOfOrder(tx, context.orgId, orderId)) === null) {
            throw new PackingError(
              'PACKING_NOT_RETURNABLE',
              `Order ${facts.orderNo} has no courier parcel to receive back. Receive it from its own page.`,
            );
          }
          const settings = await repo.settingsOf(tx, context.orgId);
          const { row, created } = await repo.openSession(tx, {
            orgId: context.orgId,
            orderId,
            orderNo: facts.orderNo,
            videoRequired: settings?.video_enabled ?? true,
            startedBy: context.userId,
            terminalId: here?.terminal.id ?? null,
            kind: 'return',
          });
          if (created) {
            await this.audit.record(tx, {
              orgId: context.orgId,
              actorUserId: context.userId,
              operation: 'create',
              action: 'packing.return_opened',
              entityType: 'packing_session',
              entityId: row.id,
              after: { orderId, orderNo: facts.orderNo, videoRequired: row.video_required },
              request,
            });
          }
          session = row;
        }
        if (here !== null && input.cameraId === undefined) {
          session = await this.station.terminalCameras(tx, context, request, session, here);
        } else if (input.cameraId !== undefined) {
          session = await this.station.chooseCamera(tx, context, request, session, input.cameraId);
        }
        if ('code' in input && session.status === 'open') {
          await this.startFromOpeningScan(tx, context, request, session, input.code);
        }
        return this.view(tx, context.orgId, session, context.userId);
      }),
    );
  }

  /** The order page's return record: its inspection, or none (the order checked first). */
  async forOrder(context: ActiveContext, request: object, orderId: string) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        if (!(await this.orders.orderVisibleTo(tx, context.orgId, orderId, request))) {
          throw new PackingError('NOT_FOUND', 'No such order.');
        }
        const session = await repo.sessionByOrder(tx, context.orgId, orderId, 'return');
        if (session === undefined) return { session: null };
        return this.view(tx, context.orgId, session, context.userId);
      }),
    );
  }

  async get(context: ActiveContext, request: object, sessionId: string) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const session = await this.sessionInScope(tx, context.orgId, request, sessionId, false);
        return this.view(tx, context.orgId, session, context.userId);
      }),
    );
  }

  /** One scan at the return table: the parcel's label starts or stops a bag; else a piece. */
  async scan(
    context: ActiveContext,
    request: AuditableRequest,
    sessionId: string,
    input: PackingScanInput,
  ) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const { session, facts } = await this.locked(tx, context.orgId, request, sessionId);
        const again = await repo.scanByScanId(tx, context.orgId, sessionId, input.scanId);
        if (again !== undefined) {
          return this.answer(again.outcome as PackScanOutcome, again.sku_id, null, {
            view: await this.view(tx, context.orgId, session, context.userId),
            repeated: true,
          });
        }
        this.assertOpen(session);
        this.assertReturnable(facts);
        const code = normaliseScannedCode(input.code);
        const label = readOrderLabel(code, labelFactsOf(facts));
        if (label !== null) {
          const answer = await this.labelScan(tx, context, request, session, {
            scanId: input.scanId,
            code,
            lot: label.lot,
          });
          return this.answer('label', null, answer, {
            view: await this.view(tx, context.orgId, session, context.userId),
            repeated: false,
          });
        }
        const recordings = await rec.recordingsOf(tx, context.orgId, sessionId);
        const running = recordings.find((row) => row.stopped_at === null);
        if (running === undefined) {
          const lotCount = await labels.lotCountOf(tx, context.orgId, session.order_id);
          throw new PackingError(
            'PACKING_LABEL_FIRST',
            lotCount > 1
              ? 'Scan the label of the bag you are opening first: it starts that bag’s recording.'
              : 'Scan the parcel label first: it starts the recording.',
          );
        }
        const found =
          code === '' ? undefined : await this.catalog.lookupCode(tx, context.orgId, code);
        const earlier = await repo.scansOf(tx, context.orgId, sessionId);
        const outcome = judgePackScan({
          needs: await this.needsOf(tx, context.orgId, facts),
          packed: packedCounts(
            earlier.map((row) => ({ skuId: row.sku_id, outcome: row.outcome as PackScanOutcome })),
          ),
          scanned: found === undefined ? null : { skuId: found.skuId, productId: found.productId },
        });
        await repo.insertScan(tx, {
          orgId: context.orgId,
          sessionId,
          scanId: input.scanId,
          code: code.slice(0, 120),
          skuId: found?.skuId ?? null,
          outcome,
          scannedBy: context.userId,
          lotNo: running.lot_no,
        });
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: outcome === 'accepted' ? 'packing.return_scanned' : 'packing.return_scan_refused',
          entityType: 'packing_session',
          entityId: sessionId,
          after: {
            orderId: session.order_id,
            skuId: found?.skuId ?? null,
            outcome,
            lot: running.lot_no,
          },
          request,
        });
        return this.answer(outcome, found?.skuId ?? null, null, {
          view: await this.view(tx, context.orgId, session, context.userId),
          repeated: false,
        });
      }),
    );
  }

  /** Take one piece scanned back out again (a scan by mistake): from the bag being opened first. */
  async remove(
    context: ActiveContext,
    request: AuditableRequest,
    sessionId: string,
    input: PackingRemovalInput,
  ) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const { session, facts } = await this.locked(tx, context.orgId, request, sessionId);
        const again = await repo.scanByScanId(tx, context.orgId, sessionId, input.scanId);
        if (again !== undefined) return this.view(tx, context.orgId, session, context.userId);
        this.assertOpen(session);
        this.assertReturnable(facts);
        const scans = await repo.scansOf(tx, context.orgId, sessionId);
        const running = (await rec.recordingsOf(tx, context.orgId, sessionId)).find(
          (row) => row.stopped_at === null,
        );
        const lots = [...new Set(scans.map((row) => row.lot_no))].sort((a, b) => b - a);
        const ordered =
          running === undefined
            ? lots
            : [running.lot_no, ...lots.filter((lot) => lot !== running.lot_no)];
        const lot = ordered.find(
          (candidate) =>
            judgePackRemoval(
              packedCounts(
                scans
                  .filter((row) => row.lot_no === candidate)
                  .map((row) => ({ skuId: row.sku_id, outcome: row.outcome as PackScanOutcome })),
              ),
              input.skuId,
            ) === 'removed',
        );
        if (lot === undefined) {
          throw new PackingError(
            'PACKING_NOTHING_TO_REMOVE',
            'No piece of that item was scanned back to take out.',
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
          action: 'packing.return_piece_removed',
          entityType: 'packing_session',
          entityId: sessionId,
          after: { orderId: session.order_id, skuId: input.skuId, lot },
          request,
        });
        return this.view(tx, context.orgId, session, context.userId);
      }),
    );
  }

  /**
   * Receive the return into stock: the pieces scanned back, sellable but for the ones marked
   * damaged, with the reason. The courier module's receipt and the order's `receive_return`
   * (stock back, the journal) run in this transaction, and the session completes with them.
   */
  async receive(
    context: ActiveContext,
    request: AuditableRequest,
    sessionId: string,
    input: PackingReturnReceiveInput,
  ) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const peek = await this.sessionInScope(tx, context.orgId, request, sessionId, false);
        this.assertOpen(peek);
        // The consignment first, as every receipt takes it (N1): two routes at one parcel wait.
        const parcel = await this.courier.parcelOfOrder(tx, context.orgId, peek.order_id, {
          forUpdate: true,
        });
        if (parcel === null) {
          throw new PackingError(
            'PACKING_NOT_RETURNABLE',
            `Order ${peek.order_no} has no courier parcel to receive back.`,
          );
        }
        const { session, facts } = await this.locked(tx, context.orgId, request, sessionId);
        this.assertOpen(session);
        this.assertReturnable(facts);
        if (!isReturnReasonCode(input.returnReason)) {
          throw new PackingError('RETURN_RECEIPT_INVALID', 'Choose why the parcel came back.');
        }
        const scans = await repo.scansOf(tx, context.orgId, sessionId);
        const back = packedCounts(
          scans.map((row) => ({
            skuId: row.sku_id,
            outcome: row.outcome as PackScanOutcome,
          })),
        );
        if (back.size === 0) {
          throw new PackingError(
            'RETURN_RECEIPT_INVALID',
            'Scan at least one piece that came back before receiving the return.',
          );
        }
        const damaged = new Map<string, number>();
        for (const entry of input.damaged) {
          damaged.set(entry.skuId, (damaged.get(entry.skuId) ?? 0) + entry.qty);
        }
        for (const [skuId, qty] of damaged) {
          if (qty > (back.get(skuId) ?? 0)) {
            throw new PackingError(
              'RETURN_RECEIPT_INVALID',
              'More pieces are marked damaged than were scanned back for one item.',
            );
          }
        }
        // What this receipt leaves out can never be booked in later (a parcel has one receipt),
        // so it is said out loud first (D-939).
        const missing = await this.missingWords(tx, context.orgId, facts, back);
        const opened = new Set(
          (await rec.recordingsOf(tx, context.orgId, sessionId)).map((row) => row.lot_no),
        );
        const lotCount = await labels.lotCountOf(tx, context.orgId, session.order_id);
        const unopened = Array.from({ length: lotCount }, (_, index) => index + 1).filter(
          (lot) => !opened.has(lot),
        );
        const unopenedWords =
          unopened.length === 0 ? '' : `Bags not opened: ${unopened.map(String).join(', ')}`;
        if ((missing !== '' || unopened.length > 0) && input.acknowledgeShort !== true) {
          throw new PackingError(
            'RETURN_RECEIPT_INVALID',
            `${[missing, unopenedWords].filter((part) => part !== '').join('. ')}. A parcel has one receipt: confirm this, or scan them first.`,
          );
        }
        // Every bag still being opened stops with the receipt (D-932).
        for (const row of await rec.recordingsOf(tx, context.orgId, sessionId)) {
          if (row.stopped_at !== null) continue;
          await stopLotIfRunning(tx, this.audit, {
            orgId: context.orgId,
            userId: context.userId,
            request,
            session,
            lot: row.lot_no,
            reason: 'received',
          });
        }
        // What did not come back first: the note is cut at the receipt's 1,000 (N3).
        const note = [missing, unopenedWords, input.inspectionNote ?? '']
          .filter((part) => part !== '')
          .join('\n');
        let received: { readonly receiptId: string; readonly orderStatus: string };
        try {
          received = await this.courier.receiveReturn(tx, context, request, parcel.consignmentId, {
            reason: input.reason,
            returnReason: input.returnReason,
            ...(note === '' ? {} : { inspectionNote: note.slice(0, 1000) }),
            ...(input.damagedLocationId === undefined
              ? {}
              : { damagedLocationId: input.damagedLocationId }),
            lines: [...back].map(([skuId, qty]) => ({
              skuId,
              sellableQty: qty - (damaged.get(skuId) ?? 0),
              damagedQty: damaged.get(skuId) ?? 0,
            })),
          });
        } catch (error) {
          // The courier module's own refusal, in its words (a receipt already booked, a shelf).
          if (error instanceof Error && error.name === 'CourierError') {
            throw new PackingError((error as unknown as { code: ErrorCode }).code, error.message);
          }
          throw error;
        }
        if (received.orderStatus !== 'returned') {
          throw new PackingError(
            'PACKING_NOT_RETURNABLE',
            `Order ${facts.orderNo} did not move to returned; receive it from the order page.`,
          );
        }
        // `orderReturned` closed it in the receipt's own transaction (D-938); should its listener
        // have failed, it closes here, or nothing of this receipt stands.
        if (!(await repo.completeSession(tx, context.orgId, sessionId, context.userId))) {
          const closed = await repo.sessionById(tx, context.orgId, sessionId);
          if (closed?.status !== 'completed') {
            throw new PackingError('CONFLICT', 'This return changed; open it again.');
          }
        }
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'packing.return_received',
          entityType: 'packing_session',
          entityId: sessionId,
          before: { status: 'open', orderStatus: facts.status },
          after: {
            status: 'completed',
            orderStatus: received.orderStatus,
            receiptId: received.receiptId,
            pieces: [...back.values()].reduce((sum, qty) => sum + qty, 0),
            damaged: [...damaged.values()].reduce((sum, qty) => sum + qty, 0),
            // M53 (D-948): what came back in which bag.
            lots: Object.fromEntries(
              piecesByLot(scans.map((row) => ({ lot: row.lot_no, outcome: row.outcome }))),
            ),
          },
          request,
        });
        const done = await repo.sessionById(tx, context.orgId, sessionId);
        return this.view(tx, context.orgId, done ?? session, context.userId);
      }),
    );
  }

  /** The newest return inspections of orders the caller may see. */
  async list(context: ActiveContext, request: object, query: PackingSessionsQuery) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const shown = await repo.recentSessions(tx, context.orgId, {
          limit: query.limit,
          status: query.status,
          kind: 'return',
          orderInScope: this.orders.orderInScopeSql(context.orgId, sql`s.order_id`, request),
        });
        const [videos, names] = await Promise.all([
          repo.videosOf(
            tx,
            context.orgId,
            shown.map((row) => row.id),
          ),
          this.iam.nameBook(tx, context.orgId),
        ]);
        const nameOf = new Map(names);
        const now = new Date();
        return {
          items: shown.map((row) => {
            const parts = videos.filter((video) => video.session_id === row.id);
            return {
              id: row.id,
              orderId: row.order_id,
              orderNo: row.order_no,
              status: row.status,
              startedAt: iso(row.started_at),
              startedBy: { id: row.started_by, name: nameOf.get(row.started_by) ?? null },
              completedAt: iso(row.completed_at),
              pieces: row.accepted - row.removed,
              mismatches: row.mismatches,
              lots: new Set(parts.map((part) => part.lot_no)).size,
              video: packingVideoState({
                videoRequired: row.video_required,
                sessionOpen: row.status === 'open',
                completedAt: row.completed_at === null ? null : new Date(row.completed_at),
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

  // --- the parts --------------------------------------------------------------------------

  /** A label at the return table (D-934): a bag starts, stops, or the scan is refused. */
  private async labelScan(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    session: repo.SessionRow,
    scan: { readonly scanId: string; readonly code: string; readonly lot: number | null },
  ): Promise<ReturnLabelAnswer> {
    const orgId = context.orgId;
    const lotCount = await labels.lotCountOf(tx, orgId, session.order_id);
    const recordings = await rec.recordingsOf(tx, orgId, session.id);
    const running = recordings.find((row) => row.stopped_at === null)?.lot_no ?? null;
    const reread = isLabelReread({
      code: scan.code,
      last: lastLabelOf(await repo.scansOf(tx, orgId, session.id)),
      nowMs: (await cameras.transactionNow(tx)).getTime(),
    });
    const verdict = judgeReturnLabelScan({
      lotCount,
      scannedLot: scan.lot,
      recordingLot: running,
      doneLots: new Set(
        recordings.filter((row) => row.stopped_at !== null).map((row) => row.lot_no),
      ),
    });
    const written = await repo.insertScan(tx, {
      orgId,
      sessionId: session.id,
      scanId: scan.scanId,
      code: scan.code.slice(0, 120),
      skuId: null,
      outcome: 'label',
      scannedBy: context.userId,
      lotNo: reread || verdict.kind === 'refused' ? (running ?? 1) : verdict.lot,
    });
    let answer: ReturnLabelAnswer;
    if (reread) {
      answer = { action: 'ignored', lot: running, message: null };
    } else if (verdict.kind === 'start') {
      await startLotRecording(tx, this.audit, {
        orgId,
        userId: context.userId,
        request,
        session,
        lot: verdict.lot,
        labelScan: written,
      });
      answer = { action: 'started', lot: verdict.lot, message: null };
    } else if (verdict.kind === 'stop') {
      await stopLotIfRunning(tx, this.audit, {
        orgId,
        userId: context.userId,
        request,
        session,
        lot: verdict.lot,
        reason: 'label',
        scanId: written.id,
      });
      answer = { action: 'stopped', lot: verdict.lot, message: null };
    } else {
      answer = { action: 'refused', lot: verdict.lot, message: returnRefusal(verdict, lotCount) };
    }
    await this.audit.record(tx, {
      orgId,
      actorUserId: context.userId,
      operation: 'update',
      action: 'packing.return_label_scanned',
      entityType: 'packing_session',
      entityId: session.id,
      after: { orderId: session.order_id, lot: answer.lot, action: answer.action },
      request,
    });
    return answer;
  }

  /** The scan that opened the return, when it is the parcel's label: it starts that bag. */
  private async startFromOpeningScan(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    opened: repo.SessionRow,
    typed: string,
  ): Promise<void> {
    const orgId = context.orgId;
    const session = await repo.sessionById(tx, orgId, opened.id, { forUpdate: true });
    if (session?.status !== 'open') return;
    const [facts] = await this.orders.packingFacts(tx, orgId, [session.order_id]);
    if (facts === undefined || !RETURNABLE.includes(facts.status)) return;
    const code = normaliseScannedCode(typed);
    const label = readOrderLabel(code, labelFactsOf(facts));
    if (label === null) return;
    const recordings = await rec.recordingsOf(tx, orgId, session.id);
    if (recordings.some((row) => row.stopped_at === null)) return;
    // Opening again only resumes the return: a done bag reopens at the station's own scan.
    if (recordings.length > 0 && label.lot === null) return;
    const verdict = judgeReturnLabelScan({
      lotCount: await labels.lotCountOf(tx, orgId, session.order_id),
      scannedLot: label.lot,
      recordingLot: null,
      doneLots: new Set(recordings.map((row) => row.lot_no)),
    });
    if (verdict.kind !== 'start') return;
    const written = await repo.insertScan(tx, {
      orgId,
      sessionId: session.id,
      scanId: randomUUID(),
      code: code.slice(0, 120),
      skuId: null,
      outcome: 'label',
      scannedBy: context.userId,
      lotNo: verdict.lot,
    });
    await startLotRecording(tx, this.audit, {
      orgId,
      userId: context.userId,
      request,
      session,
      lot: verdict.lot,
      labelScan: written,
    });
  }

  /** The order a code or id names, inside the caller's scope; one answer for none and hidden. */
  private async findOrder(
    tx: Tx,
    orgId: string,
    request: object,
    input: PackingReturnOpenInput,
  ): Promise<string> {
    const candidates =
      'orderId' in input
        ? [input.orderId]
        : (await ordersForScannedCode(this.orders, tx, orgId, normaliseScannedCode(input.code)))
            .orderIds;
    for (const id of candidates) {
      if (await this.orders.orderVisibleTo(tx, orgId, id, request)) return id;
    }
    scopeWhere(request, { createdBy: sql`null`, assignedTo: sql`null`, branchId: sql`null` });
    throw new PackingError('SHIPMENT_NOT_FOUND', 'No order you can receive has this code.');
  }

  private async sessionInScope(
    tx: Tx,
    orgId: string,
    request: object,
    sessionId: string,
    forUpdate: boolean,
  ): Promise<repo.SessionRow> {
    const session = await repo.sessionById(tx, orgId, sessionId, { forUpdate });
    if (
      session?.kind !== 'return' ||
      !(await this.orders.orderVisibleTo(tx, orgId, session.order_id, request))
    ) {
      if (session === undefined) {
        scopeWhere(request, { createdBy: sql`null`, assignedTo: sql`null`, branchId: sql`null` });
      }
      throw new PackingError('NOT_FOUND', 'No such return.');
    }
    return session;
  }

  /**
   * The session and its order, locked in the order a receipt from any route locks them: the
   * order, then this session through `orderReturned` (N1). A scan racing a receipt from another
   * page waits for it and is then told, rather than deadlocking with it.
   */
  private async locked(
    tx: Tx,
    orgId: string,
    request: object,
    sessionId: string,
  ): Promise<{ readonly session: repo.SessionRow; readonly facts: PackingFacts }> {
    const peek = await this.sessionInScope(tx, orgId, request, sessionId, false);
    const facts = await this.lockedFacts(tx, orgId, peek.order_id);
    const session = (await repo.sessionById(tx, orgId, sessionId, { forUpdate: true })) ?? peek;
    return { session, facts };
  }

  private async lockedFacts(tx: Tx, orgId: string, orderId: string): Promise<PackingFacts> {
    await this.orders.bookingSnapshot(tx, orgId, orderId, { forUpdate: true });
    const [facts] = await this.orders.packingFacts(tx, orgId, [orderId]);
    if (facts === undefined) throw new PackingError('NOT_FOUND', 'No such order.');
    return facts;
  }

  private assertReturnable(facts: PackingFacts): void {
    if (!RETURNABLE.includes(facts.status)) {
      throw new PackingError(
        'PACKING_NOT_RETURNABLE',
        `Order ${facts.orderNo} is ${STATUS_WORDS[facts.status] ?? facts.status}, so it is not received as a return now.`,
      );
    }
  }

  private assertOpen(session: repo.SessionRow): void {
    if (session.status !== 'open') {
      throw new PackingError(
        'PACKING_NOT_RETURNABLE',
        `The return of order ${session.order_no} is already received.`,
      );
    }
  }

  /** What can still come back, per SKU, with each SKU's product (to tell a wrong size). */
  private async needsOf(tx: Tx, orgId: string, facts: PackingFacts) {
    const returnable = await this.orders.returnableLines(tx, orgId, facts.id);
    const skuFacts = await this.catalog.webSkuFacts(
      tx,
      orgId,
      returnable.map((line) => line.skuId),
    );
    const productOf = new Map(skuFacts.map((fact) => [fact.id, fact.productId]));
    // Quantities only: the dispatch cost on these lines never leaves this function (invariant 5).
    return packNeeds(
      returnable.map((line) => ({
        skuId: line.skuId,
        productId: productOf.get(line.skuId) ?? null,
        qty: line.outstandingQty,
      })),
    );
  }

  /** "Not in the parcel: 1 × SKU" for the receipt's note, when pieces did not come back. */
  private async missingWords(
    tx: Tx,
    orgId: string,
    facts: PackingFacts,
    back: ReadonlyMap<string, number>,
  ): Promise<string> {
    const needs = await this.needsOf(tx, orgId, facts);
    const codeOf = new Map(facts.lines.map((line) => [line.skuId, line.skuCode]));
    const missing = needs
      .filter((need) => need.required > (back.get(need.skuId) ?? 0))
      .map(
        (need) =>
          `${String(need.required - (back.get(need.skuId) ?? 0))} × ${codeOf.get(need.skuId) ?? need.skuId}`,
      );
    return missing.length === 0 ? '' : `Not in the parcel: ${missing.join(', ')}`;
  }

  private answer<T>(
    outcome: PackScanOutcome | 'label',
    skuId: string | null,
    label: ReturnLabelAnswer | null,
    rest: { readonly view: T; readonly repeated: boolean },
  ) {
    const refused = outcome !== 'label' && isPackScanRefusal(outcome);
    return {
      outcome,
      accepted: outcome === 'accepted',
      skuId,
      message: label?.message ?? (refused ? (REFUSAL_WORDS[outcome] ?? null) : null),
      repeated: rest.repeated,
      label,
      view: rest.view,
    };
  }

  /** Everything the return station and the order page show about one return. */
  private async view(tx: Tx, orgId: string, session: repo.SessionRow, callerId: string) {
    const [facts] = await this.orders.packingFacts(tx, orgId, [session.order_id]);
    if (facts === undefined) throw new PackingError('NOT_FOUND', 'No such order.');
    const [list, scans, videos, nameBook, recordings, lotCount, extraCameras, idleMs] =
      await Promise.all([
        this.scanner.packingList(tx, orgId, facts),
        repo.scansOf(tx, orgId, session.id),
        repo.videosOf(tx, orgId, [session.id]),
        this.iam.nameBook(tx, orgId),
        rec.recordingsOf(tx, orgId, session.id),
        labels.lotCountOf(tx, orgId, session.order_id),
        cameras.extraCamerasOf(tx, orgId, session.id),
        idlePauseMsOf(tx, orgId),
      ]);
    const names = new Map(nameBook);
    const open = session.status === 'open';
    const needs = open ? await this.needsOf(tx, orgId, facts) : [];
    const back = packedCounts(
      scans.map((row) => ({ skuId: row.sku_id, outcome: row.outcome as PackScanOutcome })),
    );
    const scannedSkuIds = [
      ...new Set(scans.map((row) => row.sku_id).filter((id): id is string => id !== null)),
    ];
    const words = new Map(
      (await this.catalog.stickerData(tx, orgId, scannedSkuIds)).map((fact) => [
        fact.skuId,
        { sku: fact.skuCode, name: fact.productName, variant: fact.variantLabel },
      ]),
    );
    const items = new Map<string, (typeof list.items)[number]>();
    for (const item of list.items) if (!items.has(item.skuId)) items.set(item.skuId, item);
    const expectedOf = new Map(needs.map((need) => [need.skuId, need.required]));
    const skuIds = [...new Set([...items.keys()])].filter(
      (skuId) => (expectedOf.get(skuId) ?? 0) > 0 || (back.get(skuId) ?? 0) > 0,
    );
    const lines = skuIds.map((skuId) => {
      const item = items.get(skuId);
      const got = back.get(skuId) ?? 0;
      // Once received, what came back is what was expected of this parcel.
      const expected = open ? (expectedOf.get(skuId) ?? 0) : got;
      return {
        skuId,
        name: item?.name ?? words.get(skuId)?.name ?? '',
        image: item?.image ?? '',
        sku: item?.sku ?? words.get(skuId)?.sku ?? '',
        barcode: item?.barcode ?? null,
        size: item?.size ?? '',
        color: item?.color ?? '',
        expected,
        back: got,
        state:
          got > expected
            ? ('over' as const)
            : got === expected
              ? ('done' as const)
              : got === 0
                ? ('todo' as const)
                : ('partial' as const),
      };
    });
    const running = recordings.find((row) => row.stopped_at === null)?.lot_no ?? null;
    // A bag reopened (D-934) is being opened, not done.
    const doneLots = new Set(recordings.map((row) => row.lot_no).filter((lot) => lot !== running));
    const lotPieces = piecesByLot(scans.map((row) => ({ lot: row.lot_no, outcome: row.outcome })));
    const unitsExpected = lines.reduce((sum, line) => sum + line.expected, 0);
    const unitsBack = lines.reduce((sum, line) => sum + line.back, 0);
    // M53 (D-948): what the packer put in each bag, when it went through the station.
    const packing = await repo.sessionByOrder(tx, orgId, session.order_id, 'pack');
    const wentOut =
      packing === undefined
        ? new Map<number, number>()
        : piecesByLot(
            (await repo.scansOf(tx, orgId, packing.id)).map((row) => ({
              lot: row.lot_no,
              outcome: row.outcome,
            })),
          );
    return {
      kind: 'return' as const,
      idlePauseMs: idleMs,
      recordings: recordingViews(recordings, scans, names, new Date()),
      labelNeeded: open && running === null && doneLots.size < lotCount,
      lots: {
        count: lotCount,
        recording: running,
        done: [...doneLots].sort((a, b) => a - b),
        pieces: Array.from({ length: lotCount }, (_, index) => ({
          lot: index + 1,
          pieces: lotPieces.get(index + 1) ?? 0,
          expected: wentOut.get(index + 1) ?? null,
        })),
      },
      cameraIds: [...(session.camera_id === null ? [] : [session.camera_id]), ...extraCameras],
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
        cameraId: session.camera_id,
        cameraLocked: recordings.length > 0,
      },
      order: {
        id: list.id,
        orderNumber: list.orderNumber,
        status: list.status,
        courier: list.courier,
        consignmentId: list.consignmentId,
        trackingCode: list.trackingCode,
        recipient: { name: list.recipient.name, address: list.recipient.address },
        notes: list.notes,
      },
      lines,
      progress: {
        unitsExpected,
        unitsBack,
        missing: lines.reduce((sum, line) => sum + Math.max(0, line.expected - line.back), 0),
      },
      scans: [...scans].reverse().map((row) => ({
        id: row.id,
        code: row.code,
        skuId: row.sku_id,
        sku: row.sku_id === null ? null : (words.get(row.sku_id)?.sku ?? null),
        name: row.sku_id === null ? null : (words.get(row.sku_id)?.name ?? null),
        variant: row.sku_id === null ? null : (words.get(row.sku_id)?.variant ?? null),
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
        source: video.source,
        cameraId: video.camera_id,
        recordingId: video.recording_id,
        lot: video.lot_no,
      })),
      video: packingVideoState({
        videoRequired: session.video_required,
        sessionOpen: open,
        completedAt: session.completed_at === null ? null : new Date(session.completed_at),
        parts: videos.map((video) => ({
          attached: video.file_id !== null,
          deleted: video.deleted_at !== null,
        })),
        now: new Date(),
      }),
    };
  }
}

/** A refused label at the return table, in words. */
function returnRefusal(verdict: Extract<LabelVerdict, { kind: 'refused' }>, lotCount: number) {
  if (verdict.reason === 'other_lot') {
    return `Bag ${String(verdict.expected ?? '')} is being opened: scan its label again to finish it first.`;
  }
  if (verdict.reason === 'all_done') {
    return 'Every bag of this parcel is done: receive the return, or scan a bag’s own label to reopen it.';
  }
  return labelRefusalWords(verdict, lotCount);
}
