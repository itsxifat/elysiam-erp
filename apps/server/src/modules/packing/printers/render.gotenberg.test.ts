import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { code128Encode, poisha } from '@elysium/domain';
import { lotScanCode } from '@elysium/domain/packing';
import { beforeAll, describe, expect, it } from 'vitest';

import { decodeCode128Svg } from '../../../testing/code128-decode.js';
import { loadFonts } from '../../files/pdf/fonts.js';
import { GotenbergClient, type GotenbergAsset } from '../../files/pdf/gotenberg.client.js';
import {
  documentBarcodeValue,
  renderLabelHtml,
  renderPackingSlipHtml,
  type DocumentBrand,
  type OrderDocumentData,
} from '../../orders/order-documents.js';
import { SAMPLE_BRAND, SAMPLE_ORDER } from '../../orders/order-documents.sample.js';
import { encodePng } from './png.js';
import type { MonoBitmap } from './raster.js';
import { renderForPrinter, testPage, type PrinterPaper, type PrintPage } from './render.js';

/**
 * A lot's label and slip made ready for a thermal printer through the real Gotenberg (M46,
 * D-811): Chromium's screenshot at the printer's dots, thresholded to one bit, framed as TSPL.
 * The bitmap is the paper's size to the dot, carries ink where the page does, and its lot
 * barcode reads back off the dots as `261000004202`, the lot's twelve digits (D-912) — what the
 * handover scanner is given — on every row of the bars, and still with the bars printed a dot fat
 * or a dot thin. The bitmaps are written to `docs/review/M46/` to look at. Skipped, loudly,
 * without Gotenberg.
 *
 * The rows that read, at 203 dpi, shrunk to 96 % and on the slip shrunk onto the 4 × 6: before
 * D-912 (`ELY-2610-00042-L2`, a bar three dots on the label and under three on the slip) 72, 69
 * and 33 read as printed, every row the bars cover, and not one with a dot of print gain either
 * way; with the digits (six dots, five and a half on the slip) 72, 69 and 33 read both ways.
 *
 * Since D-917 the label carries no QR code: the digits-only bars are its one code, under the
 * consignment number in the label's biggest type, and the worst case (a two-line name, the
 * address at its four-line clamp, lot 12 of 20, a fourteen-character consignment number, a logo)
 * still fits one label with nothing pushed into its margins.
 */

/** The lot every page here is for, and what its bars carry. */
const LOT_DATA = { ...SAMPLE_ORDER, lot: { no: 2, count: 3 } };
const EXPECTED = lotScanCode(SAMPLE_ORDER.orderNo, 2) ?? '';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REVIEW_DIR = path.resolve(HERE, '../../../../../../docs/review/M46');
const client = new GotenbergClient(process.env.GOTENBERG_URL ?? 'http://localhost:3030');
let ready = false;

beforeAll(async () => {
  ready = await client.isReady();
  if (!ready) console.warn('render.gotenberg.test: Gotenberg is not running; skipped.');
});

/** The TSPL job's bitmap, read back (inverted again: in TSPL a 0 bit is a dot). */
function bitmapOfTspl(bytes: Uint8Array): MonoBitmap {
  const buffer = Buffer.from(bytes);
  const text = buffer.toString('latin1');
  const match = /BITMAP 0,0,(\d+),(\d+),0,/.exec(text);
  if (match === null) throw new Error('no BITMAP command');
  const widthBytes = Number(match[1]);
  const heightDots = Number(match[2]);
  const start = (match.index ?? 0) + match[0].length;
  const rows = Uint8Array.from(
    buffer.subarray(start, start + widthBytes * heightDots),
    (byte) => ~byte & 0xff,
  );
  return { widthBytes, widthDots: widthBytes * 8, heightDots, rows };
}

const dot = (bitmap: MonoBitmap, x: number, y: number) =>
  ((bitmap.rows[y * bitmap.widthBytes + (x >> 3)] ?? 0) & (0x80 >> (x & 7))) !== 0;

/**
 * Read a row of dots as a Code 128 symbol, as a scanner would: every run of dots measured in the
 * modules of the symbol `expected` makes (its own width, subset B or C alike: D-912) and rounded.
 * `spread` dots of print gain first grow every bar by that many dots on each side, the way a hot
 * or hazy head spreads its ink, or for a negative spread wear each one thin, the way a faded
 * ribbon or a cold head prints; a bar a whole number of dots wide reads through either only when
 * its modules are wide enough to absorb them.
 */
