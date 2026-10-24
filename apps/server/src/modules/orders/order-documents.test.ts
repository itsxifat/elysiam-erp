import {
  banglaCharactersIn,
  code128Encode,
  CODE128_QUIET_MODULES,
  normaliseScannedCode,
  poisha,
} from '@elysium/domain';
import { parseLotScanCode, parseOrderScanCode, readLotCode } from '@elysium/domain/packing';
import { describe, expect, it } from 'vitest';

import { decodeCode128Svg } from '../../testing/code128-decode.js';
import {
  channelWords,
  documentBarcodeValue,
  documentDate,
  labelModuleMm,
  orderTotal,
  PAPER,
  paperFor,
  paymentWords,
  renderBatchHtml,
  renderLabelHtml,
  renderOrderDocumentHtml,
  renderOrderInvoiceHtml,
  renderPackingSlipHtml,
  SLIP_BARS_MM,
  SLIP_MODULE_MM,
  type OrderDocumentKind,
} from './order-documents.js';
import { SAMPLE_BRAND, SAMPLE_ORDER } from './order-documents.sample.js';

/**
 * The order's documents, read without a renderer (M43 checks 1 and 2).
 *
 * What the page says is ours; the bytes are Chromium's and are checked against the real
 * Gotenberg in `files/pdf/documents-review.test.ts`, which also measures the page sizes and
 * writes the review screenshots.
 */

const KINDS: readonly { kind: OrderDocumentKind; paper: 'a4' | 'a5' }[] = [
  { kind: 'invoice', paper: 'a4' },
  { kind: 'packing_slip', paper: 'a4' },
  { kind: 'packing_slip', paper: 'a5' },
  { kind: 'label', paper: 'a4' },
];

function render(kind: OrderDocumentKind, paper: 'a4' | 'a5' = 'a4'): string {
  return renderOrderDocumentHtml(kind, SAMPLE_BRAND, SAMPLE_ORDER, [], paper);
}

/** The text of the element carrying `data-field="<name>"`, tags stripped. */
function field(html: string, name: string): string {
  const start = html.indexOf(`data-field="${name}"`);
  expect(start, `no ${name} on the page`).toBeGreaterThan(-1);
  const open = html.lastIndexOf('<', start);
  const tag = /^<(\w+)/.exec(html.slice(open))?.[1] ?? 'div';
  let depth = 0;
  const pattern = new RegExp(`<(/?)${tag}\\b`, 'g');
  pattern.lastIndex = open;
  for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
    depth += match[1] === '/' ? -1 : 1;
    if (depth === 0) {
      return html
        .slice(open, match.index)
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }
  throw new Error(`${name} never closes`);
}

/** The value of a CSS custom property or declaration in the page's style block. */
function cssPt(html: string, property: string): number {
  const match = new RegExp(`${property}:\\s*([\\d.]+)pt`).exec(html);
  return Number(match?.[1] ?? Number.NaN);
}

describe('every order document is English (check 2)', () => {
  it('carries no character of the Bengali block, the taka sign included', () => {
    for (const { kind, paper } of KINDS) {
      const html = render(kind, paper);
      expect(banglaCharactersIn(html), `${kind} ${paper}`).toEqual([]);
      expect(html, kind).toContain('<html lang="en">');
    }
  });

  it('writes money as "Tk 1,250.00" through takaText, and district and thana in English', () => {
    const invoice = render('invoice');
    expect(invoice).toContain('Tk 8,460.00');
    expect(invoice).toContain('Tk 2,450.00');
    expect(invoice).toContain('Dhanmondi, Dhanmondi');
    expect(invoice).toContain('<div class="district">Dhaka</div>');
    expect(invoice).not.toContain('৳');
  });
});

