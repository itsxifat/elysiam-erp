import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  EAN13_MAX_SEQUENCE,
  EAN13_PATTERNS,
  Ean13Error,
  MAX_STICKERS_PER_PDF,
  STICKER_MEDIA,
  STICKER_MEDIA_IDS,
  StickerLayoutError,
  createScanDetector,
  detectScans,
  ean13CheckDigit,
  ean13Modules,
  ean13Svg,
  fitStickerText,
  internalEan13,
  internalEan13Sequence,
  isInternalEan13,
  isValidEan13,
  normaliseScannedCode,
  stickerPageSize,
  stickerPages,
  stickerParts,
  stickersPerPage,
  type ScanKey,
} from './index.js';

/**
 * M38a's barcode arithmetic (D-603 to D-605): the EAN-13 check digit and symbol, the
 * sticker layout, and the scanner-versus-typing detector.
 *
 * The decoder below is the test's own, written from the symbology rather than from the
 * encoder: reading every encoded symbol back to the digits it was made from is what proves
 * the thirty transcribed patterns and the parity table, because a wrong pattern either fails
 * to decode or decodes to another digit.
 */

const digits12 = fc.stringMatching(/^\d{12}$/);

function decode(modules: string): string | null {
  if (modules.length !== 95) return null;
  if (!modules.startsWith('101') || modules.slice(45, 50) !== '01010') return null;
  if (modules.slice(92) !== '101') return null;
  const parity: string[] = [];
  const out: number[] = [];
  for (let index = 0; index < 6; index += 1) {
    const chunk = modules.slice(3 + index * 7, 10 + index * 7);
    const l = EAN13_PATTERNS.L.indexOf(chunk as (typeof EAN13_PATTERNS.L)[number]);
    const g = EAN13_PATTERNS.G.indexOf(chunk as (typeof EAN13_PATTERNS.G)[number]);
    if (l >= 0) {
      parity.push('L');
      out.push(l);
    } else if (g >= 0) {
      parity.push('G');
      out.push(g);
    } else return null;
  }
  for (let index = 0; index < 6; index += 1) {
    const chunk = modules.slice(50 + index * 7, 57 + index * 7);
    const r = EAN13_PATTERNS.R.indexOf(chunk as (typeof EAN13_PATTERNS.R)[number]);
    if (r < 0) return null;
    out.push(r);
  }
  const first = EAN13_PATTERNS.PARITY.indexOf(
    parity.join('') as (typeof EAN13_PATTERNS.PARITY)[number],
  );
  if (first < 0) return null;
  return `${String(first)}${out.join('')}`;
}