function decodeRow(bitmap: MonoBitmap, y: number, expected: string, spread = 0): string | null {
  const row = Array.from({ length: bitmap.widthDots }, (_, x) => dot(bitmap, x, y));
  const reach = Math.abs(spread);
  const inked = row.map((_, x) => {
    const near = row.slice(Math.max(0, x - reach), x + reach + 1);
    return spread >= 0 ? near.some(Boolean) : near.every(Boolean);
  });
  const runs: { black: boolean; width: number }[] = [];
  for (const black of inked) {
    const last = runs[runs.length - 1];
    if (last?.black === black) last.width += 1;
    else runs.push({ black, width: 1 });
  }
  const firstBar = runs.findIndex((run) => run.black);
  let lastBar = -1;
  runs.forEach((run, index) => {
    if (run.black) lastBar = index;
  });
  if (firstBar < 0) return null;
  const symbol = runs.slice(firstBar, lastBar + 1);
  const dots = symbol.reduce((sum, run) => sum + run.width, 0);
  const module = dots / code128Encode(expected).width;
  let x = 0;
  const rects: string[] = [];
  for (const run of symbol) {
    const modules = Math.max(1, Math.round(run.width / module));
    if (run.black) rects.push(`<rect x="${String(x)}" y="0" width="${String(modules)}"`);
    x += modules;
  }
  try {
    return decodeCode128Svg(rects.join(''));
  } catch {
    return null;
  }
}

/** The rows, every other one down the top half of the page, that read as `expected`. */
function rowsReading(bitmap: MonoBitmap, expected: string, spread = 0): number {
  let reads = 0;
  for (let y = 40; y < 600; y += 2) {
    if (decodeRow(bitmap, y, expected, spread) === expected) reads += 1;
  }
  return reads;
}

/** The rows that read with a dot of print gain either way: the fewer of the grown and the worn. */
function hazyRowsReading(bitmap: MonoBitmap, expected: string): number {
  return Math.min(rowsReading(bitmap, expected, 1), rowsReading(bitmap, expected, -1));
}

/** The 4 × 6 label at 203 dpi, and its padding (4.5 mm a side, 4 mm top and bottom) in dots. */
const LABEL_DOTS = { width: 812, height: 1218, padX: 36, padY: 32 } as const;

/** The inked dots in a box of the label, `x0` to `x1` and `y0` to `y1` (ends excluded). */
function inkIn(bitmap: MonoBitmap, x0: number, x1: number, y0: number, y1: number): number {
  let ink = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) if (dot(bitmap, x, y)) ink += 1;
  }
  return ink;
}

/** The lowest row of dots with any ink on the label's 812 dots. */
function lastInkedRow(bitmap: MonoBitmap): number {
  for (let y = bitmap.heightDots - 1; y >= 0; y -= 1) {
    if (inkIn(bitmap, 0, LABEL_DOTS.width, y, y + 1) > 0) return y;
  }
  return -1;
}

/** The dots as a picture to look at (black on white). */
function picture(bitmap: MonoBitmap): Uint8Array {
  const data = new Uint8Array(bitmap.widthDots * bitmap.heightDots);
  for (let y = 0; y < bitmap.heightDots; y += 1) {
    for (let x = 0; x < bitmap.widthDots; x += 1) {
      data[y * bitmap.widthDots + x] = dot(bitmap, x, y) ? 0 : 255;
    }
  }
  return encodePng({ width: bitmap.widthDots, height: bitmap.heightDots, channels: 1, data });
}

async function lotPage(
  kind: 'label' | 'slip',
  data: OrderDocumentData = LOT_DATA,
  brand: DocumentBrand = SAMPLE_BRAND,
  extra: readonly GotenbergAsset[] = [],
): Promise<PrintPage> {
  const fonts = await loadFonts();
  const html =
    kind === 'label'
      ? renderLabelHtml({ brand, data, fonts })
      : renderPackingSlipHtml({ brand, data, fonts, paper: 'a5' });
  const assets = [
    ...fonts.map((font) => ({
      filename: font.filename,
      bytes: font.bytes,
      contentType: 'font/woff2',
    })),
    ...extra,
  ];
  return kind === 'label'
    ? { html, assets, widthMm: 101.6, heightMm: 152.4, marginMm: 0 }
    : { html, assets, widthMm: 148, heightMm: 210, marginMm: 8 };
}

/**
 * The most a label has to hold (D-917): a name that takes two lines, an address long enough to be
 * cut at its four-line clamp, lot 12 of 20, Pathao's fourteen-character consignment number, a
 * six-figure amount to collect and the brand's logo. Made up, like the sample.
 */
