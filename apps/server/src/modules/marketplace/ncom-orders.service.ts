import { HttpException, Inject, Injectable } from '@nestjs/common';
import { withGlobal, withOrg, type Tx } from '@elysium/db';
import {
  add,
  mulQty,
  normalizeBdPhone,
  OrderError,
  poisha,
  sub,
  sum,
  takaText,
  type OrderStatus,
  type Poisha,
} from '@elysium/domain';
import {
  availableForWeb,
  matchDistrict,
  matchThana,
  ncomCents,
  ncomCentsOf,
  ncomDeliveryOutcome,
  ncomOrderMoney,
  ncomSignatureHeader,
  ncomStatusFor,
  ncomTopicFor,
  NCOM_CONTRACT,
} from '@elysium/domain/storefront';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import { AuditService } from '../../platform/audit/audit.service.js';
import { open, seal, SealedBoxUnavailable } from '../../platform/crypto/sealed-box.js';
import type { DeliveredEvent } from '../../platform/events/dispatcher.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { createLogger } from '../../platform/logging/logger.js';
import { CATALOG_API, type CatalogApi, type WebSkuFact } from '../catalog/catalog.api.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import { ORDERS_API, type OrdersApi, type PackingFacts } from '../orders/orders.api.js';
import { STOREFRONT_API, type StorefrontApi } from '../storefront/storefront.api.js';
import { NcomAuthService, type OrderContext } from './ncom-auth.service.js';
import { MARKETPLACE_QUEUES } from './marketplace.queues.js';
import * as repo from './marketplace.repository.js';
import { NcomRefusal } from './ncom.http.js';
import { NcomTransport } from './ncom.transport.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[!-~]{1,128}$/;
const MAX_LINES = 100;
const DHAKA_DISTRICT_NAME = 'Dhaka';

/** Who acts for ncom: on the order, in the audit log and on the outbox event it causes. */
export const NCOM_ORDER_ACTOR = 'marketplace:ncom';

interface NcomLine {
  readonly productId?: unknown;
  readonly variantId?: unknown;
  readonly source?: unknown;
  readonly title?: unknown;
  readonly variantTitle?: unknown;
  readonly sku?: unknown;
  readonly imageUrl?: unknown;
  readonly quantity?: unknown;
  readonly unitPriceCents?: unknown;
  readonly totalCents?: unknown;
}

/** The topics that file a new order (the old site took any other topic as one too). */
const PLACING_TOPICS = new Set([undefined, 'order.created', 'order.placed']);

interface NcomOrder {
  readonly id?: unknown;
  readonly orderNumber?: unknown;
  readonly lines?: unknown;
  readonly customer?: {
    readonly name?: unknown;
    readonly phone?: unknown;
    readonly email?: unknown;
  } | null;
  readonly shippingAddress?: Record<string, unknown> | null;
  readonly subtotalCents?: unknown;
  readonly discountTotalCents?: unknown;
  readonly couponDiscountCents?: unknown;
  readonly shippingTotalCents?: unknown;
  readonly taxTotalCents?: unknown;
  readonly totalCents?: unknown;
  readonly discountCode?: unknown;
  readonly note?: unknown;
  readonly campaign?: Record<string, unknown> | null;
  readonly store?: Record<string, unknown> | null;
}

interface Envelope {
  readonly topic?: unknown;
  readonly idempotencyKey?: unknown;
  readonly baseRevision?: unknown;
  readonly revision?: unknown;
  readonly reason?: unknown;
  readonly order?: unknown;
}

interface ForeignItem {
  readonly title: string;
  readonly variantTitle: string;
  readonly sku: string;
  readonly quantity: number;
  /** The line's value in ncom's order, before the order discount. */
  readonly pricePoisha: string;
}

/** ncom's lines, each resolved to one of the brand's SKUs or not (another shop's). */
interface Rebuilt {
  readonly lines: readonly { readonly line: NcomLine; readonly skuId: string | null }[];
  /** Lines of the brand's website (`source: website`) this shop no longer sells. */
  readonly unresolved: number;
  readonly warnings: string[];
  readonly facts: ReadonlyMap<string, WebSkuFact>;
}

/** ncom's order in the ERP's terms: its own lines merged per SKU, and the money (D-556). */
interface Priced {
  readonly ours: { skuId: string; qty: number; unitPricePoisha: Poisha }[];
  readonly foreign: ForeignItem[];
  readonly deliveryPoisha: Poisha;
  /** The ERP order's discount: its goods at these unit prices less what is collected. */
  readonly discountPoisha: Poisha;
  readonly codPoisha: Poisha;
  readonly foreignPoisha: Poisha;
}

const str = (value: unknown, max: number): string =>
  typeof value === 'string'
    ? value.trim().slice(0, max)
    : typeof value === 'number'
      ? String(value)
      : '';

/** The answer an intake route sends: a status and a JSON body. */
export interface IntakeAnswer {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Orders ncom.bd hands over, and what the ERP tells it back (M35b, D-556), as the old site's
 * `app/api/ncom/orders`, `app/api/ncom-webhook` and `lib/ncom-orders.js` did.
 *
 * - **Exactly once.** The `X-NCOM-Idempotency-Key` is unique per brand: a retry is answered
 *   200 with the order already made, never a second one.
 * - **ncom's prices are the prices.** The shopper agreed to them on ncom's page; the ERP does not
 *   reprice them (`ncomOrderMoney`). What the ERP decides is the stock: the order holds its units
 *   at one web location when one has them all, and is placed unheld (with a warning) when none
 *   does, as the old site filed a shortfall rather than lose a sale ncom already confirmed.
 * - **Revisions.** A change ncom makes must build on the revision the ERP holds; anything else
 *   is `409` with the ERP's revision for a person to reconcile. A change the ERP cannot apply
 *   (the order is packed) is refused the same way and noted on the order.
 * - **Back to ncom.** Each status change of a handed-over order queues one message, sent in
 *   order per order by the worker with the old backoff; a 409 stops the queue for a person.
 */
@Injectable()
export class NcomOrdersService {
  private cachedLogger: Logger | undefined;

