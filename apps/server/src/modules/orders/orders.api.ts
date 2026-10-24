import { Inject, Injectable } from '@nestjs/common';
import type { CallAttemptInput, CourierBookingPolicy } from '@elysium/contracts';
import type {
  CustomerAddressInput,
  CustomerCardView,
  CustomerDetailsInput,
  CustomerGender,
  CustomerPhoneAddInput,
  CustomerPhoneRetireInput,
  CustomerPhoneUpdateInput,
} from '@elysium/contracts/customers';
import type { RequestContext, Tx } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';
import {
  CALLABLE_STATUSES,
  computePartialDelivery,
  formatOrderNo,
  OrderError,
  orderPrefixFor,
  parcelWeightGrams,
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
import { returnRateBps } from '@elysium/domain/analytics';
import { parseOrderScanCode } from '@elysium/domain/packing';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import { AdvancesService } from './advances.service.js';
import { CustomersService } from './customers.service.js';
import { CustomerNumbersService } from './numbers.service.js';
import { OffersService, type WorkflowSettings } from './offers.service.js';
import { OrdersService, type CreateOrderOptions, type CreatedOrder } from './orders.service.js';
import { CourierBookingRegistry } from './ports/courier-booking.port.js';
import { DocumentsService } from './documents.service.js';
import type { DocumentPaper } from './order-documents.js';
import { TransitionsService, type MoveOptions } from './transitions.service.js';
import { mapOrderErrors, OrdersError } from './orders.errors.js';
import * as repo from './orders.repository.js';
import { deliveredNetItems } from './revenue.js';
import type { CreateOrderInput, UpdateOrderInput } from './orders.schemas.js';
import * as references from './references.repository.js';
import { buyerReachScopeFor, orderReadScopeFor } from './orders.scope.js';
import { peopleOnPhone, pickPersonByPhone } from './numbers.helpers.js';
import * as numbers from './numbers.repository.js';

/** How many of a buyer's newest orders the caller panel reads addresses from (D-860). */
const CALLER_PANEL_RECENT_ORDERS = 20;

/** How many other phones the caller panel lists. */
const CALLER_PANEL_OTHER_PHONES = 10;

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
  /**
   * Σ qty × weight in grams (M39b, D-645), or null when any line's variant has no weight:
   * the courier then declares its configured default.
   */
  readonly weightGrams: number | null;
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
  /**
   * Money the gateway took that the order does not accept (M34 ledger audit W3): a wrong
   * amount, an order changed after its page opened, a second page paid. Booked into the
   * clearing wallet all the same — the gateway settles it to the bank — and owed back at once,
   * never applied to the COD.
   */
  readonly owedBack?: boolean;
}

/** A campaign and its refs by kind, as attribution matches an order's source to it (§11). */
export interface CampaignMatch {
  readonly id: string;
  /** `meta_campaign` refs: an order's `campaignId` may carry one instead of the uuid. */
  readonly metaCampaignIds: readonly string[];
  readonly metaAdIds: readonly string[];
  /** `utm_campaign` refs, lower-cased as `marketing.campaign_refs` stores them. */
  readonly utmCampaigns: readonly string[];
}

/** One line as a packer picks it (M35b, D-554): what to put in the box, never a cost. */
export interface PackingLine {
  readonly skuId: string;
  readonly skuCode: string;
  readonly productName: string;
  readonly qty: number;
  readonly returnedQty: number;
  /** The selling price charged, for a label's price rows. */
  readonly unitPricePoisha: bigint;
}

/** An order's status and when it reached it (M38b, D-612). */
export interface OrderRetentionFacts {
  readonly orderId: string;
  readonly status: OrderStatus;
  readonly statusSince: Date | null;
}

/** An order as packing sees it (M35b: the scanner and the order labels, D-554, D-555). */
export interface PackingFacts {
  readonly id: string;
  readonly orderNo: string;
  readonly channel: string;
  readonly status: OrderStatus;
  readonly createdAt: Date;
  readonly notes: string | null;
  /** The scope columns: who may see the order (§6). */
  readonly branchId: string | null;
  readonly createdBy: string;
  readonly assignedTo: string | null;
  /** M46: the stock location it ships from (the hub's), and when its slip or label printed. */
  readonly locationId: string | null;
  readonly slipPrintedAt: Date | null;
  readonly itemsPoisha: bigint;
  readonly discountPoisha: bigint;
  readonly deliveryChargePoisha: bigint;
  readonly advancePaidPoisha: bigint;
  readonly codAmountPoisha: bigint;
  readonly recipient: {
    readonly name: string;
    /** E.164, in full: the rider calls it. Never logged (invariant 10). */
    readonly phoneE164: string;
    readonly districtEn: string | null;
    readonly districtBn: string | null;
    readonly thanaEn: string | null;
    readonly thanaBn: string | null;
    readonly area: string | null;
    readonly addressLine: string;
  };
  readonly parcel: {
    readonly courierName: string;
    readonly consignmentNo: string | null;
    readonly trackingCode: string | null;
  } | null;
  /** The order's own courier, booked or not (D-904: the courier portal counts by it). */
  readonly courierName: string | null;
  readonly lines: readonly PackingLine[];
}

export interface OrdersApi {
  /**
   * Orders whose recorded source names a campaign as §11's attribution reads it (M39a,
   * D-632): marketing keeps such a campaign rather than orphan their attribution.
   */
  ordersAttributedTo(tx: Tx, orgId: string, campaign: CampaignMatch): Promise<number>;

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
   * The courier party with this code, made when the brand has none and switched back on when it
   * was off (D-913): Settings → Couriers connects a courier by its code. In the caller's
   * transaction; the caller's audit row names it.
   */
  ensureCourierParty(
    tx: Tx,
    orgId: string,
    party: { readonly code: string; readonly name: string },
  ): Promise<CourierParty & { readonly created: boolean }>;

  /**
   * The brand's default courier (§9, D-913): the one every active delivery zone names as its
   * default, which is what a new order is given. Null when the zones name different couriers,
   * or none, or there are no active zones.
   */
  defaultCourierId(tx: Tx, orgId: string): Promise<string | null>;

  /**
   * The zones' default couriers, summed up for Settings → Couriers (§9, D-913): the one every
   * active zone names (null when they disagree or name none), whether the active zones name
   * different couriers (a zone naming none counts as one of them), and how many are active.
   */
  defaultCourierState(
    tx: Tx,
    orgId: string,
  ): Promise<{
    readonly courierId: string | null;
    readonly mixed: boolean;
    readonly activeZones: number;
  }>;

