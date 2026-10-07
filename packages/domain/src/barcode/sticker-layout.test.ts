import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { EAN13_TOTAL_MODULES } from './ean13.js';
import {
  MIN_STICKER_BAR_MM,
  MIN_STICKER_MODULE_MM,
  MIN_STICKER_WIDTH_MM,
  STICKER_DROP_ORDER,
  STICKER_EDGE_MM,
  stickerLayout,
  type StickerContent,
  type StickerLayout,
} from './sticker-layout.js';
import {
  STICKER_MEDIA,
  STICKER_MEDIA_IDS,
  customStickerMedium,
  stickerLayoutFor,
} from './stickers.js';

/**
 * The sticker layout (D-650): one rule for every size, fixed or typed in. Sizes range over
 * the custom size's limits (`STICKER_SIZE_LIMITS` in `@elysium/contracts`: 25 to 110 mm wide,
 * 15 to 100 mm tall, to a tenth), and a little past them, where the rule must still hold.
 */

const EPSILON = 1e-6;

/** A size in tenths of a millimetre, as the dialog takes it. */
const tenths = (min: number, max: number) =>
  fc.integer({ min: Math.round(min * 10), max: Math.round(max * 10) }).map((value) => value / 10);

const content: fc.Arbitrary<StickerContent> = fc.record(
  {
    price: fc.boolean(),
    variant: fc.boolean(),
    extra: fc.boolean(),
    nameLength: fc.integer({ min: 1, max: 120 }),
  },
  { requiredKeys: ['price', 'variant', 'extra'] },
);

function wanted(
  line: (typeof STICKER_DROP_ORDER)[number],
  what: StickerContent,
  layout: StickerLayout,
) {
  switch (line) {
    case 'name2':
      return (
        layout.scale.nameLines === 2 &&
        (what.nameLength === undefined || what.nameLength > layout.chars.name)
      );
    case 'extra':
      return what.extra;
    case 'variant':
      return what.variant;
    case 'code':
    case 'name':
      return true;
  }
}