  private get logger(): Logger {
    this.cachedLogger ??= createLogger('marketplace');
    return this.cachedLogger;
  }

  constructor(
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    @Inject(INVENTORY_API) private readonly inventory: InventoryApi,
    @Inject(STOREFRONT_API) private readonly storefront: StorefrontApi,
    private readonly auth: NcomAuthService,
    private readonly transport: NcomTransport,
    private readonly audit: AuditService,
  ) {}

  // --- intake ---------------------------------------------------------------------------------

  async intake(context: OrderContext, rawBody: Buffer, headerKey: string): Promise<IntakeAnswer> {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(rawBody.toString('utf8')) as Envelope;
    } catch {
      return { status: 400, body: { error: 'Invalid JSON' } };
    }
    const key = (headerKey !== '' ? headerKey : str(envelope.idempotencyKey, 255)).trim();
    if (key === '' || !/^[!-~]{1,255}$/.test(key)) {
      return { status: 400, body: { error: 'Missing idempotency key' } };
    }
    // A test is answered like an order and filed like nothing.
    if (envelope.topic === 'order.test') {
      await withOrg({ orgId: context.orgId }, (tx) =>
        repo.noteOrderReceived(tx, context.orgId, false),
      );
      return { status: 200, body: { ok: true, test: true } };
    }
    const order = envelope.order;
    if (order === null || typeof order !== 'object') {
      return { status: 400, body: { error: 'Missing order' } };
    }
    if (envelope.topic === 'order.updated' || envelope.topic === 'order.cancelled') {
      return this.applyChange(context, envelope, order, key);
    }
    if (!PLACING_TOPICS.has(envelope.topic as string | undefined)) {
      return { status: 400, body: { error: 'Unknown topic' } };
    }
    const lines = (order as NcomOrder).lines;
    if (!Array.isArray(lines) || lines.length === 0) {
      return { status: 400, body: { error: 'Order has no lines' } };
    }
    if (lines.length > MAX_LINES) {
      return { status: 400, body: { error: 'Too many lines in one order' } };
    }
    const existing = await withOrg({ orgId: context.orgId }, (tx) =>
      repo.ncomOrderByKey(tx, context.orgId, key),
    );
    if (existing !== undefined) return this.deduped(context.orgId, existing);
    try {
      return await this.place(context, envelope, order, key);
    } catch (error) {
      if (isUnique(error)) {
        // The same key raced in, or the same ncom order came again under a new key.
        const ncomId = str((order as NcomOrder).id, 128);
        const winner = await withOrg({ orgId: context.orgId }, async (tx) => {
          const byKey = await repo.ncomOrderByKey(tx, context.orgId, key);
          if (byKey !== undefined || ncomId === '') return byKey;
          return repo.ncomOrderByNcomId(tx, context.orgId, ncomId);
        });
        if (winner !== undefined) return this.deduped(context.orgId, winner);
      }
      if (error instanceof NcomRefusal) return { status: error.status, body: error.body };
      // The orders module refused it (a line it cannot take, a phone it cannot read): final,
      // so ncom's queue stops retrying and its dashboard shows why.
      const refusal = orderRefusal(error);
      if (refusal !== null) {
        return { status: 422, body: { error: refusal.message, code: refusal.code } };
      }
      this.logger.error({ err: error }, 'an ncom order could not be filed');
      // A 5xx, so ncom's queue retries: a blip is likelier than a payload never acceptable.
      return { status: 500, body: { error: 'Could not file the order' } };
    }
  }

  private async deduped(orgId: string, row: repo.NcomOrderRow): Promise<IntakeAnswer> {
    const orderNumber = await withOrg({ orgId }, async (tx) => {
      const summary = await this.orders.summary(tx, orgId, row.order_id);
      return summary?.orderNo ?? '';
    });
    return {
      status: 200,
      body: { ok: true, deduped: true, orderId: row.order_id, orderNumber },
    };
  }

