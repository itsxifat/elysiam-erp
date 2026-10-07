import { describe, expect, it } from 'vitest';

import {
  MAX_CROP_WIDTH,
  SHOP_PHOTO_ASPECT,
  centredView,
  clampOffset,
  cropRect,
  zoomAboutCentre,
} from './photo-crop.js';
import {
  DEFAULT_STICKER_PREFS,
  STICKERS_PER_PRINT,
  STICKER_MEDIUM_IDS,
  customSizeProblems,
  parseCopies,
  parseMm,
  positionsOn,
  readStickerPrefs,
  splitItemLabel,
  stickerPrints,
  writeStickerPrefs,
} from './stickers-plan.js';
import { addScannedPiece, variantForCode } from './variant-grid.js';

/**
 * The console's pure parts of M38a (D-601, D-604, D-605): splitting a big print into PDFs,
 * the remembered sticker choice, the photo crop arithmetic, and a scan landing on a variant.
 */

/** A small seeded generator: the same cases on every run, many of them. */
function generator(seed: number) {
  let state = seed;
  return (min: number, max: number) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return min + (state % (max - min + 1));
  };
}

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('a print split into PDFs', () => {
  it('keeps every sticker, in order, and no PDF over the limit', () => {
    const next = generator(38);
    for (let run = 0; run < 300; run += 1) {
      const lines = Array.from({ length: next(0, 12) }, (_, index) => ({
        skuId: `sku-${String(index)}`,
        copies: next(0, 900),
      }));
      const max = next(1, 1000);
      const parts = stickerPrints(lines, max);
      const expand = (entries: readonly { skuId: string; copies: number }[]) =>
        entries.flatMap((line) => Array.from({ length: line.copies }, () => line.skuId));
      expect(expand(parts.flat())).toEqual(expand(lines));
      for (const part of parts) {
        const count = part.reduce((sum, line) => sum + line.copies, 0);
        expect(count).toBeGreaterThan(0);
        expect(count).toBeLessThanOrEqual(max);
      }
    }
  });

  it('is one PDF up to a thousand stickers', () => {
    expect(stickerPrints([{ skuId: 'a', copies: STICKERS_PER_PRINT }])).toHaveLength(1);
    expect(stickerPrints([{ skuId: 'a', copies: STICKERS_PER_PRINT + 1 }])).toHaveLength(2);
  });

  it('knows which stock has positions to skip', () => {
    expect(positionsOn('a4-3x8')).toBe(24);
    expect(positionsOn('a4-4x10')).toBe(40);
    expect(positionsOn('thermal-38x25')).toBe(0);
    expect(positionsOn('thermal-45x35')).toBe(0);
    expect(positionsOn('custom')).toBe(0);
    // D-650: the 45 × 35 roll beside the others, and the custom size last.
    expect(STICKER_MEDIUM_IDS).toEqual([
      'thermal-38x25',
      'thermal-40x30',
      'thermal-45x35',
      'thermal-50x25',
      'a4-3x8',
      'a4-4x10',
      'custom',
    ]);
  });

  it('reads a sticker count from a box', () => {
    expect(parseCopies('12')).toBe(12);
    expect(parseCopies(' 0 ')).toBe(0);
    expect(parseCopies('-1')).toBeNull();
    expect(parseCopies('1.5')).toBeNull();
    expect(parseCopies('')).toBeNull();
  });
});

