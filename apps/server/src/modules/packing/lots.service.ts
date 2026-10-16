import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { HandoverScanInput, HandoverShipInput, LotCountInput } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import { normaliseScannedCode } from '@elysium/domain/barcode';
import { sql } from 'drizzle-orm';
import {
  handoverComplete,
  handoverMissing,
  judgeHandoverScan,
  judgeLotCount,
  parseLotCode,
} from '@elysium/domain/packing';

import { AuditService } from '../../platform/audit/audit.service.js';
import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { HandoverGuardRegistry, type HandoverGuard } from '../orders/ports/handover-guard.port.js';
import {
  ParcelObserverRegistry,
  type ParcelObserver,
} from '../orders/ports/parcel-observer.port.js';
import * as labels from './labels.repository.js';
import { PACKING_QUEUES, type AutoPrintPayload } from './packing.queues.js';
import { mapPackingErrors, PackingError } from './station.errors.js';
import * as station from './station.repository.js';
import { TerminalsService } from './terminals.service.js';

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

/** "lots 2 and 3", "lot 3". */
function lotWords(lots: readonly number[]): string {
  if (lots.length === 1) return `lot ${String(lots[0])}`;
  return `lots ${lots.slice(0, -1).join(', ')} and ${String(lots[lots.length - 1])}`;
}

/**
 * Lots and the handover (M46, D-805 to D-808), and the two hooks the orders module calls:
 *
 * - **the parcel observer**: in the courier's booking transaction, the order is kept as ready
 *   for its label and `labels.auto_print` is enqueued (D-817);
 * - **the handover guard**: a person's Ship of an order in several lots is refused until every
 *   lot's label was scanned at the handover (D-808).
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

  // --- the orders module's hooks -----------------------------------------------------------

  /** D-817: inside the courier's booking transaction. Writes its own row and enqueues; no call. */
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
    const payload: AutoPrintPayload = {
      orderId: input.orderId,
      consignmentNo: input.consignmentNo,
    };
    await enqueue(tx, PACKING_QUEUES.autoPrint.name, payload, {
      orgId: input.orgId,
      ref: input.orderId,
    });
  }

  /** D-808: a person's Ship of an order in several lots needs every lot scanned first. */
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

  /** How many bags the order goes in: the label printer's or the packer's call, until handover. */
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
        await labels.lockOrderLots(tx, context.orgId, orderId);
        // The station's session waits, so a scan is judged against the count it read.
        const session = await station.sessionByOrder(tx, context.orgId, orderId);
        if (session !== undefined) {
          await station.sessionById(tx, context.orgId, session.id, { forUpdate: true });
        }
        const [facts] = await this.orders.packingFacts(tx, context.orgId, [orderId]);
        if (facts === undefined) throw new PackingError('NOT_FOUND', 'No such order.');
        const before = await labels.lotCountOf(tx, context.orgId, orderId);
        const closedLots =
          session?.status !== 'open'
            ? 0
            : (await labels.closuresOf(tx, context.orgId, session.id)).length;
        const handedLots = (await labels.handoverScansOf(tx, context.orgId, [orderId])).length;
        const verdict = judgeLotCount({
          count: input.count,
          orderStatus: facts.status,
          closedLots,
          handedLots,
        });
        if (verdict === 'not_open') {
          throw new PackingError(
            'LOTS_LOCKED',
            `Order ${facts.orderNo} has left the hub: its lots are fixed.`,
          );
        }
        if (verdict === 'handover_started') {
          throw new PackingError(
            'LOTS_LOCKED',
            `Order ${facts.orderNo}'s lots are being handed to the courier: the count is fixed.`,
          );
        }
        if (verdict === 'below_closed') {
          throw new PackingError(
            'LOTS_LOCKED',
            `${String(closedLots)} lots of order ${facts.orderNo} are already closed at the packing station.`,
          );
        }
        if (verdict === 'out_of_range') {
          throw new PackingError('LOTS_LOCKED', 'An order goes in 1 to 20 lots.');
        }
        if (input.count !== before) {
          await labels.setLotCount(tx, {
            orgId: context.orgId,
            orderId,
            count: input.count,
            by: context.userId,
          });
          await this.audit.record(tx, {
            orgId: context.orgId,
            actorUserId: context.userId,
            operation: 'update',
            action: 'packing.lot_count_set',
            entityType: 'order',
            entityId: orderId,
            before: { lotCount: before },
            after: { lotCount: input.count },
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
   * One label scanned as the parcel goes to the courier: its order number (an order in one lot),
   * its lot code (`…-L2`) or, for an order in one lot, its consignment or tracking code. An order
   * in several lots needs each lot's own code.
   */
  async scan(
    context: ActiveContext,
    request: AuditableRequest,
    input: HandoverScanInput,
    token: string | null,
  ) {
    return mapPackingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const here = await this.terminals.resolve(tx, context, token, 'packing');
        const code = normaliseScannedCode(input.code);
        const lotted = parseLotCode(code);
        const orderId = await this.findOrder(tx, context.orgId, request, lotted?.orderCode ?? code);
        await labels.lockOrderLots(tx, context.orgId, orderId);
        const [facts] = await this.orders.packingFacts(tx, context.orgId, [orderId]);
        if (facts === undefined) throw new PackingError('NOT_FOUND', 'No such order.');
        if (facts.status !== 'packed') {
          throw new PackingError(
            'PACKING_NOT_PACKABLE',
            facts.status === 'shipped'
              ? `Order ${facts.orderNo} is already with the courier.`
              : `Order ${facts.orderNo} is not packed yet: pack every lot first.`,
          );
        }
        const lotCount = await labels.lotCountOf(tx, context.orgId, orderId);
        let lot: number;
        if (lotted !== null) {
          lot = lotted.lot;
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
          order: this.progress(orderId, facts.orderNo, lotCount, scanned),
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
            await labels.lockOrderLots(tx, context.orgId, orderId);
            const [facts] = await this.orders.packingFacts(tx, context.orgId, [orderId]);
            if (facts === undefined) throw new PackingError('NOT_FOUND', 'No such order.');
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

  /** The order a code names, inside the caller's scope; one answer for none and hidden. */
  private async findOrder(tx: Tx, orgId: string, request: object, code: string): Promise<string> {
    const candidates = await this.orders.orderIdsForShipmentCode(tx, orgId, code);
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
