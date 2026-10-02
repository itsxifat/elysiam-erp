import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';
import {
  applicableAdvance,
  computePartialDelivery,
  dispatchValue,
  orderDeliveredDraft,
  orderReturnDraft,
  poisha,
  transition,
  type AccountSubtype,
  type OrderEffect,
  type OrderStatus,
  type OrderTrigger,
  type Poisha,
  type PostingAccount,
  type TransitionResult,
} from '@elysium/domain';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { emit } from '../../platform/events/outbox.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import { CustomersService } from './customers.service.js';
import * as repo from './orders.repository.js';
import { OrdersError } from './orders.errors.js';
import { AdvancesService } from './advances.service.js';
import * as advancesRepo from './advances.repository.js';
import { CourierBookingRegistry } from './ports/courier-booking.port.js';
import { DeliveryObserverRegistry } from './ports/delivery-observer.port.js';
import { deliveredNetItems, orderLevelDiscount } from './revenue.js';
import { PROMO_PORT, type PromoPort } from './ports/promo.port.js';

/**
 * Performing a transition (architecture §9, invariant 7).
 *
 * The domain decides; this performs. `transition()` in `@elysium/domain` returns the new
 * status and an ordered list of effects, and every one of them happens here, in the
 * caller's transaction, before the status column moves. The order of the last two steps
 * is deliberate: effects first, then the conditional `setStatus`. If an effect throws —
 * no stock, a closed period, an idempotency conflict — the whole transaction rolls back
 * and the order is still in the status it was, which is the only version of this that
 * cannot leave an order confirmed with nothing reserved.
 *
 * ## Why every transition takes a row lock first
 *
 * `orderForUpdate` locks the order for the transaction. Without it, two agents pressing
 * "confirm" and "cancel" both read `pending`, both pass the domain's check, and both
 * perform their effects — a reservation and a release — before one of their UPDATEs
 * loses. The conditional `setStatus` would catch the second *write*, but by then the
 * first one's stock has already moved. The lock makes read-decide-write one unit, and
 * the conditional UPDATE stays as the second lock (it catches a caller that bypassed
 * this method, and migration 0041's trigger catches one that bypassed the service).
 *
 * ## The cost that everything downstream depends on
 *
 * `ship` is where `dispatch_unit_cost_poisha` is written on each line, and §7 requires it
 * to be exactly what the dispatch movement recorded — delivery and return both credit
 * goods in transit with it, and if the two figures differ the account never returns to
 * zero. Inventory's API returns the *total* value it posted, not the per-line cost, so
 * this reads the weighted average first, computes what the total should be, and refuses
 * with `ORDER_COST_MOVED` if the total that came back disagrees. A disagreement means a
 * receipt committed in between and moved the average; the retry reads the new one. The
 * alternative — storing the average we read and hoping — is how goods in transit acquires
 * a residue that nothing reports.
 */

/** The §7 accounts an order's journals name, resolved once per posting. */
export type Accounts = ReadonlyMap<AccountSubtype, PostingAccount>;

/**
 * One account out of the resolved set.
 *
 * A function rather than `accounts.cogs!`: a non-null assertion here would be a promise
 * that `accounts()` was called with the right subtypes, and the cost of breaking that
 * promise is a journal posted with `undefined` as an account id — refused by the database
 * with a message about a uuid, three layers from the mistake.
 */
function pick(accounts: Accounts, subtype: AccountSubtype): PostingAccount {
  const account = accounts.get(subtype);
  if (account === undefined) {
    throw new OrdersError(
      'LEDGER_ACCOUNT_NOT_FOUND',
      `This posting needs the ${subtype} account, which was not resolved.`,
    );
  }
  return account;
}

/**
 * What the effects of one transition hand each other.
 *
 * `journalId` goes back out to the courier module, which writes it on the return receipt.
 * `advanceAppliedPoisha` is what the delivery journal relieved Customer advance by, which
 * `apply_advances` then spreads over the order's advances (D-233).
 */
interface Posted {
  journalId: string | null;
  advanceAppliedPoisha: bigint;
}

export interface DeliverOptions {
  readonly collectedPoisha?: string | undefined;
  readonly differenceReason?: string | undefined;
  /** Set for a partial delivery: what actually arrived, per SKU. */
  readonly lines?: readonly { readonly skuId: string; readonly deliveredQty: number }[] | undefined;
  readonly occurredAt?: Date | undefined;
}

