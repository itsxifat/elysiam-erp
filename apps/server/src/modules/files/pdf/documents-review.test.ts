import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { banglaCharactersIn, internalEan13, poisha, STICKER_MEDIA } from '@elysium/domain';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';

import { formatTakaLabel, renderStickersHtml } from '../../catalog/labels.service.js';
import { renderLabelsHtml, type LabelData } from '../../courier/labels.service.js';
import { renderPayslipHtml } from '../../hr/payslip.template.js';
import {
  PAPER,
  paperFor,
  renderBatchHtml,
  renderOrderDocumentHtml,
  type DocumentBrand,
} from '../../orders/order-documents.js';
import { SAMPLE_BRAND, SAMPLE_ORDER } from '../../orders/order-documents.sample.js';
import { orderLabelsHtml, type OrderLabel } from '../../packing/order-labels.js';
import { fontFaceCss, loadFonts, type FontFile } from './fonts.js';
import { GotenbergClient, type GotenbergAsset } from './gotenberg.client.js';

/**
 * Every document the system prints, through the real Gotenberg (M43 checks 1, 2 and 4).
 *
 * For each: the page is English (no character of the Bengali block, U+0980 to U+09FF), the
 * PDF's every page is the exact paper size (read back from its `/MediaBox`, in points), the
 * page count is right (a long address does not spill a label onto a second page), Inter is
 * the embedded face, and page 1 is rasterised to `docs/review/M43/` for the owner to look at.
 *
 * The PNG is the same HTML, the same fonts and the same Chromium as the PDF, through
 * Gotenberg's screenshot route at twice the page's size (`zoom: 2`), with the margin the PDF
 * prints inside added as padding, so the picture is the page. Skipped, loudly, when Gotenberg
 * is not running: the content checks in `order-documents.test.ts` never are.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REVIEW_DIR = path.resolve(HERE, '../../../../../../docs/review/M43');
const PT_PER_MM = 72 / 25.4;
const PX_PER_MM = 96 / 25.4;

interface Sheet {
  /** The PNG's name in `docs/review/M43/`. */
  readonly name: string;
  readonly html: string;
  readonly widthMm: number;
  readonly heightMm: number;
  /** The margin Gotenberg prints inside the page; the page's own padding when zero. */
  readonly marginMm: number;
  readonly pages: number;
  readonly assets?: readonly GotenbergAsset[];
  /** How much larger than the page the PNG is drawn. */
  readonly zoom?: number;
}

/** Every page's MediaBox, in points. Chromium writes page dictionaries uncompressed. */
function mediaBoxes(pdf: Uint8Array): number[][] {
  const text = Buffer.from(pdf).toString('latin1');
  return [...text.matchAll(/\/MediaBox\s*\[\s*([-\d.\s]+)\]/g)].map((match) =>
    (match[1] ?? '').trim().split(/\s+/).map(Number),
  );
}

function pageCount(pdf: Uint8Array): number {
  return [
    ...Buffer.from(pdf)
      .toString('latin1')
      .matchAll(/\/Type\s*\/Page(?![s\w])/g),
  ].length;
}

/** The page as the PDF prints it: its margin as padding, drawn `zoom` times larger. */
function screenshotHtml(sheet: Sheet, zoom: number): string {
  const css = `<style>html { zoom: ${String(zoom)}; } body { padding: ${String(sheet.marginMm)}mm; }</style>`;
  return sheet.html.replace('</head>', `${css}</head>`);
}

const client = new GotenbergClient(process.env.GOTENBERG_URL ?? 'http://localhost:3030');
let ready = false;
let fonts: readonly FontFile[] = [];
let logo: GotenbergAsset | null = null;

beforeAll(async () => {
  ready = await client.isReady();
  fonts = await loadFonts(process.env.PDF_FONT_DIR);
  // A plain monogram standing in for a brand's uploaded logo, so the screenshots show where a
  // logo goes; real logos are the website's stored image (D-754).
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" rx="40" fill="#111"/><text x="120" y="160" font-family="sans-serif" font-size="150" font-weight="700" fill="#fff" text-anchor="middle">E</text></svg>`;
  logo = {
    filename: 'logo.png',
    bytes: new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer()),
    contentType: 'image/png',
  };
});

function fontAssets(): GotenbergAsset[] {
  return fonts.map((font) => ({
    filename: font.filename,
    bytes: font.bytes,
    contentType: 'font/woff2',
  }));
}