describe('the remembered sticker choice', () => {
  it('starts on a thermal roll with the price on, and remembers per person', () => {
    const storage = new MemoryStorage() as unknown as Storage;
    expect(readStickerPrefs('usr_a', storage)).toEqual(DEFAULT_STICKER_PREFS);
    expect(DEFAULT_STICKER_PREFS.showPrice).toBe(true);
    writeStickerPrefs(
      'usr_a',
      { ...DEFAULT_STICKER_PREFS, medium: 'a4-4x10', showPrice: false },
      storage,
    );
    expect(readStickerPrefs('usr_a', storage)).toEqual({
      ...DEFAULT_STICKER_PREFS,
      medium: 'a4-4x10',
      showPrice: false,
    });
    expect(readStickerPrefs('usr_b', storage)).toEqual(DEFAULT_STICKER_PREFS);
  });

  it('remembers the custom size and the extra line (D-652)', () => {
    const storage = new MemoryStorage() as unknown as Storage;
    const chosen = {
      medium: 'custom',
      showPrice: false,
      widthMm: 32.5,
      heightMm: 20,
      extraLine: 'Made in Bangladesh',
    } as const;
    writeStickerPrefs('usr_a', chosen, storage);
    expect(readStickerPrefs('usr_a', storage)).toEqual(chosen);
    // A size or a line the server would refuse is not brought back.
    storage.setItem(
      'erp-stickers:usr_a',
      JSON.stringify({ ...chosen, widthMm: 300, heightMm: 'tall', extraLine: 'x'.repeat(41) }),
    );
    expect(readStickerPrefs('usr_a', storage)).toEqual({
      ...chosen,
      widthMm: DEFAULT_STICKER_PREFS.widthMm,
      heightMm: DEFAULT_STICKER_PREFS.heightMm,
      extraLine: '',
    });
  });

  it('falls back to the defaults on anything it cannot read', () => {
    const storage = new MemoryStorage() as unknown as Storage;
    storage.setItem('erp-stickers:usr_a', '{"medium":"a5","showPrice":"yes"}');
    expect(readStickerPrefs('usr_a', storage)).toEqual(DEFAULT_STICKER_PREFS);
    storage.setItem('erp-stickers:usr_a', 'not json');
    expect(readStickerPrefs('usr_a', storage)).toEqual(DEFAULT_STICKER_PREFS);
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(readStickerPrefs('usr_a', broken)).toEqual(DEFAULT_STICKER_PREFS);
  });
});

describe('the custom sticker size in the dialog (D-650)', () => {
  const content = { price: true, variant: false, extra: false };

  it('reads millimetres with one decimal at most, in either digits', () => {
    expect(parseMm('32.5')).toBe(32.5);
    expect(parseMm(' 45 ')).toBe(45);
    expect(parseMm('32,5')).toBe(32.5);
    expect(parseMm('৩২.৫')).toBe(32.5);
    expect(parseMm('32.55')).toBeNull();
    expect(parseMm('-30')).toBeNull();
    expect(parseMm('')).toBeNull();
    expect(parseMm('3e1')).toBeNull();
    expect(parseMm('1000')).toBeNull();
  });

  it('accepts a size the server prints', () => {
    expect(customSizeProblems('45', '35', content)).toEqual([]);
    expect(customSizeProblems('32.5', '20', content)).toEqual([]);
    expect(customSizeProblems('110', '100', content)).toEqual([]);
    expect(customSizeProblems('29.3', '15', content)).toEqual([]);
  });

  it('says which box is wrong: not a number, or out of range', () => {
    expect(customSizeProblems('abc', '20', content)).toEqual([{ kind: 'number', field: 'width' }]);
    expect(customSizeProblems('40', '20.25', content)).toEqual([
      { kind: 'number', field: 'height' },
    ]);
    expect(customSizeProblems('24.9', '100.1', content)).toEqual([
      { kind: 'range', field: 'width' },
      { kind: 'range', field: 'height' },
    ]);
    expect(customSizeProblems('111', '14', content)).toEqual([
      { kind: 'range', field: 'width' },
      { kind: 'range', field: 'height' },
    ]);
  });

  it('refuses a size in range that cannot hold a scannable barcode, with the least that can', () => {
    expect(customSizeProblems('25', '20', content)).toEqual([
      { kind: 'too-narrow', field: 'width', minMm: 29.3 },
    ]);
    expect(customSizeProblems('29.2', '40', content)).toEqual([
      { kind: 'too-narrow', field: 'width', minMm: 29.3 },
    ]);
  });

  it('agrees with the range on every size a person can type', () => {
    const next = generator(650);
    for (let run = 0; run < 500; run += 1) {
      const width = next(200, 1200) / 10;
      const height = next(100, 1100) / 10;
      const problems = customSizeProblems(String(width), String(height), content);
      const inRange = width >= 25 && width <= 110 && height >= 15 && height <= 100;
      if (!inRange) expect(problems.some((problem) => problem.kind === 'range')).toBe(true);
      else if (width < 29.25)
        expect(problems).toEqual([{ kind: 'too-narrow', field: 'width', minMm: 29.3 }]);
      else expect(problems).toEqual([]);
    }
  });

  it('splits an item into the name and the variant for the preview', () => {
    expect(splitItemLabel('Linen Panjabi · M / White')).toEqual({
      name: 'Linen Panjabi',
      variant: 'M / White',
    });
    expect(splitItemLabel('Tote bag')).toEqual({ name: 'Tote bag', variant: '' });
  });
});

