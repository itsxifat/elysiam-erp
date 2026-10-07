/**
 * Where everything goes on one sticker (M38a, D-604; the custom size, D-650).
 *
 * One rule for every size: the fixed thermal rolls, the sheets' stickers and any custom size
 * a person types. The server draws the PDF from it and the console draws its live preview from
 * it, so what the dialog shows is what the printer gets.
 *
 * ## What must fit, and what gives way
 *
 * Two things are never given up: the **top row** (the brand's name, and the price when the
 * price is on) and the **barcode with its digits**. A size that cannot hold both is refused
 * with a reason, never printed with a symbol a scanner cannot read.
 *
 * The other lines give way one at a time, least important first: the name's second line (a
 * name short enough for one line never takes two), the extra line (D-651), the SKU code, the
 * size and colour, then the product name. The bars
 * shorten first (from their preferred height down to 5 mm) and a line is dropped only when
 * even 5 mm bars do not leave it room.
 *
 * ## The barcode's size
 *
 * EAN-13 is 113 modules wide with its quiet zones. The module is a whole number of 203 dpi
 * dots (0.125 mm each), because a module a thermal head cannot draw exactly is drawn unevenly
 * and is the usual reason a printed symbol does not scan: 0.25 mm (2 dots, 76 % of the
 * nominal 0.33 mm, the nearest whole-dot size to the symbology's 80 % floor and what the
 * 38 × 25 roll has printed since D-604), 0.375 mm (3 dots) or 0.5 mm (4 dots). The largest
 * that fits the width wins, unless a smaller one keeps more lines. An A4 sheet goes through a
 * laser printer and keeps the module D-604 chose for it.
 *
 * So the narrowest sticker is 113 × 0.25 mm plus half a millimetre each side for the
 * die-cut's tolerance: 29.25 mm.
 *
 * Pure and deterministic: the same size and content always give the same layout.
 */

import { EAN13_TOTAL_MODULES } from './ean13.js';

/** One dot of a 203 dpi thermal head, in millimetres. */
export const THERMAL_DOT_MM = 25.4 / 203.2;

/** The module widths a thermal roll may print, largest first: 4, 3 and 2 dots. */
export const ROLL_MODULES_MM = [0.5, 0.375, 0.25] as const;

/** The narrowest module a sticker prints: two 203 dpi dots. */
export const MIN_STICKER_MODULE_MM = 0.25;

/** The shortest data bars a sticker prints, which a handheld scanner still reads (D-604). */
export const MIN_STICKER_BAR_MM = 5;

/** Clear room at each side of the symbol (its quiet zones included): the die-cut's tolerance. */
export const STICKER_EDGE_MM = 0.5;

/** The narrowest sticker that holds a scannable EAN-13: 29.25 mm. */
export const MIN_STICKER_WIDTH_MM =
  EAN13_TOTAL_MODULES * MIN_STICKER_MODULE_MM + 2 * STICKER_EDGE_MM;

/** The human-readable digits under the bars, in modules (`ean13Svg` draws them there). */
export const EAN13_DIGIT_BAND_MODULES = 10;

/** Points to millimetres: type is set in points, the sticker is measured in millimetres. */
export const PT_TO_MM = 25.4 / 72;

/** Room kept free between the rows in all, so rounding never makes two rows touch. */
const GAP_RESERVE_MM = 0.8;

/** The most space between two rows; a tall sticker centres its rows instead of spreading them. */
const MAX_GAP_MM = 2;

/** Line heights, as multiples of the font size. */
const LINE_HEIGHT = { top: 1.1, text: 1.15, code: 1.1 } as const;

/** The lines that may give way, in the order they do (first dropped first). */
export const STICKER_DROP_ORDER = ['name2', 'extra', 'code', 'variant', 'name'] as const;

export type StickerDroppableLine = (typeof STICKER_DROP_ORDER)[number];

/** What one sticker carries, besides the brand and the barcode it always carries. */
export interface StickerContent {
  /** The selling price is printed (top right). */
  readonly price: boolean;
  /** The SKU has a size or colour to print (a single-variant product has none). */
  readonly variant: boolean;
  /** The print run has an extra line (D-651). */
  readonly extra: boolean;
  /**
   * The product name's length in characters, when known. A name short enough for one line
   * (by the same estimate the text is cut with) takes one, leaving the room to the rest;
   * absent, the name gets as many lines as the size allows.
   */
  readonly nameLength?: number;
}

