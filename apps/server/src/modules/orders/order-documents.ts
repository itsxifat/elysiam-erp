import {
  add,
  code128Encode,
  code128Svg,
  CODE128_QUIET_MODULES,
  mulQty,
  poisha,
  sub,
  takaText,
  type Poisha,
} from '@elysium/domain';
import { lotCode } from '@elysium/domain/packing';

import { DOCUMENT_FONT_STACK, fontFaceCss, type FontFile } from '../files/pdf/fonts.js';

/**
 * The order's documents: the invoice, the packing slip and the parcel label (architecture
 * §22, §9; M43, D-750 to D-754).
 *
 * The owner, 2026-10-11: "important details clear and bold and little big, like how standard
 * company do … formal english language and clean premium design". So each page leads with
 * what the person holding it acts on, in the order they act on it:
 *
 * 1. **The order number, large, with its barcode.** The barcode is Code 128 of the order
 *    number exactly as the order carries it, which is the first thing the packing station and
 *    the scanner look a code up by (`OrdersApi.orderIdsForShipmentCode`); a test decodes the
 *    printed bars and opens the order at the real station with them.
 * 2. **The cash to collect**, in a heavy black box: the one number the rider must not get
 *    wrong.
 * 3. **The recipient** — name, phone and the full address — large and bold, because a rider
 *    reads it at a gate and calls the number from it.
 * 4. **The courier**, with the consignment and tracking numbers once the parcel is booked.
 * 5. **The items** in a clean table, and on the invoice the money: subtotal, discount,
 *    delivery, total, paid and to collect.
 *
 * ## Paper, ink and type
 *
 * Inter alone (D-753), tabular figures on every number, 1 px rules, generous white space.
 * Black ink only — no tints a thermal head would dither into ash, no brand colour that a
 * laser printer turns grey; the brand shows in its name and its logo (D-752). The invoice is
 * A4, the packing slip A4 or A5, the label 4 × 6 in, each at its exact size (`PAPER`).
 *
 * ## English, and the phone in full
 *
 * Every word the system writes here is English (D-750) and every amount is `Tk 1,250.00`
 * through `takaText` (D-751); district and thana are their English names. The buyer's number
 * is printed in full, in the form a Bangladeshi reads it (`01712-345678`): invariant 10 is
 * about logs, fixtures and prompts, and a delivery document is the one place the number has
 * to be complete, because the rider calls it.
 *
 * ## What the slip and the label leave off
 *
 * The packing slip carries no prices: a picker needs items and quantities, and a priced slip
 * taped to a box is an argument at the door about a discount the buyer did not expect. It does
 * carry the cash to collect. The label carries no item list and no notes: it is stuck on the
 * outside of the box, and a parcel's contents written on its outside is an invitation.
 *
 * Everything here is pure, so a test reads the page without a running Gotenberg; the bytes
 * are Chromium's business, the contents of the page are ours.
 */

export type OrderDocumentKind = 'invoice' | 'packing_slip' | 'label';
export type DocumentPaper = 'a4' | 'a5';

/** Exact paper sizes in millimetres, and the margin Gotenberg prints inside them. */
export const PAPER = {
  a4: { widthMm: 210, heightMm: 297, marginMm: 12 },
  a5: { widthMm: 148, heightMm: 210, marginMm: 8 },
  /** 4 × 6 inches. The label draws its own margin, so the page's is zero. */
  label: { widthMm: 101.6, heightMm: 152.4, marginMm: 0 },
} as const;

export interface DocumentBrand {
  readonly displayName: string;
  readonly legalName: string;
  readonly address: string | null;
  readonly vatNo: string | null;
  readonly invoiceFooter: string | null;
  /** The logo's file name beside `index.html` (uploaded with the page), or null. */
  readonly logo: string | null;
}

export interface DocumentLine {
  readonly name: string;
  readonly sku: string;
  readonly size: string | null;
  readonly colour: string | null;
  /** Any other variant values (`Long sleeve`). */
  readonly other: string | null;
  readonly qty: number;
  readonly unitPricePoisha: Poisha;
  readonly lineDiscountPoisha: Poisha;
}

export interface DocumentCourier {
  readonly name: string;
  /** Null until the courier has booked the parcel. */
  readonly consignmentNo: string | null;
  readonly trackingCode: string | null;
}