  private async place(
    context: OrderContext,
    envelope: Envelope,
    order: NcomOrder,
    key: string,
  ): Promise<IntakeAnswer> {
    const { orgId } = context;
    const actor = { orgId, userId: NCOM_ORDER_ACTOR };
    return withOrg(actor, async (tx) => {
      // A same-order retry under a new key is answered with the order already filed.
      const ncomIdFirst = str(order.id, 128);
      if (ncomIdFirst !== '') {
        const same = await repo.ncomOrderByNcomId(tx, orgId, ncomIdFirst);
        if (same !== undefined) {
          const summary = await this.orders.summary(tx, orgId, same.order_id);
          return {
            status: 200,
            body: {
              ok: true,
              deduped: true,
              orderId: same.order_id,
              orderNumber: summary?.orderNo ?? '',
            },
          };
        }
      }
      const rebuilt = await this.rebuild(tx, orgId, order);
      const priced = this.price(rebuilt, order);
      if (priced.ours.length === 0) {
        // The ERP's orders are made of its own SKUs: an order of nothing the brand sells is
        // ncom's to fulfil (D-556), refused for good so its dashboard shows it.
        throw new NcomRefusal(400, { error: 'Order has no line this shop sells' });
      }
      const address = order.shippingAddress ?? {};
      const customer = order.customer ?? {};
      let phone: string;
      try {
        phone = normalizeBdPhone(str(customer.phone, 40) || str(address.phone, 40));
      } catch {
        throw new NcomRefusal(400, { error: 'The phone is not a Bangladeshi mobile number' });
      }
      const name = str(customer.name, 200) || str(address.name, 200) || 'Customer';
      const warnings = [...rebuilt.warnings];
      const place = await this.placeOf(tx, address, warnings);
      const money = priced;
      if (money.foreignPoisha > 0n) {
        warnings.push(
          `ncom's total carries ${takaText(money.foreignPoisha)} for items this shop does not stock; this order collects only its own goods and delivery.`,
        );
      }

      // A hold ncom took for this order before handing it over gives its units to the order.
      const ncomId = str(order.id, 128);
      const ncomNumber = str(order.orderNumber, 128);
      let converted: string | null = null;
      for (const ref of [ncomId, ncomNumber]) {
        if (ref === '' || converted !== null) continue;
        const hold = await repo.holdByRef(tx, orgId, ref, { lock: true });
        if (hold?.state === 'held') {
          await this.inventory.release(tx, actor, { refType: 'ncom_hold', refId: hold.id });
          converted = hold.id;
        }
      }

      let locationId = await this.holdLocation(tx, orgId, priced.ours);
      if (locationId === null) {
        warnings.push(
          'No single location holds every line: the order is filed without held stock; confirm it once the stock is there.',
        );
      }
      const note = str(order.note, 1500);
      const orderInput: Parameters<OrdersApi['createOrder']>[2] = {
        channel: 'marketplace',
        source: { utmSource: 'ncom' },
        customer: { phone, name },
        shipTo: {
          name: str(address.name, 200) || name,
          districtId: place.districtId,
          thanaId: place.thanaId,
          ...(place.area === '' ? {} : { area: place.area }),
          addressLine: place.addressLine,
        },
        lines: priced.ours.map((line) => ({
          skuId: line.skuId,
          qty: line.qty,
          unitPricePoisha: line.unitPricePoisha.toString(),
        })),
        deliveryChargePoisha: money.deliveryPoisha.toString(),
        discountPoisha: money.discountPoisha.toString(),
        notes: `ncom.bd ${ncomNumber || ncomId}${note === '' ? '' : `: ${note}`}`.slice(0, 2000),
      };
      let created;
      try {
        // A savepoint: losing the race for the last units undoes only the attempt to hold them.
        const at = locationId;
        created = await tx.transaction((savepoint) =>
          this.orders.createOrder(
            savepoint,
            actor,
            orderInput,
            at === null ? {} : { holdStockAt: at },
          ),
        );
      } catch (error) {
        if (locationId === null || orderRefusal(error)?.code !== 'STOCK_INSUFFICIENT') throw error;
        // The shopper was told the order is placed: file it, say the stock was short (the old
        // site's rule), and let a person confirm it once the units are there.
        warnings.push(
          'The units were sold while this order arrived: it is filed without held stock; confirm it once the stock is there.',
        );
        locationId = null;
        created = await this.orders.createOrder(tx, actor, orderInput, {});
      }
      if (BigInt(created.codAmountPoisha) !== money.codPoisha) {
        throw new Error('an ncom order’s COD did not come out as ncom’s total');
      }
      await repo.insertNcomOrder(tx, {
        orgId,
        orderId: created.id,
        ncomOrderId: ncomId || key,
        ncomOrderNumber: ncomNumber,
        idempotencyKey: key,
        storeName: str(order.store?.name, 200),
        storeUrl: str(order.store?.url, 500),
        pageTitle: str(order.campaign?.pageTitle, 300),
        pageUrl: str(order.campaign?.pageUrl, 500),
        offerKey: str(order.campaign?.offerKey, 120),
        offerLabel: str(order.campaign?.offerLabel, 300),
        offerPricePoisha: ncomCents(order.campaign?.offerPriceCents),
        regularPricePoisha: ncomCents(order.campaign?.offerRegularCents),
        discountCode: str(order.discountCode, 80),
        foreignItems: priced.foreign,
        foreignPoisha: money.foreignPoisha,
        warnings,
        stockHeld: locationId !== null,
      });
      if (converted !== null) {
        await repo.endHold(tx, {
          orgId,
          id: converted,
          state: 'converted',
          convertedOrderId: created.id,
        });
      }
      await repo.noteOrderReceived(tx, orgId, true);

      const summary = await this.orders.summary(tx, orgId, created.id);
      await this.storefront.recordPurchase(tx, orgId, {
        orderId: created.id,
        orderNo: created.orderNo,
        totalPoisha: money.codPoisha,
        lines: priced.ours.map((line) => ({
          productId: rebuilt.facts.get(line.skuId)?.productId ?? line.skuId,
          name: rebuilt.facts.get(line.skuId)?.productName ?? '',
          qty: line.qty,
          unitPricePoisha: line.unitPricePoisha,
        })),
        buyer: {
          name,
          phoneE164: phone,
          email: str(customer.email, 254) || null,
          city: place.districtName,
          customerId: summary?.customerId ?? '',
        },
        waitForPayment: false,
      });
      await this.audit.record(tx, {
        orgId,
        actorUserId: NCOM_ORDER_ACTOR,
        operation: 'create',
        action: 'marketplace.order_received',
        entityType: 'order',
        entityId: created.id,
        after: {
          orderNo: created.orderNo,
          ncomOrderNumber: ncomNumber,
          codAmountPoisha: money.codPoisha.toString(),
          heldAt: locationId,
          foreignItems: priced.foreign.length,
          warnings: warnings.length,
          topic: str(envelope.topic, 40),
        },
      });
      return {
        status: 201,
        body: { ok: true, orderId: created.id, orderNumber: created.orderNo },
      };
    });
  }