/** Type sizes in points, and the padding, for one size class of sticker. */
export interface StickerTypeScale {
  readonly brand: number;
  readonly price: number;
  readonly name: number;
  readonly variant: number;
  readonly extra: number;
  readonly code: number;
  /** The most lines the product name may take. */
  readonly nameLines: 1 | 2;
  /** Padding at the top and bottom; the sides get 0.3 mm more. */
  readonly padMm: number;
}

/*
 * The smallest stock prints the smallest type. The first three are D-604's figures, so the
 * 38 × 25, 40 × 30 and 50 × 25 rolls and both sheets keep the type they had; XL is for the
 * large custom sizes.
 */
const SCALE_S: StickerTypeScale = {
  brand: 5,
  price: 8,
  name: 6.5,
  variant: 6.5,
  extra: 5.5,
  code: 4.5,
  nameLines: 1,
  padMm: 1.1,
};
const SCALE_M: StickerTypeScale = {
  brand: 5.5,
  price: 9,
  name: 7,
  variant: 7,
  extra: 6,
  code: 5,
  nameLines: 2,
  padMm: 1.4,
};
const SCALE_L: StickerTypeScale = {
  brand: 6,
  price: 9.5,
  name: 7.5,
  variant: 7.5,
  extra: 6.5,
  code: 5.5,
  nameLines: 2,
  padMm: 1.8,
};
const SCALE_XL: StickerTypeScale = {
  brand: 7,
  price: 12,
  name: 9,
  variant: 9,
  extra: 8,
  code: 6.5,
  nameLines: 2,
  padMm: 2.5,
};

/** The type for a sticker of this size: by its height, held back on a narrow one. */
export function stickerTypeScale(widthMm: number, heightMm: number): StickerTypeScale {
  if (heightMm >= 45 && widthMm >= 60) return SCALE_XL;
  if (heightMm >= 33 && widthMm >= 40) return SCALE_L;
  if (heightMm >= 29 && widthMm >= 36) return SCALE_M;
  return SCALE_S;
}

export type StickerRowKind = 'top' | 'name' | 'variant' | 'extra' | 'symbol' | 'code';

/** One row of the sticker, top to bottom: where its box starts and how tall it is. */
export interface StickerRow {
  readonly kind: StickerRowKind;
  readonly yMm: number;
  readonly heightMm: number;
}

export interface StickerLayout {
  readonly ok: true;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly scale: StickerTypeScale;
  readonly padXMm: number;
  readonly padYMm: number;
  /** The width the text may use. */
  readonly innerWidthMm: number;
  readonly moduleMm: number;
  /** The data bars' height, in modules and in millimetres; guard bars run 5 modules longer. */
  readonly barModules: number;
  readonly barHeightMm: number;
  /** The symbol's box: quiet zones included, the digits under the bars included. */
  readonly symbolXMm: number;
  readonly symbolWidthMm: number;
  readonly symbolHeightMm: number;
  /** How many lines the product name takes: 0 when it was dropped. */
  readonly nameLines: 0 | 1 | 2;
  readonly lines: {
    readonly name: boolean;
    readonly variant: boolean;
    readonly extra: boolean;
    readonly code: boolean;
  };
  /** The lines that were wanted and did not fit, in the order they were given up. */
  readonly dropped: readonly StickerDroppableLine[];
  /** Every row printed, top to bottom. */
  readonly rows: readonly StickerRow[];
  /** About how many characters fit on one line of each text row, for cutting text to fit. */
  readonly chars: { readonly name: number; readonly variant: number; readonly extra: number };
}

export interface StickerLayoutRefusal {
  readonly ok: false;
  readonly reason: 'too-narrow' | 'too-short';
  /** The size this sticker needs at least, in millimetres, to the next tenth. */
  readonly minWidthMm: number;
  readonly minHeightMm: number;
  readonly message: string;
}

