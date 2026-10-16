import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { lotCode } from '@elysium/domain/packing';
import { beforeAll, describe, expect, it } from 'vitest';

import { decodeCode128Svg } from '../../../testing/code128-decode.js';
import { loadFonts } from '../../files/pdf/fonts.js';
import { GotenbergClient } from '../../files/pdf/gotenberg.client.js';
import { renderLabelHtml, renderPackingSlipHtml } from '../../orders/order-documents.js';
import { SAMPLE_BRAND, SAMPLE_ORDER } from '../../orders/order-documents.sample.js';
import { encodePng } from './png.js';
import type { MonoBitmap } from './raster.js';
import { renderForPrinter, testPage, type PrintPage } from './render.js';

/**
 * A lot's label and slip made ready for a thermal printer through the real Gotenberg (M46,
 * D-811): Chromium's screenshot at the printer's dots, thresholded to one bit, framed as TSPL.
 * The bitmap is the paper's size to the dot, carries ink where the page does, and its lot
 * barcode reads back off the dots as `ELY-2610-00042-L2` — what the handover scanner is given.
 * The bitmaps are written to `docs/review/M46/` to look at. Skipped, loudly, without Gotenberg.
 */

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
  const rows = Uint8Array.from(buffer.subarray(start, start + widthBytes * heightDots), (byte) => ~byte & 0xff);
  return { widthBytes, widthDots: widthBytes * 8, heightDots, rows };
}

const dot = (bitmap: MonoBitmap, x: number, y: number) =>
  ((bitmap.rows[y * bitmap.widthBytes + (x >> 3)] ?? 0) & (0x80 >> (x & 7))) !== 0;

/** Read a row of dots as a Code 128 symbol of `length` characters, as a scanner would. */
function decodeRow(bitmap: MonoBitmap, y: number, length: number): string | null {
  const runs: { black: boolean; width: number }[] = [];
  for (let x = 0; x < bitmap.widthDots; x += 1) {
    const black = dot(bitmap, x, y);
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
  const module = dots / (11 * length + 35);
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

async function lotPage(kind: 'label' | 'slip'): Promise<PrintPage> {
  const fonts = await loadFonts();
  const data = { ...SAMPLE_ORDER, lot: { no: 2, count: 3 } };
  const html =
    kind === 'label'
      ? renderLabelHtml({ brand: SAMPLE_BRAND, data, fonts })
      : renderPackingSlipHtml({ brand: SAMPLE_BRAND, data, fonts, paper: 'a5' });
  const assets = fonts.map((font) => ({
    filename: font.filename,
    bytes: font.bytes,
    contentType: 'font/woff2',
  }));
  return kind === 'label'
    ? { html, assets, widthMm: 101.6, heightMm: 152.4, marginMm: 0 }
    : { html, assets, widthMm: 148, heightMm: 210, marginMm: 8 };
}

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
    // Somewhere in the top quarter a row of dots reads as the lot's code.
    const expected = lotCode(SAMPLE_ORDER.orderNo, 2);
    let read: string | null = null;
    for (let y = 40; y < 320 && read === null; y += 2) {
      const decoded = decodeRow(bitmap, y, expected.length);
      if (decoded !== null) read = decoded;
    }
    expect(read).toBe(expected);
    await mkdir(REVIEW_DIR, { recursive: true });
    await writeFile(path.join(REVIEW_DIR, 'label-lot-2-of-3-tspl-203dpi.png'), picture(bitmap));
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
