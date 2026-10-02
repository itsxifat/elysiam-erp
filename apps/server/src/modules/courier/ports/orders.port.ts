import type { Tx } from '@elysium/db';
import type { OrderStatus, OrderTrigger, Poisha, ReturnReasonCode } from '@elysium/domain';

import type { AuditableRequest } from '../../../platform/audit/audit.interceptor.js';
import type { ActiveContext } from '../../../platform/http/context.js';

/**
 * What this module needs from `modules/orders` (invariant 12).
 *
 * Declared here, in the *consumer*, rather than imported from the orders module, and the
 * reason is more than session mechanics. Invariant 7 says an order's status changes only
 * through the domain state machine, and the orders module is the only thing that runs it
 * — so the courier module must not move an order, must not reserve or release stock, and
 * must not post an order's revenue or return journal. Every one of those is an *effect*
 * of a transition, performed by `TransitionsService`, and this port is the whole of what
 * the courier module is allowed to ask for.
 *
 * The three methods are therefore three questions and one instruction:
 *
 * - "what do I send the courier for this order" (`bookingSnapshot`)
 * - "where is this order now" (`statusOf`)
 * - "what came back, and what did it cost when it went out" (`returnableLines`)
 * - "the courier says this happened; apply §9's trigger for it" (`applyTrigger`)
 *
 * Everything that moves — stock, journals, the status column, the audit row, the
 * `order.status_changed` event — happens inside `applyTrigger`, in the caller's
 * transaction, in the orders module. This module records what the courier said and
 * nothing else.
 *
 * ## The cost that must not come back through here
 *
 * `returnableLines` carries `dispatchUnitCostPoisha`, which is purchase cost (invariant
 * 5). It is on the port because §8 requires a return to re-enter stock at exactly the
 * cost its dispatch movement recorded, and only the orders module knows that figure. It
 * must never reach a response: nothing in this module puts it in one, and the field name
 * belongs in `COST_FIELDS` so `serializeFor` would strip it if anything ever did. The
 * INTEGRATION notes ask for that entry.
 */

/** Everything a courier needs about an order, and nothing more. */
export interface OrderBookingSnapshot {
  readonly orderId: string;
  readonly orderNo: string;
  readonly status: OrderStatus;
  readonly branchId: string | null;
  readonly locationId: string | null;
  /** The courier the desk or the zone chose. Null when nobody has. */
  readonly courierId: string | null;
  readonly codAmountPoisha: Poisha;
  readonly deliveryChargePoisha: Poisha;
  /** The address as it was snapshotted on the order, with the divisions resolved to names. */
  readonly recipientName: string;
  readonly recipientPhoneE164: string;
  readonly district: string;
  readonly thana: string;
  readonly area: string | null;
  readonly addressLine: string;
  /** For the courier's parcel description. Never an item's cost. */
  readonly itemSummary: string | null;
  readonly notes: string | null;
}

/** One line of a parcel coming back, with what it was worth when it left. */
export interface ReturnableLine {
  readonly skuId: string;
  readonly skuCode: string;
  /** Dispatched minus already returned: the most that can still come back. */
  readonly outstandingQty: number;
  /** §8: the cost the dispatch movement recorded. Cost — see the note above. */
  readonly dispatchUnitCostPoisha: Poisha;
}

/** What a courier status says happened, in the shape §9's triggers need. */
export interface CourierTriggerInput {
  readonly orderId: string;
  readonly trigger: OrderTrigger;
  readonly occurredAt: Date;
  /** Required by the transitions §9 marks as needing one. */
  readonly reason?: string | null;
  /** What the courier reported collecting, for the delivery journal. */
  readonly collectedPoisha?: Poisha | undefined;
  /** Set for a partial delivery: what actually arrived, per SKU. */
  readonly deliveredLines?: readonly { readonly skuId: string; readonly deliveredQty: number }[];
  /** Set on `receive_return`: why the parcel came back, from the fixed list (M17, D-234). */
  readonly returnReason?: ReturnReasonCode | undefined;
  /** Set on `receive_return`: where sellable and damaged units go, and what came back. */
  readonly returnReceipt?: {
    readonly locationId: string;
    readonly damagedLocationId: string | null;
    readonly lines: readonly {
      readonly skuId: string;
      readonly sellableQty: number;
      readonly damagedQty: number;
    }[];
  };
}