describe('the sticker layout (D-650)', () => {
  it('never draws outside the sticker, and no two rows overlap', () => {
    fc.assert(
      fc.property(tenths(20, 115), tenths(10, 105), content, (width, height, what) => {
        const layout = stickerLayout(width, height, what);
        if (!layout.ok) return;
        expect(layout.innerWidthMm).toBeGreaterThan(0);
        let previousBottom = layout.padYMm - EPSILON;
        for (const row of layout.rows) {
          expect(row.heightMm).toBeGreaterThan(0);
          expect(row.yMm).toBeGreaterThanOrEqual(previousBottom - EPSILON);
          previousBottom = row.yMm + row.heightMm;
        }
        expect(previousBottom).toBeLessThanOrEqual(height - layout.padYMm + EPSILON);
        // The symbol with its quiet zones stays clear of the die-cut's edge.
        expect(layout.symbolXMm).toBeGreaterThanOrEqual(STICKER_EDGE_MM - EPSILON);
        expect(layout.symbolXMm + layout.symbolWidthMm).toBeLessThanOrEqual(
          width - STICKER_EDGE_MM + EPSILON,
        );
        const symbol = layout.rows.find((row) => row.kind === 'symbol');
        expect(symbol?.heightMm).toBeCloseTo(layout.symbolHeightMm, 3);
      }),
      { numRuns: 2000 },
    );
  });

  it('never prints a barcode under the scannable minimum, and refuses a size that cannot hold one', () => {
    fc.assert(
      fc.property(tenths(20, 115), tenths(15, 100), content, (width, height, what) => {
        const layout = stickerLayout(width, height, what);
        if (!layout.ok) {
          // Within the custom heights the only thing that refuses is the width: 29.25 mm.
          expect(width).toBeLessThan(MIN_STICKER_WIDTH_MM);
          expect(layout.reason).toBe('too-narrow');
          expect(layout.minWidthMm).toBe(29.3);
          expect(layout.message).toContain('29.3 mm');
          return;
        }
        expect(width).toBeGreaterThanOrEqual(MIN_STICKER_WIDTH_MM);
        expect(layout.moduleMm).toBeGreaterThanOrEqual(MIN_STICKER_MODULE_MM);
        // A roll's module is a whole number of 203 dpi dots (0.125 mm).
        expect(Number.isInteger(Math.round((layout.moduleMm / 0.125) * 1e6) / 1e6)).toBe(true);
        expect(layout.barHeightMm).toBeGreaterThanOrEqual(MIN_STICKER_BAR_MM - EPSILON);
        expect(layout.symbolWidthMm).toBeCloseTo(EAN13_TOTAL_MODULES * layout.moduleMm, 3);
        // The brand and price row and the barcode with its digits are always there.
        expect(layout.rows[0]?.kind).toBe('top');
        expect(layout.rows.some((row) => row.kind === 'symbol')).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it('refuses a sticker too short for the barcode, saying how tall it must be', () => {
    const short = stickerLayout(60, 12, { price: true, variant: true, extra: true });
    expect(short.ok).toBe(false);
    if (!short.ok) {
      expect(short.reason).toBe('too-short');
      expect(short.minHeightMm).toBeGreaterThan(12);
      expect(short.message).toContain(`${String(short.minHeightMm)} mm tall`);
      expect(
        stickerLayout(60, short.minHeightMm, { price: true, variant: true, extra: true }).ok,
      ).toBe(true);
    }
    expect(stickerLayout(Number.NaN, 20, { price: true, variant: true, extra: false }).ok).toBe(
      false,
    );
  });

  it('is deterministic: the same size and content always give the same layout', () => {
    fc.assert(
      fc.property(tenths(25, 110), tenths(15, 100), content, (width, height, what) => {
        expect(stickerLayout(width, height, what)).toEqual(
          stickerLayout(width, height, { ...what }),
        );
      }),
      { numRuns: 500 },
    );
  });

  it('gives lines up in the stated order: the extra line, the SKU code, size and colour, the name', () => {
    fc.assert(
      fc.property(tenths(29.3, 110), tenths(15, 100), content, (width, height, what) => {
        const layout = stickerLayout(width, height, what);
        if (!layout.ok) return;
        const order = STICKER_DROP_ORDER.filter((line) => wanted(line, what, layout));
        // What was given up is the start of the order, in order: never a line before a less
        // important one.
        expect(layout.dropped).toEqual(order.slice(0, layout.dropped.length));
        expect(layout.lines.extra).toBe(what.extra && !layout.dropped.includes('extra'));
        expect(layout.lines.code).toBe(!layout.dropped.includes('code'));
        expect(layout.lines.variant).toBe(what.variant && !layout.dropped.includes('variant'));
        expect(layout.lines.name).toBe(!layout.dropped.includes('name'));
        const kinds = layout.rows.map((row) => row.kind);
        expect(kinds.includes('extra')).toBe(layout.lines.extra);
        expect(kinds.includes('code')).toBe(layout.lines.code);
        expect(kinds.includes('variant')).toBe(layout.lines.variant);
        expect(kinds.includes('name')).toBe(layout.lines.name);
      }),
      { numRuns: 2000 },
    );
    // A short sticker shows it: the extra line and the SKU code go, the name and size stay.
    const small = stickerLayout(32.5, 20, { price: true, variant: true, extra: true });
    expect(small.ok && small.dropped).toEqual(['extra', 'code']);
    // The smallest height keeps only what is never given up.
    const tiny = stickerLayout(29.3, 15, { price: true, variant: true, extra: true });
    expect(tiny.ok && tiny.rows.map((row) => row.kind)).toEqual(['top', 'symbol']);
  });

  it('draws the fixed sizes as D-604 did, and 45 × 35 with room for everything', () => {
    const full = { price: true, variant: true, extra: false };
    const at = (id: (typeof STICKER_MEDIA_IDS)[number], what: StickerContent = full) => {
      const layout = stickerLayoutFor(STICKER_MEDIA[id], what);
      if (!layout.ok) throw new Error(layout.message);
      return layout;
    };
    // 0.25 mm (2 dots) on the 38 and 40 mm rolls, 0.375 mm (3 dots) on 45 and 50 mm.
    expect(at('thermal-38x25')).toMatchObject({ moduleMm: 0.25, barModules: 28, barHeightMm: 7 });
    expect(at('thermal-40x30').moduleMm).toBe(0.25);
    expect(at('thermal-50x25')).toMatchObject({ moduleMm: 0.375, barModules: 19 });
    expect(at('thermal-45x35').moduleMm).toBe(0.375);
    expect(at('thermal-45x35').nameLines).toBe(2);
    // A sheet keeps the laser printer's module D-604 chose.
    expect(at('a4-3x8').moduleMm).toBe(0.375);
    expect(at('a4-4x10').moduleMm).toBe(0.33);
    // Every fixed medium holds every line, the extra line included.
    for (const id of STICKER_MEDIA_IDS) {
      expect(at(id).dropped).toEqual([]);
      expect(at(id, { ...full, extra: true }).dropped).toEqual([]);
    }
    // A short name takes one line on a two-line size, a long one two, and the room a short
    // name leaves goes to the bars.
    const short = at('thermal-45x35', { ...full, nameLength: 12 });
    const long = at('thermal-45x35', { ...full, nameLength: 60 });
    expect(short.nameLines).toBe(1);
    expect(long.nameLines).toBe(2);
    expect(short.dropped).toEqual([]);
    expect(short.barHeightMm).toBeGreaterThanOrEqual(long.barHeightMm);
    // A custom size equal to a fixed one is laid out the same: one rule.
    expect(stickerLayoutFor(customStickerMedium(45, 35), full)).toEqual(at('thermal-45x35'));
  });
});