describe('EAN-13 check digit', () => {
  it('matches published examples', () => {
    // 400638133393-1 is the symbology's textbook example; 5901234123457 the GS1 sample.
    expect(ean13CheckDigit('400638133393')).toBe(1);
    expect(isValidEan13('4006381333931')).toBe(true);
    expect(isValidEan13('5901234123457')).toBe(true);
    expect(isValidEan13('5901234123458')).toBe(false);
  });

  it('makes any twelve digits valid, and catches every single-digit error', () => {
    fc.assert(
      fc.property(
        digits12,
        fc.integer({ min: 0, max: 12 }),
        fc.integer({ min: 1, max: 9 }),
        (body, at, shift) => {
          const code = `${body}${String(ean13CheckDigit(body))}`;
          expect(isValidEan13(code)).toBe(true);
          // Any one digit changed to any other is caught: weights 1 and 3 are coprime with 10.
          const digit = (code.charCodeAt(at) - 48 + shift) % 10;
          const broken = `${code.slice(0, at)}${String(digit)}${code.slice(at + 1)}`;
          expect(isValidEan13(broken)).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('refuses anything but twelve digits', () => {
    expect(() => ean13CheckDigit('12345')).toThrow(Ean13Error);
    expect(() => ean13CheckDigit('40063813339A')).toThrow(Ean13Error);
    expect(isValidEan13('400638133393')).toBe(false);
    expect(isValidEan13('400638133393１')).toBe(false);
  });
});

describe('internal EAN-13 numbers', () => {
  it('is 2, eleven digits of sequence and a check digit', () => {
    expect(internalEan13(1)).toBe('2000000000015');
    expect(internalEan13(42)).toMatch(/^200000000042\d$/);
    expect(isInternalEan13(internalEan13(42))).toBe(true);
    expect(isInternalEan13('4006381333931')).toBe(false);
  });

  it('is valid, in range and unique for every sequence', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: EAN13_MAX_SEQUENCE }),
        fc.integer({ min: 1, max: EAN13_MAX_SEQUENCE }),
        (a, b) => {
          const code = internalEan13(a);
          expect(code).toHaveLength(13);
          expect(isInternalEan13(code)).toBe(true);
          expect(internalEan13Sequence(code)).toBe(a);
          if (a !== b) expect(internalEan13(b)).not.toBe(code);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('refuses a sequence it cannot carry', () => {
    expect(() => internalEan13(0)).toThrow(Ean13Error);
    expect(() => internalEan13(EAN13_MAX_SEQUENCE + 1)).toThrow(Ean13Error);
    expect(() => internalEan13(1.5)).toThrow(Ean13Error);
    expect(internalEan13Sequence('5901234123457')).toBeNull();
  });
});

describe('EAN-13 symbol', () => {
  it('encodes to 95 modules that decode back to the same digits', () => {
    fc.assert(
      fc.property(digits12, (body) => {
        const code = `${body}${String(ean13CheckDigit(body))}`;
        const modules = ean13Modules(code);
        expect(modules).toHaveLength(95);
        expect(decode(modules)).toBe(code);
      }),
      { numRuns: 500 },
    );
  });

  it('has thirty distinct seven-module patterns with the right shape', () => {
    const all = [...EAN13_PATTERNS.L, ...EAN13_PATTERNS.G, ...EAN13_PATTERNS.R];
    expect(new Set(all).size).toBe(30);
    for (const pattern of all) expect(pattern).toMatch(/^[01]{7}$/);
    // Left-half patterns start with a space and end with a bar; right-half the reverse.
    for (const pattern of [...EAN13_PATTERNS.L, ...EAN13_PATTERNS.G]) {
      expect(pattern.startsWith('0') && pattern.endsWith('1')).toBe(true);
    }
    for (const pattern of EAN13_PATTERNS.R) {
      expect(pattern.startsWith('1') && pattern.endsWith('0')).toBe(true);
    }
  });

  it('refuses to draw a code whose check digit is wrong', () => {
    expect(() => ean13Modules('4006381333932')).toThrow(Ean13Error);
    expect(() => ean13Svg('ELY-0001')).toThrow(Ean13Error);
  });

  it('draws whole-module bars, longer guards and the thirteen digits', () => {
    const code = internalEan13(7);
    const svg = ean13Svg(code, { barHeight: 40 });
    const rects = [...svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)" height="(\d+)"\/>/g)];
    const modules = ean13Modules(code);
    // Every bar module is covered exactly once by an integer rect.
    const covered = new Array<number>(95).fill(0);
    for (const rect of rects) {
      const x = Number(rect[1]) - 11;
      for (let at = x; at < x + Number(rect[2]); at += 1) covered[at] = (covered[at] ?? 0) + 1;
    }
    expect(covered.map((value) => String(value)).join('')).toBe(modules);
    expect(rects.filter((rect) => rect[3] === '45')).toHaveLength(6); // 2 + 2 + 2 guard bars
    expect([...svg.matchAll(/<text /g)]).toHaveLength(13);
    expect(svg).toContain('viewBox="0 0 113 50"');
  });
});

describe('sticker layout', () => {
  it('puts one sticker per page on a roll, at the roll size', () => {
    const roll = STICKER_MEDIA['thermal-38x25'];
    expect(stickerPages(3, roll)).toEqual([[0], [1], [2]]);
    expect(stickerPageSize(roll)).toEqual({ widthMm: 38, heightMm: 25 });
    expect(() => stickerPages(3, roll, 2)).toThrow(StickerLayoutError);
  });

  it('fills a sheet from the start position and never loses or repeats a sticker', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...STICKER_MEDIA_IDS),
        fc.integer({ min: 1, max: MAX_STICKERS_PER_PDF }),
        fc.integer({ min: 1, max: 40 }),
        (id, count, start) => {
          const medium = STICKER_MEDIA[id];
          const perPage = stickersPerPage(medium);
          const startAt = medium.kind === 'roll' ? 1 : Math.min(start, perPage);
          const pages = stickerPages(count, medium, startAt);
          const flat = pages.flat();
          expect(flat.filter((slot) => slot === null)).toHaveLength(startAt - 1);
          expect(flat.filter((slot) => slot !== null)).toEqual(
            Array.from({ length: count }, (_, index) => index),
          );
          for (const page of pages) expect(page.length).toBeLessThanOrEqual(perPage);
          expect(pages).toHaveLength(Math.ceil((count + startAt - 1) / perPage));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('fits every sheet inside A4 and every barcode inside its sticker', () => {
    for (const id of STICKER_MEDIA_IDS) {
      const medium = STICKER_MEDIA[id];
      // 113 modules: the symbol and both quiet zones.
      expect(113 * medium.moduleMm).toBeLessThan(medium.labelWidthMm);
      if (medium.kind === 'sheet') {
        const width =
          medium.marginLeftMm +
          medium.columns * medium.labelWidthMm +
          (medium.columns - 1) * medium.gapXMm;
        const height =
          medium.marginTopMm +
          medium.rows * medium.labelHeightMm +
          (medium.rows - 1) * medium.gapYMm;
        expect(width).toBeLessThanOrEqual(medium.pageWidthMm);
        expect(height).toBeLessThanOrEqual(medium.pageHeightMm);
      }
    }
  });

  it('refuses nothing to print and more than one PDF holds', () => {
    expect(() => stickerPages(0, STICKER_MEDIA['a4-3x8'])).toThrow(StickerLayoutError);
    expect(() => stickerPages(MAX_STICKERS_PER_PDF + 1, STICKER_MEDIA['a4-3x8'])).toThrow(
      StickerLayoutError,
    );
    expect(() => stickerPages(1, STICKER_MEDIA['a4-3x8'], 25)).toThrow(StickerLayoutError);
  });

  it('splits a long run into parts that cover it exactly', () => {
    expect(stickerParts(2500)).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
      { from: 2000, to: 2499 },
    ]);
    expect(stickerParts(0)).toEqual([]);
  });

  it('cuts a long name with an ellipsis and never splits a Bangla cluster', () => {
    expect(fitStickerText('Linen Panjabi', 20)).toBe('Linen Panjabi');
    expect(fitStickerText('A very long product name for a sticker', 12)).toBe('A very long…');
    const cut = fitStickerText('সুতির পাঞ্জাবি লম্বা নাম', 7);
    expect(cut.endsWith('…')).toBe(true);
    expect(/[্া-ৌ]…$/.test(cut)).toBe(false);
  });
});

describe('scanner detection', () => {
  /** A scanner: every key `gap` ms after the last, then Enter. */
  function burst(code: string, start = 1000, gap = 8): ScanKey[] {
    const keys = [...code].map((key, index) => ({ key, at: start + index * gap }));
    return [...keys, { key: 'Enter', at: start + code.length * gap }];
  }

  it('reads a fast burst ending in Enter as a scan', () => {
    expect(detectScans(burst('2000000000015'))).toEqual(['2000000000015']);
  });

  it('never reads typing as a scan, however long', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[0-9A-Z]{8,30}$/),
        fc.array(fc.integer({ min: 40, max: 400 }), { minLength: 30, maxLength: 30 }),
        (code, gaps) => {
          let at = 0;
          const keys: ScanKey[] = [...code].map((key, index) => {
            at += gaps[index] ?? 100;
            return { key, at };
          });
          keys.push({ key: 'Enter', at: at + (gaps[29] ?? 100) });
          expect(detectScans(keys)).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('reads any fast burst of 8 to 64 characters, after any typing before it', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[0-9A-Z-]{8,64}$/),
        fc.integer({ min: 1, max: 30 }),
        fc.stringMatching(/^[a-z]{0,6}$/),
        (code, gap, typed) => {
          const typing: ScanKey[] = [...typed].map((key, index) => ({ key, at: index * 150 }));
          const keys = [...typing, ...burst(code, typed.length * 150 + 500, gap)];
          expect(detectScans(keys)).toEqual([code]);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('ignores Shift inside a burst and refuses short or interrupted bursts', () => {
    const withShift: ScanKey[] = [{ key: 'Shift', at: 0 }, ...burst('ELY-PNJ-0042-XL', 2, 5)];
    expect(detectScans(withShift)).toEqual(['ELY-PNJ-0042-XL']);
    expect(detectScans(burst('1234567'))).toEqual([]);
    // A Tab ends the burst; the six characters after it are too few to be a scan.
    const interrupted = burst('2000000000015');
    interrupted.splice(7, 0, { key: 'Tab', at: 1056 });
    expect(detectScans(interrupted)).toEqual([]);
    // Enter long after the last character: a person pressed it.
    const late = burst('2000000000015');
    const enter = late.at(-1);
    if (enter !== undefined) late[late.length - 1] = { key: 'Enter', at: enter.at + 500 };
    expect(detectScans(late)).toEqual([]);
  });

  it('starts again after a reset', () => {
    const detector = createScanDetector();
    for (const key of burst('2000000000015').slice(0, 6)) detector.push(key);
    detector.reset();
    const steps = burst('2000000000022', 2000).map((key) => detector.push(key));
    expect(steps.at(-1)).toEqual({ kind: 'scan', code: '2000000000022' });
  });

  it('strips a symbology identifier and spaces', () => {
    expect(normaliseScannedCode(' ]E02000000000015 ')).toBe('2000000000015');
    expect(normaliseScannedCode('ELY-0001')).toBe('ELY-0001');
  });
});
