import type { OrderLabelSize } from '@elysium/contracts';
import { encode } from 'uqr';

import type { FontFile } from '../files/pdf/fonts.js';
import { fontFaceCss } from '../files/pdf/fonts.js';

/**
 * The order label sheet (M35b, D-555): the old admin's `labels` page — a thermal label or a
 * paper slip per order, with the shop's name and courier merchant id, the order number and date,
 * a QR code of the parcel's tracking code (or the order number before it is booked), the
 * courier's consignment number, the recipient, the prices and the amount to collect.
 *
 * The QR code is what the packing scanner reads (D-554): the scanner resolves a tracking code,
 * an order number or a consignment number to the packing list. Ink is pure black: a thermal
 * head prints grey as patchy ash.
 */

/** Exact paper sizes in millimetres, and whether the label is a small thermal one. */
export const LABEL_PAPER: Readonly<
  Record<
    OrderLabelSize,
    { readonly w: number; readonly h: number; readonly pad: number; readonly compact: boolean }
  >
> = {
  a4: { w: 210, h: 297, pad: 12, compact: false },
  a5: { w: 148, h: 210, pad: 10, compact: false },
  a6: { w: 105, h: 148, pad: 6, compact: false },
  '2x3': { w: 50.8, h: 76.2, pad: 2.5, compact: true },
  '3x2': { w: 76.2, h: 50.8, pad: 2.5, compact: true },
  '4x6': { w: 101.6, h: 152.4, pad: 5, compact: false },
  '100x150': { w: 100, h: 150, pad: 5, compact: false },
  '80mm': { w: 80, h: 140, pad: 4, compact: false },
};

export interface OrderLabel {
  readonly shopName: string;
  readonly merchantId: string;
  readonly orderNo: string;
  /** dd/mm/yyyy, Asia/Dhaka. */
  readonly date: string;
  /** What the QR code carries: the tracking code, else the order number. */
  readonly scan: string;
  readonly consignmentNo: string | null;
  readonly recipientName: string;
  readonly recipientPhone: string;
  readonly address: string;
  readonly subtotal: string;
  readonly discount: string | null;
  readonly delivery: string | null;
  /** The amount to collect; null when nothing is left to collect (paid). */
  readonly collect: string | null;
  readonly total: string;
  readonly paymentWords: string;
}

export interface LabelOptions {
  readonly size: OrderLabelSize;
  readonly layout: 'portrait' | 'landscape';
  readonly showShopName: boolean;
  readonly showQr: boolean;
  readonly showPrices: boolean;
  readonly showCod: boolean;
}

/** HTML-escape everything a person typed: a name or an address is untrusted text. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A QR code as an SVG of whole modules (error correction M, one module of quiet zone), drawn
 * from the encoder's matrix rather than its own markup so the ink is ours: square, black,
 * crisp at any print size.
 */
