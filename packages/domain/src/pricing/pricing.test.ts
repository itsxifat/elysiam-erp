import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseCsv } from '../catalog/csv.js';
import { parcelWeightGrams } from '../catalog/parcel-weight.js';
import { divideRounded, poisha, type Poisha } from '../money/index.js';
import { storefrontPrice } from '../storefront/price.js';
import {
  applyPriceRule,
  attributeKindRank,
  axisOrderFromCode,
  bpsPercentText,
  compareAtProblem,
  gridPrice,
  marginBps,
  mostCommonPrice,
  newVariantPrice,
  percentTextToBps,
  planBulkPrices,
  prefillUnitCost,
  roundToStep,
  type PriceRule,
  type PricedVariant,
} from './index.js';
import { reviewStandardCostImport, standardCostCsv } from './standard-costs.js';

/**
 * M39b's pricing rules (D-635 to D-640), held as properties: every figure in integer poisha,
 * every rounding through `divideRounded`, and no rule that can produce a price of zero or
 * less, a regular price at or under the selling price, or a cheapest/archived default.
 */

const amount = fc.bigInt({ min: 1n, max: 100_000_000n });
const step = fc.constantFrom(0n, 100n, 500n, 1000n, 5000n, 10000n);

const rule: fc.Arbitrary<PriceRule> = fc.oneof(
  fc.record({
    kind: fc.constant('set' as const),
    amountPoisha: fc.bigInt({ min: -1000n, max: 100_000_000n }),
    roundToPoisha: step,
  }),
  fc.record({
    kind: fc.constant('add' as const),
    amountPoisha: fc.bigInt({ min: -100_000_000n, max: 100_000_000n }),
    roundToPoisha: step,
  }),
  fc.record({
    kind: fc.constant('percent' as const),
    basisPoints: fc.bigInt({ min: -10_000n, max: 50_000n }),
    roundToPoisha: step,
  }),
);

describe('applyPriceRule (D-636)', () => {
  it('never returns a price of zero or less, and refuses rather than clamps', () => {
    fc.assert(
      fc.property(amount, rule, (current, chosen) => {
        const outcome = applyPriceRule(current, chosen);
        if (outcome.ok) expect(outcome.value > 0n).toBe(true);
      }),
    );
  });

  it('adds exactly the amount, or exactly the percentage rounded once to the poisha', () => {
    fc.assert(
      fc.property(amount, fc.bigInt({ min: 0n, max: 1_000_000n }), (current, added) => {
        const outcome = applyPriceRule(current, { kind: 'add', amountPoisha: added });
        expect(outcome).toEqual({ ok: true, value: current + added });
      }),
    );
    fc.assert(
      fc.property(amount, fc.bigInt({ min: 0n, max: 50_000n }), (current, bps) => {
        const outcome = applyPriceRule(current, { kind: 'percent', basisPoints: bps });
        expect(outcome).toEqual({
          ok: true,
          value: current + divideRounded(current * bps, 10_000n),
        });
        if (outcome.ok) expect(outcome.value >= current).toBe(true);
      }),
    );
  });

  it('+10 % of ৳1,490 is ৳1,639, and to the nearest ৳10 it is ৳1,640', () => {
    expect(applyPriceRule(149_000n, { kind: 'percent', basisPoints: 1000n })).toEqual({
      ok: true,
      value: 163_900n,
    });
    expect(
      applyPriceRule(149_000n, { kind: 'percent', basisPoints: 1000n, roundToPoisha: 1000n }),
    ).toEqual({ ok: true, value: 164_000n });
  });

  it('refuses a cut below nothing', () => {
    expect(applyPriceRule(50_000n, { kind: 'add', amountPoisha: -50_000n })).toEqual({
      ok: false,
      reason: 'not-positive',
    });
    expect(applyPriceRule(50_000n, { kind: 'percent', basisPoints: -10_000n })).toEqual({
      ok: false,
      reason: 'not-positive',
    });
  });
});

