/**
 * The pure parts of the sticker dialog (M38a, D-604). No imports, so the unit test loads it
 * without the API client.
 */

export const STICKER_MEDIUM_IDS = [
  'thermal-38x25',
  'thermal-40x30',
  'thermal-50x25',
  'a4-3x8',
  'a4-4x10',
] as const;

export type StickerMediumChoice = (typeof STICKER_MEDIUM_IDS)[number];

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

export interface StickerPrefs {
  readonly medium: StickerMediumChoice;
  readonly showPrice: boolean;
}

/** On by default for clothing tags (D-604); the person's last choice after that. */
export const DEFAULT_STICKER_PREFS: StickerPrefs = { medium: 'thermal-38x25', showPrice: true };

function storageKey(userId: string): string {
  return `erp-stickers:${userId}`;
}

/** The person's last choice of stock and price, or the defaults. Never throws. */
export function readStickerPrefs(userId: string, storage?: Storage): StickerPrefs {
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(storageKey(userId));
    if (raw === null) return DEFAULT_STICKER_PREFS;
    const parsed = JSON.parse(raw) as Partial<StickerPrefs>;
    const medium =
      STICKER_MEDIUM_IDS.find((value) => value === parsed.medium) ?? DEFAULT_STICKER_PREFS.medium;
    return {
      medium,
      showPrice:
        typeof parsed.showPrice === 'boolean' ? parsed.showPrice : DEFAULT_STICKER_PREFS.showPrice,
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
