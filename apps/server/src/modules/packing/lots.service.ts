import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { HandoverScanInput, HandoverShipInput, LotCountInput } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import { normaliseScannedCode } from '@elysium/domain/barcode';
import { sql } from 'drizzle-orm';
import {
  handoverComplete,
  handoverMissing,
  judgeConfirmLots,
  judgeHandoverScan,
  judgeLotCount,
  lotCountLimit,
  piecesByLot,
} from '@elysium/domain/packing';

import { AuditService } from '../../platform/audit/audit.service.js';
import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { HandoverGuardRegistry, type HandoverGuard } from '../orders/ports/handover-guard.port.js';
import {
  ParcelObserverRegistry,
  type ParcelObserver,
} from '../orders/ports/parcel-observer.port.js';
import * as labels from './labels.repository.js';
import { stopLotRecording } from './lot-recording.js';
import * as rec from './recording.repository.js';
import { ordersForScannedCode } from './scanner.service.js';
import { mapPackingErrors, PackingError } from './station.errors.js';
import * as station from './station.repository.js';
import { TerminalsService } from './terminals.service.js';

/** An order at or past the handover: the courier has it (D-904), so a scan is not a refusal. */
const HANDED_STATUSES: readonly string[] = [
  'shipped',
  'delivered',
  'partially_delivered',
  'return_in_transit',
  'returned',
  'exchange',
];

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

/** "lots 2 and 3", "lot 3". */
function lotWords(lots: readonly number[]): string {
  if (lots.length === 1) return `lot ${String(lots[0])}`;
  return `lots ${lots.slice(0, -1).join(', ')} and ${String(lots[lots.length - 1])}`;
}

/**
 * The lots whose label is not printed at the order's current count, with its consignment (D-928):
 * a label printed for another count ("Lot 1 of 2" when there are now 3) is not the order's any
 * more (D-805), so a revised count needs every lot's label again.
 */