export interface OrderDocumentData {
  readonly orderNo: string;
  /** The order's Asia/Dhaka business date, `YYYY-MM-DD` (invariant 8). */
  readonly issuedOn: string;
  /** The order channel (`facebook`, `website`, …). */
  readonly channel: string;
  readonly customerName: string;
  /** Display form, in full: the rider calls it. */
  readonly customerPhone: string;
  readonly addressLine: string;
  /** The area and thana, in English: `Banani, Gulshan`. */
  readonly locality: string;
  /** The district, in English. */
  readonly district: string;
  readonly lines: readonly DocumentLine[];
  readonly itemsPoisha: Poisha;
  readonly discountPoisha: Poisha;
  readonly deliveryChargePoisha: Poisha;
  readonly advancePaidPoisha: Poisha;
  readonly codAmountPoisha: Poisha;
  readonly notes: string | null;
  /** The courier the parcel goes with, booked or planned; null when none is chosen. */
  readonly courier: DocumentCourier | null;
  /**
   * M46 (D-806): which bag this page is for, when the order goes in several. Absent or a count of
   * one prints the page as before; otherwise "Lot 2 of 3" in bold and the lot's own barcode.
   */
  readonly lot?: { readonly no: number; readonly count: number } | null;
}

/** The order's lot when it has several, else null. */
function lotOf(data: OrderDocumentData): { readonly no: number; readonly count: number } | null {
  return data.lot === undefined || data.lot === null || data.lot.count <= 1 ? null : data.lot;
}

/**
 * What the page's barcode carries (D-806): the order number, or for one lot of several its lot
 * code (`ELY-2610-00042-L2`), which the packing station and the handover read back.
 */
export function documentBarcodeValue(data: OrderDocumentData): string {
  const lot = lotOf(data);
  return lot === null ? data.orderNo : lotCode(data.orderNo, lot.no);
}

/** "Lot 2 of 3", bold and boxed, or nothing for an order in one bag. */
function lotBadge(data: OrderDocumentData): string {
  const lot = lotOf(data);
  if (lot === null) return '';
  return `<div class="lot" data-field="lot">Lot ${String(lot.no)} of ${String(lot.count)}</div>`;
}

/**
 * HTML-escape, without exception.
 *
 * A buyer's name and a desk agent's note are attacker-controlled text and this page is
 * rendered by a real browser. The dev container runs Chromium with JavaScript disabled,
 * which makes a `<script>` in a name harmless *there* — and correctness that depends on a
 * flag in a compose file is correctness that breaks when somebody tunes the compose file.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-10-11` → `11 Oct 2026`, the date as a document prints it. Never through a `Date`. */
export function documentDate(isoDate: string): string {
  const [year = '', month = '', day = ''] = isoDate.split('-');
  return `${String(Number(day))} ${MONTHS[Number(month) - 1] ?? month} ${year}`;
}

const CHANNEL_WORDS: Readonly<Record<string, string>> = {
  facebook: 'Facebook',
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  landing_page: 'Landing page',
  website: 'Website',
  phone: 'Phone',
  walk_in: 'Walk-in',
  reseller: 'Reseller',
  marketplace: 'Marketplace',
};

/** The channel in words; an unknown one prints as its own words rather than nothing. */
export function channelWords(channel: string): string {
  return CHANNEL_WORDS[channel] ?? channel.replace(/_/g, ' ');
}

/** How the buyer pays, in the words a rider and a buyer both read. */
export function paymentWords(data: OrderDocumentData): string {
  if (data.codAmountPoisha <= 0n) return 'Paid in full';
  if (data.advancePaidPoisha > 0n) return 'Part paid, balance on delivery';
  return 'Cash on delivery';
}

/** Subtotal − discount + delivery: what the order costs, before anything paid. */
export function orderTotal(data: OrderDocumentData): Poisha {
  return add(sub(data.itemsPoisha, data.discountPoisha), data.deliveryChargePoisha);
}

function units(data: OrderDocumentData): number {
  return data.lines.reduce((total, line) => total + line.qty, 0);
}

/**
 * The order number as a Code 128 barcode, sized in whole modules.
 *
 * `moduleMm` is the narrowest bar: 0.3 mm on a laser page, 0.375 mm (three dots of a 203 dpi
 * head) on a thermal label, so every bar lands on whole dots. The symbol's own width decides
 * the image's, which is the only way to keep the module exact.
 */
export function orderBarcode(value: string, moduleMm: number, heightMm: number): string {
  const modules = code128Encode(value).width + CODE128_QUIET_MODULES * 2;
  const width = Math.round(modules * moduleMm * 100) / 100;
  return code128Svg(value, 40).replace(
    '<svg ',
    `<svg width="${String(width)}mm" height="${String(heightMm)}mm" data-barcode="${escapeHtml(value)}" `,
  );
}

/** The ink, the hairlines and the type scale every page shares (§24 collapsed onto paper). */
function baseCss(fonts: readonly FontFile[]): string {
  return `${fontFaceCss(fonts)}
      :root {
        --ink: #000;
        --ink-soft: #2b2b2b;
        --ink-muted: #555;
        --hairline: #bdbdbd;
      }
      * { box-sizing: border-box; }
      html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      body {
        margin: 0;
        font-family: ${DOCUMENT_FONT_STACK};
        color: var(--ink);
        font-size: var(--s-body);
        line-height: 1.45;
      }
      .caption {
        font-size: var(--s-caption);
        font-weight: 600;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--ink-muted);
      }
      /* Tabular figures on amounts and counts only: Inter's tnum also spaces out the hyphens of
         an order number, a phone number or a SKU. */
      .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
      .r { text-align: right; }`;
}