describe('roundToStep', () => {
  it('lands on a multiple of the step, within half a step', () => {
    fc.assert(
      fc.property(amount, fc.bigInt({ min: 1n, max: 100_000n }), (value, size) => {
        const rounded = roundToStep(value, size);
        expect(rounded % size).toBe(0n);
        const distance = rounded > value ? rounded - value : value - rounded;
        expect(distance * 2n <= size).toBe(true);
      }),
    );
  });

  it('leaves the value alone without a step', () => {
    expect(roundToStep(123_456n, undefined)).toBe(123_456n);
    expect(roundToStep(123_456n, 0n)).toBe(123_456n);
  });
});

/** A 4-size × 3-colour shirt, some with a regular price. */
function shirt(): PricedVariant[] {
  const sizes = ['S', 'M', 'L', 'XL'];
  const colours = ['RED', 'NAVY', 'WHITE'];
  return sizes.flatMap((size, index) =>
    colours.map((colour) => ({
      skuId: `${size}-${colour}`,
      pricePoisha: 149_000n + BigInt(index) * 10_000n,
      compareAtPoisha: colour === 'RED' ? 199_000n : null,
    })),
  );
}

describe('planBulkPrices (D-636, M39 check 3)', () => {
  it('raises a 4 × 3 product by 10 % in one plan, changing only what was chosen', () => {
    const variants = shirt();
    const chosen = new Set(variants.map((variant) => variant.skuId));
    const plan = planBulkPrices(variants, chosen, { kind: 'percent', basisPoints: 1000n });
    expect(plan.problems).toEqual([]);
    expect(plan.changes).toHaveLength(12);
    for (const change of plan.changes) {
      const before = variants.find((variant) => variant.skuId === change.skuId);
      expect(change.fromPoisha).toBe(before?.pricePoisha);
      expect(change.toPoisha).toBe(
        (before?.pricePoisha ?? 0n) + divideRounded((before?.pricePoisha ?? 0n) * 1000n, 10_000n),
      );
    }
  });

  it('every chosen variant is a change, a problem or unchanged; nothing else moves', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            pricePoisha: amount,
            compareAtPoisha: fc.option(amount, { nil: null }),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        fc.array(fc.boolean(), { minLength: 30, maxLength: 30 }),
        rule,
        fc.constantFrom('price' as const, 'compareAt' as const),
        (rows, picks, chosenRule, field) => {
          const variants = rows.map((row, index) => ({
            skuId: `sku-${String(index)}`,
            pricePoisha: row.pricePoisha,
            compareAtPoisha:
              row.compareAtPoisha === null ? null : row.pricePoisha + row.compareAtPoisha,
          }));
          const chosen = new Set(
            variants.filter((_, index) => picks[index] === true).map((variant) => variant.skuId),
          );
          const plan = planBulkPrices(variants, chosen, chosenRule, field);
          expect(plan.changes.length + plan.problems.length + plan.unchanged).toBe(chosen.size);
          for (const change of plan.changes) {
            expect(chosen.has(change.skuId)).toBe(true);
            expect(change.toPoisha > 0n).toBe(true);
            const variant = variants.find((entry) => entry.skuId === change.skuId);
            const price = field === 'price' ? change.toPoisha : (variant?.pricePoisha ?? 0n);
            const regular =
              field === 'price' ? (variant?.compareAtPoisha ?? null) : change.toPoisha;
            expect(compareAtProblem(price, regular)).toBeNull();
          }
        },
      ),
    );
  });

  it('names a variant whose regular price the change would overtake', () => {
    const plan = planBulkPrices(
      [{ skuId: 'a', pricePoisha: 100_000n, compareAtPoisha: 105_000n }],
      new Set(['a']),
      { kind: 'percent', basisPoints: 1000n },
    );
    expect(plan.problems).toEqual([{ skuId: 'a', reason: 'regular-not-above-price' }]);
    expect(plan.changes).toEqual([]);
  });

  it('a regular-price set gives one to variants that had none', () => {
    const plan = planBulkPrices(
      [{ skuId: 'a', pricePoisha: 100_000n, compareAtPoisha: null }],
      new Set(['a']),
      { kind: 'set', amountPoisha: 150_000n },
      'compareAt',
    );
    expect(plan.changes).toEqual([{ skuId: 'a', fromPoisha: null, toPoisha: 150_000n }]);
  });
});