  /**
   * Make this courier the brand's default (D-913): every delivery zone's default courier
   * becomes it, so each new order is given it. In the caller's transaction, unaudited here;
   * the caller audits it. The zones are locked first, so two changes at once are one after
   * the other, never interleaved. Answers the zones' defaults before the change.
   */
  setDefaultCourier(
    tx: Tx,
    orgId: string,
    courierId: string,
  ): Promise<{
    readonly before: readonly {
      readonly zoneCode: string;
      readonly courierId: string | null;
      readonly isActive: boolean;
    }[];
  }>;

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
   * spent — and its phone as the buyer's rank-1 own number (M48). A phone some buyer already
   * uses, or one twice in the batch, is refused (`CUSTOMER_PHONE_INVALID`) rather than merged,
   * which rolls the whole import back; the importer skips those before calling.
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

  /**
   * The buyer this E.164 phone names, or undefined: per-buyer discount limits (D-541). M48
   * (D-876): one number may be several people's, and this is the automatic pick among them (the
   * person whose primary own number it is, else whoever ordered last). A screen with a person in
   * front of it asks `buyerCandidates` instead.
   */
  buyerIdByPhone(tx: Tx, orgId: string, phoneE164: string): Promise<string | undefined>;

  // --- M48: customer numbers and people (D-870 to D-889) -------------------------------------

  /**
   * Everyone an E.164 number names now, the automatic pick first (D-875): each with the number's
   * rank, kind and relation on them, the staff's note and their last order. No scope: the caller
   * decides who may see whom (the caller panel shows them to whoever sees the whole panel).
   */
  buyerCandidates(tx: Tx, orgId: string, phoneE164: string): Promise<readonly BuyerCandidateFact[]>;

  /** The automatic pick for a number, and whether it had to choose among several (D-876). */
  pickBuyerByPhone(
    tx: Tx,
    orgId: string,
    phoneE164: string,
  ): Promise<{ readonly customerId: string; readonly shared: boolean } | undefined>;

  /** A buyer's numbers in use, by rank, with the staff's notes (the caller panel's list). */
  customerNumbers(
    tx: Tx,
    orgId: string,
    customerId: string,
  ): Promise<readonly CustomerNumberFact[]>;

  /** Whether the buyer uses this number now (a Call to one of their numbers, D-834). */
  customerUsesPhone(tx: Tx, orgId: string, customerId: string, phoneE164: string): Promise<boolean>;

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

  /**
   * Whether the caller may see this order (M34 ledger audit W6): the route's own row scope,
   * declared on `Order` and hung on the request by the guard, applied here where the order's
   * columns are known. Marks the scope applied.
   */
  orderVisibleTo(tx: Tx, orgId: string, orderId: string, request: object): Promise<boolean>;

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

  // --- M35b: the marketplace and packing ----------------------------------------------

  /**
   * Change an order a server handed over and then changed (M35b: ncom.bd, D-556), through the
   * desk's own edit (`OrdersService.editIn`) in the caller's transaction: the same rules on
   * what may still change, no person's scope and no agent's discount ceiling. Refuses with
   * `ORDER_IMMUTABLE` once the order is past `on_hold`.
   */
  editOrder(tx: Tx, actor: OrdersActor, orderId: string, patch: UpdateOrderInput): Promise<void>;

  /**
   * The orders a scanned code names (M35b, D-554): its order number or its ten digits (D-912),
   * else a parcel's consignment number or tracking code. Newest first; empty when nothing
   * matches.
   */
  orderIdsForShipmentCode(tx: Tx, orgId: string, code: string): Promise<readonly string[]>;

  /**
   * The orders an order's own code names, never a courier's (D-912): its order number, else its
   * ten digits under the brand's prefix now, else under any prefix (one renamed since). What a
   * lot's code names its order by. Newest first; empty when nothing matches.
   */
  orderIdsForOrderCode(tx: Tx, orgId: string, code: string): Promise<readonly string[]>;

  /** These orders as packing sees them; ids not of this brand are absent. */
  packingFacts(
    tx: Tx,
    orgId: string,
    orderIds: readonly string[],
  ): Promise<readonly PackingFacts[]>;

  /**
   * When the brand books the courier (§9's `orders.courier_booking`, D-901), `manual` until
   * chosen: the Labels page says when that means no label prints by itself (D-908).
   */
  courierBooking(tx: Tx, orgId: string): Promise<CourierBookingPolicy>;

  // --- M38b: the packing station and the packing video ---------------------------------

  /**
   * Each order's status and when it reached it (the latest history row into that status),
   * for the packing video's retention (D-612). Ids not of this brand are absent.
   */
  retentionFacts(
    tx: Tx,
    orgId: string,
    orderIds: readonly string[],
  ): Promise<readonly OrderRetentionFacts[]>;

  /**
   * Of these orders, the ones the caller may see under the route's own declared scope (hung
   * on the request by the guard, as `orderVisibleTo`). Marks the scope applied.
   */
  visibleOrderIds(
    tx: Tx,
    orgId: string,
    orderIds: readonly string[],
    request: object,
  ): Promise<ReadonlySet<string>>;

  /**
   * The condition "the order `orderId` names is one the caller may see", under the route's
   * own declared scope, for another module to put in the WHERE of a query over its own rows
   * (M38b audit: the packing station's recent list pages by the order's scope instead of
   * filtering the newest N afterwards). The SQL about `sales.orders` is written here, by its
   * owner; the caller only embeds it (invariant 12). Marks the scope applied. With `statuses`,
   * the order must also be in one of them (D-914: "Ready for label" pages by confirmed orders).
   */
  orderInScopeSql(
    orgId: string,
    orderId: SQL,
    request: object,
    statuses?: readonly OrderStatus[],
  ): SQL;

  /** The SKUs with the most units delivered in the range, most first (M24). */
  topSkus(
    tx: Tx,
    orgId: string,
    range: { readonly from: string; readonly to: string },
    limit: number,
  ): Promise<readonly TopSku[]>;

  // --- M42: the inbox's customer panel (D-740 to D-742) --------------------------------------

  /**
   * A buyer as the inbox's customer panel shows them (D-740), by the buyer profile's rule: the
   * brand-wide counters (what the buyer is to the brand, naming no agent's order) and the most
   * recent orders **the viewer may open** (`read Order`, with the sales queue), each as number,
   * status, channel, COD and date. No address and nothing near a cost. Undefined for a buyer
   * not of this brand.
   */
  customerPanel(
    tx: Tx,
    orgId: string,
    customerId: string,
    recentLimit: number,
    viewer: RequestContext,
  ): Promise<CustomerPanelFacts | undefined>;

