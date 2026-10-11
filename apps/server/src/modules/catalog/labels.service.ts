import { Inject, Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import {
  code128Encode,
  code128Svg,
  CODE128_QUIET_MODULES,
  customStickerMedium,
  ean13Svg,
  fitStickerText,
  isValidEan13,
  MAX_STICKERS_PER_PDF,
  poisha,
  PT_TO_MM,
  STICKER_EDGE_MM,
  STICKER_MEDIA,
  StickerLayoutError,
  stickerLayoutFor,
  stickerPageSize,
  stickerPages,
  takaText,
  type StickerContent,
  type StickerLayout,
  type StickerMediumSpec,
} from '@elysium/domain';

import type { ActiveContext } from '../../platform/http/context.js';
import { GotenbergClient } from '../files/pdf/gotenberg.client.js';
import { DOCUMENT_FONT_STACK, loadFonts, fontFaceCss } from '../files/pdf/fonts.js';
import { CATALOG_API, type CatalogApi } from './catalog.api.js';
import { CatalogError } from './catalog.errors.js';
import * as repo from './catalog.repository.js';
import type { LabelSheetInput } from './catalog.schemas.js';

/**
 * Barcode stickers (M06's label sheet, grown in M38a: D-604, D-650, D-651; architecture §8,
 * §22).
 *
 * One PDF per print, sized for the stock it goes on:
 *
 * - **thermal rolls** (38 × 25, 40 × 30, 45 × 35, 50 × 25 mm, or a custom size from 25 × 15
 *   to 110 × 100 mm): one sticker per page, the page the sticker's exact size with no margin,
 *   so the roll printer's driver feeds one label per page;
 * - **A4 sheets** (3 × 8, 4 × 10): a grid, starting at any position so a half-used sheet
 *   is not wasted.
 *
 * Each sticker carries the brand's short name, the product name (cut to fit), the variant
 * in words, the selling price when asked, the barcode with its digits, the SKU code small,
 * and the print's extra line when one is given (D-651). Where each goes, and which give way
 * on a small sticker, is `stickerLayout`'s one rule for every size (D-650). The brand's name
 * comes from its own organization row, never from code: the same build prints for every
 * brand (white label, M31).
 *
 * **The barcode is inline SVG from @elysium/domain**, whole modules in a module-unit
 * viewBox, sized in millimetres to the layout's module (a whole number of thermal dots on a
 * roll). An internal or supplier EAN-13 prints as EAN-13; any other barcode, or a SKU with
 * none, prints its barcode or SKU code in Code 128 as M06 did.
 *
 * There is no cost on a sticker and no code path that could put one there:
 * `CatalogApi.stickerData` selects the selling price and nothing else (invariant 5).
 */

/** Inter, as every document (D-753); the font stack's fallbacks carry a Bangla product name. */
const FONT = DOCUMENT_FONT_STACK;

/** The medium a request prints on: a fixed one, or the custom size it names (D-650). */
export function mediumOf(input: LabelSheetInput): StickerMediumSpec {
  if (input.medium === 'custom') {
    if (input.widthMm === undefined || input.heightMm === undefined) {
      throw new CatalogError(
        'CATALOG_LABELS_INVALID',
        'A custom sticker needs its width and height in millimetres.',
      );
    }
    return customStickerMedium(input.widthMm, input.heightMm);
  }
  return STICKER_MEDIA[input.medium];
}

@Injectable()
export class LabelsService {
  constructor(
    private readonly gotenberg: GotenbergClient,
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
  ) {}

  async sheetPdf(context: ActiveContext, input: LabelSheetInput): Promise<Uint8Array> {
    const medium = mediumOf(input);
    const total = input.items.reduce((sum, item) => sum + item.copies, 0);
    if (total > MAX_STICKERS_PER_PDF) {
      throw new CatalogError(
        'CATALOG_LABELS_INVALID',
        `One print holds at most ${String(MAX_STICKERS_PER_PDF)} stickers; print the rest in another.`,
      );
    }
    // A size that cannot hold a scannable barcode is refused before anything is read.
    const fits = stickerLayoutFor(medium, { price: input.showPrice, variant: false, extra: false });
    if (!fits.ok) throw new CatalogError('CATALOG_LABELS_INVALID', fits.message);

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
        extraLine: input.extraLine ?? null,
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

/**
 * A sticker's price, `Tk 1,490` (D-751): whole taka print without decimals, because a tag is
 * read at arm's length; a price with poisha keeps both digits, so nothing reads truncated.
 */
export function formatTakaLabel(pricePoisha: string): string {
  return takaText(poisha(pricePoisha), { wholeTaka: true });
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

function mm(value: number): string {
  return `${String(Math.round(value * 1000) / 1000)}mm`;
}

/** What one sticker carries, for its layout: the price, a variant, the extra line, the name. */
function contentOf(sticker: StickerData, extraLine: string | null): StickerContent {
  return {
    price: sticker.priceText !== null,
    variant: sticker.variantLabel !== '',
    extra: extraLine !== null,
    nameLength: [...sticker.productName.replace(/\s+/g, ' ').trim()].length,
  };
}

/**
 * The layout of one sticker on this medium (D-650), or a `StickerLayoutError` saying why the
 * size cannot carry a scannable barcode.
 */
export function layoutFor(medium: StickerMediumSpec, content: StickerContent): StickerLayout {
  const layout = stickerLayoutFor(medium, content);
  if (!layout.ok) throw new StickerLayoutError(layout.message);
  return layout;
}

/** The symbol for one sticker, in its row of the layout. */
function symbolOf(sticker: StickerData, layout: StickerLayout): string {
  const payload = sticker.barcode ?? sticker.code;
  if (isValidEan13(payload)) {
    return ean13Svg(payload, { barHeight: layout.barModules, fontFamily: FONT }).replace(
      '<svg ',
      `<svg width="${mm(layout.symbolWidthMm)}" height="${mm(layout.symbolHeightMm)}" `,
    );
  }
  // Code 128 for anything else, at the layout's module width or narrower if it would not
  // fit, with the payload printed under it (the same string as the bars) in the band the
  // EAN-13's digits would take.
  const modules = code128Encode(payload).width + CODE128_QUIET_MODULES * 2;
  const width = Math.min(layout.widthMm - 2 * STICKER_EDGE_MM, modules * layout.moduleMm);
  const band = layout.symbolHeightMm - layout.barHeightMm;
  const digitsPt = Math.min(layout.scale.code + 1, band / PT_TO_MM / 1.15);
  return (
    code128Svg(payload, 40).replace(
      '<svg ',
      `<svg width="${mm(width)}" height="${mm(layout.barHeightMm)}" `,
    ) +
    `<div class="digits" style="font-size:${String(Math.round(digitsPt * 100) / 100)}pt">` +
    `${escapeHtml(payload)}</div>`
  );
}

function stickerHtml(
  sticker: StickerData,
  layout: StickerLayout,
  extraLine: string | null,
): string {
  const rows = layout.rows.map((row) => {
    const at = `top:${mm(row.yMm)};height:${mm(row.heightMm)}`;
    switch (row.kind) {
      case 'top': {
        const price =
          sticker.priceText === null
            ? ''
            : `<span class="price">${escapeHtml(sticker.priceText)}</span>`;
        const brand = escapeHtml(fitStickerText(sticker.brand, 24));
        return `<div class="row top" style="${at}"><span class="brand">${brand}</span>${price}</div>`;
      }
      case 'name': {
        const name = fitStickerText(sticker.productName, layout.chars.name * layout.nameLines);
        const lines = layout.nameLines === 2 ? ' two' : '';
        return `<div class="row name${lines}" style="${at}">${escapeHtml(name)}</div>`;
      }
      case 'variant': {
        const variant = fitStickerText(sticker.variantLabel, layout.chars.variant);
        return `<div class="row variant" style="${at}">${escapeHtml(variant)}</div>`;
      }
      case 'extra': {
        const extra = fitStickerText(extraLine ?? '', layout.chars.extra);
        return `<div class="row extra" style="${at}">${escapeHtml(extra)}</div>`;
      }
      case 'symbol': {
        // An EAN-13 sits where the layout centres it, quiet zones included; Code 128 is
        // centred across the sticker at whatever width it needs.
        const box = isValidEan13(sticker.barcode ?? sticker.code)
          ? `left:${mm(layout.symbolXMm)};width:${mm(layout.symbolWidthMm)}`
          : 'left:0;width:100%';
        return `<div class="bars" style="${at};${box}">${symbolOf(sticker, layout)}</div>`;
      }
      case 'code':
        return `<div class="row code" style="${at}">${escapeHtml(sticker.code)}</div>`;
    }
  });
  return `<div class="sticker">${rows.join('')}</div>`;
}

/**
 * The stickers' HTML, page by page.
 *
 * Every sticker is drawn from `stickerLayout` (D-650), the rule the console's preview draws
 * from too: each row sits where the layout puts it, so nothing overlaps whatever the text,
 * and the bars keep the module and height the layout chose. Exported so a test can check
 * the layout without a running Gotenberg: how many pages, which positions are blank, and
 * that the bars and digits say the same thing. The PDF's page size is checked against the
 * real renderer in `stickers.test.ts`.
 */
export function renderStickersHtml(input: {
  readonly stickers: readonly StickerData[];
  readonly medium: StickerMediumSpec;
  readonly startAt: number;
  readonly fontCss: string;
  /** One short line on every sticker of this print (D-651), or none. */
  readonly extraLine?: string | null;
}): string {
  const { medium } = input;
  const trimmed = input.extraLine?.trim() ?? '';
  const extraLine = trimmed === '' ? null : trimmed;
  const pages = stickerPages(input.stickers.length, medium, input.startAt);
  const page = stickerPageSize(medium);

  // One layout per kind of content: a print has at most a handful.
  const layouts = new Map<string, StickerLayout>();
  const layoutOf = (sticker: StickerData): StickerLayout => {
    const content = contentOf(sticker, extraLine);
    const key = [content.price, content.variant, content.extra, content.nameLength].join('/');
    let layout = layouts.get(key);
    if (layout === undefined) {
      layout = layoutFor(medium, content);
      layouts.set(key, layout);
    }
    return layout;
  };
  // The type and the side padding depend on the size alone: any layout of it gives them.
  const sample = layoutFor(medium, { price: true, variant: true, extra: extraLine !== null });
  const scale = sample.scale;
  const stickerOf = (sticker: StickerData) => stickerHtml(sticker, layoutOf(sticker), extraLine);

  const body = pages
    .map((slots) => {
      if (medium.kind === 'roll') {
        const index = slots[0];
        const sticker = index === null || index === undefined ? undefined : input.stickers[index];
        return `<section class="page">${sticker === undefined ? '' : stickerOf(sticker)}</section>`;
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
          return `<div class="cell" style="left:${mm(left)};top:${mm(top)}">${stickerOf(sticker)}</div>`;
        })
        .join('');
      return `<section class="page">${cells}</section>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
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
.sticker { position: relative; box-sizing: border-box; width: ${mm(medium.labelWidthMm)};
  height: ${mm(medium.kind === 'roll' ? medium.labelHeightMm - 0.15 : medium.labelHeightMm)};
  overflow: hidden; }
/* Every row where the layout puts it (D-650). */
.row { position: absolute; left: ${mm(sample.padXMm)}; right: ${mm(sample.padXMm)}; }
.top { display: flex; justify-content: space-between; align-items: baseline; gap: 1mm;
  line-height: 1.1; }
.brand { font-size: ${String(scale.brand)}pt; font-weight: 600; letter-spacing: 0.04em;
  text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.price { font-size: ${String(scale.price)}pt; font-weight: 600; white-space: nowrap;
  font-variant-numeric: tabular-nums; }
.name { font-size: ${String(scale.name)}pt; line-height: 1.15; overflow: hidden;
  white-space: nowrap; text-overflow: ellipsis; }
.name.two { white-space: normal; display: -webkit-box; -webkit-box-orient: vertical;
  -webkit-line-clamp: 2; }
.variant { font-size: ${String(scale.variant)}pt; font-weight: 600; line-height: 1.15;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.extra { font-size: ${String(scale.extra)}pt; line-height: 1.15; letter-spacing: 0.02em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bars { position: absolute; display: flex; flex-direction: column; align-items: center; }
.bars svg { display: block; color: #000; }
.digits { letter-spacing: 0.08em; line-height: 1.15; white-space: nowrap;
  font-variant-numeric: tabular-nums; }
.code { font-size: ${String(scale.code)}pt; text-align: center; line-height: 1.1;
  letter-spacing: 0.03em; white-space: nowrap; overflow: hidden; }
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
