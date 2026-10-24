import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { poisha } from '../money/index.js';
import {
  allOrNothing,
  buildSkuCode,
  code128CheckValue,
  code128Encode,
  code128Svg,
  isSkuCode,
  matrixPlan,
  parseCsv,
  reviewPriceImport,
  skuSegment,
  takaTextToPoisha,
  variantCombinations,
  variantKey,
  CODE128_PATTERNS,
  CsvError,
  MAX_VARIANTS_PER_PRODUCT,
  SkuCodeError,
  VariantMatrixError,
  type VariantAxis,
} from './index.js';

const axis = (attributeId: string, position: number, values: readonly string[]): VariantAxis => ({
  attributeId,
  position,
  values: values.map((code) => ({ valueId: `${attributeId}:${code}`, code })),
});

const COLOUR = axis('colour', 1, ['RED', 'BLUE', 'GREEN']);
const SIZE = axis('size', 2, ['S', 'M', 'L', 'XL', 'XXL']);

describe('SKU codes', () => {
  it('builds the §8 pattern', () => {
    expect(
      buildSkuCode({
        orgCode: 'ELY',
        categoryCode: 'SHRT',
        sequence: 1,
        variantCodes: ['RED', 'M'],
      }),
    ).toBe('ELY-SHRT-0001-RED-M');
  });

  it('pads the sequence to four and grows past it rather than wrapping', () => {
    const at = (sequence: number) =>
      buildSkuCode({ orgCode: 'ELY', categoryCode: 'SHRT', sequence, variantCodes: [] });
    expect(at(7)).toBe('ELY-SHRT-0007');
    expect(at(9999)).toBe('ELY-SHRT-9999');
    expect(at(10_000)).toBe('ELY-SHRT-10000');
  });

  it('omits the category segment for an uncategorised product', () => {
    expect(buildSkuCode({ orgCode: 'ELY', sequence: 3, variantCodes: ['M'] })).toBe('ELY-0003-M');
  });

  it('folds text into one character set, and refuses text that leaves nothing', () => {
    expect(skuSegment('  navy blue ', 'x')).toBe('NAVYBLUE');
    expect(skuSegment('Café', 'x')).toBe('CAFE');
    expect(() => skuSegment('লাল', 'x')).toThrow(SkuCodeError);
  });

  it('never lets a separator into a segment, so a code parses back into its parts', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 12 }).filter((s) => /[a-zA-Z0-9]/.test(s)),
        fc.integer({ min: 1, max: 99_999 }),
        (raw, sequence) => {
          const code = buildSkuCode({
            orgCode: 'ELY',
            categoryCode: 'CAT',
            sequence,
            variantCodes: [raw],
          });
          const parts = code.split('-');
          expect(parts).toHaveLength(4);
          expect(parts[1]).toBe('CAT');
          expect(Number(parts[2])).toBe(sequence);
          expect(isSkuCode(code)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('refuses a sequence that is not a whole number from 1', () => {
    expect(() => buildSkuCode({ orgCode: 'E', sequence: 0, variantCodes: [] })).toThrow(
      SkuCodeError,
    );
    expect(() => buildSkuCode({ orgCode: 'E', sequence: 1.5, variantCodes: [] })).toThrow(
      SkuCodeError,
    );
  });
});

describe('the variant matrix', () => {
  it('turns 3 colours x 5 sizes into 15 distinct SKU combinations (check 1)', () => {
    const combinations = variantCombinations([COLOUR, SIZE]);
    expect(combinations).toHaveLength(15);
    expect(new Set(combinations.map((c) => c.key)).size).toBe(15);
  });

  it('orders combinations with the last axis turning fastest', () => {
    const codes = variantCombinations([COLOUR, SIZE]).map((c) => c.codes.join('-'));
    expect(codes.slice(0, 6)).toEqual(['RED-S', 'RED-M', 'RED-L', 'RED-XL', 'RED-XXL', 'BLUE-S']);
  });

  it('keys a combination independently of axis order, so reordering cannot duplicate a SKU', () => {
    const forward = variantCombinations([COLOUR, SIZE])
      .map((c) => c.key)
      .sort();
    const reversed = variantCombinations([
      { ...SIZE, position: 1 },
      { ...COLOUR, position: 2 },
    ])
      .map((c) => c.key)
      .sort();
    expect(reversed).toEqual(forward);
  });

  it('adding a size later plans ONLY the three new SKUs (check 1)', () => {
    const existing = variantCombinations([COLOUR, SIZE]).map((c) => c.key);
    const widened = axis('size', 2, ['S', 'M', 'L', 'XL', 'XXL', 'XXXL']);

    const plan = matrixPlan([COLOUR, widened], existing);

    expect(plan.additions).toHaveLength(3);
    expect(plan.additions.map((c) => c.codes.join('-'))).toEqual([
      'RED-XXXL',
      'BLUE-XXXL',
      'GREEN-XXXL',
    ]);
    expect(plan.unchanged).toHaveLength(15);
    expect(plan.orphaned).toEqual([]);
  });

  it('plans nothing at all when the axes have not changed', () => {
    const existing = variantCombinations([COLOUR, SIZE]).map((c) => c.key);
    expect(matrixPlan([COLOUR, SIZE], existing).additions).toEqual([]);
  });

  it('reports a dropped value as orphaned rather than planning its removal', () => {
    const existing = variantCombinations([COLOUR, SIZE]).map((c) => c.key);
    const narrowed = axis('size', 2, ['S', 'M', 'L', 'XL']);

    const plan = matrixPlan([COLOUR, narrowed], existing);

    expect(plan.additions).toEqual([]);
    expect(plan.orphaned).toHaveLength(3);
    expect(plan.orphaned.every((key) => key.includes('size:XXL'))).toBe(true);
  });

  it('is idempotent however many times it runs, for any axes', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.uniqueArray(fc.string({ minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 4 }),
          {
            minLength: 1,
            maxLength: 3,
          },
        ),
        (axisValues) => {
          const axes = axisValues.map((values, index) => axis(`a${String(index)}`, index, values));
          const first = matrixPlan(axes, []);
          const keys = first.additions.map((c) => c.key);
          const second = matrixPlan(axes, keys);
          expect(second.additions).toEqual([]);
          expect(second.unchanged).toHaveLength(keys.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('refuses a duplicate axis, an empty axis and an absurd matrix', () => {
    expect(() => variantCombinations([COLOUR, COLOUR])).toThrow(VariantMatrixError);
    expect(() => variantCombinations([axis('x', 1, [])])).toThrow(VariantMatrixError);
    const huge = [1, 2, 3].map((n) =>
      axis(
        `a${String(n)}`,
        n,
        Array.from({ length: 20 }, (_, i) => `V${String(i)}`),
      ),
    );
    expect(() => variantCombinations(huge)).toThrow(new RegExp(String(MAX_VARIANTS_PER_PRODUCT)));
  });

  it('keys a single-value combination the same way whichever helper produced it', () => {
    const [only] = variantCombinations([axis('colour', 1, ['RED'])]);
    expect(only?.key).toBe(variantKey([{ attributeId: 'colour', valueId: 'colour:RED' }]));
  });
});

describe('Code 128', () => {
  it('has a structurally sound pattern table', () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    expect(new Set(CODE128_PATTERNS).size).toBe(107);

    CODE128_PATTERNS.forEach((pattern, value) => {
      const widths = [...pattern].map(Number);
      const modules = widths.reduce((total, width) => total + width, 0);
      // The stop pattern is the only one that ends on a bar, so it has seven
      // elements and 13 modules. Every other symbol character is 11.
      expect(widths.every((width) => width >= 1 && width <= 4)).toBe(true);
      if (value === 106) {
        expect(widths).toHaveLength(7);
        expect(modules).toBe(13);
      } else {
        expect(widths).toHaveLength(6);
        expect(modules).toBe(11);
      }
    });
  });

  it('computes the check character the symbology specifies', () => {
    // Worked by hand: start B (104) + 'A'(33)x1 + 'B'(34)x2 + 'C'(35)x3 = 310,
    // 310 mod 103 = 1.
    expect(code128CheckValue('ABC')).toBe(1);
    // D-912: an even run of digits is subset C, two digits a symbol: start 105, then 26, 10, 00,
    // 00, 42, so the check is (105 + 26·1 + 10·2 + 0·3 + 0·4 + 42·5) % 103 = 361 % 103 = 52.
    expect(code128CheckValue('2610000042')).toBe(52);
    const digits = code128Encode('2610000042');
    expect(digits.width).toBe((1 + 5 + 1) * 11 + 13);
    expect(digits.width).toBeLessThan(code128Encode('ELY-2610-00042').width / 2);
    // An odd run of digits stays subset B, one a symbol.
    expect(code128Encode('261000042').width).toBe((1 + 9 + 1) * 11 + 13);
  });

  it('encodes a SKU code into bars that start and end on a bar', () => {
    const symbol = code128Encode('ELY-SHRT-0001-RED-M');
    // start + 19 characters + check + stop: 21 patterns of 11 modules and one of 13.
    expect(symbol.width).toBe(21 * 11 + 13);
    expect(symbol.modules.length % 2).toBe(1);
  });

  it('refuses a payload Code 128 subset B cannot carry', () => {
    expect(() => code128Encode('লাল')).toThrow(/printable ASCII/);
    expect(() => code128Encode('')).toThrow(/payload/);
  });

  it('renders SVG whose bars sum to the symbol plus both quiet zones', () => {
    const svg = code128Svg('ELY-0001');
    const symbol = code128Encode('ELY-0001');
    expect(svg).toContain(`viewBox="0 0 ${String(symbol.width + 20)} 40"`);
    const bars = [...svg.matchAll(/width="(\d+)" height/g)].map((match) => Number(match[1]));
    // Bars are the even-indexed elements, so there is one more bar than space.
    expect(bars).toHaveLength(Math.ceil(symbol.modules.length / 2));
  });
});

describe('CSV parsing', () => {
  it('reads quoted fields, embedded commas, CRLF and a BOM', () => {
    const table = parseCsv('﻿sku,price_taka\r\n"ELY-0001-RED-M","1,490.50"\r\n');
    expect(table.headers).toEqual(['sku', 'price_taka']);
    expect(table.rows).toEqual([
      { line: 2, values: { sku: 'ELY-0001-RED-M', price_taka: '1,490.50' } },
    ]);
  });

  it('keeps a newline inside a quoted field and still numbers the next row correctly', () => {
    const table = parseCsv('sku,note\nELY-0001,"two\nlines"\nELY-0002,ok\n');
    expect(table.rows[0]?.values.note).toBe('two\nlines');
    expect(table.rows[1]?.line).toBe(4);
  });

  it('refuses a file with duplicate or unnamed columns, and an unterminated quote', () => {
    expect(() => parseCsv('sku,sku\n')).toThrow(CsvError);
    expect(() => parseCsv('sku,\n')).toThrow(CsvError);
    expect(() => parseCsv('sku\n"open')).toThrow(/ends inside a quoted field/);
  });
});

describe('the price importer', () => {
  const known = [
    { code: 'ELY-SHRT-0001-RED-M', pricePoisha: poisha(149_000) },
    { code: 'ELY-SHRT-0001-RED-L', pricePoisha: poisha(149_000) },
  ];

  it('reads taka with two decimals without going near a float', () => {
    expect(takaTextToPoisha('1490')).toBe(149_000n);
    expect(takaTextToPoisha('19.99')).toBe(1_999n);
    expect(takaTextToPoisha('1,490.50')).toBe(149_050n);
    expect(() => takaTextToPoisha('1.005')).toThrow();
  });

  it('accepts a clean file and says what would change', () => {
    const report = reviewPriceImport(
      parseCsv('sku,price_taka\nELY-SHRT-0001-RED-M,1590\nELY-SHRT-0001-RED-L,1490\n'),
      known,
    );
    expect(report.problems).toEqual([]);
    expect(report.matched).toBe(2);
    expect(report.unchanged).toBe(1);
    expect(allOrNothing(report)).toEqual({ ok: true, reason: null });
  });

  it('reports every bad row, with its line and column (check 4)', () => {
    const report = reviewPriceImport(
      parseCsv(
        [
          'sku,price_taka',
          'ELY-SHRT-0001-RED-M,1590',
          'ELY-SHRT-9999-RED-M,1590',
          'ELY-SHRT-0001-RED-L,nonsense',
          'ELY-SHRT-0001-RED-M,1690',
          ',1000',
          'not a sku,1000',
        ].join('\n'),
      ),
      known,
    );

    expect(report.problems.map((problem) => [problem.line, problem.column])).toEqual([
      [3, 'sku'],
      [4, 'price_taka'],
      [5, 'sku'],
      [6, 'sku'],
      [7, 'sku'],
    ]);
    // Line 5 repeats the SKU from line 2, and the message points back at it: the
    // operator has to know which of the two rows they meant.
    expect(report.problems[2]?.message).toContain('line 2');
    expect(allOrNothing(report).ok).toBe(false);
  });

  it('counts a row as a duplicate even when the first occurrence was itself rejected', () => {
    // The SKU is claimed the moment it is recognised, before the price is read.
    // Otherwise a file with a bad price on line 2 and a good one on line 3 for the
    // same SKU would look like one clean row, and the operator would never be told
    // their file names that SKU twice.
    const report = reviewPriceImport(
      parseCsv('sku,price_taka\nELY-SHRT-0001-RED-M,nonsense\nELY-SHRT-0001-RED-M,1590\n'),
      known,
    );
    expect(report.problems.map((problem) => problem.line)).toEqual([2, 3]);
    expect(report.problems[1]?.message).toContain('line 2');
  });

  it('refuses a cost column outright rather than reading it as a price (invariant 5)', () => {
    const report = reviewPriceImport(
      parseCsv('sku,price_taka,unit_cost_poisha\nELY-SHRT-0001-RED-M,1590,900\n'),
      known,
    );
    expect(report.problems[0]?.column).toBe('unit_cost_poisha');
    expect(report.problems[0]?.message).toContain('purchase cost');
    expect(allOrNothing(report).ok).toBe(false);
  });

  it('says only what is missing when a required column is absent', () => {
    const report = reviewPriceImport(parseCsv('sku\nELY-SHRT-0001-RED-M\n'), known);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ line: 1, column: 'price_taka' });
    expect(report.rows).toEqual([]);
  });

  it('catches a misplaced decimal point rather than repricing a shirt at 10 lakh', () => {
    const report = reviewPriceImport(
      parseCsv('sku,price_taka\nELY-SHRT-0001-RED-M,149000000\n'),
      known,
    );
    expect(report.problems[0]?.message).toContain('decimal point');
  });

  it('will not commit an empty file', () => {
    expect(allOrNothing(reviewPriceImport(parseCsv('sku,price_taka\n'), known)).ok).toBe(false);
  });

  it('keeps the ERP’s own barcode range for the ERP, but lets a SKU keep its number (D-603)', () => {
    const own = '2000000000015';
    const withBarcodes = [
      { code: 'ELY-SHRT-0001-RED-M', pricePoisha: poisha(149_000), barcode: own },
      { code: 'ELY-SHRT-0001-RED-L', pricePoisha: poisha(149_000), barcode: null },
    ];
    const report = reviewPriceImport(
      parseCsv(
        `sku,price_taka,barcode\nELY-SHRT-0001-RED-M,1490,${own}\nELY-SHRT-0001-RED-L,1490,2000000000022\n`,
      ),
      withBarcodes,
    );
    expect(report.problems.map((problem) => [problem.line, problem.column])).toEqual([
      [3, 'barcode'],
    ]);
    // A supplier's code outside the range is taken as before.
    const supplier = reviewPriceImport(
      parseCsv('sku,price_taka,barcode\nELY-SHRT-0001-RED-L,1490,5901234123457\n'),
      withBarcodes,
    );
    expect(supplier.problems).toEqual([]);
  });
});