  /**
   * Whether the viewer may open this buyer at all, by `GET /v1/customers/:id`'s rule: everyone
   * with an org-wide grant; otherwise a buyer with an order in the viewer's `read Customer` scope
   * ("customers of own orders") or in the sales queue, or with no orders yet (D-740, D-725). The
   * inbox links a typed phone to a buyer only then.
   */
  customerReachable(
    tx: Tx,
    orgId: string,
    customerId: string,
    viewer: RequestContext,
  ): Promise<boolean>;

  /** The buyer an order is for, and the inbox conversation it was taken from (D-742). */
  inboxOrigin(tx: Tx, orgId: string, orderId: string): Promise<InboxOrderOrigin | undefined>;

  /**
   * Units available to promise at the order desk's own location (the brand's default
   * fulfilment location), for the inbox's "sizes in stock" (D-741). Empty for a brand that has
   * no location yet, rather than a refusal: the panel then shows no sizes in stock.
   */
  deskAvailability(tx: Tx, orgId: string, skuIds: readonly string[]): Promise<Map<string, number>>;

  // --- D-748: the inbox's auto-offer, on the brand's one switch ----------------------------

  /**
   * The brand's order workflow settings (M41, D-715): whether it auto-assigns, the seconds an
   * offer stays open and the most open work per person. The inbox offers conversations on the
   * same switch, with the same countdown and the same cap per kind (D-748).
   */
  workflowSettings(tx: Tx, orgId: string): Promise<WorkflowSettings>;

  // --- M46: Labels and Packaging (D-811, D-819) ------------------------------------------

  /**
   * An order's slip or label for the print queue, for one lot of several or the whole order:
   * the page's HTML, its fonts and logo, and the paper it is drawn on. Its own short transaction
   * and then the logo, so the caller holds none (invariant 6); no person's scope (the brand's
   * own queue). Refuses `ORDER_NOT_FOUND` for an order not of this brand.
   */
  documentForPrint(input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly kind: 'label' | 'packing_slip';
    readonly lot: { readonly no: number; readonly count: number } | null;
    readonly paper: DocumentPaper;
  }): Promise<{
    readonly html: string;
    readonly assets: readonly {
      readonly filename: string;
      readonly bytes: Uint8Array;
      readonly contentType: string;
    }[];
    readonly orderNo: string;
    readonly widthMm: number;
    readonly heightMm: number;
    readonly marginMm: number;
  }>;

  /**
   * The hub printed these confirmed orders' slip or label (D-819): they move from M41's "To
   * print" to "Packing", as the hub's Print slips does. The first print counts; ids of other
   * brands or other statuses change nothing. Returns the orders marked now.
   */
  markSlipsPrinted(tx: Tx, orgId: string, orderIds: readonly string[]): Promise<readonly string[]>;

  // --- M47: phone calls through Envo (D-834, D-835, D-838) -------------------------------------

  /**
   * The order a person calls about through Envo, locked in their own desk scope (their `update
   * Order`, widened by what sales reads, as a verification call's lock: D-725) and through M41's
   * owner gate for the act `call`: a colleague's order needs `x-acknowledge-owner: 1`, and is then
   * audited and its owner told (D-710). Any status: a buyer is called after delivery too. Refuses
   * (as problem+json) an order the caller cannot reach and an unacknowledged owner.
   */
  phoneCallTarget(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    orderId: string,
  ): Promise<PhoneCallTarget>;

  /**
   * M41's verification attempt for a phone call about an order (D-838), in the caller's
   * transaction under the same lock and gate as `phoneCallTarget`, with M41's own rules (the
   * statuses whose calls are over, a call-back time) and audit row. The attempt's id.
   */
  recordPhoneCallOutcome(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    orderId: string,
    input: CallAttemptInput,
  ): Promise<{ readonly attemptId: string; readonly outcome: string }>;

  /**
   * A buyer's newest orders still open (not delivered, returned or cancelled), brand-wide, for
   * linking a call Envo told us about to the order it is probably about (D-835). No scope: the
   * worker links, and who may see the call is the call's own scope.
   */
  openOrdersOfCustomer(
    tx: Tx,
    orgId: string,
    customerId: string,
    limit: number,
  ): Promise<readonly OpenOrderFact[]>;

  /**
   * Whether M41 can still log a verification call on this order (`CALLABLE_STATUSES`), for a
   * wrap-up deciding whether to record the attempt (D-859). False for an order not of this brand.
   */
  phoneCallOrderCallable(tx: Tx, orgId: string, orderId: string): Promise<boolean>;

  // --- M47: the caller panel (D-860) ------------------------------------------------------------

  /**
   * A buyer as the caller panel shows them: the brand-wide counters with the return rate, what
   * they spent, their first and last order, tags, RFM segment and the pinned note (who wrote it
   * and when). No address and nothing near a cost. Undefined for a buyer not of this brand.
   */
  callerCustomer(
    tx: Tx,
    orgId: string,
    customerId: string,
  ): Promise<CallerCustomerFacts | undefined>;

  /**
   * One page of all the buyer's orders the viewer may open (`orderReadScopeFor`, with the sales
   * queue), newest first; `cursor` is the previous page's `nextCursor` (a malformed one is refused
   * as `VALIDATION_FAILED`, problem+json).
   */
  customerOrdersPage(
    tx: Tx,
    orgId: string,
    customerId: string,
    viewer: RequestContext,
    page: { readonly limit: number; readonly cursor: string | null },
  ): Promise<{ readonly items: readonly CustomerOrderFact[]; readonly nextCursor: string | null }>;

  /**
   * The buyer's saved addresses (the default first), then the distinct addresses their twenty
   * newest orders went to, with district and thana names (D-860 revises D-740 for this panel).
   */
  customerAddresses(
    tx: Tx,
    orgId: string,
    customerId: string,
  ): Promise<readonly CustomerAddressFact[]>;

  /** The distinct recipient phones (E.164) on the buyer's orders other than theirs, newest first. */
  customerOtherPhones(tx: Tx, orgId: string, customerId: string): Promise<readonly string[]>;

  /**
   * Pin `body` (trimmed; empty clears) on the buyer, stamped with the caller and the time, and
   * audit `customer.note_pinned` with the lengths only (invariant 10), in the caller's
   * transaction. The caller has already decided who may (telephony's caller panel rule, D-863);
   * no such buyer is `CUSTOMER_NOT_FOUND` (problem+json). The note now pinned, or null.
   */
  setPinnedNote(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    customerId: string,
    body: string,
  ): Promise<PinnedNoteFact | null>;

  // --- M49: the inbox's customer card (D-890 to D-895) ---------------------------------------

  /**
   * The buyer as the inbox's customer card shows and edits them: the details, every number with
   * the staff's notes (in use and retired), the address book, the segment and the pinned note (who
   * wrote it as an id). Undefined for a buyer not of this brand. No scope: the inbox decides who
   * may, through the conversation the buyer is linked to (D-890), as the caller panel does.
   */
  customerCard(tx: Tx, orgId: string, customerId: string): Promise<CustomerCardFacts | undefined>;

  /**
   * The writes behind the card, each in the caller's transaction, audited as the buyer page's own
   * (`customer.updated`, `customer.phone_*`, `customer.address_*`) and refused on a merged record.
   * The caller has decided who may (D-890); the inputs are the contracts' (`customers.ts`).
   */
  updateCustomerDetails(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    customerId: string,
    patch: CustomerDetailsInput,
  ): Promise<void>;
  addCustomerPhone(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    customerId: string,
    input: CustomerPhoneAddInput,
  ): Promise<void>;
  updateCustomerPhone(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    customerId: string,
    phoneId: string,
    input: CustomerPhoneUpdateInput,
  ): Promise<void>;
  retireCustomerPhone(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    customerId: string,
    phoneId: string,
    input: CustomerPhoneRetireInput,
  ): Promise<void>;
  addCustomerAddress(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    customerId: string,
    input: CustomerAddressInput,
  ): Promise<void>;
  replaceCustomerAddress(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    customerId: string,
    addressId: string,
    input: CustomerAddressInput,
  ): Promise<void>;
  removeCustomerAddress(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    customerId: string,
    addressId: string,
  ): Promise<void>;

  /**
   * Save a chat's person as a buyer (the inbox's Save as customer, D-892): their name and number,
   * the number theirs and noted as from the chat. `newPerson` makes a new record even when the
   * number is already someone's (a relative on the same phone); otherwise the number's automatic
   * pick is answered and nothing is created. Audited `customer.created` when made.
   */
  saveChatCustomer(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    input: {
      readonly name: string;
      readonly phoneE164: string;
      readonly newPerson: boolean;
      readonly address?: {
        readonly districtId: number;
        readonly thanaId: number;
        readonly area?: string | undefined;
        readonly addressLine: string;
      };
    },
  ): Promise<{ readonly id: string; readonly created: boolean }>;
}

