import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { OrderLabelsInput } from '@elysium/contracts';
import { withOrg } from '@elysium/db';
import { businessDate, formatBdPhoneForDisplay, poisha, takaText } from '@elysium/domain';

import type { ActiveContext } from '../../platform/http/context.js';
import { loadFonts } from '../files/pdf/fonts.js';
import { GotenbergClient } from '../files/pdf/gotenberg.client.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { STOREFRONT_API, type StorefrontApi } from '../storefront/storefront.api.js';
import { LABEL_PAPER, orderLabelsHtml, type OrderLabel } from './order-labels.js';

const MM_PER_INCH = 25.4;

/**
 * Order labels as a PDF (M35b, D-555), the orders list's bulk action: one label per order, at
 * the paper size chosen, through M04's Gotenberg slice. Every order is checked against the
 * caller's own `read Order` scope before anything about it is read; an order outside it answers
 * as a missing one. No cost is on a label, and the phone is in full: the rider calls it.
 */
@Injectable()
export class OrderLabelsService {
  constructor(
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    @Inject(STOREFRONT_API) private readonly storefront: StorefrontApi,
    private readonly gotenberg: GotenbergClient,
  ) {}

  async gather(
    context: ActiveContext,
    request: object,
    input: OrderLabelsInput,
  ): Promise<OrderLabel[]> {
    const ids = [...new Set(input.orderIds)];
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      for (const id of ids) {
        if (!(await this.orders.orderVisibleTo(tx, context.orgId, id, request))) {
          throw new HttpException(
            { code: 'ORDER_NOT_FOUND', message: 'One of those orders does not exist.' },
            HttpStatus.NOT_FOUND,
          );
        }
      }
      const [facts, site] = await Promise.all([
        this.orders.packingFacts(tx, context.orgId, ids),
        this.storefront.siteFacts(tx, context.orgId),
      ]);
      if (facts.length !== ids.length) {
        throw new HttpException(
          { code: 'ORDER_NOT_FOUND', message: 'One of those orders does not exist.' },
          HttpStatus.NOT_FOUND,
        );
      }
      return facts.map((order) => {
        const total = order.itemsPoisha - order.discountPoisha + order.deliveryChargePoisha;
        const [year, month, day] = businessDate(order.createdAt).split('-');
        const recipient = order.recipient;
        return {
          shopName: site.siteName,
          merchantId: site.merchantId,
          orderNo: order.orderNo,
          date: `${day ?? ''}/${month ?? ''}/${year ?? ''}`,
          scan: order.parcel?.trackingCode ?? order.orderNo,
          consignmentNo: order.parcel?.consignmentNo ?? null,
          recipientName: recipient.name,
          recipientPhone: formatBdPhoneForDisplay(recipient.phoneE164),
          address: [recipient.addressLine, recipient.area, recipient.thanaEn, recipient.districtEn]
            .filter((part): part is string => part !== null && part.trim() !== '')
            .join(', '),
          subtotal: takaText(poisha(order.itemsPoisha)),
          discount: order.discountPoisha > 0n ? takaText(poisha(order.discountPoisha)) : null,
          delivery:
            order.deliveryChargePoisha > 0n ? takaText(poisha(order.deliveryChargePoisha)) : null,
          collect: order.codAmountPoisha > 0n ? takaText(poisha(order.codAmountPoisha)) : null,
          total: takaText(poisha(total)),
          paymentWords:
            order.codAmountPoisha === 0n
              ? 'Paid in advance'
              : order.advancePaidPoisha > 0n
                ? `Cash on delivery (${takaText(poisha(order.advancePaidPoisha))} paid in advance)`
                : 'Cash on delivery',
        };
      });
    });
  }

  async render(
    context: ActiveContext,
    request: object,
    input: OrderLabelsInput,
  ): Promise<{ bytes: Uint8Array; filename: string }> {
    const labels = await this.gather(context, request, input);
    const fonts = await loadFonts();
    const paper = LABEL_PAPER[input.size];
    const bytes = await this.gotenberg.renderPdf({
      html: orderLabelsHtml({ labels, options: input, fonts }),
      assets: fonts.map((font) => ({
        filename: font.filename,
        bytes: font.bytes,
        contentType: 'font/woff2',
      })),
      paperWidth: paper.w / MM_PER_INCH,
      paperHeight: paper.h / MM_PER_INCH,
      marginInches: 0,
    });
    const first = labels[0]?.orderNo ?? 'labels';
    return {
      bytes,
      filename:
        labels.length === 1 ? `${first}-label.pdf` : `order-labels-${String(labels.length)}.pdf`,
    };
  }
}