export interface ReturnOptions {
  readonly reason: string;
  readonly locationId?: string | undefined;
  /**
   * The whole parcel is damaged, for the desk's own receive-return route.
   *
   * Kept for the caller that has no inspection to report — a box that came back soaked.
   * It cannot express the ordinary case, which is why `receipt` exists.
   */
  readonly damaged?: boolean | undefined;
  /**
   * The warehouse's line-by-line inspection (§7, §8).
   *
   * §7 sends sellable and damaged units to *different* locations, so a single `damaged`
   * flag cannot describe a box with one torn kurti in it: the whole parcel would go on the
   * damaged shelf and three sellable kurtis would need a manual transfer, or the torn one
   * would go back on the sellable shelf and be sold. With this, the return makes two sets
   * of movements at one cost and posts one journal for the combined value.
   */
  readonly receipt?:
    | {
        readonly locationId: string;
        readonly damagedLocationId: string | null;
        readonly lines: readonly {
          readonly skuId: string;
          readonly sellableQty: number;
          readonly damagedQty: number;
        }[];
      }
    | undefined;
  readonly occurredAt?: Date | undefined;
}

export interface MoveOptions {
  readonly reason?: string | null;
  /** Why the goods came back, from the fixed list: required on a return or an exchange (D-234). */
  readonly returnReason?: string | null | undefined;
  readonly occurredAt?: Date;
  readonly courierId?: string | null;
  readonly deliver?: DeliverOptions;
  readonly ret?: ReturnOptions;
  /** True when the caller performs `create_exchange_order` itself (see OrdersService). */
  readonly callerHandlesExchange?: boolean;
}

@Injectable()
export class TransitionsService {
  constructor(
    @Inject(INVENTORY_API) private readonly inventory: InventoryApi,
    @Inject(LEDGER_API) private readonly ledger: LedgerApi,
    @Inject(PROMO_PORT) private readonly promo: PromoPort,
    private readonly customers: CustomersService,
    private readonly audit: AuditService,
    private readonly courier: CourierBookingRegistry,
    private readonly deliveries: DeliveryObserverRegistry,
    private readonly advances: AdvancesService,
  ) {}

