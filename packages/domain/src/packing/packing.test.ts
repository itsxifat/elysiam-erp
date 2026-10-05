import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { addDays, businessDate } from '../dates/index.js';
import { ORDER_STATUSES, type OrderStatus } from '../orders/state.js';
import {
  isPackingVideoExpired,
  judgePackRemoval,
  judgePackScan,
  packNeeds,
  packProgress,
  packedCounts,
  packingVideoExpiry,
  packingVideoState,
  PACKING_VIDEO_RETENTION_REASONS,
  type PackOrderLine,
  type PackScanOutcome,
  type RecordedPackScan,
} from './index.js';

/**
 * Scan-to-pack and the packing video's retention (M38b, D-610, D-612), against random orders,
 * random scans and random clocks.
 */

const DAY = 86_400_000;

// --- scanning ------------------------------------------------------------------------------

/** A small order: up to four SKUs over up to three products, each line 1 to 4 pieces. */
const orderArb = fc
  .array(
    fc.record({
      sku: fc.integer({ min: 0, max: 5 }),
      product: fc.integer({ min: 0, max: 2 }),
      qty: fc.integer({ min: 1, max: 4 }),
    }),
    { minLength: 1, maxLength: 5 },
  )
  .map((lines) =>
    // A SKU belongs to one product: the first line's product wins.
    lines.map((line, index) => ({
      skuId: `sku-${String(line.sku)}`,
      productId: `product-${String(lines.find((other) => other.sku === line.sku)?.product ?? index)}`,
      qty: line.qty,
    })),
  );

/** A SKU of the brand, in or out of the order: product chosen the same way as the order. */
const scanArb = fc.option(
  fc.record({ sku: fc.integer({ min: 0, max: 9 }), product: fc.integer({ min: 0, max: 4 }) }),
  { nil: null, freq: 6 },
);

/** Play scans one by one through the judge, as the server does, and record each. */
function play(
  lines: readonly PackOrderLine[],
  scans: readonly ({ sku: number; product: number } | null)[],
): { recorded: RecordedPackScan[]; outcomes: PackScanOutcome[] } {
  const needs = packNeeds(lines);
  const productOf = new Map(lines.map((line) => [line.skuId, line.productId]));
  const recorded: RecordedPackScan[] = [];
  const outcomes: PackScanOutcome[] = [];
  for (const scan of scans) {
    const skuId = scan === null ? null : `sku-${String(scan.sku)}`;
    const scanned =
      skuId === null
        ? null
        : { skuId, productId: productOf.get(skuId) ?? `product-${String(scan?.product ?? 0)}` };
    const outcome = judgePackScan({ needs, packed: packedCounts(recorded), scanned });
    recorded.push({ skuId, outcome });
    outcomes.push(outcome);
  }
  return { recorded, outcomes };
}

