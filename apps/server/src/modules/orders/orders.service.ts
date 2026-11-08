import { Inject, Injectable } from '@nestjs/common';
import {
  defineAbilityFor,
  MATRIX,
  MEMBERSHIP_ROLES,
  type CallAttemptInput,
} from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import {
  assignmentDecision,
  CALLABLE_STATUSES,
  canHoldOrder,
  TAKEABLE_STATUSES,
  callAttemptProblem,
  hubStageOf,
  isSupervisor,
  type HubStage,
  type OwnerGatedAct,
  applicableAdvance,
  add,
  businessDate,
  computeExchangeReturn,
  computeOrderTotals,
  basisPointsAsPercent,
  discountAllowed,
  formatOrderNo,
  holdsStock as holdsStockNow,
  mulQty,
  normalizeBdPhone,
  orderDiscountCeilingBps,
  orderExchangeDraft,
  orderPeriodFor,
  orderPrefixFor,
  placedForOf,
  poisha,
  repriceReturn,
  sub,
  TRANSITIONS,
  type PlacedFor,
  type DiscountedOrder,
  withinPostingWindow,
  type OrderStatus,
  type OrderTrigger,
} from '@elysium/domain';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { emit } from '../../platform/events/outbox.js';
import { assertInScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { CATALOG_API, type CatalogApi, type CatalogSku } from '../catalog/catalog.api.js';
import { IAM_API, type IamApi } from '../iam/iam.api.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import { CustomersService } from './customers.service.js';
import { addNumber, sourceForOrder } from './numbers.helpers.js';
import { HandoverGuardRegistry } from './ports/handover-guard.port.js';
import { PROMO_PORT, type PricedPromo, type PromoPort } from './ports/promo.port.js';
import type { AppliedDiscountView, OfferView } from '../promo/promo.api.js';
import { TransitionsService, type MoveOptions } from './transitions.service.js';
import { TEAM_API, type TeamApi } from '../team/team.api.js';
import { OffersService } from './offers.service.js';
import { OwnershipGate } from './ownership.gate.js';
import { orderQueueSql } from './queues.js';
import * as desk from './desk.repository.js';
import { checkedArea } from './area.helpers.js';
import * as repo from './orders.repository.js';
import {
  deskActScopeFor,
  deskActScopeSql,
  orderActScopeFor,
  orderInActScope,
  orderScopeSql,
} from './orders.scope.js';
import { orderTimeline } from './timeline.js';
import { mapOrderErrors, OrdersError } from './orders.errors.js';
import type {
  AvailabilityQuery,
  CreateOrderInput,
  ExchangeOrderInput,
  OrderOffersInput,
  OrderQuery,
  ReplaceOrderInput,
  UpdateOrderInput,
} from './orders.schemas.js';

// §6's scope for orders lives in `orders.scope.ts`, where the advances service can reach it
// without an import cycle through this file; re-exported for the readers that import it here.
export { orderScopeSql } from './orders.scope.js';
/**
 * Orders (architecture §9, invariants 1, 5, 6, 7, 11 and 12).
 *
 * This file takes orders, edits them and hands every status change to
 * `TransitionsService`. It owns none of the arithmetic and none of the journals: totals
 * come from `computeOrderTotals`, the transition table from `transition()`, the journals
 * from `packages/domain/src/posting`, the stock from `INVENTORY_API` and the posting
 * itself from `LEDGER_API`. What is left here is the part that is genuinely about
 * orders — resolving a buyer, a zone, a price and a number, and deciding who may see
 * which row.
 *
 * Four decisions worth reading before the code.
 *
 * ## Everything happens in one `withOrg` transaction
 *
 * An order, its lines, its reservation, its journal, its outbox row and its audit row
 * commit together or not at all. That is not tidiness: the failure it prevents is an
 * order sitting `confirmed` with nothing reserved, which nothing reports and which the
 * warehouse discovers when it cannot pick it. No external call is made inside any of
 * these transactions (invariant 6) — the courier and the SMS gateway are reached by
 * jobs the outbox row starts, after the commit.
 *
 * ## The scope is a predicate, not a filter
 *
 * §6's sales cell is "own orders **plus** the unassigned queue". A filter applied after
 * the read cannot express that, so every path resolves its order through
 * `repo.lockOrderInScope` with the caller's scope as SQL. `orderScope()` below is where
 * the queue is added, and it is added **only for a caller holding `sales`** — the same
 * `read Order|own` grant is held by `reseller`, and widening it there would hand a
 * reseller every unassigned staff order in the brand.
 *
 * ## No cost enters or leaves
 *
 * The request schemas have no cost field and the views below have none: `unit_price` is
 * a selling price, and `dispatch_unit_cost_poisha` — which the ship transition writes on
 * each line — is deliberately absent from `OrderLineView`. Invariant 5's
 * `serializeFor()` is the backstop, not the mechanism; the mechanism is that the number
 * is never put in a response object.
 */

// --- what the endpoints return -------------------------------------------------

export interface OrderLineView {
  readonly id: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly productName: string;
  readonly qty: number;
  readonly unitPricePoisha: string;
  readonly discountPoisha: string;
  readonly deliveredQty: number;
  readonly returnedQty: number;
  readonly position: number;
}

export interface OrderView {
  readonly id: string;
  readonly orderNo: string;
  readonly status: string;
  readonly channel: string;
  readonly source: unknown;
  readonly branchId: string | null;
  readonly customer: { readonly id: string; readonly name: string; readonly phone: string };
  readonly shipTo: {
    readonly name: string;
    readonly phone: string;
    readonly districtId: number | null;
    readonly thanaId: number | null;
    readonly area: string | null;
    readonly addressLine: string;
  };
  /**
   * M48 (D-878): whom it was placed for. The buyer (`customer`) ordered; the recipient is
   * `shipTo`, with their own record when the staff linked one.
   */
  readonly placedFor: string;
  readonly placedForNote: string | null;
  readonly recipientCustomerId: string | null;
  /** M48 (D-876): "check the buyer: shared number", until confirmed or changed. */
  readonly buyerCheck: string | null;
  readonly deliveryZoneId: string | null;
  readonly courierId: string | null;
  readonly locationId: string | null;
  readonly amounts: {
    readonly itemsPoisha: string;
    readonly discountPoisha: string;
    readonly deliveryChargePoisha: string;
    readonly advancePaidPoisha: string;
    readonly codAmountPoisha: string;
  };
  readonly holdReason: string | null;
  readonly cancelReason: string | null;
  readonly assignedTo: string | null;
  /** M41 (D-710): since when the owner has it. */
  readonly assignedAt: string | null;
  readonly createdBy: string;
  readonly exchangeOfOrderId: string | null;
  readonly notes: string | null;
  /** M41 (D-718): the verification calls, summarised for the queue. */
  readonly calls: {
    readonly attempts: number;
    readonly lastOutcome: string | null;
    readonly lastAt: string | null;
    readonly callBackAt: string | null;
  };
  /** M41 (D-719): the hub's progress, which the desk that sold it follows. */
  readonly slipPrintedAt: string | null;
  readonly hubStage: HubStage | null;
  readonly timestamps: {
    readonly createdAt: string;
    readonly confirmedAt: string | null;
    readonly packedAt: string | null;
    readonly handedOverAt: string | null;
    readonly deliveredAt: string | null;
    readonly returnedAt: string | null;
    readonly cancelledAt: string | null;
  };
}

/**
 * A timestamp as §23 wants it: ISO 8601, or null.
 *
 * The driver hands `timestamptz` back as text in its own format
 * (`2026-09-25 16:07:02.039+00`), which is a perfectly good timestamp and not what a client
 * parses. Normalised here rather than in the repository, because the repository's job is to
 * return what the row says and this is a decision about the wire (see `OrderRow`).
 */
function isoOf(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toLineView(row: repo.OrderLineRow): OrderLineView {
  return {
    id: row.id,
    skuId: row.sku_id,
    skuCode: row.sku_code,
    productName: row.product_name,
    qty: row.qty,
    unitPricePoisha: String(row.unit_price_poisha),
    discountPoisha: String(row.discount_poisha),
    deliveredQty: row.delivered_qty,
    returnedQty: row.returned_qty,
    position: row.position,
    // `dispatch_unit_cost_poisha` is on the row and is not on the view (invariant 5).
    // It is what the handover journal posted, and nobody outside the ledger needs it.
  };
}

function toOrderView(row: repo.OrderRow): OrderView {
  return {
    id: row.id,
    orderNo: row.order_no,
    status: row.status,
    channel: row.channel,
    source: row.source,
    branchId: row.branch_id,
    customer: { id: row.customer_id, name: row.customer_name, phone: row.customer_phone },
    shipTo: {
      name: row.ship_name,
      phone: row.ship_phone_e164,
      districtId: row.ship_district_id,
      thanaId: row.ship_thana_id,
      area: row.ship_area,
      addressLine: row.ship_address_line,
    },
    placedFor: row.placed_for,
    placedForNote: row.placed_for_note,
    recipientCustomerId: row.recipient_customer_id,
    buyerCheck: row.buyer_check,
    deliveryZoneId: row.delivery_zone_id,
    courierId: row.courier_id,
    locationId: row.location_id,
    amounts: {
      itemsPoisha: String(row.items_poisha),
      discountPoisha: String(row.discount_poisha),
      deliveryChargePoisha: String(row.delivery_charge_poisha),
      advancePaidPoisha: String(row.advance_paid_poisha),
      codAmountPoisha: String(row.cod_amount_poisha),
    },
    holdReason: row.hold_reason,
    cancelReason: row.cancel_reason,
    assignedTo: row.assigned_to,
    assignedAt: isoOf(row.assigned_at),
    createdBy: row.created_by,
    exchangeOfOrderId: row.exchange_of_order_id,
    notes: row.notes,
    calls: {
      attempts: row.call_attempts,
      lastOutcome: row.last_call_outcome,
      lastAt: isoOf(row.last_call_at),
      callBackAt: isoOf(row.call_back_at),
    },
    slipPrintedAt: isoOf(row.slip_printed_at),
    hubStage: hubStageOf({ status: row.status, slipPrintedAt: row.slip_printed_at }),
    timestamps: {
      createdAt: new Date(row.created_at).toISOString(),
      confirmedAt: isoOf(row.confirmed_at),
      packedAt: isoOf(row.packed_at),
      handedOverAt: isoOf(row.handed_over_at),
      deliveredAt: isoOf(row.delivered_at),
      returnedAt: isoOf(row.returned_at),
      cancelledAt: isoOf(row.cancelled_at),
    },
  };
}

/**
 * The moves §9's machine allows from this status, for the console to offer (D-392).
 *
 * Read off `TRANSITIONS`, the table `transition()` itself enforces, so a button the order
 * detail shows is a row the server will accept and a row it will refuse is never offered —
 * and the console carries no copy of the table to drift from it. Whether the *caller* may
 * take it is their `update Order` grant (or `create Order` for an exchange), which the
 * console asks of its own ability; the server re-checks both on the request.
 */
export interface AvailableTransition {
  readonly trigger: OrderTrigger;
  readonly to: OrderStatus;
  /** The machine refuses this move without a reason (§9's `requiresReason`). */
  readonly requiresReason: boolean;
  /** The machine refuses it without a return reason code from the fixed list (D-234). */
  readonly requiresReturnReason: boolean;
}

export function transitionsFrom(status: OrderStatus): readonly AvailableTransition[] {
  return TRANSITIONS.filter((row) => row.from === status).map((row) => ({
    trigger: row.trigger,
    to: row.to,
    requiresReason: row.requiresReason,
    requiresReturnReason: row.effects.includes('record_return_reason'),
  }));
}

/**
 * The moves a parcel's own routes record when the order has one with a courier (see
 * `TransitionsService.assertNoLiveParcel`).
 */
const PARCEL_RECORDED: readonly OrderTrigger[] = ['deliver', 'deliver_partially', 'receive_return'];

/** A shipping address, however the caller expressed it. */
interface ShipTo {
  readonly name: string;
  readonly phoneE164: string;
  /** Optional since D-953: the address is one written line, the zone is picked. */
  readonly districtId: number | null;
  readonly thanaId: number | null;
  readonly area: string | null;
  readonly addressLine: string;
}

/** A priced line, ready to insert. */
interface PricedLine {
  readonly skuId: string;
  readonly skuCode: string;
  readonly productName: string;
  readonly qty: number;
  readonly unitPricePoisha: bigint;
  readonly discountPoisha: bigint;
}

/** An order's lines and its order-level discount, as the discount ceiling reads them. */
interface PricedOrder {
  readonly lines: readonly {
    readonly skuId: string;
    readonly qty: number;
    readonly unitPricePoisha: bigint;
    readonly discountPoisha: bigint;
  }[];
  readonly orderDiscountPoisha: bigint;
}

/** What `createIn` needs beyond the request body. */
export interface CreateOrderOptions {
  /** The original order, when this is an exchange's replacement (§9). */
  readonly exchangeOfOrderId?: string | null;
  /** A credit to absorb as an advance, capped by `applicableAdvance`. */
  readonly creditPoisha?: bigint;
  /** Fall back to this address when the body names none: the original order's. */
  readonly fallbackShipTo?: ShipTo;
  /** The zone and charge to inherit when the body names none. */
  readonly fallbackDeliveryZoneId?: string | null;
  readonly fallbackDeliveryChargePoisha?: bigint;
  /**
   * The prices come from the system, not from a person at the desk, so the agent's discount
   * ceiling (D-364) does not apply: the public intake (whose body cannot carry a price), a
   * brand's migrated order history and the preview's seed. Set only by `OrdersApiService`;
   * every HTTP path leaves it out and is checked.
   */
  readonly systemPricing?: true;
  /**
   * Reserve the lines at this location as the order is placed, in this transaction (a website
   * checkout, M34, D-532). The order is then `stock_held_at`: confirming it reserves nothing
   * more and cancelling it while pending releases the hold, both by the state machine. All or
   * nothing: a line the location cannot hold refuses the order with `STOCK_INSUFFICIENT`.
   */
  readonly holdStockAt?: string;
  /**
   * The discount the order's `promo_code_id` names, for a server caller that priced and
   * redeems its discounts itself (the website, M34, D-539). Never from a request body.
   */
  readonly promoCodeId?: string | null;
}

export interface CreatedOrder {
  readonly id: string;
  readonly orderNo: string;
  readonly status: OrderStatus;
  readonly codAmountPoisha: string;
  readonly advancePaidPoisha: string;
}

@Injectable()
export class OrdersService {
  constructor(
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    @Inject(INVENTORY_API) private readonly inventory: InventoryApi,
    @Inject(LEDGER_API) private readonly ledger: LedgerApi,
    @Inject(PROMO_PORT) private readonly promo: PromoPort,
    @Inject(IAM_API) private readonly iam: IamApi,
    private readonly customers: CustomersService,
    private readonly transitions: TransitionsService,
    private readonly audit: AuditService,
    private readonly gate: OwnershipGate,
    private readonly offers: OffersService,
    @Inject(TEAM_API) private readonly team: TeamApi,
    // M46 (D-808): an order in several lots is shipped by hand only once every lot is scanned.
    private readonly handover: HandoverGuardRegistry,
  ) {}

  // --- reads --------------------------------------------------------------------

  async list(context: ActiveContext, request: object, query: OrderQuery) {
    const scope = orderScopeSql(context, request);
    /*
     * The queue filters narrow the scope; they never widen it.
     *
     * `unassigned` is `assigned_to is null` **and** the scope, not instead of it, so a
     * role whose cell does not include the queue sees only the unassigned orders it
     * could already see. `mine` is the caller's own name on the row, which is what the
     * order desk's "my orders" tab means.
     */
    const queue = orderQueueSql(query.queue, context.userId);
    /*
     * D-725: a queue lists the orders the caller may work on, the plain list every order they
     * may read. For a sales agent the two differ: the desk's and the hub's tabs stay their own
     * and the unassigned, and "every agent" on the order list is the whole brand.
     */
    const reach =
      query.queue === undefined ? scope : sql`(${scope} and ${orderActScopeFor(context)})`;

    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        /*
         * One row more than the page, so the list can say whether there is a next page
         * without a count query. A count races the next insert on a busy evening and costs
         * a second scan of the same predicate; "the page came back full" misreports the one
         * case where the last page is exactly full, which the extra row removes.
         */
        /*
         * M41 (D-719): the hub's queues are the hub's location's. Asked without a location, a
         * person whose desk profile names a hub sees that hub's orders; one with no hub (a
         * supervisor) sees every location's.
         */
        const locationId =
          query.locationId ??
          (query.queue?.startsWith('hub_') === true
            ? ((await this.team.hubLocationOf(tx, context.orgId, context.userId)) ?? undefined)
            : undefined);
        // A desk order that named no location ships from the brand's default warehouse.
        const fallback =
          locationId === undefined
            ? undefined
            : await repo.defaultFulfilmentLocation(tx, context.orgId, null);
        const rows = await repo.listOrders(tx, context.orgId, {
          scope: reach,
          queue: queue.where,
          orderBy: queue.orderBy,
          locationId,
          locationIncludesUnset: fallback !== undefined && fallback.id === locationId,
          status: query.status,
          customerId: query.customerId,
          q: query.q,
          from: query.from,
          to: query.to,
          channel: query.channel,
          assignedTo: query.assignedTo,
          zoneId: query.zoneId,
          buyerCheck: query.buyerCheck,
          limit: query.limit + 1,
          offset: query.offset,
        });
        return {
          items: rows
            .slice(0, query.limit)
            .map((row) => ({ ...toOrderView(row), itemCount: row.item_count })),
          hasNext: rows.length > query.limit,
        };
      }),
    );
  }

  async get(context: ActiveContext, request: object, id: string) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const order = await this.readInScope(tx, context, request, id);
        const [lines, events, audited] = await Promise.all([
          repo.orderLines(tx, context.orgId, order.id),
          repo.orderEvents(tx, context.orgId, order.id),
          desk.orderAuditTrail(tx, context.orgId, order.id),
        ]);
        const history = events.map((event) => ({
          id: event.id,
          from: event.from_status,
          to: event.to_status,
          trigger: event.trigger,
          reason: event.reason,
          actorUserId: event.actor_user_id,
          occurredAt: new Date(event.occurred_at).toISOString(),
        }));
        const timeline = orderTimeline(history, audited);
        /*
         * The owners among the people on this order (M31, D-473): an owner holds no role,
         * so the console cannot name them from its list of staff. Their names go to other
         * owners only; everyone else reads "Owner".
         */
        const owners = await this.iam.ownersAmong(
          tx,
          [
            ...timeline.flatMap((entry) => (entry.actorUserId === null ? [] : [entry.actorUserId])),
            ...[order.assigned_to, order.created_by].filter(
              (id): id is string => typeof id === 'string',
            ),
          ],
          context,
        );
        // M50: the offers on the order now, and the packed order it replaced or that replaced it.
        const appliedOffers = await this.promo.appliedOnOrder(tx, context.orgId, order.id);
        const links = await repo.replacementLinks(tx, context.orgId, order.id);
        return {
          ...toOrderView(order),
          lines: lines.map(toLineView),
          history,
          timeline,
          owners,
          transitions: transitionsFor(context, order),
          appliedOffers,
          replaces: links.replaces,
          replacedBy: links.replacedBy,
        };
      }),
    );
  }

  /**
   * What the order desk needs to know before it promises a size (M10 Build list).
   *
   * On hand minus reserved, per SKU, at the location the order will ship from — read
   * through `INVENTORY_API.availability` rather than by joining `inventory.stock_levels`
   * (invariant 12). The selling price comes with it because the same screen prices the
   * line, and one round trip beats two.
   */
  async availability(context: ActiveContext, query: AvailabilityQuery) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const locationId = query.locationId ?? (await this.defaultLocation(tx, context, null));
        const [skus, available] = await Promise.all([
          this.catalog.skusByIds(tx, context.orgId, query.skuIds),
          this.inventory.availability(tx, context.orgId, locationId, query.skuIds),
        ]);
        const bySku = new Map(skus.map((sku) => [sku.id, sku]));
        return {
          locationId,
          items: query.skuIds.map((skuId) => {
            const sku = bySku.get(skuId);
            return {
              skuId,
              skuCode: sku?.code ?? null,
              productName: sku?.productName ?? null,
              status: sku?.status ?? null,
              pricePoisha: sku === undefined ? null : sku.pricePoisha.toString(),
              // Zero for a SKU the org has never stocked at this location, which is the
              // same answer as one that has run out — see `InventoryApi.reserve`.
              availableQty: available.get(skuId) ?? 0,
            };
          }),
        };
      }),
    );
  }

  async zones(context: ActiveContext) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const [zones, couriers] = await Promise.all([
          repo.listZones(tx, context.orgId),
          repo.listCouriers(tx, context.orgId),
        ]);
        return {
          zones: zones.map((zone) => ({
            id: zone.id,
            code: zone.code,
            nameEn: zone.name_en,
            nameBn: zone.name_bn,
            chargePoisha: String(zone.charge_poisha),
            defaultCourierId: zone.default_courier_id,
            position: zone.position,
            isActive: zone.is_active,
          })),
          couriers: couriers.map((courier) => ({
            id: courier.id,
            code: courier.code,
            name: courier.name,
            isActive: courier.is_active,
          })),
        };
      }),
    );
  }

  /** The zone and charge that apply to one address (§9), for the order form. */
  async zoneFor(context: ActiveContext, query: { districtId: number; thanaId?: number }) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const zone = await repo.zoneForArea(
          tx,
          context.orgId,
          query.districtId,
          query.thanaId ?? null,
        );
        if (zone === undefined) {
          throw new OrdersError(
            'DELIVERY_ZONE_NOT_FOUND',
            'No delivery zone covers that district; map it to a zone first.',
          );
        }
        return {
          id: zone.id,
          code: zone.code,
          nameEn: zone.name_en,
          nameBn: zone.name_bn,
          chargePoisha: String(zone.charge_poisha),
          defaultCourierId: zone.default_courier_id,
        };
      }),
    );
  }

  async upsertZone(
    context: ActiveContext,
    request: AuditableRequest,
    input: {
      code: string;
      nameEn: string;
      nameBn?: string | undefined;
      chargePoisha: string;
      defaultCourierId?: string;
      position?: number;
      isActive?: boolean;
    },
  ) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const id = await repo.upsertZone(tx, {
          orgId: context.orgId,
          code: input.code,
          nameEn: input.nameEn,
          nameBn: input.nameBn ?? null,
          chargePoisha: BigInt(input.chargePoisha),
          defaultCourierId: input.defaultCourierId ?? null,
          position: input.position ?? 0,
          isActive: input.isActive ?? true,
        });
        // D-952: a zone saved naming another courier than the brand's chosen default means the
        // zones decide now, so that default is forgotten and Settings → Couriers and new orders
        // keep naming the same courier. A zone saved with none keeps it (it falls back to it).
        const brandDefault = await repo.brandDefaultCourierSetting(tx, context.orgId);
        const brandDefaultCleared =
          input.defaultCourierId !== undefined &&
          brandDefault !== null &&
          brandDefault !== input.defaultCourierId;
        if (brandDefaultCleared) {
          await repo.deleteOrgSetting(tx, context.orgId, 'orders.default_courier');
        }
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'delivery_zone.saved',
          entityType: 'delivery_zone',
          entityId: id,
          after: {
            code: input.code,
            chargePoisha: input.chargePoisha,
            defaultCourierId: input.defaultCourierId ?? null,
            ...(brandDefaultCleared ? { brandDefaultCourierCleared: brandDefault } : {}),
          },
          request,
        });
        return { id, code: input.code };
      }),
    );
  }

  // --- create and edit ----------------------------------------------------------

  async create(context: ActiveContext, request: AuditableRequest, input: CreateOrderInput) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        /*
         * The caller's `create` scope is asserted before anything is written.
         *
         * D-061: a `create` has nothing to filter, so the scope is checked against the
         * row about to exist. A branch manager granted `create Order|branch` must not
         * enter an order for another branch, and this is the only place that can say so
         * — the guard only knows they may create *some* order.
         */
        this.assertCreatable(request, context, input.branchId ?? null, input.assignedTo ?? null);
        /*
         * M41 (D-712): an order created for somebody else is a supervisor's routing, as on the
         * assign route, and the person named must be able to hold it.
         */
        if (input.assignedTo !== undefined && input.assignedTo !== context.userId) {
          if (!isSupervisor(context.roles, context.isSuperAdmin)) {
            throw new OrdersError(
              'ORDER_ASSIGN_NOT_ALLOWED',
              'Only a supervisor can take an order for somebody else. Leave it in New, or take it yourself.',
            );
          }
          await this.assertAssignable(tx, context, input.assignedTo, input.branchId ?? null);
        }
        if (input.customerId !== undefined) {
          /*
           * A named buyer has to be one this caller may already see.
           *
           * Taking an order *reads* the buyer — their name and number come back on the
           * order, which is then `own` — so an unchecked id was a way to learn a buyer §6
           * does not give you by guessing a uuid inside your own org. Applied here rather
           * than in `createIn`, because `OrdersApi`'s callers are workers with no request
           * to scope against and their own edge to apply §6 at.
           */
          await this.customers.assertReachable(tx, context, request, input.customerId);
        }
        if (input.recipientCustomerId !== undefined) {
          // The same test for the recipient's record (M48, D-880): naming it reads it.
          await this.customers.assertReachable(tx, context, request, input.recipientCustomerId);
        }
        const created = await this.createIn(tx, context, request, input, {});
        return created;
      }),
    );
  }

  /**
   * Create an order inside a caller's transaction.
   *
   * Public because three callers need it and they are not all HTTP: this service's own
   * `create`, the exchange flow (which creates the replacement in the same transaction
   * as the original's credit), and `OrdersApi` for M21's reseller orders and M23's POS.
   * It applies no permission scope — the caller does, because a worker has no request to
   * scope against.
   */
  async createIn(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    input: CreateOrderInput,
    options: CreateOrderOptions,
  ): Promise<CreatedOrder> {
    const at = new Date();
    const buyer = await this.resolveBuyer(tx, context, input);
    const shipTo = await this.resolveShipTo(tx, context, input, buyer, options);
    const behalf = await this.resolveRecipient(tx, context, input, buyer, shipTo);
    const zone = await this.resolveZone(tx, context, input, shipTo, options);
    const lines = await this.priceLines(tx, context, input.lines);
    if (options.systemPricing !== true) {
      await this.assertDiscountCeiling(tx, context, {
        lines,
        orderDiscountPoisha: BigInt(input.discountPoisha ?? 0n),
      });
    }

    const baseDeliveryChargePoisha =
      input.deliveryChargePoisha !== undefined
        ? BigInt(input.deliveryChargePoisha)
        : (zone?.chargePoisha ?? options.fallbackDeliveryChargePoisha ?? 0n);

    /*
     * A promo code is priced here, before the totals, because both the order's discount
     * and its delivery charge depend on it — and priced from the lines this server just
     * priced, never from anything the caller sent but the word (D-204). It is redeemed
     * after the order row exists, in this same transaction; see `PromoPort`.
     */
    const priced: PricedPromo | null =
      input.promoCode === undefined
        ? null
        : await this.promo.priceForOrder(tx, context, {
            code: input.promoCode,
            customerId: buyer.id,
            channel: input.channel,
            lines: lines.map((line) => ({
              skuId: line.skuId,
              qty: line.qty,
              netPoisha: sub(
                mulQty(poisha(line.unitPricePoisha), line.qty),
                poisha(line.discountPoisha),
              ).toString(),
            })),
            // The agent's own discount comes off first; the code is priced on the rest.
            orderDiscountPoisha: (input.discountPoisha ?? '0').toString(),
            deliveryChargePoisha: baseDeliveryChargePoisha.toString(),
          });

    // The code's delivery discount comes off the charge; its goods discount joins the
    // agent's typed one as the order's discount. Revenue is then credited net of it by
    // the existing delivery posting (§7), with no new rule.
    const deliveryChargePoisha =
      priced === null
        ? baseDeliveryChargePoisha
        : sub(poisha(baseDeliveryChargePoisha), poisha(priced.deliveryDiscountPoisha));
    const orderDiscountPoisha = add(
      poisha(input.discountPoisha ?? 0n),
      poisha(priced === null ? 0n : priced.discountPoisha),
    );

    /*
     * Totals twice, because a credit cannot be capped before the order is priced.
     *
     * §9 rejects a negative COD, so an exchange credit larger than the replacement is
     * worth is applied up to the payable and the remainder stays in `customer_advance`
     * as a store credit (`applicableAdvance`). The first pass exists only to learn the
     * payable; nothing is written from it.
     */
    const withoutAdvance = computeOrderTotals({
      lines: lines.map((line) => ({
        qty: line.qty,
        unitPricePoisha: poisha(line.unitPricePoisha),
        lineDiscountPoisha: poisha(line.discountPoisha),
      })),
      orderDiscountPoisha: poisha(orderDiscountPoisha),
      deliveryChargePoisha: poisha(deliveryChargePoisha),
    });

    const advancePaidPoisha =
      options.creditPoisha !== undefined
        ? BigInt(
            applicableAdvance({
              netItemsPoisha: withoutAdvance.netItemsPoisha,
              deliveryChargePoisha: withoutAdvance.deliveryChargePoisha,
              creditPoisha: poisha(options.creditPoisha),
            }).appliedPoisha,
          )
        : // No advance on a create body (D-230): an advance is a verified claim, never a number.
          0n;

    const totals = computeOrderTotals({
      lines: lines.map((line) => ({
        qty: line.qty,
        unitPricePoisha: poisha(line.unitPricePoisha),
        lineDiscountPoisha: poisha(line.discountPoisha),
      })),
      orderDiscountPoisha: poisha(orderDiscountPoisha),
      deliveryChargePoisha: poisha(deliveryChargePoisha),
      advancePaidPoisha: poisha(advancePaidPoisha),
    });

    if (input.locationId !== undefined) {
      // Checked at creation as well as at every transition, so the refusal arrives while
      // the agent is still on the phone rather than at the confirm that reserves stock.
      await this.assertShippableLocation(tx, context, input.locationId);
    }
    const holdAt = options.holdStockAt;
    if (holdAt !== undefined) {
      if (input.locationId !== undefined && input.locationId !== holdAt) {
        throw new OrdersError(
          'STOCK_LOCATION_INVALID',
          'An order is held at the location it ships from; name one location, not two.',
        );
      }
      await this.assertShippableLocation(tx, context, holdAt);
    }

    /*
     * M42 (D-742): an order names the inbox conversation it came from only when its taker can
     * read the inbox. The inbox links that conversation's contact to this buyer when it hears
     * the order, so the field is not for a role that has no inbox (a branch manager, a reseller).
     */
    if (
      input.source?.inboxConversationId !== undefined &&
      !defineAbilityFor(context).can('read', 'Conversation')
    ) {
      throw new OrdersError(
        'VALIDATION_FAILED',
        'source.inboxConversationId: only someone who answers the inbox names a conversation.',
      );
    }

    const orderNo = await this.nextOrderNo(tx, context, at);
    const deliveryZoneId = zone?.id ?? options.fallbackDeliveryZoneId ?? null;
    // The order's courier: the one named, else the brand's default by §9's rule (D-952: the
    // zone's, else the brand's chosen one, else its only courier), so a brand with no zone, or a
    // zone with no default, still sends each new order to its courier.
    const courierId =
      input.courierId ??
      zone?.defaultCourierId ??
      (await repo.deliveryFallbackCourier(tx, context.orgId, deliveryZoneId)) ??
      null;
    const orderId = await repo.insertOrder(tx, {
      orgId: context.orgId,
      branchId: input.branchId ?? null,
      orderNo,
      channel: input.channel,
      source: input.source ?? {},
      customerId: buyer.id,
      shipName: shipTo.name,
      shipPhoneE164: shipTo.phoneE164,
      shipDistrictId: shipTo.districtId,
      shipThanaId: shipTo.thanaId,
      shipArea: shipTo.area,
      shipAddressLine: shipTo.addressLine,
      deliveryZoneId,
      courierId,
      locationId: holdAt ?? input.locationId ?? null,
      stockHeldAt: holdAt === undefined ? null : at,
      itemsPoisha: BigInt(totals.itemsPoisha),
      discountPoisha: BigInt(totals.discountPoisha),
      deliveryChargePoisha: BigInt(totals.deliveryChargePoisha),
      advancePaidPoisha: BigInt(totals.advancePaidPoisha),
      codAmountPoisha: BigInt(totals.codAmountPoisha),
      promoCodeId: priced?.codeId ?? options.promoCodeId ?? null,
      assignedTo: input.assignedTo ?? null,
      createdBy: context.userId,
      notes: input.notes ?? null,
      exchangeOfOrderId: options.exchangeOfOrderId ?? null,
      placedFor: behalf.placedFor,
      recipientCustomerId: behalf.recipientCustomerId,
      placedForNote: behalf.placedFor === 'someone_else' ? (input.placedForNote ?? null) : null,
      // D-876: an automatic pick among several people on one number is the desk's to check.
      buyerCheck: buyer.shared ? 'shared_number' : null,
    });

    // The order row now exists, so the redemption's foreign key has something to name.
    // Same transaction: if the code's last use went to another order while this one was
    // being priced, the conditional UPDATE inside refuses, and this order rolls back with
    // it rather than keeping a discount it was not given.
    if (priced !== null) await this.promo.redeemForOrder(tx, context, priced, orderId);

    for (const [index, line] of lines.entries()) {
      await repo.insertOrderLine(tx, {
        orgId: context.orgId,
        orderId,
        skuId: line.skuId,
        skuCode: line.skuCode,
        productName: line.productName,
        qty: line.qty,
        unitPricePoisha: line.unitPricePoisha,
        discountPoisha: line.discountPoisha,
        position: index,
      });
    }

    if (holdAt !== undefined) {
      /*
       * The website's hold (D-532): the lines are reserved now, with M07's atomic conditional
       * UPDATE, so two shoppers racing for the last unit cannot both be sold it. A line the
       * location cannot hold throws `STOCK_INSUFFICIENT` and the whole order rolls back.
       */
      await this.inventory.reserve(
        tx,
        { orgId: context.orgId, userId: context.userId },
        {
          refType: 'order',
          refId: orderId,
          lines: lines.map((line) => ({ skuId: line.skuId, locationId: holdAt, qty: line.qty })),
        },
      );
    }

    /*
     * The order's own history starts here, with no `from`.
     *
     * §9: "every transition writes an outbox event and an audit row". Creation is not a
     * transition, and the row still has to exist — otherwise the first entry in an
     * order's history is whatever happened to it next, and "who entered this and when"
     * is answerable only from `created_by` and `created_at`, which a later edit could
     * make misleading.
     */
    await repo.insertOrderEvent(tx, {
      orgId: context.orgId,
      orderId,
      fromStatus: null,
      toStatus: 'pending',
      trigger: 'create',
      reason: null,
      actorUserId: context.userId,
      businessDate: businessDate(at),
      occurredAt: at,
    });

    await this.customers.applyStats(tx, context.orgId, buyer.id, { orders: 1, orderedAt: at });

    await emit(
      tx,
      'order.created',
      {
        id: orderId,
        orderNo,
        channel: input.channel,
        codAmountPoisha: BigInt(totals.codAmountPoisha).toString(),
        assignedTo: input.assignedTo ?? null,
        createdAt: at.toISOString(),
      },
      { orgId: context.orgId },
    );

    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'create',
      action: 'order.created',
      entityType: 'order',
      entityId: orderId,
      // Named `phone` so the audit redactor masks it (invariant 10), and no cost field
      // exists to leak: the lines carry selling prices only.
      after: {
        orderNo,
        channel: input.channel,
        phone: shipTo.phoneE164,
        codAmountPoisha: BigInt(totals.codAmountPoisha).toString(),
        lines: lines.length,
        exchangeOfOrderId: options.exchangeOfOrderId ?? null,
        placedFor: behalf.placedFor,
        recipientCustomerId: behalf.recipientCustomerId,
        buyerCheck: buyer.shared ? 'shared_number' : null,
      },
      request,
    });

    return {
      id: orderId,
      orderNo,
      status: 'pending',
      codAmountPoisha: BigInt(totals.codAmountPoisha).toString(),
      advancePaidPoisha: BigInt(totals.advancePaidPoisha).toString(),
    };
  }

  /**
   * Change an order that has not gone out yet (§24's order desk).
   *
   * Line changes on a `confirmed` or `on_hold` order release the reservation and reserve
   * the new set, in that order and in this transaction. Not a diff: releasing first and
   * reserving after means the units the order already held are available to it, so
   * dropping one unit of a scarce SKU cannot fail because the order is competing with
   * itself. If the new set cannot be held, the whole edit rolls back and the *old*
   * reservation stands — which is why the release is not a separate request.
   */
  async edit(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    patch: UpdateOrderInput,
  ) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) =>
        this.editIn(tx, context, request, id, patch),
      ),
    );
  }

  /**
   * The edit, in the caller's transaction (M35b: an order the ncom.bd marketplace handed over
   * and then changed, D-556). `system` is set only by `OrdersApiService`: the change comes from
   * a server whose prices the order already carries, so there is no person's scope to apply
   * and no agent's discount ceiling (D-364), as for `createIn`'s `systemPricing`.
   */
  async editIn(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    patch: UpdateOrderInput,
    options: { readonly system?: true; readonly offersChecked?: true } = {},
  ) {
    const order =
      options.system === true
        ? await this.lockSystem(tx, context, id)
        : await this.lockForAct(tx, context, request, id, 'edit');
    const editable: readonly string[] = ['pending', 'confirmed', 'on_hold'];
    if (!editable.includes(order.status)) {
      throw new OrdersError(
        'ORDER_IMMUTABLE',
        `An order that is ${order.status} can no longer be edited; its terms are already on an invoice.`,
      );
    }

    /*
     * An order a promo code priced keeps its price (ledger audit W2).
     *
     * The redemption records what the code gave against these lines, this discount and
     * this delivery charge; changing any of them would leave the code's use spent on a
     * price that no longer exists — or bring back a charge a free-delivery code took
     * off. Re-pricing a code on an edit is its own decision; until then the honest path
     * is to cancel the order (which gives the use back) and take it again.
     */
    const repricing =
      patch.lines !== undefined ||
      patch.discountPoisha !== undefined ||
      patch.deliveryChargePoisha !== undefined;
    /*
     * M35a: a website order can carry several discounts and no single `promo_code_id`,
     * and its lines can hold flash-sale units claimed at a sale price (D-542). A line
     * edit replaces the lines, which would orphan the claims (their foreign key refuses
     * it) and leave the sale's sold count describing lines that no longer exist.
     */
    const holds = repricing
      ? await this.promo.holdsOnOrder(tx, context.orgId, order.id)
      : { appliedDiscounts: 0, flashClaims: 0 };
    /*
     * M50 (D-921): an edit that names its offers re-prices them on purpose. The order's
     * discounts are given back and the chosen ones priced against the edited basket and taken
     * again, in this transaction, so the use spent and the price charged stay one number.
     */
    const offersMode = patch.discountIds !== undefined;
    if (!offersMode && repricing && (order.promo_code_id !== null || holds.appliedDiscounts > 0)) {
      throw new OrdersError(
        'ORDER_IMMUTABLE',
        'A promo code priced this order, so its lines, discount and delivery charge are fixed. Cancel it and take it again to change them.',
      );
    }
    if (patch.lines !== undefined && holds.flashClaims > 0) {
      throw new OrdersError(
        'ORDER_IMMUTABLE',
        'Flash-sale prices priced this order’s lines, so they are fixed. Cancel it and take it again to change them.',
      );
    }

    const existing = await repo.orderLines(tx, context.orgId, order.id);
    const lines =
      patch.lines === undefined
        ? existing.map((line) => ({
            skuId: line.sku_id,
            skuCode: line.sku_code,
            productName: line.product_name,
            qty: line.qty,
            unitPricePoisha: BigInt(line.unit_price_poisha),
            discountPoisha: BigInt(line.discount_poisha),
          }))
        : await this.priceLines(tx, context, patch.lines);

    /*
     * The order-level discount, derived rather than stored.
     *
     * `orders.discount_poisha` is the total §9 names and the COD CHECK re-derives
     * from, so the order-level part is what is left after the lines' own discounts.
     * The same derivation as `TransitionsService.orderLevelDiscount`, for the same
     * reason: two columns holding one number is two numbers that must agree.
     */
    const existingLineDiscounts = existing.reduce(
      (total, line) => total + BigInt(line.discount_poisha),
      0n,
    );
    const existingOrderLevel = bigintMax(BigInt(order.discount_poisha) - existingLineDiscounts, 0n);
    // M50: what the offers on the order gave, so the typed discount and the charge before any
    // offer can be told apart from them.
    const existingOffers = offersMode
      ? await this.promo.appliedOnOrder(tx, context.orgId, order.id)
      : [];
    const existingOfferGoods = existingOffers.reduce(
      (total, offer) => total + BigInt(offer.discountPoisha),
      0n,
    );
    const existingOfferDelivery = existingOffers.reduce(
      (total, offer) => total + BigInt(offer.deliveryDiscountPoisha),
      0n,
    );
    const existingTyped = bigintMax(existingOrderLevel - existingOfferGoods, 0n);
    // The person's own order discount: in offers mode, without what the offers give.
    const typedDiscountPoisha =
      patch.discountPoisha !== undefined
        ? BigInt(patch.discountPoisha)
        : offersMode
          ? existingTyped
          : existingOrderLevel;

    if (
      options.system !== true &&
      (patch.lines !== undefined || patch.discountPoisha !== undefined)
    ) {
      // An offer is the brand's discount, not the person's: only the typed one meets the
      // role's ceiling (D-364).
      await this.assertDiscountCeiling(
        tx,
        context,
        { lines, orderDiscountPoisha: typedDiscountPoisha },
        {
          lines: existing.map((line) => ({
            skuId: line.sku_id,
            qty: line.qty,
            unitPricePoisha: BigInt(line.unit_price_poisha),
            discountPoisha: BigInt(line.discount_poisha),
          })),
          orderDiscountPoisha: offersMode ? existingTyped : existingOrderLevel,
        },
      );
    }

    const baseDeliveryChargePoisha =
      patch.deliveryChargePoisha !== undefined
        ? BigInt(patch.deliveryChargePoisha)
        : BigInt(order.delivery_charge_poisha) + existingOfferDelivery;

    let offerGoods = 0n;
    let offerDelivery = 0n;
    let chosen: Awaited<ReturnType<PromoPort['quoteChosen']>> | null = null;
    if (offersMode) {
      // Applying an offer the order does not carry is the "apply codes" grant (§6).
      const carried = new Set(existingOffers.map((offer) => offer.discountId));
      if (
        options.system !== true &&
        options.offersChecked !== true &&
        (patch.discountIds ?? []).some((id) => !carried.has(id))
      ) {
        assertMayApplyOffers(context);
      }
      await this.promo.lockForReprice(tx, context.orgId, order.id, patch.discountIds ?? []);
      await this.promo.releaseForOrder(tx, context.orgId, order.id);
      chosen = await this.promo.quoteChosen(tx, context.orgId, {
        lines: lines.map((line) => ({
          skuId: line.skuId,
          qty: line.qty,
          netPoisha: sub(
            mulQty(poisha(line.unitPricePoisha), line.qty),
            poisha(line.discountPoisha),
          ).toString(),
        })),
        orderDiscountPoisha: typedDiscountPoisha.toString(),
        deliveryChargePoisha: baseDeliveryChargePoisha.toString(),
        channel: order.channel,
        customerId: order.customer_id,
        excludeOrderId: order.id,
        now: new Date(),
        discountIds: patch.discountIds ?? [],
      });
      assertAllChosenApply(patch.discountIds ?? [], chosen);
      offerGoods = BigInt(chosen.discountPoisha);
      offerDelivery = BigInt(chosen.deliveryDiscountPoisha);
    }
    const orderDiscountPoisha = typedDiscountPoisha + offerGoods;
    const deliveryChargePoisha = bigintMax(baseDeliveryChargePoisha - offerDelivery, 0n);

    const totals = computeOrderTotals({
      lines: lines.map((line) => ({
        qty: line.qty,
        unitPricePoisha: poisha(line.unitPricePoisha),
        lineDiscountPoisha: poisha(line.discountPoisha),
      })),
      orderDiscountPoisha: poisha(orderDiscountPoisha),
      deliveryChargePoisha: poisha(deliveryChargePoisha),
      // An advance is a posted journal, so the edit carries it across untouched.
      advancePaidPoisha: poisha(BigInt(order.advance_paid_poisha)),
    });

    const patchArea = patch.shipTo === undefined ? undefined : await this.areaOf(tx, patch.shipTo);
    const shipTo: ShipTo =
      patch.shipTo === undefined
        ? {
            name: order.ship_name,
            phoneE164: order.ship_phone_e164,
            districtId: order.ship_district_id,
            thanaId: order.ship_thana_id,
            area: order.ship_area,
            addressLine: order.ship_address_line,
          }
        : {
            name: patch.shipTo.name ?? order.ship_name,
            // M48 (D-878): the recipient's number, when the parcel is someone else's.
            phoneE164:
              patch.shipTo.phone === undefined
                ? order.ship_phone_e164
                : normalizeBdPhone(patch.shipTo.phone),
            districtId: patchArea?.districtId ?? null,
            thanaId: patchArea?.thanaId ?? null,
            area: patch.shipTo.area ?? null,
            addressLine: patch.shipTo.addressLine,
          };

    const linesChanged = patch.lines !== undefined && !sameLines(existing, lines);
    const nextLocationId = patch.locationId ?? order.location_id;
    const locationChanged = nextLocationId !== order.location_id;
    // A confirmed or held order, and a website order its checkout held (D-532).
    const holdsStock = holdsStockNow(order.status as OrderStatus, order.stock_held_at !== null);
    /*
     * A moved fulfilment location needs the hold moved with it.
     *
     * `inventory.reservations` is keyed on `(sku, location)`, so an edit that changed
     * only `location_id` would leave the units held at the warehouse the order is no
     * longer shipping from — reserved where nobody will pick them, and unavailable to
     * the orders that will. So the reservation is rewritten for a location change as
     * well as for a line change.
     */
    const rewriteReservation = holdsStock && (linesChanged || locationChanged);
    if (rewriteReservation) {
      await this.inventory.release(
        tx,
        { orgId: context.orgId, userId: context.userId },
        { refType: 'order', refId: order.id },
      );
    }
    if (linesChanged) {
      await repo.deleteOrderLines(tx, context.orgId, order.id);
      for (const [index, line] of lines.entries()) {
        await repo.insertOrderLine(tx, {
          orgId: context.orgId,
          orderId: order.id,
          skuId: line.skuId,
          skuCode: line.skuCode,
          productName: line.productName,
          qty: line.qty,
          unitPricePoisha: line.unitPricePoisha,
          discountPoisha: line.discountPoisha,
          position: index,
        });
      }
    }

    await this.transitions.assertCourierChangeAllowed(tx, context.orgId, order, patch.courierId);
    const moved = await repo.updateOrderCommercials(tx, {
      orgId: context.orgId,
      orderId: order.id,
      itemsPoisha: BigInt(totals.itemsPoisha),
      discountPoisha: BigInt(totals.discountPoisha),
      deliveryChargePoisha: BigInt(totals.deliveryChargePoisha),
      advancePaidPoisha: BigInt(totals.advancePaidPoisha),
      codAmountPoisha: BigInt(totals.codAmountPoisha),
      shipName: shipTo.name,
      shipPhoneE164: shipTo.phoneE164,
      shipDistrictId: shipTo.districtId,
      shipThanaId: shipTo.thanaId,
      shipArea: shipTo.area,
      shipAddressLine: shipTo.addressLine,
      deliveryZoneId: patch.deliveryZoneId ?? order.delivery_zone_id,
      courierId: patch.courierId ?? order.courier_id,
      locationId: nextLocationId,
      notes: patch.notes ?? order.notes,
    });
    if (!moved) {
      // The order was dispatched between the lock and here, which the lock should
      // have made impossible — so this is the backstop for a caller that reached
      // `edit` without one.
      throw new OrdersError(
        'ORDER_IMMUTABLE',
        'This order moved while the edit was in flight; reload and try again.',
      );
    }
    if (chosen !== null) {
      // After the row, like an order's create: the uses are taken in this transaction, so an
      // offer that ran out since the quote rolls the whole edit back.
      await this.promo.redeem(tx, context.orgId, {
        orderId: order.id,
        customerId: order.customer_id,
        applied: chosen.applied,
      });
      await repo.setOrderPromoCode(tx, {
        orgId: context.orgId,
        orderId: order.id,
        promoCodeId: chosen.applied.find((entry) => entry.method === 'code')?.discountId ?? null,
      });
    }

    if (rewriteReservation) {
      // Resolved from the order *as edited*, not as read: passing the old row here
      // would hold the new lines at the old location, which is the bug the release
      // above exists to avoid. It goes through the kind check too, so an edit cannot
      // move an order onto a shelf it may not ship from.
      const locationId = await this.fulfilmentLocation(
        tx,
        context,
        { ...order, location_id: nextLocationId },
        nextLocationId ?? undefined,
      );
      await this.inventory.reserve(
        tx,
        { orgId: context.orgId, userId: context.userId },
        {
          refType: 'order',
          refId: order.id,
          lines: lines.map((line) => ({ skuId: line.skuId, locationId, qty: line.qty })),
        },
      );
    }

    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'update',
      action: 'order.edited',
      entityType: 'order',
      entityId: order.id,
      before: {
        codAmountPoisha: String(order.cod_amount_poisha),
        lines: existing.length,
      },
      after: {
        codAmountPoisha: BigInt(totals.codAmountPoisha).toString(),
        lines: lines.length,
        linesChanged,
        ...(chosen === null ? {} : { offers: chosen.applied.map((entry) => entry.discountId) }),
      },
      request,
    });
    // M35b: the order as it now stands goes to whoever listens (ncom.bd for its own orders,
    // D-556), in this transaction like every order event.
    await emit(
      tx,
      'order.edited',
      { id: order.id, orderNo: order.order_no, at: new Date().toISOString() },
      { orgId: context.orgId },
    );

    const after = await repo.orderById(tx, context.orgId, order.id);
    return after === undefined ? { id: order.id } : toOrderView(after);
  }

  // --- M50: the order editor (D-921 to D-924) ----------------------------------------------

  /**
   * The editor's offers panel and its totals (M50, D-921). Reads only; nothing is claimed.
   *
   * `edit` prices the lines as edited at the server's own prices (`priceLines`), with the
   * person's typed discount and the charge before any offer. `return` prices what the buyer
   * keeps of a parcel with the courier at the order's own prices (`repriceReturn`, D-924). Either
   * way every live offer comes back with what it gives or why it does not, and the chosen ones
   * are quoted through the engine the save uses, so the panel shows what will be charged.
   */
  async editorOffers(context: ActiveContext, request: object, id: string, input: OrderOffersInput) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        // Offers are a staff tool: a reseller's own order shows no brand's codes (D-098).
        if (!context.isSuperAdmin && !context.roles.some((role) => role !== 'reseller')) {
          throw new OrdersError('FORBIDDEN', 'Offers are for the brand’s staff.');
        }
        // A read the editor repeats as the person types: no row lock.
        const order = await repo.orderByIdInScope(
          tx,
          context.orgId,
          id,
          orderScopeSql(context, request),
        );
        if (order === undefined) throw new OrdersError('ORDER_NOT_FOUND', 'No such order.');
        // A code's word is shown only to someone who may apply codes.
        const showCodes = defineAbilityFor(context).can('read', 'LandingPage');
        const offerView = (offer: OfferView) => toOfferView(offer, showCodes);
        const appliedView = (entry: AppliedDiscountView) => toAppliedView(entry, showCodes);
        const shared = {
          channel: order.channel,
          customerId: order.customer_id,
          excludeOrderId: order.id,
          now: new Date(),
        };
        const fee = BigInt(input.deliveryChargePoisha);

        if (input.mode === 'edit') {
          const lines = await this.priceLines(tx, context, input.lines);
          const typed = BigInt(input.discountPoisha ?? '0');
          const basket = {
            ...shared,
            lines: lines.map((line) => ({
              skuId: line.skuId,
              qty: line.qty,
              netPoisha: sub(
                mulQty(poisha(line.unitPricePoisha), line.qty),
                poisha(line.discountPoisha),
              ).toString(),
            })),
            orderDiscountPoisha: typed.toString(),
            deliveryChargePoisha: fee.toString(),
          };
          const offers = await this.promo.offersForOrder(tx, context.orgId, basket);
          const chosen = await this.promo.quoteChosen(tx, context.orgId, {
            ...basket,
            discountIds: input.discountIds,
          });
          const totals = computeOrderTotals({
            lines: lines.map((line) => ({
              qty: line.qty,
              unitPricePoisha: poisha(line.unitPricePoisha),
              lineDiscountPoisha: poisha(line.discountPoisha),
            })),
            orderDiscountPoisha: poisha(typed + BigInt(chosen.discountPoisha)),
            deliveryChargePoisha: poisha(
              bigintMax(fee - BigInt(chosen.deliveryDiscountPoisha), 0n),
            ),
            advancePaidPoisha: poisha(BigInt(order.advance_paid_poisha)),
          });
          return {
            mode: 'edit' as const,
            offers: offers.map(offerView),
            applied: chosen.applied.map(appliedView),
            offerDiscountPoisha: chosen.discountPoisha.toString(),
            offerDeliveryDiscountPoisha: chosen.deliveryDiscountPoisha.toString(),
            totals: {
              itemsPoisha: totals.itemsPoisha.toString(),
              discountPoisha: totals.discountPoisha.toString(),
              deliveryChargePoisha: totals.deliveryChargePoisha.toString(),
              advancePaidPoisha: totals.advancePaidPoisha.toString(),
              codAmountPoisha: totals.codAmountPoisha.toString(),
            },
          };
        }

        if (order.status !== 'shipped') {
          throw new OrdersError(
            'ORDER_TRANSITION_INVALID',
            'Only an order that is with the courier can be returned here.',
          );
        }
        const lines = await repo.orderLines(tx, context.orgId, order.id);
        const keep = new Map(input.keep.map((entry) => [entry.skuId, entry.qty]));
        for (const skuId of keep.keys()) {
          if (!lines.some((line) => line.sku_id === skuId)) {
            throw new OrdersError('ORDER_LINES_INVALID', 'That item is not on this order.');
          }
        }
        const lineDiscounts = lines.reduce(
          (total, line) => total + BigInt(line.discount_poisha),
          0n,
        );
        const orderLevel = poisha(bigintMax(BigInt(order.discount_poisha) - lineDiscounts, 0n));
        // The person's own part of it: what is left after the order's offers (ledger audit C1).
        const offersGave = (await this.promo.appliedOnOrder(tx, context.orgId, order.id)).reduce(
          (total, offer) => total + BigInt(offer.discountPoisha),
          0n,
        );
        const typedOrderDiscount = poisha(bigintMax(orderLevel - offersGave, 0n));
        const repriceLines = lines.map((line) => ({
          qty: line.qty,
          unitPricePoisha: poisha(BigInt(line.unit_price_poisha)),
          lineDiscountPoisha: poisha(BigInt(line.discount_poisha)),
          keptQty: keep.get(line.sku_id) ?? line.qty,
        }));
        const kept = repriceReturn({
          lines: repriceLines,
          orderDiscountPoisha: orderLevel,
          deliveryChargePoisha: poisha(BigInt(order.delivery_charge_poisha)),
          advancePaidPoisha: poisha(BigInt(order.advance_paid_poisha)),
          offerDiscountPoisha: poisha(0n),
          typedOrderDiscountPoisha: typedOrderDiscount,
          newDeliveryChargePoisha: poisha(fee),
        });
        if (kept.keptUnits === 0) {
          return {
            mode: 'return' as const,
            wholeReturn: true,
            offers: [],
            applied: [],
            offerDiscountPoisha: '0',
            offerDeliveryDiscountPoisha: '0',
            keptNetPoisha: '0',
            typedDiscountPoisha: '0',
            deliveryChargePoisha: '0',
            advanceAppliedPoisha: '0',
            expectedPoisha: '0',
            collectPoisha: '0',
          };
        }
        const basket = {
          ...shared,
          lines: lines.flatMap((line, index) => {
            const qty = repriceLines[index]?.keptQty ?? 0;
            const net = kept.keptLineNetPoisha[index];
            return qty === 0 || net === undefined
              ? []
              : [{ skuId: line.sku_id, qty, netPoisha: net.toString() }];
          }),
          // Offers are priced after the person's own discount, as on the desk (W3).
          orderDiscountPoisha: kept.keptTypedDiscountPoisha.toString(),
          deliveryChargePoisha: fee.toString(),
        };
        const offers = await this.promo.offersForOrder(tx, context.orgId, basket);
        const chosen = await this.promo.quoteChosen(tx, context.orgId, {
          ...basket,
          discountIds: input.discountIds,
        });
        const charge = bigintMax(fee - BigInt(chosen.deliveryDiscountPoisha), 0n);
        const priced = repriceReturn({
          lines: repriceLines,
          orderDiscountPoisha: orderLevel,
          deliveryChargePoisha: poisha(BigInt(order.delivery_charge_poisha)),
          advancePaidPoisha: poisha(BigInt(order.advance_paid_poisha)),
          offerDiscountPoisha: poisha(BigInt(chosen.discountPoisha)),
          typedOrderDiscountPoisha: typedOrderDiscount,
          newDeliveryChargePoisha: poisha(charge),
        });
        return {
          mode: 'return' as const,
          wholeReturn: false,
          offers: offers.map(offerView),
          applied: chosen.applied.map(appliedView),
          typedDiscountPoisha: priced.keptTypedDiscountPoisha.toString(),
          offerDiscountPoisha: chosen.discountPoisha.toString(),
          offerDeliveryDiscountPoisha: chosen.deliveryDiscountPoisha.toString(),
          keptNetPoisha: priced.keptNetPoisha.toString(),
          deliveryChargePoisha: charge.toString(),
          advanceAppliedPoisha: priced.advanceAppliedPoisha.toString(),
          expectedPoisha: priced.expectedPoisha.toString(),
          collectPoisha: priced.collectPoisha.toString(),
        };
      }),
    );
  }

  /**
   * The editor's product picker (M50, D-923): active products for what was typed (a name, a
   * SKU or parent SKU, a barcode, a website slug), or every product newest first when nothing
   * was, a page at a time to the last; or the products of these SKUs (an order's lines). Each
   * with its photo and every active size and colour at its selling price with the units in hand
   * at the location named, else where the desk sells from. Selling prices only, never a cost.
   */
  async picker(
    context: ActiveContext,
    query: {
      readonly q?: string | undefined;
      readonly offset?: number | undefined;
      readonly skuIds?: readonly string[] | undefined;
      readonly locationId?: string | undefined;
    },
  ) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        let page: Awaited<ReturnType<CatalogApi['pickerProducts']>>;
        if (query.skuIds !== undefined) {
          const skus = await this.catalog.skusByIds(tx, context.orgId, query.skuIds);
          page = await this.catalog.pickerProducts(tx, context.orgId, {
            ids: [...new Set(skus.map((sku) => sku.productId))],
            limit: 100,
          });
        } else {
          page = await this.catalog.pickerProducts(tx, context.orgId, {
            q: query.q ?? '',
            limit: PICKER_PAGE,
            offset: query.offset ?? 0,
          });
        }
        if (page.items.length === 0) return { items: [], nextOffset: page.nextOffset };
        const skus = await this.catalog.webSkus(
          tx,
          context.orgId,
          page.items.map((product) => product.id),
        );
        const location =
          query.locationId ?? (await repo.defaultFulfilmentLocation(tx, context.orgId, null))?.id;
        const available =
          location === undefined
            ? new Map<string, number>()
            : await this.inventory.availability(
                tx,
                context.orgId,
                location,
                skus.map((sku) => sku.id),
              );
        return {
          items: page.items.map((product) => ({
            id: product.id,
            name: product.name,
            imageFileId: product.imageFileId,
            matchedSkuId: product.matchedSkuId,
            variants: skus
              .filter((sku) => sku.productId === product.id)
              .map((sku) => ({
                skuId: sku.id,
                code: sku.code,
                size: sku.values.find((value) => value.kind === 'size')?.label ?? null,
                colour: sku.values.find((value) => value.kind === 'colour')?.label ?? null,
                label: sku.values.map((value) => value.label).join(' / '),
                pricePoisha: sku.pricePoisha.toString(),
                compareAtPoisha: sku.compareAtPoisha?.toString() ?? null,
                available: available.get(sku.id) ?? 0,
              })),
          })),
          nextOffset: page.nextOffset,
        };
      }),
    );
  }

  /**
   * A packed order changed (M50, D-922): cancelled and replaced, in one transaction.
   *
   * The owner's rule: "if the order is packed once but not sent to courier it has to be
   * cancelled then create another one". So a packed order is never edited in place. The
   * replacement is created with the changed terms (same buyer, address, courier, location,
   * branch and owner unless changed), the packed order is cancelled with the reason and the
   * replacement's number (its stock released, its parcel's booking cancelled, its discounts
   * given back, by the cancel's own effects), the chosen offers are applied to the replacement,
   * and the replacement is confirmed (its stock reserved, its label queued). If any step is
   * refused nothing happens: the packed order stays packed.
   *
   * An order holding an advance is refused for now: the cancel would turn the advance into a
   * refund owed rather than carry it to the replacement (follow-up in progress.md).
   */
  async replace(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    input: ReplaceOrderInput,
  ) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const order = await this.lockForAct(tx, context, request, id, 'edit');
        if (order.status !== 'packed') {
          throw new OrdersError(
            'ORDER_TRANSITION_INVALID',
            ['pending', 'confirmed', 'on_hold'].includes(order.status)
              ? 'This order is not packed yet; edit it instead.'
              : `An order that is ${order.status} cannot be replaced.`,
          );
        }
        if (BigInt(order.advance_paid_poisha) > 0n) {
          throw new OrdersError(
            'ORDER_IMMUTABLE',
            'This order holds an advance, so it cannot be replaced here yet. Cancel it and take the new order on the desk, or ask accounts to move the advance.',
          );
        }

        const existing = await repo.orderLines(tx, context.orgId, order.id);
        const offers = await this.promo.appliedOnOrder(tx, context.orgId, order.id);
        const carried = new Set(offers.map((offer) => offer.discountId));
        if ((input.discountIds ?? []).some((discountId) => !carried.has(discountId))) {
          assertMayApplyOffers(context);
        }
        // An inbox order's conversation is named only by someone who answers the inbox (D-742).
        const source: Record<string, unknown> = {
          ...((order.source ?? {}) as Record<string, unknown>),
        };
        if (!defineAbilityFor(context).can('read', 'Conversation')) {
          delete source.inboxConversationId;
        }
        const lineDiscounts = existing.reduce(
          (total, line) => total + BigInt(line.discount_poisha),
          0n,
        );
        const offerGoods = offers.reduce(
          (total, offer) => total + BigInt(offer.discountPoisha),
          0n,
        );
        const offerDelivery = offers.reduce(
          (total, offer) => total + BigInt(offer.deliveryDiscountPoisha),
          0n,
        );
        const typed =
          input.discountPoisha ??
          bigintMax(BigInt(order.discount_poisha) - lineDiscounts - offerGoods, 0n).toString();
        const baseFee =
          input.deliveryChargePoisha ??
          (BigInt(order.delivery_charge_poisha) + offerDelivery).toString();
        const notes = input.notes ?? order.notes;

        const created = await this.createIn(
          tx,
          context,
          request,
          {
            channel: order.channel as CreateOrderInput['channel'],
            source,
            customerId: order.customer_id,
            shipTo: input.shipTo ?? {
              name: order.ship_name,
              phone: order.ship_phone_e164,
              ...(order.ship_district_id === null ? {} : { districtId: order.ship_district_id }),
              ...(order.ship_thana_id === null ? {} : { thanaId: order.ship_thana_id }),
              ...(order.ship_area === null ? {} : { area: order.ship_area }),
              addressLine: order.ship_address_line,
            },
            placedFor: order.placed_for === 'someone_else' ? 'someone_else' : 'self',
            ...(order.recipient_customer_id === null
              ? {}
              : { recipientCustomerId: order.recipient_customer_id }),
            ...(order.placed_for_note === null ? {} : { placedForNote: order.placed_for_note }),
            ...(order.branch_id === null ? {} : { branchId: order.branch_id }),
            ...(order.location_id === null ? {} : { locationId: order.location_id }),
            ...(order.delivery_zone_id === null ? {} : { deliveryZoneId: order.delivery_zone_id }),
            ...(order.courier_id === null ? {} : { courierId: order.courier_id }),
            ...(order.assigned_to === null ? {} : { assignedTo: order.assigned_to }),
            deliveryChargePoisha: baseFee,
            discountPoisha: typed,
            ...(notes === null ? {} : { notes }),
            lines: input.lines,
          },
          {},
        );

        // Within the order history's 500 characters.
        const prefix = `Replaced by ${created.orderNo}: `;
        await this.transitions.move(tx, context, request, order, 'cancel', {
          reason: `${prefix}${input.reason.slice(0, 500 - prefix.length)}`,
        });

        if ((input.discountIds ?? []).length > 0) {
          await this.editIn(
            tx,
            context,
            request,
            created.id,
            {
              discountIds: input.discountIds ?? [],
              discountPoisha: typed,
              deliveryChargePoisha: baseFee,
            },
            { offersChecked: true },
          );
        }
        await repo.setReplacesOrder(tx, {
          orgId: context.orgId,
          orderId: created.id,
          replacesOrderId: order.id,
        });

        const replacement = await repo.orderForUpdate(tx, context.orgId, created.id);
        if (replacement === undefined) throw new Error('the replacement written here is gone');
        const confirmed = await this.transitions.move(
          tx,
          context,
          request,
          replacement,
          'confirm',
          {},
        );

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'order.replaced',
          entityType: 'order',
          entityId: order.id,
          before: { status: order.status, codAmountPoisha: String(order.cod_amount_poisha) },
          after: {
            replacementId: created.id,
            replacementNo: created.orderNo,
            codAmountPoisha: String(confirmed.order.cod_amount_poisha),
          },
          request,
        });

        return {
          id: created.id,
          orderNo: created.orderNo,
          replacedOrderId: order.id,
          replacedOrderNo: order.order_no,
        };
      }),
    );
  }

  /** A system caller's lock on an order of the brand, with no person's scope to apply. */
  private async lockSystem(tx: Tx, context: ActiveContext, id: string): Promise<repo.OrderRow> {
    const order = await repo.lockOrderInScope(tx, context.orgId, id, sql`true`);
    if (order === undefined) throw new OrdersError('ORDER_NOT_FOUND', 'No such order.');
    return order;
  }

  // --- transitions --------------------------------------------------------------

  /**
   * Confirm: lock the order in scope, then let the domain machine run and reserve the stock.
   *
   * M52 (D-941): an order above the brand's limit is asked how many lots it goes in. Only here:
   * a replacement is confirmed in the same step as the person's Replace, is not asked, and starts
   * as one lot for the label desk or the packer to change.
   */
  async confirm(context: ActiveContext, request: AuditableRequest, id: string, lots?: number) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const order = await this.lockForAct(tx, context, request, id, 'confirm');
        // Only an order this confirm can move: any other is refused by the machine, unasked.
        if (order.status === 'pending') {
          await this.handover.settleLots(tx, {
            orgId: context.orgId,
            orderId: order.id,
            orderNo: order.order_no,
            userId: context.userId,
            lots,
            request,
          });
        }
        const moved = await this.transitions.move(tx, context, request, order, 'confirm', {});
        return toOrderView(moved.order);
      }),
    );
  }

  /** Every other transition, which differ only in what they carry (§9). */
  async transition(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    trigger: OrderTrigger,
    options: MoveOptions = {},
  ) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const gated = DESK_TRIGGERS[trigger];
        const order =
          gated === undefined
            ? await this.readInScope(tx, context, request, id)
            : await this.lockForAct(tx, context, request, id, gated);
        // Every transition that posts reads its date from here, so §7's window is checked
        // once rather than in each of the five endpoints that accept one.
        const occurredAt = this.postingInstant(options.occurredAt);
        if (PARCEL_RECORDED.includes(trigger)) {
          await this.transitions.assertNoLiveParcel(tx, context.orgId, order.id);
        }
        await this.assertWorkflowStep(tx, context.orgId, order, trigger);
        if (trigger === 'ship' && options.courierId != null) {
          await this.transitions.assertCourierChangeAllowed(
            tx,
            context.orgId,
            order,
            options.courierId,
          );
          // Recorded before the handover posts, because §7's receivable is per courier
          // and the delivery journal reads the column.
          await repo.setOrderCourier(tx, {
            orgId: context.orgId,
            orderId: order.id,
            courierId: options.courierId,
          });
        }
        const moved = await this.transitions.move(tx, context, request, order, trigger, {
          ...options,
          occurredAt,
        });
        return toOrderView(moved.order);
      }),
    );
  }

  /** The same, for a caller that already holds the transaction (`OrdersApi`). */
  async transitionIn(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    orderId: string,
    trigger: OrderTrigger,
    options: MoveOptions = {},
  ): Promise<{ from: OrderStatus; to: OrderStatus }> {
    const order = await repo.orderForUpdate(tx, context.orgId, orderId);
    if (order === undefined) throw new OrdersError('ORDER_NOT_FOUND', 'No such order.');
    await this.assertWorkflowStep(tx, context.orgId, order, trigger);
    const moved = await this.transitions.move(tx, context, request, order, trigger, options);
    return { from: moved.result.from, to: moved.result.to };
  }

  /**
   * The hub's order of work (D-928): booked, its label printed, packed, then handed over. A Pack
   * (the desk's, the bulk one, the station's Finish) needs every lot's label printed with its
   * consignment, which the packing module answers; a person's Ship needs the order packed, and an
   * order in several lots every lot scanned at the handover (D-808). The order is locked already.
   * A courier's own status that ships an order does not come through here: the courier has it.
   */
  private async assertWorkflowStep(
    tx: Tx,
    orgId: string,
    order: repo.OrderRow,
    trigger: OrderTrigger,
  ): Promise<void> {
    const input = { orgId, orderId: order.id, orderNo: order.order_no };
    if (trigger === 'pack' && order.status === 'confirmed') {
      await this.handover.assertPackable(tx, input);
    }
    if (trigger === 'ship') {
      if (order.status === 'confirmed') {
        throw new OrdersError(
          'ORDER_NOT_PACKED',
          `Order ${order.order_no} is not packed yet: print its label and pack it before it goes to the courier.`,
        );
      }
      await this.handover.assertShippable(tx, input);
    }
  }

  // --- the queue (M10, M41: D-711, D-712) ---------------------------------------------

  /**
   * Hand an order to a person, or (the owner, or a supervisor) on to a colleague.
   *
   * `assignmentDecision` is the rule: the owner may hand their order on; org_admin,
   * branch_manager and super admins may reassign anyone's order in their scope; anybody may
   * take a queued order for themselves, and only a supervisor routes queued work to someone
   * else. The person named must hold a role that works orders in this brand. The previous
   * owner, when it was somebody other than the caller, is told.
   */
  async assign(context: ActiveContext, request: AuditableRequest, id: string, assignedTo: string) {
    return this.moveOwner(context, request, id, assignedTo, 'order.assigned');
  }

  /** Back to the unassigned queue: the owner's own call, or a supervisor's. */
  async release(context: ActiveContext, request: AuditableRequest, id: string) {
    return this.moveOwner(context, request, id, null, 'order.released');
  }

  /**
   * Take an unassigned order out of §6's queue (M41 check 1).
   *
   * The order is locked first and judged after, so of two people pressing "Take this order"
   * together, the second waits for the first and then finds the order taken. The loser is told
   * **who** has it (`ORDER_ALREADY_CLAIMED`, D-711) even when, as for a sales agent, the order
   * has just left their scope: a sales agent reaches the queue, and an order taken from it
   * moments ago is one they were looking at. Taking an order you already hold is a no-op.
   */
  async claim(context: ActiveContext, request: AuditableRequest, id: string) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const scope = orderScopeSql(context, request);
        const reach = context.roles.includes('sales')
          ? sql`(${scope} or o.assigned_to is not null)`
          : scope;
        const order = await repo.lockOrderInScope(tx, context.orgId, id, reach);
        if (order === undefined) throw new OrdersError('ORDER_NOT_FOUND', 'No such order.');
        if (order.assigned_to === context.userId) return toOrderView(order);
        if (
          order.assigned_to === null &&
          !TAKEABLE_STATUSES.includes(order.status as OrderStatus)
        ) {
          throw new OrdersError(
            'ORDER_ASSIGN_NOT_ALLOWED',
            `Order ${order.order_no} is ${order.status}: there is nothing left to handle at the desk.`,
          );
        }
        if (order.assigned_to !== null) {
          const name = await this.gate.nameOf(tx, context.orgId, order.assigned_to);
          throw new OrdersError(
            'ORDER_ALREADY_CLAIMED',
            `${name} took order ${order.order_no} first.`,
          );
        }
        await repo.assignOrder(tx, {
          orgId: context.orgId,
          orderId: order.id,
          assignedTo: context.userId,
          onlyIfUnassigned: true,
        });
        await this.offers.withdrawFor(tx, context.orgId, order.id);
        await emit(
          tx,
          'order.claimed',
          { id: order.id, orderNo: order.order_no, assignedTo: context.userId },
          { orgId: context.orgId },
        );
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'order.claimed',
          entityType: 'order',
          entityId: order.id,
          before: { assignedTo: null },
          after: { assignedTo: context.userId },
          request,
        });
        const after = await repo.orderById(tx, context.orgId, order.id);
        return after === undefined
          ? { id: order.id, assignedTo: context.userId }
          : toOrderView(after);
      }),
    );
  }

  private async moveOwner(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    target: string | null,
    action: 'order.assigned' | 'order.released',
  ) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        // D-725: a sales agent reaches a colleague's order here too, so a refusal names the owner.
        const order = await this.lockReadable(tx, context, request, id);
        const previous = order.assigned_to;
        /*
         * A supervisor reassigns only orders in their own scope (D-712): one a sales agent who is
         * also a branch manager reaches only through sales' reading (D-725) is not theirs to
         * move, so there they are judged as anyone else.
         */
        const supervising =
          isSupervisor(context.roles, context.isSuperAdmin) &&
          (await repo.orderByIdInScope(
            tx,
            context.orgId,
            order.id,
            orderScopeSql(context, request),
          )) !== undefined;
        const decision = assignmentDecision({
          ownerId: previous,
          callerId: context.userId,
          target,
          supervisor: supervising,
        });
        if (!decision.allowed) {
          const owner =
            previous === null ? null : await this.gate.nameOf(tx, context.orgId, previous);
          throw new OrdersError(
            'ORDER_ASSIGN_NOT_ALLOWED',
            owner === null
              ? 'Only a supervisor can give a queued order to somebody else. Take it yourself, or ask one.'
              : `${owner} is handling this order. Only they or a supervisor can hand it on.`,
          );
        }
        if (decision.change === 'unchanged') return toOrderView(order);
        if (target !== null && target !== context.userId) {
          await this.assertAssignable(tx, context, target, order.branch_id);
        }

        await repo.assignOrder(tx, {
          orgId: context.orgId,
          orderId: order.id,
          assignedTo: target,
          onlyIfUnassigned: false,
        });
        await this.offers.withdrawFor(tx, context.orgId, order.id);
        if (target === null) {
          await emit(
            tx,
            'order.released',
            { id: order.id, orderNo: order.order_no },
            { orgId: context.orgId },
          );
          // Back in New, so auto-assign may offer it to the next person (D-717).
          if (order.status === 'pending')
            await this.offers.queueDispatch(tx, context.orgId, order.id);
        } else {
          await emit(
            tx,
            'order.assigned',
            { id: order.id, orderNo: order.order_no, assignedTo: target },
            { orgId: context.orgId },
          );
        }
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action,
          entityType: 'order',
          entityId: order.id,
          before: { assignedTo: previous },
          after: { assignedTo: target, change: decision.change },
          request,
        });
        if (previous !== null && previous !== context.userId) {
          // A supervisor moved somebody's order: they hear it from the ERP, not the floor.
          await this.gate.tellOwner(tx, context, request, order, previous, decision.change);
        }

        const after = await repo.orderById(tx, context.orgId, order.id);
        return after === undefined ? { id: order.id, assignedTo: target } : toOrderView(after);
      }),
    );
  }

  /**
   * The person named holds a role that works orders in this brand and would still reach this
   * order once it is theirs (`canHoldOrder`, D-712): a branch manager limited to other branches
   * would be an owner nobody can reach.
   */
  private async assertAssignable(
    tx: Tx,
    context: ActiveContext,
    userId: string,
    branchId: string | null,
  ): Promise<void> {
    const members = await this.iam.activeMembers(tx, context.orgId, { roles: ORDER_HOLDING_ROLES });
    const scopes = members.some((member) => member.userId === userId)
      ? await this.iam.roleScopes(tx, context.orgId, userId)
      : [];
    if (!canHoldOrder(scopes, branchId)) {
      throw new OrdersError(
        'ORDER_ASSIGNEE_INVALID',
        'That person cannot hold this order: they do not work orders here, or not this branch’s.',
      );
    }
  }

  // --- verification calls (M41, D-718) -------------------------------------------------

  /** Record one call to the buyer: the owner's work, so the owner's gate applies. */
  async logCall(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    input: CallAttemptInput,
  ) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const order = await this.lockForAct(tx, context, request, id, 'call');
        return this.recordCallOn(tx, context, request, order, input);
      }),
    );
  }

  /**
   * M47 (D-834, D-838): an order a person calls about through Envo, or records a phone call's
   * outcome on, locked in their own desk scope from their context (the route declares
   * `PhoneCall`, not `Order`), and M41's owner gate for the act `call`.
   */
  async lockForPhoneCall(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
  ): Promise<repo.OrderRow> {
    const order = await repo.lockOrderInScope(tx, context.orgId, id, deskActScopeFor(context));
    if (order === undefined) throw new OrdersError('ORDER_NOT_FOUND', 'No such order.');
    await this.gate.check(tx, context, request, order, 'call');
    return order;
  }

  /** One verification attempt on a locked order, its queue summary and its audit row (D-718). */
  async recordCallOn(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    order: repo.OrderRow,
    input: CallAttemptInput,
  ) {
    if (!CALLABLE_STATUSES.includes(order.status as OrderStatus)) {
      throw new OrdersError(
        'ORDER_CALL_INVALID',
        `Order ${order.order_no} is ${order.status}: its verification calls are over.`,
      );
    }
    const callBackAt = input.callBackAt === undefined ? null : new Date(input.callBackAt);
    const problem = callAttemptProblem({
      outcome: input.outcome,
      callBackAt,
      now: new Date(),
    });
    if (problem !== null) throw new OrdersError('ORDER_CALL_INVALID', problem);
    const note = input.note === undefined || input.note === '' ? null : input.note;
    const row = await repo.recordCallAttempt(tx, {
      orgId: context.orgId,
      orderId: order.id,
      outcome: input.outcome,
      callBackAt,
      note,
      calledBy: context.userId,
    });
    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'create',
      action: 'order.call_logged',
      entityType: 'order',
      entityId: order.id,
      after: {
        callId: row.id,
        outcome: input.outcome,
        callBackAt: callBackAt === null ? null : callBackAt.toISOString(),
        attempt: order.call_attempts + 1,
      },
      request,
    });
    return toCallView(row);
  }

  async calls(context: ActiveContext, request: object, id: string) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const order = await repo.orderByIdInScope(
          tx,
          context.orgId,
          id,
          orderScopeSql(context, request),
        );
        if (order === undefined) throw new OrdersError('ORDER_NOT_FOUND', 'No such order.');
        const rows = await repo.callAttemptsOf(tx, context.orgId, order.id);
        // The desk's notes and names are staff's; a reseller sees that calls were made (D-718).
        const staff = context.isSuperAdmin || context.roles.some((role) => role !== 'reseller');
        return {
          orderId: order.id,
          items: rows
            .map(toCallView)
            .map((call) => (staff ? call : { ...call, note: null, calledBy: '' })),
        };
      }),
    );
  }

  // --- the hub (M41, D-719) ----------------------------------------------------------

  /**
   * The hub printed these confirmed orders' slips: they move from "To print" to "Packing". The
   * PDF itself is `GET /v1/orders/documents`, which stays a read.
   */
  async markPrinted(context: ActiveContext, request: AuditableRequest, ids: readonly string[]) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const marked = await repo.markSlipsPrinted(
          tx,
          context.orgId,
          ids,
          orderScopeSql(context, request),
        );
        for (const order of marked) {
          await this.audit.record(tx, {
            orgId: context.orgId,
            actorUserId: context.userId,
            operation: 'update',
            action: 'order.slip_printed',
            entityType: 'order',
            entityId: order.id,
            after: { orderNo: order.order_no },
            request,
          });
        }
        return { marked: marked.map((order) => order.id) };
      }),
    );
  }

  // --- exchange -----------------------------------------------------------------

  /**
   * Exchange a delivered order for a replacement (§9's last transition row, check 7).
   *
   * Four things in one transaction, in this order and for these reasons:
   *
   * 1. **The units come back at their dispatch cost**, through
   *    `INVENTORY_API.receiveCustomerReturn`. Today's average would let a price rise
   *    between delivery and exchange create inventory value out of a swap.
   * 2. **The journal** `orderExchangeDraft` undoes the sale of those units against the
   *    accounts that received it: Dr Inventory / Cr COGS and Dr Sales revenue / Cr
   *    Customer advance. The buyer's money becomes a credit, not a refund.
   * 3. **The original moves to `exchange`** through the domain machine, with
   *    `callerHandlesExchange` set — the machine declares the `create_exchange_order`
   *    effect and this method is the one performing it, which the flag makes explicit
   *    rather than assumed.
   * 4. **The replacement is a new order** with `exchange_of_order_id` set and the credit
   *    applied as its advance. It is `pending`, and it confirms, ships and delivers
   *    through the ordinary path — which is what makes its revenue, its COGS and its
   *    collection post by rules that already exist. The price difference is not a
   *    journal at all: it is the replacement's COD, `items − discount + delivery −
   *    advance`, and whatever the credit does not cover stays on the balance sheet.
   *
   * The lines' `delivered_qty` is reduced as `returned_qty` grows, because
   * `order_lines_fulfilled_within_qty` keeps their sum within the quantity ordered — a
   * fully delivered line that gained a returned unit without losing a delivered one is a
   * row the database refuses, and rightly: it would claim more units left than existed.
   */
  async exchange(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    input: ExchangeOrderInput,
  ) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const order = await this.lockForAct(tx, context, request, id, 'exchange');
        const occurredAt = this.postingInstant(
          input.occurredAt === undefined ? undefined : new Date(input.occurredAt),
        );
        const lines = await repo.orderLines(tx, context.orgId, order.id);

        /*
         * The domain aggregates the request by SKU before it checks anything.
         *
         * A body naming one SKU twice used to pass a per-entry "is this more than was
         * delivered" test twice over, and the journal then credited COGS with twice the
         * cost while inventory's dedupe key wrote the movement once — a balanced journal,
         * a trial balance still at zero, and a replacement order free of charge. See
         * `computeExchangeReturn`.
         */
        const returned = computeExchangeReturn({
          returning: input.returnLines,
          lines: lines.map((line) => ({
            skuId: line.sku_id,
            qty: line.qty,
            deliveredQty: line.delivered_qty,
            returnedQty: line.returned_qty,
            unitPricePoisha: poisha(BigInt(line.unit_price_poisha)),
            lineDiscountPoisha: poisha(BigInt(line.discount_poisha)),
            dispatchUnitCostPoisha: poisha(BigInt(line.dispatch_unit_cost_poisha ?? '0')),
          })),
        });

        const locationId = await this.fulfilmentLocation(tx, context, order, input.locationId);

        const received = await this.inventory.receiveCustomerReturn(
          tx,
          { orgId: context.orgId, userId: context.userId },
          {
            orderId: order.id,
            locationId,
            occurredAt,
            lines: returned.lines.map((entry) => ({
              skuId: entry.skuId,
              qty: entry.qty,
              dispatchUnitCostPoisha: entry.dispatchUnitCostPoisha,
            })),
            memo: `Order ${order.order_no} exchange`,
          },
        );

        /*
         * Movements first, and the journal relieves what they actually wrote.
         *
         * `receiveCustomerReturn` is idempotent on `order:<id>:return:<sku>:<location>`, so
         * a replay writes nothing and still reports a value. Zero created movements with a
         * value to post therefore means these units are already back on the shelf for this
         * order — and posting the journal anyway would put cost into inventory a second
         * time. Refused as retryable rather than absorbed, the way `dispatch` refuses a
         * moved average.
         */
        const returnedValue = BigInt(received.valuePoisha);
        if (returnedValue > 0n && received.movementIds.length === 0) {
          throw new OrdersError(
            'ORDER_COST_MOVED',
            'Those units are already back in stock for this order, so the exchange cannot be recorded again.',
          );
        }

        const accounts = await this.transitions.accountsFor(tx, context.orgId, [
          'inventory',
          'cogs',
          'sales_revenue',
          'customer_advance',
        ]);
        const pick = (subtype: 'inventory' | 'cogs' | 'sales_revenue' | 'customer_advance') => {
          const account = accounts.get(subtype);
          if (account === undefined) {
            throw new OrdersError(
              'LEDGER_ACCOUNT_NOT_FOUND',
              `This organization has no ${subtype} account.`,
            );
          }
          return account;
        };

        await this.ledger.post(
          tx,
          { orgId: context.orgId, userId: context.userId },
          orderExchangeDraft({
            orderId: order.id,
            occurredAt,
            inventory: pick('inventory'),
            cogs: pick('cogs'),
            salesRevenue: pick('sales_revenue'),
            customerAdvance: pick('customer_advance'),
            // The value the movements recorded, not the value the request implied: the two
            // agree by construction, and taking the movements' figure is what keeps them
            // unable to disagree if that construction ever changes.
            returnedCostPoisha: poisha(returnedValue),
            returnedNetItemsPoisha: returned.netItemsPoisha,
            branchId: order.branch_id,
            memo: `Order ${order.order_no} exchange`,
          }),
        );

        await this.transitions.move(tx, context, request, order, 'exchange', {
          reason: input.reason,
          // Why the goods came back (M17, D-234): an exchange is a return too.
          returnReason: input.returnReason,
          occurredAt,
          callerHandlesExchange: true,
        });

        for (const entry of returned.lines) {
          await repo.setLineFulfilment(tx, {
            orgId: context.orgId,
            orderId: order.id,
            skuId: entry.skuId,
            deliveredQty: entry.deliveredQty,
            returnedQty: entry.returnedQty,
          });
        }

        const replacement = await this.createIn(
          tx,
          context,
          request,
          {
            channel: order.channel as CreateOrderInput['channel'],
            customerId: order.customer_id,
            lines: input.lines,
            ...(input.deliveryChargePoisha === undefined
              ? {}
              : { deliveryChargePoisha: input.deliveryChargePoisha }),
            ...(order.location_id === null ? {} : { locationId: order.location_id }),
            ...(order.branch_id === null ? {} : { branchId: order.branch_id }),
            ...(order.assigned_to === null ? {} : { assignedTo: order.assigned_to }),
            notes: `Exchange of ${order.order_no}: ${input.reason}`,
          },
          {
            exchangeOfOrderId: order.id,
            creditPoisha: BigInt(returned.netItemsPoisha),
            fallbackShipTo: {
              name: order.ship_name,
              phoneE164: order.ship_phone_e164,
              districtId: order.ship_district_id,
              thanaId: order.ship_thana_id,
              area: order.ship_area,
              addressLine: order.ship_address_line,
            },
            fallbackDeliveryZoneId: order.delivery_zone_id,
            fallbackDeliveryChargePoisha: BigInt(order.delivery_charge_poisha),
          },
        );

        return {
          originalOrderId: order.id,
          replacement,
          creditPoisha: BigInt(returned.netItemsPoisha).toString(),
          creditAppliedPoisha: replacement.advancePaidPoisha,
        };
      }),
    );
  }

  // --- the pieces the flows are built from --------------------------------------

  /**
   * The order, locked in the caller's scope, and the owner's gate asked (M41, D-710).
   *
   * Every desk write goes through here, so "somebody else is handling this order" is decided in
   * one place: `OwnershipGate.check` refuses a non-owner without `x-acknowledge-owner`, and
   * with it audits the act and tells the owner, in this transaction.
   */
  private async lockForAct(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    act: OwnerGatedAct,
  ): Promise<repo.OrderRow> {
    const order = await this.lockReadable(tx, context, request, id);
    await this.gate.check(tx, context, request, order, act);
    return order;
  }

  /**
   * The order, locked in the route's scope widened by what sales reads (D-725, `deskActScopeSql`):
   * a sales agent reaches a colleague's order for a desk act or a hand-over, and the owner's gate
   * or the assignment rule, not a 404, is what answers them. Only those two callers use it;
   * everything else locks in the route's own scope.
   */
  private async lockReadable(
    tx: Tx,
    context: ActiveContext,
    request: object,
    id: string,
  ): Promise<repo.OrderRow> {
    const order = await repo.lockOrderInScope(
      tx,
      context.orgId,
      id,
      deskActScopeSql(context, request),
    );
    if (order === undefined) throw new OrdersError('ORDER_NOT_FOUND', 'No such order.');
    return order;
  }

  /** The order, locked, or a 404-shaped refusal that reveals nothing. */
  private async readInScope(
    tx: Tx,
    context: ActiveContext,
    request: object,
    id: string,
  ): Promise<repo.OrderRow> {
    const order = await repo.lockOrderInScope(
      tx,
      context.orgId,
      id,
      orderScopeSql(context, request),
    );
    if (order === undefined) throw new OrdersError('ORDER_NOT_FOUND', 'No such order.');
    return order;
  }

  /**
   * The `create` scope check (D-061).
   *
   * `scopeWhere` cannot help: there is no row to filter yet. So the caller's filter is
   * evaluated against the row about to be written, which is what stops a branch manager
   * entering an order for a branch they do not hold. `assertInScope` is the shared
   * helper for exactly this and it also marks the scope applied, which
   * `ScopeInterceptor` refuses a response without.
   */
  private assertCreatable(
    request: object,
    context: ActiveContext,
    branchId: string | null,
    assignedTo: string | null,
  ): void {
    assertInScope(request, { createdBy: context.userId, assignedTo, branchId });
  }

  private async resolveBuyer(
    tx: Tx,
    context: ActiveContext,
    input: CreateOrderInput,
  ): Promise<{ id: string; name: string; phoneE164: string; shared: boolean }> {
    if (input.customerId !== undefined) {
      const row = await this.customers.require(tx, context.orgId, input.customerId);
      if (row.merged_into_customer_id !== null) {
        throw new OrdersError(
          'CUSTOMER_MERGE_INVALID',
          'That buyer was merged into another record; take the order for that one.',
        );
      }
      // Chosen by a person (the desk's chooser): nothing for the desk to check (D-875).
      return { id: row.id, name: row.name, phoneE164: row.phone_e164, shared: false };
    }

    if (input.customer === undefined) {
      throw new OrdersError(
        'CUSTOMER_NOT_FOUND',
        'An order needs a buyer: name an existing customer or supply one.',
      );
    }
    const upserted = await this.customers.upsert(tx, context, input.customer, {
      source: sourceForOrder(input.channel, input.source),
    });
    return {
      id: upserted.id,
      name: upserted.name,
      phoneE164: upserted.phoneE164,
      shared: upserted.shared,
    };
  }

  /**
   * Whom the order is for (M48, D-878 to D-881). The buyer is who ordered; the recipient is the
   * parcel's name, phone and address. `someone_else` when the caller says so, or when the parcel's
   * phone is not the buyer's; it needs the recipient's name and phone. The recipient's record is the
   * one named (checked by the caller), or with `saveRecipient` the person their number names (the
   * automatic pick) or a new one. The recipient's number joins the buyer's numbers only when the
   * staff ticked it, as `someone_else`, with the order's note.
   */
  private async resolveRecipient(
    tx: Tx,
    context: ActiveContext,
    input: CreateOrderInput,
    buyer: { id: string; name: string; phoneE164: string },
    shipTo: ShipTo,
  ): Promise<{ placedFor: PlacedFor; recipientCustomerId: string | null }> {
    const placedFor = input.placedFor ?? placedForOf(buyer.phoneE164, shipTo.phoneE164);
    if (placedFor === 'self') return { placedFor, recipientCustomerId: null };
    if (input.shipTo?.name === undefined || input.shipTo.phone === undefined) {
      throw new OrdersError(
        'VALIDATION_FAILED',
        'An order for someone else needs the recipient’s name and phone.',
      );
    }
    let recipientCustomerId: string | null = null;
    if (input.recipientCustomerId !== undefined) {
      const row = await this.customers.require(tx, context.orgId, input.recipientCustomerId);
      recipientCustomerId = row.id;
    } else if (input.saveRecipient === true) {
      const saved = await this.customers.upsert(
        tx,
        context,
        {
          phone: shipTo.phoneE164,
          name: shipTo.name,
          // The recipient's own address is theirs: the parcel's, saved as their default.
          address: {
            ...(shipTo.districtId === null ? {} : { districtId: shipTo.districtId }),
            ...(shipTo.thanaId === null ? {} : { thanaId: shipTo.thanaId }),
            ...(shipTo.area === null ? {} : { area: shipTo.area }),
            addressLine: shipTo.addressLine,
          },
        },
        { source: 'order' },
      );
      recipientCustomerId = saved.id;
    }
    if (recipientCustomerId === buyer.id) recipientCustomerId = null;
    if (input.addRecipientNumberToBuyer === true && shipTo.phoneE164 !== buyer.phoneE164) {
      await addNumber(tx, {
        orgId: context.orgId,
        customerId: buyer.id,
        phoneE164: shipTo.phoneE164,
        relation: 'someone_else',
        note: input.placedForNote ?? null,
        source: 'order',
        addedByUserId: context.userId,
      });
    }
    return { placedFor, recipientCustomerId };
  }

  /**
   * The district and thana an address names, checked (D2), or neither (D-953: the address is
   * one written line and the delivery zone is picked). One without the other is refused.
   */
  private async areaOf(
    tx: Tx,
    address: { readonly districtId?: number | undefined; readonly thanaId?: number | undefined },
  ): Promise<{ districtId: number | null; thanaId: number | null }> {
    return checkedArea(tx, address);
  }

  /**
   * The address snapshot the parcel is labelled with.
   *
   * A snapshot, not a reference: a buyer who moves house must not retroactively change
   * where an already-shipped parcel was sent, and a courier dispute six weeks later is
   * argued from what was printed. `sales.orders` therefore carries the address columns
   * and `sales.customer_addresses` is only where the form gets its default.
   */
  private async resolveShipTo(
    tx: Tx,
    context: ActiveContext,
    input: CreateOrderInput,
    buyer: { id: string; name: string; phoneE164: string },
    options: CreateOrderOptions,
  ): Promise<ShipTo> {
    if (input.shipTo !== undefined) {
      const area = await this.areaOf(tx, input.shipTo);
      return {
        name: input.shipTo.name ?? buyer.name,
        // M48 (D-878): the recipient's phone when the parcel is someone else's.
        phoneE164: normalizeBdPhone(input.shipTo.phone ?? buyer.phoneE164),
        districtId: area.districtId,
        thanaId: area.thanaId,
        area: input.shipTo.area ?? null,
        addressLine: input.shipTo.addressLine,
      };
    }

    const addresses = await repo.listAddresses(tx, context.orgId, buyer.id);
    const preferred = addresses.find((address) => address.is_default) ?? addresses[0];
    if (preferred !== undefined) {
      return {
        name: buyer.name,
        phoneE164: normalizeBdPhone(buyer.phoneE164),
        districtId: preferred.district_id,
        thanaId: preferred.thana_id,
        area: preferred.area,
        addressLine: preferred.address_line,
      };
    }
    if (options.fallbackShipTo !== undefined) return options.fallbackShipTo;

    throw new OrdersError(
      'VALIDATION_FAILED',
      'This order has no delivery address: send one, or save a default address for the buyer.',
    );
  }

  private async resolveZone(
    tx: Tx,
    context: ActiveContext,
    input: CreateOrderInput,
    shipTo: ShipTo,
    options: CreateOrderOptions,
  ): Promise<{ id: string; chargePoisha: bigint; defaultCourierId: string | null } | undefined> {
    if (input.deliveryZoneId !== undefined) {
      const named = await repo.zoneById(tx, context.orgId, input.deliveryZoneId);
      if (named === undefined) {
        throw new OrdersError('DELIVERY_ZONE_NOT_FOUND', 'No such delivery zone in this brand.');
      }
      return {
        id: named.id,
        chargePoisha: BigInt(named.charge_poisha),
        defaultCourierId: named.default_courier_id,
      };
    }

    /*
     * The zone the address falls in (D-009's seeded mapping), or none.
     *
     * A missing mapping is not an error here. §9 lets an org set a charge per order, and
     * an org that has not finished mapping its districts still has to be able to take
     * an order — refusing would make an incomplete reference table into an outage. The
     * charge then comes from the body, or from the order being exchanged, or is zero,
     * and `GET /v1/delivery-zones/for-area` is where a desk finds out there is no zone.
     */
    const found =
      shipTo.districtId === null
        ? undefined
        : await repo.zoneForArea(tx, context.orgId, shipTo.districtId, shipTo.thanaId);
    if (found !== undefined) {
      return {
        id: found.id,
        chargePoisha: BigInt(found.charge_poisha),
        defaultCourierId: found.default_courier_id,
      };
    }
    if (options.fallbackDeliveryZoneId != null) {
      const inherited = await repo.zoneById(tx, context.orgId, options.fallbackDeliveryZoneId);
      if (inherited !== undefined) {
        return {
          id: inherited.id,
          chargePoisha: BigInt(inherited.charge_poisha),
          defaultCourierId: inherited.default_courier_id,
        };
      }
    }
    return undefined;
  }

  /**
   * How far below the catalogue this caller may price an order (M30, C4; D-364).
   *
   * The desk's agents type prices and discounts, which is the ordinary case on a phone call,
   * but nothing bounded them: a sales agent could book a line at nothing to an accomplice
   * and the delivery would post full cost against no revenue. The typed discount (prices
   * under the list, line and order discounts; never a promo code, which the server prices)
   * is held to the caller's role ceiling. An edit that adds nothing to the discount the order
   * already carried is always allowed, so an agent can still fix the address on an order an
   * org admin priced deeply.
   */
  private async assertDiscountCeiling(
    tx: Tx,
    context: ActiveContext,
    after: PricedOrder,
    before?: PricedOrder,
  ): Promise<void> {
    const ids = [...new Set([...after.lines, ...(before?.lines ?? [])].map((line) => line.skuId))];
    const listPrice = new Map(
      (await this.catalog.skusByIds(tx, context.orgId, ids)).map((sku) => [
        sku.id,
        sku.pricePoisha,
      ]),
    );
    const discounted = (order: PricedOrder): DiscountedOrder => ({
      lines: order.lines.map((line) => ({
        skuId: line.skuId,
        qty: line.qty,
        // A SKU the catalogue no longer has is valued at what the order charges for it:
        // it can neither raise nor lower the discount.
        listPricePoisha: poisha(listPrice.get(line.skuId) ?? line.unitPricePoisha),
        unitPricePoisha: poisha(line.unitPricePoisha),
        lineDiscountPoisha: poisha(line.discountPoisha),
      })),
      orderDiscountPoisha: poisha(order.orderDiscountPoisha),
    });

    const ceilingBps = orderDiscountCeilingBps(context);
    if (
      discountAllowed({
        after: discounted(after),
        ...(before === undefined ? {} : { before: discounted(before) }),
        ceilingBps,
      })
    ) {
      return;
    }
    throw new OrdersError(
      'ORDER_DISCOUNT_ABOVE_CEILING',
      `A line or the order is priced more than ${basisPointsAsPercent(ceilingBps)}% below the ` +
        'catalogue, which is as far as your role may go. An org admin can enter this price.',
    );
  }

  /**
   * Price the lines from the catalog, and never from the body alone.
   *
   * `unitPricePoisha` in the body is honoured because an agent negotiating on a phone
   * call is the ordinary case in this business (see `createOrderLineSchema`). What is
   * *not* taken from the body is the SKU's code or its product name: those are
   * snapshotted from the catalog so the invoice cannot be made to describe a different
   * item than the one that will be picked.
   */
  private async priceLines(
    tx: Tx,
    context: ActiveContext,
    input: readonly {
      skuId: string;
      qty: number;
      unitPricePoisha?: string;
      discountPoisha?: string;
    }[],
  ): Promise<PricedLine[]> {
    const ids = input.map((line) => line.skuId);
    if (new Set(ids).size !== ids.length) {
      // `order_lines_org_order_sku_idx` would refuse the second row with a message about
      // an index; saying it here names the fix instead.
      throw new OrdersError(
        'ORDER_LINES_INVALID',
        'A SKU appears twice on this order; combine them into one line.',
      );
    }

    const skus = await this.catalog.skusByIds(tx, context.orgId, ids);
    const bySku = new Map<string, CatalogSku>(skus.map((sku) => [sku.id, sku]));

    return input.map((line) => {
      const sku = bySku.get(line.skuId);
      if (sku === undefined) {
        throw new OrdersError('ORDER_LINES_INVALID', 'One of those SKUs is not in this brand.');
      }
      if (sku.status === 'archived') {
        throw new OrdersError(
          'ORDER_LINES_INVALID',
          `${sku.code} is archived and cannot be sold; choose the replacement SKU.`,
        );
      }
      return {
        skuId: sku.id,
        skuCode: sku.code,
        productName: sku.productName,
        qty: line.qty,
        unitPricePoisha:
          line.unitPricePoisha === undefined ? sku.pricePoisha : BigInt(line.unitPricePoisha),
        discountPoisha: line.discountPoisha === undefined ? 0n : BigInt(line.discountPoisha),
      };
    });
  }

  /**
   * The next order number, from the counter's atomic upsert (§9).
   *
   * The Asia/Dhaka business date decides the period (invariant 8): an order confirmed at
   * half past midnight in Dhaka is that day's order, and reading UTC would file it in
   * the previous month — where the ledger period may already be closed.
   */
  private async nextOrderNo(tx: Tx, context: ActiveContext, at: Date): Promise<string> {
    const period = orderPeriodFor(businessDate(at));
    const [slug, configured] = await Promise.all([
      repo.orgSlug(tx, context.orgId),
      repo.orderNumberPrefix(tx, context.orgId),
    ]);
    const sequence = await repo.nextOrderNumber(tx, context.orgId, period);
    return formatOrderNo({ prefix: orderPrefixFor({ slug, configured }), period, sequence });
  }

  /**
   * Where an order ships from: the caller's location if it is one goods leave by.
   *
   * §8 has four kinds of location and only `warehouse` and `showroom` are places an order
   * goes out from. `damaged` and `in_transit` are refused here rather than at the schema,
   * because the schema cannot know which ids are which — and an order that could dispatch
   * off the damaged shelf is a way to sell written-off stock without the approval the
   * write-off needs. `defaultFulfilmentLocation` already filters by kind, so this is only
   * about an id a caller named.
   */
  private async fulfilmentLocation(
    tx: Tx,
    context: ActiveContext,
    order: repo.OrderRow,
    named?: string,
  ): Promise<string> {
    const candidate = named ?? order.location_id;
    if (candidate === null || candidate === undefined) {
      // No id anywhere: the org's first active warehouse, which
      // `defaultFulfilmentLocation` already filters by kind.
      return this.transitions.locationFor(tx, context, order);
    }
    await this.assertShippableLocation(tx, context, candidate);
    return candidate;
  }

  /** The kind check on its own, for a caller that has an id and no order yet. */
  private async assertShippableLocation(
    tx: Tx,
    context: ActiveContext,
    locationId: string,
  ): Promise<void> {
    const place = await repo.locationKind(tx, context.orgId, locationId);
    if (place === undefined) {
      throw new OrdersError('STOCK_LOCATION_INVALID', 'No such active location in this brand.');
    }
    if (place.kind !== 'warehouse' && place.kind !== 'showroom') {
      throw new OrdersError(
        'STOCK_LOCATION_INVALID',
        'An order ships from a warehouse or a showroom, not from that location.',
      );
    }
  }

  /**
   * The instant an event is posted on, refused if §7 would need an approval for it.
   *
   * Every endpoint that accepts an `occurredAt` — deliver, partial delivery, receive
   * return, exchange, advance — posts a journal dated from it, and §7 allows only today
   * and yesterday without a `back_dated_entry` approval. There is no approval type wired
   * into this module, so the honest answer is to refuse rather than to post quietly: an
   * order marked delivered with last month's date lands revenue in a period that may be
   * closed, and one dated next year lands it where no close can reach.
   *
   * M12's courier settlements are the case that will need the approval route (D-037); when
   * they arrive, this is the check they replace with one.
   */
  private postingInstant(named: Date | undefined): Date {
    const at = named ?? new Date();
    if (Number.isNaN(at.getTime())) {
      throw new OrdersError('VALIDATION_FAILED', 'That is not a usable timestamp.');
    }
    if (!withinPostingWindow(at)) {
      throw new OrdersError(
        'APPROVAL_REQUIRED',
        'An order event can only be dated today or yesterday; anything else needs a back-dated entry approval (§7).',
      );
    }
    return at;
  }

  private async defaultLocation(
    tx: Tx,
    context: ActiveContext,
    branchId: string | null,
  ): Promise<string> {
    const found = await repo.defaultFulfilmentLocation(tx, context.orgId, branchId);
    if (found === undefined) {
      throw new OrdersError(
        'STOCK_LOCATION_INVALID',
        'This brand has no warehouse to fulfil from; create one first.',
      );
    }
    return found.id;
  }
}