/** M49 (D-890): the inbox's customer card, with the pinned note's author as an id. */
export interface CustomerCardFacts extends Omit<CustomerCardView, 'pinnedNote'> {
  readonly pinnedNote: PinnedNoteFact | null;
}

/** M47 (D-860): a buyer as the caller panel shows them. No address, nothing near a cost. */
export interface CallerCustomerFacts {
  readonly id: string;
  readonly name: string;
  readonly phoneE164: string;
  readonly tags: readonly string[];
  /** The buyer's RFM segment (M16), or null before the nightly job has scored them. */
  readonly segment: string | null;
  readonly orders: number;
  readonly delivered: number;
  readonly returned: number;
  readonly cancelled: number;
  /** Returned ÷ (delivered + returned) in basis points (`returnRateBps`); null before either. */
  readonly returnRateBps: number | null;
  /** What they have spent on delivered orders (`ltv_poisha`), integer poisha. */
  readonly spentPoisha: bigint;
  readonly firstOrderAt: Date | null;
  readonly lastOrderAt: Date | null;
  readonly pinnedNote: PinnedNoteFact | null;
}

/** M48 (D-875): one person a number names. */
export interface BuyerCandidateFact {
  readonly customerId: string;
  readonly name: string;
  readonly rank: number;
  readonly kind: string;
  readonly relation: string;
  readonly note: string | null;
  readonly lastOrderAt: Date | null;
  readonly orders: number;
  /** The automatic pick among them (D-876). */
  readonly suggested: boolean;
}

/** M48 (D-870): one of a buyer's numbers in use. */
export interface CustomerNumberFact {
  readonly id: string;
  readonly phoneE164: string;
  readonly rank: number;
  readonly kind: string;
  readonly relation: string;
  readonly note: string | null;
}

/** M47 (D-860): the note pinned on a buyer, with who wrote it and when. */
export interface PinnedNoteFact {
  readonly body: string;
  readonly byUserId: string;
  readonly at: Date;
}

/** M47 (D-860): one of a buyer's orders in the caller panel. */
export interface CustomerOrderFact {
  readonly id: string;
  readonly orderNo: string;
  readonly status: OrderStatus;
  /** The COD the order screens show, integer poisha as a string. */
  readonly codAmountPoisha: string;
  readonly createdAt: Date;
}

/** M47 (D-860): a buyer's address, saved or one an order of theirs went to. */
export interface CustomerAddressFact {
  readonly source: 'saved' | 'order';
  readonly label: string | null;
  readonly districtName: string | null;
  readonly thanaName: string | null;
  readonly area: string | null;
  readonly addressLine: string;
  readonly isDefault: boolean;
}

/** M47: what a phone call needs about the order it is about. No cost. */
export interface PhoneCallTarget {
  readonly orderId: string;
  readonly orderNo: string;
  readonly status: OrderStatus;
  readonly customerId: string;
  /** E.164: the buyer's phone, and the recipient's on this order. */
  readonly customerPhoneE164: string;
  readonly recipientPhoneE164: string;
  readonly assignedTo: string | null;
}

/** M47: an open order of a buyer, for linking a call to it. */
export interface OpenOrderFact {
  readonly id: string;
  readonly orderNo: string;
  readonly status: OrderStatus;
  readonly assignedTo: string | null;
  readonly createdAt: Date;
}

/** M42 (D-740): the inbox panel's view of a buyer. */
export interface CustomerPanelFacts {
  readonly id: string;
  readonly name: string;
  readonly phoneE164: string;
  readonly orders: number;
  readonly delivered: number;
  readonly returned: number;
  readonly cancelled: number;
  /** What they have spent on delivered orders (`ltv_poisha`), integer poisha. */
  readonly spentPoisha: bigint;
  readonly lastOrderAt: Date | null;
  readonly recentOrders: readonly {
    readonly id: string;
    readonly orderNo: string;
    readonly status: OrderStatus;
    readonly channel: string;
    readonly codAmountPoisha: string;
    readonly createdAt: Date;
  }[];
}