  /** A change ncom made to an order it already handed over (the old `applyNcomChange`). */
  private async applyChange(
    context: OrderContext,
    envelope: Envelope,
    incoming: NcomOrder,
    key: string,
  ): Promise<IntakeAnswer> {
    const { orgId } = context;
    const actor = { orgId, userId: NCOM_ORDER_ACTOR };
    return withOrg(actor, async (tx) => {
      const existing = await repo.ncomOrderByNcomId(tx, orgId, str(incoming.id, 128));
      if (existing === undefined) return { status: 404, body: { error: 'Unknown order' } };
      const held = existing.revision;
      if (key === existing.last_inbound_key) {
        return { status: 200, body: { ok: true, deduped: true, revision: held } };
      }
      const base = envelope.baseRevision;
      if (typeof base !== 'number' || !Number.isInteger(base)) {
        return { status: 400, body: { error: 'Missing baseRevision' } };
      }
      if (base !== held) {
        return {
          status: 409,
          body: { error: 'This shop holds a different version of the order', revision: held },
        };
      }
      const revision =
        typeof envelope.revision === 'number' &&
        Number.isInteger(envelope.revision) &&
        envelope.revision > held
          ? envelope.revision
          : held + 1;
      const warnings = Array.isArray(existing.warnings) ? [...(existing.warnings as string[])] : [];

      if (envelope.topic === 'order.cancelled') {
        const summary = await this.orders.summary(tx, orgId, existing.order_id);
        if (summary !== undefined && summary.status !== 'cancelled') {
          try {
            await tx.transaction((savepoint) =>
              this.orders.transition(savepoint, actor, existing.order_id, 'cancel', {
                reason: `Cancelled on ncom${str(envelope.reason, 200) === '' ? '' : `: ${str(envelope.reason, 200)}`}`,
              }),
            );
          } catch (error) {
            if (orderRefusal(error) === null) throw error;
            warnings.push(
              `ncom cancelled this order when it was ${summary.status}; stop it by hand.`,
            );
            await repo.applyInbound(tx, {
              orgId,
              orderId: existing.order_id,
              revision: held,
              key: existing.last_inbound_key ?? '',
              warnings,
            });
            return {
              status: 409,
              body: { error: 'This shop cannot cancel the order now', revision: held },
            };
          }
        }
        await repo.applyInbound(tx, { orgId, orderId: existing.order_id, revision, key });
        return { status: 200, body: { ok: true, revision } };
      }

      // An edit: their lines, their money and their address, through the desk's own edit.
      const rebuilt = await this.rebuild(tx, orgId, incoming);
      const address = incoming.shippingAddress ?? {};
      const editWarnings: string[] = [...rebuilt.warnings];
      const refuseEdit = async (why: string): Promise<IntakeAnswer> => {
        warnings.push(`ncom changed this order but the change was not applied: ${why}`);
        await repo.applyInbound(tx, {
          orgId,
          orderId: existing.order_id,
          revision: held,
          key: existing.last_inbound_key ?? '',
          warnings,
        });
        return {
          status: 409,
          body: { error: 'This shop cannot apply that change now', revision: held },
        };
      };
      // A line of ours that no longer resolves would silently leave the order (the ledger
      // audit's C2): a person decides instead.
      if (rebuilt.unresolved > 0) {
        return refuseEdit('a line names a product this shop no longer sells; edit it by hand.');
      }
      const priced = this.price(rebuilt, incoming);
      if (priced.ours.length === 0) {
        return refuseEdit('it leaves no line this shop sells; cancel or edit it by hand.');
      }
      const hasAddress = str(address.address1, 300) !== '' || str(address.city, 120) !== '';
      const place = hasAddress ? await this.placeOf(tx, address, editWarnings) : null;
      try {
        await tx.transaction(async (savepoint) => {
          await this.orders.editOrder(savepoint, actor, existing.order_id, {
            lines: priced.ours.map((line) => ({
              skuId: line.skuId,
              qty: line.qty,
              unitPricePoisha: line.unitPricePoisha.toString(),
            })),
            deliveryChargePoisha: priced.deliveryPoisha.toString(),
            discountPoisha: priced.discountPoisha.toString(),
            ...(place === null
              ? {}
              : {
                  shipTo: {
                    ...(str(address.name, 200) === '' ? {} : { name: str(address.name, 200) }),
                    districtId: place.districtId,
                    thanaId: place.thanaId,
                    ...(place.area === '' ? {} : { area: place.area }),
                    addressLine: place.addressLine,
                  },
                }),
            ...(incoming.note === undefined ? {} : { notes: str(incoming.note, 2000) }),
          });
          // The order must now collect exactly the brand's part of ncom's total, less what
          // was paid ahead; anything else is undone with the savepoint.
          const after = await this.orders.summary(savepoint, orgId, existing.order_id);
          const advance = poisha(after?.advancePaidPoisha ?? '0');
          const expected = priced.codPoisha > advance ? sub(priced.codPoisha, advance) : poisha(0);
          if (after === undefined || poisha(after.codAmountPoisha) !== expected) {
            throw new NcomRefusal(409, { error: 'The edit would not collect ncom’s total' });
          }
        });
      } catch (error) {
        if (error instanceof NcomRefusal) {
          return refuseEdit('the order would not have collected ncom’s total.');
        }
        const refusal = orderRefusal(error);
        if (refusal === null) throw error;
        return refuseEdit(refusal.message);
      }
      await repo.applyInbound(tx, {
        orgId,
        orderId: existing.order_id,
        revision,
        key,
        warnings: [...warnings, ...editWarnings],
        foreignItems: priced.foreign,
        foreignPoisha: priced.foreignPoisha,
      });
      return { status: 200, body: { ok: true, revision } };
    });
  }

  // --- the webhook ----------------------------------------------------------------------------