// --- small helpers ------------------------------------------------------------

/** The desk's transitions, which the owner's name guards (D-710); the hub's are not here. */
const DESK_TRIGGERS: Partial<Record<OrderTrigger, OwnerGatedAct>> = {
  hold: 'hold',
  release_hold: 'release_hold',
  cancel: 'cancel',
};

/** Every move a desk act makes, each through `lockForAct`: confirm, the three above, exchange. */
const DESK_ACT_TRIGGERS: ReadonlySet<OrderTrigger> = new Set<OrderTrigger>([
  'confirm',
  'exchange',
  ...(Object.keys(DESK_TRIGGERS) as OrderTrigger[]),
]);

/**
 * The moves this caller may make on this order (D-392, D-725). §9's rows from its status, less
 * the hub's for a sales agent on a colleague's order: they may act on it only through the
 * desk's acts and the owner's acknowledgement, so the console offers only those.
 */
function transitionsFor(context: ActiveContext, order: repo.OrderRow) {
  // D-928: §9 keeps `confirmed → shipped` for a courier's own pickup, but a person ships only a
  // packed order, so the order page never offers it.
  const all = transitionsFrom(order.status as OrderStatus).filter(
    (row) => !(order.status === 'confirmed' && row.trigger === 'ship'),
  );
  if (
    !context.roles.includes('sales') ||
    orderInActScope(context, {
      createdBy: order.created_by,
      assignedTo: order.assigned_to,
      branchId: order.branch_id,
    })
  ) {
    return all;
  }
  return all.filter((row) => DESK_ACT_TRIGGERS.has(row.trigger));
}

