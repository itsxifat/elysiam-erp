import { Inject, Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import { businessDate, transitionFor } from '@elysium/domain';
import { statusDedupeKey } from '@elysium/domain/courier';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { assertInScope } from '../../platform/auth/scope.js';
import { CourierError } from './courier.errors.js';
import * as repo from './courier.repository.js';
import { ORDERS_PORT, type OrdersPort } from './ports/orders.port.js';
import type { ReceiveReturnInput } from './courier.schemas.js';

/**
 * Receiving a returned parcel, with the inspection (M12's returns bullet; §7, §8, §9).
 *
 * ## What this module does and does not do
 *
 * It records **the inspection**: which SKUs came back, how many are sellable, how many are
 * damaged, which locations they went to, who received them and why. That is a courier-side
 * fact and nothing else owns it.
 *
 * It does **not** move stock and does **not** post the journal. §9's transition
 * `return_in_transit → returned` (and `partially_delivered → returned`) carries the effects
 * `receive_return_stock` and `post_return`, performed by the orders module inside
 * `applyTrigger` — movements through `INVENTORY_API.receiveCustomerReturn`, and §7's
 * `Dr Inventory / Cr Goods in transit` at the **dispatch** value. Doing either here would
 * mean two modules creating movements for one physical event, with different dedupe keys,
 * and the units would go back on the shelf twice.
 *
 * The inspection split is the reason the port carries it. §7: "Damaged units go to the
 * `damaged` location; writing them off is a separate step that needs approval." So the
 * quantities and both locations travel through `applyTrigger`, and the orders module makes
 * two sets of movements from them — one per location, at the same dispatch cost.
 *
 * ## Why the courier's "returned to merchant" does not trigger this
 *
 * `orderTriggerFor` returns null for `returned_to_merchant`, so a webhook cannot perform a
 * return. A courier saying a parcel reached *its own* warehouse is not our warehouse
 * receiving it, and letting the webhook do it would put stock back on a shelf nobody has
 * looked in and post a journal for units that may be missing. A person opens the box.
 */
@Injectable()
export class ReturnsService {
  constructor(
    @Inject(ORDERS_PORT) private readonly orders: OrdersPort,
    private readonly audit: AuditService,
  ) {}

  /** What can still come back off a parcel, for the receiving screen. */
  async inspectable(context: ActiveContext, request: object, consignmentId: string) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const consignment = await repo.consignmentById(tx, context.orgId, consignmentId);
      if (consignment === undefined) {
        throw new CourierError('CONSIGNMENT_NOT_FOUND', 'No such consignment.');
      }
      assertInScope(request, { branchId: consignment.branch_id });

      const lines = await this.orders.returnableLines(tx, context.orgId, consignment.order_id);
      const already = await repo.returnReceiptFor(tx, context.orgId, consignmentId);

      return {
        consignmentId,
        orderId: consignment.order_id,
        orderNo: consignment.reference,
        status: consignment.status,
        alreadyReceivedId: already?.id ?? null,
        // No cost field. The value a returned unit re-enters stock at is
        // `sales.order_lines.dispatch_unit_cost_poisha`, which the orders module holds and
        // which `applyTrigger` uses — it never travels to a screen (invariant 5).
        lines: lines.map((line) => ({
          skuId: line.skuId,
          skuCode: line.skuCode,
          outstandingQty: line.outstandingQty,
        })),
      };
    });
  }

  /**
   * Receive and inspect a returned parcel.
   *
   * One transaction: the receipt, its lines, the courier event, the order's transition and
   * everything that transition does. A partial failure anywhere rolls the lot back, which is
   * the only version of this that cannot leave stock on a shelf with no journal behind it.
   */
  async receive(
    context: ActiveContext,
    request: AuditableRequest,
    consignmentId: string,
    input: ReceiveReturnInput,
  ) {
    const at = input.occurredAt === undefined ? new Date() : new Date(input.occurredAt);

    const damagedTotal = input.lines.reduce((total, line) => total + line.damagedQty, 0);
    if (damagedTotal > 0 && input.damagedLocationId === undefined) {
      // §7 sends damaged units to the `damaged` location, and migration 0050 refuses a
      // receipt that records damage without naming one. Saying so here gives the warehouse a
      // sentence instead of a constraint name.
      throw new CourierError(
        'RETURN_RECEIPT_INVALID',
        'Some units are damaged, so the damaged location has to be named (§7).',
      );
    }
    if (damagedTotal === 0 && input.damagedLocationId !== undefined) {
      throw new CourierError(
        'RETURN_RECEIPT_INVALID',
        'Nothing was damaged, so no damaged location is needed.',
      );
    }

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const consignment = await repo.consignmentForUpdate(tx, context.orgId, consignmentId);
      if (consignment === undefined) {
        throw new CourierError('CONSIGNMENT_NOT_FOUND', 'No such consignment.');
      }
      assertInScope(request, { branchId: consignment.branch_id });

      // One receipt per parcel. The unique index says the same; this says it in words, and
      // returns the existing id so a double-submitted form is not a mystery.
      const already = await repo.returnReceiptFor(tx, context.orgId, consignmentId);
      if (already !== undefined) {
        throw new CourierError(
          'RETURN_RECEIPT_INVALID',
          'This parcel has already been received and inspected.',
        );
      }

      const order = await this.orders.statusOf(tx, context.orgId, consignment.order_id);
      if (order === null) {
        throw new CourierError('ORDER_NOT_FOUND', 'That consignment’s order is gone.');
      }

      const returnable = await this.orders.returnableLines(tx, context.orgId, consignment.order_id);
      const outstanding = new Map(returnable.map((line) => [line.skuId, line.outstandingQty]));
      for (const line of input.lines) {
        const limit = outstanding.get(line.skuId);
        if (limit === undefined) {
          throw new CourierError(
            'RETURN_RECEIPT_INVALID',
            'One of those SKUs is not on this order.',
          );
        }
        if (line.sellableQty + line.damagedQty > limit) {
          /*
           * More back than went out.
           *
           * Refused rather than clamped: a box with one extra kurti in it is either a
           * picking error on the way out or another order's unit in the wrong parcel, and
           * both need a person. Clamping would create stock out of nothing and make the
           * inventory reconciliation report the symptom weeks later.
           */
          throw new CourierError(
            'RETURN_RECEIPT_INVALID',
            `More units came back for one SKU than went out (${String(limit)} outstanding).`,
          );
        }
      }

      const locationId = input.locationId ?? order.locationId;
      if (locationId === null || locationId === undefined) {
        throw new CourierError(
          'RETURN_RECEIPT_INVALID',
          'Name the location the sellable units go back to.',
        );
      }

      const receiptId = await repo.insertReturnReceipt(tx, {
        orgId: context.orgId,
        consignmentId,
        orderId: consignment.order_id,
        branchId: consignment.branch_id,
        locationId,
        damagedLocationId: input.damagedLocationId ?? null,
        receivedAt: at,
        businessDate: businessDate(at),
        receivedBy: context.userId,
        reason: input.reason,
        inspectionNote: input.inspectionNote ?? null,
      });
      await repo.insertReturnReceiptLines(tx, context.orgId, receiptId, input.lines);

      /*
       * The courier event, so the timeline says the parcel came home.
       *
       * `returned_to_merchant` with source `manual`: the courier may or may not have told us,
       * and this is the moment *we* know. Deduped on the same key as a webhook's would be, so
       * a courier webhook arriving afterwards about the same second records nothing — which is
       * the behaviour acceptance check 3 asks for across both paths.
       */
      await repo.insertConsignmentEvent(tx, {
        orgId: context.orgId,
        consignmentId,
        source: 'manual',
        status: 'returned_to_merchant',
        rawStatus: 'received_and_inspected',
        occurredAt: at,
        businessDate: businessDate(at),
        dedupeKey: statusDedupeKey({
          consignmentId,
          status: 'returned_to_merchant',
          occurredAt: at,
        }),
        payload: {
          receiptId,
          sellable: input.lines.reduce((t, l) => t + l.sellableQty, 0),
          damaged: damagedTotal,
        },
        webhookDeliveryId: null,
        appliedTrigger: 'receive_return',
        orderFromStatus: order.status,
        // Written now, not updated after: the table is append-only (0049, 0050), and §9's
        // table already determines where `receive_return` from this status lands.
        orderToStatus: transitionFor(order.status, 'receive_return')?.to ?? null,
      });

      await repo.applyConsignmentStatus(tx, {
        orgId: context.orgId,
        consignmentId,
        status: 'returned_to_merchant',
        rawStatus: 'received_and_inspected',
        occurredAt: at,
      });

      /*
       * §9's `receive_return`, with its effects: stock back through
       * `INVENTORY_API.receiveCustomerReturn` at the dispatch cost, and §7's
       * `Dr Inventory / Cr Goods in transit`. Both happen in the orders module, in this
       * transaction. Nothing here touches `inventory.*` or `ledger.*`.
       */
      const applied = await this.orders.applyTrigger(tx, context, request, {
        orderId: consignment.order_id,
        trigger: 'receive_return',
        occurredAt: at,
        reason: input.reason,
        returnReceipt: {
          locationId,
          damagedLocationId: input.damagedLocationId ?? null,
          lines: input.lines,
        },
      });

      if (applied !== null) {
        // `returned_at` only once the transition ran, for the same reason the sync path holds
        // its money columns back: a date on a consignment whose order never moved is a fact
        // with no journal behind it, and the settlement matcher reads those columns.
        await repo.recordConsignmentOutcome(tx, {
          orgId: context.orgId,
          consignmentId,
          occurredAt: at,
          collectedPoisha: null,
          delivered: false,
          returned: true,
        });
        await repo.setReturnReceiptJournal(tx, context.orgId, receiptId, applied.journalId);
      }

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'courier.return.received',
        entityType: 'Order',
        entityId: consignment.order_id,
        before: { status: order.status },
        after: {
          receiptId,
          locationId,
          damagedLocationId: input.damagedLocationId ?? null,
          sellableQty: input.lines.reduce((total, line) => total + line.sellableQty, 0),
          damagedQty: damagedTotal,
          reason: input.reason,
          orderTo: applied?.to ?? order.status,
          journalId: applied?.journalId ?? null,
        },
        requestId: context.requestId,
        request,
      });

      return {
        receiptId,
        consignmentId,
        orderStatus: applied?.to ?? order.status,
        journalId: applied?.journalId ?? null,
      };
    });
  }
}
