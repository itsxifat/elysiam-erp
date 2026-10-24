import { banglaCharactersIn, normaliseScannedCode, poisha } from '@elysium/domain';
import { describe, expect, it } from 'vitest';

import { decodeCode128Svg } from '../../testing/code128-decode.js';
import {
  channelWords,
  documentDate,
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

describe('the order barcode is the code the packing station opens (check 1)', () => {
  it('decodes, from the printed bars, to the order number the station looks up first', () => {
    for (const { kind, paper } of KINDS) {
      const html = render(kind, paper);
      const svg = /<svg [^>]*data-barcode="[^"]*"[\s\S]*?<\/svg>/.exec(html)?.[0] ?? '';
      expect(svg, kind).not.toBe('');
      const decoded = decodeCode128Svg(svg);
      expect(decoded, `${kind} ${paper}`).toBe(SAMPLE_ORDER.orderNo);
      // What the station does with a scan before it looks the code up (`station.service.ts`).
      expect(normaliseScannedCode(decoded)).toBe(SAMPLE_ORDER.orderNo);
    }
  });

  it('gives the packing slip one strip barcode a scanner reads even shrunk onto a label (D-905)', () => {
    const quiet = 20; // CODE128_QUIET_MODULES on each side
    const symbol = (value: string) => 11 * value.length + 35 + quiet; // subset B
    const sized = (html: string) => {
      const match =
        /<svg [^>]*width="([\d.]+)mm" height="([\d.]+)mm"[^>]*data-barcode="([^"]*)"/.exec(html);
      return { width: Number(match?.[1]), height: Number(match?.[2]), value: match?.[3] ?? '' };
    };
    for (const paper of ['a4', 'a5'] as const) {
      const html = render('packing_slip', paper);
      // The strip only: no second, smaller barcode in the header to aim at by mistake.
      expect(html.match(/data-barcode=/g)).toHaveLength(1);
      expect(html).toContain('data-field="scan"');
      const { width, height, value } = sized(html);
      expect(value).toBe(SAMPLE_ORDER.orderNo);
      expect(width / symbol(value)).toBeCloseTo(0.5, 2);
      expect(height).toBe(SLIP_BARS_MM[paper]);
    }
    // On the 4 × 6 printer the slip is drawn on A5 and shrunk to fit (D-822): still a third of a
    // millimetre a bar, and over eight millimetres tall (the old one was six). The bars decoded
    // off a real 203 dpi render are `render.gotenberg.test.ts`'s.
    const a5 = sized(render('packing_slip', 'a5'));
    const shrink = Math.min(
      PAPER.label.widthMm / PAPER.a5.widthMm,
      PAPER.label.heightMm / PAPER.a5.heightMm,
    );
    expect((a5.width / symbol(a5.value)) * shrink).toBeGreaterThanOrEqual(0.33);
    expect(a5.height * shrink).toBeGreaterThanOrEqual(8);

    // A lot of several carries its longer lot code, and the strip still fits inside the margins.
    const lotted = renderPackingSlipHtml({
      brand: SAMPLE_BRAND,
      data: { ...SAMPLE_ORDER, lot: { no: 2, count: 3 } },
      fonts: [],
      paper: 'a5',
    });
    const lot = sized(lotted);
    expect(lot.value).toBe(`${SAMPLE_ORDER.orderNo}-L2`);
    expect(lot.width).toBeLessThanOrEqual(PAPER.a5.widthMm - PAPER.a5.marginMm * 2);
    const svg = /<svg [^>]*data-barcode="[^"]*"[\s\S]*?<\/svg>/.exec(lotted)?.[0] ?? '';
    expect(decodeCode128Svg(svg)).toBe(`${SAMPLE_ORDER.orderNo}-L2`);
  });

  it('prints whole modules: 0.3 mm on A4, 0.375 mm (three thermal dots) on the label', () => {
    const width = (html: string) =>
      Number(/<svg [^>]*width="([\d.]+)mm"[^>]*data-barcode/.exec(html)?.[1] ?? Number.NaN);
    const a4 = width(render('invoice'));
    const label = width(render('label'));
    expect(label / a4).toBeCloseTo(0.375 / 0.3, 2);
    expect(label).toBeLessThan(PAPER.label.widthMm - 9);
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