/** Roles that hold `update Order`, read off the matrix: who may be handed an order (D-712). */
const ORDER_HOLDING_ROLES = MEMBERSHIP_ROLES.filter((role) =>
  MATRIX[role].some(
    (rule) =>
      rule.subject === 'Order' &&
      (Array.isArray(rule.action) ? rule.action.includes('update') : rule.action === 'update'),
  ),
);

function toCallView(row: repo.CallAttemptRow) {
  return {
    id: row.id,
    outcome: row.outcome,
    callBackAt: row.call_back_at === null ? null : new Date(row.call_back_at).toISOString(),
    note: row.note,
    calledBy: row.called_by,
    calledAt: new Date(row.called_at).toISOString(),
  };
}

/** How many products one page of the editor's picker lists (M50, D-923). */
const PICKER_PAGE = 24;

/**
 * Applying an offer is §6's "apply codes" grant, `read LandingPage` (sales, branch managers,
 * marketing, org admins): a role that may not type a taka off may not pick a code either
 * (ledger audit C2).
 */
function assertMayApplyOffers(context: ActiveContext): void {
  if (!defineAbilityFor(context).can('read', 'LandingPage')) {
    throw new OrdersError('FORBIDDEN', 'Your role cannot apply offers to an order.');
  }
}

/** An offer as the editor's panel reads it: money as strings, the word only for who may use it. */
function toOfferView(offer: OfferView, showCode: boolean) {
  return {
    discountId: offer.discountId,
    method: offer.method,
    code: showCode ? offer.code : null,
    title: offer.title,
    description: offer.description,
    kind: offer.kind,
    allowStacking: offer.allowStacking,
    qualifies: offer.qualifies,
    discountPoisha: offer.discountPoisha.toString(),
    deliveryDiscountPoisha: offer.deliveryDiscountPoisha.toString(),
    reason: offer.reason,
  };
}

