import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';
import {
  computePartialDelivery,
  poisha,
  TRANSITIONS,
  transitionFor,
  type OrderStatus,
  type GatewayAdvanceMethod,
  type OrderTrigger,
  type Poisha,
  type PostingAccount,
  type ReturnReasonCode,
} from '@elysium/domain';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import { AdvancesService } from './advances.service.js';
import { OrdersService, type CreateOrderOptions, type CreatedOrder } from './orders.service.js';
import { CourierBookingRegistry } from './ports/courier-booking.port.js';
import { TransitionsService, type MoveOptions } from './transitions.service.js';
import { mapOrderErrors } from './orders.errors.js';
import * as repo from './orders.repository.js';
import { deliveredNetItems } from './revenue.js';
import type { CreateOrderInput } from './orders.schemas.js';

/**
 * Orders' service interface for other modules (invariant 12).
 *
 * The modules that need it are M12 (a courier webhook moves an order to delivered,
 * partially delivered or returned), M13 (writes a trust score and a decision onto an
 * order it may not otherwise touch), M21 (a reseller's order, entered through the
 * portal) and M23 (a POS sale, which is an order that ships and delivers in one step).
 * None of them writes `sales.*`, and none of them decides a transition for itself.
 *
 * ## Why this is not simply `OrdersService`
 *
 * Every method here takes the **caller's** transaction and a plain `{ orgId, userId }`
 * actor. `OrdersService`'s public methods open their own `withOrg` and read the caller's
 * permission scope off an HTTP request; a worker has neither. Handing M12 the service
 * directly would mean a courier webhook opening a second transaction beside the one that
 * recorded the webhook — and then a delivered order whose journal committed while the
 * webhook row rolled back.
 *
 * ## What is deliberately not here
 *
 * * **No cost, and no way to ask for one.** `OrderSummary` carries the COD, which is
 *   what the courier collects, and no unit cost, no dispatch value and no margin
 *   (invariant 5). M12 reconciles against the COD; nothing downstream needs more.
 * * **No permission scope.** These callers are servers, not people. A module that wants
 *   to act *as* a user — M21's portal — applies §6 at its own edge, where it has the
 *   request to apply it from.
 * * **No `setStatus`.** The only way an order's status moves is `transition`, which runs
 *   the domain machine and performs §9's effects (invariant 7). An interface that could
 *   set a status would be the hole invariant 7 exists to close.
 */

export interface OrdersActor {
  readonly orgId: string;
  readonly userId: string;
}

/** One order, as another module sees it. No cost, by construction. */
export interface OrderSummary {
  readonly id: string;
  readonly orderNo: string;
  readonly status: OrderStatus;
  readonly branchId: string | null;
  readonly customerId: string;
  /** E.164. Masked before it reaches a log line (invariant 10). */
  readonly customerPhoneE164: string;
  readonly codAmountPoisha: string;
  readonly advancePaidPoisha: string;
  readonly deliveryChargePoisha: string;
  readonly courierId: string | null;
  readonly locationId: string | null;
  readonly deliveryZoneId: string | null;
  readonly assignedTo: string | null;
  readonly createdBy: string;
  readonly resellerId: string | null;
  readonly exchangeOfOrderId: string | null;
}

/**
 * ## The four methods a courier module needs, restated here
 *
 * M12 declares its own `OrdersPort` (`modules/courier/ports/orders.port.ts`) and depends
 * on that rather than on this file, the same way this module depends on its own
 * ports rather than on other modules. The shapes below are therefore a
 * deliberate *copy* of that port's: importing it would point the arrow back and make the
 * two modules' service interfaces depend on each other, which is where invariant 12 stops
 * meaning anything. The copy is bounded — `courier.module.ts` binds `ORDERS_PORT` through
 * a typed factory, so a drift between the two declarations is a compile error there — and
 * the duplication is the price of the arrow pointing one way.
 *
 * Everything that *moves* stays here: stock, journals, the status column, the audit row
 * and `order.status_changed` all happen inside `applyTrigger`, in the caller's
 * transaction, through `TransitionsService` and the domain machine (invariant 7).
 */

