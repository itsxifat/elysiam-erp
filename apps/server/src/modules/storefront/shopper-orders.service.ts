import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { add, mulQty, poisha, sub } from '@elysium/domain';
import {
  shopperPaymentStatus,
  shopperStatusOf,
  SHOPPER_STATUS_LABELS,
  wireMoney,
} from '@elysium/domain/storefront';

import { ORDERS_API, type OrdersApi, type ShopperOrderFacts } from '../orders/orders.api.js';
import * as buying from './buying.repository.js';
import { StorefrontError } from './storefront.errors.js';
import { tokenHash } from './tokens.js';

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function notFound(): StorefrontError {
  return new StorefrontError('NOT_FOUND', HttpStatus.NOT_FOUND, 'No such order.');
}

/**
 * What a shopper sees of an order (M34, D-524): by its view token (a guest's link), or as the
 * account that placed or claimed it. Only shopper-facing fields: the shopper's status words, the
 * money they were charged, the address they gave, the courier's tracking code once the parcel
 * is booked. No cost, no staff, no internal note; a desk order (not placed on the website) is
 * not found here whatever token or account asks.
 */
@Injectable()
export class ShopperOrdersService {
  constructor(@Inject(ORDERS_API) private readonly orders: OrdersApi) {}

  /** A guest's view, by the order number and the token its link carries. */
  async byToken(orgId: string, orderNo: string, token: string) {
    return withOrg({ orgId }, async (tx) => {
      const orderId = await this.orders.orderIdByNumber(tx, orgId, orderNo);
      const tokenOrder = await buying.orderIdForToken(tx, orgId, tokenHash(token));
      if (orderId === undefined || tokenOrder !== orderId) throw notFound();
      return { order: await this.view(tx, orgId, orderId) };
    });
  }

  /** The account's own order, by number. */
  async forAccount(orgId: string, accountId: string, orderNo: string) {
    return withOrg({ orgId }, async (tx) => {
      const orderId = await this.orders.orderIdByNumber(tx, orgId, orderNo);
      if (orderId === undefined) throw notFound();
      const web = await buying.webOrder(tx, orgId, orderId);
      if (web?.account_id !== accountId) throw notFound();
      return { order: await this.view(tx, orgId, orderId) };
    });
  }

  /** The account's orders, newest first, a page at a time. */
  async listForAccount(
    orgId: string,
    accountId: string,
    input: { readonly cursor: string | undefined; readonly limit: number },
  ) {
    const before = decodeCursor(input.cursor);
    return withOrg({ orgId }, async (tx) => {
      const account = await buying.accountById(tx, orgId, accountId);
      if (account === undefined) {
        throw new StorefrontError('ACCOUNT_NOT_FOUND', HttpStatus.NOT_FOUND, 'No such account.');
      }
      const rows = await buying.webOrdersOfAccount(tx, orgId, accountId, {
        before,
        limit: input.limit + 1,
      });
      const page = rows.slice(0, input.limit);
      const facts = new Map(
        (
          await this.orders.shopperOrders(
            tx,
            orgId,
            page.map((row) => row.order_id),
          )
        ).map((order) => [order.id, order]),
      );
      const last = page.at(-1);
      return {
        items: page.flatMap((row) => {
          const order = facts.get(row.order_id);
          return order === undefined ? [] : [summary(order, row.payment_method)];
        }),
        nextCursor:
          rows.length > input.limit && last !== undefined
            ? Buffer.from(
                JSON.stringify([new Date(last.created_at).toISOString(), last.order_id]),
              ).toString('base64url')
            : null,
      };
    });
  }

  /** The full shopper view, inside the caller's transaction. */
  async view(tx: Tx, orgId: string, orderId: string) {
    const [order] = await this.orders.shopperOrders(tx, orgId, [orderId]);
    const web = await buying.webOrder(tx, orgId, orderId);
    if (order === undefined || web === undefined) throw notFound();
    const [lines, sessions, tracking] = await Promise.all([
      this.orders.shopperOrderLines(tx, orgId, orderId),
      buying.sessionsOfOrder(tx, orgId, orderId),
      ['shipped', 'delivered', 'partially_delivered', 'return_in_transit'].includes(order.status)
        ? this.orders.parcelTracking(tx, orgId, orderId)
        : Promise.resolve(null),
    ]);
    const paidOnline = sessions
      .filter((session) => session.status === 'paid')
      .reduce((total, session) => total + BigInt(session.amount_poisha), 0n);
    const method = web.payment_method === 'sslcommerz' ? 'sslcommerz' : 'cod';
    return {
      ...summary(order, method),
      confirmedAt: iso(order.confirmedAt),
      shippedAt: iso(order.shippedAt),
      deliveredAt: iso(order.deliveredAt),
      cancelledAt: iso(order.cancelledAt),
      items: wireMoney(order.itemsPoisha),
      discount: wireMoney(order.discountPoisha),
      delivery: wireMoney(order.deliveryChargePoisha),
      paid: wireMoney(order.advancePaidPoisha),
      dueOnDelivery: wireMoney(order.codAmountPoisha),
      payment: {
        method,
        status: shopperPaymentStatus({
          method,
          paidPoisha: paidOnline,
          codPoisha: order.codAmountPoisha,
          orderStatus: order.status,
        }),
        paidOnline: wireMoney(paidOnline),
      },
      shipTo: {
        name: order.shipTo.name,
        phone: order.shipTo.phoneE164,
        districtId: order.shipTo.districtId,
        thanaId: order.shipTo.thanaId,
        district: { nameEn: order.shipTo.districtEn, nameBn: order.shipTo.districtBn },
        thana: { nameEn: order.shipTo.thanaEn, nameBn: order.shipTo.thanaBn },
        area: order.shipTo.area,
        addressLine: order.shipTo.addressLine,
      },
      lines: lines.map((line) => ({
        skuId: line.skuId,
        sku: line.skuCode,
        name: line.productName,
        qty: line.qty,
        unitPrice: wireMoney(line.unitPricePoisha),
        lineTotal: wireMoney(
          sub(mulQty(poisha(line.unitPricePoisha), line.qty), poisha(line.discountPoisha)),
        ),
      })),
      tracking:
        tracking === null
          ? null
          : {
              courier: tracking.courierName,
              trackingCode: tracking.trackingCode ?? tracking.consignmentNo,
            },
    };
  }
}

function summary(order: ShopperOrderFacts, method: string) {
  const status = shopperStatusOf(order.status);
  return {
    orderNo: order.orderNo,
    status,
    statusLabel: SHOPPER_STATUS_LABELS[status],
    placedAt: order.createdAt.toISOString(),
    total: wireMoney(
      add(
        sub(poisha(order.itemsPoisha), poisha(order.discountPoisha)),
        poisha(order.deliveryChargePoisha),
      ),
    ),
    itemCount: order.unitCount,
    paymentMethod: method,
  };
}

function decodeCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (cursor === undefined || cursor === '') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      !Number.isNaN(Date.parse(parsed[0])) &&
      /^[0-9a-f-]{36}$/i.test(parsed[1])
    ) {
      return { at: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through
  }
  throw new StorefrontError('VALIDATION_FAILED', HttpStatus.BAD_REQUEST, 'cursor: not a cursor.');
}