function sheets(): Sheet[] {
  const brand: DocumentBrand = { ...SAMPLE_BRAND, logo: 'logo.png' };
  const withLogo = logo === null ? [] : [logo];
  const order = (kind: 'invoice' | 'packing_slip' | 'label', paper: 'a4' | 'a5' = 'a4') =>
    renderOrderDocumentHtml(kind, brand, SAMPLE_ORDER, fonts, paper);

  const courierLabel: LabelData = {
    brandName: SAMPLE_BRAND.displayName,
    courierName: 'Steadfast',
    consignmentNo: '127403991',
    trackingCode: 'SFR2610ELY42',
    orderNo: SAMPLE_ORDER.orderNo,
    recipientName: SAMPLE_ORDER.customerName,
    recipientPhone: SAMPLE_ORDER.customerPhone,
    addressLine: SAMPLE_ORDER.addressLine,
    area: 'Dhanmondi',
    thana: 'Dhanmondi',
    district: 'Dhaka',
    codAmountPoisha: 846_000n,
    note: 'Call before delivery.',
  };

  const qrLabel: OrderLabel = {
    shopName: SAMPLE_BRAND.displayName,
    merchantId: 'SF-104233',
    orderNo: SAMPLE_ORDER.orderNo,
    date: '11/10/2026',
    scan: 'SFR2610ELY42',
    consignmentNo: '127403991',
    recipientName: SAMPLE_ORDER.customerName,
    recipientPhone: SAMPLE_ORDER.customerPhone,
    address: `${SAMPLE_ORDER.addressLine}, Dhanmondi, Dhaka`,
    subtotal: 'Tk 8,895.00',
    discount: 'Tk 295.00',
    delivery: 'Tk 60.00',
    collect: 'Tk 8,460.00',
    total: 'Tk 8,660.00',
    paymentWords: 'Cash on delivery (Tk 200.00 paid in advance)',
  };

  const payslip = renderPayslipHtml({
    brand: {
      displayName: SAMPLE_BRAND.displayName,
      legalName: SAMPLE_BRAND.legalName,
      address: SAMPLE_BRAND.address ?? undefined,
    },
    data: {
      month: '2026-09',
      employeeCode: 'EMP-0042',
      employeeName: 'Farhana Akter',
      designation: 'Senior packer',
      joinDate: '2025-03-01',
      workingDays: 26,
      presentDays: 24,
      absentDays: 1,
      halfDays: 1,
      earnings: [
        { label: 'Basic', amountPoisha: poisha(1_800_000n) },
        { label: 'House rent', amountPoisha: poisha(720_000n) },
        { label: 'Conveyance', amountPoisha: poisha(150_000n) },
        { label: 'Target bonus', amountPoisha: poisha(250_000n) },
      ],
      deductions: [
        { label: 'Absence (1 day)', amountPoisha: poisha(69_231n) },
        { label: 'Loan instalment', amountPoisha: poisha(200_000n) },
      ],
      grossPoisha: poisha(2_920_000n),
      deductionsPoisha: poisha(269_231n),
      netPoisha: poisha(2_650_769n),
      loanShortfallPoisha: poisha(0n),
      runStatus: 'paid',
      paidOn: '2026-10-05',
    },
    fonts,
  });

  const stickers = renderStickersHtml({
    stickers: [
      {
        barcode: internalEan13(42),
        code: 'ELY-PNJ-0012-M-NVY',
        productName: 'Linen Panjabi',
        variantLabel: 'M / Navy',
        priceText: formatTakaLabel('245000'),
        brand: SAMPLE_BRAND.displayName,
      },
    ],
    medium: STICKER_MEDIA['thermal-38x25'],
    startAt: 1,
    fontCss: fontFaceCss(fonts),
  });

  return [
    { name: 'invoice-a4', html: order('invoice'), ...PAPER.a4, pages: 1, assets: withLogo },
    {
      name: 'packing-slip-a4',
      html: order('packing_slip'),
      ...PAPER.a4,
      pages: 1,
      assets: withLogo,
    },
    {
      name: 'packing-slip-a5',
      html: order('packing_slip', 'a5'),
      ...PAPER.a5,
      pages: 1,
      assets: withLogo,
    },
    { name: 'parcel-label-4x6', html: order('label'), ...PAPER.label, pages: 1, assets: withLogo },
    {
      name: 'packing-slips-batch-a5',
      html: renderBatchHtml({
        kind: 'packing_slip',
        brand,
        documents: [SAMPLE_ORDER, { ...SAMPLE_ORDER, orderNo: 'ELY-2610-00043' }],
        fonts,
        paper: 'a5',
      }),
      ...PAPER.a5,
      pages: 2,
      assets: withLogo,
    },
    {
      name: 'courier-label-4x6',
      html: renderLabelsHtml({ labels: [courierLabel], fonts }),
      widthMm: 101.6,
      heightMm: 152.4,
      marginMm: 0,
      pages: 1,
    },
    {
      name: 'qr-label-sheet-4x6',
      html: orderLabelsHtml({
        labels: [qrLabel],
        options: {
          size: '4x6',
          layout: 'portrait',
          showShopName: true,
          showQr: true,
          showPrices: true,
          showCod: true,
        },
        fonts,
      }),
      widthMm: 101.6,
      heightMm: 152.4,
      marginMm: 0,
      pages: 1,
    },
    { name: 'payslip-a4', html: payslip, ...PAPER.a4, pages: 1 },
    {
      name: 'sticker-38x25',
      html: stickers,
      widthMm: 38,
      heightMm: 25,
      marginMm: 0,
      pages: 1,
      zoom: 6,
    },
  ];
}