/** Everything a courier needs about an order, and nothing more. */
export interface OrderBookingSnapshot {
  readonly orderId: string;
  readonly orderNo: string;
  readonly status: OrderStatus;
  readonly branchId: string | null;
  readonly locationId: string | null;
  readonly courierId: string | null;
  readonly codAmountPoisha: Poisha;
  readonly deliveryChargePoisha: Poisha;
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

/**
 * One line of a parcel coming back, with what it was worth when it left.
 *
 * `dispatchUnitCostPoisha` is purchase cost (invariant 5) and it is on this interface
 * because §8 requires a return to re-enter stock at exactly the cost its dispatch
 * movement recorded — a figure only this module holds. It travels to the courier module
 * so that module can hand it straight back to `applyTrigger`; nothing puts it in a
 * response, and the field name is in `COST_FIELDS`, so `serializeFor` would strip it if
 * anything ever did.
 */
export interface ReturnableLine {
  readonly skuId: string;
  readonly skuCode: string;
  /** Dispatched minus already returned: the most that can still come back. */
  readonly outstandingQty: number;
  readonly dispatchUnitCostPoisha: Poisha;
}

/** What a courier status says happened, in the shape §9's triggers need. */
export interface CourierTriggerInput {
  readonly orderId: string;
  readonly trigger: OrderTrigger;
  readonly occurredAt: Date;
  readonly reason?: string | null;
  /** What the courier reported collecting, for the delivery journal. */
  readonly collectedPoisha?: Poisha | undefined;
  /**
   * Why the collection differs from the COD, for a delivery a person records (§7: the
   * difference goes to Sales discounts "with a reason", on the journal line's memo).
   */
  readonly differenceReason?: string | undefined;
  /**
   * A person typed the collected amount (a parcel's manual status), not the courier: a
   * shortfall then needs a reason and stays within the person's ceiling (D-365).
   */
  readonly typedByPerson?: true | undefined;
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

/** One buyer and what they did with this brand before go-live (M14a). */
export interface ImportedBuyer {
  readonly phoneE164: string;
  readonly name: string;
  readonly delivered: number;
  readonly returned: number;
  readonly cancelled: number;
  /** Selling money, never a cost. */
  readonly spentPoisha: bigint;
}

/**
 * One agent's order results on one Asia/Dhaka day (M20, D-272).
 *
 * The shape `@elysium/domain/targets`' rollup adds up. Revenue is the net goods value the
 * delivery journal recognised — never a cost, and never the delivery charge.
 */
export interface AgentDayResult {
  readonly userId: string;
  readonly businessDate: string;
  readonly confirmedOrders: number;
  readonly deliveredOrders: number;
  readonly deliveredRevenuePoisha: bigint;
}

/** A courier party: who delivers, named. Reference data, never order state. */
export interface CourierParty {
  readonly id: string;
  /** `steadfast`, `pathao`, `redx`, `own_rider`. */
  readonly code: string;
  readonly name: string;
}

/**
 * One order, as §11's marketing dashboard needs it (M18).
 *
 * The dates things happened, the order's own recorded source and promo code (attribution
 * is the marketing module's to resolve), and two revenues computed here, where the lines
 * are: delivered net item value, by the same function the delivery journal uses, and the
 * net item value as placed. No buyer, no phone, no cost.
 */
export interface MarketingOrderFact {
  readonly orderId: string;
  readonly channel: string;
  readonly status: OrderStatus;
  readonly source: {
    readonly campaignId: string | null;
    readonly adId: string | null;
    readonly utmCampaign: string | null;
  };
  readonly promoCodeId: string | null;
  readonly confirmedAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly returnedAt: Date | null;
  readonly deliveredRevenuePoisha: Poisha;
  readonly placedRevenuePoisha: Poisha;
}

/**
 * What a delivered order's Conversions API event is built from (M18, §11).
 *
 * The buyer's phone, name and district are here because Meta matches on them — hashed by
 * the caller before anything is stored or sent, and never logged (invariant 10).
 */
export interface ConversionFacts {
  readonly orderId: string;
  readonly customerId: string;
  readonly channel: string;
  readonly status: OrderStatus;
  readonly deliveredAt: Date | null;
  readonly deliveredRevenuePoisha: Poisha;
  readonly phoneE164: string;
  readonly name: string;
  readonly city: string | null;
  readonly lines: readonly { readonly skuCode: string; readonly deliveredQty: number }[];
}

/**
 * One order, as the analytics rollup needs it (M24, D-321): the Dhaka day each thing
 * happened to it, where it came from, and two amounts computed here, where the lines are.
 *
 * `deliveredCostPoisha` is purchase cost (invariant 5). It leaves this module only so the
 * rollup can subtract it from revenue; the rollup stores the difference (gross profit,
 * which is in `COST_FIELDS`) and never the cost. No buyer, no phone, no address.
 */
export interface AnalyticsOrderFact {
  readonly orderId: string;
  readonly channel: string;
  readonly branchId: string | null;
  readonly createdOn: string;
  readonly confirmedOn: string | null;
  readonly deliveredOn: string | null;
  readonly returnedOn: string | null;
  /** Only for an order cancelled after it had been confirmed. */
  readonly cancelledOn: string | null;
  readonly outsideDhaka: boolean;
  readonly deliveredRevenuePoisha: Poisha;
  readonly deliveredCostPoisha: Poisha;
}

/** A SKU's delivered units in a period, for the dashboard's best sellers (M24). */
export interface TopSku {
  readonly skuId: string;
  readonly skuCode: string;
  readonly productName: string;
  readonly units: number;
}

/** A delivery zone as another module sees it (M33). */
export interface DeliveryZoneSummary {
  readonly id: string;
  readonly code: string;
  readonly nameEn: string;
  readonly nameBn: string;
  readonly chargePoisha: bigint;
  readonly isActive: boolean;
}

/** One order as its shopper may see it (M34, D-524): selling-side money, no cost, no staff. */
export interface ShopperOrderFacts {
  readonly id: string;
  readonly orderNo: string;
  readonly channel: string;
  readonly status: OrderStatus;
  readonly customerId: string;
  readonly createdAt: Date;
  readonly confirmedAt: Date | null;
  readonly shippedAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly returnedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly itemsPoisha: bigint;
  readonly discountPoisha: bigint;
  readonly deliveryChargePoisha: bigint;
  readonly advancePaidPoisha: bigint;
  readonly codAmountPoisha: bigint;
  readonly courierId: string | null;
  readonly lineCount: number;
  readonly unitCount: number;
  readonly shipTo: {
    readonly name: string;
    readonly phoneE164: string;
    readonly districtId: number;
    readonly thanaId: number;
    readonly districtEn: string | null;
    readonly districtBn: string | null;
    readonly thanaEn: string | null;
    readonly thanaBn: string | null;
    readonly area: string | null;
    readonly addressLine: string;
  };
}

/** One line as its shopper may see it: what was charged, never what it cost. */
export interface ShopperOrderLine {
  readonly id: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly productName: string;
  readonly qty: number;
  readonly unitPricePoisha: bigint;
  readonly discountPoisha: bigint;
}

/** A gateway payment the caller validated, to book as a verified advance (M34, D-526). */
export interface GatewayAdvanceInput {
  readonly orderId: string;
  readonly method: GatewayAdvanceMethod;
  /** The gateway transaction id: the advance's reference, unique while live. */
  readonly transactionRef: string;
  readonly amountPoisha: bigint;
  /** The clearing wallet's ledger account (`WalletsApi.ensureSystemWallet`). */
  readonly wallet: PostingAccount;
  readonly note: string | null;
}

export interface OrdersApi {
  /**
   * Take an order inside the caller's transaction.
   *
   * The same path the HTTP endpoint uses, minus the scope check the caller owns: the
   * buyer is upserted by phone, the lines are priced from the catalog, the totals come
   * from the domain and the number from the counter's atomic upsert.
   */
  createOrder(
    tx: Tx,
    actor: OrdersActor,
    input: CreateOrderInput,
    options?: CreateOrderOptions,
  ): Promise<CreatedOrder>;

