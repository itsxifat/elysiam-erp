import { Inject, Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import {
  code128Encode,
  code128Svg,
  CODE128_QUIET_MODULES,
  EAN13_TOTAL_MODULES,
  ean13Svg,
  fitStickerText,
  isValidEan13,
  MAX_STICKERS_PER_PDF,
  poisha,
  STICKER_MEDIA,
  StickerLayoutError,
  stickerPageSize,
  stickerPages,
  takaParts,
  type StickerMediumSpec,
} from '@elysium/domain';

import type { ActiveContext } from '../../platform/http/context.js';
import { GotenbergClient } from '../files/pdf/gotenberg.client.js';
import { loadFonts, fontFaceCss } from '../files/pdf/fonts.js';
import { CATALOG_API, type CatalogApi } from './catalog.api.js';
import { CatalogError } from './catalog.errors.js';
import * as repo from './catalog.repository.js';
import type { LabelSheetInput } from './catalog.schemas.js';

/**
 * Barcode stickers (M06's label sheet, grown in M38a: D-604; architecture §8, §22).
 *
 * One PDF per print, sized for the stock it goes on:
 *
 * - **thermal rolls** (38 × 25, 40 × 30, 50 × 25 mm): one sticker per page, the page the
 *   sticker's exact size with no margin, so the roll printer's driver feeds one label per
 *   page;
 * - **A4 sheets** (3 × 8, 4 × 10): a grid, starting at any position so a half-used sheet
 *   is not wasted.
 *
 * Each sticker carries the brand's short name, the product name (cut to fit), the variant
 * in words, the selling price when asked, the barcode with its digits, and the SKU code
 * small. The brand's name comes from its own organization row, never from code: the same
 * build prints for every brand (white label, M31).
 *
 * **The barcode is inline SVG from @elysium/domain**, whole modules in a module-unit
 * viewBox, sized in millimetres to a whole number of thermal dots per module. An internal
 * or supplier EAN-13 prints as EAN-13; any other barcode, or a SKU with none, prints its
 * barcode or SKU code in Code 128 as M06 did.
 *
 * There is no cost on a sticker and no code path that could put one there:
 * `CatalogApi.stickerData` selects the selling price and nothing else (invariant 5).
 */

const FONT = `'Hind Siliguri', sans-serif`;

@Injectable()
export class LabelsService {
  constructor(
    private readonly gotenberg: GotenbergClient,
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
  ) {}

  async sheetPdf(context: ActiveContext, input: LabelSheetInput): Promise<Uint8Array> {
    const medium = STICKER_MEDIA[input.medium];
    const total = input.items.reduce((sum, item) => sum + item.copies, 0);
    if (total > MAX_STICKERS_PER_PDF) {
      throw new CatalogError(
        'CATALOG_LABELS_INVALID',
        `One print holds at most ${String(MAX_STICKERS_PER_PDF)} stickers; print the rest in another.`,
      );
    }

    const { skus, brand } = await withOrg(context, async (tx) => ({
      skus: await this.catalog.stickerData(
        tx,
        context.orgId,
        input.items.map((item) => item.skuId),
      ),
      brand: await repo.brandShortName(tx, context.orgId),
    }));

    const byId = new Map(skus.map((sku) => [sku.skuId, sku]));
    const stickers = input.items.flatMap((item) => {
      const sku = byId.get(item.skuId);
      if (sku === undefined) {
        throw new CatalogError('CATALOG_NOT_FOUND', 'One of those SKUs is not in this brand.');
      }
      const sticker: StickerData = {
        barcode: sku.barcode,
        code: sku.skuCode,
        productName: sku.productName,
        variantLabel: sku.variantLabel,
        priceText: input.showPrice ? formatTakaLabel(sku.pricePoisha) : null,
        brand,
      };
      return Array.from({ length: item.copies }, () => sticker);
    });

    let html: string;
    const fonts = await loadFonts();
    try {
      html = renderStickersHtml({
        stickers,
        medium,
        startAt: input.startAt,
        fontCss: fontFaceCss(fonts),
      });
    } catch (error) {
      if (error instanceof StickerLayoutError) {
        throw new CatalogError('CATALOG_LABELS_INVALID', error.message);
      }
      throw error;
    }

    const page = stickerPageSize(medium);
    return this.gotenberg.renderPdf({
      html,
      assets: fonts.map((font) => ({
        filename: font.filename,
        bytes: font.bytes,
        contentType: 'font/woff2',
      })),
      // The page is the sticker (a roll) or A4 (a sheet), in inches as Gotenberg takes it,
      // and no margin: the HTML owns the geometry, and a Chromium margin on top of it would
      // shift every sticker off its die-cut.
      paperWidth: page.widthMm / 25.4,
      paperHeight: page.heightMm / 25.4,
      marginInches: 0,
      // A thousand roll stickers is a thousand pages.
      timeoutMs: 120_000,
    });
  }
}

export function formatTakaLabel(pricePoisha: string): string {
  const { taka, poisha: fraction } = takaParts(poisha(pricePoisha));
  // Whole taka print without decimals ("৳1,490"): a tag is read at arm's length. A price
  // with poisha keeps both digits, so ৳1490.5 never reads as a truncated number.
  const whole = taka.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === 0n ? `৳${whole}` : `৳${whole}.${fraction.toString().padStart(2, '0')}`;
}

/** One sticker's text and symbol. */
export interface StickerData {
  /** What the bars encode: an EAN-13, a supplier's code, or null for the SKU code. */
  readonly barcode: string | null;
  readonly code: string;
  readonly productName: string;
  readonly variantLabel: string;
  readonly priceText: string | null;
  readonly brand: string;
}

/** Text sizes per sticker size: the smallest stock prints the smallest type. */
function typeScale(medium: StickerMediumSpec): {
  readonly brand: number;
  readonly name: number;
  readonly variant: number;
  readonly price: number;
  readonly code: number;
  readonly nameLines: number;
  readonly padMm: number;
} {
  if (medium.labelHeightMm >= 33) {
    return { brand: 6, name: 7.5, variant: 7.5, price: 9.5, code: 5.5, nameLines: 2, padMm: 1.8 };
  }
  if (medium.labelHeightMm >= 29) {
    return { brand: 5.5, name: 7, variant: 7, price: 9, code: 5, nameLines: 2, padMm: 1.4 };
  }
  return { brand: 5, name: 6.5, variant: 6.5, price: 8, code: 4.5, nameLines: 1, padMm: 1.1 };
}

const PT_TO_MM = 25.4 / 72;

/**
 * How tall the bars may be on this sticker: the medium's own figure, or less when the text
 * above and below leaves less room, so the symbol never overlaps the words and a scanner
 * always gets the whole of it. Never under 5 mm, which a handheld scanner still reads.
 */
export function barHeightFor(medium: StickerMediumSpec, hasVariant: boolean): number {
  const scale = typeScale(medium);
  const text =
    Math.max(scale.brand, scale.price) * 1.1 +
    scale.name * 1.15 * scale.nameLines +
    (hasVariant ? scale.variant * 1.15 : 0) +
    scale.code * 1.1;
  const digits = 10 * medium.moduleMm;
  const room = medium.labelHeightMm - 2 * scale.padMm - text * PT_TO_MM - digits - 0.8;
  return Math.max(5, Math.min(medium.barHeightMm, room));
}

/** The symbol for one sticker, sized in millimetres. */
function symbolOf(sticker: StickerData, medium: StickerMediumSpec, innerWidthMm: number): string {
  const payload = sticker.barcode ?? sticker.code;
  const barHeightMm = barHeightFor(medium, sticker.variantLabel !== '');
  if (isValidEan13(payload)) {
    const barModules = Math.round(barHeightMm / medium.moduleMm);
    const width = EAN13_TOTAL_MODULES * medium.moduleMm;
    const height = (barModules + 10) * medium.moduleMm;
    return ean13Svg(payload, { barHeight: barModules, fontFamily: FONT }).replace(
      '<svg ',
      `<svg width="${mm(width)}" height="${mm(height)}" `,
    );
  }
  // Code 128 for anything else, at the medium's module width or narrower if it would not
  // fit, with the payload printed under it (the same string as the bars).
  const modules = code128Encode(payload).width + CODE128_QUIET_MODULES * 2;
  const width = Math.min(innerWidthMm, modules * medium.moduleMm);
  return (
    code128Svg(payload, 40).replace(
      '<svg ',
      `<svg width="${mm(width)}" height="${mm(barHeightMm - 10 * medium.moduleMm * 0.6)}" `,
    ) + `<div class="digits">${escapeHtml(payload)}</div>`
  );
}

function mm(value: number): string {
  return `${String(Math.round(value * 1000) / 1000)}mm`;
}

function stickerHtml(sticker: StickerData, medium: StickerMediumSpec): string {
  const scale = typeScale(medium);
  const inner = medium.labelWidthMm - scale.padMm * 2;
  // About 1.3 mm a character at 6.5 pt; the CSS ellipsis is the second line of defence.
  const perLine = Math.max(8, Math.floor(inner / ((scale.name / 6.5) * 1.3)));
  const name = fitStickerText(sticker.productName, perLine * scale.nameLines);
  const price =
    sticker.priceText === null ? '' : `<span class="price">${escapeHtml(sticker.priceText)}</span>`;
  const variant =
    sticker.variantLabel === ''
      ? ''
      : `<div class="variant">${escapeHtml(fitStickerText(sticker.variantLabel, perLine))}</div>`;
  return `<div class="sticker">
  <div class="top"><span class="brand">${escapeHtml(fitStickerText(sticker.brand, 24))}</span>${price}</div>
  <div class="name">${escapeHtml(name)}</div>
  ${variant}
  <div class="bars">${symbolOf(sticker, medium, inner)}</div>
  <div class="code">${escapeHtml(sticker.code)}</div>
</div>`;
}

/**
 * The stickers' HTML, page by page.
 *
 * Exported so a test can check the layout without a running Gotenberg: how many pages,
 * which positions are blank, and that the bars and digits say the same thing. The PDF's
 * page size is checked against the real renderer in `labels.db.test.ts`.
 */
export function renderStickersHtml(input: {
  readonly stickers: readonly StickerData[];
  readonly medium: StickerMediumSpec;
  readonly startAt: number;
  readonly fontCss: string;
}): string {
  const { medium } = input;
  const scale = typeScale(medium);
  const pages = stickerPages(input.stickers.length, medium, input.startAt);
  const page = stickerPageSize(medium);

  const body = pages
    .map((slots) => {
      if (medium.kind === 'roll') {
        const index = slots[0];
        const sticker = index === null || index === undefined ? undefined : input.stickers[index];
        return `<section class="page">${sticker === undefined ? '' : stickerHtml(sticker, medium)}</section>`;
      }
      const cells = slots
        .map((index, position) => {
          if (index === null) return '';
          const sticker = input.stickers[index];
          if (sticker === undefined) return '';
          const column = position % medium.columns;
          const row = Math.floor(position / medium.columns);
          const left = medium.marginLeftMm + column * (medium.labelWidthMm + medium.gapXMm);
          const top = medium.marginTopMm + row * (medium.labelHeightMm + medium.gapYMm);
          return `<div class="cell" style="left:${mm(left)};top:${mm(top)}">${stickerHtml(sticker, medium)}</div>`;
        })
        .join('');
      return `<section class="page">${cells}</section>`;
    })
    .join('');

  return `<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8">
<style>
${input.fontCss}
@page { size: ${mm(page.widthMm)} ${mm(page.heightMm)}; margin: 0; }
html, body { margin: 0; padding: 0; }
body { font-family: ${FONT}; color: #000; -webkit-print-color-adjust: exact; }
/* A hair under the page, so rounding from millimetres to pixels can never spill a page
   onto a second one and feed a blank label. */
.page { position: relative; width: ${mm(page.widthMm)}; height: ${mm(page.heightMm - 0.15)};
  overflow: hidden; break-after: page; }
.page:last-child { break-after: auto; }
.cell { position: absolute; width: ${mm(medium.labelWidthMm)}; height: ${mm(medium.labelHeightMm)}; }
.sticker { box-sizing: border-box; width: ${mm(medium.labelWidthMm)};
  height: ${mm(medium.kind === 'roll' ? medium.labelHeightMm - 0.15 : medium.labelHeightMm)};
  padding: ${mm(scale.padMm)} ${mm(scale.padMm + 0.3)}; display: flex; flex-direction: column;
  justify-content: space-between; overflow: hidden; }
/* Only the name may give way; everything else keeps its size, so nothing overlaps. */
.sticker > * { flex-shrink: 0; }
.sticker > .name { flex-shrink: 1; min-height: 0; }
.top { display: flex; justify-content: space-between; align-items: baseline; gap: 1mm;
  line-height: 1.1; }
.brand { font-size: ${String(scale.brand)}pt; font-weight: 600; letter-spacing: 0.04em;
  text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.price { font-size: ${String(scale.price)}pt; font-weight: 600; white-space: nowrap;
  font-variant-numeric: tabular-nums; }
.name { font-size: ${String(scale.name)}pt; line-height: 1.15; overflow: hidden;
  ${
    scale.nameLines === 1
      ? 'white-space: nowrap; text-overflow: ellipsis;'
      : `display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: ${String(scale.nameLines)};`
  } }
.variant { font-size: ${String(scale.variant)}pt; font-weight: 600; line-height: 1.15;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bars { display: flex; flex-direction: column; align-items: center; }
.bars svg { display: block; color: #000; }
.digits { font-size: ${String(scale.code + 1)}pt; letter-spacing: 0.08em; line-height: 1.1;
  font-variant-numeric: tabular-nums; }
.code { font-size: ${String(scale.code)}pt; text-align: center; line-height: 1.1;
  letter-spacing: 0.03em; font-variant-numeric: tabular-nums; white-space: nowrap;
  overflow: hidden; }
</style>
</head>
<body>${body}</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Stickers on one A4 3 × 8 sheet, M06's original layout. */
export const LABELS_PER_SHEET = 24;