export interface StickerLayoutOptions {
  /**
   * A fixed module width: an A4 sheet's, printed by a laser printer, which draws any width.
   * Absent, a thermal roll's module is chosen from `ROLL_MODULES_MM`.
   */
  readonly moduleMm?: number;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function upToTenth(value: number): number {
  return Math.ceil(value * 10 - 1e-9) / 10;
}

function rowHeight(fontPt: number, lineHeight: number, lines = 1): number {
  return fontPt * lineHeight * lines * PT_TO_MM;
}

/** About how many characters of a font size fit in a width: 1.3 mm a character at 6.5 pt. */
function charsFor(widthMm: number, fontPt: number): number {
  return Math.max(4, Math.floor(widthMm / ((fontPt / 6.5) * 1.3)));
}

/**
 * The bars' preferred height: 7 mm on a 25 mm sticker and 0.6 mm more for every millimetre
 * taller (10 mm at 30 mm), never more than 0.6 of the symbol's width (the EAN-13's own
 * proportion), never under 5 mm.
 */
function preferredBarMm(heightMm: number, symbolWidthMm: number): number {
  return Math.max(MIN_STICKER_BAR_MM, Math.min(7 + 0.6 * (heightMm - 25), 0.6 * symbolWidthMm));
}

interface Attempt {
  readonly moduleMm: number;
  readonly barModules: number;
  readonly dropped: StickerDroppableLine[];
  readonly kept: {
    nameLines: 0 | 1 | 2;
    variant: boolean;
    extra: boolean;
    code: boolean;
  };
}

/** The layout at one module width, dropping lines until the bars fit; null if they never do. */
function attempt(
  heightMm: number,
  scale: StickerTypeScale,
  content: StickerContent,
  moduleMm: number,
  nameLines: 1 | 2,
): Attempt | null {
  const symbolWidthMm = EAN13_TOTAL_MODULES * moduleMm;
  const available = heightMm - 2 * scale.padMm - GAP_RESERVE_MM;
  const top = rowHeight(
    content.price ? Math.max(scale.brand, scale.price) : scale.brand,
    LINE_HEIGHT.top,
  );
  const digits = EAN13_DIGIT_BAND_MODULES * moduleMm;
  const minBarModules = Math.ceil(MIN_STICKER_BAR_MM / moduleMm - 1e-9);
  const preferredModules = Math.round(preferredBarMm(heightMm, symbolWidthMm) / moduleMm);

  const kept = {
    nameLines: nameLines as 0 | 1 | 2,
    variant: content.variant,
    extra: content.extra,
    code: true,
  };
  const dropped: StickerDroppableLine[] = [];
  const textHeight = () =>
    rowHeight(scale.name, LINE_HEIGHT.text, kept.nameLines) +
    (kept.variant ? rowHeight(scale.variant, LINE_HEIGHT.text) : 0) +
    (kept.extra ? rowHeight(scale.extra, LINE_HEIGHT.text) : 0) +
    (kept.code ? rowHeight(scale.code, LINE_HEIGHT.code) : 0);

  for (let step = 0; step <= STICKER_DROP_ORDER.length; step += 1) {
    const room = available - top - digits - textHeight();
    const roomModules = Math.floor(room / moduleMm + 1e-9);
    if (roomModules >= minBarModules) {
      return {
        moduleMm,
        barModules: Math.max(minBarModules, Math.min(preferredModules, roomModules)),
        dropped,
        kept,
      };
    }
    // Give up the next line this sticker has, least important first.
    let gaveUp = false;
    for (const line of STICKER_DROP_ORDER) {
      if (line === 'name2' && kept.nameLines === 2) kept.nameLines = 1;
      else if (line === 'extra' && kept.extra) kept.extra = false;
      else if (line === 'code' && kept.code) kept.code = false;
      else if (line === 'variant' && kept.variant) kept.variant = false;
      else if (line === 'name' && kept.nameLines === 1) kept.nameLines = 0;
      else continue;
      dropped.push(line);
      gaveUp = true;
      break;
    }
    if (!gaveUp) return null;
  }
  return null;
}

/**
 * Lay out one sticker of `widthMm × heightMm` carrying `content`.
 *
 * Returns the rows and the barcode's geometry, or a refusal with the reason and the least
 * size that would do. Never throws for a finite size; a non-finite or non-positive one is
 * refused as too narrow or too short.
 */
export function stickerLayout(
  widthMm: number,
  heightMm: number,
  content: StickerContent,
  options: StickerLayoutOptions = {},
): StickerLayout | StickerLayoutRefusal {
  const scale = stickerTypeScale(widthMm, heightMm);
  const padXMm = scale.padMm + 0.3;
  const innerWidthMm = widthMm - 2 * padXMm;
  const nameChars = charsFor(innerWidthMm, scale.name);
  // The lines the name wants: one when it fits on one by the estimate, else the size's most.
  const nameLines: 1 | 2 =
    content.nameLength !== undefined && content.nameLength <= nameChars ? 1 : scale.nameLines;
  const candidates = options.moduleMm === undefined ? [...ROLL_MODULES_MM] : [options.moduleMm];
  const smallest = Math.min(...candidates);
  const minWidthMm = upToTenth(EAN13_TOTAL_MODULES * smallest + 2 * STICKER_EDGE_MM);
  const fitting = candidates.filter(
    (moduleMm) => EAN13_TOTAL_MODULES * moduleMm + 2 * STICKER_EDGE_MM <= widthMm + 1e-9,
  );

  // The least height a barcode needs here: the top row and 5 mm bars with their digits.
  const smallScale = stickerTypeScale(widthMm, 0);
  const minHeightMm = upToTenth(
    2 * smallScale.padMm +
      GAP_RESERVE_MM +
      rowHeight(
        content.price ? Math.max(smallScale.brand, smallScale.price) : smallScale.brand,
        LINE_HEIGHT.top,
      ) +
      Math.ceil(MIN_STICKER_BAR_MM / smallest - 1e-9) * smallest +
      EAN13_DIGIT_BAND_MODULES * smallest,
  );

  if (!Number.isFinite(widthMm) || fitting.length === 0) {
    return {
      ok: false,
      reason: 'too-narrow',
      minWidthMm,
      minHeightMm,
      message: `A sticker ${formatMm(widthMm)} mm wide cannot hold a barcode a scanner reads. Make it at least ${formatMm(minWidthMm)} mm wide.`,
    };
  }

  let best: Attempt | null = null;
  if (Number.isFinite(heightMm)) {
    for (const moduleMm of fitting) {
      const next = attempt(heightMm, scale, content, moduleMm, nameLines);
      if (next === null) continue;
      // Fewer lines given up wins; on a tie, the wider module (largest first) stays.
      if (best === null || next.dropped.length < best.dropped.length) best = next;
    }
  }
  if (best === null) {
    return {
      ok: false,
      reason: 'too-short',
      minWidthMm,
      minHeightMm,
      message: `A sticker ${formatMm(heightMm)} mm tall cannot hold a barcode a scanner reads. Make it at least ${formatMm(minHeightMm)} mm tall.`,
    };
  }

  const { moduleMm, barModules, kept, dropped } = best;
  const symbolWidthMm = EAN13_TOTAL_MODULES * moduleMm;
  const barHeightMm = barModules * moduleMm;
  const symbolHeightMm = (barModules + EAN13_DIGIT_BAND_MODULES) * moduleMm;

  const stack: { kind: StickerRowKind; heightMm: number }[] = [
    {
      kind: 'top',
      heightMm: rowHeight(
        content.price ? Math.max(scale.brand, scale.price) : scale.brand,
        LINE_HEIGHT.top,
      ),
    },
  ];
  if (kept.nameLines > 0) {
    stack.push({ kind: 'name', heightMm: rowHeight(scale.name, LINE_HEIGHT.text, kept.nameLines) });
  }
  if (kept.variant)
    stack.push({ kind: 'variant', heightMm: rowHeight(scale.variant, LINE_HEIGHT.text) });
  if (kept.extra) stack.push({ kind: 'extra', heightMm: rowHeight(scale.extra, LINE_HEIGHT.text) });
  stack.push({ kind: 'symbol', heightMm: symbolHeightMm });
  if (kept.code) stack.push({ kind: 'code', heightMm: rowHeight(scale.code, LINE_HEIGHT.code) });

  // Spread the rows over the sticker like a column with space between, but never more than
  // MAX_GAP_MM apart: the rest is split above and below, so a tall sticker stays composed.
  const contentHeight = heightMm - 2 * scale.padMm;
  const used = stack.reduce((sum, row) => sum + row.heightMm, 0);
  const free = Math.max(0, contentHeight - used);
  const gap = stack.length > 1 ? Math.min(MAX_GAP_MM, free / (stack.length - 1)) : 0;
  let y = scale.padMm + (free - gap * (stack.length - 1)) / 2;
  const rows: StickerRow[] = stack.map((row) => {
    const placed = { kind: row.kind, yMm: round3(y), heightMm: round3(row.heightMm) };
    y += row.heightMm + gap;
    return placed;
  });

  return {
    ok: true,
    widthMm,
    heightMm,
    scale,
    padXMm,
    padYMm: scale.padMm,
    innerWidthMm: round3(innerWidthMm),
    moduleMm,
    barModules,
    barHeightMm: round3(barHeightMm),
    symbolXMm: round3((widthMm - symbolWidthMm) / 2),
    symbolWidthMm: round3(symbolWidthMm),
    symbolHeightMm: round3(symbolHeightMm),
    nameLines: kept.nameLines,
    lines: {
      name: kept.nameLines > 0,
      variant: kept.variant,
      extra: kept.extra,
      code: kept.code,
    },
    dropped,
    rows,
    chars: {
      name: nameChars,
      variant: charsFor(innerWidthMm, scale.variant),
      extra: charsFor(innerWidthMm, scale.extra),
    },
  };
}

/** `32.5`, `45`: a size as a person types it, one decimal at most. */
function formatMm(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return String(Math.round(value * 10) / 10);
}