/** The type scale for a page: A4 reads at arm's length on a desk, A5 in a hand. */
function scaleCss(paper: DocumentPaper): string {
  return paper === 'a4'
    ? `:root {
        --s-body: 9.5pt; --s-caption: 7pt; --s-small: 8pt;
        --s-brand: 15pt; --s-order: 24pt; --s-collect: 25pt;
        --s-name: 15pt; --s-phone: 15pt; --s-address: 11.5pt;
        --gap: 7mm;
      }`
    : `:root {
        --s-body: 8pt; --s-caption: 6pt; --s-small: 7pt;
        --s-brand: 11.5pt; --s-order: 17pt; --s-collect: 19pt;
        --s-name: 12.5pt; --s-phone: 12.5pt; --s-address: 9.5pt;
        --gap: 4.5mm;
      }
      /* A5 is too narrow for six facts in a row: three a row, so a courier's long tracking
         code stays on one line. */
      .strip { grid-auto-flow: row; grid-template-columns: repeat(3, 1fr); }
      .strip > div:nth-child(3n + 1) { border-left: none; padding-left: 0; }
      .strip > div:nth-child(n + 4) { border-top: 1px solid var(--hairline); }`;
}

/** The masthead, the cash box, the recipient, the facts, the items table and the footer. */
function pageCss(): string {
  return `
      .masthead {
        display: flex; justify-content: space-between; align-items: flex-start; gap: var(--gap);
        padding-bottom: calc(var(--gap) * 0.6); border-bottom: 2pt solid var(--ink);
      }
      .brand { display: flex; align-items: center; gap: 3.5mm; min-width: 0; }
      .logo { max-height: 15mm; max-width: 38mm; object-fit: contain; filter: grayscale(100%); }
      .brand-name { font-size: var(--s-brand); font-weight: 700; letter-spacing: -0.01em; line-height: 1.15; }
      .brand-meta { margin-top: 1.2mm; font-size: var(--s-small); color: var(--ink-muted); line-height: 1.4; }
      .doc-id { text-align: right; flex: none; }
      .doc-title { font-size: var(--s-caption); font-weight: 700; letter-spacing: 0.22em; text-transform: uppercase; }
      .order-no {
        margin-top: 0.6mm; font-size: var(--s-order); font-weight: 700; line-height: 1.05;
        letter-spacing: -0.01em; white-space: nowrap;
      }
      .barcode { margin-top: 1.6mm; line-height: 0; color: #000; }
      /* M46 (D-806): one bag of several, boxed and bold beside the order number. */
      .lot {
        display: inline-block; margin-top: 1.2mm; border: 2pt solid var(--ink); padding: 0.6mm 2.4mm;
        font-size: calc(var(--s-order) * 0.55); font-weight: 800; letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .barcode svg { display: inline-block; }
      /* D-905: the slip's barcode on a strip of its own, quiet zones clear. */
      .scan-strip {
        margin-top: calc(var(--gap) * 0.8); text-align: center; line-height: 0; color: #000;
      }
      .scan-strip svg { display: inline-block; }

      .hero { display: grid; gap: var(--gap); margin-top: var(--gap); align-items: start; }
      .party .caption { margin-bottom: 1.2mm; }
      .name { font-size: var(--s-name); font-weight: 700; line-height: 1.2; }
      .phone { margin-top: 0.8mm; font-size: var(--s-phone); font-weight: 700; letter-spacing: 0.01em; }
      .address { margin-top: 1.6mm; font-size: var(--s-address); font-weight: 600; line-height: 1.35; }
      .district { font-size: var(--s-address); font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }

      .collect { border: 2pt solid var(--ink); display: flex; flex-direction: column; }
      .collect-label {
        background: #000; color: #fff; padding: 1.4mm 3mm;
        font-size: var(--s-caption); font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase;
      }
      .collect-amount {
        padding: 2.4mm 3mm 0.6mm; font-size: var(--s-collect); font-weight: 700; line-height: 1.1;
        font-variant-numeric: tabular-nums; white-space: nowrap;
      }
      .collect-note { padding: 0 3mm 2.4mm; font-size: var(--s-small); color: var(--ink-soft); }

      .facts { display: grid; grid-template-columns: auto 1fr; column-gap: 4mm; row-gap: 1.1mm; margin: 0; align-content: start; }
      .facts dt { font-size: var(--s-caption); font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-muted); padding-top: 0.35mm; }
      .facts dd { margin: 0; font-weight: 600; }
      .facts dd.mono { letter-spacing: 0.02em; }

      .strip {
        display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; margin-top: var(--gap);
        border-top: 1pt solid var(--ink); border-bottom: 1pt solid var(--ink);
      }
      .strip > div { padding: 1.8mm 2.4mm; border-left: 1px solid var(--hairline); min-width: 0; }
      .strip > div:first-child { border-left: none; padding-left: 0; }
      .strip .value { margin-top: 0.5mm; font-weight: 700; overflow-wrap: anywhere; }

      table.items { width: 100%; border-collapse: collapse; margin-top: var(--gap); }
      .items th {
        font-size: var(--s-caption); font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase;
        text-align: left; padding: 0 2mm 1.6mm; border-bottom: 1.5pt solid var(--ink); white-space: nowrap;
      }
      .items td { padding: 2mm; border-bottom: 1px solid var(--hairline); vertical-align: top; }
      .items tr:last-child td { border-bottom: 1pt solid var(--ink); }
      .items th:first-child, .items td:first-child { padding-left: 0; }
      .items th:last-child, .items td:last-child { padding-right: 0; }
      .items .idx { width: 6mm; color: var(--ink-muted); }
      .item-name { font-weight: 600; }
      .item-sub { margin-top: 0.4mm; font-size: var(--s-small); color: var(--ink-muted); }
      .sku { font-size: var(--s-small); letter-spacing: 0.02em; white-space: nowrap; }
      .qty { font-weight: 700; }
      .tick { display: inline-block; width: 4.2mm; height: 4.2mm; border: 1pt solid var(--ink); vertical-align: middle; }

      .close { display: grid; grid-template-columns: 1fr 78mm; gap: var(--gap); margin-top: var(--gap); align-items: start; }
      .note { border-left: 2pt solid var(--ink); padding: 0.6mm 0 0.6mm 3mm; }
      .note p { margin: 1mm 0 0; font-weight: 500; white-space: pre-line; }
      table.totals { width: 100%; border-collapse: collapse; }
      .totals td { padding: 1.1mm 0; }
      .totals td + td { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .totals .label { color: var(--ink-soft); }
      .totals .total td { border-top: 1pt solid var(--ink); padding-top: 2mm; font-weight: 700; }
      .totals .due td {
        border-top: 2pt solid var(--ink); padding-top: 2.4mm; font-weight: 700; font-size: calc(var(--s-body) * 1.45);
      }
      .pieces { margin-top: 2mm; text-align: right; font-weight: 700; }

      footer {
        margin-top: calc(var(--gap) * 1.4); padding-top: 3mm; border-top: 1px solid var(--hairline);
        font-size: var(--s-small); color: var(--ink-soft); line-height: 1.5;
      }
      footer .thanks { color: var(--ink); font-weight: 700; font-size: var(--s-body); margin-bottom: 0.8mm; }`;
}

