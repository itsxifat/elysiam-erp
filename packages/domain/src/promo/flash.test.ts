import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { poisha } from '../money/index.js';
import {
  bestFlashOffer,
  flashSaleStatus,
  planFlashLines,
  rankFlashOffers,
  type FlashOffer,
} from './flash.js';

/**
 * Which flash offer prices a line (M35a, D-542): the old site's rule, cheapest live offer
 * below the shelf price, then the one ending soonest.
 */

const NOW = new Date('2026-10-05T10:00:00+06:00');
const HOUR = 3_600_000;
const SHELF = poisha(150_000);

function offer(id: string, fields: Partial<FlashOffer> = {}): FlashOffer {
  return {
    flashSaleItemId: id,
    flashSaleId: `sale-${id}`,
    skuId: 'sku-1',
    salePricePoisha: poisha(120_000),
    unitsLeft: 5,
    startsAt: new Date(NOW.getTime() - HOUR),
    endsAt: new Date(NOW.getTime() + HOUR),
    enabled: true,
    priority: 0,
    ...fields,
  };
}

describe('flash offers (D-542)', () => {
  it('names a sale draft, scheduled, live or ended', () => {
    const sale = { enabled: true, startsAt: NOW, endsAt: new Date(NOW.getTime() + HOUR) };
    expect(flashSaleStatus({ ...sale, enabled: false }, NOW)).toBe('draft');
    expect(flashSaleStatus(sale, new Date(NOW.getTime() - 1))).toBe('scheduled');
    expect(flashSaleStatus(sale, NOW)).toBe('live');
    expect(flashSaleStatus(sale, new Date(NOW.getTime() + HOUR))).toBe('live');
    expect(flashSaleStatus(sale, new Date(NOW.getTime() + HOUR + 1))).toBe('ended');
    expect(flashSaleStatus({ enabled: true, startsAt: null, endsAt: null }, NOW)).toBe('live');
  });

  it('takes the cheapest, then the one ending soonest', () => {
    const offers = [
      offer('dear', { salePricePoisha: poisha(130_000) }),
      offer('late', { endsAt: new Date(NOW.getTime() + 5 * HOUR) }),
      offer('soon', { endsAt: new Date(NOW.getTime() + 2 * 60_000) }),
      offer('open', { endsAt: null }),
    ];
    expect(rankFlashOffers(SHELF, offers, NOW).map((entry) => entry.flashSaleItemId)).toEqual([
      'soon',
      'late',
      'open',
      'dear',
    ]);
    expect(bestFlashOffer(SHELF, offers, NOW)?.flashSaleItemId).toBe('soon');
  });

  it('ignores an offer not below the shelf price, not live, switched off or sold out', () => {
    const offers = [
      offer('same', { salePricePoisha: SHELF }),
      offer('later', { startsAt: new Date(NOW.getTime() + 1) }),
      offer('over', { endsAt: new Date(NOW.getTime() - 1) }),
      offer('off', { enabled: false }),
      offer('gone', { unitsLeft: 0 }),
    ];
    expect(rankFlashOffers(SHELF, offers, NOW)).toEqual([]);
    expect(bestFlashOffer(SHELF, offers, NOW)).toBeNull();
  });

  it('a whole line or nothing: three units skip an offer with two left', () => {
    const offers = [
      offer('two', { salePricePoisha: poisha(100_000), unitsLeft: 2 }),
      offer('all', { salePricePoisha: poisha(110_000), unitsLeft: null }),
    ];
    expect(bestFlashOffer(SHELF, offers, NOW, 3)?.flashSaleItemId).toBe('all');
    expect(bestFlashOffer(SHELF, offers, NOW, 2)?.flashSaleItemId).toBe('two');
  });

  it('plans lines in turn, each using up what the next one sees', () => {
    const offers = [offer('five', { salePricePoisha: poisha(100_000), unitsLeft: 5 })];
    const plan = planFlashLines(
      [
        { skuId: 'sku-1', qty: 3, shelfPricePoisha: SHELF },
        { skuId: 'sku-1', qty: 3, shelfPricePoisha: SHELF },
        { skuId: 'sku-1', qty: 2, shelfPricePoisha: SHELF },
      ],
      offers,
      NOW,
    );
    expect(plan.map((entry) => entry.offer?.flashSaleItemId ?? null)).toEqual([
      'five',
      null,
      'five',
    ]);
    expect(plan.map((entry) => entry.unitPricePoisha)).toEqual([100_000n, 150_000n, 100_000n]);
    // The second line could have had two at the sale price.
    expect(plan[1]?.best?.left).toBe(2);
  });

  it('never prices a line above its shelf price, nor beyond an offer’s units', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            price: fc.bigInt({ min: 1n, max: 300_000n }),
            left: fc.option(fc.integer({ min: 0, max: 6 }), { nil: null }),
            ends: fc.option(fc.integer({ min: -2, max: 5 }), { nil: null }),
            sku: fc.constantFrom('sku-1', 'sku-2'),
          }),
          { maxLength: 6 },
        ),
        fc.array(
          fc.record({
            sku: fc.constantFrom('sku-1', 'sku-2'),
            qty: fc.integer({ min: 1, max: 4 }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (raw, lines) => {
          const offers = raw.map((entry, index) =>
            offer(`o${String(index)}`, {
              skuId: entry.sku,
              salePricePoisha: poisha(entry.price),
              unitsLeft: entry.left,
              endsAt: entry.ends === null ? null : new Date(NOW.getTime() + entry.ends * HOUR),
            }),
          );
          const plan = planFlashLines(
            lines.map((entry) => ({ skuId: entry.sku, qty: entry.qty, shelfPricePoisha: SHELF })),
            offers,
            NOW,
          );
          const taken = new Map<string, number>();
          plan.forEach((entry, index) => {
            expect(entry.unitPricePoisha <= SHELF).toBe(true);
            if (entry.offer === null) return;
            expect(entry.offer.skuId).toBe(lines[index]?.sku);
            expect(entry.offer.endsAt === null || entry.offer.endsAt >= NOW).toBe(true);
            const sofar = (taken.get(entry.offer.flashSaleItemId) ?? 0) + (lines[index]?.qty ?? 0);
            taken.set(entry.offer.flashSaleItemId, sofar);
            if (entry.offer.unitsLeft !== null) {
              expect(sofar <= entry.offer.unitsLeft).toBe(true);
            }
          });
        },
      ),
      { numRuns: 1_000 },
    );
  });
});