export async function lotsAwaitingLabel(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<{ readonly lotCount: number; readonly missing: readonly number[] }> {
  const lotCount = await labels.lotCountOf(tx, orgId, orderId);
  const printed = await labels.printedCounts(tx, orgId, [orderId]);
  return {
    lotCount,
    missing: Array.from({ length: lotCount }, (_, index) => index + 1).filter(
      (lot) => (printed.get(`${orderId}:label:${String(lot)}`) ?? 0) === 0,
    ),
  };
}

/**
 * M52 (D-942): what the packer is told while labels are still to print, or null when they all
 * are. After a revised count a label scanned meanwhile is an old one, or names a bag with no label
 * yet, so no lot starts or closes on it.
 */
export async function awaitedLabelsWords(
  tx: Tx,
  input: { readonly orgId: string; readonly orderId: string; readonly orderNo: string },
): Promise<string | null> {
  const { lotCount, missing } = await lotsAwaitingLabel(tx, input.orgId, input.orderId);
  if (missing.length === 0) return null;
  return lotCount === 1
    ? `Order ${input.orderNo} goes in one lot and its label is not printed yet: wait for it from Labels, then scan that.`
    : `Order ${input.orderNo} goes in ${String(lotCount)} lots and the labels of ${lotWords(missing)} are not printed yet: wait for them from Labels, then scan those.`;
}

/**
 * D-928: every lot's label printed, at the order's current lot count and with its consignment (a
 * "Not booked" label is not the order's label). What packing waits for: the desk's Pack, the
 * station's opening scan and its Finish.
 */
export async function assertLabelsPrinted(
  tx: Tx,
  input: { readonly orgId: string; readonly orderId: string; readonly orderNo: string },
): Promise<void> {
  const { lotCount, missing } = await lotsAwaitingLabel(tx, input.orgId, input.orderId);
  if (missing.length === 0) return;
  throw new PackingError(
    'ORDER_LABEL_NOT_PRINTED',
    lotCount === 1
      ? `Order ${input.orderNo}'s label is not printed yet: print it from Ready for label before packing.`
      : `Order ${input.orderNo} goes in ${String(lotCount)} lots: print the label of ${lotWords(missing)} before packing.`,
  );
}

/**
 * Lots and the handover (M46, D-805 to D-808), and the two hooks the orders module calls:
 *
 * - **the parcel observer**: in the confirm's transaction the order is kept as ready for its
 *   label (D-914); in the courier's booking transaction the row gains its consignment (D-817); a
 *   booking that failed for good keeps it ready without one (D-914). Nothing prints by itself
 *   (D-917): the order waits in "Ready for label" until a person prints it, one or many at once;
 * - **the handover guard**: a person's Confirm above the brand's limit says how many lots (M52,
 *   D-941), a Pack is refused until every lot's label was printed with its consignment (D-928),
 *   and a person's Ship of an order in several lots until every lot's label was scanned at the
 *   handover (D-808).
 *
 * The lot count and an order's handover scans change one at a time per order (an advisory lock),
 * and a count change also waits for the order's open packing session, so a scan at the station
 * is judged against the count it read.
 */
@Injectable()
export class LotsService implements ParcelObserver, HandoverGuard, OnModuleInit {
  constructor(
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    private readonly terminals: TerminalsService,
    private readonly audit: AuditService,
    private readonly parcels: ParcelObserverRegistry,
    private readonly guards: HandoverGuardRegistry,
  ) {}

  onModuleInit(): void {
    this.parcels.register(this);
    this.guards.register(this);
  }

  /**
   * One change to an order's lots at a time, in the one lock order every path takes (M46 ledger
   * audit, W1): the order's own row, then the order's lots. The orders module's Ship locks the
   * row before it asks the guard, so the two never wait on each other the other way round.
   */
  private async lockOrder(tx: Tx, orgId: string, orderId: string): Promise<void> {
    await this.orders.bookingSnapshot(tx, orgId, orderId, { forUpdate: true });
    await labels.lockOrderLots(tx, orgId, orderId);
  }

  // --- the orders module's hooks -----------------------------------------------------------

  /**
   * M51 (D-938): the order was received back, by the station, the courier's page or the order's
   * own. Its open return inspection ends here, in that transaction: a bag still being opened
   * stops, and the session completes, so no inspection reads open for ever and its videos reach
   * their thirty days (D-935). Its own rows only.
   */
  async orderReturned(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly orderId: string;
      readonly userId: string;
      readonly at: Date;
    },
  ): Promise<void> {
    const found = await station.sessionByOrder(tx, input.orgId, input.orderId, 'return');
    if (found?.status !== 'open') return;
    const session = await station.sessionById(tx, input.orgId, found.id, { forUpdate: true });
    if (session?.status !== 'open') return;
    for (const recording of await rec.recordingsOf(tx, input.orgId, session.id)) {
      if (recording.stopped_at !== null) continue;
      await stopLotRecording(tx, this.audit, {
        orgId: input.orgId,
        userId: input.userId,
        session,
        recording,
        reason: 'received',
        at: input.at,
      });
    }
    if (!(await station.completeSession(tx, input.orgId, session.id, input.userId))) return;
    await this.audit.record(tx, {
      orgId: input.orgId,
      actorUserId: input.userId,
      operation: 'update',
      action: 'packing.return_closed',
      entityType: 'packing_session',
      entityId: session.id,
      before: { status: 'open' },
      after: { status: 'completed', orderId: input.orderId },
    });
  }

  /**
   * D-817: inside the courier's booking transaction. The order's row in "Ready for label" gains
   * its consignment (or is made with it); nothing is printed (D-917). Its own rows only.
   */
  async parcelBooked(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly orderId: string;
      readonly consignmentNo: string;
      readonly at: Date;
    },
  ): Promise<void> {
    await labels.upsertLabelOrder(tx, input);
    await this.fillFromOrder(tx, input.orgId, input.orderId);
  }

  /**
   * D-914: inside the confirm's transaction. The order is ready for its label now, with its
   * consignment once a booking brings one (`parcelBooked`). Nothing is printed (D-917): it waits
   * in "Ready for label" until a person prints it. Its own row only.
   */
  async orderConfirmed(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly orderId: string;
      readonly orderNo: string;
      readonly locationId: string | null;
      readonly at: Date;
    },
  ): Promise<void> {
    await labels.upsertReadyOrder(tx, input);
  }

  /**
   * D-914: the booking failed for good, in that transaction: no consignment is coming, and the
   * order stays ready for its label without one. Nothing is printed (D-917).
   */
  async bookingFailed(
    tx: Tx,
    input: { readonly orgId: string; readonly orderId: string; readonly at: Date },
  ): Promise<void> {
    await labels.ensureLabelOrder(tx, input);
    await this.fillFromOrder(tx, input.orgId, input.orderId);
  }

  /**
   * The row's order number and location, read from the order (D-917: the automatic print used
   * to fill them in the worker). A row the booking made has neither, and its location decides
   * which hub's "Ready for label" lists it.
   */
  private async fillFromOrder(tx: Tx, orgId: string, orderId: string): Promise<void> {
    const order = await this.orders.summary(tx, orgId, orderId);
    if (order === undefined) return;
    await labels.fillLabelOrder(tx, {
      orgId,
      orderId,
      orderNo: order.orderNo,
      locationId: order.locationId,
    });
  }

  /**
   * M52 (D-941): a person is confirming the order, its row already locked, so only the lots' lock
   * is taken (W1's order). Under the brand's limit nobody is asked and it stays one lot; above it
   * the person says how many. An answer of one writes nothing, as no row is one lot.
   */
  async settleLots(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly orderId: string;
      readonly orderNo: string;
      readonly userId: string;
      readonly lots: number | undefined;
      readonly request: AuditableRequest;
    },
  ): Promise<void> {
    const [settings, [facts]] = await Promise.all([
      station.settingsOf(tx, input.orgId),
      this.orders.packingFacts(tx, input.orgId, [input.orderId]),
    ]);
    const pieces = (facts?.lines ?? []).reduce((sum, line) => sum + line.qty, 0);
    const verdict = judgeConfirmLots({
      pieces,
      askAbovePieces: settings?.lot_ask_above_pieces ?? null,
      lots: input.lots,
    });
    if (verdict === 'ask') {
      throw new PackingError(
        'ORDER_LOTS_REQUIRED',
        `Order ${input.orderNo} has ${String(pieces)} pieces: open it and say how many lots it goes in.`,
      );
    }
    if (verdict === 'out_of_range') {
      throw new PackingError(
        'LOT_COUNT_INVALID',
        `Order ${input.orderNo} has ${String(pieces)} ${pieces === 1 ? 'piece' : 'pieces'}: it goes in 1 to ${String(lotCountLimit(pieces))} lots.`,
      );
    }
    if (input.lots === undefined || input.lots === 1) return;
    await labels.lockOrderLots(tx, input.orgId, input.orderId);
    await labels.setLotCount(tx, {
      orgId: input.orgId,
      orderId: input.orderId,
      count: input.lots,
      by: input.userId,
    });
    await this.audit.record(tx, {
      orgId: input.orgId,
      actorUserId: input.userId,
      operation: 'update',
      action: 'packing.lot_count_set',
      entityType: 'order',
      entityId: input.orderId,
      before: { lotCount: 1 },
      after: { lotCount: input.lots, at: 'confirm' },
      request: input.request,
    });
  }

  /**
   * D-928: an order is packed only once every lot's label was printed with its consignment. Asked
   * by the orders module's Pack (the desk's and the station's Finish) with the order's row locked.
   */
  async assertPackable(
    tx: Tx,
    input: { readonly orgId: string; readonly orderId: string; readonly orderNo: string },
  ): Promise<void> {
    await assertLabelsPrinted(tx, input);
  }

  /**
   * D-808: a person's Ship of an order in several lots needs every lot scanned first. Asked by
   * the orders module with the order's row already locked, so only the lots' lock is taken.
   */
  async assertShippable(
    tx: Tx,
    input: { readonly orgId: string; readonly orderId: string; readonly orderNo: string },
  ): Promise<void> {
    await labels.lockOrderLots(tx, input.orgId, input.orderId);
    const lotCount = await labels.lotCountOf(tx, input.orgId, input.orderId);
    if (lotCount <= 1) return;
    const scanned = new Set(
      (await labels.handoverScansOf(tx, input.orgId, [input.orderId])).map((scan) => scan.lot_no),
    );
    const missing = handoverMissing({ lotCount, scanned });
    if (missing.length > 0) {
      throw new PackingError(
        'ORDER_LOTS_NOT_HANDED',
        `Order ${input.orderNo} goes in ${String(lotCount)} lots: scan ${lotWords(missing)} at the handover first.`,
      );
    }
  }

  // --- the lot count (D-805) ---------------------------------------------------------------

  /**
   * How many bags the order goes in: the label printer's or the packer's call, until it is packed
   * (D-944). A change sends it back to Ready for label (M52, D-942): the labels printed at the old
   * count stop counting, so it is listed first, marked, until every lot's new label is printed;
   * pages still queued for the old count are cancelled (D-945).
   */
  async setLotCount(
    context: ActiveContext,
    request: AuditableRequest,
    orderId: string,
    input: LotCountInput,
  ) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        if (!(await this.orders.orderVisibleTo(tx, context.orgId, orderId, request))) {
          throw new PackingError('NOT_FOUND', 'No such order.');
        }
        // The station's session first, as a scan takes it (session, then order, then lots), so
        // a scan is judged against the count it read and the two never deadlock (W1).
        const session = await station.sessionByOrder(tx, context.orgId, orderId);
        if (session !== undefined) {
          await station.sessionById(tx, context.orgId, session.id, { forUpdate: true });
        }
        await this.lockOrder(tx, context.orgId, orderId);
        const [facts] = await this.orders.packingFacts(tx, context.orgId, [orderId]);
        if (facts === undefined) throw new PackingError('NOT_FOUND', 'No such order.');
        const before = await labels.lotCountOf(tx, context.orgId, orderId);
        // The bags closed at the table and what is sealed in them: only the rest can fill more.
        const closures =
          session === undefined ? [] : await labels.closuresOf(tx, context.orgId, session.id);
        const inLots =
          session === undefined
            ? new Map<number, number>()
            : piecesByLot(
                (await station.scansOf(tx, context.orgId, session.id)).map((row) => ({
                  lot: row.lot_no,
                  outcome: row.outcome,
                })),
              );
        const closed = {
          lots: closures.length,
          pieces: closures.reduce((sum, row) => sum + (inLots.get(row.lot_no) ?? 0), 0),
        };
        const pieces = facts.lines.reduce((sum, line) => sum + line.qty, 0);
        const verdict = judgeLotCount({
          count: input.count,
          orderStatus: facts.status,
          closedLots: closed.lots,
          pieces,
          piecesInClosedLots: closed.pieces,
        });
        if (verdict === 'not_open') {
          throw new PackingError(
            'LOTS_LOCKED',
            `Order ${facts.orderNo} is ${facts.status}: its lots change only while it is confirmed, before it is packed.`,
          );
        }
        if (verdict === 'below_closed') {
          throw new PackingError(
            'LOTS_LOCKED',
            `${String(closed.lots)} lots of order ${facts.orderNo} are already closed at the packing station: keep at least one more open.`,
          );
        }
        if (verdict === 'out_of_range') {
          throw new PackingError('LOTS_LOCKED', 'An order goes in 1 to 20 lots.');
        }
        if (verdict === 'more_than_pieces') {
          throw new PackingError(
            'LOT_COUNT_INVALID',
            `Every lot holds at least one piece, and order ${facts.orderNo} has only enough for ${String(lotCountLimit(pieces, closed))} ${lotCountLimit(pieces, closed) === 1 ? 'lot' : 'lots'}.`,
          );
        }
        if (input.count !== before) {
          await labels.setLotCount(tx, {
            orgId: context.orgId,
            orderId,
            count: input.count,
            by: context.userId,
          });
          const cancelledPrints = await labels.cancelQueuedAtOtherCounts(tx, {
            orgId: context.orgId,
            orderId,
            count: input.count,
          });
          await this.audit.record(tx, {
            orgId: context.orgId,
            actorUserId: context.userId,
            operation: 'update',
            action: 'packing.lot_count_set',
            entityType: 'order',
            entityId: orderId,
            before: { lotCount: before },
            after: { lotCount: input.count, cancelledPrints },
            request,
          });
        }
        return {
          orderId,
          orderNo: facts.orderNo,
          lotCount: input.count,
          changed: input.count !== before,
        };
      }),
    );
  }

  // --- the handover (D-808) ----------------------------------------------------------------

  /**
   * One label scanned as the parcel goes to the courier: its order number or ten digits (an order
   * in one lot), its lot code (`…-L2` or twelve digits, D-912) or, for an order in one lot, its
   * consignment or tracking code. An order in several lots needs each lot's own code.
   */
  async scan(
    context: ActiveContext,
    request: AuditableRequest,
    input: HandoverScanInput,
    token: string | null,
  ) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const here = await this.terminals.resolve(tx, context, token, 'any');
        const code = normaliseScannedCode(input.code);
        // D-912: a lot's code in letters (`…-L2`) or twelve digits; the order's in either too.
        const found = await ordersForScannedCode(this.orders, tx, context.orgId, code);
        const orderId = await this.findOrder(tx, context.orgId, request, found.orderIds);
        await this.lockOrder(tx, context.orgId, orderId);
        const [facts] = await this.orders.packingFacts(tx, context.orgId, [orderId]);
        if (facts === undefined) throw new PackingError('NOT_FOUND', 'No such order.');
        if (HANDED_STATUSES.includes(facts.status)) {
          throw new PackingError(
            'ORDER_ALREADY_HANDED',
            `Order ${facts.orderNo} is already with the courier.`,
          );
        }
        if (facts.status !== 'packed') {
          throw new PackingError(
            'PACKING_NOT_PACKABLE',
            `Order ${facts.orderNo} is not packed yet: pack every lot first.`,
          );
        }
        const lotCount = await labels.lotCountOf(tx, context.orgId, orderId);
        let lot: number;
        if (found.lot !== null) {
          lot = found.lot;
        } else if (lotCount === 1) {
          lot = 1;
        } else {
          throw new PackingError(
            'ORDER_LOTS_NOT_HANDED',
            `Order ${facts.orderNo} goes in ${String(lotCount)} lots: scan each lot's own label.`,
          );
        }
        const scans = await labels.handoverScansOf(tx, context.orgId, [orderId]);
        const scanned = new Set(scans.map((scan) => scan.lot_no));
        const outcome = judgeHandoverScan({ lotCount, scanned, lot });
        if (outcome === 'no_such_lot') {
          throw new PackingError(
            'ORDER_LOTS_NOT_HANDED',
            `Order ${facts.orderNo} goes in ${String(lotCount)} ${lotCount === 1 ? 'lot' : 'lots'}: there is no lot ${String(lot)}. Print its labels again.`,
          );
        }
        if (outcome === 'accepted') {
          await labels.insertHandoverScan(tx, {
            orgId: context.orgId,
            orderId,
            lotNo: lot,
            code,
            by: context.userId,
            terminalId: here?.terminal.id ?? null,
          });
          scanned.add(lot);
          await this.audit.record(tx, {
            orgId: context.orgId,
            actorUserId: context.userId,
            operation: 'create',
            action: 'packing.handover_scanned',
            entityType: 'order',
            entityId: orderId,
            after: { lot, lotCount, terminalId: here?.terminal.id ?? null },
            request,
          });
        }
        return {
          outcome,
          order: {
            ...this.progress(orderId, facts.orderNo, lotCount, scanned),
            // The courier portal counts each courier's parcels as they go (D-904): the booked
            // parcel's courier, else the order's own.
            courier: facts.parcel?.courierName ?? facts.courierName,
          },
        };
      }),
    );
  }

  /** The handover's list: packed orders scanned in the last day, with what is still missing. */
  async pending(context: ActiveContext, request: object) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const recent = await labels.recentHandoverOrders(tx, context.orgId);
      const visible = await this.orders.visibleOrderIds(tx, context.orgId, recent, request);
      const ids = recent.filter((id) => visible.has(id));
      const [facts, lots, scans] = await Promise.all([
        this.orders.packingFacts(tx, context.orgId, ids),
        labels.lotCounts(tx, context.orgId, ids),
        labels.handoverScansOf(tx, context.orgId, ids),
      ]);
      return {
        items: facts
          .filter((fact) => fact.status === 'packed')
          .map((fact) => ({
            ...this.progress(
              fact.id,
              fact.orderNo,
              lots.get(fact.id) ?? 1,
              new Set(scans.filter((scan) => scan.order_id === fact.id).map((scan) => scan.lot_no)),
            ),
            customer: fact.recipient.name,
            courier: fact.parcel?.courierName ?? null,
            lastScanAt: iso(
              scans.filter((scan) => scan.order_id === fact.id).at(-1)?.scanned_at ?? null,
            ),
          })),
      };
    });
  }

  /**
   * Hand these orders to the courier: each one whose every lot was scanned moves to `shipped`
   * through the state machine (§9's handover journal and all), each in its own transaction; the
   * rest are refused, each with what is missing.
   */
  async ship(context: ActiveContext, request: AuditableRequest, input: HandoverShipInput) {
    const results: {
      id: string;
      orderNo: string | null;
      ok: boolean;
      code?: string;
      message?: string;
    }[] = [];
    for (const orderId of [...new Set(input.orderIds)]) {
      try {
        const orderNo = await mapPackingErrors(() =>
          withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
            if (!(await this.orders.orderVisibleTo(tx, context.orgId, orderId, request))) {
              throw new PackingError('NOT_FOUND', 'No such order.');
            }
            await this.lockOrder(tx, context.orgId, orderId);
            const [facts] = await this.orders.packingFacts(tx, context.orgId, [orderId]);
            if (facts === undefined) throw new PackingError('NOT_FOUND', 'No such order.');
            // Shipped meanwhile (the courier's pickup, another desk): with the courier, not refused.
            if (HANDED_STATUSES.includes(facts.status)) {
              throw new PackingError(
                'ORDER_ALREADY_HANDED',
                `Order ${facts.orderNo} is already with the courier.`,
              );
            }
            const lotCount = await labels.lotCountOf(tx, context.orgId, orderId);
            const scanned = new Set(
              (await labels.handoverScansOf(tx, context.orgId, [orderId])).map(
                (scan) => scan.lot_no,
              ),
            );
            if (!handoverComplete({ lotCount, scanned })) {
              const missing = handoverMissing({ lotCount, scanned });
              throw new PackingError(
                'ORDER_LOTS_NOT_HANDED',
                lotCount === 1
                  ? `Scan order ${facts.orderNo}'s label as it goes to the courier.`
                  : `Order ${facts.orderNo} goes in ${String(lotCount)} lots: scan ${lotWords(missing)} first.`,
              );
            }
            const moved = await this.orders.transition(
              tx,
              { orgId: context.orgId, userId: context.userId },
              orderId,
              'ship',
            );
            await this.audit.record(tx, {
              orgId: context.orgId,
              actorUserId: context.userId,
              operation: 'update',
              action: 'packing.handed_over',
              entityType: 'order',
              entityId: orderId,
              before: { status: moved.from },
              after: { status: moved.to, lots: lotCount },
              request,
            });
            return facts.orderNo;
          }),
        );
        results.push({ id: orderId, orderNo, ok: true });
      } catch (error) {
        const body = (error as { getResponse?: () => unknown }).getResponse?.() as
          { code?: string; message?: string } | undefined;
        if (body?.code === undefined) throw error;
        results.push({
          id: orderId,
          orderNo: null,
          ok: false,
          code: body.code,
          message: body.message ?? '',
        });
      }
    }
    return { moved: results.filter((result) => result.ok).length, results };
  }

  private progress(
    orderId: string,
    orderNo: string,
    lotCount: number,
    scanned: ReadonlySet<number>,
  ) {
    return {
      orderId,
      orderNo,
      lotCount,
      scanned: [...scanned].sort((a, b) => a - b),
      missing: handoverMissing({ lotCount, scanned }),
      complete: handoverComplete({ lotCount, scanned }),
    };
  }

  /** The first of a code's orders inside the caller's scope; one answer for none and hidden. */
  private async findOrder(
    tx: Tx,
    orgId: string,
    request: object,
    candidates: readonly string[],
  ): Promise<string> {
    for (const id of candidates) {
      if (await this.orders.orderVisibleTo(tx, orgId, id, request)) return id;
    }
    // Nothing, or nothing the caller may see: the scope has nothing left to narrow.
    scopeWhere(request, { createdBy: sql`null`, assignedTo: sql`null`, branchId: sql`null` });
    throw new PackingError(
      'SHIPMENT_NOT_FOUND',
      'No packed order you can hand over has this code.',
    );
  }
}