describe('compareAtProblem (D-640)', () => {
  it('a regular price is optional and, when set, above the selling price', () => {
    fc.assert(
      fc.property(amount, fc.option(amount, { nil: null }), (price, regular) => {
        const problem = compareAtProblem(price, regular);
        if (regular === null) expect(problem).toBeNull();
        else expect(problem === null).toBe(regular > price);
      }),
    );
  });
});

describe('gridPrice (D-635)', () => {
  it('the row, then the size, then the colour, then the main price', () => {
    expect(gridPrice(1n, 2n, 3n, 4n)).toBe(1n);
    expect(gridPrice(null, 2n, 3n, 4n)).toBe(2n);
    expect(gridPrice(null, null, 3n, 4n)).toBe(3n);
    expect(gridPrice(null, null, null, 4n)).toBe(4n);
    expect(gridPrice(null, null, null, null)).toBeNull();
  });
});

describe('prefillUnitCost (D-637, D-638)', () => {
  it("the supplier's standard, then any supplier's, then the last price, never zero", () => {
    fc.assert(
      fc.property(
        fc.option(fc.bigInt({ min: 0n, max: 1_000_000n }), { nil: null }),
        fc.option(fc.bigInt({ min: 0n, max: 1_000_000n }), { nil: null }),
        fc.option(fc.bigInt({ min: 0n, max: 1_000_000n }), { nil: null }),
        (supplierStandard, standard, last) => {
          const filled = prefillUnitCost({ supplierStandard, standard, last });
          const expected = [supplierStandard, standard, last].find(
            (value) => value !== null && value > 0n,
          );
          expect(filled.unitCostPoisha).toBe(expected ?? null);
          if (filled.unitCostPoisha !== null) expect(filled.unitCostPoisha > 0n).toBe(true);
        },
      ),
    );
    expect(prefillUnitCost({ supplierStandard: 800n, standard: 700n, last: 600n }).source).toBe(
      'supplier-standard',
    );
    expect(prefillUnitCost({ supplierStandard: null, standard: 700n, last: 600n }).source).toBe(
      'standard',
    );
    expect(prefillUnitCost({ supplierStandard: null, standard: null, last: 600n }).source).toBe(
      'last',
    );
  });
});

describe('marginBps (D-636)', () => {
  it('is (price − cost) / price in basis points, rounded once', () => {
    expect(marginBps(150_000n, 75_000n)).toBe(5000n);
    expect(marginBps(150_000n, 0n)).toBe(10_000n);
    expect(marginBps(150_000n, 150_000n)).toBe(0n);
    expect(marginBps(100_000n, 120_000n)).toBe(-2000n);
    expect(marginBps(0n, 10n)).toBeNull();
    fc.assert(
      fc.property(amount, fc.bigInt({ min: 0n, max: 200_000_000n }), (price, cost) => {
        const margin = marginBps(price, cost);
        expect(margin).toBe(divideRounded((price - cost) * 10_000n, price));
        expect((margin ?? 0n) <= 10_000n).toBe(true);
      }),
    );
  });

  it('reads as a percentage with one decimal', () => {
    expect(bpsPercentText(4567n)).toBe('45.7');
    expect(bpsPercentText(10_000n)).toBe('100.0');
    expect(bpsPercentText(-50n)).toBe('-0.5');
    expect(bpsPercentText(4n)).toBe('0.0');
  });

  it('a typed percentage becomes basis points, or nothing', () => {
    expect(percentTextToBps('10')).toBe(1000n);
    expect(percentTextToBps('12.5')).toBe(1250n);
    expect(percentTextToBps('-7.25')).toBe(-725n);
    expect(percentTextToBps('+3')).toBe(300n);
    expect(percentTextToBps('1.234')).toBeNull();
    expect(percentTextToBps('ten')).toBeNull();
  });
});