describe('every printed document (M43)', () => {
  it('is English: no character of the Bengali block on any page', () => {
    for (const sheet of sheets()) {
      expect(banglaCharactersIn(sheet.html), sheet.name).toEqual([]);
      expect(sheet.html, sheet.name).toMatch(/<html lang="en">/);
      expect(sheet.html, sheet.name).not.toMatch(/Hind Siliguri|hind-siliguri/);
    }
  });

  it('prints at its exact paper size, page for page, in Inter, and is pictured for review', async () => {
    if (!ready) {
      console.warn(
        'Gotenberg is not reachable. Start it with ' +
          '`docker compose -f infra/docker-compose.dev.yml up -d gotenberg` to check the page ' +
          'sizes and regenerate docs/review/M43/.',
      );
      expect(ready).toBe(false);
      return;
    }
    await mkdir(REVIEW_DIR, { recursive: true });

    for (const sheet of sheets()) {
      const assets = [...fontAssets(), ...(sheet.assets ?? [])];
      const pdf = await client.renderPdf({
        html: sheet.html,
        assets,
        paperWidth: Math.round((sheet.widthMm / 25.4) * 1e6) / 1e6,
        paperHeight: Math.round((sheet.heightMm / 25.4) * 1e6) / 1e6,
        marginInches: sheet.marginMm / 25.4,
      });
      expect(Buffer.from(pdf.subarray(0, 5)).toString('latin1'), sheet.name).toBe('%PDF-');
      expect(pageCount(pdf), `${sheet.name} pages`).toBe(sheet.pages);
      const boxes = mediaBoxes(pdf);
      expect(boxes.length, `${sheet.name} media boxes`).toBeGreaterThanOrEqual(sheet.pages);
      // Exact to Chromium's print grid, which steps a page in 1/75 inch (0.96 pt): A4 comes
      // out 595.92 × 841.92 pt against ISO's 595.28 × 841.89, A5 420 × 595.92, and 4 × 6 in
      // exactly 288 × 432. Under a point either way, as the sticker suite holds its sizes.
      for (const box of boxes) {
        const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = box;
        expect(Math.abs(x1 - x0 - sheet.widthMm * PT_PER_MM), `${sheet.name} width`).toBeLessThan(
          1,
        );
        expect(Math.abs(y1 - y0 - sheet.heightMm * PT_PER_MM), `${sheet.name} height`).toBeLessThan(
          1,
        );
      }
      // The embedded face is Inter: a PDF that looks right here and carries no font of its
      // own renders in whatever the reader's machine has.
      expect(Buffer.from(pdf).toString('latin1'), `${sheet.name} font`).toMatch(/Inter/);

      const zoom = sheet.zoom ?? 2;
      const png = await client.screenshotPng({
        html: screenshotHtml(sheet, zoom),
        assets,
        width: Math.round(sheet.widthMm * PX_PER_MM * zoom),
        height: Math.round(sheet.heightMm * PX_PER_MM * zoom),
        fullPage: false,
      });
      expect(Buffer.from(png.subarray(1, 4)).toString('latin1')).toBe('PNG');
      await writeFile(path.join(REVIEW_DIR, `${sheet.name}.png`), png);
    }
  }, 240_000);

  it('uses the same paper the services hand Gotenberg', () => {
    expect(paperFor('invoice').paperWidth).toBeCloseTo(PAPER.a4.widthMm / 25.4, 5);
    expect(paperFor('packing_slip', 'a5').paperHeight).toBeCloseTo(PAPER.a5.heightMm / 25.4, 5);
    expect(paperFor('label')).toMatchObject({ paperWidth: 4, paperHeight: 6 });
  });
});