describe('judgePackScan (D-610)', () => {
  it('never puts more of a SKU in the box than the order needs', () => {
    fc.assert(
      fc.property(orderArb, fc.array(scanArb, { maxLength: 40 }), (lines, scans) => {
        const { recorded } = play(lines, scans);
        const needs = packNeeds(lines);
        const counts = packedCounts(recorded);
        for (const [skuId, count] of counts) {
          const need = needs.find((entry) => entry.skuId === skuId);
          expect(need, `${skuId} is not in the order`).toBeDefined();
          expect(count).toBeLessThanOrEqual(need?.required ?? 0);
        }
      }),
    );
  });

  it('never accepts a SKU the order does not have, and names a wrong size apart from a wrong product', () => {
    fc.assert(
      fc.property(orderArb, fc.array(scanArb, { maxLength: 30 }), (lines, scans) => {
        const { recorded } = play(lines, scans);
        const inOrder = new Set(lines.map((line) => line.skuId));
        const products = new Set(lines.map((line) => line.productId));
        const productOf = new Map(lines.map((line) => [line.skuId, line.productId]));
        recorded.forEach((scan, index) => {
          if (scan.skuId === null) {
            expect(scan.outcome).toBe('unknown_code');
            return;
          }
          if (inOrder.has(scan.skuId)) {
            expect(['accepted', 'over']).toContain(scan.outcome);
            return;
          }
          const product =
            productOf.get(scan.skuId) ?? `product-${String(scans[index]?.product ?? 0)}`;
          expect(scan.outcome).toBe(products.has(product) ? 'wrong_variant' : 'wrong_item');
        });
      }),
    );
  });

  it('accepts exactly the pieces the order needs when every needed piece is scanned in turn', () => {
    fc.assert(
      fc.property(orderArb, (lines) => {
        const needs = packNeeds(lines);
        const scans = needs.flatMap((need) =>
          Array.from({ length: need.required }, () => ({
            sku: Number(need.skuId.slice(4)),
            product: 0,
          })),
        );
        const { recorded, outcomes } = play(lines, scans);
        expect(outcomes.every((outcome) => outcome === 'accepted')).toBe(true);
        const progress = packProgress(needs, packedCounts(recorded));
        expect(progress.complete).toBe(true);
        expect(progress.unitsPacked).toBe(progress.unitsRequired);
        // One more of anything the order has is refused as one too many.
        const first = needs[0];
        if (first !== undefined) {
          expect(
            judgePackScan({
              needs,
              packed: packedCounts(recorded),
              scanned: { skuId: first.skuId, productId: first.productId },
            }),
          ).toBe('over');
        }
      }),
    );
  });

  it('is complete exactly when every SKU is at its quantity and nothing else is in the box', () => {
    fc.assert(
      fc.property(
        orderArb,
        fc.dictionary(fc.constantFrom('sku-0', 'sku-1', 'sku-2', 'sku-7'), fc.nat({ max: 6 })),
        (lines, raw) => {
          const needs = packNeeds(lines);
          const packed = new Map(Object.entries(raw).filter(([, count]) => count > 0));
          const progress = packProgress(needs, packed);
          const exact =
            needs.every((need) => (packed.get(need.skuId) ?? 0) === need.required) &&
            [...packed.keys()].every((skuId) => needs.some((need) => need.skuId === skuId));
          expect(progress.complete).toBe(exact);
        },
      ),
    );
  });
});

describe('the packed count and taking a piece out', () => {
  it('counts accepted pieces less removed ones, and ignores refusals', () => {
    const counts = packedCounts([
      { skuId: 'a', outcome: 'accepted' },
      { skuId: 'a', outcome: 'accepted' },
      { skuId: 'a', outcome: 'removed' },
      { skuId: 'b', outcome: 'over' },
      { skuId: 'c', outcome: 'wrong_variant' },
      { skuId: null, outcome: 'unknown_code' },
    ]);
    expect([...counts]).toEqual([['a', 1]]);
  });

  it('takes out only a piece that is in the box', () => {
    const packed = new Map([['a', 1]]);
    expect(judgePackRemoval(packed, 'a')).toBe('removed');
    expect(judgePackRemoval(packed, 'b')).toBe('nothing_to_remove');
  });

  it('adds up an order that names one SKU on two lines', () => {
    expect(
      packNeeds([
        { skuId: 'a', productId: 'p', qty: 1 },
        { skuId: 'a', productId: 'p', qty: 2 },
        { skuId: 'b', productId: 'p', qty: 1 },
      ]),
    ).toEqual([
      { skuId: 'a', productId: 'p', required: 3 },
      { skuId: 'b', productId: 'p', required: 1 },
    ]);
  });

  it('shows an edited order with too many pieces as over, and a dropped SKU as extra', () => {
    const progress = packProgress(
      [{ skuId: 'a', productId: 'p', required: 1 }],
      new Map([
        ['a', 2],
        ['z', 1],
      ]),
    );
    expect(progress.lines[0]?.state).toBe('over');
    expect(progress.extra).toEqual([{ skuId: 'z', packed: 1 }]);
    expect(progress.complete).toBe(false);
  });

  it('never calls an order with no pieces complete', () => {
    expect(packProgress([], new Map()).complete).toBe(false);
  });
});

// --- the packing video's retention ------------------------------------------------------------

const instantArb = fc
  .integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2030, 11, 31) })
  .map((ms) => new Date(ms));

const IN_FLIGHT: readonly OrderStatus[] = ORDER_STATUSES.filter(
  (status) => !(PACKING_VIDEO_RETENTION_REASONS as readonly string[]).includes(status),
);

