import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import {
  code128Encode,
  code128Svg,
  CODE128_QUIET_MODULES,
  formatBdPhoneForDisplay,
  poisha,
  takaText,
} from '@elysium/domain';

import { assertInScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { DOCUMENT_FONT_STACK, fontFaceCss, loadFonts, type FontFile } from '../files/pdf/fonts.js';
import { GotenbergClient } from '../files/pdf/gotenberg.client.js';
import { CourierError } from './courier.errors.js';
import * as repo from './courier.repository.js';
import { ORDERS_PORT, type OrdersPort } from './ports/orders.port.js';

/**
 * Courier labels (M15's "label printing", through M04's Gotenberg slice; §22's "courier
 * label" template).
 *
 * One label per page at 4 × 6 inches — the thermal label every Bangladeshi courier's pickup
 * desk scans — rendered by the same headless Chromium and the same Inter as the order's own
 * documents (D-753), in English (D-750), in black ink only: a thermal head prints grey as ash.
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
      /*
       * §6's branch narrowing on every parcel **first**, before any other answer. An
       * out-of-scope parcel answers exactly as a missing one, and never reaches the "not
       * booked" message below — which names order numbers, and would otherwise hand a
       * branch-scoped caller the numbers of another branch's orders (M15 ledger audit m3).
       */
      for (const row of rows) {
        try {
          assertInScope(request, { branchId: row.branch_id });
        } catch (error) {
          if (error instanceof NotFoundException) {
            throw new CourierError('CONSIGNMENT_NOT_FOUND', 'One of those parcels does not exist.');
          }
          throw error;
        }
      }
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
      // The couriers' names, from the module that owns them (invariant 12). One call
      // for the sheet rather than one per label.
      const courierNames = new Map(
        (
          await this.orders.courierParties(
            tx,
            context.orgId,
            rows.map((row) => row.courier_id),
          )
        ).map((party) => [party.id, party.name]),
      );
      const labels: LabelData[] = [];
      for (const row of rows) {
        const order = await this.orders.bookingSnapshot(tx, context.orgId, row.order_id);
        if (order === null) {
          throw new CourierError('ORDER_NOT_FOUND', 'That parcel’s order is gone.');
        }
        labels.push({
          brandName,
          courierName: courierNames.get(row.courier_id) ?? '',
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
      // Exactly 4 × 6 in; the label draws its own margin (M43).
      paperWidth: 4,
      paperHeight: 6,
      marginInches: 0,
    });
    const first = labels[0]?.orderNo ?? 'labels';
    return {
      bytes,
      filename:
        labels.length === 1 ? `${first}-label.pdf` : `courier-labels-${String(labels.length)}.pdf`,
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
  // Three dots of a 203 dpi head per module (0.375 mm), so every bar lands on whole dots.
  const modules = code128Encode(consignmentNo).width + CODE128_QUIET_MODULES * 2;
  const width = Math.min(92, Math.round(modules * 0.375 * 100) / 100);
  return `<div class="barcode">${code128Svg(consignmentNo, 40).replace(
    '<svg ',
    `<svg width="${String(width)}mm" height="17mm" `,
  )}</div>`;
}

/** The labels as one HTML document, a page each. Exported so a test can read the page. */
export function renderLabelsHtml(input: {
  readonly labels: readonly LabelData[];
  readonly fonts: readonly FontFile[];
}): string {
  const pages = input.labels
    .map((label) => {
      const area = [label.area, label.thana, label.district]
        .filter((part): part is string => part !== null && part.trim() !== '')
        .map(escape)
        .join(', ');
      const nothing = label.codAmountPoisha <= 0n;
      return `
    <section class="label">
      <div class="top">
        <div class="brand">${escape(label.brandName)}</div>
        <div class="courier">${escape(label.courierName)}</div>
      </div>
      ${barcodeFor(label.consignmentNo)}
      <div class="cn"><span class="caption">Consignment</span> <strong>${escape(label.consignmentNo)}</strong></div>
      <div class="numbers">
        <div><span class="caption">Order</span> ${escape(label.orderNo)}</div>
        ${label.trackingCode !== null && label.trackingCode !== label.consignmentNo ? `<div><span class="caption">Tracking</span> ${escape(label.trackingCode)}</div>` : ''}
      </div>
      <div class="to">
        <div class="caption">Deliver to</div>
        <div class="name">${escape(label.recipientName)}</div>
        <div class="phone">${escape(label.recipientPhone)}</div>
        <div class="address">${escape(label.addressLine)}</div>
        <div class="area">${area}</div>
      </div>
      <div class="cod">
        <div class="cod-label">${nothing ? 'Paid in full · Collect nothing' : 'Cash on delivery · Collect'}</div>
        <div class="amount">${escape(takaText(poisha(nothing ? 0n : label.codAmountPoisha)))}</div>
      </div>
      ${label.note === null || label.note.trim() === '' ? '' : `<footer><span class="caption">Note</span> ${escape(label.note)}</footer>`}
    </section>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      ${fontFaceCss(input.fonts)}
      @page { size: 101.6mm 152.4mm; margin: 0; }
      * { box-sizing: border-box; }
      html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      body { margin: 0; font-family: ${DOCUMENT_FONT_STACK}; color: #000; font-size: 9pt; line-height: 1.3; }
      /* A hair under the page, so rounding from millimetres never spills onto a second label. */
      .label { width: 101.6mm; height: 152.2mm; padding: 4mm 4.5mm; display: flex; flex-direction: column; gap: 2mm; overflow: hidden; page-break-after: always; break-after: page; }
      .label:last-child { page-break-after: auto; break-after: auto; }
      .caption { font-size: 6.5pt; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
      .top { display: flex; justify-content: space-between; align-items: center; gap: 3mm; padding-bottom: 2mm; border-bottom: 1.5pt solid #000; }
      .brand { font-weight: 700; font-size: 10pt; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .courier { flex: none; background: #000; color: #fff; padding: 1mm 2.4mm; font-weight: 700; font-size: 9pt; letter-spacing: 0.04em; text-transform: uppercase; }
      .barcode { text-align: center; line-height: 0; color: #000; }
      .barcode svg { display: inline-block; }
      .cn { text-align: center; font-size: 14pt; letter-spacing: 0.04em; }
      .cn strong { font-weight: 700; }
      .numbers { display: flex; justify-content: space-between; gap: 2mm; font-weight: 600; }
      .to { border-top: 1.5pt solid #000; padding-top: 2.4mm; }
      .name { margin-top: 1mm; font-weight: 700; font-size: 16pt; line-height: 1.15; overflow-wrap: anywhere; }
      .phone { margin-top: 0.6mm; font-weight: 700; font-size: 16pt; letter-spacing: 0.02em; }
      .address { margin-top: 1.4mm; font-weight: 600; font-size: 11pt; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden; }
      .area { margin-top: 0.6mm; font-weight: 700; font-size: 11pt; text-transform: uppercase; letter-spacing: 0.03em; }
      .cod { margin-top: auto; border: 2pt solid #000; }
      .cod-label { background: #000; color: #fff; padding: 1.2mm 2.6mm; font-size: 7.5pt; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
      .amount { padding: 1.4mm 2.6mm 1.6mm; font-weight: 700; font-size: 22pt; line-height: 1.05; white-space: nowrap; font-variant-numeric: tabular-nums; }
      footer { font-size: 8.5pt; font-weight: 500; overflow-wrap: anywhere; }
    </style>
  </head>
  <body>${pages}
  </body>
</html>`;
}