describe('newVariantPrice (D-639)', () => {
  const sizes = new Set(['S', 'M', 'L', 'XL', 'XXL']);

  it("takes the same size's price in the other colours", () => {
    const existing = [
      { valueIds: ['XL', 'RED'], pricePoisha: 159_000n, active: true },
      { valueIds: ['M', 'RED'], pricePoisha: 149_000n, active: true },
    ];
    expect(newVariantPrice(['XL', 'BLUE'], sizes, existing, 149_000n)).toBe(159_000n);
  });

  it('a new size takes the main price, never the cheapest or an archived variant', () => {
    const existing = [
      { valueIds: ['S', 'RED'], pricePoisha: 99_000n, active: false },
      { valueIds: ['M', 'RED'], pricePoisha: 149_000n, active: true },
      { valueIds: ['L', 'RED'], pricePoisha: 149_000n, active: true },
      { valueIds: ['XL', 'RED'], pricePoisha: 159_000n, active: true },
    ];
    expect(newVariantPrice(['XXL', 'RED'], sizes, existing, null)).toBe(149_000n);
    expect(newVariantPrice(['XXL', 'RED'], sizes, existing, 169_000n)).toBe(169_000n);
    expect(newVariantPrice(['S', 'BLUE'], sizes, existing, null)).toBe(149_000n);
  });

  it('is never an archived price and never below every active price unless typed', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            size: fc.constantFrom('S', 'M', 'L', 'XL'),
            pricePoisha: amount,
            active: fc.boolean(),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        fc.constantFrom('S', 'M', 'L', 'XL', 'XXL'),
        (rows, size) => {
          const existing = rows.map((row) => ({
            valueIds: [row.size, 'RED'],
            pricePoisha: row.pricePoisha,
            active: row.active,
          }));
          const price = newVariantPrice([size, 'BLUE'], sizes, existing, null);
          const active = existing.filter((variant) => variant.active);
          if (active.length === 0) {
            expect(price).toBeNull();
            return;
          }
          expect(active.some((variant) => variant.pricePoisha === price)).toBe(true);
        },
      ),
    );
  });

  it('the most common price, a tie going to the higher', () => {
    expect(mostCommonPrice([1n, 2n, 2n, 3n])).toBe(2n);
    expect(mostCommonPrice([1n, 3n])).toBe(3n);
    expect(mostCommonPrice([])).toBeNull();
  });
});

describe('axisOrderFromCode (D-639)', () => {
  it('reads the axis order back from an existing code', () => {
    expect(
      axisOrderFromCode('ELY-PNJ-0007-XL-RED', [
        { attributeId: 'colour', valueCode: 'RED' },
        { attributeId: 'size', valueCode: 'XL' },
      ]),
    ).toEqual(['size', 'colour']);
    expect(
      axisOrderFromCode('ELY-0007-RED-XL', [
        { attributeId: 'size', valueCode: 'XL' },
        { attributeId: 'colour', valueCode: 'RED' },
      ]),
    ).toEqual(['colour', 'size']);
  });

  it('leaves out what a code kept from another system does not show', () => {
    expect(axisOrderFromCode('OLD123', [{ attributeId: 'size', valueCode: 'M' }])).toEqual([]);
  });

  it('ranks size before colour before the rest', () => {
    expect(
      ['custom', 'colour', 'size'].sort((a, b) => attributeKindRank(a) - attributeKindRank(b)),
    ).toEqual(['size', 'colour', 'custom']);
  });
});

describe('storefrontPrice with a regular price (D-640)', () => {
  it('strikes through the regular price, or the higher of shelf and regular under a flash price', () => {
    const sku = { id: 's', pricePoisha: poisha(149_000), compareAtPoisha: poisha(189_000) };
    expect(storefrontPrice(sku)).toEqual({ pricePoisha: 149_000n, compareAtPoisha: 189_000n });
    expect(storefrontPrice(sku, [{ skuId: 's', pricePoisha: poisha(119_000) }])).toEqual({
      pricePoisha: 119_000n,
      compareAtPoisha: 189_000n,
    });
    expect(
      storefrontPrice({ id: 's', pricePoisha: poisha(149_000), compareAtPoisha: null }, [
        { skuId: 's', pricePoisha: poisha(119_000) },
      ]),
    ).toEqual({ pricePoisha: 119_000n, compareAtPoisha: 149_000n });
  });

  it('never strikes through a figure at or below what the shopper pays', () => {
    fc.assert(
      fc.property(
        amount,
        fc.option(fc.bigInt({ min: 0n, max: 200_000_000n }), { nil: null }),
        fc.array(fc.bigInt({ min: -10n, max: 200_000_000n }), { maxLength: 4 }),
        (shelf, regular, offers) => {
          const price = storefrontPrice(
            {
              id: 's',
              pricePoisha: shelf as Poisha,
              compareAtPoisha: regular === null ? null : (regular as Poisha),
            },
            offers.map((value) => ({ skuId: 's', pricePoisha: value as Poisha })),
          );
          expect(price.pricePoisha <= shelf).toBe(true);
          if (price.compareAtPoisha !== null) {
            expect(price.compareAtPoisha > price.pricePoisha).toBe(true);
          }
        },
      ),
    );
  });
});

