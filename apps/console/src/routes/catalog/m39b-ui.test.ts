import { describe, expect, it } from 'vitest';

import {
  copyDown,
  fillRows,
  marginCost,
  parseGrams,
  planExtend,
  positivePrice,
  resolveRowPrices,
  variantLabel,
  variantRows,
} from './variant-grid.js';

/** M39b's pure console helpers (D-635 to D-639): the grid, the extend plan, the margin basis. */
describe('positivePrice', () => {
  it('takes a positive poisha figure and refuses zero, a minus and blanks', () => {
    expect(positivePrice('149000')).toBe('149000');
    expect(positivePrice('0')).toBeNull();
    expect(positivePrice('-100')).toBeNull();
    expect(positivePrice(null)).toBeNull();
    expect(positivePrice('007')).toBeNull();
  });
});

const rows = variantRows([
  {
    attributeId: 'size',
    values: [
      { id: 's', label: 'S' },
      { id: 'xl', label: 'XL' },
    ],
  },
  {
    attributeId: 'colour',
    values: [
      { id: 'red', label: 'Red' },
      { id: 'navy', label: 'Navy' },
    ],
  },
]);

describe('resolveRowPrices (D-635)', () => {
  it('the row, then the size, then the colour, then the main price', () => {
    const xlNavy = rows.find((row) => row.label === 'XL / Navy')?.key ?? '';
    const prices = resolveRowPrices(rows, {
      own: { [xlNavy]: '199000' },
      bySize: { xl: '169000' },
      byColour: { navy: '159000' },
      main: '149000',
    });
    expect(rows.map((row) => [row.label, prices.get(row.key)])).toEqual([
      ['S / Red', '149000'],
      ['S / Navy', '159000'],
      ['XL / Red', '169000'],
      ['XL / Navy', '199000'],
    ]);
  });

  it('with no main price, a row priced by nothing is null', () => {
    const prices = resolveRowPrices(rows, {
      own: {},
      bySize: { xl: '169000' },
      byColour: {},
      main: null,
    });
    expect(prices.get(rows[0]?.key ?? '')).toBeNull();
    expect(prices.get(rows[2]?.key ?? '')).toBe('169000');
  });
});

describe('copyDown and fillRows', () => {
  it('copies a row to every row below it, and fills the chosen ones', () => {
    const first = rows[1]?.key ?? '';
    expect(copyDown({ [first]: '1500' }, rows, first)).toEqual({
      [first]: '1500',
      [rows[2]?.key ?? '']: '1500',
      [rows[3]?.key ?? '']: '1500',
    });
    expect(fillRows({}, [rows[0]?.key ?? ''], '10')).toEqual({ [rows[0]?.key ?? '']: '10' });
  });
});

describe('parseGrams', () => {
  it('whole grams from 1 to 100 kg; blank is no weight', () => {
    expect(parseGrams('350')).toBe(350);
    expect(parseGrams('')).toBeUndefined();
    expect(parseGrams('0')).toBeNull();
    expect(parseGrams('12.5')).toBeNull();
    expect(parseGrams('100001')).toBeNull();
  });
});

describe('planExtend (D-639)', () => {
  const axis = new Map([
    ['s', 'size'],
    ['m', 'size'],
    ['xs', 'size'],
    ['red', 'colour'],
    ['blue', 'colour'],
  ]);
  const existing = [
    { id: 'sku-s-red', valueIds: ['s', 'red'], status: 'active' as const, pricePoisha: '100' },
    { id: 'sku-m-red', valueIds: ['m', 'red'], status: 'active' as const, pricePoisha: '100' },
    { id: 'sku-xs-red', valueIds: ['xs', 'red'], status: 'archived' as const, pricePoisha: '90' },
  ];

  it('adds the new combinations, archives an unticked size, restores a re-ticked one', () => {
    const plan = planExtend(
      existing,
      [
        { attributeId: 'size', valueIds: ['m', 'xs'] },
        { attributeId: 'colour', valueIds: ['red', 'blue'] },
      ],
      axis,
    );
    expect(plan.add.map((row) => row.key).sort()).toEqual(['blue|m', 'blue|xs']);
    expect(plan.archive).toEqual(['sku-s-red']);
    expect(plan.restore).toEqual(['sku-xs-red']);
    expect(plan.orphans).toEqual([]);
  });

  it('offers the old size-only variants when colours are added', () => {
    const plan = planExtend(
      [
        { id: 'sku-m', valueIds: ['m'], status: 'active', pricePoisha: '100' },
        { id: 'sku-s', valueIds: ['s'], status: 'active', pricePoisha: '100' },
      ],
      [
        { attributeId: 'size', valueIds: ['m', 's'] },
        { attributeId: 'colour', valueIds: ['red'] },
      ],
      axis,
    );
    expect(plan.add).toHaveLength(2);
    expect([...plan.orphans].sort()).toEqual(['sku-m', 'sku-s']);
    expect(plan.archive).toEqual([]);
  });

  it('adds no combination with an archived value, and keeps the variants that have one', () => {
    // Red is archived in Catalog setup; the product still sells S and M in red.
    const plan = planExtend(
      existing,
      [
        { attributeId: 'size', valueIds: ['s', 'm', 'xs'] },
        { attributeId: 'colour', valueIds: ['red', 'blue'] },
      ],
      axis,
      new Set(['red']),
    );
    expect(plan.add.map((row) => row.key).sort()).toEqual(['blue|m', 'blue|s', 'blue|xs']);
    // XS / Red would have been restored, which is not a new variant: it stays offered.
    expect(plan.restore).toEqual(['sku-xs-red']);
    expect(plan.archive).toEqual([]);
    expect(plan.skipped).toBe(0);
    const onlyRed = planExtend(
      existing,
      [
        { attributeId: 'size', valueIds: ['s', 'm', 'l'] },
        { attributeId: 'colour', valueIds: ['red'] },
      ],
      new Map<string, string>([...axis, ['l', 'size']]),
      new Set(['red']),
    );
    expect(onlyRed.add).toEqual([]);
    expect(onlyRed.skipped).toBe(1);
  });
});

describe('variantLabel and marginCost (D-636)', () => {
  it('reads size before colour whatever order the values come in', () => {
    const sku = {
      attributes: [
        {
          attributeId: 'c',
          code: 'COLOUR',
          name: 'Colour',
          valueId: 'r',
          valueCode: 'RED',
          valueLabel: 'Red',
        },
        {
          attributeId: 's',
          code: 'SIZE',
          name: 'Size',
          valueId: 'm',
          valueCode: 'M',
          valueLabel: 'M',
        },
      ],
    };
    expect(variantLabel(sku)).toBe('M / Red');
    expect(
      variantLabel(
        sku,
        new Map([
          ['c', 'size'],
          ['s', 'colour'],
        ]),
      ),
    ).toBe('Red / M');
  });

  it('works from the average while there is one, else the last price', () => {
    expect(marginCost({ wacPoisha: '75000', lastUnitCostPoisha: '80000' })).toBe('75000');
    expect(marginCost({ wacPoisha: '0', lastUnitCostPoisha: '80000' })).toBe('80000');
    expect(marginCost({ wacPoisha: null, lastUnitCostPoisha: null })).toBeNull();
    expect(marginCost(undefined)).toBeNull();
  });
});