  /** One webhook ncom delivered: claimed once by its event id, noted, never moving stock. */
  async webhook(
    context: OrderContext,
    rawBody: Buffer,
    headerEventId: string,
  ): Promise<IntakeAnswer> {
    let event: { id?: unknown; topic?: unknown; data?: unknown };
    try {
      event = JSON.parse(rawBody.toString('utf8')) as typeof event;
    } catch {
      return { status: 400, body: { error: 'Invalid JSON' } };
    }
    const eventId = str(event.id, 128) || headerEventId.trim();
    if (!SAFE_ID.test(eventId)) return { status: 400, body: { error: 'Missing event id' } };
    const topic = str(event.topic, 81) || 'unknown';
    const { orgId } = context;
    return withOrg({ orgId, userId: NCOM_ORDER_ACTOR }, async (tx) => {
      const claimed = await repo.claimEvent(
        tx,
        orgId,
        eventId,
        /^[a-z_]{1,40}([.][a-z_]{1,40})?$/.test(topic) ? topic : 'unknown',
      );
      if (!claimed) return { status: 200, body: { ok: true, deduped: true } };
      const data = (event.data ?? {}) as { id?: unknown; reason?: unknown };
      const notable: Readonly<Record<string, string>> = {
        'order.held_for_review': 'ncom is holding this order for review',
        'order.cancelled': 'ncom reports the order cancelled',
        'shipment.returned': 'ncom reports the parcel returned',
      };
      const note = notable[topic];
      if (note !== undefined && typeof data.id === 'string') {
        const row = await repo.ncomOrderByNcomId(tx, orgId, data.id.slice(0, 128));
        if (row !== undefined) {
          const warnings = Array.isArray(row.warnings) ? [...(row.warnings as string[])] : [];
          warnings.push(
            `${note}${str(data.reason, 200) === '' ? '' : `: ${str(data.reason, 200)}`}.`,
          );
          await repo.applyInbound(tx, {
            orgId,
            orderId: row.order_id,
            revision: row.revision,
            key: row.last_inbound_key ?? '',
            warnings,
          });
        }
      }
      await repo.noteWebhook(tx, orgId);
      return { status: 200, body: { ok: true } };
    });
  }

  // --- back to ncom (the outbox) --------------------------------------------------------------

  /**
   * The outbox subscriber for `order.status_changed`: a handed-over order's change is queued
   * for ncom, unless ncom itself caused it (an inbound cancel is not echoed back).
   */
  async onStatusChanged(event: DeliveredEvent): Promise<void> {
    if (event.actorUserId === NCOM_ORDER_ACTOR) return;
    const payload = event.payload as { id?: unknown; to?: unknown };
    if (typeof payload.id !== 'string' || typeof payload.to !== 'string') return;
    const orderId = payload.id;
    const status = payload.to as OrderStatus;
    await withOrg({ orgId: event.orgId, userId: 'system:marketplace' }, (tx) =>
      this.queueChange(tx, event.orgId, orderId, status, `Status changed to ${status}`, event.id),
    );
  }

  /**
   * The outbox subscriber for `order.edited`: a person corrected a handed-over order (its
   * lines, money or address) and ncom hears the order as it now stands, under a new revision,
   * so its next change cannot quietly overwrite the correction (the ledger audit's W5).
   */
  async onEdited(event: DeliveredEvent): Promise<void> {
    if (event.actorUserId === NCOM_ORDER_ACTOR) return;
    const payload = event.payload as { id?: unknown };
    if (typeof payload.id !== 'string') return;
    const orderId = payload.id;
    await withOrg({ orgId: event.orgId, userId: 'system:marketplace' }, async (tx) => {
      const summary = await this.orders.summary(tx, event.orgId, orderId);
      if (summary === undefined) return;
      await this.queueChange(
        tx,
        event.orgId,
        orderId,
        summary.status,
        'Edited in the shop',
        event.id,
      );
    });
  }

  /** Queue one change of an order ncom handed over; nothing for any other order. */
  async queueChange(
    tx: Tx,
    orgId: string,
    orderId: string,
    status: OrderStatus,
    reason: string | null,
    sourceEventId: string | null = null,
  ): Promise<string | null> {
    const row = await repo.ncomOrderByOrderId(tx, orgId, orderId, { lock: true });
    if (row === undefined) return null;
    // A redelivered outbox event (another subscriber failed) queues nothing a second time.
    if (sourceEventId !== null && (await repo.queuedByEvent(tx, orgId, sourceEventId))) return null;
    const settings = await repo.settingsOf(tx, orgId);
    if (
      settings === undefined ||
      settings.order_key_id === '' ||
      settings.order_secret_sealed === null
    ) {
      return null;
    }
    const bumped = await repo.bumpRevision(tx, orgId, orderId);
    if (bumped === undefined) return null;
    const [facts] = await this.orders.packingFacts(tx, orgId, [orderId]);
    if (facts === undefined) return null;
    const topic = ncomTopicFor(status);
    const idempotencyKey = `erp:${orderId}:${String(bumped.revision)}`;
    const body = {
      version: 1,
      topic,
      idempotencyKey,
      sentAt: new Date().toISOString(),
      baseRevision: bumped.base,
      revision: bumped.revision,
      reason,
      order: await this.serialise(tx, orgId, row, facts, status, topic),
    };
    let sealed;
    try {
      sealed = seal(JSON.stringify(body), {
        orgId,
        row: `ncom_outbox:${idempotencyKey}`,
        field: 'payload',
      });
    } catch (error) {
      if (error instanceof SealedBoxUnavailable) return null;
      throw error;
    }
    const id = await repo.insertOutbox(tx, {
      orgId,
      orderId,
      topic,
      idempotencyKey,
      sourceEventId,
      baseRevision: bumped.base,
      revision: bumped.revision,
      payload: { sealed: sealed.ciphertext, keyId: sealed.keyId },
    });
    await enqueue(
      tx,
      MARKETPLACE_QUEUES.send.name,
      { orderId },
      { orgId, ref: orderId, singletonKey: `ncom-send:${orderId}` },
    );
    return id;
  }