/** M42 (D-742): where an order came from, as far as the inbox cares. */
export interface InboxOrderOrigin {
  readonly customerId: string;
  readonly customerPhoneE164: string;
  /** `source.inboxConversationId`, when the order was created from a chat. */
  readonly inboxConversationId: string | null;
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
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    private readonly offers: OffersService,
    private readonly documents: DocumentsService,
    // M47 (D-860): the pinned note's audit row, in the caller's transaction.
    private readonly audit: AuditService,
    // M49 (D-890): the inbox's customer card writes through the buyer page's own logic.
    private readonly customers: CustomersService,
    private readonly numbersService: CustomerNumbersService,
  ) {}

  // --- M49: the inbox's customer card (D-890 to D-895) ----------------------------------------

  async customerCard(
    tx: Tx,
    orgId: string,
    customerId: string,
  ): Promise<CustomerCardFacts | undefined> {
    const [row, caller] = await Promise.all([
      repo.customerById(tx, orgId, customerId),
      repo.callerCustomerById(tx, orgId, customerId),
    ]);
    if (row === undefined || caller === undefined) return undefined;
    const facts = callerCustomerFacts(caller);
    const [phones, addresses] = await Promise.all([
      this.numbersService.viewsOf(tx, orgId, customerId),
      this.customers.addressViews(tx, orgId, customerId),
    ]);
    return {
      id: row.id,
      name: row.name,
      phone: row.phone_e164,
      email: row.email,
      gender: isGender(row.gender) ? row.gender : null,
      ageBand: row.age_band,
      profession: row.profession,
      birthday: row.birthday,
      anniversary: row.anniversary,
      tags: facts.tags,
      notes: row.notes,
      segment: facts.segment,
      phones,
      addresses,
      pinnedNote: facts.pinnedNote,
    };
  }

  async updateCustomerDetails(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    customerId: string,
    patch: CustomerDetailsInput,
  ): Promise<void> {
    await mapOrderErrors(() => this.customers.updateIn(tx, context, request, customerId, patch));
  }

  async addCustomerPhone(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    customerId: string,
    input: CustomerPhoneAddInput,
  ): Promise<void> {
    await mapOrderErrors(() =>
      this.numbersService.addIn(tx, context, request, customerId, input, 'decided'),
    );
  }

  async updateCustomerPhone(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    customerId: string,
    phoneId: string,
    input: CustomerPhoneUpdateInput,
  ): Promise<void> {
    await mapOrderErrors(() =>
      this.numbersService.updateIn(tx, context, request, customerId, phoneId, input, 'decided'),
    );
  }

  async retireCustomerPhone(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    customerId: string,
    phoneId: string,
    input: CustomerPhoneRetireInput,
  ): Promise<void> {
    await mapOrderErrors(() =>
      this.numbersService.retireIn(tx, context, request, customerId, phoneId, input, 'decided'),
    );
  }

  async addCustomerAddress(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    customerId: string,
    input: CustomerAddressInput,
  ): Promise<void> {
    await mapOrderErrors(() =>
      this.customers.addAddressIn(tx, context, request, customerId, input),
    );
  }

  async replaceCustomerAddress(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    customerId: string,
    addressId: string,
    input: CustomerAddressInput,
  ): Promise<void> {
    await mapOrderErrors(() =>
      this.customers.replaceAddressIn(tx, context, request, customerId, addressId, input),
    );
  }

  async removeCustomerAddress(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    customerId: string,
    addressId: string,
  ): Promise<void> {
    await mapOrderErrors(() =>
      this.customers.removeAddressIn(tx, context, request, customerId, addressId),
    );
  }

  async saveChatCustomer(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    input: Parameters<OrdersApi['saveChatCustomer']>[3],
  ): Promise<{ readonly id: string; readonly created: boolean }> {
    return mapOrderErrors(async () => {
      const saved = await this.customers.createIn(
        tx,
        context,
        request,
        {
          phone: input.phoneE164,
          name: input.name,
          newPerson: input.newPerson,
          phoneRelation: 'own',
          ...(input.address === undefined ? {} : { address: input.address }),
        },
        { source: 'inbox' },
      );
      return { id: saved.id, created: saved.created };
    });
  }

  workflowSettings(tx: Tx, orgId: string): Promise<WorkflowSettings> {
    return this.offers.settingsIn(tx, orgId);
  }

  documentForPrint(input: Parameters<OrdersApi['documentForPrint']>[0]) {
    return mapOrderErrors(() => this.documents.documentForPrint(input));
  }

  async markSlipsPrinted(
    tx: Tx,
    orgId: string,
    orderIds: readonly string[],
  ): Promise<readonly string[]> {
    const ids = [...new Set(orderIds)].sort();
    const marked = await repo.markSlipsPrinted(tx, orgId, ids, sql`true`);
    return marked.map((row) => row.id);
  }

  async phoneCallTarget(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    orderId: string,
  ): Promise<PhoneCallTarget> {
    return mapOrderErrors(async () => {
      const order = await this.orders.lockForPhoneCall(tx, context, request, orderId);
      return {
        orderId: order.id,
        orderNo: order.order_no,
        status: order.status as OrderStatus,
        customerId: order.customer_id,
        customerPhoneE164: order.customer_phone,
        recipientPhoneE164: order.ship_phone_e164,
        assignedTo: order.assigned_to,
      };
    });
  }

  async recordPhoneCallOutcome(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    orderId: string,
    input: CallAttemptInput,
  ): Promise<{ readonly attemptId: string; readonly outcome: string }> {
    return mapOrderErrors(async () => {
      const order = await this.orders.lockForPhoneCall(tx, context, request, orderId);
      const view = await this.orders.recordCallOn(tx, context, request, order, input);
      return { attemptId: view.id, outcome: view.outcome };
    });
  }

  async openOrdersOfCustomer(
    tx: Tx,
    orgId: string,
    customerId: string,
    limit: number,
  ): Promise<readonly OpenOrderFact[]> {
    const rows = await repo.openOrdersOfCustomer(tx, orgId, customerId, limit);
    return rows.map((row) => ({
      id: row.id,
      orderNo: row.order_no,
      status: row.status as OrderStatus,
      assignedTo: row.assigned_to,
      createdAt: new Date(row.created_at),
    }));
  }

  async phoneCallOrderCallable(tx: Tx, orgId: string, orderId: string): Promise<boolean> {
    const order = await repo.orderById(tx, orgId, orderId);
    return order !== undefined && CALLABLE_STATUSES.includes(order.status as OrderStatus);
  }

  // --- M47: the caller panel (D-860) ------------------------------------------------------------

  async callerCustomer(
    tx: Tx,
    orgId: string,
    customerId: string,
  ): Promise<CallerCustomerFacts | undefined> {
    const row = await repo.callerCustomerById(tx, orgId, customerId);
    return row === undefined ? undefined : callerCustomerFacts(row);
  }

  async customerOrdersPage(
    tx: Tx,
    orgId: string,
    customerId: string,
    viewer: RequestContext,
    page: { readonly limit: number; readonly cursor: string | null },
  ): Promise<{ readonly items: readonly CustomerOrderFact[]; readonly nextCursor: string | null }> {
    return mapOrderErrors(async () => {
      let cursor: { createdAt: string; id: string } | null = null;
      if (page.cursor !== null) {
        const [at, id] = page.cursor.split('|');
        if (
          at === undefined ||
          id === undefined ||
          Number.isNaN(new Date(at).getTime()) ||
          !/^[0-9a-f-]{36}$/i.test(id)
        ) {
          throw new OrdersError('VALIDATION_FAILED', 'That page marker is not valid.');
        }
        cursor = { createdAt: new Date(at).toISOString(), id };
      }
      const rows = await repo.customerOrdersPage(tx, orgId, customerId, orderReadScopeFor(viewer), {
        limit: page.limit + 1,
        cursor,
      });
      const items = rows.slice(0, page.limit).map((order) => ({
        id: order.id,
        orderNo: order.order_no,
        status: order.status as OrderStatus,
        codAmountPoisha: String(order.cod_amount_poisha),
        createdAt: instant(order.created_at) ?? new Date(0),
      }));
      const last = items[items.length - 1];
      return {
        items,
        nextCursor:
          rows.length > page.limit && last !== undefined
            ? `${last.createdAt.toISOString()}|${last.id}`
            : null,
      };
    });
  }

  async customerAddresses(
    tx: Tx,
    orgId: string,
    customerId: string,
  ): Promise<readonly CustomerAddressFact[]> {
    const rows = await repo.namedAddressesOf(tx, orgId, customerId, CALLER_PANEL_RECENT_ORDERS);
    return rows.map((row) => ({
      source: row.source,
      label: row.label,
      districtName: row.district_name,
      thanaName: row.thana_name,
      area: row.area,
      addressLine: row.address_line,
      isDefault: row.is_default,
    }));
  }

  async customerOtherPhones(tx: Tx, orgId: string, customerId: string): Promise<readonly string[]> {
    const row = await repo.customerById(tx, orgId, customerId);
    if (row === undefined) return [];
    return repo.otherShipPhonesOf(tx, orgId, customerId, CALLER_PANEL_OTHER_PHONES);
  }

  async buyerCandidates(
    tx: Tx,
    orgId: string,
    phoneE164: string,
  ): Promise<readonly BuyerCandidateFact[]> {
    const people = await peopleOnPhone(tx, orgId, phoneE164);
    const suggested = people[0]?.customerId ?? null;
    return people.map((person) => ({
      customerId: person.customerId,
      name: person.row.name,
      rank: person.rank,
      kind: person.row.kind,
      relation: person.relation,
      note: person.row.note,
      lastOrderAt: person.lastOrderAt,
      orders: person.row.orders_total,
      suggested: person.customerId === suggested,
    }));
  }

  pickBuyerByPhone(
    tx: Tx,
    orgId: string,
    phoneE164: string,
  ): Promise<{ readonly customerId: string; readonly shared: boolean } | undefined> {
    return pickPersonByPhone(tx, orgId, phoneE164);
  }

  async customerNumbers(
    tx: Tx,
    orgId: string,
    customerId: string,
  ): Promise<readonly CustomerNumberFact[]> {
    const rows = await numbers.activePhonesOf(tx, orgId, customerId);
    return rows.map((row) => ({
      id: row.id,
      phoneE164: row.phone_e164,
      rank: row.rank,
      kind: row.kind,
      relation: row.relation,
      note: row.note,
    }));
  }

  customerUsesPhone(
    tx: Tx,
    orgId: string,
    customerId: string,
    phoneE164: string,
  ): Promise<boolean> {
    return numbers.personUsesPhone(tx, orgId, customerId, phoneE164);
  }

  async setPinnedNote(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    customerId: string,
    body: string,
  ): Promise<PinnedNoteFact | null> {
    return mapOrderErrors(async () => {
      const note = body.trim();
      const written = await repo.setPinnedNote(
        tx,
        context.orgId,
        customerId,
        note === '' ? null : { body: note, byUserId: context.userId },
      );
      if (written === undefined) throw new OrdersError('CUSTOMER_NOT_FOUND', 'No such buyer.');
      // The lengths only: a note about a buyer is personal data (invariant 10).
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'customer.note_pinned',
        entityType: 'customer',
        entityId: customerId,
        before: { length: written.before?.length ?? 0 },
        after: { length: note.length },
        requestId: context.requestId,
        request,
      });
      return callerCustomerFacts(written.row).pinnedNote;
    });
  }

  ordersAttributedTo(tx: Tx, orgId: string, campaign: CampaignMatch) {
    return references.ordersAttributedTo(tx, orgId, campaign);
  }

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

  async ensureCourierParty(
    tx: Tx,
    orgId: string,
    party: { readonly code: string; readonly name: string },
  ): Promise<CourierParty & { readonly created: boolean }> {
    const row = await repo.ensureCourier(tx, orgId, party.code, party.name);
    return { id: row.id, code: row.code, name: row.name, created: row.created };
  }

  async defaultCourierId(tx: Tx, orgId: string): Promise<string | null> {
    return (await this.defaultCourierState(tx, orgId)).courierId;
  }

  async defaultCourierState(
    tx: Tx,
    orgId: string,
  ): Promise<{
    readonly courierId: string | null;
    readonly mixed: boolean;
    readonly activeZones: number;
  }> {
    const active = (await repo.listZones(tx, orgId)).filter((zone) => zone.is_active);
    const named = new Set(active.map((zone) => zone.default_courier_id));
    const single = active.length > 0 && named.size === 1 ? ([...named][0] ?? null) : null;
    return { courierId: single, mixed: named.size > 1, activeZones: active.length };
  }

  async setDefaultCourier(
    tx: Tx,
    orgId: string,
    courierId: string,
  ): Promise<{
    readonly before: readonly {
      readonly zoneCode: string;
      readonly courierId: string | null;
      readonly isActive: boolean;
    }[];
  }> {
    // Locked before they are read, so `before` is what this change replaces and a second
    // change at the same moment waits for this one rather than skipping its zones.
    await repo.lockZones(tx, orgId);
    const before = (await repo.listZones(tx, orgId)).map((zone) => ({
      zoneCode: zone.code,
      courierId: zone.default_courier_id,
      isActive: zone.is_active,
    }));
    await repo.setZonesDefaultCourier(tx, orgId, courierId);
    return { before };
  }

  async buyerPhones(
    tx: Tx,
    orgId: string,
    phones: readonly string[],
  ): Promise<ReadonlySet<string>> {
    return new Set(await numbers.phonesInUse(tx, orgId, [...new Set(phones)]));
  }

  async importBuyers(
    tx: Tx,
    actor: OrdersActor,
    buyers: readonly ImportedBuyer[],
  ): Promise<number> {
    // In slices, so a brand's tens of thousands of buyers are a few hundred statements
    // rather than one statement over PostgreSQL's 65,535-parameter limit.
    const SLICE = 500;
    // M48: no unique phone on the buyer row any more, so the refusal it gave is asked here.
    const phones = buyers.map((buyer) => buyer.phoneE164);
    if (new Set(phones).size !== phones.length) {
      throw new OrdersError(
        'CUSTOMER_PHONE_INVALID',
        'The same phone is on two buyers in this batch.',
      );
    }
    for (let start = 0; start < phones.length; start += SLICE) {
      const taken = await numbers.phonesInUse(tx, actor.orgId, phones.slice(start, start + SLICE));
      if (taken.length > 0) {
        throw new OrdersError(
          'CUSTOMER_PHONE_INVALID',
          `${String(taken.length)} of these phones already belong to a buyer of this brand.`,
        );
      }
    }
    for (let start = 0; start < buyers.length; start += SLICE) {
      await repo.insertImportedBuyers(tx, actor.orgId, buyers.slice(start, start + SLICE));
    }
    // Each new buyer's phone becomes their rank-1 own number, from the import (D-870).
    await numbers.insertImportedPhones(tx, actor.orgId);
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
    // What the parcel weighs (D-645), through the catalog's interface (invariant 12).
    const weights = await this.catalog.skuWeights(
      tx,
      orgId,
      lines.map((line) => line.sku_id),
    );

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
      weightGrams: parcelWeightGrams(
        lines.map((line) => ({ qty: line.qty, grams: weights.get(line.sku_id) ?? null })),
      ),
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
    return (await pickPersonByPhone(tx, orgId, phoneE164))?.customerId;
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

  async orderVisibleTo(tx: Tx, orgId: string, orderId: string, request: object): Promise<boolean> {
    const scope = scopeWhere(request, {
      createdBy: sql`o.created_by`,
      assignedTo: sql`o.assigned_to`,
      branchId: sql`o.branch_id`,
    });
    return (await repo.orderByIdInScope(tx, orgId, orderId, scope)) !== undefined;
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

  async editOrder(
    tx: Tx,
    actor: OrdersActor,
    orderId: string,
    patch: UpdateOrderInput,
  ): Promise<void> {
    await mapOrderErrors(async () => {
      // Defence in depth (M35b ledger audit, note 6): the system edit skips a person's scope and
      // the discount ceiling, so it is for orders a server handed over, and nothing else.
      const row = await repo.orderById(tx, actor.orgId, orderId);
      if (row !== undefined && row.channel !== 'marketplace') {
        throw new OrdersError(
          'ORDER_IMMUTABLE',
          'Only an order a marketplace handed over is edited this way.',
        );
      }
      await this.orders.editIn(tx, workerContext(actor), NO_REQUEST, orderId, patch, {
        system: true,
      });
    });
  }

  async retentionFacts(
    tx: Tx,
    orgId: string,
    orderIds: readonly string[],
  ): Promise<readonly OrderRetentionFacts[]> {
    const rows = await repo.retentionFacts(tx, orgId, [...new Set(orderIds)]);
    return rows.map((row) => ({
      orderId: row.id,
      status: row.status as OrderStatus,
      statusSince: instant(row.status_since),
    }));
  }

  async visibleOrderIds(
    tx: Tx,
    orgId: string,
    orderIds: readonly string[],
    request: object,
  ): Promise<ReadonlySet<string>> {
    const scope = scopeWhere(request, {
      createdBy: sql`o.created_by`,
      assignedTo: sql`o.assigned_to`,
      branchId: sql`o.branch_id`,
    });
    return new Set(await repo.orderIdsInScope(tx, orgId, [...new Set(orderIds)], scope));
  }

  orderInScopeSql(
    orgId: string,
    orderId: SQL,
    request: object,
    statuses?: readonly OrderStatus[],
  ): SQL {
    const scope = scopeWhere(request, {
      createdBy: sql`o.created_by`,
      assignedTo: sql`o.assigned_to`,
      branchId: sql`o.branch_id`,
    });
    const status =
      statuses === undefined
        ? sql`true`
        : sql`o.status = any (${sql.param([...statuses])}::sales.order_status[])`;
    return sql`exists (
      select 1 from sales.orders o
      where o.org_id = ${orgId} and o.id = ${orderId} and ${scope} and ${status}
    )`;
  }

  async orderIdsForShipmentCode(tx: Tx, orgId: string, code: string): Promise<readonly string[]> {
    const trimmed = code.trim();
    if (trimmed === '') return [];
    // An order's own code before a courier's, as the order number always was: ten digits that
    // are both an order's code and another parcel's consignment number open the order. Every
    // slip and label this ERP prints carries the order's code in its bars, so it is what is
    // scanned, and it names one order by construction; a courier's number is an order's code
    // only by beginning with a month this brand took orders in and a counter it reached (a
    // numeric id counting up reaches ten digits at `10…`, the year 2010).
    const byOrder = await this.orderIdsForOrderCode(tx, orgId, trimmed);
    if (byOrder.length > 0) return byOrder;
    const courier = this.courier.current();
    if (courier === undefined) return [];
    return courier.ordersByParcelCode(tx, orgId, trimmed);
  }

  async orderIdsForOrderCode(tx: Tx, orgId: string, code: string): Promise<readonly string[]> {
    const trimmed = code.trim();
    if (trimmed === '') return [];
    const byNumber = await repo.orderIdByNo(tx, orgId, trimmed);
    if (byNumber !== undefined) return [byNumber];
    const byNumberUpper = await repo.orderIdByNo(tx, orgId, trimmed.toUpperCase());
    if (byNumberUpper !== undefined) return [byNumberUpper];
    // D-912: the ten digits a barcode carries, the order number without its prefix.
    const digits = parseOrderScanCode(trimmed);
    if (digits === null) return [];
    const prefix = await this.currentOrderPrefix(tx, orgId);
    if (prefix !== null) {
      const sequence = Number(digits.counter);
      const orderNo = formatOrderNo({ prefix, period: digits.period, sequence });
      const exact = await repo.orderIdByNo(tx, orgId, orderNo);
      if (exact !== undefined) return [exact];
    }
    // Numbered under a prefix the brand has changed since: the period and counter alone.
    return repo.orderIdsByPeriodCounter(tx, orgId, digits.period, digits.counter);
  }

  /** The prefix new orders are numbered with, as `nextOrderNo` makes it; null if none is usable. */
  private async currentOrderPrefix(tx: Tx, orgId: string): Promise<string | null> {
    const [slug, configured] = await Promise.all([
      repo.orgSlug(tx, orgId),
      repo.orderNumberPrefix(tx, orgId),
    ]);
    try {
      return orderPrefixFor({ slug, configured });
    } catch (error) {
      // A prefix setting no order could be numbered with: only the fallback can name one.
      if (error instanceof OrderError) return null;
      throw error;
    }
  }

  async courierBooking(tx: Tx, orgId: string): Promise<CourierBookingPolicy> {
    const value = await repo.courierBookingSetting(tx, orgId);
    return value === 'on_confirm' || value === 'on_pack' ? value : 'manual';
  }

  async packingFacts(
    tx: Tx,
    orgId: string,
    orderIds: readonly string[],
  ): Promise<readonly PackingFacts[]> {
    const ids = [...new Set(orderIds)];
    const [rows, lines] = await Promise.all([
      repo.packingOrderRows(tx, orgId, ids),
      repo.packingLines(tx, orgId, ids),
    ]);
    const courierIds = [
      ...new Set(rows.flatMap((row) => (row.courier_id === null ? [] : [row.courier_id]))),
    ];
    const couriers = new Map(
      (await repo.couriersByIds(tx, orgId, courierIds)).map((courier) => [
        courier.id,
        courier.name,
      ]),
    );
    const facts: PackingFacts[] = [];
    for (const row of rows) {
      facts.push({
        id: row.id,
        orderNo: row.order_no,
        channel: row.channel,
        status: row.status as OrderStatus,
        createdAt: instant(row.created_at) ?? new Date(0),
        notes: row.notes,
        branchId: row.branch_id,
        createdBy: row.created_by,
        assignedTo: row.assigned_to,
        locationId: row.location_id,
        slipPrintedAt: instant(row.slip_printed_at),
        itemsPoisha: BigInt(row.items_poisha),
        discountPoisha: BigInt(row.discount_poisha),
        deliveryChargePoisha: BigInt(row.delivery_charge_poisha),
        advancePaidPoisha: BigInt(row.advance_paid_poisha),
        codAmountPoisha: BigInt(row.cod_amount_poisha),
        recipient: {
          name: row.ship_name,
          phoneE164: row.ship_phone_e164,
          districtEn: row.district_en,
          districtBn: row.district_bn,
          thanaEn: row.thana_en,
          thanaBn: row.thana_bn,
          area: row.ship_area,
          addressLine: row.ship_address_line,
        },
        parcel: await this.parcelTracking(tx, orgId, row.id),
        courierName: row.courier_id === null ? null : (couriers.get(row.courier_id) ?? null),
        lines: lines
          .filter((line) => line.order_id === row.id)
          .map((line) => ({
            skuId: line.sku_id,
            skuCode: line.sku_code,
            productName: line.product_name,
            qty: line.qty,
            returnedQty: line.returned_qty,
            unitPricePoisha: BigInt(line.unit_price_poisha),
          })),
      });
    }
    const order = new Map(ids.map((id, index) => [id, index]));
    return facts.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  async customerPanel(
    tx: Tx,
    orgId: string,
    customerId: string,
    recentLimit: number,
    viewer: RequestContext,
  ): Promise<CustomerPanelFacts | undefined> {
    const row = await repo.customerById(tx, orgId, customerId);
    if (row === undefined) return undefined;
    const recent =
      recentLimit === 0
        ? []
        : await repo.recentOrdersOfCustomer(
            tx,
            orgId,
            customerId,
            recentLimit,
            orderReadScopeFor(viewer),
          );
    return {
      id: row.id,
      name: row.name,
      phoneE164: row.phone_e164,
      orders: row.orders_total,
      delivered: row.delivered_count,
      returned: row.returned_count,
      cancelled: row.cancelled_count,
      spentPoisha: BigInt(row.ltv_poisha),
      lastOrderAt: instant(row.last_order_at),
      recentOrders: recent.map((order) => ({
        id: order.id,
        orderNo: order.order_no,
        status: order.status as OrderStatus,
        channel: order.channel,
        codAmountPoisha: String(order.cod_amount_poisha),
        createdAt: instant(order.created_at) ?? new Date(0),
      })),
    };
  }

  async customerReachable(
    tx: Tx,
    orgId: string,
    customerId: string,
    viewer: RequestContext,
  ): Promise<boolean> {
    // A buyer the agent may open (D-740), not every buyer of an order they may read (D-725).
    return repo.customerReachableIn(tx, orgId, customerId, buyerReachScopeFor(viewer));
  }

  async inboxOrigin(tx: Tx, orgId: string, orderId: string): Promise<InboxOrderOrigin | undefined> {
    const row = await repo.inboxOriginOf(tx, orgId, orderId);
    if (row === undefined) return undefined;
    const conversation = row.inbox_conversation_id;
    return {
      customerId: row.customer_id,
      customerPhoneE164: row.phone_e164,
      inboxConversationId:
        typeof conversation === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversation)
          ? conversation
          : null,
    };
  }

  async deskAvailability(
    tx: Tx,
    orgId: string,
    skuIds: readonly string[],
  ): Promise<Map<string, number>> {
    if (skuIds.length === 0) return new Map();
    const location = await repo.defaultFulfilmentLocation(tx, orgId, null);
    if (location === undefined) return new Map();
    return this.inventory.availability(tx, orgId, location.id, skuIds);
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

/** M47 (D-860): the caller panel's buyer, from their row. */
const GENDERS: readonly string[] = ['female', 'male', 'other'];

/** A stored gender the contracts name (an imported value they do not is shown as none). */
function isGender(value: string | null): value is CustomerGender {
  return value !== null && GENDERS.includes(value);
}

function callerCustomerFacts(row: repo.CallerCustomerRow): CallerCustomerFacts {
  const rate = returnRateBps(row.delivered_count, row.returned_count);
  const noteAt = instant(row.pinned_note_at);
  return {
    id: row.id,
    name: row.name,
    phoneE164: row.phone_e164,
    tags: Array.isArray(row.tags)
      ? row.tags.filter((tag): tag is string => typeof tag === 'string')
      : [],
    segment: row.segment,
    orders: row.orders_total,
    delivered: row.delivered_count,
    returned: row.returned_count,
    cancelled: row.cancelled_count,
    returnRateBps: rate === null ? null : Number(rate),
    spentPoisha: BigInt(row.ltv_poisha),
    firstOrderAt: instant(row.first_order_at),
    lastOrderAt: instant(row.last_order_at),
    pinnedNote:
      row.pinned_note === null || row.pinned_note_by_user_id === null || noteAt === null
        ? null
        : { body: row.pinned_note, byUserId: row.pinned_note_by_user_id, at: noteAt },
  };
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
