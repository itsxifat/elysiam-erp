import { Inject, Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import { code128Svg, formatBdPhoneForDisplay, poisha } from '@elysium/domain';

import { assertInScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { fontFaceCss, loadFonts, type FontFile } from '../files/pdf/fonts.js';
import { GotenbergClient } from '../files/pdf/gotenberg.client.js';
import { formatTaka } from '../files/pdf/invoice.template.js';
import { CourierError } from './courier.errors.js';
import * as repo from './courier.repository.js';
import { ORDERS_PORT, type OrdersPort } from './ports/orders.port.js';

/**
 * Courier labels (M15's "label printing", through M04's Gotenberg slice; §22's "courier
 * label" template).
 *
 * One label per page at 4 × 6 inches — the thermal label every Bangladeshi courier's pickup
 * desk scans — rendered by the same headless Chromium and the same vendored Hind Siliguri as
 * the invoice, because a label is Bangla (D-036) and Bangla conjuncts only shape correctly in
 * a real text engine.
 *
 * ## What is on it, and what is not
 *
 * The courier's consignment number, as a Code 128 barcode and in text; our order number; the
 * recipient's name, **full** phone number and address; and the amount to collect, large. The
 * phone is complete for the reason the packing slip's is: the rider calls it from the gate,
 * and invariant 10 is about logs, fixtures and prompts, not the one document whose job is to
 * get the parcel to that person.
 *
 * No item prices, no item list and no cost. A label is stuck on the outside of a box.
 *
 * Only a **booked** parcel gets a label. A label without the courier's number on it is a box
 * the pickup desk cannot scan, and printing one would invite exactly that.
 */

export const MAX_LABELS_PER_REQUEST = 100;

export interface LabelData {
  readonly brandName: string;
  readonly courierName: string;
  readonly consignmentNo: string;
  readonly trackingCode: string | null;
  readonly orderNo: string;
  readonly recipientName: string;
  /** Display form, in full: the rider calls it. */
  readonly recipientPhone: string;
  readonly addressLine: string;
  readonly area: string | null;
  readonly thana: string;
  readonly district: string;
  readonly codAmountPoisha: bigint;
  readonly note: string | null;
}

@Injectable()
export class CourierLabelsService {
  constructor(
    private readonly gotenberg: GotenbergClient,
    @Inject(ORDERS_PORT) private readonly orders: OrdersPort,
  ) {}

  /** Everything the labels need, in one transaction and inside the caller's scope. */
  async gather(
    context: ActiveContext,
    request: object,
    consignmentIds: readonly string[],
  ): Promise<LabelData[]> {
    const ids = [...new Set(consignmentIds)];
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.labelRows(tx, context.orgId, ids);
      if (rows.length !== ids.length) {
        // One answer for "missing" and "another org's": a label request must not be a way to
        // learn which consignment ids exist.
        throw new CourierError('CONSIGNMENT_NOT_FOUND', 'One of those parcels does not exist.');
      }
      const unbooked = rows.filter(
        (row) => row.booking_state !== 'booked' || row.consignment_no === null,
      );
      if (unbooked.length > 0) {
        throw new CourierError(
          'CONSIGNMENT_INVALID',
          `Not booked with the courier yet, so there is no number to print: ${unbooked
            .map((row) => row.order_no)
            .join(', ')}.`,
        );
      }

      const brandName = await repo.orgDisplayName(tx, context.orgId);
      const labels: LabelData[] = [];
      for (const row of rows) {
        // §6's branch narrowing on each parcel, before its address is read.
        assertInScope(request, { branchId: row.branch_id });
        const order = await this.orders.bookingSnapshot(tx, context.orgId, row.order_id);
        if (order === null) {
          throw new CourierError('ORDER_NOT_FOUND', 'That parcel’s order is gone.');
        }
        labels.push({
          brandName,
          courierName: row.courier_name,
          consignmentNo: row.consignment_no ?? '',
          trackingCode: row.tracking_code,
          orderNo: row.order_no,
          recipientName: order.recipientName,
          recipientPhone: formatBdPhoneForDisplay(order.recipientPhoneE164),
          addressLine: order.addressLine,
          area: order.area,
          thana: order.thana,
          district: order.district,
          // The consignment's COD, which is what the courier was told to collect — not the
          // order's current figure, which somebody may have edited after booking.
          codAmountPoisha: BigInt(row.cod_amount_poisha),
          note: order.notes,
        });
      }
      return labels;
    });
  }

  async render(
    context: ActiveContext,
    request: object,
    consignmentIds: readonly string[],
  ): Promise<{ bytes: Uint8Array; filename: string }> {
    const labels = await this.gather(context, request, consignmentIds);
    const fonts = await loadFonts();
    const bytes = await this.gotenberg.renderPdf({
      html: renderLabelsHtml({ labels, fonts }),
      assets: fonts.map((font) => ({
        filename: font.filename,
        bytes: font.bytes,
        contentType: 'font/woff2',
      })),
      paperWidth: 4,
      paperHeight: 6,
      marginInches: 0.12,
    });
    const first = labels[0]?.orderNo ?? 'labels';
    return {
      bytes,
      filename: labels.length === 1 ? `${first}-label.pdf` : `courier-labels-${String(labels.length)}.pdf`,
    };
  }
}