describe('the standard buying price spreadsheet (D-638)', () => {
  const skus = new Set(['ELY-0001-M', 'ELY-0001-L']);
  const suppliers = new Set(['SUP-A']);

  it('reads every priced row, skips blank ones and reports every problem', () => {
    const table = parseCsv(
      [
        'sku,product,variant,supplier,standard_cost_taka',
        'ELY-0001-M,Shirt,M,,820',
        'ELY-0001-M,Shirt,M,SUP-A,800.50',
        'ELY-0001-L,Shirt,L,,',
        'ELY-0009-X,Nothing,,,10',
        'ELY-0001-L,Shirt,L,SUP-Z,0',
        'ELY-0001-M,Shirt,M,,830',
      ].join('\n'),
    );
    const report = reviewStandardCostImport(table, skus, suppliers);
    expect(report.rows).toEqual([
      { line: 2, sku: 'ELY-0001-M', supplierCode: null, unitCostPoisha: 82_000n },
      { line: 3, sku: 'ELY-0001-M', supplierCode: 'SUP-A', unitCostPoisha: 80_050n },
    ]);
    expect(report.skipped).toBe(1);
    expect(report.problems.map((problem) => [problem.line, problem.column])).toEqual([
      [5, 'sku'],
      [6, 'supplier'],
      [6, 'standard_cost_taka'],
      [7, 'sku'],
    ]);
  });

  it('refuses a column it does not read', () => {
    const report = reviewStandardCostImport(
      parseCsv('sku,standard_cost_taka,price_taka\nELY-0001-M,1,2\n'),
      skus,
      suppliers,
    );
    expect(report.problems.some((problem) => problem.column === 'price_taka')).toBe(true);
  });

  it('exports what it imports, with formula-looking names kept as text', () => {
    const text = standardCostCsv([
      {
        sku: 'ELY-0001-M',
        product: '=Shirt',
        variant: 'M',
        supplierCode: null,
        unitCostPoisha: 82_050n,
      },
      {
        sku: 'ELY-0001-L',
        product: 'Shirt, cotton',
        variant: 'L',
        supplierCode: 'SUP-A',
        unitCostPoisha: null,
      },
    ]);
    expect(text).toBe(
      'sku,product,variant,supplier,standard_cost_taka\nELY-0001-M,\'=Shirt,M,,820.50\nELY-0001-L,"Shirt, cotton",L,SUP-A,\n',
    );
    const report = reviewStandardCostImport(parseCsv(text), skus, suppliers);
    expect(report.problems).toEqual([]);
    expect(report.rows).toEqual([
      { line: 2, sku: 'ELY-0001-M', supplierCode: null, unitCostPoisha: 82_050n },
    ]);
    expect(report.skipped).toBe(1);
  });
});

describe('parcelWeightGrams (D-645)', () => {
  it('sums qty × grams, and gives the courier its default when any line has no weight', () => {
    expect(
      parcelWeightGrams([
        { qty: 2, grams: 350 },
        { qty: 1, grams: 420 },
      ]),
    ).toBe(1120);
    expect(
      parcelWeightGrams([
        { qty: 2, grams: 350 },
        { qty: 1, grams: null },
      ]),
    ).toBeNull();
    expect(parcelWeightGrams([])).toBeNull();
    expect(parcelWeightGrams([{ qty: 0, grams: 350 }])).toBeNull();
  });
});
