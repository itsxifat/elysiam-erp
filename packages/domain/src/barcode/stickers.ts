/**
 * Sticker media and where each sticker goes (M38a, D-604; 45 × 35 and the custom size, D-650).
 *
 * Two kinds of stock, both in daily use in Bangladeshi warehouses:
 *
 * - **Thermal rolls** (38 × 25, 40 × 30, 45 × 35, 50 × 25 mm, or any size typed in, D-650):
 *   one sticker per PDF page, the page exactly the sticker's size with no margin. A roll
 *   printer's driver feeds one label per page; a page of any other size is scaled or split
 *   across two labels.
 * - **A4 sheets** (3 × 8 and 4 × 10): a grid on an A4 page, with "start at position" so a
 *   sheet with its first eleven stickers already used is not wasted.
 *
 * What goes where on one sticker, and how wide the bars' module is, comes from one rule for
 * every size: `stickerLayout` (`sticker-layout.ts`). A roll's module is a whole number of
 * 203 dpi dots chosen by that rule; a sheet goes through a laser printer and keeps the module
 * D-604 chose for it (0.375 mm on 3 × 8, 0.33 mm on 4 × 10). The geometry of the two sheets is
 * the common retail stock (24-up 63.5 × 33.9 mm, 40-up 48.5 × 25.4 mm); ASSUMED in D-604 until
 * the owner's own sheets are measured.
 */

import {
  stickerLayout,
  type StickerContent,
  type StickerLayout,
  type StickerLayoutRefusal,
} from './sticker-layout.js';

export const STICKER_MEDIA_IDS = [
  'thermal-38x25',
  'thermal-40x30',
  'thermal-45x35',
  'thermal-50x25',
  'a4-3x8',
  'a4-4x10',
] as const;

export type StickerMedium = (typeof STICKER_MEDIA_IDS)[number];

/** A roll sticker of a size the person types (D-650): `widthMm` and `heightMm` with it. */
export const CUSTOM_STICKER_MEDIUM = 'custom' as const;

/** Every choice of stock: a fixed medium, or the custom size. */
export type StickerMediumChoice = StickerMedium | typeof CUSTOM_STICKER_MEDIUM;

interface MediumBase {
  readonly id: StickerMediumChoice;
  /** One sticker's size. */
  readonly labelWidthMm: number;
  readonly labelHeightMm: number;
}

/** A thermal roll: its module and bar height come from `stickerLayout`. */
export interface RollMedium extends MediumBase {
  readonly kind: 'roll';
}

export interface SheetMedium extends MediumBase {
  readonly kind: 'sheet';
  readonly id: StickerMedium;
  /** The EAN-13 module width for the laser printer: the narrowest bar, in millimetres. */
  readonly moduleMm: number;
  readonly pageWidthMm: number;
  readonly pageHeightMm: number;
  readonly columns: number;
  readonly rows: number;
  readonly marginTopMm: number;
  readonly marginLeftMm: number;
  /** Space between two columns, and between two rows. */
  readonly gapXMm: number;
  readonly gapYMm: number;
}

export type StickerMediumSpec = RollMedium | SheetMedium;

export const STICKER_MEDIA: Readonly<Record<StickerMedium, StickerMediumSpec>> = {
  'thermal-38x25': {
    kind: 'roll',
    id: 'thermal-38x25',
    labelWidthMm: 38,
    labelHeightMm: 25,
  },
  'thermal-40x30': {
    kind: 'roll',
    id: 'thermal-40x30',
    labelWidthMm: 40,
    labelHeightMm: 30,
  },
  'thermal-45x35': {
    kind: 'roll',
    id: 'thermal-45x35',
    labelWidthMm: 45,
    labelHeightMm: 35,
  },
  'thermal-50x25': {
    kind: 'roll',
    id: 'thermal-50x25',
    labelWidthMm: 50,
    labelHeightMm: 25,
  },
  'a4-3x8': {
    kind: 'sheet',
    id: 'a4-3x8',
    pageWidthMm: 210,
    pageHeightMm: 297,
    columns: 3,
    rows: 8,
    labelWidthMm: 63.5,
    labelHeightMm: 33.9,
    marginTopMm: 12.9,
    marginLeftMm: 7.25,
    gapXMm: 2.5,
    gapYMm: 0,
    moduleMm: 0.375,
  },
  'a4-4x10': {
    kind: 'sheet',
    id: 'a4-4x10',
    pageWidthMm: 210,
    pageHeightMm: 297,
    columns: 4,
    rows: 10,
    labelWidthMm: 48.5,
    labelHeightMm: 25.4,
    marginTopMm: 21.5,
    marginLeftMm: 8,
    gapXMm: 0,
    gapYMm: 0,
    moduleMm: 0.33,
  },
};