export function qrSvg(value: string, sizeMm: number): string {
  const { data, size } = encode(value, { ecc: 'M', border: 1 });
  const rects: string[] = [];
  for (let y = 0; y < size; y += 1) {
    const row = data[y] ?? [];
    for (let x = 0; x < size; x += 1) {
      if (row[x] === true)
        rects.push(`<rect x="${String(x)}" y="${String(y)}" width="1" height="1"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(size)} ${String(size)}" width="${String(sizeMm)}mm" height="${String(sizeMm)}mm" shape-rendering="crispEdges"><rect width="${String(size)}" height="${String(size)}" fill="#fff"/><g fill="#000">${rects.join('')}</g></svg>`;
}

function priceRows(label: OrderLabel): string {
  return `<div class="prices">
      <div><span>Subtotal</span><span>${esc(label.subtotal)}</span></div>
      ${label.discount === null ? '' : `<div><span>Discount</span><span>−${esc(label.discount)}</span></div>`}
      <div><span>Shipping</span><span>${label.delivery === null ? 'Free' : esc(label.delivery)}</span></div>
    </div>`;
}

function cnBlock(label: OrderLabel): string {
  return label.consignmentNo === null
    ? '<div class="cn"><div class="cn-none">Not in courier yet</div></div>'
    : `<div class="cn"><div class="k">Consignment No.</div><div class="cn-no">${esc(label.consignmentNo)}</div></div>`;
}

function codBlock(label: OrderLabel): string {
  return `<div class="cod"><span class="k">${label.collect === null ? 'Paid' : 'Collect (COD)'}</span><span class="amount">${esc(label.collect ?? label.total)}</span></div>
    <div class="method">${esc(label.paymentWords)}</div>`;
}

function labelHtml(label: OrderLabel, options: LabelOptions): string {
  const paper = LABEL_PAPER[options.size];
  const qrSize = paper.compact ? (options.layout === 'landscape' ? 18 : 22) : 34;
  const qr = options.showQr
    ? `<div class="qr">${qrSvg(label.scan, qrSize)}<div class="scan">${esc(label.scan)}</div></div>`
    : '';
  const head = `<header>
      <div class="shop">
        ${options.showShopName ? `<div class="shop-name">${esc(label.shopName)}</div>` : ''}
        ${label.merchantId === '' ? '' : `<div class="merchant">${esc(label.merchantId)}</div>`}
      </div>
      <div class="order"><div class="order-no">${esc(label.orderNo)}</div><div class="date">${esc(label.date)}</div></div>
    </header>`;
  const to = `<div class="to">
      <div class="k">Deliver to</div>
      <div class="name">${esc(label.recipientName)}</div>
      <div class="phone">${esc(label.recipientPhone)}</div>
      <div class="address">${esc(label.address)}</div>
    </div>`;
  if (paper.compact && options.layout === 'landscape') {
    return `<section class="label landscape">
      <div class="left">${head}${to}</div>
      <div class="right">${qr}${cnBlock(label)}${options.showPrices ? priceRows(label) : ''}${options.showCod ? codBlock(label) : ''}</div>
    </section>`;
  }
  return `<section class="label">
      ${head}
      ${qr}
      ${cnBlock(label)}
      ${to}
      <div class="foot">${options.showPrices ? priceRows(label) : ''}${options.showCod ? codBlock(label) : ''}</div>
    </section>`;
}

/** The sheet as one HTML document, a label a page. Exported so a test can read it. */
export function orderLabelsHtml(input: {
  readonly labels: readonly OrderLabel[];
  readonly options: LabelOptions;
  readonly fonts: readonly FontFile[];
}): string {
  const paper = LABEL_PAPER[input.options.size];
  const small = paper.compact;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      ${fontFaceCss(input.fonts)}
      @page { size: ${String(paper.w)}mm ${String(paper.h)}mm; margin: 0; }
      * { box-sizing: border-box; }
      body { margin: 0; color: #000; font-family: Arial, 'Hind Siliguri', sans-serif; font-size: ${small ? '7pt' : '10pt'}; line-height: 1.25; }
      .label { width: ${String(paper.w)}mm; height: ${String(paper.h)}mm; padding: ${String(paper.pad)}mm; display: flex; flex-direction: column; gap: ${small ? '0.8mm' : '2mm'}; page-break-after: always; break-after: page; overflow: hidden; }
      .label:last-child { page-break-after: auto; break-after: auto; }
      .landscape { flex-direction: row; }
      .landscape .left { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.8mm; }
      .landscape .right { width: 34mm; border-left: 1px solid #000; padding-left: 2mm; display: flex; flex-direction: column; gap: 0.8mm; }
      header { display: flex; justify-content: space-between; gap: 2mm; border-bottom: ${small ? '1px' : '2px'} solid #000; padding-bottom: 1mm; }
      .shop-name { font-weight: 700; font-size: ${small ? '9pt' : '14pt'}; }
      .merchant { font-weight: 600; }
      .order { text-align: right; }
      .order-no { font-weight: 700; }
      .qr { display: flex; flex-direction: column; align-items: center; }
      .scan { font-family: monospace; font-size: ${small ? '6pt' : '9pt'}; }
      .cn { text-align: center; border-bottom: ${small ? '1px' : '2px'} solid #000; padding-bottom: 1mm; }
      .cn-no { font-weight: 700; font-size: ${small ? '13pt' : '20pt'}; }
      .cn-none { font-weight: 600; }
      .k { text-transform: uppercase; font-size: ${small ? '5.5pt' : '8pt'}; }
      .to .name { font-weight: 700; font-size: ${small ? '10pt' : '14pt'}; }
      .to .phone { font-weight: 600; font-size: ${small ? '9pt' : '12pt'}; }
      .foot { margin-top: auto; }
      .prices div { display: flex; justify-content: space-between; }
      .cod { display: flex; justify-content: space-between; align-items: center; border-top: 2px solid #000; margin-top: 1mm; padding-top: 1mm; }
      .amount { font-weight: 700; font-size: ${small ? '13pt' : '18pt'}; font-variant-numeric: tabular-nums; }
      .method { font-size: ${small ? '5.5pt' : '8pt'}; }
    </style>
  </head>
  <body>${input.labels.map((label) => labelHtml(label, input.options)).join('')}
  </body>
</html>`;
}
