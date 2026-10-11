import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  banglaCharactersIn,
  STICKER_MEDIA,
  STICKER_MEDIA_IDS,
  StickerLayoutError,
  customStickerMedium,
  internalEan13,
  stickerPageSize,
  type StickerMediumSpec,
} from '@elysium/domain';
import { beforeAll, describe, expect, it } from 'vitest';

import type { ActiveContext } from '../../platform/http/context.js';
import { GotenbergClient } from '../files/pdf/gotenberg.client.js';
import { fontFaceCss, loadFonts } from '../files/pdf/fonts.js';
import type { CatalogApi } from './catalog.api.js';
import { CatalogError } from './catalog.errors.js';
import { labelSheetSchema } from './catalog.schemas.js';
import {
  LabelsService,
  formatTakaLabel,
  mediumOf,
  renderStickersHtml,
  type StickerData,
} from './labels.service.js';

/**
 * Stickers (M38a, D-604; acceptance check 3; 45 × 35, the custom size and the extra line,
 * D-650 and D-651): the layout, and the PDF's exact page size for every medium and a custom
 * size, rendered by the real Gotenberg.
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
    // `Tk 1,490` on a tag (D-751): whole taka, no Bangla-block sign.
    expect(html).toContain('Tk 2,450');
    expect(banglaCharactersIn(html)).toEqual([]);
    expect(html).toContain('M / White');
  });

  it('leaves the price off when not asked, and never names a brand of its own', () => {
    const html = renderStickersHtml({
      stickers: [sticker(0, { priceText: null, brand: 'Any Brand' })],
      medium: STICKER_MEDIA['thermal-40x30'],
      startAt: 1,
      fontCss: '',
    });
    expect(html).not.toContain('Tk ');
    expect(html).toContain('Any Brand');
    expect(html).not.toMatch(/elysium/i);
  });
});

describe('the custom size and the extra line (D-650, D-651)', () => {
  const custom = (widthMm: number, heightMm: number) => ({
    items: [{ skuId: '00000000-0000-4000-8000-000000000001', copies: 1 }],
    medium: 'custom',
    widthMm,
    heightMm,
  });

  it('takes a custom size in range, to one decimal, and only with the custom medium', () => {
    const parsed = labelSheetSchema.safeParse(custom(32.5, 20));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const medium = mediumOf(parsed.data);
      expect(medium).toMatchObject({ kind: 'roll', labelWidthMm: 32.5, labelHeightMm: 20 });
      expect(stickerPageSize(medium)).toEqual({ widthMm: 32.5, heightMm: 20 });
    }
    expect(labelSheetSchema.safeParse(custom(110, 100)).success).toBe(true);
    expect(labelSheetSchema.safeParse({ ...custom(25, 15), medium: 'thermal-45x35' }).success).toBe(
      false,
    );
    expect(
      labelSheetSchema.safeParse({ items: custom(1, 1).items, medium: 'thermal-45x35' }).success,
    ).toBe(true);
  });

  it('refuses a size out of range, with two decimals, or missing, and a long extra line', () => {
    for (const [width, height] of [
      [24.9, 20],
      [110.1, 20],
      [40, 14.9],
      [40, 100.5],
      [32.55, 20],
      [Number.NaN, 20],
    ] as const) {
      const parsed = labelSheetSchema.safeParse(custom(width, height));
      expect(parsed.success, `${String(width)} x ${String(height)}`).toBe(false);
    }
    const { heightMm: _height, ...noHeight } = custom(40, 30);
    expect(labelSheetSchema.safeParse(noHeight).success).toBe(false);
    expect(
      labelSheetSchema.safeParse({ ...custom(40, 30), extraLine: 'x'.repeat(41) }).success,
    ).toBe(false);
    expect(
      labelSheetSchema.safeParse({ ...custom(40, 30), extraLine: 'Made in\nBangladesh' }).success,
    ).toBe(false);
    expect(
      labelSheetSchema.safeParse({ ...custom(40, 30), extraLine: 'Made in Bangladesh' }).success,
    ).toBe(true);
  });

  it('refuses a size in range that cannot hold a scannable barcode, with a typed error', async () => {
    // 27 mm is in range but under the 29.25 mm a 0.25 mm EAN-13 needs with its quiet zones.
    expect(() =>
      renderStickersHtml({
        stickers: [sticker(0)],
        medium: customStickerMedium(27, 20),
        startAt: 1,
        fontCss: '',
      }),
    ).toThrow(StickerLayoutError);

    // The service refuses before it reads anything: no database, no renderer needed.
    const untouched = new Proxy(
      {},
      {
        get: () => {
          throw new Error('nothing should be read for a size that cannot print');
        },
      },
    );
    const service = new LabelsService(untouched as GotenbergClient, untouched as CatalogApi);
    const input = labelSheetSchema.parse({ ...custom(27, 20), showPrice: true });
    const refused = await service
      .sheetPdf({ orgId: 'org', userId: 'user' } as unknown as ActiveContext, input)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CatalogError);
    expect((refused as CatalogError).code).toBe('CATALOG_LABELS_INVALID');
    expect((refused as CatalogError).message).toMatch(/at least 29\.3 mm wide/);
  });

  it('prints the extra line on every sticker, escaped, and gives it up first when short of room', () => {
    const roomy = renderStickersHtml({
      stickers: [sticker(0), sticker(1)],
      medium: STICKER_MEDIA['thermal-45x35'],
      startAt: 1,
      fontCss: '',
      extraLine: '  Made in <Bangladesh>  ',
    });
    expect([...roomy.matchAll(/class="row extra"/g)]).toHaveLength(2);
    expect(roomy).toContain('Made in &lt;Bangladesh&gt;');
    expect(roomy).toContain('@page { size: 45mm 35mm; margin: 0; }');

    const tight = renderStickersHtml({
      stickers: [sticker(0)],
      medium: customStickerMedium(32.5, 20),
      startAt: 1,
      fontCss: '',
      extraLine: 'SS26',
    });
    expect(tight).not.toContain('class="row extra"');
    expect(tight).toContain(`aria-label="${internalEan13(1)}"`);
    expect(tight).toContain('Tk 2,450');

    const blank = renderStickersHtml({
      stickers: [sticker(0)],
      medium: STICKER_MEDIA['thermal-38x25'],
      startAt: 1,
      fontCss: '',
      extraLine: '   ',
    });
    expect(blank).not.toContain('class="row extra"');
  });
});

describe('sticker PDFs have the exact page size for every medium (check 3)', () => {
  const client = new GotenbergClient(process.env.GOTENBERG_URL ?? 'http://localhost:3030');
  let ready = false;

  beforeAll(async () => {
    ready = await client.isReady();
  });

  async function render(
    spec: StickerMediumSpec,
    count: number,
    startAt = 1,
    extraLine: string | null = null,
  ) {
    const fonts = await loadFonts(process.env.PDF_FONT_DIR);
    const page = stickerPageSize(spec);
    const html = renderStickersHtml({
      stickers: Array.from({ length: count }, (_, index) => sticker(index)),
      medium: spec,
      startAt,
      fontCss: fontFaceCss(fonts),
      extraLine,
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
    it(`renders ${medium} at its page size`, async (context) => {
      // Skipped, and counted as skipped, when Gotenberg is down: this is acceptance check 3,
      // and a pass that rendered nothing would claim a page size nobody measured.
      if (!ready) {
        console.warn('Gotenberg is not reachable; start the dev stack to check sticker PDFs.');
        context.skip();
        return;
      }
      const spec = STICKER_MEDIA[medium];
      const count = spec.kind === 'roll' ? 5 : 45;
      const { pdf, page } = await render(spec, count);
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

  it('keeps the used positions blank on a half-used sheet', async (context) => {
    if (!ready) {
      context.skip();
      return;
    }
    // 30 used + 12 new = 42 slots: two A4 pages of 40.
    const { pdf } = await render(STICKER_MEDIA['a4-4x10'], 12, 31);
    expect(pageCount(pdf)).toBe(2);
  }, 60_000);

  it('renders a custom 32.5 × 20 mm sticker at exactly that size, one a page (D-650)', async (context) => {
    if (!ready) {
      context.skip();
      return;
    }
    const { pdf } = await render(customStickerMedium(32.5, 20), 4, 1, 'Made in Bangladesh');
    expect(Buffer.from(pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(pageCount(pdf)).toBe(4);
    const boxes = mediaBoxes(pdf);
    expect(boxes.length).toBeGreaterThanOrEqual(1);
    for (const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] of boxes) {
      // 32.5 × 20 mm is 92.13 × 56.69 pt; within a point, as for the fixed rolls (D-604).
      expect(Math.abs(x1 - x0 - 32.5 * MM_TO_PT)).toBeLessThan(1);
      expect(Math.abs(y1 - y0 - 20 * MM_TO_PT)).toBeLessThan(1);
    }
  }, 60_000);

  it('writes review images of a roll sticker and an A4 sheet', async (context) => {
    if (!ready) {
      context.skip();
      return;
    }
    mkdirSync(REVIEW_DIR, { recursive: true });
    const shots: [StickerMediumSpec, number, number, number, string, string | null][] = [
      [STICKER_MEDIA['thermal-38x25'], 1, 144, 95, 'sticker-thermal-38x25.png', null],
      [STICKER_MEDIA['thermal-50x25'], 1, 189, 95, 'sticker-thermal-50x25.png', null],
      // 45 × 35 mm (D-650) with an extra line (D-651): 170 × 132 CSS pixels.
      [
        STICKER_MEDIA['thermal-45x35'],
        1,
        170,
        132,
        'sticker-thermal-45x35.png',
        'Made in Bangladesh',
      ],
      // A custom 32.5 × 20 mm sticker: 123 × 76 CSS pixels.
      [customStickerMedium(32.5, 20), 1, 123, 76, 'sticker-custom-32x20.png', null],
      [STICKER_MEDIA['a4-3x8'], 8, 794, 1123, 'sticker-sheet-a4-3x8.png', null],
    ];
    for (const [spec, count, width, height, name, extraLine] of shots) {
      const { html, assets } = await render(spec, count, 1, extraLine);
      // 3× the CSS pixels for a roll, so the bars are legible in the review image.
      const scale = spec.kind === 'roll' ? 3 : 1;
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