function brandBlock(brand: DocumentBrand, withMeta: boolean): string {
  const meta = withMeta
    ? [
        brand.legalName !== '' && brand.legalName !== brand.displayName ? brand.legalName : null,
        brand.address,
        brand.vatNo === null ? null : `VAT reg. no. ${brand.vatNo}`,
      ].filter((part): part is string => part !== null && part.trim() !== '')
    : [];
  return `<div class="brand">
        ${brand.logo === null ? '' : `<img class="logo" src="${escapeHtml(brand.logo)}" alt="" />`}
        <div>
          <div class="brand-name">${escapeHtml(brand.displayName)}</div>
          ${meta.length === 0 ? '' : `<div class="brand-meta">${meta.map(escapeHtml).join('<br />')}</div>`}
        </div>
      </div>`;
}

function masthead(
  brand: DocumentBrand,
  title: string,
  data: OrderDocumentData,
  paper: DocumentPaper,
  options: { readonly barcode: boolean } = { barcode: true },
): string {
  const value = documentBarcodeValue(data);
  const barcode = paper === 'a4' ? orderBarcode(value, 0.3, 12) : orderBarcode(value, 0.25, 9);
  return `<header class="masthead">
      ${brandBlock(brand, true)}
      <div class="doc-id">
        <div class="doc-title">${escapeHtml(title)}</div>
        <div class="order-no" data-field="order-no">${escapeHtml(data.orderNo)}</div>
        ${lotBadge(data)}
        ${options.barcode ? `<div class="barcode">${barcode}</div>` : ''}
      </div>
    </header>`;
}

/** The widest a slip's scan strip draws its narrowest bar (D-905). */
export const SLIP_MODULE_MM = 0.5;

/**
 * The packing slip's barcode, alone on a strip the page's width (D-905).
 *
 * The slip is what the packing station and the courier's handover scan, and it is often printed
 * on the 4 × 6 label printer, shrunk to about two thirds of its A5. In the header's corner its
 * bars were 0.25 mm and 9 mm tall: two thirds of that is one or two of a thermal head's dots,
 * which a scanner reads only on its third try. On its own strip under the header it is drawn at
 * 0.5 mm (narrower only when a long lot code would not fit the page's width), 12 mm tall on A5
 * and 16 mm on A4, so even shrunk the bars stay a third of a millimetre wide and over 8 mm tall,
 * with their quiet zones clear of anything else. The order number above it is the human copy.
 * The slip's own spacing (`slipCss`) gives the strip its height back, so the slip still prints on
 * one page.
 */