  /** What ncom needs to know about the order as it now stands, in its minor units. */
  private async serialise(
    tx: Tx,
    orgId: string,
    row: repo.NcomOrderRow,
    facts: PackingFacts,
    status: OrderStatus,
    topic: string,
  ) {
    const skuFacts = new Map(
      (
        await this.catalog.webSkuFacts(
          tx,
          orgId,
          facts.lines.map((line) => line.skuId),
        )
      ).map((fact) => [fact.id, fact]),
    );
    const [productLegacy, variantLegacy] = await Promise.all([
      this.storefront.legacyIdsFor(
        tx,
        orgId,
        'product',
        [...skuFacts.values()].map((fact) => fact.productId),
      ),
      this.storefront.legacyIdsFor(
        tx,
        orgId,
        'variant',
        facts.lines.map((line) => line.skuId),
      ),
    ]);
    const total = add(
      sub(poisha(facts.itemsPoisha), poisha(facts.discountPoisha)),
      poisha(facts.deliveryChargePoisha),
    );
    return {
      id: row.ncom_order_id,
      orderNumber: facts.orderNo,
      status: ncomStatusFor(status),
      fulfilmentStatus: status,
      paymentStatus: poisha(facts.advancePaidPoisha) >= total && total > 0n ? 'paid' : 'pending',
      currencyCode: 'BDT',
      subtotalCents: ncomCentsOf(poisha(facts.itemsPoisha)),
      discountTotalCents: ncomCentsOf(poisha(facts.discountPoisha)),
      shippingTotalCents: ncomCentsOf(poisha(facts.deliveryChargePoisha)),
      taxTotalCents: 0,
      totalCents: ncomCentsOf(total),
      cancelledAt:
        topic === 'order.cancelled' || status === 'returned' ? new Date().toISOString() : null,
      note: facts.notes,
      shippingAddress: {
        name: facts.recipient.name,
        phone: facts.recipient.phoneE164,
        email: null,
        address1: facts.recipient.addressLine,
        address2: facts.recipient.area,
        city: facts.recipient.districtEn,
        province: null,
        postalCode: null,
        countryCode: 'BD',
      },
      lines: facts.lines.map((line) => {
        const productId = skuFacts.get(line.skuId)?.productId ?? null;
        return {
          productId: productId === null ? null : (productLegacy.get(productId) ?? productId),
          variantId: variantLegacy.get(line.skuId) ?? line.skuId,
          source: 'website',
          title: line.productName,
          variantTitle: null,
          sku: line.skuCode,
          imageUrl: null,
          quantity: line.qty,
          unitPriceCents: ncomCentsOf(poisha(line.unitPricePoisha)),
          discountCents: 0,
          taxCents: 0,
          totalCents: ncomCentsOf(mulQty(poisha(line.unitPricePoisha), line.qty)),
          requiresShipping: true,
          weightGrams: 0,
          isGift: false,
        };
      }),
    };
  }

  /**
   * Send one order's waiting messages to ncom, oldest first, stopping at the first that does
   * not land (the queue is per order: a later change must not overtake an earlier one). No
   * transaction is open while ncom is called (invariant 6).
   */
  async send(orgId: string, orderId: string): Promise<void> {
    for (let guard = 0; guard < 20; guard += 1) {
      const next = await withOrg({ orgId }, async (tx) => {
        const [message] = await repo.pendingForOrder(tx, orgId, orderId);
        if (message === undefined) return null;
        const due =
          message.next_attempt_at === null ||
          new Date(message.next_attempt_at).getTime() <= Date.now();
        if (!due) return null;
        const settings = await repo.settingsOf(tx, orgId);
        return { message, settings };
      });
      if (next === null) return;
      const { message, settings } = next;
      const secret = settings === undefined ? null : this.auth.orderSecretOf(orgId, settings);
      const url = settings === undefined ? '' : callbackUrl(settings.base_url);
      if (settings === undefined || secret === null || url === '' || settings.order_key_id === '') {
        await withOrg({ orgId }, (tx) =>
          repo.recordDelivery(tx, {
            orgId,
            id: message.id,
            status: 'failed',
            statusCode: null,
            error: 'ncom credentials are not configured',
            retryAfterSeconds: null,
          }),
        );
        return;
      }
      let body: string;
      try {
        body =
          message.payload_sealed === null
            ? ''
            : open(message.payload_sealed, {
                orgId,
                row: `ncom_outbox:${message.idempotency_key}`,
                field: 'payload',
              });
      } catch (error) {
        if (!(error instanceof SealedBoxUnavailable)) throw error;
        body = '';
      }
      if (body === '') {
        await withOrg({ orgId }, (tx) =>
          repo.recordDelivery(tx, {
            orgId,
            id: message.id,
            status: 'failed',
            statusCode: null,
            error: 'the message could not be opened on this server',
            retryAfterSeconds: null,
          }),
        );
        return;
      }
      const answer = await this.transport.post(url, body, {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'ERP-NcomOrders/1',
        'x-ncom-key': settings.order_key_id,
        'x-ncom-contract': NCOM_CONTRACT,
        'x-ncom-idempotency-key': message.idempotency_key,
        'x-ncom-signature': ncomSignatureHeader(secret, body, Math.floor(Date.now() / 1000)),
      });
      const attempt = message.attempts + 1;
      const outcome = ncomDeliveryOutcome(answer.status, attempt);
      await withOrg({ orgId }, (tx) =>
        repo.recordDelivery(tx, {
          orgId,
          id: message.id,
          status:
            outcome.state === 'retry'
              ? 'pending'
              : outcome.state === 'delivered'
                ? 'delivered'
                : outcome.state,
          statusCode: answer.status,
          error:
            outcome.state === 'delivered'
              ? null
              : outcome.state === 'retry'
                ? answer.status === null
                  ? `No answer from ncom: ${answer.error}`
                  : `ncom answered ${String(answer.status)}`
                : outcome.state === 'refused' && outcome.reason === 'version_conflict'
                  ? `ncom holds a different version of this order. ${answer.text.slice(0, 200)}`
                  : `ncom refused it (${outcome.reason}). ${answer.text.slice(0, 200)}`,
          retryAfterSeconds: outcome.state === 'retry' ? outcome.afterSeconds : null,
        }),
      );
      if (outcome.state !== 'delivered') return;
    }
  }