/**
 * HTML-escape, without exception: a recipient's name and a desk note are attacker-controlled
 * text on a page a real browser renders.
 */
function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A barcode only for a number that is plainly an identifier.
 *
 * The consignment number is the courier's text. Code 128 can carry most ASCII, but the SVG
 * the encoder emits puts its payload in an attribute, so anything outside a conservative
 * alphabet is printed as text only rather than trusted into markup.
 */
function barcodeFor(consignmentNo: string): string {
  if (!/^[A-Za-z0-9-]{1,40}$/.test(consignmentNo)) return '';
  return `<div class="barcode">${code128Svg(consignmentNo, 50)}</div>`;
}

/** The labels as one HTML document, a page each. Exported so a test can read the page. */
export function renderLabelsHtml(input: {
  readonly labels: readonly LabelData[];
  readonly fonts: readonly FontFile[];
}): string {
  const pages = input.labels
    .map((label) => {
      const address = [label.addressLine, label.area, label.thana, label.district]
        .filter((part): part is string => part !== null && part.trim() !== '')
        .map(escape)
        .join(', ');
      return `
    <section class="label">
      <header>
        <div class="brand">${escape(label.brandName)}</div>
        <div class="courier">${escape(label.courierName)}</div>
      </header>
      ${barcodeFor(label.consignmentNo)}
      <div class="numbers">
        <div><span class="k">কনসাইনমেন্ট</span> <strong>${escape(label.consignmentNo)}</strong></div>
        ${label.trackingCode !== null && label.trackingCode !== label.consignmentNo ? `<div><span class="k">ট্র্যাকিং</span> ${escape(label.trackingCode)}</div>` : ''}
        <div><span class="k">অর্ডার</span> ${escape(label.orderNo)}</div>
      </div>
      <div class="to">
        <div class="k">প্রাপক</div>
        <div class="name">${escape(label.recipientName)}</div>
        <div class="phone">${escape(label.recipientPhone)}</div>
        <div class="address">${address}</div>
      </div>
      <div class="cod">
        <div class="k">সংগ্রহ করুন</div>
        <div class="amount">${escape(formatTaka(poisha(label.codAmountPoisha)))}</div>
      </div>
      ${label.note === null || label.note.trim() === '' ? '' : `<footer>নির্দেশনা: ${escape(label.note)}</footer>`}
    </section>`;
    })
    .join('');

  return `<!doctype html>
<html lang="bn">
  <head>
    <meta charset="utf-8" />
    <style>
      ${fontFaceCss(input.fonts)}
      :root { --ink: oklch(0.2 0 0); --muted: oklch(0.45 0 0); --hairline: oklch(0.75 0 0); }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: 'Hind Siliguri', 'Noto Sans Bengali', sans-serif; color: var(--ink); font-size: 10pt; line-height: 1.35; }
      .label { page-break-after: always; break-after: page; display: flex; flex-direction: column; gap: 6pt; height: 100%; }
      .label:last-child { page-break-after: auto; break-after: auto; }
      header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid var(--hairline); padding-bottom: 4pt; }
      .brand { font-weight: 600; font-size: 11pt; }
      .courier { font-weight: 600; font-size: 12pt; }
      .barcode svg { width: 100%; height: 50pt; display: block; }
      .numbers { font-variant-numeric: tabular-nums; }
      .k { color: var(--muted); font-size: 8.5pt; }
      .to { border-top: 1px solid var(--hairline); padding-top: 4pt; }
      .name { font-weight: 600; font-size: 12pt; }
      .phone { font-size: 12pt; font-variant-numeric: tabular-nums; }
      .cod { border: 1px solid var(--ink); padding: 4pt 6pt; display: flex; justify-content: space-between; align-items: center; }
      .amount { font-weight: 600; font-size: 16pt; font-variant-numeric: tabular-nums; }
      footer { font-size: 9pt; color: var(--muted); }
    </style>
  </head>
  <body>${pages}
  </body>
</html>`;
}
