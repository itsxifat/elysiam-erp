import { Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import {
  businessDate,
  code128Svg,
  formatBdPhoneForDisplay,
  poisha,
  type Poisha,
} from '@elysium/domain';

import type { ActiveContext } from '../../platform/http/context.js';
import { fontFaceCss, loadFonts, type FontFile } from '../files/pdf/fonts.js';
import { GotenbergClient } from '../files/pdf/gotenberg.client.js';
import { formatTaka } from '../files/pdf/invoice.template.js';
import { orderScopeSql } from './orders.service.js';
import * as repo from './orders.repository.js';
import { OrdersError } from './orders.errors.js';

/**
 * The invoice and the packing slip (architecture §22, §9; D-036, D-034).
 *
 * Rendered by M04's Gotenberg slice: the same headless Chromium, the same vendored Hind
 * Siliguri, uploaded with the document. Not a PDF library — Bangla is a Brahmic script
 * and `ক্ষ` is one glyph assembled from three codepoints by the font's GSUB table, which
 * a library that draws text box by box does not run. The failure is not a crash; it is an
 * invoice that reads as separate letters to a Bangla reader and looks fine to everybody
 * who signed it off.
 *
 * ## Both documents are Bangla, and the invoice prints the real phone number
 *
 * D-036: the staff console is English and everything customer-facing is Bangla. These go
 * in the parcel, so they are Bangla, including the district and thana names — which come
 * from `ref.districts.name_bn` and `ref.thanas.name_bn` rather than being transliterated
 * here.
 *
 * The buyer's number is printed **in full**, in the form a Bangladeshi reads their own
 * number in (`01712-345678`). Invariant 10 is about logs, fixtures and LLM prompts; a
 * delivery document is the one place the number has to be complete, because the rider
 * calls it from the gate. Masking it here would be a privacy gesture that loses parcels.
 *
 * ## Why they are two documents and not one with a flag
 *
 * The invoice is the commercial record: line prices, the discount, the delivery charge,
 * what was already paid and what the rider collects. The packing slip carries **no line
 * prices at all** — a picker needs items and quantities, and a priced slip taped to a box
 * is an argument at the door about a discount the buyer did not expect. It does carry the
 * collectable amount, large, because that is the one number the rider must not get wrong.
 *
 * Both render functions are exported so a test can assert their contents without a
 * running Gotenberg: the bytes are Chromium's business, the contents of the page are ours.
 */

export type OrderDocumentKind = 'invoice' | 'packing_slip' | 'label';

interface DocumentBrand {
  readonly displayName: string;
  readonly legalName: string;
  readonly address: string | null;
  readonly vatNo: string | null;
  readonly invoiceFooter: string | null;
  readonly accentHue: number;
}

interface DocumentLine {
  readonly name: string;
  readonly sku: string;
  readonly qty: number;
  readonly unitPricePoisha: Poisha;
  readonly lineDiscountPoisha: Poisha;
}

export interface OrderDocumentData {
  readonly orderNo: string;
  /** An Asia/Dhaka calendar date (invariant 8). */
  readonly issuedOn: string;
  readonly customerName: string;
  /** Display form, in full: the rider calls it. */
  readonly customerPhone: string;
  readonly addressLine: string;
  readonly areaBn: string;
  /** The same area in English, for the parcel label a courier's rider reads. */
  readonly areaEn: string;
  readonly lines: readonly DocumentLine[];
  readonly itemsPoisha: Poisha;
  readonly discountPoisha: Poisha;
  readonly deliveryChargePoisha: Poisha;
  readonly advancePaidPoisha: Poisha;
  readonly codAmountPoisha: Poisha;
  readonly notes: string | null;
}

/**
 * HTML-escape, without exception.
 *
 * A buyer's name and a desk agent's note are attacker-controlled text and this page is
 * rendered by a real browser. The dev container runs Chromium with JavaScript disabled,
 * which makes a `<script>` in a name harmless *there* — and correctness that depends on a
 * flag in a compose file is correctness that breaks when somebody tunes the compose file.
 */
function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The tokens §24 collapses to on paper: ink, hairline, and the org's one accent. */
function documentCss(fonts: readonly FontFile[], accentHue: number): string {
  return `${fontFaceCss(fonts)}
      :root {
        --ink: oklch(0.22 0.01 260);
        --muted: oklch(0.52 0.01 260);
        --hairline: oklch(0.9 0.005 260);
        --accent: oklch(0.55 0.12 ${String(accentHue)});
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: 'Hind Siliguri', 'Noto Sans Bengali', sans-serif;
        font-size: 11pt;
        line-height: 1.6;
        color: var(--ink);
      }
      header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 24px;
        padding-bottom: 14px;
        border-bottom: 2px solid var(--accent);
      }
      .brand-name { font-size: 17pt; font-weight: 600; line-height: 1.3; }
      .brand-legal { color: var(--muted); font-size: 9.5pt; }
      .doc-title { font-size: 15pt; font-weight: 600; text-align: right; }
      .doc-meta { color: var(--muted); font-size: 9.5pt; text-align: right; }
      .parties { display: flex; gap: 32px; margin: 18px 0 20px; }
      .party { flex: 1; }
      .party h2 {
        margin: 0 0 4px;
        font-size: 9.5pt;
        font-weight: 600;
        color: var(--muted);
        letter-spacing: 0.04em;
      }
      table { width: 100%; border-collapse: collapse; }
      thead th {
        background: oklch(0.97 0.004 260);
        font-size: 9.5pt;
        font-weight: 600;
        text-align: left;
        padding: 7px 8px;
        border-bottom: 1px solid var(--hairline);
      }
      tbody td { padding: 8px; border-bottom: 1px solid var(--hairline); vertical-align: top; }
      .item { font-weight: 500; }
      .sku { color: var(--muted); font-size: 9pt; }
      .num { text-align: center; width: 9%; }
      /* Tabular figures, so a column of money aligns digit for digit (§24). */
      .money { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      thead th.num { text-align: center; }
      thead th.money { text-align: right; }
      .totals { margin-top: 14px; margin-left: auto; width: 54%; }
      .totals tr td { border: none; padding: 3px 8px; }
      .totals .label { color: var(--muted); }
      .totals .grand td {
        border-top: 1px solid var(--hairline);
        padding-top: 8px;
        font-weight: 600;
        font-size: 12pt;
      }
      .totals .due td { color: var(--accent); font-weight: 600; font-size: 13pt; }
      .collect {
        margin-top: 18px;
        padding: 12px 16px;
        border: 1px solid var(--accent);
        display: flex;
        justify-content: space-between;
        align-items: baseline;
      }
      .collect .amount {
        font-size: 20pt;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        color: var(--accent);
      }
      footer {
        margin-top: 28px;
        padding-top: 10px;
        border-top: 1px solid var(--hairline);
        color: var(--muted);
        font-size: 9.5pt;
      }
      .thanks { color: var(--ink); font-weight: 500; margin-bottom: 4px; }`;
}

function brandHeader(brand: DocumentBrand, title: string, data: OrderDocumentData): string {
  return `<header>
      <div>
        <div class="brand-name">${escape(brand.displayName)}</div>
        <div class="brand-legal">${escape(brand.legalName)}</div>
        ${brand.address === null ? '' : `<div class="brand-legal">${escape(brand.address)}</div>`}
        ${
          brand.vatNo === null
            ? ''
            : `<div class="brand-legal">ভ্যাট নিবন্ধন নম্বর: ${escape(brand.vatNo)}</div>`
        }
      </div>
      <div>
        <div class="doc-title">${title}</div>
        <div class="doc-meta">অর্ডার নম্বর: ${escape(data.orderNo)}</div>
        <div class="doc-meta">তারিখ: ${escape(data.issuedOn)}</div>
      </div>
    </header>`;
}

function buyerBlock(data: OrderDocumentData): string {
  return `<section class="parties">
      <div class="party">
        <h2>ক্রেতার বিবরণ</h2>
        <div>${escape(data.customerName)}</div>
        <div>${escape(data.customerPhone)}</div>
      </div>
      <div class="party">
        <h2>ডেলিভারি ঠিকানা</h2>
        <div>${escape(data.addressLine)}</div>
        <div>${escape(data.areaBn)}</div>
      </div>
    </section>`;
}

/** The commercial document: prices, discount, advance and what the rider collects. */
export function renderOrderInvoiceHtml(input: {
  readonly brand: DocumentBrand;
  readonly data: OrderDocumentData;
  readonly fonts: readonly FontFile[];
}): string {
  const { brand, data, fonts } = input;
  const rows = data.lines
    .map((line, index) => {
      const gross = poisha(BigInt(line.unitPricePoisha) * BigInt(line.qty));
      const net = poisha(BigInt(gross) - BigInt(line.lineDiscountPoisha));
      return `
      <tr>
        <td class="num">${String(index + 1)}</td>
        <td>
          <div class="item">${escape(line.name)}</div>
          <div class="sku">${escape(line.sku)}</div>
        </td>
        <td class="num">${String(line.qty)}</td>
        <td class="money">${formatTaka(line.unitPricePoisha)}</td>
        <td class="money">${formatTaka(net)}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="bn">
  <head>
    <meta charset="utf-8" />
    <title>${escape(data.orderNo)}</title>
    <style>
${documentCss(fonts, brand.accentHue)}
    </style>
  </head>
  <body>
    ${brandHeader(brand, 'বিক্রয় চালান', data)}
    ${buyerBlock(data)}

    <table>
      <thead>
        <tr>
          <th class="num">ক্রম</th>
          <th>পণ্যের বিবরণ</th>
          <th class="num">পরিমাণ</th>
          <th class="money">একক মূল্য</th>
          <th class="money">মোট</th>
        </tr>
      </thead>
      <tbody>${rows}
      </tbody>
    </table>

    <table class="totals">
      <tbody>
        <tr>
          <td class="label">উপমোট</td>
          <td class="money">${formatTaka(data.itemsPoisha)}</td>
        </tr>
        <tr>
          <td class="label">ছাড়</td>
          <td class="money">${formatTaka(data.discountPoisha)}</td>
        </tr>
        <tr>
          <td class="label">ডেলিভারি চার্জ</td>
          <td class="money">${formatTaka(data.deliveryChargePoisha)}</td>
        </tr>
        <tr class="grand">
          <td>সর্বমোট</td>
          <td class="money">${formatTaka(
            poisha(
              BigInt(data.itemsPoisha) -
                BigInt(data.discountPoisha) +
                BigInt(data.deliveryChargePoisha),
            ),
          )}</td>
        </tr>
        <tr>
          <td class="label">অগ্রিম পরিশোধিত</td>
          <td class="money">${formatTaka(data.advancePaidPoisha)}</td>
        </tr>
        <tr class="due">
          <td>ডেলিভারিতে সংগ্রহযোগ্য</td>
          <td class="money">${formatTaka(data.codAmountPoisha)}</td>
        </tr>
      </tbody>
    </table>

    <footer>
      <div class="thanks">আমাদের সঙ্গে থাকার জন্য আন্তরিক ধন্যবাদ।</div>
      <div>${escape(
        brand.invoiceFooter ?? 'পণ্য বদলাতে চাইলে ডেলিভারির ৭ দিনের মধ্যে যোগাযোগ করুন।',
      )}</div>
      <div>এই চালানটি কম্পিউটারে তৈরি, তাই কোনো স্বাক্ষরের প্রয়োজন নেই।</div>
    </footer>
  </body>
</html>`;
}

/**
 * The picking and handover document.
 *
 * No unit prices and no line totals — only what to put in the box and how much to
 * collect. A slip that showed both would put the brand's pricing on the outside of every
 * parcel, and the picker who reads it has no use for either number.
 */
export function renderPackingSlipHtml(input: {
  readonly brand: DocumentBrand;
  readonly data: OrderDocumentData;
  readonly fonts: readonly FontFile[];
}): string {
  const { brand, data, fonts } = input;
  const rows = data.lines
    .map(
      (line, index) => `
      <tr>
        <td class="num">${String(index + 1)}</td>
        <td>
          <div class="item">${escape(line.name)}</div>
          <div class="sku">${escape(line.sku)}</div>
        </td>
        <td class="num">${String(line.qty)}</td>
        <td class="num">☐</td>
      </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="bn">
  <head>
    <meta charset="utf-8" />
    <title>${escape(data.orderNo)}</title>
    <style>
${documentCss(fonts, brand.accentHue)}
    </style>
  </head>
  <body>
    ${brandHeader(brand, 'প্যাকিং স্লিপ', data)}
    ${buyerBlock(data)}

    <table>
      <thead>
        <tr>
          <th class="num">ক্রম</th>
          <th>পণ্যের বিবরণ</th>
          <th class="num">পরিমাণ</th>
          <th class="num">মিলিয়ে দেখা</th>
        </tr>
      </thead>
      <tbody>${rows}
      </tbody>
    </table>

    <div class="collect">
      <div>ডেলিভারিতে সংগ্রহযোগ্য (ক্যাশ অন ডেলিভারি)</div>
      <div class="amount">${formatTaka(data.codAmountPoisha)}</div>
    </div>

    ${data.notes === null ? '' : `<footer><div>বিশেষ নির্দেশনা: ${escape(data.notes)}</div></footer>`}
  </body>
</html>`;
}

/**
 * The parcel's address label (M11 "bulk print of invoices and labels"; §22).
 *
 * 4 × 6 inches, the thermal-label size every Bangladeshi courier's pickup desk prints, and
 * one order per label. What is on it is what a rider needs at a door and nothing else: who,
 * where, how much to collect, and the order number as a Code 128 barcode so the warehouse
 * can scan it at handover instead of typing it.
 *
 * Bangla and English side by side for the area, and deliberately: the label is read by the
 * buyer (D-036 makes customer-facing output Bangla) *and* by a courier hub whose sorting is
 * done in English district names. No price per item, no item list — a label is stuck on the
 * outside of the box, and the contents of a parcel written on its outside is an invitation.
 * The order's notes are left off for the same reason: they are the desk's remarks and a
 * stranger's form text, and they belong on the packing slip inside, not on the box.
 */
export function renderLabelHtml(input: {
  readonly brand: DocumentBrand;
  readonly data: OrderDocumentData;
  readonly fonts: readonly FontFile[];
}): string {
  const { brand, data, fonts } = input;
  const units = data.lines.reduce((total, line) => total + line.qty, 0);
  return `<!doctype html>
<html lang="bn">
  <head>
    <meta charset="utf-8" />
    <title>${escape(data.orderNo)}</title>
    <style>
${labelCss(fonts, brand.accentHue)}
    </style>
  </head>
  <body>
    <div class="label">
      <div class="from">${escape(brand.displayName)}</div>
      <div class="barcode">${code128Svg(data.orderNo, 36)}</div>
      <div class="order-no">${escape(data.orderNo)}</div>
      <div class="to">
        <div class="caption">প্রাপক · To</div>
        <div class="name">${escape(data.customerName)}</div>
        <div class="phone">${escape(data.customerPhone)}</div>
        <div class="address">${escape(data.addressLine)}</div>
        <div class="area">${escape(data.areaBn)}</div>
        <div class="area-en">${escape(data.areaEn)}</div>
      </div>
      <div class="cod">
        <div>সংগ্রহযোগ্য · COD</div>
        <div class="amount">${formatTaka(data.codAmountPoisha)}</div>
      </div>
      <div class="meta">${String(units)} পিস · ${escape(data.issuedOn)}</div>
    </div>
  </body>
</html>`;
}

function labelCss(fonts: readonly FontFile[], accentHue: number): string {
  return `${fontFaceCss(fonts)}
      :root { --ink: oklch(0.2 0.01 260); --muted: oklch(0.5 0.01 260); --accent: oklch(0.5 0.12 ${String(accentHue)}); }
      body { margin: 0; font-family: 'Hind Siliguri', 'Noto Sans Bengali', sans-serif; color: var(--ink); }
      .label { font-size: 11pt; line-height: 1.35; }
      .from { font-size: 10pt; font-weight: 600; color: var(--muted); }
      .barcode { height: 0.62in; margin-top: 6px; color: #000; }
      .barcode svg { width: 100%; height: 100%; }
      .order-no { text-align: center; font-size: 12pt; font-weight: 600; letter-spacing: 0.06em; font-variant-numeric: tabular-nums; }
      .to { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--ink); }
      .caption { font-size: 8.5pt; color: var(--muted); }
      .name { font-size: 15pt; font-weight: 600; }
      .phone { font-size: 13pt; font-weight: 600; font-variant-numeric: tabular-nums; }
      .address { margin-top: 4px; }
      .area-en { color: var(--muted); font-size: 10pt; }
      .cod { margin-top: 10px; padding: 8px 10px; border: 2px solid var(--ink); display: flex; justify-content: space-between; align-items: baseline; }
      .cod .amount { font-size: 18pt; font-weight: 700; font-variant-numeric: tabular-nums; }
      .meta { margin-top: 6px; font-size: 9pt; color: var(--muted); }`;
}

/** The inside of a document's `<body>`, for putting several documents in one file. */
function bodyOf(html: string): string {
  const start = html.indexOf('<body>');
  const end = html.lastIndexOf('</body>');
  if (start < 0 || end < start) throw new Error('an order document rendered without a body');
  return html.slice(start + '<body>'.length, end);
}

/** The `<style>` block of a document, so a batch carries the same CSS as a single page. */
function styleOf(html: string): string {
  const start = html.indexOf('<style>');
  const end = html.indexOf('</style>');
  if (start < 0 || end < start) throw new Error('an order document rendered without styles');
  return html.slice(start + '<style>'.length, end);
}

function renderOne(
  kind: OrderDocumentKind,
  brand: DocumentBrand,
  data: OrderDocumentData,
  fonts: readonly FontFile[],
): string {
  if (kind === 'invoice') return renderOrderInvoiceHtml({ brand, data, fonts });
  if (kind === 'packing_slip') return renderPackingSlipHtml({ brand, data, fonts });
  return renderLabelHtml({ brand, data, fonts });
}

/**
 * Several orders' documents as one HTML file, a page each (M11 bulk print).
 *
 * One file and one Gotenberg call rather than one per order and a PDF merge afterwards:
 * a warehouse printing forty labels at the end of a shift wants one print dialog, and
 * forty sequential renders is forty times the headless-Chromium start-up. Each order's
 * page is exactly the page the single-order endpoint renders — the body is lifted from the
 * same template — so a batch cannot drift from a reprint of one order.
 */
export function renderBatchHtml(input: {
  readonly kind: OrderDocumentKind;
  readonly brand: DocumentBrand;
  readonly documents: readonly OrderDocumentData[];
  readonly fonts: readonly FontFile[];
}): string {
  const { kind, brand, documents, fonts } = input;
  const first = documents[0];
  if (first === undefined) throw new Error('a batch needs at least one order');
  const css = styleOf(renderOne(kind, brand, first, fonts));
  const pages = documents
    .map(
      (data) => `<section class="sheet">${bodyOf(renderOne(kind, brand, data, fonts))}</section>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="bn">
  <head>
    <meta charset="utf-8" />
    <title>${escape(`${String(documents.length)} × ${kind}`)}</title>
    <style>
${css}
      .sheet { break-after: page; }
      .sheet:last-child { break-after: auto; }
    </style>
  </head>
  <body>
${pages}
  </body>
</html>`;
}

function suffixOf(kind: OrderDocumentKind): string {
  return kind === 'packing_slip' ? 'packing-slip' : kind;
}

/** Paper for each kind: A4 for the documents that go in the box, 4 × 6 in for the label. */
function paperFor(kind: OrderDocumentKind): {
  paperWidth: number;
  paperHeight: number;
  marginInches: number;
} {
  return kind === 'label'
    ? { paperWidth: 4, paperHeight: 6, marginInches: 0.15 }
    : { paperWidth: 8.27, paperHeight: 11.7, marginInches: 0.4 };
}

@Injectable()
export class DocumentsService {
  constructor(private readonly gotenberg: GotenbergClient) {}

  /** The bytes, for the controller to send. */
  async render(
    context: ActiveContext,
    request: object,
    orderId: string,
    kind: OrderDocumentKind,
  ): Promise<{ bytes: Uint8Array; filename: string }> {
    const { brand, data } = await this.gather(context, request, orderId);
    const fonts = await loadFonts();
    const html = renderOne(kind, brand, data, fonts);

    const bytes = await this.gotenberg.renderPdf({
      html,
      assets: fonts.map((font) => ({
        filename: font.filename,
        bytes: font.bytes,
        contentType: 'font/woff2',
      })),
      ...paperFor(kind),
    });
    return { bytes, filename: `${data.orderNo}-${suffixOf(kind)}.pdf` };
  }

  /**
   * Many orders' documents in one PDF (M11 bulk print).
   *
   * Every id goes through `gather`, which applies the caller's §6 scope to each one, and a
   * single id outside it refuses the whole batch as not found. Printing the rest silently
   * would hand back a PDF one page short with nothing to say which order is missing — and
   * a warehouse that trusts the page count ships one parcel without its invoice.
   *
   * Gathered one after another rather than in parallel: each is its own short transaction,
   * and a hundred concurrent ones would take a hundred pool connections away from the desk
   * for the length of a print.
   */
  async renderMany(
    context: ActiveContext,
    request: object,
    orderIds: readonly string[],
    kind: OrderDocumentKind,
  ): Promise<{ bytes: Uint8Array; filename: string }> {
    let brand: DocumentBrand | undefined;
    const documents: OrderDocumentData[] = [];
    for (const orderId of orderIds) {
      const gathered = await this.gather(context, request, orderId);
      brand ??= gathered.brand;
      documents.push(gathered.data);
    }
    if (brand === undefined) throw new OrdersError('ORDER_NOT_FOUND', 'No orders to print.');

    const fonts = await loadFonts();
    const bytes = await this.gotenberg.renderPdf({
      html: renderBatchHtml({ kind, brand, documents, fonts }),
      assets: fonts.map((font) => ({
        filename: font.filename,
        bytes: font.bytes,
        contentType: 'font/woff2',
      })),
      ...paperFor(kind),
      // A hundred pages is well past the single-document default of thirty seconds.
      timeoutMs: 120_000,
    });
    return {
      bytes,
      filename: `orders-${businessDate(new Date())}-${String(documents.length)}-${suffixOf(kind)}.pdf`,
    };
  }

  /**
   * Everything the page needs, in one transaction and inside the caller's scope.
   *
   * The scope matters here more than on most reads: a document is the whole order, in a
   * form that can be saved and forwarded, so a sales agent must not be able to pull the
   * invoice of an order that is not theirs by guessing an id. The same
   * `orderScopeSql` the JSON endpoints use, so the two cannot disagree about who may see
   * what.
   */
  async gather(
    context: ActiveContext,
    request: object,
    orderId: string,
  ): Promise<{ brand: DocumentBrand; data: OrderDocumentData }> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const order = await repo.orderByIdInScope(
        tx,
        context.orgId,
        orderId,
        orderScopeSql(context, request),
      );
      if (order === undefined) throw new OrdersError('ORDER_NOT_FOUND', 'No such order.');

      const [lines, orgBrand, area] = await Promise.all([
        repo.orderLines(tx, context.orgId, order.id),
        repo.orgBrand(tx, context.orgId),
        repo.areaNames(tx, order.ship_district_id, order.ship_thana_id),
      ]);

      const block = (orgBrand?.brand ?? {}) as {
        address?: unknown;
        vatNo?: unknown;
        invoiceFooter?: unknown;
        accent?: { hue?: unknown };
      };

      return {
        brand: {
          displayName: orgBrand?.display_name ?? '',
          legalName: orgBrand?.legal_name ?? '',
          address: typeof block.address === 'string' ? block.address : null,
          vatNo: typeof block.vatNo === 'string' ? block.vatNo : null,
          invoiceFooter: typeof block.invoiceFooter === 'string' ? block.invoiceFooter : null,
          // D-034's per-org accent, with a neutral ink as the fallback so a brand that
          // has not chosen one still prints a coherent document.
          accentHue: typeof block.accent?.hue === 'number' ? block.accent.hue : 250,
        },
        data: {
          orderNo: order.order_no,
          // The order's Asia/Dhaka business date, not `created_at` formatted in UTC: an
          // order taken at 00:30 in Dhaka is that day's order, and the date on the
          // invoice has to be the date in the books (invariant 8).
          issuedOn: businessDate(new Date(order.created_at)),
          customerName: order.ship_name,
          customerPhone: formatBdPhoneForDisplay(order.ship_phone_e164),
          addressLine: order.ship_address_line,
          areaBn: [order.ship_area, area?.thana_bn, area?.district_bn]
            .filter((part): part is string => part != null && part !== '')
            .join(', '),
          areaEn: [order.ship_area, area?.thana_en, area?.district_en]
            .filter((part): part is string => part != null && part !== '')
            .join(', '),
          lines: lines.map((line) => ({
            name: line.product_name,
            sku: line.sku_code,
            qty: line.qty,
            unitPricePoisha: poisha(BigInt(line.unit_price_poisha)),
            lineDiscountPoisha: poisha(BigInt(line.discount_poisha)),
          })),
          itemsPoisha: poisha(BigInt(order.items_poisha)),
          discountPoisha: poisha(BigInt(order.discount_poisha)),
          deliveryChargePoisha: poisha(BigInt(order.delivery_charge_poisha)),
          advancePaidPoisha: poisha(BigInt(order.advance_paid_poisha)),
          codAmountPoisha: poisha(BigInt(order.cod_amount_poisha)),
          notes: order.notes,
        },
      };
    });
  }
}
