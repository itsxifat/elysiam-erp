import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { poisha } from '../money/index.js';
import { parseCsv } from './csv.js';
import {
  productSlug,
  reviewProductImport,
  splitValueList,
  uniqueSlug,
  PRODUCT_IMPORT_TEMPLATE,
  type ProductImportContext,
} from './product-import.js';
import { variantCombinations, VariantMatrixError, type VariantAxis } from './variant-matrix.js';
import { variantPrices } from './variant-prices.js';

const SIZE: VariantAxis = {
  attributeId: 'a-size',
  position: 0,
  values: [
    { valueId: 's', code: 'S' },
    { valueId: 'm', code: 'M' },
    { valueId: 'xl', code: 'XL' },
  ],
};
const COLOUR: VariantAxis = {
  attributeId: 'a-colour',
  position: 1,
  values: [
    { valueId: 'red', code: 'RED' },
    { valueId: 'blue', code: 'BLU' },
  ],
};

describe('variantPrices (D-422)', () => {
  const combos = variantCombinations([SIZE, COLOUR]);
  const base = poisha(149_000n);

  it('starts every variant at the base price when nothing is overridden', () => {
    const prices = variantPrices(combos, base, []);
    expect(prices.size).toBe(6);
    expect([...prices.values()].every((price) => price === base)).toBe(true);
  });

  it('overrides exactly the named combination, whatever order its values come in', () => {
    const prices = variantPrices(combos, base, [
      { valueIds: ['red', 'xl'], pricePoisha: poisha(159_000n) },
    ]);
    const xlRed = combos.find(
      (c) => c.pairs.some((p) => p.valueId === 'xl') && c.pairs.some((p) => p.valueId === 'red'),
    );
    expect(prices.get(xlRed?.key ?? '')).toBe(159_000n);
    expect([...prices.values()].filter((price) => price === base)).toHaveLength(5);
  });

  it('refuses a combination the matrix does not have, a partial one and a duplicate', () => {
    expect(() =>
      variantPrices(combos, base, [{ valueIds: ['xl'], pricePoisha: poisha(1n) }]),
    ).toThrow(VariantMatrixError);
    expect(() =>
      variantPrices(combos, base, [{ valueIds: ['xl', 'green'], pricePoisha: poisha(1n) }]),
    ).toThrow(VariantMatrixError);
    expect(() =>
      variantPrices(combos, base, [
        { valueIds: ['xl', 'red'], pricePoisha: poisha(1n) },
        { valueIds: ['red', 'xl'], pricePoisha: poisha(2n) },
      ]),
    ).toThrow(VariantMatrixError);
  });

  it('property: every price is either the base or the one override for that variant', () => {
    fc.assert(
      fc.property(
        fc.subarray(combos, { minLength: 0 }),
        fc.bigInt({ min: 1n, max: 100_000_000n }),
        (chosen, price) => {
          const overrides = chosen.map((c) => ({
            valueIds: c.pairs.map((p) => p.valueId).reverse(),
            pricePoisha: poisha(price),
          }));
          const prices = variantPrices(combos, base, overrides);
          const chosenKeys = new Set(chosen.map((c) => c.key));
          for (const combination of combos) {
            expect(prices.get(combination.key)).toBe(
              chosenKeys.has(combination.key) ? price : base,
            );
          }
        },
      ),
    );
  });
});

const CONTEXT: ProductImportContext = {
  categories: [{ id: 'cat-pnj', code: 'PNJ', name: 'Panjabi' }],
  sizes: {
    attributeId: 'a-size',
    name: 'Size',
    values: [
      { id: 'm', code: 'M', label: 'M' },
      { id: 'l', code: 'L', label: 'L' },
      { id: 'xl', code: 'XL', label: 'XL' },
    ],
  },
  colours: {
    attributeId: 'a-colour',
    name: 'Colour',
    values: [
      { id: 'white', code: 'WHT', label: 'White' },
      { id: 'cream', code: 'CRM', label: 'Cream' },
    ],
  },
  existingNames: ['Old Kurti'],
};