  /**
   * Move one order through §9's machine, performing its effects in this transaction.
   *
   * Idempotency is the caller's to arrange. A courier webhook that arrives twice must
   * not deliver an order twice, and the reason it does not is that the second attempt
   * finds the order already `delivered` and the machine refuses the move with
   * `ORDER_TRANSITION_INVALID` — which M12 treats as "already applied" rather than as a
   * failure. The journals underneath are idempotent as well (`ledger.post`), so even a
   * path that got past the machine could not post twice.
   */
  transition(
    tx: Tx,
    actor: OrdersActor,
    orderId: string,
    trigger: OrderTrigger,
    options?: MoveOptions,
  ): Promise<{ from: OrderStatus; to: OrderStatus }>;

  /** One order, or nothing. The read every other module starts from. */
  summary(tx: Tx, orgId: string, orderId: string): Promise<OrderSummary | undefined>;

  /**
   * The courier parties these ids name (M10 owns `sales.couriers`).
   *
   * Here because every other module stores a `courier_id` and needs the word beside
   * it — a consignment list, a label, a settlement screen, a tracking page. Reading
   * the table across the module boundary is what invariant 12 forbids, and a join
   * is a read: the courier module used to carry eight of them.
   *
   * Ids that name no courier of this org are absent from the result rather than an
   * error, so one unknown id in a page of consignments does not blank the page.
   */
  courierParties(tx: Tx, orgId: string, ids: readonly string[]): Promise<readonly CourierParty[]>;

  /** The couriers these codes name, active or not (M14a's COD in transit). */
  couriersByCodes(
    tx: Tx,
    orgId: string,
    codes: readonly string[],
  ): Promise<ReadonlyMap<string, CourierParty & { readonly isActive: boolean }>>;

  /**
   * The brand's delivery zones, active or not (M33): what the website's shipping rule maps
   * its three zones onto (D-503). Charges are selling-side money, never a cost.
   */
  deliveryZones(tx: Tx, orgId: string): Promise<readonly DeliveryZoneSummary[]>;

  /** Of these E.164 phones, the ones already a buyer of this brand. */
  buyerPhones(tx: Tx, orgId: string, phones: readonly string[]): Promise<ReadonlySet<string>>;

  /**
   * A brand's existing buyers with their history (M14a, D-218), inside the caller's
   * transaction: one `sales.customers` row each, its counters set from the file —
   * `orders_total` is delivered + returned + cancelled, and `ltv_poisha` is what they
   * spent. A phone that is already a buyer is refused by the unique index rather than
   * merged, which rolls the whole import back; the importer skips those before calling.
   */
  importBuyers(tx: Tx, actor: OrdersActor, buyers: readonly ImportedBuyer[]): Promise<number>;

  /** Available units per SKU at one location, for a caller pricing a basket. */
  availability(
    tx: Tx,
    orgId: string,
    locationId: string,
    skuIds: readonly string[],
  ): Promise<Map<string, number>>;

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

  /** Just the status and the ids a consignment row needs. Null when not found. */
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
   * Locks the order, asks the domain, performs the effects and moves the status — one
   * transaction with the caller's, so the consignment row, the courier event and
   * everything the transition does commit together or not at all.
   *
   * Returns **null when the machine has nothing to do**: the order is already in the
   * status this trigger leads to, which is what a duplicate webhook or a re-delivered
   * poll looks like from here. That is not an error and must not be one — a courier that
   * retries a delivery notification would otherwise dead-letter its own webhook (M12
   * acceptance check 3). A genuinely illegal move — `deliver` on a `pending` order — still
   * throws `ORDER_TRANSITION_INVALID` from the domain, with the domain's own message.
   *
   * `request` is the HTTP request when a person caused this and `undefined` when a job
   * did. Undefined is passed through as "no request" rather than replaced with something
   * invented: a made-up scope on an audit row is worse than none.
   */
  applyTrigger(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest | undefined,
    input: CourierTriggerInput,
  ): Promise<AppliedTrigger | null>;

  /** Orders confirmed, delivered or returned on a Dhaka date in the period (M18, D-255). */
  marketingFacts(
    tx: Tx,
    orgId: string,
    period: { readonly from: string; readonly to: string },
  ): Promise<readonly MarketingOrderFact[]>;

  /** One order's conversion inputs, or null when it is not this org's (M18). */
  conversionFacts(tx: Tx, orgId: string, orderId: string): Promise<ConversionFacts | null>;

