import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildSkuCode, parentSkuCode, parentSkuSlug, productParentSku } from './sku-code.js';

/**
 * The parent SKU and the web address it gives a new product (D-661), and the numbers a run
 * of copies takes (D-662, D-663).
 */
const SLUG_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const segment = fc.stringMatching(/^[A-Z0-9]{1,8}$/);
const orgCode = fc.stringMatching(/^[A-Z0-9]{2,8}$/);

describe('parentSkuCode and parentSkuSlug', () => {
  it("is the owner's example: ELY-HAWA-0020, its variants and its address", () => {
    const parent = parentSkuCode({ orgCode: 'ELY', categoryCode: 'HAWA', sequence: 20 });
    expect(parent).toBe('ELY-HAWA-0020');
    expect(parentSkuSlug(parent)).toBe('ely-hawa-0020');
    expect(
      buildSkuCode({ orgCode: 'ELY', categoryCode: 'HAWA', sequence: 20, variantCodes: ['M'] }),
    ).toBe('ELY-HAWA-0020-M');
  });

  it('leaves out the category segment for a product with no category, as its SKU codes do', () => {
    expect(parentSkuCode({ orgCode: 'ELY', categoryCode: undefined, sequence: 7 })).toBe(
      'ELY-0007',
    );
    expect(parentSkuCode({ orgCode: 'ELY', categoryCode: '', sequence: 7 })).toBe('ELY-0007');
    expect(parentSkuSlug('ELY-0007')).toBe('ely-0007');
  });

  it('gives consecutive copies consecutive numbers, and grows past four digits', () => {
    const run = [20, 21, 22, 23].map((sequence) =>
      parentSkuCode({ orgCode: 'ELY', categoryCode: 'HAWA', sequence }),
    );
    expect(run).toEqual(['ELY-HAWA-0020', 'ELY-HAWA-0021', 'ELY-HAWA-0022', 'ELY-HAWA-0023']);
    expect(parentSkuCode({ orgCode: 'ELY', categoryCode: 'HAWA', sequence: 10_000 })).toBe(
      'ELY-HAWA-10000',
    );
  });

  it('makes a slug that is the lower-cased parent SKU, in the slug shape, for any sequence and category', () => {
    fc.assert(
      fc.property(
        orgCode,
        fc.option(segment, { nil: undefined }),
        fc.integer({ min: 1, max: 999_999 }),
        fc.array(segment, { maxLength: 3 }),
        (org, category, sequence, variants) => {
          const parent = parentSkuCode({ orgCode: org, categoryCode: category, sequence });
          const slug = parentSkuSlug(parent);
          expect(slug).toBe(parent.toLowerCase());
          expect(slug).toMatch(SLUG_SHAPE);
          expect(slug.length).toBeLessThanOrEqual(120);
          // Every variant's code is the parent SKU and its own segments.
          const code = buildSkuCode({
            orgCode: org,
            categoryCode: category,
            sequence,
            variantCodes: variants,
          });
          expect(code === parent || code.startsWith(`${parent}-`)).toBe(true);
        },
      ),
    );
  });

  it('never gives two sequences of one brand the same parent SKU or address', () => {
    fc.assert(
      fc.property(
        orgCode,
        fc.option(segment, { nil: undefined }),
        fc.option(segment, { nil: undefined }),
        fc.integer({ min: 1, max: 999_999 }),
        fc.integer({ min: 1, max: 999_999 }),
        (org, categoryA, categoryB, a, b) => {
          fc.pre(a !== b);
          // Whatever the two categories are: the last segment is the sequence, and two
          // different sequences never pad to the same digits.
          const left = parentSkuSlug(
            parentSkuCode({ orgCode: org, categoryCode: categoryA, sequence: a }),
          );
          const right = parentSkuSlug(
            parentSkuCode({ orgCode: org, categoryCode: categoryB, sequence: b }),
          );
          expect(left).not.toBe(right);
        },
      ),
    );
  });
});

describe('productParentSku', () => {
  it('reads the parent SKU back from the codes the product carries, whatever its category is now', () => {
    fc.assert(
      fc.property(
        orgCode,
        fc.option(segment, { nil: undefined }),
        fc.option(segment, { nil: undefined }),
        fc.integer({ min: 1, max: 99_999 }),
        fc.array(segment, { minLength: 1, maxLength: 3 }),
        (org, category, now, sequence, variants) => {
          fc.pre(category !== undefined || variants[0] !== String(sequence).padStart(4, '0'));
          const code = buildSkuCode({
            orgCode: org,
            categoryCode: category,
            sequence,
            variantCodes: variants,
          });
          expect(
            productParentSku({ sequence, skuCodes: [code], orgCode: 'NEW', categoryCode: now }),
          ).toBe(parentSkuCode({ orgCode: org, categoryCode: category, sequence }));
        },
      ),
    );
  });

  it('gives a product with no SKU yet the prefix it would get now', () => {
    expect(
      productParentSku({ sequence: 20, skuCodes: [], orgCode: 'ELY', categoryCode: 'HAWA' }),
    ).toBe('ELY-HAWA-0020');
    expect(
      productParentSku({ sequence: 20, skuCodes: [], orgCode: 'ELY', categoryCode: undefined }),
    ).toBe('ELY-0020');
    expect(
      productParentSku({ sequence: 20, skuCodes: [], orgCode: undefined, categoryCode: 'HAWA' }),
    ).toBeNull();
  });

  it('says nothing for a product whose codes were imported as they were', () => {
    expect(
      productParentSku({
        sequence: 3,
        skuCodes: ['OLDSHOP123', 'OLDSHOP124'],
        orgCode: 'ELY',
        categoryCode: 'HAWA',
      }),
    ).toBeNull();
  });

  it('takes the first code it can read when an imported one comes first', () => {
    expect(
      productParentSku({
        sequence: 3,
        skuCodes: ['OLDSHOP123', 'ELY-HAWA-0003-XL'],
        orgCode: 'ELY',
        categoryCode: 'TOPS',
      }),
    ).toBe('ELY-HAWA-0003');
  });
});