function scanStrip(data: OrderDocumentData, paper: DocumentPaper): string {
  const value = documentBarcodeValue(data);
  const size = PAPER[paper];
  const modules = code128Encode(value).width + CODE128_QUIET_MODULES * 2;
  const room = size.widthMm - size.marginMm * 2;
  const moduleMm = Math.min(SLIP_MODULE_MM, Math.floor((room / modules) * 100) / 100);
  return `<section class="scan-strip" data-field="scan">
      ${orderBarcode(value, moduleMm, paper === 'a4' ? SLIP_BARS_MM.a4 : SLIP_BARS_MM.a5)}
    </section>`;
}

/** The scan strip's bar height (D-905). */
export const SLIP_BARS_MM = { a4: 16, a5: 12 } as const;

/** The packing slip's vertical rhythm, tightened to pay for its scan strip (D-905). */
function slipCss(): string {
  return `
      .scan-strip { margin-top: calc(var(--gap) * 0.5); }
      .hero { margin-top: calc(var(--gap) * 0.7); }
      .strip, table.items { margin-top: calc(var(--gap) * 0.7); }
      footer { margin-top: var(--gap); }`;
}

function recipient(data: OrderDocumentData): string {
  return `<div class="party" data-field="recipient">
        <div class="caption">Deliver to</div>
        <div class="name" data-field="name">${escapeHtml(data.customerName)}</div>
        <div class="phone" data-field="phone">${escapeHtml(data.customerPhone)}</div>
        <div class="address" data-field="address">${escapeHtml(data.addressLine)}${
          data.locality === '' ? '' : `<br />${escapeHtml(data.locality)}`
        }</div>
        ${data.district === '' ? '' : `<div class="district">${escapeHtml(data.district)}</div>`}
      </div>`;
}

function cashBox(data: OrderDocumentData): string {
  const nothing = data.codAmountPoisha <= 0n;
  const note = nothing
    ? 'Paid in full. Collect nothing.'
    : data.advancePaidPoisha > 0n
      ? `${takaText(data.advancePaidPoisha)} paid in advance`
      : 'Cash on delivery';
  return `<div class="collect" data-field="collect">
        <div class="collect-label">${nothing ? 'Nothing to collect' : 'Cash to collect'}</div>
        <div class="collect-amount">${escapeHtml(takaText(nothing ? poisha(0n) : data.codAmountPoisha))}</div>
        <div class="collect-note">${escapeHtml(note)}</div>
      </div>`;
}

function courierFacts(data: OrderDocumentData): string {
  const courier = data.courier;
  if (courier === null) return `<dt>Courier</dt><dd>Not chosen yet</dd>`;
  return `<dt>Courier</dt><dd>${escapeHtml(courier.name)}</dd>
        <dt>Consignment</dt><dd class="mono">${escapeHtml(courier.consignmentNo ?? 'Not booked yet')}</dd>
        ${
          courier.trackingCode === null || courier.trackingCode === courier.consignmentNo
            ? ''
            : `<dt>Tracking</dt><dd class="mono">${escapeHtml(courier.trackingCode)}</dd>`
        }`;
}

function variantSub(line: DocumentLine): string {
  return line.other === null || line.other === ''
    ? ''
    : `<div class="item-sub">${escapeHtml(line.other)}</div>`;
}

function dash(value: string | null): string {
  return value === null || value === '' ? '<span class="item-sub">—</span>' : escapeHtml(value);
}

function noteBlock(data: OrderDocumentData): string {
  return data.notes === null || data.notes.trim() === ''
    ? '<div></div>'
    : `<div class="note"><div class="caption">Note</div><p>${escapeHtml(data.notes.trim())}</p></div>`;
}