  /**
   * What each agent's orders came to per Asia/Dhaka day, `from` to `to` inclusive (M20).
   *
   * For HR's targets: the agent who confirmed an order is the one it counts for (D-272).
   * Delivered revenue goes through `computePartialDelivery`, the function the delivery
   * journal uses, so a target and the books cannot disagree about what an order earned.
   */
  agentResults(
    tx: Tx,
    orgId: string,
    range: { readonly from: string; readonly to: string },
  ): Promise<readonly AgentDayResult[]>;

  /**
   * Every order that had something happen on a Dhaka date `from` to `to` (M24, D-321), for
   * the analytics rollup. Revenue through `deliveredNetItems`, as the delivery journal.
   */
  analyticsFacts(
    tx: Tx,
    orgId: string,
    range: { readonly from: string; readonly to: string },
  ): Promise<readonly AnalyticsOrderFact[]>;

  // --- M34: the website ------------------------------------------------------------

  /** The buyer this E.164 phone names, or undefined: per-buyer discount limits (D-541). */
  buyerIdByPhone(tx: Tx, orgId: string, phoneE164: string): Promise<string | undefined>;

  /**
   * Whether this thana is in this district (the reference data), and the brand's delivery zone
   * for it, or null when the address falls in no zone: what the website's shipping rule prices.
   */
  deliveryZoneForArea(
    tx: Tx,
    orgId: string,
    districtId: number,
    thanaId: number,
  ): Promise<{ readonly valid: boolean; readonly zoneId: string | null }>;

  /** An order's id by its number in this brand, or undefined. */
  orderIdByNumber(tx: Tx, orgId: string, orderNo: string): Promise<string | undefined>;

  /** These orders as their shoppers may see them (D-524). Ids not of this brand are absent. */
  shopperOrders(
    tx: Tx,
    orgId: string,
    orderIds: readonly string[],
  ): Promise<readonly ShopperOrderFacts[]>;

  /** One order's lines as its shopper may see them, in their order. */
  shopperOrderLines(tx: Tx, orgId: string, orderId: string): Promise<readonly ShopperOrderLine[]>;

  /**
   * Book a validated gateway payment as a verified advance (D-526): Dr the clearing wallet /
   * Cr Customer advance, the COD lowered before the parcel moves, in the caller's transaction.
   * `applied` lowered the COD; `settled` met an order that had already ended and is owed back;
   * `held` met a parcel on the road and waits as a claim for accounts.
   */
  recordGatewayAdvance(
    tx: Tx,
    actor: { readonly orgId: string; readonly recordedBy: string; readonly decidedBy: string },
    input: GatewayAdvanceInput,
  ): Promise<{ readonly advanceId: string; readonly outcome: 'applied' | 'settled' | 'held' }>;

  /** The booked parcel's courier and codes, for the buyer (D-524). Null before booking. */
  parcelTracking(
    tx: Tx,
    orgId: string,
    orderId: string,
  ): Promise<{
    readonly courierName: string;
    readonly consignmentNo: string | null;
    readonly trackingCode: string | null;
  } | null>;

  /** The SKUs with the most units delivered in the range, most first (M24). */
  topSkus(
    tx: Tx,
    orgId: string,
    range: { readonly from: string; readonly to: string },
    limit: number,
  ): Promise<readonly TopSku[]>;
}

/** The Nest injection token for `OrdersApi`. */
export const ORDERS_API = Symbol('OrdersApi');

/**
 * A request context for a caller that has no request.
 *
 * `roles: []` and `isSuperAdmin: false` are the honest values and they are also the safe
 * ones: nothing downstream of here reads the roles to *widen* anything — the scope is
 * applied at the HTTP edge, which a worker does not go through — so an empty set can only
 * ever narrow. `requestId` is empty rather than invented, because a made-up id in the
 * audit log would look like it could be correlated with a request that never existed.
 */
function workerContext(actor: OrdersActor): ActiveContext {
  return {
    orgId: actor.orgId,
    userId: actor.userId,
    isSuperAdmin: false,
    roles: [],
    branchIds: [],
    branchIdsByRole: {},
    requestId: '',
  };
}

/** No HTTP request to stand the audit interceptor's net down for. */
const NO_REQUEST: AuditableRequest = {};

@Injectable()
export class OrdersApiService implements OrdersApi {
  constructor(
    private readonly orders: OrdersService,
    private readonly transitions: TransitionsService,
    @Inject(INVENTORY_API) private readonly inventory: InventoryApi,
    private readonly advances: AdvancesService,
    private readonly courier: CourierBookingRegistry,
  ) {}

  async createOrder(
    tx: Tx,
    actor: OrdersActor,
    input: CreateOrderInput,
    options: CreateOrderOptions = {},
  ): Promise<CreatedOrder> {
    // System-authored prices (the intake, migrated history, the preview seed): the desk's
    // discount ceiling is for people typing prices (D-364).
    return this.orders.createIn(tx, workerContext(actor), NO_REQUEST, input, {
      ...options,
      systemPricing: true,
    });
  }

  async transition(
    tx: Tx,
    actor: OrdersActor,
    orderId: string,
    trigger: OrderTrigger,
    options: MoveOptions = {},
  ): Promise<{ from: OrderStatus; to: OrderStatus }> {
    return this.orders.transitionIn(
      tx,
      workerContext(actor),
      NO_REQUEST,
      orderId,
      trigger,
      options,
    );
  }

