import { describe, expect, it } from 'vitest';

import { PRODUCT_TEMPLATE, codeFrom, parseQty, total, variantRows } from './variant-grid.js';

/** The pure parts of the new-product form and the product page (plan `catalog-stock-ux`). */
describe('variantRows', () => {
  it('is every combination, first axis outermost, labelled the way a person says it', () => {
    const rows = variantRows([
      {
        attributeId: 'size',
        values: [
          { id: 'm', label: 'M' },
          { id: 'l', label: 'L' },
        ],
      },
      {
        attributeId: 'colour',
        values: [
          { id: 'red', label: 'Red' },
          { id: 'blue', label: 'Blue' },
        ],
      },
    ]);
    expect(rows.map((row) => row.label)).toEqual(['M / Red', 'M / Blue', 'L / Red', 'L / Blue']);
    expect(rows[1]?.valueIds).toEqual(['m', 'blue']);
    // The key is the sorted ids, so it does not change when the axes are reordered.
    expect(rows[1]?.key).toBe('blue|m');
  });

  it('skips an axis with nothing chosen, and with none chosen is one plain variant', () => {
    expect(
      variantRows([
        { attributeId: 'size', values: [{ id: 'm', label: 'M' }] },
        { attributeId: 'colour', values: [] },
      ]).map((row) => row.label),
    ).toEqual(['M']);
    expect(variantRows([])).toEqual([{ key: '', valueIds: [], label: '' }]);
  });
});

describe('codeFrom', () => {
  it('suggests an upper-case code of letters and digits, cut to the limit', () => {
    expect(codeFrom('Men’s Panjabi', 4)).toBe('MENS');
    expect(codeFrom('xl', 8)).toBe('XL');
    expect(codeFrom('Gulshan Showroom 2', 12)).toBe('GULSHANSHOWR');
    expect(codeFrom('Café', 8)).toBe('CAFE');
  });

  it('gives nothing for a name with no Latin letters, so the field asks for one', () => {
    expect(codeFrom('লাল', 8)).toBe('');
  });
});

describe('parseQty and total', () => {
  it('accepts only whole positive quantities', () => {
    expect(parseQty('12')).toBe(12);
    expect(parseQty(' 3 ')).toBe(3);
    for (const bad of ['', '0', '-1', '1.5', 'ten', '99999999']) expect(parseQty(bad)).toBeNull();
  });

  it('adds stock numbers', () => {
    expect(total([3, 0, 7])).toBe(10);
    expect(total([])).toBe(0);
  });
});

describe('the new-products template', () => {
  it('has the importer’s columns and one example row', () => {
    const [header, example, rest] = PRODUCT_TEMPLATE.split('\n');
    expect(header).toBe('name,category,price_taka,sizes,colours,status,description');
    expect(example?.split(',')).toHaveLength(7);
    expect(rest).toBe('');
  });
});
