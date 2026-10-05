import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STICKER_MEDIA,
  STICKER_MEDIA_IDS,
  internalEan13,
  stickerPageSize,
  type StickerMedium,
} from '@elysium/domain';
import { beforeAll, describe, expect, it } from 'vitest';

import { GotenbergClient } from '../files/pdf/gotenberg.client.js';
import { fontFaceCss, loadFonts } from '../files/pdf/fonts.js';
import { formatTakaLabel, renderStickersHtml, type StickerData } from './labels.service.js';

/**
 * Stickers (M38a, D-604; acceptance check 3): the layout, and the PDF's exact page size for
 * every medium, rendered by the real Gotenberg.
 *
 * The page size is read back from the PDF itself: every `/MediaBox` is the page in points
 * (1/72 inch). A roll's page must be the sticker's size, because the printer driver feeds one
 * label per page; a sheet's must be A4. Rendered page counts are checked too: a roll prints
 * exactly one sticker a page, so N stickers are N pages and never a blank one between them.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REVIEW_DIR = path.resolve(HERE, '../../../../../docs/review/M38a');

function sticker(index: number, overrides: Partial<StickerData> = {}): StickerData {
  return {
    barcode: internalEan13(index + 1),
    code: `ELY-PNJ-0042-${['M', 'L', 'XL'][index % 3] ?? 'M'}-WHT`,
    productName: 'Linen Panjabi with a long name that has to be cut',
    variantLabel: `${['M', 'L', 'XL'][index % 3] ?? 'M'} / White`,
    priceText: formatTakaLabel('245000'),
    brand: 'Brand Name',
    ...overrides,
  };
}

/** Every page's MediaBox, in points. Chromium writes page dictionaries uncompressed. */
function mediaBoxes(pdf: Uint8Array): number[][] {
  const text = Buffer.from(pdf).toString('latin1');
  return [...text.matchAll(/\/MediaBox\s*\[\s*([-\d.\s]+)\]/g)].map((match) =>
    (match[1] ?? '').trim().split(/\s+/).map(Number),
  );
}

function pageCount(pdf: Uint8Array): number {
  const text = Buffer.from(pdf).toString('latin1');
  return [...text.matchAll(/\/Type\s*\/Page(?![s\w])/g)].length;
}

const MM_TO_PT = 72 / 25.4;

describe('sticker layout', () => {
  it('puts one sticker per page on a roll and skips used positions on a sheet', () => {
    const roll = renderStickersHtml({
      stickers: [0, 1, 2].map((index) => sticker(index)),
      medium: STICKER_MEDIA['thermal-38x25'],
      startAt: 1,
      fontCss: '',
    });
    expect([...roll.matchAll(/<section class="page">/g)]).toHaveLength(3);
    expect(roll).toContain('@page { size: 38mm 25mm; margin: 0; }');

    const sheet = renderStickersHtml({
      stickers: Array.from({ length: 30 }, (_, index) => sticker(index)),
      medium: STICKER_MEDIA['a4-4x10'],
      startAt: 15,
      fontCss: '',
    });
    // 14 used positions + 30 stickers = 44 slots: two pages of 40.
    expect([...sheet.matchAll(/<section class="page">/g)]).toHaveLength(2);
    expect([...sheet.matchAll(/class="cell"/g)]).toHaveLength(30);
    // Position 15 on a 4-wide sheet is row 4, column 3.
    const first = /class="cell" style="left:([\d.]+)mm;top:([\d.]+)mm"/.exec(sheet);
    expect(Number(first?.[1])).toBeCloseTo(8 + 2 * 48.5, 3);
    expect(Number(first?.[2])).toBeCloseTo(21.5 + 3 * 25.4, 3);
  });

  it('prints the barcode as EAN-13 with its digits, and a non-EAN code as Code 128', () => {
    const html = renderStickersHtml({
      stickers: [sticker(0), sticker(1, { barcode: null, code: 'ELY-PNJ-0042-M' })],
      medium: STICKER_MEDIA['a4-3x8'],
      startAt: 1,
      fontCss: '',
    });
    expect(html).toContain(`aria-label="${internalEan13(1)}"`);
    expect([...html.matchAll(/<text /g)]).toHaveLength(13);
    expect(html).toContain('aria-label="ELY-PNJ-0042-M"');
    expect(html).toContain('৳2,450');
    expect(html).toContain('M / White');
  });

  it('leaves the price off when not asked, and never names a brand of its own', () => {
    const html = renderStickersHtml({
      stickers: [sticker(0, { priceText: null, brand: 'Any Brand' })],
      medium: STICKER_MEDIA['thermal-40x30'],
      startAt: 1,
      fontCss: '',
    });
    expect(html).not.toContain('৳');
    expect(html).toContain('Any Brand');
    expect(html).not.toMatch(/elysium/i);
  });
});

