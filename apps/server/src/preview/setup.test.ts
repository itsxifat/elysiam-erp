import { describe, expect, it } from 'vitest';

import { previewBarcode, PRODUCTS } from './setup.js';

describe('previewBarcode', () => {
  it('names the same item on every run: the Classic Cotton Tee in M is 2000000000102', () => {
    expect(PRODUCTS[0].slug).toBe('classic-cotton-tee');
    expect(previewBarcode(0, 'M')).toBe('2000000000102');
  });

  it('gives every SKU of the range its own 13-digit in-store code', () => {
    const codes = PRODUCTS.flatMap((product, index) =>
      product.sizes.map((size) => previewBarcode(index, size)),
    );
    for (const code of codes) expect(code).toMatch(/^200\d{10}$/);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