describe('the packing slip (check 1)', () => {
  for (const paper of ['a4', 'a5'] as const) {
    it(`leads with the order number, the cash to collect and the recipient, large and bold (${paper})`, () => {
      const html = render('packing_slip', paper);
      expect(field(html, 'order-no')).toBe('ELY-2610-00042');
      expect(field(html, 'collect')).toContain('Cash to collect');
      expect(field(html, 'collect')).toContain('Tk 8,460.00');
      expect(field(html, 'name')).toBe('Nusrat Jahan Chowdhury');
      expect(field(html, 'phone')).toBe('01700-000123');
      expect(field(html, 'address')).toContain('Concord Royal Court');
      expect(field(html, 'address')).toContain('Dhanmondi, Dhanmondi');

      // Large: the order number, the amount and the recipient are the page's biggest type,
      // well above its body; bold: each is set at 700.
      const body = cssPt(html, '--s-body');
      for (const variable of ['--s-order', '--s-collect', '--s-name', '--s-phone']) {
        expect(cssPt(html, variable), variable).toBeGreaterThanOrEqual(body * 1.5);
      }
      expect(cssPt(html, '--s-address')).toBeGreaterThan(body);
      for (const rule of ['.order-no', '.collect-amount', '.name', '.phone']) {
        const css = new RegExp(`\\${rule} \\{[^}]*font-weight: 700`).test(html);
        expect(css, `${rule} is bold`).toBe(true);
      }
      expect(/\.address \{[^}]*font-weight: 600/.test(html), '.address is semibold').toBe(true);
    });
  }

  it('carries the items with SKU, size, colour and quantity, and no prices', () => {
    const html = render('packing_slip');
    const items = field(html, 'items');
    for (const text of ['Linen Panjabi', 'ELY-PNJ-0012-M-NVY', 'Navy', 'Free size', 'Olive']) {
      expect(items).toContain(text);
    }
    expect(items).toContain('Long sleeve');
    // A priced slip taped to a box is an argument at the door; only the cash to collect.
    expect(html).not.toContain('Tk 2,450.00');
    expect(html).not.toContain('Tk 8,895.00');
    expect(html).toContain('7 pieces in this parcel');
  });

  it('names the courier with the consignment and tracking numbers, the date and the channel', () => {
    const facts = field(render('packing_slip'), 'facts');
    expect(facts).toContain('Steadfast');
    expect(facts).toContain('127403991');
    expect(facts).toContain('SFR2610ELY42');
    expect(facts).toContain('11 Oct 2026');
    expect(facts).toContain('Facebook');
  });
});

/** The sample order's ten digits and its lot 2's twelve (D-912). */
const ORDER_DIGITS = '2610000042';
const LOT_DIGITS = '261000004202';

/** One dot of a 203 dpi thermal head, in millimetres. */
const DOT_MM = 25.4 / 203;

/** The first barcode on a page: its printed size and what it says it carries. */
function sized(html: string): { width: number; height: number; value: string; svg: string } {
  const match = /<svg [^>]*width="([\d.]+)mm" height="([\d.]+)mm"[^>]*data-barcode="([^"]*)"/.exec(
    html,
  );
  const svg = /<svg [^>]*data-barcode="[^"]*"[\s\S]*?<\/svg>/.exec(html)?.[0] ?? '';
  return {
    width: Number(match?.[1]),
    height: Number(match?.[2]),
    value: match?.[3] ?? '',
    svg,
  };
}

/** A barcode's whole width in modules, quiet zones included. */
const modulesOf = (value: string) => code128Encode(value).width + CODE128_QUIET_MODULES * 2;