const WORST_DATA: OrderDocumentData = {
  ...SAMPLE_ORDER,
  customerName: 'Mohammad Abdur Rahman Chowdhury Talukder',
  addressLine:
    'Flat 12C, Navana Tower Residential Complex, House 45/A, Road 16 (New), Block C, Bashundhara Residential Area, behind the Jamuna Future Park north gate, beside the green pharmacy, third floor, ring the bell twice',
  locality: 'Bashundhara, Vatara',
  district: 'Dhaka',
  codAmountPoisha: poisha(12_548_000n),
  courier: { name: 'Pathao', consignmentNo: 'DL121224VS8TFZ', trackingCode: null },
  lot: { no: 12, count: 20 },
};

/** A plain monogram standing in for a brand's logo, taller than the brand's name. */
const LOGO: GotenbergAsset = {
  filename: 'logo.svg',
  bytes: new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" rx="40" fill="#000"/></svg>',
  ),
  contentType: 'image/svg+xml',
};

const LABEL_203: PrinterPaper = {
  language: 'tspl',
  widthUm: 101_600,
  heightUm: 152_400,
  dpi: 203,
  copies: 1,
};

describe('a lot’s label and slip on a thermal printer (D-811)', () => {
  it('rasters the 4 × 6 label at 203 dpi to exactly 812 × 1218 dots, its lot barcode readable', async (context) => {
    if (!ready) context.skip();
    const page = await lotPage('label');
    const rendered = await renderForPrinter(client, page, {
      language: 'tspl',
      widthUm: 101_600,
      heightUm: 152_400,
      dpi: 203,
      copies: 1,
    });
    expect(rendered.format).toBe('raw');
    const bitmap = bitmapOfTspl(rendered.bytes);
    expect(bitmap.widthDots).toBe(816);
    expect(bitmap.heightDots).toBe(1218);
    let ink = 0;
    for (let y = 0; y < bitmap.heightDots; y += 1) {
      for (let x = 0; x < 812; x += 1) if (dot(bitmap, x, y)) ink += 1;
    }
    const share = ink / (812 * 1218);
    expect(share).toBeGreaterThan(0.03);
    expect(share).toBeLessThan(0.5);
    // In the top half, rows of dots read as the lot's twelve digits, all down the bars' 18 mm (144
    // dots, 72 rows of every other one: D-911), and so they do printed a dot fat or thin (D-912).
    await mkdir(REVIEW_DIR, { recursive: true });
    await writeFile(path.join(REVIEW_DIR, 'label-lot-2-of-3-tspl-203dpi.png'), picture(bitmap));
    expect(EXPECTED).toBe('261000004202');
    expect(documentBarcodeValue(LOT_DATA)).toBe(EXPECTED);
    expect(rowsReading(bitmap, EXPECTED)).toBeGreaterThanOrEqual(70);
    expect(hazyRowsReading(bitmap, EXPECTED)).toBeGreaterThanOrEqual(65);
    // D-917: the bars are the label's one code; no QR code is printed beside the order number.
    expect(page.html).not.toContain('data-qr');
  });

  it('keeps the bars readable shrunk to 96 %, as Chrome fits a PDF to a printable area (D-911)', async (context) => {
    if (!ready) context.skip();
    // The same 4 × 6 page drawn at 195 dpi on 203 dpi paper: every mark 96 % of its size, so no
    // bar or square falls on whole dots any more.
    const page = await lotPage('label');
    const rendered = await renderForPrinter(client, page, {
      language: 'tspl',
      widthUm: 101_600,
      heightUm: 152_400,
      dpi: 195,
      copies: 1,
    });
    const bitmap = bitmapOfTspl(rendered.bytes);
    await mkdir(REVIEW_DIR, { recursive: true });
    await writeFile(path.join(REVIEW_DIR, 'label-lot-2-of-3-shrunk-96.png'), picture(bitmap));
    // Every row of the shrunk bars (17.3 mm, 69 rows) reads, and with a dot's gain either way
    // (before D-912: 69 rows as printed, not one with the gain).
    expect(rowsReading(bitmap, EXPECTED)).toBeGreaterThanOrEqual(66);
    expect(hazyRowsReading(bitmap, EXPECTED)).toBeGreaterThanOrEqual(60);
  });

  it('fits the worst case on one label, nothing pushed into its margins (D-917)', async (context) => {
    if (!ready) context.skip();
    const brand = { ...SAMPLE_BRAND, logo: LOGO.filename };
    const sample = bitmapOfTspl(
      (await renderForPrinter(client, await lotPage('label', LOT_DATA, brand, [LOGO]), LABEL_203))
        .bytes,
    );
    const page = await lotPage('label', WORST_DATA, brand, [LOGO]);
    const worst = bitmapOfTspl((await renderForPrinter(client, page, LABEL_203)).bytes);
    expect(worst.heightDots).toBe(LABEL_DOTS.height);
    // What makes it the worst case, on the page as rendered.
    expect(page.html).toContain('Lot 12 of 20');
    expect(page.html).toContain('>DL121224VS8TFZ<');
    expect(page.html).toContain('Tk 125,480.00');
    // The cash box and the footer sit at the foot of the label whatever is above them: had the
    // name, the clamped address or the lot pushed them down, the last inked row would move and
    // ink would reach the bottom margin.
    const last = lastInkedRow(worst);
    expect(last).toBe(lastInkedRow(sample));
    expect(last).toBeLessThan(LABEL_DOTS.height - LABEL_DOTS.padY);
    // Nothing reaches the margins, a millimetre in from the content's edge: the consignment number
    // at its shrunk size fits the width, the brand's logo and the lot badge fit their rows.
    const { width, height, padX, padY } = LABEL_DOTS;
    const inset = 8;
    expect(inkIn(worst, 0, padX - inset, 0, height)).toBe(0);
    expect(inkIn(worst, width - padX + inset, width, 0, height)).toBe(0);
    expect(inkIn(worst, 0, width, 0, padY - inset)).toBe(0);
    expect(inkIn(worst, 0, width, height - padY + inset, height)).toBe(0);
    // And the bars still read: lot 12's twelve digits, a dot fat or thin.
    const lot12 = lotScanCode(SAMPLE_ORDER.orderNo, 12) ?? '';
    expect(lot12).toBe('261000004212');
    expect(rowsReading(worst, lot12)).toBeGreaterThanOrEqual(70);
    expect(hazyRowsReading(worst, lot12)).toBeGreaterThanOrEqual(65);
  });

  it('shrinks the A5 slip onto a 4 × 6 label printer and a test page onto 100 × 150 mm', async (context) => {
    if (!ready) context.skip();
    const slip = await renderForPrinter(client, await lotPage('slip'), {
      language: 'tspl',
      widthUm: 101_600,
      heightUm: 152_400,
      dpi: 203,
      copies: 1,
    });
    const slipBitmap = bitmapOfTspl(slip.bytes);
    expect(slipBitmap.heightDots).toBe(1218);
    // D-905: the slip's scan strip still reads, shrunk to two thirds on a 203 dpi head, on rows
    // all across its height (12 mm shrunk to 8.2, 33 rows) rather than on one lucky row; since
    // D-912 its 1 mm bars are five and a half dots there and read with a dot's gain either way too.
    expect(rowsReading(slipBitmap, EXPECTED)).toBeGreaterThanOrEqual(31);
    expect(hazyRowsReading(slipBitmap, EXPECTED)).toBeGreaterThanOrEqual(28);
    await mkdir(REVIEW_DIR, { recursive: true });
    await writeFile(path.join(REVIEW_DIR, 'slip-lot-2-of-3-on-4x6-tspl.png'), picture(slipBitmap));

    const test = await renderForPrinter(
      client,
      testPage({
        printerName: 'Label 1 · Xprinter',
        terminalName: 'Label 1',
        widthUm: 100_000,
        heightUm: 150_000,
        dpi: 300,
        at: '17/10/2026, 14:02:00',
      }),
      { language: 'zpl', widthUm: 100_000, heightUm: 150_000, dpi: 300, copies: 1 },
    );
    const text = Buffer.from(test.bytes).toString('latin1');
    expect(text.startsWith('^XA\n^PW1184\n^LL1772\n')).toBe(true);
  });

  it('makes a PDF at the printer’s paper for IPP and the browser station', async (context) => {
    if (!ready) context.skip();
    const rendered = await renderForPrinter(client, await lotPage('label'), {
      language: 'pdf',
      widthUm: 100_000,
      heightUm: 150_000,
      dpi: 203,
      copies: 1,
    });
    const text = Buffer.from(rendered.bytes).toString('latin1');
    expect(text.startsWith('%PDF-')).toBe(true);
    // 100 × 150 mm is 283.46 × 425.2 points (Chromium writes whole points).
    const box = /\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/.exec(text);
    expect(Math.abs(Number(box?.[1]) - 283.46)).toBeLessThan(1);
    expect(Math.abs(Number(box?.[2]) - 425.2)).toBeLessThan(1);
  });
});