function htmlDocument(title: string, css: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
${css}
    </style>
  </head>
  <body>
${body}
  </body>
</html>`;
}

/** The commercial document: every line's price, the totals, what was paid and what is due. */
export function renderOrderInvoiceHtml(input: {
  readonly brand: DocumentBrand;
  readonly data: OrderDocumentData;
  readonly fonts: readonly FontFile[];
}): string {
  const { brand, data, fonts } = input;
  // Each line's amount is quantity × unit price, so the column adds up to the subtotal; a
  // line's own discount is named under it and counted once, in the Discount row.
  const rows = data.lines
    .map((line, index) => {
      const gross = mulQty(line.unitPricePoisha, line.qty);
      return `
        <tr>
          <td class="idx num">${String(index + 1)}</td>
          <td><div class="item-name">${escapeHtml(line.name)}</div>${variantSub(line)}${
            line.lineDiscountPoisha > 0n
              ? `<div class="item-sub">Discount ${escapeHtml(takaText(line.lineDiscountPoisha))}, in the total below</div>`
              : ''
          }</td>
          <td class="sku">${escapeHtml(line.sku)}</td>
          <td>${dash(line.size)}</td>
          <td>${dash(line.colour)}</td>
          <td class="r num qty">${String(line.qty)}</td>
          <td class="r num">${escapeHtml(takaText(line.unitPricePoisha))}</td>
          <td class="r num">${escapeHtml(takaText(gross))}</td>
        </tr>`;
    })
    .join('');

  const total = orderTotal(data);
  const body = `
    ${masthead(brand, 'Invoice', data, 'a4')}

    <section class="hero" style="grid-template-columns: 1.25fr 1fr 0.95fr">
      ${recipient(data)}
      <dl class="facts" data-field="facts">
        <dt>Order date</dt><dd>${escapeHtml(documentDate(data.issuedOn))}</dd>
        <dt>Channel</dt><dd>${escapeHtml(channelWords(data.channel))}</dd>
        <dt>Payment</dt><dd>${escapeHtml(paymentWords(data))}</dd>
        ${courierFacts(data)}
      </dl>
      ${cashBox(data)}
    </section>

    <table class="items" data-field="items">
      <thead>
        <tr>
          <th class="idx">#</th>
          <th>Item</th>
          <th>SKU</th>
          <th>Size</th>
          <th>Colour</th>
          <th class="r">Qty</th>
          <th class="r">Unit price</th>
          <th class="r">Amount</th>
        </tr>
      </thead>
      <tbody>${rows}
      </tbody>
    </table>

    <section class="close">
      ${noteBlock(data)}
      <table class="totals" data-field="totals">
        <tbody>
          <tr><td class="label">Subtotal (${String(units(data))} ${units(data) === 1 ? 'item' : 'items'})</td><td>${escapeHtml(takaText(data.itemsPoisha))}</td></tr>
          <tr><td class="label">Discount</td><td>${escapeHtml(data.discountPoisha > 0n ? `-${takaText(data.discountPoisha)}` : takaText(data.discountPoisha))}</td></tr>
          <tr><td class="label">Delivery</td><td>${escapeHtml(takaText(data.deliveryChargePoisha))}</td></tr>
          <tr class="total"><td>Total</td><td>${escapeHtml(takaText(total))}</td></tr>
          <tr><td class="label">Paid</td><td>${escapeHtml(takaText(data.advancePaidPoisha))}</td></tr>
          <tr class="due"><td>To collect</td><td>${escapeHtml(takaText(data.codAmountPoisha))}</td></tr>
        </tbody>
      </table>
    </section>

    <footer>
      <div class="thanks">Thank you for shopping with ${escapeHtml(brand.displayName)}.</div>
      <div>${escapeHtml(
        brand.invoiceFooter ?? 'To exchange an item, contact us within 7 days of delivery.',
      )}</div>
      <div>This invoice is computer-generated and needs no signature.</div>
    </footer>`;

  return htmlDocument(
    `${data.orderNo} invoice`,
    `${baseCss(fonts)}\n${pageCss()}\n${scaleCss('a4')}`,
    body,
  );
}

/**
 * The picking and handover document, A4 or A5.
 *
 * No unit prices and no line totals — only what goes in the box, a square to tick for each
 * line, and how much to collect.
 */
export function renderPackingSlipHtml(input: {
  readonly brand: DocumentBrand;
  readonly data: OrderDocumentData;
  readonly fonts: readonly FontFile[];
  readonly paper?: DocumentPaper;
}): string {
  const { brand, data, fonts } = input;
  const paper = input.paper ?? 'a4';
  const rows = data.lines
    .map(
      (line, index) => `
        <tr>
          <td class="idx num">${String(index + 1)}</td>
          <td><div class="item-name">${escapeHtml(line.name)}</div>${variantSub(line)}</td>
          <td class="sku">${escapeHtml(line.sku)}</td>
          <td>${dash(line.size)}</td>
          <td>${dash(line.colour)}</td>
          <td class="r num qty">${String(line.qty)}</td>
          <td class="r"><span class="tick" aria-label="Packed"></span></td>
        </tr>`,
    )
    .join('');

  const courier = data.courier;
  const body = `
    ${masthead(brand, 'Packing slip', data, paper, { barcode: false })}
    ${scanStrip(data, paper)}

    <section class="hero" style="grid-template-columns: 1.35fr 1fr">
      ${recipient(data)}
      ${cashBox(data)}
    </section>

    <section class="strip" data-field="facts">
      <div><div class="caption">Order date</div><div class="value">${escapeHtml(documentDate(data.issuedOn))}</div></div>
      <div><div class="caption">Channel</div><div class="value">${escapeHtml(channelWords(data.channel))}</div></div>
      <div><div class="caption">Courier</div><div class="value">${escapeHtml(courier?.name ?? 'Not chosen yet')}</div></div>
      <div><div class="caption">Consignment</div><div class="value">${escapeHtml(courier?.consignmentNo ?? 'Not booked yet')}</div></div>
      ${
        courier?.trackingCode == null || courier.trackingCode === courier.consignmentNo
          ? ''
          : `<div><div class="caption">Tracking</div><div class="value">${escapeHtml(courier.trackingCode)}</div></div>`
      }
      <div><div class="caption">Pieces</div><div class="value">${String(units(data))}</div></div>
    </section>

    <table class="items" data-field="items">
      <thead>
        <tr>
          <th class="idx">#</th>
          <th>Item</th>
          <th>SKU</th>
          <th>Size</th>
          <th>Colour</th>
          <th class="r">Qty</th>
          <th class="r">Packed</th>
        </tr>
      </thead>
      <tbody>${rows}
      </tbody>
    </table>
    <div class="pieces">${String(units(data))} ${units(data) === 1 ? 'piece' : 'pieces'} ${
      lotOf(data) === null
        ? 'in this parcel'
        : `in this order, packed in ${String(lotOf(data)?.count ?? 1)} lots`
    }</div>

    ${data.notes === null || data.notes.trim() === '' ? '' : `<section class="close" style="grid-template-columns: 1fr">${noteBlock(data)}</section>`}

    <footer>
      <div>${escapeHtml(brand.displayName)} · Order ${escapeHtml(data.orderNo)} · Scan the barcode at the packing station to open this order.</div>
    </footer>`;

  return htmlDocument(
    `${data.orderNo} packing slip`,
    `${baseCss(fonts)}\n${pageCss()}\n${scaleCss(paper)}\n${slipCss()}`,
    body,
  );
}

/**
 * The parcel's address label, 4 × 6 inches (M11 bulk print; §22).
 *
 * The thermal label every Bangladeshi courier's pickup desk prints, one order per label. What
 * is on it is what a rider needs at a door: who, where, how much to collect, the courier and
 * its numbers, and the order number as a Code 128 barcode so the warehouse scans it at
 * handover instead of typing it. All black, nothing grey: a thermal head prints grey as ash.
 */
export function renderLabelHtml(input: {
  readonly brand: DocumentBrand;
  readonly data: OrderDocumentData;
  readonly fonts: readonly FontFile[];
}): string {
  const { brand, data, fonts } = input;
  const courier = data.courier;
  const nothing = data.codAmountPoisha <= 0n;
  const body = `
    <div class="label">
      <div class="top">
        <div class="from">${brand.logo === null ? '' : `<img class="logo" src="${escapeHtml(brand.logo)}" alt="" />`}<span>${escapeHtml(brand.displayName)}</span></div>
        <div class="courier">${escapeHtml(courier?.name ?? 'Courier')}</div>
      </div>
      <div class="barcode">${orderBarcode(documentBarcodeValue(data), 0.375, 17)}</div>
      <div class="order-no" data-field="order-no">${escapeHtml(data.orderNo)}</div>
      ${lotBadge(data)}

      <div class="to" data-field="recipient">
        <div class="caption">Deliver to</div>
        <div class="name" data-field="name">${escapeHtml(data.customerName)}</div>
        <div class="phone" data-field="phone">${escapeHtml(data.customerPhone)}</div>
        <div class="address" data-field="address">${escapeHtml(data.addressLine)}</div>
        <div class="area">${escapeHtml([data.locality, data.district].filter((part) => part !== '').join(', '))}</div>
      </div>

      <div class="cod" data-field="collect">
        <div class="cod-label">${nothing ? 'Paid in full · Collect nothing' : 'Cash on delivery · Collect'}</div>
        <div class="cod-amount">${escapeHtml(takaText(nothing ? poisha(0n) : data.codAmountPoisha))}</div>
      </div>

      <div class="foot">
        <div><div class="caption">Consignment</div><div class="value">${escapeHtml(courier?.consignmentNo ?? 'Not booked')}</div></div>
        <div><div class="caption">Pieces</div><div class="value">${String(units(data))}</div></div>
        <div><div class="caption">Date</div><div class="value">${escapeHtml(documentDate(data.issuedOn))}</div></div>
      </div>
    </div>`;

  return htmlDocument(`${data.orderNo} label`, labelCss(fonts), body);
}

function labelCss(fonts: readonly FontFile[]): string {
  const page = PAPER.label;
  return `${fontFaceCss(fonts)}
      @page { size: ${String(page.widthMm)}mm ${String(page.heightMm)}mm; margin: 0; }
      * { box-sizing: border-box; }
      html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      body { margin: 0; font-family: ${DOCUMENT_FONT_STACK}; color: #000; }
      /* A hair under the page, so rounding from millimetres can never spill onto a second label. */
      .label {
        width: ${String(page.widthMm)}mm; height: ${String(page.heightMm - 0.2)}mm; padding: 4mm 4.5mm;
        display: flex; flex-direction: column; overflow: hidden; font-size: 9pt; line-height: 1.3;
      }
      .caption { font-size: 6.5pt; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
      .top { display: flex; justify-content: space-between; align-items: center; gap: 3mm; padding-bottom: 2mm; border-bottom: 1.5pt solid #000; }
      .from { display: flex; align-items: center; gap: 2mm; min-width: 0; font-size: 10pt; font-weight: 700; }
      .from span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .logo { max-height: 7mm; max-width: 20mm; object-fit: contain; filter: grayscale(100%) contrast(140%); }
      .courier { flex: none; background: #000; color: #fff; padding: 1mm 2.4mm; font-size: 9pt; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
      .barcode { margin-top: 3mm; text-align: center; line-height: 0; }
      .barcode svg { display: inline-block; }
      .order-no { margin-top: 1.2mm; text-align: center; font-size: 16pt; font-weight: 700; letter-spacing: 0.06em; }
      /* M46 (D-806): one bag of several, black on white so a thermal head prints it solid. */
      .lot { margin: 1.4mm auto 0; width: fit-content; background: #000; color: #fff; padding: 1mm 3.2mm; font-size: 13pt; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; }
      .to { margin-top: 3mm; padding-top: 2.6mm; border-top: 1.5pt solid #000; }
      .name { margin-top: 1mm; font-size: 17pt; font-weight: 700; line-height: 1.15; overflow-wrap: anywhere; }
      .phone { margin-top: 0.6mm; font-size: 17pt; font-weight: 700; letter-spacing: 0.02em; }
      .address {
        margin-top: 1.6mm; font-size: 11.5pt; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere;
        display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden;
      }
      .area { margin-top: 0.8mm; font-size: 11.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; }
      .cod { margin-top: auto; border: 2pt solid #000; }
      .cod-label { background: #000; color: #fff; padding: 1.2mm 2.6mm; font-size: 7.5pt; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
      .cod-amount { padding: 1.6mm 2.6mm 1.8mm; font-size: 28pt; font-weight: 700; line-height: 1.05; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .foot { display: grid; grid-template-columns: 1.6fr 0.7fr 1fr; gap: 2mm; margin-top: 2.6mm; }
      .foot .value { margin-top: 0.4mm; font-size: 9.5pt; font-weight: 700; overflow-wrap: anywhere; }`;
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

export function renderOrderDocumentHtml(
  kind: OrderDocumentKind,
  brand: DocumentBrand,
  data: OrderDocumentData,
  fonts: readonly FontFile[],
  paper: DocumentPaper = 'a4',
): string {
  if (kind === 'invoice') return renderOrderInvoiceHtml({ brand, data, fonts });
  if (kind === 'packing_slip') return renderPackingSlipHtml({ brand, data, fonts, paper });
  return renderLabelHtml({ brand, data, fonts });
}

/**
 * Several orders' documents as one HTML file, a page each (M11 bulk print).
 *
 * One file and one Gotenberg call rather than one per order and a PDF merge afterwards: a
 * warehouse printing forty labels at the end of a shift wants one print dialog. Each order's
 * page is exactly the page the single-order endpoint renders — the body is lifted from the
 * same template — so a batch cannot drift from a reprint of one order.
 */
export function renderBatchHtml(input: {
  readonly kind: OrderDocumentKind;
  readonly brand: DocumentBrand;
  readonly documents: readonly OrderDocumentData[];
  readonly fonts: readonly FontFile[];
  readonly paper?: DocumentPaper;
}): string {
  const { kind, brand, documents, fonts } = input;
  const paper = input.paper ?? 'a4';
  const first = documents[0];
  if (first === undefined) throw new Error('a batch needs at least one order');
  const css = styleOf(renderOrderDocumentHtml(kind, brand, first, fonts, paper));
  const pages = documents
    .map(
      (data) =>
        `<section class="sheet">${bodyOf(renderOrderDocumentHtml(kind, brand, data, fonts, paper))}</section>`,
    )
    .join('\n');
  return htmlDocument(
    `${String(documents.length)} orders`,
    `${css}
      .sheet { break-after: page; }
      .sheet:last-child { break-after: auto; }`,
    pages,
  );
}

/** The paper and margin Gotenberg prints a kind on, in inches as it takes them. */
export function paperFor(
  kind: OrderDocumentKind,
  paper: DocumentPaper = 'a4',
): { paperWidth: number; paperHeight: number; marginInches: number } {
  const size = kind === 'label' ? PAPER.label : kind === 'packing_slip' ? PAPER[paper] : PAPER.a4;
  // Six decimals of an inch is a ten-thousandth of a millimetre, and keeps 152.4 mm exactly
  // 6 in rather than 6.000000000000001.
  const inches = (mm: number) => Math.round((mm / 25.4) * 1_000_000) / 1_000_000;
  return {
    paperWidth: inches(size.widthMm),
    paperHeight: inches(size.heightMm),
    marginInches: inches(size.marginMm),
  };
}