  async summary(tx: Tx, orgId: string, orderId: string): Promise<OrderSummary | undefined> {
    const row = await repo.orderById(tx, orgId, orderId);
    if (row === undefined) return undefined;
    return {
      id: row.id,
      orderNo: row.order_no,
      status: row.status as OrderStatus,
      branchId: row.branch_id,
      customerId: row.customer_id,
      customerPhoneE164: row.customer_phone,
      codAmountPoisha: String(row.cod_amount_poisha),
      advancePaidPoisha: String(row.advance_paid_poisha),
      deliveryChargePoisha: String(row.delivery_charge_poisha),
      courierId: row.courier_id,
      locationId: row.location_id,
      deliveryZoneId: row.delivery_zone_id,
      assignedTo: row.assigned_to,
      createdBy: row.created_by,
      resellerId: row.reseller_id,
      exchangeOfOrderId: row.exchange_of_order_id,
    };
  }

  async courierParties(
    tx: Tx,
    orgId: string,
    ids: readonly string[],
  ): Promise<readonly CourierParty[]> {
    const rows = await repo.couriersByIds(tx, orgId, [...new Set(ids)]);
    return rows.map((row) => ({ id: row.id, code: row.code, name: row.name }));
  }

  async deliveryZones(tx: Tx, orgId: string): Promise<readonly DeliveryZoneSummary[]> {
    const rows = await repo.listZones(tx, orgId);
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      nameEn: row.name_en,
      nameBn: row.name_bn,
      chargePoisha: BigInt(row.charge_poisha),
      isActive: row.is_active,
    }));
  }

  async couriersByCodes(
    tx: Tx,
    orgId: string,
    codes: readonly string[],
  ): Promise<ReadonlyMap<string, CourierParty & { readonly isActive: boolean }>> {
    const rows = await repo.couriersByCodes(tx, orgId, [...new Set(codes)]);
    return new Map(
      rows.map((row) => [
        row.code,
        { id: row.id, code: row.code, name: row.name, isActive: row.is_active },
      ]),
    );
  }

  async buyerPhones(
    tx: Tx,
    orgId: string,
    phones: readonly string[],
  ): Promise<ReadonlySet<string>> {
    return new Set(await repo.existingBuyerPhones(tx, orgId, [...new Set(phones)]));
  }

  async importBuyers(
    tx: Tx,
    actor: OrdersActor,
    buyers: readonly ImportedBuyer[],
  ): Promise<number> {
    // In slices, so a brand's tens of thousands of buyers are a few hundred statements
    // rather than one statement over PostgreSQL's 65,535-parameter limit.
    const SLICE = 500;
    for (let start = 0; start < buyers.length; start += SLICE) {
      await repo.insertImportedBuyers(tx, actor.orgId, buyers.slice(start, start + SLICE));
    }
    return buyers.length;
  }

  async availability(
    tx: Tx,
    orgId: string,
    locationId: string,
    skuIds: readonly string[],
  ): Promise<Map<string, number>> {
    return this.inventory.availability(tx, orgId, locationId, skuIds);
  }

  async bookingSnapshot(
    tx: Tx,
    orgId: string,
    orderId: string,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<OrderBookingSnapshot | null> {
    const order =
      options.forUpdate === true
        ? await repo.orderForUpdate(tx, orgId, orderId)
        : await repo.orderById(tx, orgId, orderId);
    if (order === undefined) return null;

    const area = await repo.areaNames(tx, order.ship_district_id, order.ship_thana_id);
    const lines = await repo.orderLines(tx, orgId, orderId);

    return {
      orderId: order.id,
      orderNo: order.order_no,
      status: order.status as OrderStatus,
      branchId: order.branch_id,
      locationId: order.location_id,
      courierId: order.courier_id,
      codAmountPoisha: poisha(BigInt(order.cod_amount_poisha)),
      deliveryChargePoisha: poisha(BigInt(order.delivery_charge_poisha)),
      recipientName: order.ship_name,
      recipientPhoneE164: order.ship_phone_e164,
      /*
       * English names, because they are what a courier's API and a rider's phone read.
       *
       * The Bangla names exist in `ref` and are what the customer-facing documents use
       * (§22); a parcel label is neither — it is a machine-matched district and thana on
       * a third party's system, and Steadfast's own address fields are English.
       */
      district: area?.district_en ?? '',
      thana: area?.thana_en ?? '',
      area: order.ship_area,
      addressLine: order.ship_address_line,
      itemSummary: itemSummaryOf(lines),
      notes: order.notes,
    };
  }

  async statusOf(
    tx: Tx,
    orgId: string,
    orderId: string,
  ): Promise<{
    status: OrderStatus;
    branchId: string | null;
    locationId: string | null;
    courierId: string | null;
  } | null> {
    const order = await repo.orderById(tx, orgId, orderId);
    if (order === undefined) return null;
    return {
      status: order.status as OrderStatus,
      branchId: order.branch_id,
      locationId: order.location_id,
      courierId: order.courier_id,
    };
  }

  async returnableLines(
    tx: Tx,
    orgId: string,
    orderId: string,
  ): Promise<readonly ReturnableLine[]> {
    const lines = await repo.orderLines(tx, orgId, orderId);
    return lines.map((line) => ({
      skuId: line.sku_id,
      skuCode: line.sku_code,
      outstandingQty: line.qty - line.delivered_qty - line.returned_qty,
      dispatchUnitCostPoisha: poisha(BigInt(line.dispatch_unit_cost_poisha ?? '0')),
    }));
  }

  async marketingFacts(
    tx: Tx,
    orgId: string,
    period: { readonly from: string; readonly to: string },
  ): Promise<readonly MarketingOrderFact[]> {
    const rows = await repo.marketingFactRows(tx, orgId, period);
    const delivered = rows.filter((row) => row.delivered_at !== null).map((row) => row.id);
    const linesByOrder = new Map<string, repo.RevenueLineRow[]>();
    for (const line of await repo.linesForOrders(tx, orgId, delivered)) {
      const list = linesByOrder.get(line.order_id) ?? [];
      list.push(line);
      linesByOrder.set(line.order_id, list);
    }
    return rows.map((row) => {
      const source = sourceFields(row.source);
      const net = BigInt(row.items_poisha) - BigInt(row.discount_poisha);
      return {
        orderId: row.id,
        channel: row.channel,
        status: row.status as OrderStatus,
        source,
        promoCodeId: row.promo_code_id,
        confirmedAt: instant(row.confirmed_at),
        deliveredAt: instant(row.delivered_at),
        returnedAt: instant(row.returned_at),
        deliveredRevenuePoisha:
          row.delivered_at === null
            ? poisha(0n)
            : deliveredNetItems(row, linesByOrder.get(row.id) ?? []),
        placedRevenuePoisha: poisha(net > 0n ? net : 0n),
      };
    });
  }

  async conversionFacts(tx: Tx, orgId: string, orderId: string): Promise<ConversionFacts | null> {
    const order = await repo.orderById(tx, orgId, orderId);
    if (order === undefined) return null;
    const lines = await repo.orderLines(tx, orgId, orderId);
    const area = await repo.areaNames(tx, order.ship_district_id, order.ship_thana_id);
    return {
      orderId: order.id,
      customerId: order.customer_id,
      channel: order.channel,
      status: order.status as OrderStatus,
      deliveredAt: instant(order.delivered_at),
      deliveredRevenuePoisha: deliveredNetItems(order, lines),
      phoneE164: order.customer_phone,
      name: order.ship_name,
      city: area?.district_en ?? null,
      lines: lines.map((line) => ({ skuCode: line.sku_code, deliveredQty: line.delivered_qty })),
    };
  }

  async applyTrigger(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest | undefined,
    input: CourierTriggerInput,
  ): Promise<AppliedTrigger | null> {
    /*
     * Locked before the machine is asked, the same as every HTTP transition.
     *
     * Two webhooks for the same parcel arrive on two connections. Without the lock both
     * read `shipped`, both pass the domain's check, and both post the delivery journal —
     * the second one is stopped by `ledger.post`'s idempotency key, but the stock and the
     * customer counters underneath it are not idempotent. The lock makes read-decide-write
     * one unit, and the second caller then sees the moved row and falls into the no-op
     * below.
     */
    const order = await repo.orderForUpdate(tx, context.orgId, input.orderId);
    if (order === undefined) return null;

    const from = order.status as OrderStatus;
    if (transitionFor(from, input.trigger) === undefined && alreadyThere(from, input.trigger)) {
      /*
       * The duplicate. §9 has no move for this pair *because the order is already where
       * this trigger leads*, which is exactly what a retried webhook, a poll that raced a
       * webhook, or a manual status a moment before the courier's own report looks like.
       *
       * Null rather than a throw: the caller records the courier event and returns 200, so
       * the courier stops retrying. Throwing would dead-letter a delivery notification for
       * an order that is, in fact, delivered (acceptance check 3). Any *other* missing pair
       * falls through to the machine, which refuses it with its own message.
       */
      return null;
    }

    const deliveredLines = await this.deliveredLinesFor(tx, context.orgId, order, input);

    /*
     * Refusals leave here as HTTP problems, not as domain exceptions.
     *
     * The caller is another module's controller or a job, and neither can translate this
     * module's errors: `mapCourierErrors` knows `CourierError` and the ledger's codes, and a
     * domain `OrderError` passing through it became a **500** on the courier's own routes —
     * "this order cannot be delivered from pending" answered as "something went wrong on our
     * side". Mapped here because this is the module the refusal belongs to (invariant 12):
     * `mapOrderErrors` is what the orders routes already use, and an `HttpException` passes
     * through every other module's mapper untouched.
     */
    const moved = await mapOrderErrors(() =>
      this.transitions.move(
        tx,
        context,
        request ?? NO_REQUEST,
        order,
        input.trigger,
        moveOptionsFor(input, deliveredLines),
      ),
    );

    return {
      from,
      to: moved.result.to,
      businessDate: moved.result.businessDate,
      journalId: moved.journalId,
    };
  }

  async agentResults(
    tx: Tx,
    orgId: string,
    range: { readonly from: string; readonly to: string },
  ): Promise<readonly AgentDayResult[]> {
    const results = new Map<
      string,
      {
        userId: string;
        businessDate: string;
        confirmed: number;
        delivered: number;
        revenue: bigint;
      }
    >();
    const entry = (userId: string, businessDate: string) => {
      const key = `${userId}|${businessDate}`;
      let found = results.get(key);
      if (found === undefined) {
        found = { userId, businessDate, confirmed: 0, delivered: 0, revenue: 0n };
        results.set(key, found);
      }
      return found;
    };

    for (const row of await repo.confirmedCounts(tx, orgId, range.from, range.to)) {
      entry(row.user_id, row.business_date).confirmed += row.n;
    }

    const delivered = await repo.deliveredOrders(tx, orgId, range.from, range.to);
    const lines = await repo.linesOfOrders(
      tx,
      orgId,
      delivered.map((order) => order.id),
    );
    for (const order of delivered) {
      const own = lines.filter((line) => line.order_id === order.id);
      // The order-level discount only; the lines carry their own (as `TransitionsService`).
      const lineDiscounts = own.reduce((total, line) => total + BigInt(line.discount_poisha), 0n);
      const orderDiscount = BigInt(order.discount_poisha) - lineDiscounts;
      const split = computePartialDelivery({
        lines: own.map((line) => ({
          qty: line.qty,
          unitPricePoisha: poisha(BigInt(line.unit_price_poisha)),
          lineDiscountPoisha: poisha(BigInt(line.discount_poisha)),
          deliveredQty: line.delivered_qty,
        })),
        orderDiscountPoisha: poisha(orderDiscount > 0n ? orderDiscount : 0n),
        deliveryChargePoisha: poisha(BigInt(order.delivery_charge_poisha)),
      });
      const target = entry(order.user_id, order.business_date);
      target.delivered += 1;
      target.revenue += BigInt(split.deliveredNetItemsPoisha);
    }

    return [...results.values()].map((result) => ({
      userId: result.userId,
      businessDate: result.businessDate,
      confirmedOrders: result.confirmed,
      deliveredOrders: result.delivered,
      deliveredRevenuePoisha: result.revenue,
    }));
  }

  async analyticsFacts(
    tx: Tx,
    orgId: string,
    range: { readonly from: string; readonly to: string },
  ): Promise<readonly AnalyticsOrderFact[]> {
    const rows = await repo.analyticsFactRows(tx, orgId, range.from, range.to);
    const delivered = rows.filter((row) => row.delivered_on !== null).map((row) => row.id);
    const linesByOrder = new Map<string, repo.AnalyticsLineRow[]>();
    for (const line of await repo.analyticsLines(tx, orgId, delivered)) {
      const list = linesByOrder.get(line.order_id) ?? [];
      list.push(line);
      linesByOrder.set(line.order_id, list);
    }
    return rows.map((row) => {
      const lines = linesByOrder.get(row.id) ?? [];
      const cost = lines.reduce(
        (total, line) =>
          total + BigInt(line.dispatch_unit_cost_poisha ?? '0') * BigInt(line.delivered_qty),
        0n,
      );
      return {
        orderId: row.id,
        channel: row.channel,
        branchId: row.branch_id,
        createdOn: row.created_on,
        confirmedOn: row.confirmed_on,
        deliveredOn: row.delivered_on,
        returnedOn: row.returned_on,
        cancelledOn: row.cancelled_on,
        outsideDhaka: row.outside_dhaka,
        deliveredRevenuePoisha:
          row.delivered_on === null ? poisha(0n) : deliveredNetItems(row, lines),
        deliveredCostPoisha: poisha(row.delivered_on === null ? 0n : cost),
      };
    });
  }

  async buyerIdByPhone(tx: Tx, orgId: string, phoneE164: string): Promise<string | undefined> {
    return repo.buyerIdByPhone(tx, orgId, phoneE164);
  }

  async deliveryZoneForArea(
    tx: Tx,
    orgId: string,
    districtId: number,
    thanaId: number,
  ): Promise<{ readonly valid: boolean; readonly zoneId: string | null }> {
    if (!(await repo.areaExists(tx, districtId, thanaId))) return { valid: false, zoneId: null };
    const zone = await repo.zoneForArea(tx, orgId, districtId, thanaId);
    return { valid: true, zoneId: zone?.id ?? null };
  }

  async orderIdByNumber(tx: Tx, orgId: string, orderNo: string): Promise<string | undefined> {
    return repo.orderIdByNo(tx, orgId, orderNo);
  }

  async shopperOrders(
    tx: Tx,
    orgId: string,
    orderIds: readonly string[],
  ): Promise<readonly ShopperOrderFacts[]> {
    const rows = await repo.shopperOrderRows(tx, orgId, [...new Set(orderIds)]);
    return rows.map((row) => ({
      id: row.id,
      orderNo: row.order_no,
      channel: row.channel,
      status: row.status as OrderStatus,
      customerId: row.customer_id,
      createdAt: instant(row.created_at) ?? new Date(0),
      confirmedAt: instant(row.confirmed_at),
      shippedAt: instant(row.handed_over_at),
      deliveredAt: instant(row.delivered_at),
      returnedAt: instant(row.returned_at),
      cancelledAt: instant(row.cancelled_at),
      itemsPoisha: BigInt(row.items_poisha),
      discountPoisha: BigInt(row.discount_poisha),
      deliveryChargePoisha: BigInt(row.delivery_charge_poisha),
      advancePaidPoisha: BigInt(row.advance_paid_poisha),
      codAmountPoisha: BigInt(row.cod_amount_poisha),
      courierId: row.courier_id,
      lineCount: row.line_count,
      unitCount: row.unit_count,
      shipTo: {
        name: row.ship_name,
        phoneE164: row.ship_phone_e164,
        districtId: row.ship_district_id,
        thanaId: row.ship_thana_id,
        districtEn: row.district_en,
        districtBn: row.district_bn,
        thanaEn: row.thana_en,
        thanaBn: row.thana_bn,
        area: row.ship_area,
        addressLine: row.ship_address_line,
      },
    }));
  }

  async shopperOrderLines(
    tx: Tx,
    orgId: string,
    orderId: string,
  ): Promise<readonly ShopperOrderLine[]> {
    const lines = await repo.orderLines(tx, orgId, orderId);
    return lines.map((line) => ({
      id: line.id,
      skuId: line.sku_id,
      skuCode: line.sku_code,
      productName: line.product_name,
      qty: line.qty,
      unitPricePoisha: BigInt(line.unit_price_poisha),
      discountPoisha: BigInt(line.discount_poisha),
    }));
  }

  async recordGatewayAdvance(
    tx: Tx,
    actor: { readonly orgId: string; readonly recordedBy: string; readonly decidedBy: string },
    input: GatewayAdvanceInput,
  ): Promise<{ readonly advanceId: string; readonly outcome: 'applied' | 'settled' | 'held' }> {
    return mapOrderErrors(() => this.advances.recordGatewayAdvance(tx, actor, input));
  }

  async parcelTracking(
    tx: Tx,
    orgId: string,
    orderId: string,
  ): Promise<{
    courierName: string;
    consignmentNo: string | null;
    trackingCode: string | null;
  } | null> {
    const courier = this.courier.current();
    if (courier === undefined) return null;
    const parcel = await courier.parcelTracking(tx, orgId, orderId);
    if (parcel === null) return null;
    const [party] = await repo.couriersByIds(tx, orgId, [parcel.courierId]);
    return {
      courierName: party?.name ?? '',
      consignmentNo: parcel.consignmentNo,
      trackingCode: parcel.trackingCode,
    };
  }

  async topSkus(
    tx: Tx,
    orgId: string,
    range: { readonly from: string; readonly to: string },
    limit: number,
  ): Promise<readonly TopSku[]> {
    const rows = await repo.topSkus(tx, orgId, range.from, range.to, limit);
    return rows.map((row) => ({
      skuId: row.sku_id,
      skuCode: row.sku_code,
      productName: row.product_name,
      units: row.units,
    }));
  }

  /**
   * What a courier's partial delivery means when it names no lines.
   *
   * A courier reports money and a status; most of them cannot report which SKUs the buyer
   * kept. §9's partial delivery needs per-line quantities — the desk's own
   * partial-delivery route makes the warehouse supply them — so a webhook that says
   * "partially delivered, ৳2,400 collected" with no lines would otherwise be read as
   * *nothing* delivered, and `computePartialDelivery` refuses that as a return.
   *
   * Refusing is the wrong answer here: the parcel is at the buyer's door and the money is
   * in the rider's hand. So a partial with no line detail is taken as "every outstanding
   * unit arrived, and the collection was short" — the short amount lands on Sales
   * discounts through `orderDeliveredDraft`'s difference branch, which is exactly what a
   * haggled COD is. A genuinely partial *parcel* comes back to the warehouse, is inspected
   * there, and reaches this module through `receive_return` with real quantities.
   */
  private async deliveredLinesFor(
    tx: Tx,
    orgId: string,
    order: repo.OrderRow,
    input: CourierTriggerInput,
  ): Promise<readonly { skuId: string; deliveredQty: number }[] | undefined> {
    if (input.deliveredLines !== undefined) return input.deliveredLines;
    const entry = transitionFor(order.status as OrderStatus, input.trigger);
    if (entry?.effects.includes('post_partial_revenue') !== true) return undefined;

    const lines = await repo.orderLines(tx, orgId, order.id);
    return lines
      .map((line) => ({
        skuId: line.sku_id,
        deliveredQty: line.qty - line.delivered_qty - line.returned_qty,
      }))
      .filter((line) => line.deliveredQty > 0);
  }
}