export interface AppliedTrigger {
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  /** The Asia/Dhaka business date the transition posted on (invariant 8). */
  readonly businessDate: string;
  /** The journal the transition posted, when it posted one. */
  readonly journalId: string | null;
}

/**
 * The few order facts M15 needs beyond the booking snapshot (M15).
 *
 * A structural subset of `OrdersApi.summary`'s `OrderSummary`, declared here so this module
 * states exactly what it reads: the zone, for the selection rules and the performance
 * report; the buyer's phone, for the public tracking page's last-four check; the status, for
 * the stage a customer is shown. Nothing about money beyond the COD, and no cost.
 */
export interface OrderFacts {
  readonly orderNo: string;
  readonly status: OrderStatus;
  readonly branchId: string | null;
  readonly courierId: string | null;
  readonly deliveryZoneId: string | null;
  /** E.164. Compared on its last four digits and never returned by this module. */
  readonly customerPhoneE164: string;
  /** Decimal string, as `OrderSummary` carries it. */
  readonly codAmountPoisha: string;
}

/** A courier party, named. M10 owns the row; this module owns the account beside it. */
export interface CourierParty {
  readonly id: string;
  /** `steadfast`, `pathao`, `redx`, `own_rider`. Resolves the adapter. */
  readonly code: string;
  readonly name: string;
}

export interface OrdersPort {
  /**
   * Null when the order is not this org's.
   *
   * `forUpdate` locks the order for the caller's transaction (M17, D-231): the booking that
   * copies the COD onto a consignment must serialise with an advance verification that
   * lowers it, or the parcel goes out carrying the figure from before the advance.
   */
  bookingSnapshot(
    tx: Tx,
    orgId: string,
    orderId: string,
    options?: { readonly forUpdate?: boolean },
  ): Promise<OrderBookingSnapshot | null>;

  /**
   * The words for the courier ids this module stores (invariant 12).
   *
   * Every consignment, account, label and settlement row carries a `courier_id`, and
   * a person reading one needs the courier's name beside it. `sales.couriers` is
   * M10's table, so this module asks for the names instead of joining them: eight
   * queries here used to reach across that boundary, which is the coupling that
   * stops M10 ever changing the shape of its own table.
   *
   * Ids this org does not have come back absent rather than as an error.
   */
  courierParties(tx: Tx, orgId: string, ids: readonly string[]): Promise<readonly CourierParty[]>;

  /**
   * M15. `OrdersApi.summary`, read through this module's own statement of what it needs.
   * Undefined when the order is not this org's.
   */
  summary(tx: Tx, orgId: string, orderId: string): Promise<OrderFacts | undefined>;

  /** Just the status and the two ids a consignment row needs. Null when not found. */
  statusOf(
    tx: Tx,
    orgId: string,
    orderId: string,
  ): Promise<{
    readonly status: OrderStatus;
    readonly branchId: string | null;
    readonly locationId: string | null;
    readonly courierId: string | null;
  } | null>;

  /** What can still come back off this order, for the returns screen. */
  returnableLines(tx: Tx, orgId: string, orderId: string): Promise<readonly ReturnableLine[]>;

  /**
   * Run §9's trigger for a courier event, with all of its effects.
   *
   * Joins the caller's transaction, so the consignment row, the event row and everything
   * the transition does commit together or not at all. Returns `null` when the machine
   * has nothing to do — the order is already in that state, which is what a duplicate
   * webhook looks like from here (acceptance check 3) — and throws
   * `ORDER_TRANSITION_INVALID` when the move is genuinely illegal.
   *
   * `request` is the HTTP request when a person caused this, and `undefined` when a job
   * did. The orders module needs it for the audit row's scope; a job has no request, and
   * passing a fabricated one would put a made-up scope on an audit entry.
   */
  applyTrigger(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest | undefined,
    input: CourierTriggerInput,
  ): Promise<AppliedTrigger | null>;
}

export const ORDERS_PORT = Symbol('OrdersPort');