describe('the order barcode is the code the packing station opens (check 1)', () => {
  it('decodes, from the printed bars, to the order’s digits and nothing else (D-912)', () => {
    for (const { kind, paper } of KINDS) {
      const html = render(kind, paper);
      const { svg } = sized(html);
      expect(svg, kind).not.toBe('');
      const decoded = decodeCode128Svg(svg);
      expect(decoded, `${kind} ${paper}`).toBe(ORDER_DIGITS);
      // What the station does with a scan before it looks the code up (`station.service.ts`).
      expect(normaliseScannedCode(decoded)).toBe(ORDER_DIGITS);
      // No letter and no hyphen in the bars: the period and the counter of the order number.
      expect(decoded).toMatch(/^\d+$/);
      expect(parseOrderScanCode(decoded)).toEqual({ period: '2610', counter: '00042' });
      // The order number in letters is still printed, as the human copy, and on the label the
      // digits under the bars for typing; the A5 slip has no room left for them (D-905).
      expect(field(html, 'order-no')).toBe(SAMPLE_ORDER.orderNo);
      if (kind === 'label') expect(field(html, 'scan-digits')).toBe(ORDER_DIGITS);
      else expect(html).not.toContain('data-field="scan-digits"');
    }
  });

  it('carries one lot of several as its twelve digits, on every page (D-806, D-912)', () => {
    const lotted = { ...SAMPLE_ORDER, lot: { no: 2, count: 3 } };
    expect(documentBarcodeValue(lotted)).toBe(LOT_DIGITS);
    expect(readLotCode(LOT_DIGITS)).toEqual({ orderCode: ORDER_DIGITS, lot: 2 });
    expect(parseLotScanCode(LOT_DIGITS)).toEqual({ orderCode: ORDER_DIGITS, lot: 2 });
    for (const { kind, paper } of KINDS) {
      const html = renderOrderDocumentHtml(kind, SAMPLE_BRAND, lotted, [], paper);
      expect(decodeCode128Svg(sized(html).svg), `${kind} ${paper}`).toBe(LOT_DIGITS);
      expect(field(html, 'lot')).toBe('Lot 2 of 3');
    }
    // A lot count of one is an order in one bag: the order's own ten digits.
    expect(documentBarcodeValue({ ...SAMPLE_ORDER, lot: { no: 1, count: 1 } })).toBe(ORDER_DIGITS);
  });

  it('prints the order number as text for an order with no digits-only code, as before', () => {
    // A counter past six digits (a million orders in a month) has no ten-digit code.
    const huge = { ...SAMPLE_ORDER, orderNo: 'ELY-2610-1000000' };
    expect(documentBarcodeValue(huge)).toBe('ELY-2610-1000000');
    expect(documentBarcodeValue({ ...huge, lot: { no: 2, count: 3 } })).toBe('ELY-2610-1000000-L2');
    for (const { kind, paper } of KINDS) {
      const html = renderOrderDocumentHtml(kind, SAMPLE_BRAND, huge, [], paper);
      expect(decodeCode128Svg(sized(html).svg), `${kind} ${paper}`).toBe('ELY-2610-1000000');
    }
  });

  it('gives the packing slip one strip barcode a scanner reads even shrunk onto a label (D-905)', () => {
    for (const paper of ['a4', 'a5'] as const) {
      const html = render('packing_slip', paper);
      // The strip only: no second, smaller barcode in the header to aim at by mistake.
      expect(html.match(/data-barcode=/g)).toHaveLength(1);
      expect(html).toContain('data-field="scan"');
      const { width, height, value } = sized(html);
      expect(value).toBe(ORDER_DIGITS);
      // D-912: 1 mm a bar, twice D-905's 0.5, and no wider than a lot's strip was at 0.5 mm, so a
      // scanner's window takes it in as before.
      expect(width / modulesOf(value)).toBeCloseTo(SLIP_MODULE_MM, 2);
      expect(width).toBeLessThanOrEqual(modulesOf(`${SAMPLE_ORDER.orderNo}-L2`) * 0.5);
      expect(height).toBe(SLIP_BARS_MM[paper]);
    }
    // On the 4 × 6 printer the slip is drawn on A5 and shrunk to fit (D-822): over two thirds of
    // a millimetre a bar, five of a 203 dpi head's dots and more (it was a third, under three),
    // and over eight millimetres tall. The bars decoded off a real 203 dpi render are
    // `render.gotenberg.test.ts`'s.
    const a5 = sized(render('packing_slip', 'a5'));
    const shrink = Math.min(
      PAPER.label.widthMm / PAPER.a5.widthMm,
      PAPER.label.heightMm / PAPER.a5.heightMm,
    );
    expect((a5.width / modulesOf(a5.value)) * shrink).toBeGreaterThanOrEqual(5 * DOT_MM);
    expect(a5.height * shrink).toBeGreaterThanOrEqual(8);

    // A lot of several carries its twelve digits at the same 1 mm, inside the margins.
    const lotted = renderPackingSlipHtml({
      brand: SAMPLE_BRAND,
      data: { ...SAMPLE_ORDER, lot: { no: 2, count: 3 } },
      fonts: [],
      paper: 'a5',
    });
    const lot = sized(lotted);
    expect(lot.value).toBe(LOT_DIGITS);
    expect(lot.width / modulesOf(lot.value)).toBeCloseTo(SLIP_MODULE_MM, 2);
    expect(lot.width).toBeLessThanOrEqual(PAPER.a5.widthMm - PAPER.a5.marginMm * 2);
    expect(decodeCode128Svg(lot.svg)).toBe(LOT_DIGITS);

    // A code that falls back to text is drawn narrower, as fits the page.
    const text = sized(
      renderPackingSlipHtml({
        brand: SAMPLE_BRAND,
        data: { ...SAMPLE_ORDER, orderNo: 'ELY-2610-1000000', lot: { no: 2, count: 3 } },
        fonts: [],
        paper: 'a5',
      }),
    );
    expect(text.value).toBe('ELY-2610-1000000-L2');
    expect(text.width).toBeLessThanOrEqual(PAPER.a5.widthMm - PAPER.a5.marginMm * 2);
    expect(decodeCode128Svg(text.svg)).toBe('ELY-2610-1000000-L2');
  });

  it('prints whole modules: 0.5 mm on the invoice, whole thermal dots on the label', () => {
    expect(sized(render('invoice')).width / modulesOf(ORDER_DIGITS)).toBeCloseTo(0.5, 2);
    expect(sized(render('invoice')).width).toBeLessThan(modulesOf(SAMPLE_ORDER.orderNo) * 0.3);
  });

  it('draws the label’s bars as wide as fit its width in whole dots, from the symbol (D-912)', () => {
    const room = PAPER.label.widthMm - 2 * 4.5;
    const label = (data: typeof SAMPLE_ORDER) =>
      sized(renderLabelHtml({ brand: SAMPLE_BRAND, data, fonts: [] }));
    const cases = [
      // The order's ten digits and a lot's twelve: six dots, 0.75 mm.
      { data: SAMPLE_ORDER, value: ORDER_DIGITS, dots: 6 },
      { data: { ...SAMPLE_ORDER, lot: { no: 2, count: 3 } }, value: LOT_DIGITS, dots: 6 },
      // A code that falls back to text: three dots, 0.375 mm, as every label had before, and two
      // for a long lot code that three would push past the label's edge.
      {
        data: { ...SAMPLE_ORDER, orderNo: 'ELY-2610-1000000' },
        value: 'ELY-2610-1000000',
        dots: 3,
      },
      {
        data: { ...SAMPLE_ORDER, orderNo: 'ELY-2610-1000000', lot: { no: 2, count: 3 } },
        value: 'ELY-2610-1000000-L2',
        dots: 2,
      },
    ];
    for (const { data, value, dots } of cases) {
      const { width, height, svg } = label(data);
      expect(decodeCode128Svg(svg), value).toBe(value);
      expect(field(renderLabelHtml({ brand: SAMPLE_BRAND, data, fonts: [] }), 'scan-digits')).toBe(
        value,
      );
      expect(labelModuleMm(value) / DOT_MM, value).toBeCloseTo(dots, 6);
      expect(width / modulesOf(value), value).toBeCloseTo(dots * DOT_MM, 3);
      expect(height).toBe(18);
      // It fits, and one dot more a bar would not.
      expect(width, value).toBeLessThanOrEqual(room);
      expect(modulesOf(value) * (dots + 1) * DOT_MM, value).toBeGreaterThan(room);
    }
  });
});