function toAppliedView(entry: AppliedDiscountView, showCode: boolean) {
  return {
    discountId: entry.discountId,
    method: entry.method,
    code: showCode ? entry.code : null,
    title: entry.title,
    discountPoisha: entry.discountPoisha.toString(),
    deliveryDiscountPoisha: entry.deliveryDiscountPoisha.toString(),
  };
}

/**
 * Every offer the person chose is one the engine applied (M50, D-921). The panel priced the
 * same choice a moment ago, so a difference means something changed since (a limit reached,
 * a discount paused, two that do not stack); saving without it would change the cash on
 * delivery behind their back, so the edit is refused and the panel shows the offers again.
 */
function assertAllChosenApply(
  chosenIds: readonly string[],
  quote: { readonly applied: readonly { readonly discountId: string }[] },
): void {
  const applied = new Set(quote.applied.map((entry) => entry.discountId));
  if ([...new Set(chosenIds)].some((id) => !applied.has(id))) {
    throw new OrdersError(
      'PROMO_NOT_APPLICABLE',
      'One of the chosen offers no longer applies to this order, or it does not combine with the others. Look at the offers again.',
    );
  }
}

function bigintMax(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

/** Whether an edit actually changed the lines, so a reservation is left alone if not. */
function sameLines(existing: readonly repo.OrderLineRow[], next: readonly PricedLine[]): boolean {
  if (existing.length !== next.length) return false;
  const before = new Map(
    existing.map((line) => [
      line.sku_id,
      `${String(line.qty)}:${String(line.unit_price_poisha)}:${String(line.discount_poisha)}`,
    ]),
  );
  return next.every(
    (line) =>
      before.get(line.skuId) ===
      `${String(line.qty)}:${line.unitPricePoisha.toString()}:${line.discountPoisha.toString()}`,
  );
}