describe('sticker PDFs have the exact page size for every medium (check 3)', () => {
  const client = new GotenbergClient(process.env.GOTENBERG_URL ?? 'http://localhost:3030');
  let ready = false;

  beforeAll(async () => {
    ready = await client.isReady();
  });

  async function render(medium: StickerMedium, count: number, startAt = 1) {
    const fonts = await loadFonts(process.env.PDF_FONT_DIR);
    const spec = STICKER_MEDIA[medium];
    const page = stickerPageSize(spec);
    const html = renderStickersHtml({
      stickers: Array.from({ length: count }, (_, index) => sticker(index)),
      medium: spec,
      startAt,
      fontCss: fontFaceCss(fonts),
    });
    const assets = fonts.map((font) => ({
      filename: font.filename,
      bytes: font.bytes,
      contentType: 'font/woff2',
    }));
    const pdf = await client.renderPdf({
      html,
      assets,
      paperWidth: page.widthMm / 25.4,
      paperHeight: page.heightMm / 25.4,
      marginInches: 0,
    });
    return { pdf, html, assets, page };
  }

  for (const medium of STICKER_MEDIA_IDS) {
    it(`renders ${medium} at its page size`, async () => {
      if (!ready) {
        console.warn('Gotenberg is not reachable; start the dev stack to check sticker PDFs.');
        expect(ready).toBe(false);
        return;
      }
      const spec = STICKER_MEDIA[medium];
      const count = spec.kind === 'roll' ? 5 : 45;
      const { pdf, page } = await render(medium, count);
      expect(Buffer.from(pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-');

      const expectedPages =
        spec.kind === 'roll' ? count : Math.ceil(count / (spec.columns * spec.rows));
      expect(pageCount(pdf)).toBe(expectedPages);

      const boxes = mediaBoxes(pdf);
      expect(boxes.length).toBeGreaterThanOrEqual(1);
      for (const box of boxes) {
        const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = box;
        // Within one point (0.35 mm) of the medium's size. Chromium stores a page size on its
        // own grid (1/300 inch), so 38 × 25 mm comes out 108 × 71.04 pt where the exact figure
        // is 107.72 × 70.87: 0.1 mm over, which no label printer feels. Measured, D-604.
        expect(Math.abs(x1 - x0 - page.widthMm * MM_TO_PT)).toBeLessThan(1);
        expect(Math.abs(y1 - y0 - page.heightMm * MM_TO_PT)).toBeLessThan(1);
      }
    }, 60_000);
  }

  it('keeps the used positions blank on a half-used sheet', async () => {
    if (!ready) {
      expect(ready).toBe(false);
      return;
    }
    // 30 used + 12 new = 42 slots: two A4 pages of 40.
    const { pdf } = await render('a4-4x10', 12, 31);
    expect(pageCount(pdf)).toBe(2);
  }, 60_000);

  it('writes review images of a roll sticker and an A4 sheet', async () => {
    if (!ready) {
      expect(ready).toBe(false);
      return;
    }
    mkdirSync(REVIEW_DIR, { recursive: true });
    for (const [medium, count, width, height, name] of [
      ['thermal-38x25', 1, 144, 95, 'sticker-thermal-38x25.png'],
      ['thermal-50x25', 1, 189, 95, 'sticker-thermal-50x25.png'],
      ['a4-3x8', 8, 794, 1123, 'sticker-sheet-a4-3x8.png'],
    ] as const) {
      const { html, assets } = await render(medium, count);
      // 3× the CSS pixels for a roll, so the bars are legible in the review image.
      const scale = medium.startsWith('thermal') ? 3 : 1;
      const png = await client.screenshotPng({
        html: html.replace('<body>', `<body style="zoom:${String(scale)}">`),
        assets,
        width: width * scale,
        height: height * scale,
      });
      writeFileSync(path.join(REVIEW_DIR, name), png);
    }
  }, 120_000);
});
