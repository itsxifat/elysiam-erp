/**
 * The pure parts of the sticker dialog (M38a, D-604; the custom size and the extra line,
 * D-650 to D-652). Nothing here touches the API client, so the unit test loads it alone.
 *
 * The custom size is checked with the server's own rules: the range from
 * `@elysium/contracts` (`STICKER_SIZE_LIMITS`, the schema the server parses with) and the
 * scannable minimum from `stickerLayout` in `@elysium/domain/barcode`, the rule the PDF is
 * drawn by. The dialog cannot accept a size the server refuses.
 */
import {
  STICKER_EXTRA_LINE_MAX,
  STICKER_SIZE_LIMITS,
  stickerExtraLineSchema,
  stickerHeightMmSchema,
  stickerWidthMmSchema,
} from '@elysium/contracts';
import { stickerLayout, type StickerContent } from '@elysium/domain/barcode';

export const STICKER_MEDIUM_IDS = [
  'thermal-38x25',
  'thermal-40x30',
  'thermal-45x35',
  'thermal-50x25',
  'a4-3x8',
  'a4-4x10',
  'custom',
] as const;

export type StickerMediumChoice = (typeof STICKER_MEDIUM_IDS)[number];

/** A fixed medium's sticker size, for the preview; the custom size is the person's. */
export const STICKER_SIZES: Readonly<
  Record<Exclude<StickerMediumChoice, 'custom'>, { widthMm: number; heightMm: number }>
> = {
  'thermal-38x25': { widthMm: 38, heightMm: 25 },
  'thermal-40x30': { widthMm: 40, heightMm: 30 },
  'thermal-45x35': { widthMm: 45, heightMm: 35 },
  'thermal-50x25': { widthMm: 50, heightMm: 25 },
  'a4-3x8': { widthMm: 63.5, heightMm: 33.9 },
  'a4-4x10': { widthMm: 48.5, heightMm: 25.4 },
};

/** A sheet's laser-printer module (D-604), which the layout keeps; a roll's is chosen. */
export const SHEET_MODULE_MM: Readonly<Partial<Record<StickerMediumChoice, number>>> = {
  'a4-3x8': 0.375,
  'a4-4x10': 0.33,
};

export { STICKER_EXTRA_LINE_MAX, STICKER_SIZE_LIMITS };

/** Positions on one sheet, for the "start at" box; a roll has none. */
export function positionsOn(medium: StickerMediumChoice): number {
  return medium === 'a4-3x8' ? 24 : medium === 'a4-4x10' ? 40 : 0;
}

/** The most stickers in one PDF; the server refuses more (`MAX_STICKERS_PER_PDF`). */
export const STICKERS_PER_PRINT = 1000;

export interface StickerLine {
  readonly skuId: string;
  readonly copies: number;
}

/**
 * Split a print into PDFs of at most `max` stickers, in order, cutting a SKU's run between
 * two parts when it straddles the boundary. Lines with no copies are left out.
 */