/**
 * Whether this trigger's destination is where the order already is.
 *
 * Read off the domain's own transition table rather than listed here, so a new row in §9
 * cannot leave a status that a retried webhook would start throwing on.
 */
function alreadyThere(status: OrderStatus, trigger: OrderTrigger): boolean {
  return TRANSITIONS.some((entry) => entry.trigger === trigger && entry.to === status);
}

/** The courier's input in the shape `TransitionsService` takes. */
function moveOptionsFor(
  input: CourierTriggerInput,
  deliveredLines: readonly { skuId: string; deliveredQty: number }[] | undefined,
): MoveOptions {
  const deliver =
    input.collectedPoisha === undefined && deliveredLines === undefined
      ? undefined
      : {
          ...(input.collectedPoisha === undefined
            ? {}
            : { collectedPoisha: input.collectedPoisha.toString() }),
          ...(input.differenceReason === undefined
            ? {}
            : { differenceReason: input.differenceReason }),
          ...(input.typedByPerson === true ? { shortfallNeedsReason: true as const } : {}),
          ...(deliveredLines === undefined ? {} : { lines: deliveredLines }),
          occurredAt: input.occurredAt,
        };

  return {
    reason: input.reason ?? null,
    returnReason: input.returnReason ?? null,
    occurredAt: input.occurredAt,
    ...(deliver === undefined ? {} : { deliver }),
    ...(input.returnReceipt === undefined
      ? {}
      : {
          ret: {
            // §9 marks the return transitions `requiresReason`, and the courier module
            // always sends one; the fallback exists so a missing reason is a sentence in
            // the audit log rather than a refusal three layers down.
            reason: input.reason ?? 'Returned through the courier.',
            occurredAt: input.occurredAt,
            receipt: input.returnReceipt,
          },
        }),
  };
}

/**
 * What goes on the parcel label as a description.
 *
 * Quantities and product names, never a price and never a cost: a courier's rider carries
 * this to a customer's door, and §21's parcel description is for identifying the box.
 * Truncated, because a ten-line order would otherwise fill a third party's column and be
 * cut off wherever they chose.
 */
function itemSummaryOf(lines: readonly repo.OrderLineRow[]): string | null {
  if (lines.length === 0) return null;
  const summary = lines.map((line) => `${line.product_name} ×${String(line.qty)}`).join(', ');
  return summary.length <= 200 ? summary : `${summary.slice(0, 197)}...`;
}

/** A timestamp column as a `Date`, whichever form the driver handed back. */
function instant(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

/** §9's `source` block, reduced to the three fields §11's attribution reads. */
function sourceFields(source: unknown): MarketingOrderFact['source'] {
  const record =
    typeof source === 'object' && source !== null ? (source as Record<string, unknown>) : {};
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
  return {
    campaignId: text(record.campaignId),
    adId: text(record.adId),
    utmCampaign: text(record.utmCampaign),
  };
}