  /** Every brand's orders with a message whose backoff has passed: queue their senders. */
  async sweep(): Promise<number> {
    const orgIds = await withGlobal(async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        sql`select id from org.organizations where is_active`,
      );
      return [...rows].map((row) => row.id);
    });
    let queued = 0;
    for (const orgId of orgIds) {
      queued += await withOrg({ orgId }, async (tx) => {
        await repo.purgeEvents(tx, orgId);
        const due = await repo.dueOrders(tx, orgId, 50);
        for (const orderId of due) {
          await enqueue(
            tx,
            MARKETPLACE_QUEUES.send.name,
            { orderId },
            { orgId, ref: orderId, singletonKey: `ncom-send:${orderId}` },
          );
        }
        return due.length;
      });
    }
    return queued;
  }

  // --- pieces ---------------------------------------------------------------------------------

  /** ncom's lines split into ours (resolved to SKUs) and theirs (recorded, never picked). */
  private async rebuild(tx: Tx, orgId: string, order: NcomOrder): Promise<Rebuilt> {
    const lines = (Array.isArray(order.lines) ? order.lines : []) as NcomLine[];
    const warnings: string[] = [];
    const productKeys = lines
      .filter((line) => line.source === 'website')
      .map((line) => str(line.productId, 128))
      .filter((key) => key !== '');
    const legacyProducts = await this.storefront.legacyIds(
      tx,
      orgId,
      'product',
      productKeys.filter((key) => !UUID.test(key)),
    );
    const productIdOf = (key: string): string | null =>
      UUID.test(key) ? key.toLowerCase() : (legacyProducts.get(key) ?? null);
    const productIds = [
      ...new Set(productKeys.map(productIdOf).filter((id): id is string => id !== null)),
    ];
    const skus = await this.catalog.webSkus(tx, orgId, productIds);
    const variantKeys = lines
      .map((line) => str(line.variantId, 128))
      .filter((key) => key !== '' && !UUID.test(key));
    const legacyVariants = await this.storefront.legacyIds(tx, orgId, 'variant', variantKeys);
    const facts = new Map(
      (
        await this.catalog.webSkuFacts(
          tx,
          orgId,
          skus.map((sku) => sku.id),
        )
      ).map((fact) => [fact.id, fact]),
    );

    const resolved: { line: NcomLine; skuId: string | null }[] = [];
    let unresolved = 0;
    for (const line of lines) {
      const productId = line.source === 'website' ? productIdOf(str(line.productId, 128)) : null;
      const candidates =
        productId === null ? [] : skus.filter((sku) => sku.productId === productId);
      const skuId = matchVariant(candidates, line, legacyVariants);
      if (skuId === null && line.source === 'website') {
        unresolved += 1;
        warnings.push(
          `"${str(line.title, 120)}"${str(line.variantTitle, 60) === '' ? '' : ` (${str(line.variantTitle, 60)})`} is no longer in this shop's catalogue.`,
        );
      }
      resolved.push({ line, skuId });
    }
    return { lines: resolved, unresolved, warnings, facts };
  }

  /**
   * ncom's money for the order (`ncomOrderMoney`), refused when it does not add up, and the
   * brand's lines merged per SKU. A SKU on two lines at different prices takes the higher
   * one; the order's discount is whatever makes it collect exactly the brand's part.
   */
  private price(rebuilt: Rebuilt, order: NcomOrder): Priced {
    const money = ncomOrderMoney({
      lines: rebuilt.lines.map(({ line, skuId }) => ({
        ours: skuId !== null,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        totalCents: line.totalCents,
      })),
      shippingTotalCents: order.shippingTotalCents,
      discountTotalCents: order.discountTotalCents,
      couponDiscountCents: order.couponDiscountCents,
      taxTotalCents: order.taxTotalCents,
      totalCents: order.totalCents,
    });
    if (!money.ok) throw new NcomRefusal(400, { error: money.reason });
    const ours = new Map<string, { skuId: string; qty: number; unitPricePoisha: Poisha }>();
    const foreign: ForeignItem[] = [];
    rebuilt.lines.forEach(({ line, skuId }, index) => {
      const priced = money.lines[index];
      if (priced === undefined) return;
      if (skuId === null) {
        foreign.push({
          title: str(line.title, 200) || 'Item',
          variantTitle: str(line.variantTitle, 100),
          sku: str(line.sku, 100),
          quantity: priced.quantity,
          pricePoisha: priced.valuePoisha.toString(),
        });
        return;
      }
      const existing = ours.get(skuId);
      if (existing === undefined) {
        ours.set(skuId, { skuId, qty: priced.quantity, unitPricePoisha: priced.unitPricePoisha });
      } else {
        existing.qty += priced.quantity;
        if (priced.unitPricePoisha > existing.unitPricePoisha) {
          existing.unitPricePoisha = priced.unitPricePoisha;
        }
      }
    });
    const merged = [...ours.values()];
    const items = sum(merged.map((line) => mulQty(line.unitPricePoisha, line.qty)));
    // Never negative: each line's unit price covers its value, and the brand collects its
    // goods less their discount plus delivery.
    const discount = sub(add(items, money.deliveryPoisha), money.codPoisha);
    return {
      ours: merged,
      foreign,
      deliveryPoisha: money.deliveryPoisha,
      discountPoisha: discount,
      codPoisha: money.codPoisha,
      foreignPoisha: money.foreignPoisha,
    };
  }

  /** The courier's district and thana for ncom's free-text address (D-556). */
  private async placeOf(
    tx: Tx,
    address: Record<string, unknown>,
    warnings: string[],
  ): Promise<{
    districtId: number;
    thanaId: number;
    districtName: string;
    area: string;
    addressLine: string;
  }> {
    const texts = [
      str(address.district, 120),
      str(address.city, 120),
      str(address.province, 120),
      str(address.address1, 300),
      str(address.address2, 300),
    ];
    const districts = (await repo.districts(tx)).map((row) => ({
      id: row.id,
      nameEn: row.name_en,
      nameBn: row.name_bn,
    }));
    let district = matchDistrict(texts, districts);
    if (district === null) {
      district =
        districts.find((row) => row.nameEn === DHAKA_DISTRICT_NAME) ?? districts[0] ?? null;
      warnings.push(
        'The district could not be read from ncom’s address: check it before booking the courier.',
      );
    }
    if (district === null) throw new Error('the geography is not seeded');
    const thanas = (await repo.thanasOf(tx, district.id)).map((row) => ({
      id: row.id,
      nameEn: row.name_en,
      nameBn: row.name_bn,
    }));
    let thana = matchThana([str(address.thana, 120), str(address.area, 120), ...texts], thanas);
    if (thana === null) {
      thana = thanas[0] ?? null;
      warnings.push(
        'The thana could not be read from ncom’s address: check it before booking the courier.',
      );
    }
    if (thana === null) throw new Error('the district has no thanas');
    const lineText = [str(address.address1, 300), str(address.address2, 300)]
      .filter((part) => part !== '')
      .join(', ');
    return {
      districtId: district.id,
      thanaId: thana.id,
      districtName: district.nameEn,
      area: str(address.area, 160),
      addressLine: (lineText.length >= 3
        ? lineText
        : `${lineText} ${district.nameEn}`.trim()
      ).slice(0, 500),
    };
  }

  /** The first web location that holds every line, or null. */
  private async holdLocation(
    tx: Tx,
    orgId: string,
    lines: readonly { skuId: string; qty: number }[],
  ): Promise<string | null> {
    const locations = await this.storefront.webLocationIds(tx, orgId);
    const levels = await this.inventory.levelsAt(
      tx,
      orgId,
      lines.map((line) => line.skuId),
      [...locations],
    );
    for (const locationId of locations) {
      const free = availableForWeb(
        levels.filter((level) => level.locationId === locationId),
        [locationId],
      );
      if (lines.every((line) => (free.get(line.skuId) ?? 0) >= line.qty)) return locationId;
    }
    return null;
  }
}

