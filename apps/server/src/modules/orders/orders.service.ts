import { Inject, Injectable } from '@nestjs/common';
import { MATRIX, MEMBERSHIP_ROLES, type CallAttemptInput } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import {
  assignmentDecision,
  CALLABLE_STATUSES,
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
  poisha,
  sub,
  TRANSITIONS,
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
import { PROMO_PORT, type PricedPromo, type PromoPort } from './ports/promo.port.js';
import { TransitionsService, type MoveOptions } from './transitions.service.js';
import { TEAM_API, type TeamApi } from '../team/team.api.js';
import { OffersService } from './offers.service.js';
import { OwnershipGate } from './ownership.gate.js';
import { orderQueueSql } from './queues.js';
import * as desk from './desk.repository.js';
import * as repo from './orders.repository.js';
import { orderScopeSql } from './orders.scope.js';
import { orderTimeline } from './timeline.js';
import { mapOrderErrors, OrdersError } from './orders.errors.js';
import type {
  AvailabilityQuery,
  CreateOrderInput,
  ExchangeOrderInput,
  OrderQuery,
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
    readonly districtId: number;
    readonly thanaId: number;
    readonly area: string | null;
    readonly addressLine: string;
  };
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
  readonly districtId: number;
  readonly thanaId: number;
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
        const rows = await repo.listOrders(tx, context.orgId, {
          scope,
          queue: queue.where,
          orderBy: queue.orderBy,
          locationId,
          status: query.status,
          customerId: query.customerId,
          q: query.q,
          from: query.from,
          to: query.to,
          channel: query.channel,
          assignedTo: query.assignedTo,
          zoneId: query.zoneId,
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
        return {
          ...toOrderView(order),
          lines: lines.map(toLineView),
          history,
          timeline,
          owners,
          transitions: transitionsFrom(order.status as OrderStatus),
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
      nameBn: string;
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
          nameBn: input.nameBn,
          chargePoisha: BigInt(input.chargePoisha),
          defaultCourierId: input.defaultCourierId ?? null,
          position: input.position ?? 0,
          isActive: input.isActive ?? true,
        });
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'delivery_zone.saved',
          entityType: 'delivery_zone',
          entityId: id,
          after: { code: input.code, chargePoisha: input.chargePoisha },
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

    const orderNo = await this.nextOrderNo(tx, context, at);
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
      deliveryZoneId: zone?.id ?? options.fallbackDeliveryZoneId ?? null,
      courierId: input.courierId ?? zone?.defaultCourierId ?? null,
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
    options: { readonly system?: true } = {},
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
    if (repricing && (order.promo_code_id !== null || holds.appliedDiscounts > 0)) {
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
    const orderDiscountPoisha =
      patch.discountPoisha !== undefined
        ? BigInt(patch.discountPoisha)
        : bigintMax(BigInt(order.discount_poisha) - existingLineDiscounts, 0n);

    if (
      options.system !== true &&
      (patch.lines !== undefined || patch.discountPoisha !== undefined)
    ) {
      await this.assertDiscountCeiling(
        tx,
        context,
        { lines, orderDiscountPoisha },
        {
          lines: existing.map((line) => ({
            skuId: line.sku_id,
            qty: line.qty,
            unitPricePoisha: BigInt(line.unit_price_poisha),
            discountPoisha: BigInt(line.discount_poisha),
          })),
          orderDiscountPoisha: bigintMax(BigInt(order.discount_poisha) - existingLineDiscounts, 0n),
        },
      );
    }

    const deliveryChargePoisha =
      patch.deliveryChargePoisha === undefined
        ? BigInt(order.delivery_charge_poisha)
        : BigInt(patch.deliveryChargePoisha);

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

    if (patch.shipTo !== undefined) await this.assertArea(tx, patch.shipTo);
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
            phoneE164: order.ship_phone_e164,
            districtId: patch.shipTo.districtId,
            thanaId: patch.shipTo.thanaId,
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

  /** A system caller's lock on an order of the brand, with no person's scope to apply. */
  private async lockSystem(tx: Tx, context: ActiveContext, id: string): Promise<repo.OrderRow> {
    const order = await repo.lockOrderInScope(tx, context.orgId, id, sql`true`);
    if (order === undefined) throw new OrdersError('ORDER_NOT_FOUND', 'No such order.');
    return order;
  }

  // --- transitions --------------------------------------------------------------

  /**
   * Confirm: lock the order in scope, then let the domain machine run and reserve the stock.
   */
  async confirm(context: ActiveContext, request: AuditableRequest, id: string) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const order = await this.lockForAct(tx, context, request, id, 'confirm');
        const moved = await this.transitions.move(tx, context, request, order, 'confirm', {});
        // It left New: nobody should still be holding a card for it (D-717).
        await this.offers.withdrawFor(tx, context.orgId, order.id);
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
        if (trigger === 'cancel') await this.offers.withdrawFor(tx, context.orgId, order.id);
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
    const moved = await this.transitions.move(tx, context, request, order, trigger, options);
    return { from: moved.result.from, to: moved.result.to };
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
        const order = await this.readInScope(tx, context, request, id);
        const previous = order.assigned_to;
        const decision = assignmentDecision({
          ownerId: previous,
          callerId: context.userId,
          target,
          supervisor: isSupervisor(context.roles, context.isSuperAdmin),
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
          await this.assertAssignable(tx, context, target);
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

  /** The person named holds a role that works orders in this brand (D-712). */
  private async assertAssignable(tx: Tx, context: ActiveContext, userId: string): Promise<void> {
    const members = await this.iam.activeMembers(tx, context.orgId, { roles: ORDER_HOLDING_ROLES });
    if (!members.some((member) => member.userId === userId)) {
      throw new OrdersError(
        'ORDER_ASSIGNEE_INVALID',
        'That person cannot hold orders in this brand.',
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
        await emit(
          tx,
          'order.edited',
          { id: order.id, orderNo: order.order_no, at: new Date(row.called_at).toISOString() },
          { orgId: context.orgId },
        );
        return toCallView(row);
      }),
    );
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
        return { orderId: order.id, items: rows.map(toCallView) };
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
          await emit(
            tx,
            'order.edited',
            { id: order.id, orderNo: order.order_no, at: new Date().toISOString() },
            { orgId: context.orgId },
          );
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
    const order = await this.readInScope(tx, context, request, id);
    await this.gate.check(tx, context, request, order, act);
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
  ): Promise<{ id: string; name: string; phoneE164: string }> {
    if (input.customerId !== undefined) {
      const row = await this.customers.require(tx, context.orgId, input.customerId);
      return { id: row.id, name: row.name, phoneE164: row.phone_e164 };
    }

    if (input.customer === undefined) {
      throw new OrdersError(
        'CUSTOMER_NOT_FOUND',
        'An order needs a buyer: name an existing customer or supply one.',
      );
    }
    const upserted = await this.customers.upsert(tx, context, input.customer);
    return { id: upserted.id, name: upserted.name, phoneE164: upserted.phoneE164 };
  }

  /** A district and thana the reference data has, the thana inside the district (D2). */
  private async assertArea(
    tx: Tx,
    address: { readonly districtId: number; readonly thanaId: number },
  ): Promise<void> {
    if (!(await repo.areaExists(tx, address.districtId, address.thanaId))) {
      throw new OrdersError(
        'VALIDATION_FAILED',
        'That thana is not one of the district’s. Choose the district, then a thana in it.',
      );
    }
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
      await this.assertArea(tx, input.shipTo);
      return {
        name: input.shipTo.name ?? buyer.name,
        phoneE164: normalizeBdPhone(buyer.phoneE164),
        districtId: input.shipTo.districtId,
        thanaId: input.shipTo.thanaId,
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
    const found = await repo.zoneForArea(tx, context.orgId, shipTo.districtId, shipTo.thanaId);
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