  /**
   * Move one order through `trigger`, performing §9's effects.
   *
   * Public because two callers need it: the controller's transition routes, and
   * `OrdersService.exchange`, which has to create the replacement order itself and then
   * move the original. Keeping `create_exchange_order` with the caller rather than here
   * avoids a circular dependency between the two services, and the effect list is
   * returned so the caller can assert it was asked to do that work rather than assume.
   */
  async move(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    order: repo.OrderRow,
    trigger: OrderTrigger,
    options: MoveOptions = {},
  ): Promise<{ result: TransitionResult; order: repo.OrderRow; journalId: string | null }> {
    const at = options.occurredAt ?? new Date();
    const result = transition({
      from: order.status as OrderStatus,
      trigger,
      at,
      reason: options.reason ?? null,
      /*
       * §9's booking trigger, per org, read from `org.settings`.
       *
       * Read here rather than passed in by the caller, because the policy belongs to the
       * *org* and not to the request: a confirm from the desk, from the portal and from a
       * job all have to make the same parcel. An unset or unrecognised value is `manual`,
       * which enqueues nothing — the only default that cannot book a parcel a brand did not
       * ask for, and the only safe one while a courier account is still being set up.
       */
      bookingPolicy: await this.bookingPolicy(tx, context.orgId),
      /*
       * Asked only on a cancel, because that is the only transition the domain filters on
       * it: enqueueing a cancellation for a parcel that was never booked would hand a
       * courier a consignment number that does not exist. Every other trigger would pay for
       * a query whose answer it cannot use.
       */
      parcelBooked: trigger === 'cancel' && (await this.parcelBooked(tx, context.orgId, order.id)),
      returnReason: options.returnReason ?? null,
    });

    /*
     * The journal an effect posted, carried back out of here.
     *
     * `applyTrigger` hands it to the courier module, which writes it onto the return
     * receipt so the warehouse's receipt and §7's journal can be read off each other. A
     * mutable holder rather than a return value from `perform`, because the effect list is
     * a loop and only two of its effects post anything.
     */
    const posted: Posted = { journalId: null, advanceAppliedPoisha: 0n };

    for (const effect of result.effects) {
      await this.perform(tx, context, order, effect, result, options, posted);
    }

    const moved = await repo.setStatus(tx, {
      orgId: context.orgId,
      orderId: order.id,
      expected: order.status,
      next: result.to,
      actorUserId: context.userId,
      reason: result.reason,
      at,
    });
    if (!moved) {
      // The row moved between the lock and here, which the lock should have made
      // impossible — so this is the backstop for a caller that reached `move` with a row
      // it read without locking. Same code the domain and the trigger raise.
      throw new OrdersError(
        'ORDER_TRANSITION_INVALID',
        'This order changed while the request was in flight; reload and try again.',
      );
    }

    await repo.insertOrderEvent(tx, {
      orgId: context.orgId,
      orderId: order.id,
      fromStatus: order.status,
      toStatus: result.to,
      trigger,
      reason: result.reason,
      actorUserId: context.userId,
      businessDate: result.businessDate,
      occurredAt: at,
    });

    await emit(
      tx,
      'order.status_changed',
      {
        id: order.id,
        orderNo: order.order_no,
        from: order.status,
        to: result.to,
        at: at.toISOString(),
        resellerId: order.reseller_id,
        branchId: order.branch_id,
      },
      { orgId: context.orgId },
    );

    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'update',
      action: `order.${trigger}`,
      entityType: 'order',
      entityId: order.id,
      before: { status: order.status },
      after: { status: result.to, reason: result.reason },
      request,
    });

    /*
     * M18: whoever registered for deliveries hears about this one in the same transaction
     * (the marketing module enqueues its Conversions API event), so the event commits or
     * rolls back with the delivery itself. Nothing registered is nothing to do (D-262).
     */
    if (result.to === 'delivered' || result.to === 'partially_delivered') {
      await this.deliveries.notify(tx, {
        orgId: context.orgId,
        orderId: order.id,
        status: result.to,
        at,
      });
    }

    const after = await repo.orderById(tx, context.orgId, order.id);
    return { result, order: after ?? order, journalId: posted.journalId };
  }

  /** §9's booking trigger for this org, defaulting to `manual`. */
  private async bookingPolicy(tx: Tx, orgId: string): Promise<'on_confirm' | 'on_pack' | 'manual'> {
    const value = await repo.courierBookingSetting(tx, orgId);
    return value === 'on_confirm' || value === 'on_pack' ? value : 'manual';
  }

  /** Whether a parcel is live with a courier, asked of the module that owns the row. */
  private async parcelBooked(tx: Tx, orgId: string, orderId: string): Promise<boolean> {
    const courier = this.courier.current();
    if (courier === undefined) return false;
    return courier.hasLiveParcel(tx, orgId, orderId);
  }

  private async perform(
    tx: Tx,
    context: ActiveContext,
    order: repo.OrderRow,
    effect: OrderEffect,
    result: TransitionResult,
    options: MoveOptions,
    posted: Posted,
  ): Promise<void> {
    const actor = { orgId: context.orgId, userId: context.userId };

    switch (effect) {
      case 'reserve_stock': {
        const locationId = await this.locationFor(tx, context, order);
        const lines = await repo.orderLines(tx, context.orgId, order.id);
        // All or nothing across the lines: inventory throws `STOCK_INSUFFICIENT` naming
        // the line that ran out, and the throw rolls back this transaction — which is
        // what releases the lines already held. Acceptance check 2 (concurrent confirms
        // never oversell) rests on inventory's conditional UPDATE, not on anything here.
        await this.inventory.reserve(tx, actor, {
          refType: 'order',
          refId: order.id,
          lines: lines.map((line) => ({ skuId: line.sku_id, locationId, qty: line.qty })),
        });
        return;
      }

      case 'release_reservation': {
        await this.inventory.release(tx, actor, { refType: 'order', refId: order.id });
        return;
      }

      case 'consume_reservation':
        // Consumed by `inventory.dispatch` in the same call that creates the movements —
        // the two cannot be separated without leaving units reserved for an order that
        // has already gone out. Handled under `create_dispatch_movement`.
        return;

      case 'create_dispatch_movement':
      case 'post_handover':
        // Both are `inventory.dispatch`: the movements, the reservation settlement and
        // §7's handover journal are one call because they have to be one transaction, and
        // the average recorded on the movement is the value the journal posts. Performed
        // once, on the first of the two effects.
        if (effect === 'create_dispatch_movement') await this.dispatch(tx, context, order, options);
        return;

      case 'post_revenue':
      case 'post_partial_revenue':
        await this.postDelivery(
          tx,
          context,
          order,
          effect === 'post_partial_revenue',
          options,
          posted,
        );
        return;

      case 'receive_return_stock':
      case 'post_return':
        if (effect === 'receive_return_stock')
          await this.receiveReturn(tx, context, order, options, posted);
        return;

      case 'update_customer_stats':
        await this.updateStats(tx, context, order, result);
        return;

      case 'apply_advances':
        // After the delivery journal, which computed what it applied (D-233).
        await this.advances.applyOnDelivery(tx, context.orgId, order, posted.advanceAppliedPoisha);
        return;

      case 'settle_advances':
        // A cancel and a received return are the two endings (D-232).
        await this.advances.settleOnEnding(
          tx,
          context,
          order,
          result.to === 'cancelled' ? 'cancel' : 'return',
          options.occurredAt ?? new Date(),
        );
        return;

      case 'record_return_reason': {
        // The machine refused the move without a code, so one is here (D-234).
        const code = result.returnReason;
        if (code === null) throw new Error('a return was allowed without a reason code');
        await advancesRepo.insertReturnReason(tx, {
          orgId: context.orgId,
          orderId: order.id,
          kind: result.to === 'exchange' ? 'exchange' : 'return',
          reasonCode: code,
          note: result.reason,
          businessDate: result.businessDate,
          recordedBy: context.userId,
        });
        return;
      }

      case 'release_promo':
        // The use goes back once however often the cancel arrives: conditional on the
        // redemption still being applied (D-204). Nothing to do for an order with no code.
        await this.promo.releaseForOrder(tx, context.orgId, order.id);
        return;

      case 'create_exchange_order':
        if (options.callerHandlesExchange !== true) {
          // A guard rather than a comment: if a future caller reaches the exchange
          // transition through the ordinary transition route, the original order would
          // be marked `exchange` with no replacement order in existence, and the
          // customer's credit would sit in `customer_advance` with nothing pointing at it.
          throw new OrdersError(
            'ORDER_TRANSITION_INVALID',
            'An exchange is raised through the exchange endpoint, which creates the replacement order.',
          );
        }
        return;

      case 'enqueue_courier_booking':
      case 'enqueue_courier_cancel': {
        /*
         * Both are enqueues, never courier calls (invariant 6).
         *
         * `reserveConsignment` writes the consignment row and the pg-boss job *through this
         * transaction*, so the parcel is queued if and only if the status change commits: an
         * order that rolled back has no parcel queued, and one that committed has exactly
         * one. The courier call itself happens in the worker, where no transaction is open.
         */
        const courier = this.courier.current();
        if (courier === undefined) {
          // The org's policy says book, and there is nothing to book with. Refusing rolls
          // the transition back, which beats a confirmed order that the desk believes has a
          // parcel and that no courier has ever heard of.
          throw new OrdersError(
            'ORDER_TRANSITION_INVALID',
            'This deployment has no courier module registered, so a parcel cannot be queued.',
          );
        }
        if (effect === 'enqueue_courier_booking') {
          await courier.reserveConsignment(tx, actor, {
            orderId: order.id,
            courierId: options.courierId ?? order.courier_id,
          });
          return;
        }
        await courier.cancelConsignment(tx, actor, order.id);
        return;
      }

      default: {
        /*
         * `effect` is `never` here while every effect the domain declares has a case. One
         * added to the state machine without a handler stops compiling, where before it
         * compiled and silently did nothing on every transition that named it — which is
         * how `release_promo` would have gone missing.
         */
        const unhandled: never = effect;
        throw new Error(
          `The order state machine declared an effect with no handler: ${String(unhandled)}`,
        );
      }
    }
  }

  // --- the effects, in full ----------------------------------------------------

  private async dispatch(
    tx: Tx,
    context: ActiveContext,
    order: repo.OrderRow,
    options: MoveOptions,
  ): Promise<void> {
    const actor = { orgId: context.orgId, userId: context.userId };
    const locationId = await this.locationFor(tx, context, order);
    const lines = await repo.orderLines(tx, context.orgId, order.id);
    const occurredAt = options.occurredAt ?? new Date();

    /*
     * The average now, so the per-line cost can be written down.
     *
     * Read before the dispatch and checked against the total the dispatch reports. A
     * concurrent receipt that moved the average between the two makes the totals
     * disagree, and the request is refused as retryable rather than storing a figure no
     * movement records — which would put the delivery journal and the handover journal
     * on different numbers and leave goods in transit permanently non-zero.
     */
    const costs = await this.inventory.costFor(
      tx,
      context.orgId,
      lines.map((line) => line.sku_id),
    );
    const expected = lines.reduce(
      (total, line) => total + BigInt(costs.get(line.sku_id) ?? 0n) * BigInt(line.qty),
      0n,
    );

    const posted = await this.inventory.dispatch(tx, actor, {
      orderId: order.id,
      locationId,
      branchId: order.branch_id,
      occurredAt,
      lines: lines.map((line) => ({ skuId: line.sku_id, qty: line.qty })),
      fromReservation: true,
      memo: `Order ${order.order_no}`,
    });

    if (BigInt(posted.valuePoisha) !== expected) {
      throw new OrdersError(
        'ORDER_COST_MOVED',
        'A stock receipt changed the cost of these units while the handover was being recorded; try again.',
      );
    }

    for (const line of lines) {
      await repo.setLineDispatchCost(tx, {
        orgId: context.orgId,
        orderId: order.id,
        skuId: line.sku_id,
        unitCostPoisha: BigInt(costs.get(line.sku_id) ?? 0n),
      });
    }
  }

  private async postDelivery(
    tx: Tx,
    context: ActiveContext,
    order: repo.OrderRow,
    partial: boolean,
    options: MoveOptions,
    posted: Posted,
  ): Promise<void> {
    const occurredAt = options.occurredAt ?? new Date();
    const lines = await repo.orderLines(tx, context.orgId, order.id);
    const reported = new Map(
      (options.deliver?.lines ?? []).map((line) => [line.skuId, line.deliveredQty]),
    );

    // A full delivery delivers every remaining unit; a partial one delivers what the
    // courier reported, and anything not reported is treated as not delivered.
    const deliveredFor = (line: repo.OrderLineRow): number =>
      partial ? (reported.get(line.sku_id) ?? 0) : line.qty - line.returned_qty;

    const split = computePartialDelivery({
      lines: lines.map((line) => ({
        qty: line.qty,
        unitPricePoisha: poisha(BigInt(line.unit_price_poisha)),
        lineDiscountPoisha: poisha(BigInt(line.discount_poisha)),
        deliveredQty: deliveredFor(line),
      })),
      // The order-level discount only. Line discounts are already on the lines, and
      // adding them twice is how an order's revenue comes out short by exactly its
      // discount.
      orderDiscountPoisha: poisha(this.orderLevelDiscount(order, lines)),
      deliveryChargePoisha: poisha(BigInt(order.delivery_charge_poisha)),
    });

    const costPoisha = dispatchValue(
      lines.map((line) => ({
        qty: deliveredFor(line),
        unitCostPoisha: poisha(BigInt(line.dispatch_unit_cost_poisha ?? '0')),
      })),
    );

    /*
     * Only the delivered share of the advance is applied.
     *
     * Applying the whole prepayment was wrong in both directions on a partial delivery.
     * `earned` is the delivered lines plus the delivery charge, so when the advance
     * exceeded it the difference fell through `orderDeliveredDraft`'s short/over branch
     * and was **credited to Sales discounts** — extinguishing a liability the brand still
     * owed and recognising the buyer's own money as income, with the trial balance still
     * at zero and no report able to show it. The other branch was no better: with the
     * collected amount left out, the default below went negative and the transition was
     * refused outright, so a mostly-prepaid parcel that arrived in part could not be
     * recorded correctly at all.
     *
     * `applicableAdvance` is the rule the exchange flow already used for exactly this
     * question. What is left over stays in `customer_advance`, which is what it is: a
     * store credit the brand owes, spendable on a reshipment or refundable.
     */
    const { appliedPoisha: advanceAppliedPoisha } = applicableAdvance({
      netItemsPoisha: split.deliveredNetItemsPoisha,
      deliveryChargePoisha: poisha(BigInt(order.delivery_charge_poisha)),
      creditPoisha: poisha(BigInt(order.advance_paid_poisha)),
    });
    const advanceApplied = BigInt(advanceAppliedPoisha);
    const collected =
      options.deliver?.collectedPoisha === undefined
        ? // Nothing reported: assume the rider collected what the order says, which is
          // the ordinary case and keeps the Sales discounts line off the journal.
          BigInt(split.expectedCollectionPoisha) - advanceApplied
        : BigInt(options.deliver.collectedPoisha);
    if (collected < 0n) {
      throw new OrdersError(
        'ORDER_TOTAL_INVALID',
        'A rider cannot collect a negative amount; record a refund instead.',
      );
    }

    const courierId = await this.courierFor(tx, context, order, options);
    const accounts = await this.accounts(tx, context.orgId, [
      'courier_receivable',
      'sales_revenue',
      'delivery_charge_income',
      'cogs',
      'goods_in_transit',
      'customer_advance',
      'sales_discounts',
    ]);

    const journal = await this.ledger.post(
      tx,
      { orgId: context.orgId, userId: context.userId },
      orderDeliveredDraft({
        orderId: order.id,
        occurredAt,
        partial,
        courierReceivable: pick(accounts, 'courier_receivable'),
        courierId,
        salesRevenue: pick(accounts, 'sales_revenue'),
        deliveryIncome: pick(accounts, 'delivery_charge_income'),
        cogs: pick(accounts, 'cogs'),
        goodsInTransit: pick(accounts, 'goods_in_transit'),
        customerAdvance: pick(accounts, 'customer_advance'),
        salesDiscounts: pick(accounts, 'sales_discounts'),
        netItemsPoisha: split.deliveredNetItemsPoisha,
        deliveryChargePoisha: poisha(BigInt(order.delivery_charge_poisha)),
        advanceAppliedPoisha: poisha(advanceApplied),
        collectedPoisha: poisha(collected),
        costPoisha,
        differenceReason: options.deliver?.differenceReason ?? null,
        branchId: order.branch_id,
        memo: `Order ${order.order_no}`,
      }),
    );

    posted.journalId = journal.journalId;
    posted.advanceAppliedPoisha = advanceApplied;

    for (const line of lines) {
      await repo.setLineFulfilment(tx, {
        orgId: context.orgId,
        orderId: order.id,
        skuId: line.sku_id,
        deliveredQty: deliveredFor(line),
      });
    }
  }

  private async receiveReturn(
    tx: Tx,
    context: ActiveContext,
    order: repo.OrderRow,
    options: MoveOptions,
    posted: Posted,
  ): Promise<void> {
    const occurredAt = options.occurredAt ?? new Date();
    const lines = await repo.orderLines(tx, context.orgId, order.id);
    const outstanding = new Map(
      lines.map((line) => [line.sku_id, line.qty - line.delivered_qty - line.returned_qty]),
    );
    const costs = new Map(
      lines.map((line) => [line.sku_id, poisha(BigInt(line.dispatch_unit_cost_poisha ?? '0'))]),
    );

    /*
     * One receipt, two destinations (§7, §8).
     *
     * A parcel that comes back is inspected unit by unit, and §7 sends the sellable units to
     * the shelf they were picked from and the damaged ones to the `damaged` location. So the
     * movements are made in **two batches at one cost** rather than one batch at a location
     * chosen by a flag: a box with three sellable kurtis and one torn one cannot be described
     * by a boolean, and describing it wrongly either sells a torn garment or sends three good
     * ones to a shelf they need a manual transfer to leave.
     *
     * Both batches value their units at `dispatch_unit_cost_poisha`, which is what the
     * dispatch movement recorded. The journal below is one journal for their combined value,
     * because §7's return rule is `Dr Inventory / Cr Goods in transit` and the chart has one
     * inventory account — the damaged shelf is inside it. Writing damaged units *off* is a
     * separate step that needs approval (M07's `stockAdjustmentDraft`), and that separation is
     * the control: a return that could write off in one step would be a way to make stock
     * disappear without one.
     */
    const batches = await this.returnBatches(tx, context, order, options, outstanding, costs);
    const usable = batches.filter((batch) => batch.lines.length > 0);

    if (usable.length === 0) {
      throw new OrdersError(
        'ORDER_LINES_INVALID',
        'Every unit on this order is already accounted for.',
      );
    }

    let valuePoisha = 0n;
    const returned = new Map<string, number>();
    for (const batch of usable) {
      const received = await this.inventory.receiveCustomerReturn(
        tx,
        { orgId: context.orgId, userId: context.userId },
        {
          orderId: order.id,
          locationId: batch.locationId,
          occurredAt,
          lines: batch.lines,
          memo: `Order ${order.order_no} return (${batch.condition})`,
        },
      );
      valuePoisha += BigInt(received.valuePoisha);
      for (const line of batch.lines) {
        returned.set(line.skuId, (returned.get(line.skuId) ?? 0) + line.qty);
      }
    }

    // §7's return journal is `Dr Inventory / Cr Goods in transit` at the dispatch value.
    // Inventory records the movements and deliberately leaves the journal to whoever knows
    // whether the parcel was refused, partly delivered or sent back — which is this module.
    if (valuePoisha > 0n) {
      const accounts = await this.accounts(tx, context.orgId, ['inventory', 'goods_in_transit']);
      const journal = await this.ledger.post(
        tx,
        { orgId: context.orgId, userId: context.userId },
        orderReturnDraft({
          orderId: order.id,
          occurredAt,
          inventory: pick(accounts, 'inventory'),
          goodsInTransit: pick(accounts, 'goods_in_transit'),
          valuePoisha: poisha(valuePoisha),
          branchId: order.branch_id,
          memo: `Order ${order.order_no} return`,
        }),
      );
      posted.journalId = journal.journalId;
    }

    for (const line of lines) {
      const back = returned.get(line.sku_id) ?? 0;
      if (back === 0) continue;
      await repo.setLineFulfilment(tx, {
        orgId: context.orgId,
        orderId: order.id,
        skuId: line.sku_id,
        returnedQty: line.returned_qty + back,
      });
    }
  }

  /**
   * The movements a return makes, grouped by the location they land in.
   *
   * Two shapes of caller, one set of batches. The courier module and the warehouse screen
   * send `receipt` — an inspection, per SKU, split into sellable and damaged. The desk's own
   * receive-return route has no inspection and sends every outstanding unit to one place,
   * optionally the damaged shelf. Both end up here so there is exactly one place that
   * decides how many units of what cost go where.
   */
  private async returnBatches(
    tx: Tx,
    context: ActiveContext,
    order: repo.OrderRow,
    options: MoveOptions,
    outstanding: ReadonlyMap<string, number>,
    costs: ReadonlyMap<string, Poisha>,
  ): Promise<
    readonly {
      readonly condition: 'sellable' | 'damaged';
      readonly locationId: string;
      readonly lines: readonly { skuId: string; qty: number; dispatchUnitCostPoisha: Poisha }[];
    }[]
  > {
    const receipt = options.ret?.receipt;

    if (receipt === undefined) {
      const locationId =
        options.ret?.damaged === true
          ? await this.damagedLocation(tx, context)
          : (options.ret?.locationId ?? (await this.locationFor(tx, context, order)));
      const lines = [...outstanding]
        .filter(([, qty]) => qty > 0)
        .map(([skuId, qty]) => ({
          skuId,
          qty,
          dispatchUnitCostPoisha: costs.get(skuId) ?? poisha(0n),
        }));
      return [
        { condition: options.ret?.damaged === true ? 'damaged' : 'sellable', locationId, lines },
      ];
    }

    for (const line of receipt.lines) {
      const limit = outstanding.get(line.skuId);
      if (limit === undefined || line.sellableQty + line.damagedQty > limit) {
        /*
         * More back than went out, refused rather than clamped.
         *
         * Checked here as well as in the module that took the inspection, because this is
         * the module that would create the units: clamping would put stock on a shelf that
         * no dispatch ever took off one, and the inventory reconciliation would report the
         * symptom weeks later with nothing to trace it to.
         */
        throw new OrdersError(
          'ORDER_LINES_INVALID',
          'More units came back for one SKU than are still outstanding on this order.',
        );
      }
    }

    const damagedQty = receipt.lines.reduce((total, line) => total + line.damagedQty, 0);
    const damagedLocationId =
      damagedQty === 0
        ? null
        : (receipt.damagedLocationId ?? (await this.damagedLocation(tx, context)));

    const batches: {
      condition: 'sellable' | 'damaged';
      locationId: string;
      lines: { skuId: string; qty: number; dispatchUnitCostPoisha: Poisha }[];
    }[] = [
      { condition: 'sellable', locationId: receipt.locationId, lines: [] },
      ...(damagedLocationId === null
        ? []
        : [{ condition: 'damaged' as const, locationId: damagedLocationId, lines: [] }]),
    ];

    for (const line of receipt.lines) {
      const unitCost = costs.get(line.skuId) ?? poisha(0n);
      if (line.sellableQty > 0) {
        batches[0]?.lines.push({
          skuId: line.skuId,
          qty: line.sellableQty,
          dispatchUnitCostPoisha: unitCost,
        });
      }
      if (line.damagedQty > 0) {
        batches[1]?.lines.push({
          skuId: line.skuId,
          qty: line.damagedQty,
          dispatchUnitCostPoisha: unitCost,
        });
      }
    }

    return batches;
  }

  /** The brand's damaged shelf, or a refusal naming what is missing (§7). */
  private async damagedLocation(tx: Tx, context: ActiveContext): Promise<string> {
    const damaged = await repo.damagedLocation(tx, context.orgId);
    if (damaged === undefined) {
      throw new OrdersError(
        'STOCK_LOCATION_INVALID',
        'This brand has no damaged-stock location; create one before receiving damaged returns.',
      );
    }
    return damaged.id;
  }

  private async updateStats(
    tx: Tx,
    context: ActiveContext,
    order: repo.OrderRow,
    result: TransitionResult,
  ): Promise<void> {
    /*
     * Three of §9's eleven statuses move a buyer's counters, and the rest move nothing.
     *
     * Written as guards rather than a `switch` with a `default`, because the machine only
     * ever produces this effect on those three rows — a `default: return` would be a branch
     * that looks like it handles the other eight and in fact can never run, which is the
     * kind of dead code a reader spends time on.
     */
    if (result.to === 'delivered' || result.to === 'partially_delivered') {
      /*
       * LTV moves by net revenue recognised, which for a partial delivery is the
       * delivered part only — anything else would count a return as a purchase.
       *
       * Through `computePartialDelivery`, which is the same function the journal used, so
       * the two cannot disagree. Summing it here by hand was wrong twice: it ignored the
       * **order-level** discount entirely, so a ৳1,000 order with a ৳200 promo added
       * ৳1,000 to lifetime value while ৳800 of revenue was recognised; and on a partial
       * delivery it subtracted the whole line discount from the delivered units alone,
       * understating the rest. It was also arithmetic outside `packages/domain`, which
       * invariant 11 exists to prevent — and this figure feeds §10's trust score, so a
       * buyer's own history was being scored against a number the ledger never agreed
       * with.
       */
      const lines = await repo.orderLines(tx, context.orgId, order.id);
      const net = BigInt(deliveredNetItems(order, lines));
      await this.customers.applyStats(tx, context.orgId, order.customer_id, {
        delivered: 1,
        ltvPoisha: net > 0n ? net : 0n,
        orderedAt: order.created_at,
      });
      return;
    }
    if (result.to === 'returned') {
      await this.customers.applyStats(tx, context.orgId, order.customer_id, { returned: 1 });
      return;
    }
    if (result.to === 'cancelled') {
      await this.customers.applyStats(tx, context.orgId, order.customer_id, { cancelled: 1 });
    }
  }

  // --- resolving the things a posting needs ------------------------------------

  /**
   * The order-level discount: the order's total discount minus what the lines carry.
   *
   * Derived rather than stored separately because `orders.discount_poisha` is what §9
   * names and what the COD CHECK re-derives from. Splitting it into two columns would
   * give two numbers that must agree, and the one the reports read would be whichever
   * the last migration touched.
   */
  private orderLevelDiscount(order: repo.OrderRow, lines: readonly repo.OrderLineRow[]): bigint {
    return orderLevelDiscount(order, lines);
  }

  async locationFor(tx: Tx, context: ActiveContext, order: repo.OrderRow): Promise<string> {
    if (order.location_id !== null) return order.location_id;
    const fallback = await repo.defaultFulfilmentLocation(tx, context.orgId, order.branch_id);
    if (fallback === undefined) {
      throw new OrdersError(
        'STOCK_LOCATION_INVALID',
        'This brand has no warehouse to fulfil from; create one first.',
      );
    }
    return fallback.id;
  }

  /**
   * Refuse to name a different courier once a parcel is with one.
   *
   * §7's delivery journal debits `courier_receivable` against the order's courier, and a
   * settlement relieves it against the *consignment's* courier. While they are the same
   * party the receivable clears to zero. Let the order move to another courier after the
   * parcel is booked and the debit lands on one courier and the credit on another: the
   * first is owed money it never collected, the second has a balance that never clears,
   * and the org's total still agrees — so the trial balance is no help and the only
   * symptom is two reconciliation variances nobody can pair up (M15's ledger audit).
   *
   * A live parcel is a pending or booked consignment. To change courier, cancel that
   * booking first; then there is no parcel and this allows it.
   */
  async assertCourierChangeAllowed(
    tx: Tx,
    orgId: string,
    order: Pick<repo.OrderRow, 'id' | 'courier_id'>,
    nextCourierId: string | null | undefined,
  ): Promise<void> {
    if (nextCourierId === null || nextCourierId === undefined) return;
    if (nextCourierId === order.courier_id) return;
    const courier = this.courier.current();
    if (courier === undefined) return;
    if (await courier.hasLiveParcel(tx, orgId, order.id)) {
      throw new OrdersError(
        'ORDER_IMMUTABLE',
        'This order already has a parcel booked with its courier. Cancel that booking before choosing another courier.',
      );
    }
  }

  /**
   * Refuse a delivery or a received return recorded on the order while its parcel is live
   * with a courier (ledger audit of D-392, W2).
   *
   * The order routes post §7's journals and never touch the consignment, so a delivery
   * marked here left the parcel's `collected_poisha` empty: the courier's own "delivered"
   * then found the order delivered and recorded nothing, and every such parcel became an
   * amount mismatch on the courier's statement, its receivable never cleared by matching.
   * A return received here sat in the courier's "awaiting return" list for good. The parcel
   * routes (`POST /v1/courier/parcels/:id/status` and `…/receive-return`) take the same
   * moves through `applyTrigger` and write the consignment too, so the order is pointed
   * there. Pending counts as live, as it does for a cancel (`hasLiveParcel`).
   */
  async assertNoLiveParcel(tx: Tx, orgId: string, orderId: string): Promise<void> {
    const courier = this.courier.current();
    if (courier === undefined) return;
    if (await courier.hasLiveParcel(tx, orgId, orderId)) {
      throw new OrdersError(
        'ORDER_TRANSITION_INVALID',
        'This order has a parcel with the courier. Record the delivery or the return on the parcel, so the courier’s figure and its statement agree.',
      );
    }
  }

  private async courierFor(
    tx: Tx,
    context: ActiveContext,
    order: repo.OrderRow,
    options: MoveOptions,
  ): Promise<string> {
    // Every posting that names a courier party comes through here, so this is the one
    // place the rule cannot be walked around by a transition that takes `courierId`.
    await this.assertCourierChangeAllowed(tx, context.orgId, order, options.courierId);
    const named = options.courierId ?? order.courier_id;
    if (named !== null && named !== undefined) return named;
    const fallback = await repo.defaultCourier(tx, context.orgId);
    if (fallback === undefined) {
      // §7's courier receivable is a party subtype: the balance is per courier or it is
      // meaningless. Refusing beats posting the delivery against a nameless party, which
      // is a receivable nobody can reconcile.
      throw new OrdersError(
        'DELIVERY_ZONE_NOT_FOUND',
        'This brand has no courier configured, so a delivery cannot be posted.',
      );
    }
    return fallback.id;
  }

  /** The §7 accounts, by subtype, or a clear refusal naming the missing one. */
  private async accounts(
    tx: Tx,
    orgId: string,
    subtypes: readonly AccountSubtype[],
  ): Promise<Accounts> {
    const found = new Map<AccountSubtype, PostingAccount>();
    for (const subtype of subtypes) {
      const row = await repo.accountBySubtype(tx, orgId, subtype);
      if (row === undefined) {
        // Seeded by the chart-of-accounts template (D-084). Missing means the chart is
        // broken, and saying so beats posting the value somewhere else.
        throw new OrdersError(
          'LEDGER_ACCOUNT_NOT_FOUND',
          `This organization has no ${subtype} account.`,
        );
      }
      found.set(subtype, { accountId: row.id, subtype, branchId: row.branch_id });
    }
    return found;
  }

  /** Exposed for the exchange flow, which needs the same accounts. */
  async accountsFor(tx: Tx, orgId: string, subtypes: readonly AccountSubtype[]): Promise<Accounts> {
    return this.accounts(tx, orgId, subtypes);
  }
}