describe('the invoice', () => {
  it('lists every line with SKU, size, colour, quantity, unit price and amount', () => {
    const items = field(render('invoice'), 'items');
    expect(items).toContain('Cotton Kurti with block print');
    expect(items).toContain('ELY-KRT-0031-L-MRN');
    expect(items).toContain('Maroon');
    // 3 × 685 = 2,055: the amount is quantity × unit price.
    expect(items).toContain('Tk 685.00');
    expect(items).toContain('Tk 2,055.00');
    expect(items).toContain('Discount Tk 100.00, in the total below');
  });

  it('totals subtotal, discount, delivery, total, paid and to collect, and they add up', () => {
    const totals = field(render('invoice'), 'totals');
    expect(totals).toContain('Subtotal (7 items) Tk 8,895.00');
    expect(totals).toContain('Discount -Tk 295.00');
    expect(totals).toContain('Delivery Tk 60.00');
    expect(totals).toContain('Total Tk 8,660.00');
    expect(totals).toContain('Paid Tk 200.00');
    expect(totals).toContain('To collect Tk 8,460.00');
    expect(orderTotal(SAMPLE_ORDER)).toBe(poisha(866_000n));
  });

  it('carries the brand block: name, legal name, address and VAT number', () => {
    const html = render('invoice');
    expect(html).toContain('Elysiam Lifestyle BD Limited');
    expect(html).toContain('House 12, Road 5, Dhanmondi, Dhaka 1205');
    expect(html).toContain('VAT reg. no. 004512345678');
    expect(html).toContain('This invoice is computer-generated and needs no signature.');
  });

  it('shows the logo when the brand has one, and nothing in its place when not', () => {
    expect(render('invoice')).not.toContain('<img');
    const withLogo = renderOrderInvoiceHtml({
      brand: { ...SAMPLE_BRAND, logo: 'logo.webp' },
      data: SAMPLE_ORDER,
      fonts: [],
    });
    expect(withLogo).toContain('<img class="logo" src="logo.webp"');
  });

  it('escapes a buyer’s name and a note rather than letting them become markup', () => {
    const html = renderOrderInvoiceHtml({
      brand: SAMPLE_BRAND,
      data: { ...SAMPLE_ORDER, customerName: '<script>alert(1)</script>', notes: '<b>x</b>' },
      fonts: [],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<b>x</b>');
  });

  it('prints a buyer’s own Bangla as typed: their words are theirs, the page’s are English', () => {
    const typed = String.fromCodePoint(0x09b0, 0x09b9, 0x09bf, 0x09ae, 0x09be);
    const html = renderOrderInvoiceHtml({
      brand: SAMPLE_BRAND,
      data: { ...SAMPLE_ORDER, customerName: typed },
      fonts: [],
    });
    expect(html).toContain(typed);
    expect(banglaCharactersIn(html.replace(typed, ''))).toEqual([]);
  });
});

describe('the parcel label', () => {
  it('carries who, where, how much, the courier and its number, and no items or notes', () => {
    const html = renderLabelHtml({ brand: SAMPLE_BRAND, data: SAMPLE_ORDER, fonts: [] });
    expect(field(html, 'order-no')).toBe('ELY-2610-00042');
    expect(field(html, 'recipient')).toContain('Nusrat Jahan Chowdhury');
    expect(field(html, 'recipient')).toContain('01700-000123');
    expect(field(html, 'recipient')).toContain('Dhanmondi, Dhanmondi, Dhaka');
    expect(field(html, 'collect')).toContain('Tk 8,460.00');
    expect(html).toContain('127403991');
    expect(html).toContain('Steadfast');
    expect(html).not.toContain('Linen Panjabi');
    expect(html).not.toContain('Call before delivery');
    // D-911, D-912: the QR code carries what the bars do, the order's digits.
    expect(html).toContain(`data-qr="${ORDER_DIGITS}"`);
    expect(html).toContain(`data-barcode="${ORDER_DIGITS}"`);
    // Ink is black: no grey a thermal head would dither into ash.
    expect(html).not.toMatch(/#(?!000\b|fff\b)[0-9a-f]{3,6}\b/i);
  });

  it('says plainly when nothing is to be collected', () => {
    const paid = {
      ...SAMPLE_ORDER,
      codAmountPoisha: poisha(0n),
      advancePaidPoisha: poisha(866_000n),
    };
    expect(field(renderLabelHtml({ brand: SAMPLE_BRAND, data: paid, fonts: [] }), 'collect')).toBe(
      'Paid in full · Collect nothing Tk 0.00',
    );
    expect(paymentWords(paid)).toBe('Paid in full');
  });
});

describe('a batch', () => {
  it('is one page per order, each the single order’s page', () => {
    const second = { ...SAMPLE_ORDER, orderNo: 'ELY-2610-00043' };
    const html = renderBatchHtml({
      kind: 'packing_slip',
      brand: SAMPLE_BRAND,
      documents: [SAMPLE_ORDER, second],
      fonts: [],
      paper: 'a5',
    });
    expect(html.match(/<section class="sheet">/g)).toHaveLength(2);
    expect(html).toContain('ELY-2610-00043');
    expect(html).toContain('--s-body: 8pt');
    expect(banglaCharactersIn(html)).toEqual([]);
  });
});

describe('paper', () => {
  it('is exactly A4, A5 and 4 × 6 in, in Gotenberg’s inches', () => {
    const a4 = paperFor('invoice');
    expect(a4.paperWidth * 25.4).toBeCloseTo(210, 3);
    expect(a4.paperHeight * 25.4).toBeCloseTo(297, 3);
    expect(a4.marginInches * 25.4).toBeCloseTo(12, 3);
    const a5 = paperFor('packing_slip', 'a5');
    expect(a5.paperWidth * 25.4).toBeCloseTo(148, 3);
    expect(a5.paperHeight * 25.4).toBeCloseTo(210, 3);
    expect(paperFor('label')).toEqual({ paperWidth: 4, paperHeight: 6, marginInches: 0 });
    // The invoice is A4 whatever is asked; the schema refuses A5 for it.
    expect(paperFor('invoice', 'a5')).toEqual(a4);
  });
});

describe('words', () => {
  it('names channels, payment and dates in English', () => {
    expect(channelWords('walk_in')).toBe('Walk-in');
    expect(channelWords('landing_page')).toBe('Landing page');
    expect(channelWords('something_new')).toBe('something new');
    expect(documentDate('2026-01-07')).toBe('7 Jan 2026');
    expect(paymentWords({ ...SAMPLE_ORDER, advancePaidPoisha: poisha(0n) })).toBe(
      'Cash on delivery',
    );
    expect(paymentWords(SAMPLE_ORDER)).toBe('Part paid, balance on delivery');
  });

  it('renders the packing slip through the shared entry point too', () => {
    expect(renderPackingSlipHtml({ brand: SAMPLE_BRAND, data: SAMPLE_ORDER, fonts: [] })).toBe(
      render('packing_slip'),
    );
  });
});
