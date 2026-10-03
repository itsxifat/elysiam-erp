import { describe, expect, it } from 'vitest';

import {
  PRODUCT_TEMPLATE,
  codeFrom,
  isReplayConflict,
  parseQty,
  positiveCost,
  requestKey,
  total,
  variantRows,
} from './variant-grid.js';

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

describe('requestKey (ledger audit H1)', () => {
  it('sends the same key on every attempt until one succeeds', () => {
    let next = 0;
    const key = requestKey(() => `key-${String((next += 1))}`);
    const first = key.current();
    // The first attempt fails (a lost response); the retry carries the same key, so the
    // server replays the receipt it may already hold instead of posting a second one.
    expect(key.current()).toBe(first);
    expect(key.current()).toBe(first);
    key.settle();
    expect(key.current()).not.toBe(first);
    expect(key.current()).toBe('key-2');
  });

  it('knows the server telling it an earlier save already went through', () => {
    expect(isReplayConflict({ code: 'IDEMPOTENCY_CONFLICT' })).toBe(true);
    expect(isReplayConflict({ code: 'VALIDATION_FAILED' })).toBe(false);
    expect(isReplayConflict(new Error('offline'))).toBe(false);
    expect(isReplayConflict(null)).toBe(false);
  });

  it('makes a fresh uuid by default', () => {
    expect(requestKey().current()).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('positiveCost', () => {
  it('refuses a zero cost and passes a real one', () => {
    expect(positiveCost('0')).toBeNull();
    expect(positiveCost('000')).toBeNull();
    expect(positiveCost(null)).toBeNull();
    expect(positiveCost('118050')).toBe('118050');
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