describe('packingVideoExpiry (D-612)', () => {
  it('never deletes a video before seven whole days after the order reached its end state', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PACKING_VIDEO_RETENTION_REASONS),
        instantArb,
        fc.integer({ min: 0, max: 20 * DAY }),
        (status, since, after) => {
          const now = new Date(since.getTime() + after);
          if (isPackingVideoExpired({ status, statusSince: since }, now)) {
            expect(now.getTime() - since.getTime()).toBeGreaterThanOrEqual(7 * DAY);
          }
        },
      ),
    );
  });

  it('always deletes it once nine days have passed', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PACKING_VIDEO_RETENTION_REASONS),
        instantArb,
        fc.integer({ min: 9 * DAY, max: 400 * DAY }),
        (status, since, after) => {
          expect(
            isPackingVideoExpired(
              { status, statusSince: since },
              new Date(since.getTime() + after),
            ),
          ).toBe(true);
        },
      ),
    );
  });

  it('never deletes the video of an order still on its way, however old', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...IN_FLIGHT),
        instantArb,
        fc.integer({ min: 0, max: 4000 * DAY }),
        (status, since, after) => {
          expect(packingVideoExpiry({ status, statusSince: since })).toBeNull();
          expect(
            isPackingVideoExpired(
              { status, statusSince: since },
              new Date(since.getTime() + after),
            ),
          ).toBe(false);
        },
      ),
    );
  });

  it('keeps it through the seventh Dhaka day after delivery and lets it go on the eighth', () => {
    // Delivered at 23:30 in Dhaka on 6 October (17:30 UTC).
    const since = new Date('2026-10-06T17:30:00Z');
    const expiry = packingVideoExpiry({ status: 'delivered', statusSince: since });
    expect(expiry).toEqual({
      reason: 'delivered',
      keepThrough: '2026-10-13',
      deleteFrom: '2026-10-14',
    });
    // 23:59 on the 13th in Dhaka: kept. 00:00 on the 14th in Dhaka: due.
    expect(
      isPackingVideoExpired(
        { status: 'delivered', statusSince: since },
        new Date('2026-10-13T17:59:00Z'),
      ),
    ).toBe(false);
    expect(
      isPackingVideoExpired(
        { status: 'delivered', statusSince: since },
        new Date('2026-10-13T18:00:00Z'),
      ),
    ).toBe(true);
  });

  it('counts the day in Dhaka, not in UTC', () => {
    // 00:30 on 7 October in Dhaka is still 6 October in UTC.
    const since = new Date('2026-10-06T18:30:00Z');
    expect(businessDate(since)).toBe('2026-10-07');
    expect(packingVideoExpiry({ status: 'returned', statusSince: since })?.keepThrough).toBe(
      addDays(businessDate(since), 7),
    );
  });

  it('keeps the video of an ended order with no record of when it ended', () => {
    expect(packingVideoExpiry({ status: 'cancelled', statusSince: null })).toBeNull();
    expect(
      isPackingVideoExpired(
        { status: 'cancelled', statusSince: null },
        new Date(Date.UTC(2040, 0)),
      ),
    ).toBe(false);
  });
});

describe('packingVideoState (D-611)', () => {
  const now = new Date('2026-10-06T10:00:00Z');
  const finished = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);

  it('is off when recording was off and nothing was recorded', () => {
    expect(
      packingVideoState({
        videoRequired: false,
        sessionOpen: false,
        completedAt: finished(500),
        parts: [],
        now,
      }),
    ).toBe('off');
  });

  it('waits for a video while the session is open or just finished, then calls it missing', () => {
    const base = { videoRequired: true, parts: [], now };
    expect(packingVideoState({ ...base, sessionOpen: true, completedAt: null })).toBe('pending');
    expect(packingVideoState({ ...base, sessionOpen: false, completedAt: finished(30) })).toBe(
      'pending',
    );
    expect(packingVideoState({ ...base, sessionOpen: false, completedAt: finished(121) })).toBe(
      'missing',
    );
    const unarrived = [
      { attached: true, deleted: false },
      { attached: false, deleted: false },
    ];
    expect(
      packingVideoState({
        ...base,
        parts: unarrived,
        sessionOpen: false,
        completedAt: finished(121),
      }),
    ).toBe('missing');
  });

  it('is uploaded when every part arrived, and deleted once retention took them all', () => {
    const base = { videoRequired: true, sessionOpen: false, completedAt: finished(5000), now };
    expect(packingVideoState({ ...base, parts: [{ attached: true, deleted: false }] })).toBe(
      'uploaded',
    );
    expect(packingVideoState({ ...base, parts: [{ attached: false, deleted: true }] })).toBe(
      'deleted',
    );
  });
});
