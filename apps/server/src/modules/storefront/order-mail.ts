import { Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { poisha, type OrderStatus } from '@elysium/domain';
import { takaDecimal } from '@elysium/domain/storefront';

import type { DeliveredEvent } from '../../platform/events/dispatcher.js';
import { NOTIFY_API, type NotifyApi } from '../notify/notify.api.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import * as buying from './buying.repository.js';
import { StorefrontService } from './storefront.service.js';
import { newToken, tokenHash } from './tokens.js';

export type OrderEmailTemplate =
  'order.placed' | 'order.confirmed' | 'order.shipped' | 'order.delivered' | 'order.cancelled';

/** The statuses a shopper hears about by email, and the template for each (D-530). */
const EMAIL_FOR: Partial<Record<OrderStatus, OrderEmailTemplate>> = {
  confirmed: 'order.confirmed',
  shipped: 'order.shipped',
  delivered: 'order.delivered',
  cancelled: 'order.cancelled',
};

/**
 * A website order's emails (M34, D-529, D-530): "placed" from the checkout's own transaction,
 * and "confirmed", "shipped" (with the courier and its tracking code), "delivered" and
 * "cancelled" from the order's status events, in the worker after the change committed.
 *
 * Each email carries a link to the shopper's order page on the brand's own website, with a fresh
 * order view token (stored hashed, D-524) so a guest can open it from the email. The email is
 * once per order and template (`dedupeKey`), however often the event is delivered. A brand with
 * no website address set gets the email without a link; one with no email server switched on
 * gets it recorded as skipped.
 */
@Injectable()
export class OrderMail {
  constructor(
    @Inject(NOTIFY_API) private readonly notify: NotifyApi,
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    private readonly settings: StorefrontService,
  ) {}

  async queueOrderEmail(
    tx: Tx,
    orgId: string,
    input: {
      readonly orderId: string;
      readonly orderNo: string;
      readonly template: OrderEmailTemplate;
      readonly to: string;
      readonly locale: string;
      readonly name: string;
      readonly totalPoisha?: bigint;
      readonly courier?: string;
      readonly trackingCode?: string;
    },
  ): Promise<void> {
    const settings = await this.settings.settingsIn(tx, orgId);
    const siteUrl = settings.siteInfo.siteUrl.replace(/\/+$/, '');
    let orderUrl = '';
    if (siteUrl.startsWith('https://')) {
      const token = newToken();
      await buying.insertViewToken(tx, {
        orgId,
        orderId: input.orderId,
        tokenSha256: tokenHash(token),
        purpose: 'email',
      });
      orderUrl = `${siteUrl}/order-confirmation/${encodeURIComponent(input.orderNo)}?token=${token}`;
    }
    await this.notify.queueEmail(tx, orgId, {
      templateKey: input.template,
      to: input.to,
      locale: input.locale === 'en' ? 'en' : 'bn',
      values: {
        brand: settings.siteInfo.siteName,
        name: input.name,
        orderNo: input.orderNo,
        orderUrl,
        total: input.totalPoisha === undefined ? '' : `৳${takaDecimal(poisha(input.totalPoisha))}`,
        courier: input.courier ?? '',
        trackingCode: input.trackingCode ?? '',
      },
      refType: 'order',
      refId: input.orderId,
      dedupeKey: `order:${input.orderId}:${input.template}`,
    });
  }

  /**
   * The outbox subscriber for `order.status_changed` (D-530). Runs in the worker's dispatch
   * loop; a desk order, a website order without an email, or a status shoppers are not told
   * about is nothing to do.
   */
  async onStatusChanged(event: DeliveredEvent): Promise<void> {
    const payload = event.payload as { id?: unknown; to?: unknown };
    if (typeof payload.id !== 'string' || typeof payload.to !== 'string') return;
    const template = EMAIL_FOR[payload.to as OrderStatus];
    if (template === undefined) return;
    const orderId = payload.id;
    await withOrg({ orgId: event.orgId, userId: 'system:storefront' }, async (tx) => {
      const web = await buying.webOrder(tx, event.orgId, orderId);
      if (web?.email == null) return;
      const [order] = await this.orders.shopperOrders(tx, event.orgId, [orderId]);
      if (order === undefined) return;
      const tracking =
        template === 'order.shipped'
          ? await this.orders.parcelTracking(tx, event.orgId, orderId)
          : null;
      await this.queueOrderEmail(tx, event.orgId, {
        orderId,
        orderNo: order.orderNo,
        template,
        to: web.email,
        locale: web.locale,
        name: order.shipTo.name,
        ...(tracking === null
          ? {}
          : {
              courier: tracking.courierName,
              trackingCode: tracking.trackingCode ?? tracking.consignmentNo ?? '',
            }),
      });
    });
  }
}