describe('reviewProductImport (D-425)', () => {
  it('accepts the template as it is downloaded', () => {
    const report = reviewProductImport(parseCsv(PRODUCT_IMPORT_TEMPLATE), CONTEXT);
    expect(report.problems).toEqual([]);
    expect(report.rows).toHaveLength(1);
    const [row] = report.rows;
    expect(row?.categoryId).toBe('cat-pnj');
    expect(row?.pricePoisha).toBe(245_000n);
    expect(row?.status).toBe('active');
    expect(row?.variantCount).toBe(6);
    expect(row?.axes).toEqual([
      { attributeId: 'a-size', valueIds: ['m', 'l', 'xl'] },
      { attributeId: 'a-colour', valueIds: ['white', 'cream'] },
    ]);
  });

  it('matches values and categories by code or label, ignoring case', () => {
    const csv = 'name,category,price_taka,sizes,colors\nTee,panjabi,990,"m, xl",wht;CREAM\n';
    const report = reviewProductImport(parseCsv(csv), CONTEXT);
    expect(report.problems).toEqual([]);
    expect(report.rows[0]?.axes).toEqual([
      { attributeId: 'a-size', valueIds: ['m', 'xl'] },
      { attributeId: 'a-colour', valueIds: ['white', 'cream'] },
    ]);
  });

  it('a product with no sizes or colours is one plain SKU', () => {
    const report = reviewProductImport(parseCsv('name,price_taka\nScarf,350.50\n'), CONTEXT);
    expect(report.problems).toEqual([]);
    expect(report.rows[0]?.axes).toEqual([]);
    expect(report.rows[0]?.variantCount).toBe(1);
    expect(report.rows[0]?.pricePoisha).toBe(35_050n);
  });

  it('names every problem with its line and column', () => {
    const csv = [
      'name,category,price_taka,sizes,colours,status',
      'Old Kurti,,500,,,', // already in the catalog
      'Shirt,SHIRTS,500,,,', // unknown category
      'Shirt Two,,abc,,,', // bad price
      'Shirt Three,,500,XXXL,,', // unknown size
      'Shirt Four,,500,,Rde,', // unknown colour
      'Shirt Five,,500,,,maybe', // bad status
      'Shirt Six,,500,M|M,,', // twice
      'Shirt Seven,,500,,,',
      'shirt seven,,600,,,', // duplicate in file
    ].join('\n');
    const report = reviewProductImport(parseCsv(csv), CONTEXT);
    const where = report.problems.map((p) => `${String(p.line)}:${p.column ?? ''}`);
    expect(where).toEqual([
      '2:name',
      '3:category',
      '4:price_taka',
      '5:sizes',
      '6:colours',
      '7:status',
      '8:sizes',
      '10:name',
    ]);
    expect(report.rows.map((r) => r.name)).toEqual(['Shirt Seven']);
  });

  it('refuses unknown columns, including any cost column, before reading a row', () => {
    const report = reviewProductImport(
      parseCsv('name,price_taka,cost_taka\nTee,500,300\n'),
      CONTEXT,
    );
    expect(report.rows).toEqual([]);
    expect(report.problems).toEqual([expect.objectContaining({ line: 1, column: 'cost_taka' })]);
  });

  it('says so when the brand has no size list yet', () => {
    const report = reviewProductImport(parseCsv('name,price_taka,sizes\nTee,500,M\n'), {
      ...CONTEXT,
      sizes: null,
    });
    expect(report.problems[0]?.message).toMatch(/no size list/);
  });

  it('splits value lists on |, ;, / and commas', () => {
    expect(splitValueList(' S | M;L/XL, XXL ')).toEqual(['S', 'M', 'L', 'XL', 'XXL']);
    expect(splitValueList('')).toEqual([]);
  });
});

describe('slugs', () => {
  it('makes a web address from a name and falls back for a name with no Latin letters', () => {
    expect(productSlug('Linen Panjabi (Eid) 2026', 'x')).toBe('linen-panjabi-eid-2026');
    expect(productSlug('লাল পাঞ্জাবি', 'seed')).toBe('p-seed');
  });

  it('takes the next free suffix', () => {
    const taken = new Set(['tee', 'tee-2']);
    expect(uniqueSlug('tee', taken)).toBe('tee-3');
    expect(uniqueSlug('shirt', taken)).toBe('shirt');
    expect(taken.has('tee-3') && taken.has('shirt')).toBe(true);
  });

  it('property: a slug always has the shape the catalog accepts', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (name) => {
        expect(productSlug(name, 'seed')).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      }),
    );
  });
});