/**
 * Which of a product's SKUs ncom's line is for (the old `matchVariant`): its variant id (ours
 * or the old site's), then its variant title (`M`, or `M / Red`), then its SKU code, then the
 * only size a single-size product has.
 */
function matchVariant(
  candidates: readonly {
    id: string;
    code: string;
    values: readonly { kind: string; label: string }[];
  }[],
  line: NcomLine,
  legacyVariants: ReadonlyMap<string, string>,
): string | null {
  if (candidates.length === 0) return null;
  const variantId = str(line.variantId, 128);
  if (variantId !== '' && variantId !== 'undefined') {
    const wanted = UUID.test(variantId) ? variantId.toLowerCase() : legacyVariants.get(variantId);
    const byId = candidates.find((sku) => sku.id === wanted);
    if (byId !== undefined) return byId.id;
  }
  const title = str(line.variantTitle, 100).toLowerCase();
  if (title !== '' && title !== 'default') {
    const byTitle = candidates.find((sku) => {
      const labels = sku.values.map((value) => value.label.toLowerCase());
      return labels.join(' / ') === title || labels.includes(title);
    });
    if (byTitle !== undefined) return byTitle.id;
  }
  const code = str(line.sku, 100);
  if (code !== '') {
    const byCode = candidates.find((sku) => sku.code === code);
    if (byCode !== undefined) return byCode.id;
  }
  return candidates.length === 1 ? (candidates[0]?.id ?? null) : null;
}

/** Where ncom listens for these: derived from its REST base, as the old site did. */
export function callbackUrl(baseUrl: string): string {
  try {
    const url = new URL('/api/orders/callback', baseUrl);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function isUnique(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === '23505') return true;
  }
  return false;
}

/**
 * A refusal the orders module answered with, whatever wrapped it: `OrdersApi.editOrder` maps
 * its errors to HTTP exceptions, `createOrder` and `transition` throw the module's own. Its
 * contract code and message, or null for anything that is not a refusal (a 5xx, a bug).
 */
function orderRefusal(error: unknown): { code: string; message: string } | null {
  if (error instanceof HttpException) {
    if (error.getStatus() >= 500) return null;
    const body = error.getResponse() as { code?: unknown; message?: unknown } | string;
    return typeof body === 'string'
      ? { code: 'REFUSED', message: body }
      : {
          code: typeof body.code === 'string' ? body.code : 'REFUSED',
          message: typeof body.message === 'string' ? body.message : error.message,
        };
  }
  if (error instanceof OrderError) return { code: error.code, message: error.message };
  const code = (error as { code?: unknown } | null)?.code;
  // A contract code (`STOCK_INSUFFICIENT`), never a database SQLSTATE (`23505`).
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,}$/.test(code)
    ? { code, message: error instanceof Error ? error.message : code }
    : null;
}
