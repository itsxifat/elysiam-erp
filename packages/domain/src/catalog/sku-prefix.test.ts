import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildSkuCode, skuCodePrefix } from './sku-code.js';

/**
 * A product's existing code prefix, read back (M39a, D-623): new variants of a product that
 * moved category keep the segments its printed labels already carry.
 */
describe('skuCodePrefix', () => {
  const segment = fc.stringMatching(/^[A-Z0-9]{1,8}$/);
  const orgCode = fc.stringMatching(/^[A-Z0-9]{2,8}$/);

  it('reads back the organization and category a code was built with', () => {
    fc.assert(
      fc.property(
        orgCode,
        fc.option(segment, { nil: undefined }),
        fc.integer({ min: 1, max: 99_999 }),
        fc.array(segment, { maxLength: 3 }),
        (org, category, sequence, variants) => {
          // The one ambiguous shape: no category and a first variant code equal to the padded
          // sequence. Nobody types a size coded 0007; the function reads it as a category.
          fc.pre(category !== undefined || variants[0] !== String(sequence).padStart(4, '0'));
          const code = buildSkuCode({
            orgCode: org,
            categoryCode: category,
            sequence,
            variantCodes: variants,
          });
          expect(skuCodePrefix(code, sequence)).toEqual({ orgCode: org, categoryCode: category });
        },
      ),
    );
  });

  it('says nothing about a code this system did not build for that sequence', () => {
    expect(skuCodePrefix('ELY-SHRT-0007-RED', 8)).toBeUndefined();
    expect(skuCodePrefix('IMPORTED123', 1)).toBeUndefined();
    expect(skuCodePrefix('ELY-SHRT-0007-RED', 0)).toBeUndefined();
  });

  it('reads a category coded like a sequence as the category', () => {
    expect(skuCodePrefix('ELY-0007-0007-M', 7)).toEqual({ orgCode: 'ELY', categoryCode: '0007' });
    expect(skuCodePrefix('ELY-0007-M', 7)).toEqual({ orgCode: 'ELY', categoryCode: undefined });
  });
});