/** The most stickers one PDF holds; the console prints more in parts. */
export const MAX_STICKERS_PER_PDF = 1000;

export function isStickerMedium(value: string): value is StickerMedium {
  return (STICKER_MEDIA_IDS as readonly string[]).includes(value);
}

/** A roll sticker of the size typed in (D-650). Its size is checked by `stickerLayout`. */
export function customStickerMedium(widthMm: number, heightMm: number): RollMedium {
  return {
    kind: 'roll',
    id: CUSTOM_STICKER_MEDIUM,
    labelWidthMm: widthMm,
    labelHeightMm: heightMm,
  };
}

/** The layout of one sticker on this medium: the same rule for every size (D-650). */
export function stickerLayoutFor(
  medium: StickerMediumSpec,
  content: StickerContent,
): StickerLayout | StickerLayoutRefusal {
  return stickerLayout(
    medium.labelWidthMm,
    medium.labelHeightMm,
    content,
    medium.kind === 'sheet' ? { moduleMm: medium.moduleMm } : {},
  );
}

/** Stickers per page: one on a roll, the grid on a sheet. */
export function stickersPerPage(medium: StickerMediumSpec): number {
  return medium.kind === 'roll' ? 1 : medium.columns * medium.rows;
}

/** The page size a PDF for this medium must have, in millimetres. */
export function stickerPageSize(medium: StickerMediumSpec): {
  readonly widthMm: number;
  readonly heightMm: number;
} {
  return medium.kind === 'roll'
    ? { widthMm: medium.labelWidthMm, heightMm: medium.labelHeightMm }
    : { widthMm: medium.pageWidthMm, heightMm: medium.pageHeightMm };
}

export class StickerLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StickerLayoutError';
  }
}

/**
 * Lay `count` stickers out on pages.
 *
 * Each page is its slots in reading order (left to right, top to bottom); a slot holds the
 * index of the sticker printed there, or null for a position left blank. On a sheet, the
 * first page's first `startAt - 1` positions are blank: those stickers are already used.
 * On a roll `startAt` means nothing and must be 1.
 */
export function stickerPages(
  count: number,
  medium: StickerMediumSpec,
  startAt = 1,
): (number | null)[][] {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new StickerLayoutError('Print at least one sticker.');
  }
  if (count > MAX_STICKERS_PER_PDF) {
    throw new StickerLayoutError(
      `One PDF holds at most ${String(MAX_STICKERS_PER_PDF)} stickers; print the rest in another.`,
    );
  }
  const perPage = stickersPerPage(medium);
  if (!Number.isSafeInteger(startAt) || startAt < 1 || startAt > perPage) {
    throw new StickerLayoutError(
      medium.kind === 'roll'
        ? 'A roll has no positions to skip.'
        : `Start at a position from 1 to ${String(perPage)}.`,
    );
  }

  const slots: (number | null)[] = [
    ...Array.from({ length: startAt - 1 }, () => null),
    ...Array.from({ length: count }, (_, index) => index),
  ];
  const pages: (number | null)[][] = [];
  for (let offset = 0; offset < slots.length; offset += perPage) {
    pages.push(slots.slice(offset, offset + perPage));
  }
  return pages;
}

/** Split a run of stickers into PDFs of at most `max`: `[{ from: 0, to: 999 }, …]`. */
export function stickerParts(
  total: number,
  max = MAX_STICKERS_PER_PDF,
): { readonly from: number; readonly to: number }[] {
  if (!Number.isSafeInteger(total) || total < 1) return [];
  const parts: { from: number; to: number }[] = [];
  for (let from = 0; from < total; from += max) {
    parts.push({ from, to: Math.min(total, from + max) - 1 });
  }
  return parts;
}

/**
 * A product name cut to fit a line of a sticker: at most `max` characters, ending in an
 * ellipsis when cut, never in the middle of a Bangla cluster's combining marks.
 */
export function fitStickerText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const characters = [...clean];
  if (characters.length <= max) return clean;
  let cut = characters.slice(0, Math.max(1, max - 1));
  // Drop trailing combining marks, virama and joiners, so a cluster is never split.
  while (cut.length > 1 && /[̀-ͯঁ-ঃ়-ৗ‌‍]/.test(cut.at(-1) ?? '')) {
    cut = cut.slice(0, -1);
  }
  return `${cut.join('').trimEnd()}…`;
}