describe('cropping a photo to the shop’s shape', () => {
  const frame = { width: 240, height: 320 };

  it('covers the frame, stays inside the photo and saves at the shop’s shape', () => {
    const next = generator(601);
    for (let run = 0; run < 300; run += 1) {
      const width = next(200, 6000);
      const height = next(200, 6000);
      const zoom = 1 + next(0, 300) / 100;
      const start = centredView(frame.width, frame.height, width, height);
      const zoomed = zoomAboutCentre(start, zoom);
      const moved = {
        ...zoomed,
        ...clampOffset({
          ...zoomed,
          offsetX: zoomed.offsetX + next(-5000, 5000),
          offsetY: zoomed.offsetY + next(-5000, 5000),
        }),
      };
      const rect = cropRect(moved);
      expect(rect.sx).toBeGreaterThanOrEqual(0);
      expect(rect.sy).toBeGreaterThanOrEqual(0);
      expect(rect.sx + rect.sw).toBeLessThanOrEqual(width + 1e-6);
      expect(rect.sy + rect.sh).toBeLessThanOrEqual(height + 1e-6);
      expect(rect.width).toBeLessThanOrEqual(MAX_CROP_WIDTH);
      // The saved photo is 3 wide by 4 tall, to the pixel.
      expect(Math.abs(rect.width / rect.height - SHOP_PHOTO_ASPECT)).toBeLessThan(0.01);
    }
  });

  it('crops a landscape photo to its centre at first', () => {
    const view = centredView(frame.width, frame.height, 1600, 1200);
    const rect = cropRect(view);
    // 1200 tall, so 900 wide, centred: 350 off each side.
    expect(rect.sh).toBeCloseTo(1200, 3);
    expect(rect.sw).toBeCloseTo(900, 3);
    expect(rect.sx).toBeCloseTo(350, 3);
    expect(rect.sy).toBeCloseTo(0, 3);
  });
});

describe('a scan landing on one of a product’s variants', () => {
  const variants = [
    { id: 'm', skuCode: 'BR-PNJ-0042-M', barcode: '2000000000015' },
    { id: 'l', skuCode: 'BR-PNJ-0042-L', barcode: null },
  ];

  it('matches the barcode exactly, or the SKU code in any case', () => {
    expect(variantForCode(variants, '2000000000015')?.id).toBe('m');
    expect(variantForCode(variants, 'br-pnj-0042-l')?.id).toBe('l');
    expect(variantForCode(variants, '2000000000022')).toBeUndefined();
  });

  it('adds one piece per scan, from a blank box or a typed number', () => {
    let quantities: Record<string, string> = {};
    quantities = addScannedPiece(quantities, 'm');
    quantities = addScannedPiece(quantities, 'm');
    expect(quantities.m).toBe('2');
    expect(addScannedPiece({ l: '7' }, 'l').l).toBe('8');
    expect(addScannedPiece({ l: 'x' }, 'l').l).toBe('1');
  });
});
