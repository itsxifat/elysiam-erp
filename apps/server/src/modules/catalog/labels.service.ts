import { Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';

import type { ActiveContext } from '../../platform/http/context.js';
import { code128Svg, poisha, takaParts } from '@elysium/domain';

import { GotenbergClient } from '../files/pdf/gotenberg.client.js';
import { loadFonts, fontFaceCss } from '../files/pdf/fonts.js';
import { CatalogError } from './catalog.errors.js';
import * as repo from './catalog.repository.js';
import type { LabelSheetInput } from './catalog.schemas.js';

/**
 * The barcode label sheet (M06 Build list, architecture §22).
 *
 * A4, 3 × 8 labels of 65 × 35 mm, rendered by the same Gotenberg that renders
 * §22's invoices. Two decisions worth stating:
 *
 * **The barcodes are inline SVG, drawn from `code128Svg` in @elysium/domain.**
 * Not a barcode font, and not an image service. A font cannot be checked — a
 * missing glyph renders as a blank and a wrong check character renders as a
 * barcode that looks perfect and does not scan, and the failure is discovered by a
 * warehouse with a scanner rather than by CI. The SVG's bars are integers in a
 * module-unit viewBox, so scaling cannot round two adjacent bars differently,
 * which is the other common reason a printed symbol fails.
 *
 * **The label carries no price unless asked.** A label is printed once and lives
 * on a box until the box is empty; a price printed on it is wrong the first time
 * the product is discounted, and an operator sticking a label over a label is the
 * expensive version of that mistake. `showPrice` is off by default.
 *
 * There is no cost on the label, and there is no code path here that could put one
 * there: `skusByIds` selects the selling price and nothing else (invariant 5).
 */

/** Millimetres. 3 columns × 8 rows on A4 with a 10 mm margin. */
const LABEL = { width: 63, height: 33.5, columns: 3, rows: 8 } as const;

@Injectable()
export class LabelsService {
  constructor(private readonly gotenberg: GotenbergClient) {}

  async sheetPdf(context: ActiveContext, input: LabelSheetInput): Promise<Uint8Array> {
    const skus = await withOrg(context, (tx) =>
      repo.skusByIds(
        tx,
        context.orgId,
        input.items.map((item) => item.skuId),
      ),
    );

    const byId = new Map(skus.map((sku) => [sku.id, sku]));
    const labels = input.items.flatMap((item) => {
      const sku = byId.get(item.skuId);
      if (sku === undefined) {
        throw new CatalogError('CATALOG_NOT_FOUND', 'One of those SKUs is not in this brand.');
      }
      return Array.from({ length: item.copies }, () => sku);
    });

    const fonts = await loadFonts();
    const html = renderLabelSheetHtml({
      labels: labels.map((sku) => ({
        // The payload is the barcode when the supplier gave us one, otherwise the
        // SKU code. Either way it is what a scanner will read, so the human-
        // readable line underneath prints the *same* string — a label whose
        // digits and bars disagree is worse than one with no digits.
        payload: sku.barcode ?? sku.code,
        code: sku.code,
        productName: sku.product_name,
        priceTaka: input.showPrice ? formatTakaLabel(sku.price_poisha) : null,
      })),
      fontCss: fontFaceCss(fonts),
    });

    return this.gotenberg.renderPdf({
      html,
      assets: fonts.map((font) => ({
        filename: font.filename,
        bytes: font.bytes,
        contentType: 'font/woff2',
      })),
      // A4 in inches, and no margin: the grid below owns the page geometry, and a
      // Chromium margin on top of it shifts every label off its die-cut.
      paperWidth: 8.27,
      paperHeight: 11.69,
      marginInches: 0,
    });
  }
}

function formatTakaLabel(pricePoisha: string): string {
  const { taka, poisha: fraction } = takaParts(poisha(pricePoisha));
  // Two decimals always. `৳1490.5` on a label reads as a truncated number to
  // whoever is checking a price against a till.
  return `৳${taka.toString()}.${fraction.toString().padStart(2, '0')}`;
}

interface LabelData {
  readonly payload: string;
  readonly code: string;
  readonly productName: string;
  readonly priceTaka: string | null;
}

/**
 * The sheet's HTML.
 *
 * Exported so a test can assert the symbol count and the payloads without a
 * running Gotenberg — the PDF bytes are Chromium's business, the contents of the
 * page are ours.
 */
export function renderLabelSheetHtml(input: {
  readonly labels: readonly LabelData[];
  readonly fontCss: string;
}): string {
  const cells = input.labels
    .map(
      (label) => `
      <div class="label">
        <div class="name">${escapeHtml(label.productName)}</div>
        <div class="bars">${code128Svg(label.payload, 30)}</div>
        <div class="foot">
          <span class="code">${escapeHtml(label.code)}</span>
          ${label.priceTaka === null ? '' : `<span class="price">${escapeHtml(label.priceTaka)}</span>`}
        </div>
      </div>`,
    )
    .join('');

  return `<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8">
<style>
${input.fontCss}
@page { size: A4; margin: 0; }
html, body { margin: 0; padding: 0; }
body {
  font-family: 'Inter', 'Hind Siliguri', sans-serif;
  /* The 10 mm page margin lives here rather than in @page so the grid below
     measures the printable area and the die-cut lines up. */
  padding: 8.5mm 6mm;
  -webkit-print-color-adjust: exact;
}
.sheet {
  display: grid;
  grid-template-columns: repeat(${String(LABEL.columns)}, ${String(LABEL.width)}mm);
  grid-auto-rows: ${String(LABEL.height)}mm;
  gap: 0;
}
.label {
  box-sizing: border-box;
  padding: 2mm 2.5mm;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  overflow: hidden;
  /* A hairline, so a sheet of plain paper can be cut by hand. On die-cut label
     stock it sits inside the cut and is invisible. */
  outline: 0.1mm dashed #d4d4d4;
  outline-offset: -0.1mm;
}
.name {
  font-size: 7pt;
  line-height: 1.15;
  max-height: 2.4em;
  overflow: hidden;
  color: #171717;
}
.bars { height: 12mm; }
.bars svg { width: 100%; height: 100%; display: block; color: #000; }
.foot {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 7.5pt;
}
/* Tabular numerals: a column of label codes that jitters is a column a picker
   misreads. */
.code { font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
.price { font-variant-numeric: tabular-nums; font-weight: 600; }
</style>
</head>
<body><div class="sheet">${cells}</div></body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const LABELS_PER_SHEET = LABEL.columns * LABEL.rows;