export function stickerPrints(
  lines: readonly StickerLine[],
  max: number = STICKERS_PER_PRINT,
): StickerLine[][] {
  const parts: StickerLine[][] = [];
  let current: StickerLine[] = [];
  let room = max;
  for (const line of lines) {
    let left = Math.max(0, Math.floor(line.copies));
    while (left > 0) {
      const take = Math.min(left, room);
      current.push({ skuId: line.skuId, copies: take });
      left -= take;
      room -= take;
      if (room === 0) {
        parts.push(current);
        current = [];
        room = max;
      }
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/** What the person chose last time, on this device (D-604, D-652). */
export interface StickerPrefs {
  readonly medium: StickerMediumChoice;
  readonly showPrice: boolean;
  /** The custom size, kept even while a fixed medium is chosen. */
  readonly widthMm: number;
  readonly heightMm: number;
  /** The extra line; empty for none. */
  readonly extraLine: string;
}

/** On by default for clothing tags (D-604); the person's last choice after that. */
export const DEFAULT_STICKER_PREFS: StickerPrefs = {
  medium: 'thermal-38x25',
  showPrice: true,
  widthMm: 40,
  heightMm: 30,
  extraLine: '',
};

function storageKey(userId: string): string {
  return `erp-stickers:${userId}`;
}

/** The person's last choice, or the defaults for anything unreadable. Never throws. */
export function readStickerPrefs(userId: string, storage?: Storage): StickerPrefs {
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(storageKey(userId));
    if (raw === null) return DEFAULT_STICKER_PREFS;
    const parsed = JSON.parse(raw) as Partial<Record<keyof StickerPrefs, unknown>>;
    const medium =
      STICKER_MEDIUM_IDS.find((value) => value === parsed.medium) ?? DEFAULT_STICKER_PREFS.medium;
    const width = stickerWidthMmSchema.safeParse(parsed.widthMm);
    const height = stickerHeightMmSchema.safeParse(parsed.heightMm);
    const extra = stickerExtraLineSchema.safeParse(parsed.extraLine);
    return {
      medium,
      showPrice:
        typeof parsed.showPrice === 'boolean' ? parsed.showPrice : DEFAULT_STICKER_PREFS.showPrice,
      widthMm: width.success ? width.data : DEFAULT_STICKER_PREFS.widthMm,
      heightMm: height.success ? height.data : DEFAULT_STICKER_PREFS.heightMm,
      extraLine: extra.success ? extra.data : DEFAULT_STICKER_PREFS.extraLine,
    };
  } catch {
    return DEFAULT_STICKER_PREFS;
  }
}

export function writeStickerPrefs(userId: string, prefs: StickerPrefs, storage?: Storage): void {
  try {
    (storage ?? globalThis.localStorage).setItem(storageKey(userId), JSON.stringify(prefs));
  } catch {
    // Private browsing: the choice holds for this print only.
  }
}

/** A whole number of stickers from a text box, or null (blank, negative, a fraction). */
export function parseCopies(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value <= 10_000 ? value : null;
}

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

/**
 * Millimetres from a text box: digits with at most one decimal (`32.5`, `32,5`, Bangla
 * digits too), or null for anything else.
 */
export function parseMm(text: string): number | null {
  const normalised = [...text.trim()]
    .map((character) => {
      const bangla = BANGLA_DIGITS.indexOf(character);
      return bangla >= 0 ? String(bangla) : character === ',' ? '.' : character;
    })
    .join('');
  if (!/^\d{1,3}(\.\d)?$/.test(normalised)) return null;
  return Number(normalised);
}

/** What is wrong with a custom size, for the dialog to say in the person's language. */
export type StickerSizeProblem =
  /** Not a number of millimetres with at most one decimal. */
  | { readonly kind: 'number'; readonly field: 'width' | 'height' }
  /** Outside `STICKER_SIZE_LIMITS`. */
  | { readonly kind: 'range'; readonly field: 'width' | 'height' }
  /** In range, but no scannable barcode fits: the layout's own refusal (D-650). */
  | { readonly kind: 'too-narrow'; readonly field: 'width'; readonly minMm: number }
  | { readonly kind: 'too-short'; readonly field: 'height'; readonly minMm: number };

/**
 * Check a custom size as typed: the format, the server's range, then whether the layout can
 * hold a barcode a scanner reads with this content. Every problem, width first; none when
 * the size will print.
 */
export function customSizeProblems(
  widthText: string,
  heightText: string,
  content: StickerContent,
): StickerSizeProblem[] {
  const problems: StickerSizeProblem[] = [];
  const width = parseMm(widthText);
  const height = parseMm(heightText);
  if (width === null) problems.push({ kind: 'number', field: 'width' });
  else if (!stickerWidthMmSchema.safeParse(width).success) {
    problems.push({ kind: 'range', field: 'width' });
  }
  if (height === null) problems.push({ kind: 'number', field: 'height' });
  else if (!stickerHeightMmSchema.safeParse(height).success) {
    problems.push({ kind: 'range', field: 'height' });
  }
  if (problems.length > 0 || width === null || height === null) return problems;

  const layout = stickerLayout(width, height, content);
  if (!layout.ok) {
    problems.push(
      layout.reason === 'too-narrow'
        ? { kind: 'too-narrow', field: 'width', minMm: layout.minWidthMm }
        : { kind: 'too-short', field: 'height', minMm: layout.minHeightMm },
    );
  }
  return problems;
}

/** `Linen Panjabi · M / White` → the name and the variant, for the preview. */
export function splitItemLabel(label: string): { name: string; variant: string } {
  const at = label.indexOf(' · ');
  return at < 0
    ? { name: label, variant: '' }
    : { name: label.slice(0, at), variant: label.slice(at + 3) };
}

/** `32.5` for 32.5 and `45` for 45: a size as a person would type it. */
export function formatMm(value: number): string {
  return String(Math.round(value * 10) / 10);
}
