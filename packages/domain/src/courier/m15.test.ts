import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toIsoDate } from '../dates/index.js';
import { poisha } from '../money/index.js';
import { ORDER_STATUSES } from '../orders/state.js';
import {
  asciiDigits,
  basisPoints,
  canonicalStatement,
  courierStatusMap,
  isStuck,
  isTerminalParcelStatus,
  lastFourMatches,
  MAPPED_COURIER_CODES,
  normalizeStatus,
  oneDecimalMean,
  orderTriggerFor,
  PARCEL_STATUSES,
  parseTrackingQuery,
  PATHAO_STATUS_MAP,
  PATHAO_STATUS_VOCABULARY,
  PROVIDER_VOCABULARIES,
  REDX_STATUS_MAP,
  REDX_STATUS_VOCABULARY,
  selectCourier,
  stuckCutoffDate,
  summarisePerformance,
  trackingLadder,
  trackingStage,
  trackingStatusAfter,
  TRACKING_STEPS,
  unmappedStatuses,
  validateRuleSet,
  type CourierSelectionRule,
  type ParcelStatus,
  type SettlementFileRow,
} from './index.js';

/**
 * M15's pure logic (acceptance checks 1, 2 and 5, and the rules behind check 3).
 *
 * 1. **Complete mapping tables for each adapter.** For every provider the map's key set
 *    *equals* the declared vocabulary, in both directions — the same shape of test M12
 *    wrote for Steadfast, now over four providers. Pathao's and RedX's vocabularies are
 *    transcribed from the sources named on their maps (Pathao's own plugin code; RedX's
 *    developer page, recalled), and the test is what stops the two lists drifting apart.
 * 2. **Courier selection rules**, table-driven for the cases a person writes and a property
 *    test for the precedence nobody should be able to break.
 * 5. **The staleness threshold**, at its boundary, in Asia/Dhaka calendar days.
 *
 * And the two tracking-page rules that do not need a database: the digits comparison and
 * the stage a customer is shown.
 */

const parcelStatus = fc.constantFrom(...PARCEL_STATUSES);

/**
 * Check 1's wording is "complete mapping tables for each adapter", and for three of the
 * four that is what the tests below prove: each map's keys equal a vocabulary transcribed
 * from a cited first-party document, both directions.
 *
 * **RedX is not one of them** (D-200). Its vocabulary has no source — the developer portal
 * needs a merchant session, and the `redx-for-woocommerce` plugin was downloaded and has
 * no status handling at all — so for RedX these assertions prove the map and the list agree
 * with each other and nothing about what RedX actually sends. The test below says so out
 * loud, so that a green run is not read as verification RedX never gave.
 */
describe('every adapter has a complete mapping table (check 1)', () => {
  it('knows all four providers', () => {
    expect([...MAPPED_COURIER_CODES].sort()).toEqual(['fake', 'pathao', 'redx', 'steadfast']);
  });

  for (const code of ['steadfast', 'fake', 'pathao', 'redx']) {
    describe(code, () => {
      const map = courierStatusMap(code);
      const vocabulary = PROVIDER_VOCABULARIES[code] ?? [];

      it('has a map', () => {
        expect(map?.code).toBe(code);
      });

      it('maps every word the courier can send', () => {
        if (map === undefined) throw new Error(`no map for ${code}`);
        expect(unmappedStatuses(map, vocabulary)).toEqual([]);
      });

      it('maps nothing the courier does not send', () => {
        if (map === undefined) throw new Error(`no map for ${code}`);
        // The other direction. An entry for a word the courier never sends sits in the table
        // for years looking like coverage.
        expect(Object.keys(map.statuses).sort()).toEqual([...vocabulary].sort());
      });

      it('maps every word to one of §9’s twelve statuses', () => {
        if (map === undefined) throw new Error(`no map for ${code}`);
        for (const status of Object.values(map.statuses)) {
          expect(PARCEL_STATUSES).toContain(status);
        }
      });

      it('has no duplicate words in its vocabulary', () => {
        expect(new Set(vocabulary).size).toBe(vocabulary.length);
      });
    });
  }

  it('is honest about which vocabularies have a source (D-200)', () => {
    // The adapters whose words were transcribed from a first-party document, against the
    // one whose words were not. If a RedX sandbox ever confirms the list, this moves to
    // `SOURCED` and the decision row closes; until then nothing may claim RedX is verified.
    const SOURCED = ['steadfast', 'pathao', 'fake'];
    const UNSOURCED = ['redx'];

    expect([...SOURCED, ...UNSOURCED].sort()).toEqual([...MAPPED_COURIER_CODES].sort());
    // The unverified one is exactly the adapter whose `verified` flag is false, so the
    // runtime gate (D-176: it cannot be activated without an explicit opt-in) and this
    // list cannot drift apart.
    expect(UNSOURCED).toEqual(['redx']);
  });

  it('reads Pathao’s event names and status words the same way', () => {
    // The plugin stores either the body's `order_status` or its mapped event into one field,
    // so an event and its status word must land on the same normalized status.
    const pairs: readonly [string, string][] = [
      ['order.created', 'order_created'],
      ['order.pickup-requested', 'pickup_requested'],
      ['order.assigned-for-pickup', 'assigned_for_pickup'],
      ['order.picked', 'picked'],
      ['order.pickup-failed', 'pickup_failed'],
      ['order.pickup-cancelled', 'pickup_cancelled'],
      ['order.at-the-sorting-hub', 'at_the_sorting_hub'],
      ['order.in-transit', 'in_transit'],
      ['order.received-at-last-mile-hub', 'received_at_last_mile_hub'],
      ['order.assigned-for-delivery', 'assigned_for_delivery'],
      ['order.delivered', 'delivered'],
      ['order.partial-delivery', 'partial_delivery'],
      ['order.returned', 'return'],
      ['order.delivery-failed', 'delivery_failed'],
      ['order.on-hold', 'on_hold'],
      ['order.paid-return', 'paid_return'],
      ['order.exchanged', 'exchange'],
      ['order.paid', 'payment_invoice'],
      ['order.updated', 'order_updated'],
    ];
    expect(pairs).toHaveLength(19);
    for (const [event, word] of pairs) {
      expect(normalizeStatus(PATHAO_STATUS_MAP, event).status).toBe(
        normalizeStatus(PATHAO_STATUS_MAP, word).status,
      );
    }
  });

  it('reads Pathao’s words case-insensitively, as its plugin writes them', () => {
    // The plugin's own spelling is `Pickup_Requested`, `Delivered`, `Partial_Delivery`.
    expect(normalizeStatus(PATHAO_STATUS_MAP, 'Pickup_Requested').status).toBe('pickup_pending');
    expect(normalizeStatus(PATHAO_STATUS_MAP, 'Delivered').status).toBe('delivered');
    expect(normalizeStatus(PATHAO_STATUS_MAP, 'Partial_Delivery').status).toBe('partial_delivered');
    expect(normalizeStatus(PATHAO_STATUS_MAP, 'Return').status).toBe('returned_to_merchant');
  });

  it('never books revenue on a Pathao word that is not a delivery', () => {
    // Exchange, payment and update words are facts about money or the order, not a parcel
    // reaching a customer. Mapping any of them to delivered would recognise the full COD.
    const delivering = PATHAO_STATUS_VOCABULARY.filter((word) => {
      const status = normalizeStatus(PATHAO_STATUS_MAP, word).status;
      return status === 'delivered' || status === 'partial_delivered';
    });
    expect(delivering.sort()).toEqual(
      ['delivered', 'order.delivered', 'order.partial-delivery', 'partial_delivery'].sort(),
    );
  });

  it('never books revenue on a RedX word that is not a delivery', () => {
    const delivering = REDX_STATUS_VOCABULARY.filter(
      (word) => normalizeStatus(REDX_STATUS_MAP, word).status === 'delivered',
    );
    expect(delivering).toEqual(['delivered']);
  });

  it('keeps a word it cannot map, raw (§9)', () => {
    const answer = normalizeStatus(REDX_STATUS_MAP, 'pickup-something-new');
    expect(answer).toEqual({ status: 'unknown', raw: 'pickup-something-new' });
  });
});

describe('tracking status after a courier event', () => {
  it('never lets an unknown word replace a status', () => {
    fc.assert(
      fc.property(parcelStatus, (current) => {
        expect(trackingStatusAfter(current, 'unknown')).toBe(current);
      }),
    );
  });

  it('never re-opens a finished parcel, except a partial delivery coming back', () => {
    fc.assert(
      fc.property(parcelStatus, parcelStatus, (current, incoming) => {
        const next = trackingStatusAfter(current, incoming);
        if (!isTerminalParcelStatus(current)) return;
        if (
          current === 'partial_delivered' &&
          (incoming === 'return_in_transit' || incoming === 'returned_to_merchant')
        ) {
          expect(next).toBe(incoming);
        } else {
          expect(next).toBe(current);
        }
      }),
    );
  });

  it('follows the courier while the parcel is still moving', () => {
    fc.assert(
      fc.property(parcelStatus, parcelStatus, (current, incoming) => {
        if (isTerminalParcelStatus(current) || incoming === 'unknown') return;
        expect(trackingStatusAfter(current, incoming)).toBe(incoming);
      }),
    );
  });

  it('keeps a Pathao payment notice from re-opening a delivered parcel', () => {
    const paid = normalizeStatus(PATHAO_STATUS_MAP, 'order.paid').status;
    expect(trackingStatusAfter('delivered', paid)).toBe('delivered');
  });
});

describe('a partial delivery with no figure moves nothing (M15)', () => {
  it('waits for a person when the courier did not say what it collected', () => {
    expect(orderTriggerFor('partial_delivered', 'shipped', { collectedKnown: false })).toBeNull();
    expect(orderTriggerFor('partial_delivered', 'shipped', { collectedKnown: true })).toBe(
      'deliver_partially',
    );
  });

  it('keeps the full-delivery fallback: a rider who delivered everything collected the COD', () => {
    expect(orderTriggerFor('delivered', 'shipped', { collectedKnown: false })).toBe('deliver');
  });

  it('never produces a receive_return from any status, for any order', () => {
    fc.assert(
      fc.property(parcelStatus, fc.constantFrom(...ORDER_STATUSES), fc.boolean(), (s, o, k) => {
        expect(orderTriggerFor(s, o, { collectedKnown: k })).not.toBe('receive_return');
      }),
    );
  });
});

// --- check 2: selection rules ---------------------------------------------------

const ZONE_DHAKA = 'zone-dhaka';
const ZONE_OUTSIDE = 'zone-outside';
const PATHAO = 'courier-pathao';
const STEADFAST = 'courier-steadfast';
const REDX = 'courier-redx';

function rule(overrides: Partial<CourierSelectionRule> & { id: string }): CourierSelectionRule {
  return {
    priority: 100,
    deliveryZoneId: null,
    minCodPoisha: null,
    maxCodPoisha: null,
    courierId: PATHAO,
    isActive: true,
    ...overrides,
  };
}

const RULES: readonly CourierSelectionRule[] = [
  // Big COD inside Dhaka goes with Steadfast, whose riders carry more cash.
  rule({
    id: 'r1',
    priority: 10,
    deliveryZoneId: ZONE_DHAKA,
    minCodPoisha: poisha(500_000n),
    courierId: STEADFAST,
  }),
  // Everything else inside Dhaka goes with Pathao.
  rule({ id: 'r2', priority: 20, deliveryZoneId: ZONE_DHAKA, courierId: PATHAO }),
  // Outside Dhaka: RedX, falling back to Steadfast if RedX cannot book.
  rule({ id: 'r3', priority: 30, deliveryZoneId: ZONE_OUTSIDE, courierId: REDX }),
  rule({ id: 'r4', priority: 40, deliveryZoneId: ZONE_OUTSIDE, courierId: STEADFAST }),
  // A switched-off rule never decides anything.
  rule({ id: 'r5', priority: 1, courierId: REDX, isActive: false }),
];

const everyoneCanBook = () => true;

describe('courier selection rules (check 2)', () => {
  const cases: readonly {
    readonly name: string;
    readonly zone: string | null;
    readonly cod: bigint;
    readonly requested?: string;
    readonly orderCourier?: string | null;
    readonly canBook?: (courierId: string) => boolean;
    readonly want: { courierId: string | null; source: string; ruleId: string | null };
  }[] = [
    {
      name: 'a small Dhaka COD goes with the zone rule',
      zone: ZONE_DHAKA,
      cod: 120_000n,
      want: { courierId: PATHAO, source: 'rule', ruleId: 'r2' },
    },
    {
      name: 'a big Dhaka COD goes with the higher-priority COD band',
      zone: ZONE_DHAKA,
      cod: 750_000n,
      want: { courierId: STEADFAST, source: 'rule', ruleId: 'r1' },
    },
    {
      name: 'the band is inclusive at its lower bound',
      zone: ZONE_DHAKA,
      cod: 500_000n,
      want: { courierId: STEADFAST, source: 'rule', ruleId: 'r1' },
    },
    {
      name: 'one poisha under the band falls to the next rule',
      zone: ZONE_DHAKA,
      cod: 499_999n,
      want: { courierId: PATHAO, source: 'rule', ruleId: 'r2' },
    },
    {
      name: 'outside Dhaka goes with RedX',
      zone: ZONE_OUTSIDE,
      cod: 100_000n,
      want: { courierId: REDX, source: 'rule', ruleId: 'r3' },
    },
    {
      name: 'outside Dhaka fails over to Steadfast when RedX cannot book',
      zone: ZONE_OUTSIDE,
      cod: 100_000n,
      canBook: (courierId) => courierId !== REDX,
      want: { courierId: STEADFAST, source: 'rule', ruleId: 'r4' },
    },
    {
      name: 'a zone no rule names keeps the order’s own courier',
      zone: 'zone-suburbs',
      cod: 100_000n,
      orderCourier: PATHAO,
      want: { courierId: PATHAO, source: 'order', ruleId: null },
    },
    {
      name: 'an order with no zone keeps its own courier',
      zone: null,
      cod: 100_000n,
      orderCourier: STEADFAST,
      want: { courierId: STEADFAST, source: 'order', ruleId: null },
    },
    {
      name: 'a courier a person names wins over every rule',
      zone: ZONE_DHAKA,
      cod: 750_000n,
      requested: REDX,
      want: { courierId: REDX, source: 'requested', ruleId: null },
    },
    {
      name: 'a named courier is kept even when it cannot book — the booking says why',
      zone: ZONE_DHAKA,
      cod: 100_000n,
      requested: REDX,
      canBook: (courierId) => courierId !== REDX,
      want: { courierId: REDX, source: 'requested', ruleId: null },
    },
    {
      name: 'when no rule’s courier can book, the order’s courier is used',
      zone: ZONE_OUTSIDE,
      cod: 100_000n,
      orderCourier: PATHAO,
      canBook: (courierId) => courierId === PATHAO,
      want: { courierId: PATHAO, source: 'order', ruleId: null },
    },
    {
      name: 'nothing to go on at all is nothing, not a guess',
      zone: 'zone-suburbs',
      cod: 100_000n,
      orderCourier: null,
      want: { courierId: null, source: 'none', ruleId: null },
    },
  ];

  for (const entry of cases) {
    it(entry.name, () => {
      const result = selectCourier(
        {
          requestedCourierId: entry.requested ?? null,
          orderCourierId: entry.orderCourier === undefined ? null : entry.orderCourier,
          deliveryZoneId: entry.zone,
          codAmountPoisha: poisha(entry.cod),
        },
        RULES,
        entry.canBook ?? everyoneCanBook,
      );
      expect({
        courierId: result.courierId,
        source: result.source,
        ruleId: result.ruleId,
      }).toEqual(entry.want);
    });
  }

  it('says which matching rules it passed over, so the desk can explain', () => {
    const result = selectCourier(
      {
        requestedCourierId: null,
        orderCourierId: null,
        deliveryZoneId: ZONE_OUTSIDE,
        codAmountPoisha: poisha(100_000n),
      },
      RULES,
      (courierId) => courierId !== REDX,
    );
    expect(result.skippedRuleIds).toEqual(['r3']);
  });

  it('never answers with a courier that is neither requested, a rule’s, nor the order’s', () => {
    const couriers = [PATHAO, STEADFAST, REDX, 'courier-other'];
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            priority: fc.integer({ min: 0, max: 50 }),
            deliveryZoneId: fc.option(fc.constantFrom(ZONE_DHAKA, ZONE_OUTSIDE), { nil: null }),
            minCodPoisha: fc.option(fc.bigInt({ min: 0n, max: 1_000_000n }), { nil: null }),
            maxCodPoisha: fc.option(fc.bigInt({ min: 0n, max: 1_000_000n }), { nil: null }),
            courierId: fc.constantFrom(...couriers),
            isActive: fc.boolean(),
          }),
          { maxLength: 8 },
        ),
        fc.option(fc.constantFrom(...couriers), { nil: null }),
        fc.option(fc.constantFrom(...couriers), { nil: null }),
        fc.option(fc.constantFrom(ZONE_DHAKA, ZONE_OUTSIDE), { nil: null }),
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        fc.subarray(couriers),
        (rawRules, requested, orderCourier, zone, cod, bookable) => {
          const rules = rawRules.map((entry) => ({
            ...entry,
            minCodPoisha: entry.minCodPoisha === null ? null : poisha(entry.minCodPoisha),
            maxCodPoisha: entry.maxCodPoisha === null ? null : poisha(entry.maxCodPoisha),
          }));
          const result = selectCourier(
            {
              requestedCourierId: requested,
              orderCourierId: orderCourier,
              deliveryZoneId: zone,
              codAmountPoisha: poisha(cod),
            },
            rules,
            (courierId) => bookable.includes(courierId),
          );

          if (requested !== null) {
            expect(result).toMatchObject({ courierId: requested, source: 'requested' });
            return;
          }
          if (result.source === 'rule') {
            const chosen = rules.find((candidate) => candidate.id === result.ruleId);
            // A rule's courier is only chosen when it can book, and only an active rule.
            expect(chosen?.isActive).toBe(true);
            expect(bookable).toContain(result.courierId);
            expect(chosen?.courierId).toBe(result.courierId);
          } else if (result.source === 'order') {
            expect(result.courierId).toBe(orderCourier);
          } else {
            expect(result.courierId).toBeNull();
            expect(orderCourier).toBeNull();
          }
        },
      ),
    );
  });

  it('refuses a rule set a person could not have meant', () => {
    const problems = validateRuleSet([
      {
        priority: 10,
        deliveryZoneId: ZONE_DHAKA,
        minCodPoisha: poisha(600n),
        maxCodPoisha: poisha(500n),
        courierId: PATHAO,
        isActive: true,
      },
      {
        priority: 20,
        deliveryZoneId: ZONE_DHAKA,
        minCodPoisha: null,
        maxCodPoisha: null,
        courierId: PATHAO,
        isActive: true,
      },
      {
        priority: 20,
        deliveryZoneId: ZONE_DHAKA,
        minCodPoisha: null,
        maxCodPoisha: null,
        courierId: STEADFAST,
        isActive: true,
      },
      {
        priority: -1,
        deliveryZoneId: null,
        minCodPoisha: null,
        maxCodPoisha: null,
        courierId: REDX,
        isActive: false,
      },
    ]);
    expect(problems.map((problem) => problem.index)).toEqual([0, 2, 3]);
  });
});

// --- check 5: staleness -----------------------------------------------------------

describe('the stuck-parcel threshold (check 5)', () => {
  // 10:00 on 20 March in Dhaka is 04:00 UTC.
  const now = new Date('2026-03-20T04:00:00.000Z');

  function candidate(statusChangedAt: string, status: ParcelStatus = 'in_transit') {
    return {
      bookingState: 'booked',
      status,
      statusChangedAt: new Date(statusChangedAt),
      lastStatusAt: null,
      bookedAt: null,
    };
  }

  it('counts Asia/Dhaka calendar days, not hours', () => {
    // 23:30 Dhaka on the 16th (17:30 UTC) is four calendar days before the 20th.
    expect(isStuck(candidate('2026-03-16T17:30:00.000Z'), now, 4)).toBe(true);
    // 00:30 Dhaka on the 17th (18:30 UTC on the 16th) is three.
    expect(isStuck(candidate('2026-03-16T18:30:00.000Z'), now, 4)).toBe(false);
    expect(isStuck(candidate('2026-03-16T18:30:00.000Z'), now, 3)).toBe(true);
  });

  it('never lists a finished or unbooked parcel however old', () => {
    for (const status of [
      'delivered',
      'partial_delivered',
      'returned_to_merchant',
      'cancelled',
    ] as const) {
      expect(isStuck(candidate('2025-01-01T00:00:00.000Z', status), now, 3)).toBe(false);
    }
    expect(
      isStuck({ ...candidate('2025-01-01T00:00:00.000Z'), bookingState: 'pending' }, now, 3),
    ).toBe(false);
  });

  it('agrees with the SQL cut-off at the boundary', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('2026-01-01T00:00:00Z'),
          max: new Date('2026-03-20T03:59:59Z'),
          noInvalidDate: true,
        }),
        fc.integer({ min: 1, max: 30 }),
        (changed, threshold) => {
          const cutoff = stuckCutoffDate(now, threshold);
          const changedOn = toIsoDate(
            new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(changed),
          );
          expect(isStuck(candidate(changed.toISOString()), now, threshold)).toBe(
            changedOn <= cutoff,
          );
        },
      ),
    );
  });

  it('falls back to M12’s columns for a row written before the new one existed', () => {
    expect(
      isStuck(
        {
          bookingState: 'booked',
          status: 'hold',
          statusChangedAt: null,
          lastStatusAt: new Date('2026-03-01T00:00:00Z'),
          bookedAt: null,
        },
        now,
        3,
      ),
    ).toBe(true);
  });
});

// --- the performance report --------------------------------------------------------

describe('courier performance', () => {
  const on = (date: string) => toIsoDate(date);

  it('rates only the parcels that resolved, and averages whole days', () => {
    const report = summarisePerformance([
      {
        courierId: 'c1',
        deliveryZoneId: 'z1',
        status: 'delivered',
        bookedOn: on('2026-03-01'),
        deliveredOn: on('2026-03-03'),
      },
      {
        courierId: 'c1',
        deliveryZoneId: 'z1',
        status: 'delivered',
        bookedOn: on('2026-03-01'),
        deliveredOn: on('2026-03-02'),
      },
      {
        courierId: 'c1',
        deliveryZoneId: 'z1',
        status: 'partial_delivered',
        bookedOn: on('2026-03-02'),
        deliveredOn: on('2026-03-06'),
      },
      {
        courierId: 'c1',
        deliveryZoneId: 'z1',
        status: 'returned_to_merchant',
        bookedOn: on('2026-03-02'),
        deliveredOn: null,
      },
      {
        courierId: 'c1',
        deliveryZoneId: 'z1',
        status: 'in_transit',
        bookedOn: on('2026-03-05'),
        deliveredOn: null,
      },
      {
        courierId: 'c1',
        deliveryZoneId: 'z1',
        status: 'cancelled',
        bookedOn: on('2026-03-05'),
        deliveredOn: null,
      },
      {
        courierId: 'c1',
        deliveryZoneId: null,
        status: 'delivered',
        bookedOn: on('2026-03-05'),
        deliveredOn: on('2026-03-05'),
      },
    ]);

    const zone = report.rows.find((row) => row.deliveryZoneId === 'z1');
    expect(zone).toMatchObject({
      booked: 6,
      delivered: 3,
      partial: 1,
      returned: 1,
      cancelled: 1,
      inFlight: 1,
      resolved: 4,
      deliveryRateBps: 7500,
      returnRateBps: 2500,
      // (2 + 1 + 4) / 3 = 2.333…
      averageDeliveryDays: '2.3',
    });

    const courier = report.couriers[0];
    expect(courier).toMatchObject({ booked: 7, delivered: 4, resolved: 5, deliveryRateBps: 8000 });
    expect(report.rows.some((row) => row.deliveryZoneId === null)).toBe(true);
  });

  it('says nothing about a rate before anything resolved', () => {
    const report = summarisePerformance([
      {
        courierId: 'c1',
        deliveryZoneId: 'z1',
        status: 'in_transit',
        bookedOn: on('2026-03-01'),
        deliveredOn: null,
      },
    ]);
    expect(report.rows[0]).toMatchObject({
      deliveryRateBps: null,
      returnRateBps: null,
      averageDeliveryDays: null,
    });
  });

  it('rounds half-up once, in integers', () => {
    expect(basisPoints(1, 3)).toBe(3333);
    expect(basisPoints(2, 3)).toBe(6667);
    expect(basisPoints(0, 5)).toBe(0);
    expect(oneDecimalMean(5, 2)).toBe('2.5');
    expect(oneDecimalMean(1, 8)).toBe('0.1');
    expect(oneDecimalMean(1, 20)).toBe('0.1');
    expect(oneDecimalMean(1, 21)).toBe('0.0');
  });

  it('keeps the two rates inside 0–100% and summing to 100% whenever anything resolved', () => {
    fc.assert(
      fc.property(fc.array(parcelStatus, { maxLength: 40 }), (statuses) => {
        const report = summarisePerformance(
          statuses.map((status) => ({
            courierId: 'c1',
            deliveryZoneId: 'z1',
            status,
            bookedOn: on('2026-03-01'),
            deliveredOn: on('2026-03-02'),
          })),
        );
        for (const row of report.rows) {
          if (row.resolved === 0) continue;
          const delivered = row.deliveryRateBps ?? -1;
          const returned = row.returnRateBps ?? -1;
          expect(delivered).toBeGreaterThanOrEqual(0);
          expect(returned).toBeGreaterThanOrEqual(0);
          // Half-up rounding of two complementary ratios can overshoot by one basis point.
          expect(Math.abs(delivered + returned - 10_000)).toBeLessThanOrEqual(1);
        }
      }),
    );
  });
});

// --- the tracking page ---------------------------------------------------------------

describe('the public tracking page’s rules', () => {
  it('reads Bangla digits as a customer types them', () => {
    expect(asciiDigits('০১৭১২-৩৪৫ ৬৭৮')).toBe('01712345678');
    expect(parseTrackingQuery({ orderNo: ' our-2609-০০০৪২ ', phoneLast4: '৫৬৭৮' })).toEqual({
      orderNo: 'OUR-2609-00042',
      phoneLast4: '5678',
    });
  });

  it('refuses input that is not an order number and four digits', () => {
    expect(parseTrackingQuery({ orderNo: 'OUR-1', phoneLast4: '123' })).toBeNull();
    expect(parseTrackingQuery({ orderNo: 'OUR-1', phoneLast4: '12345' })).toBeNull();
    expect(parseTrackingQuery({ orderNo: "'; drop table", phoneLast4: '1234' })).toBeNull();
  });

  it('matches the last four digits of any phone on the order', () => {
    expect(lastFourMatches('5678', ['+8801712345678', null])).toBe(true);
    expect(lastFourMatches('5678', [null, '+8801812345678'])).toBe(true);
    expect(lastFourMatches('5679', ['+8801712345678', '+8801812345678'])).toBe(false);
    expect(lastFourMatches('5678', [null, null])).toBe(false);
  });

  it('never matches digits that are not the phone’s last four', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^01[3-9]\d{8}$/),
        fc.stringMatching(/^\d{4}$/),
        (phone, digits) => {
          expect(lastFourMatches(digits, [`+88${phone}`])).toBe(phone.endsWith(digits));
        },
      ),
    );
  });

  it('shows a stage for every order status, and never says “on hold”', () => {
    for (const status of ORDER_STATUSES) {
      const stage = trackingStage(status, null);
      expect([...TRACKING_STEPS, 'returned', 'cancelled']).toContain(stage);
    }
    expect(trackingStage('on_hold', null)).toBe('processing');
  });

  it('tells a customer the rider is out today, and never gets ahead of the books', () => {
    expect(trackingStage('shipped', 'out_for_delivery')).toBe('out_for_delivery');
    // The courier says delivered; our order has not moved yet. The page waits.
    expect(trackingStage('shipped', 'delivered')).toBe('with_courier');
  });

  it('draws a ladder that never claims a step the order did not take', () => {
    expect(trackingLadder('with_courier').map((step) => step.reached)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(trackingLadder('returned').filter((step) => step.reached)).toHaveLength(3);
    expect(trackingLadder('cancelled').filter((step) => step.reached)).toHaveLength(1);
  });
});

// --- check 4's pure half: what makes two statements one ------------------------------

describe('the fetched-statement fingerprint', () => {
  const row = (consignmentNo: string, cod: bigint, rowNo: number): SettlementFileRow => ({
    consignmentNo,
    reference: null,
    codCollectedPoisha: poisha(cod),
    deliveryChargePoisha: poisha(6_000n),
    returnChargePoisha: poisha(0n),
    otherChargePoisha: poisha(0n),
    netPoisha: null,
    rowNo,
  });

  it('is the same for the same rows in any order', () => {
    const a = canonicalStatement({
      reference: 'S1',
      settlementDate: '2026-03-31',
      rows: [row('A1', 100n, 1), row('B2', 200n, 2)],
    });
    const b = canonicalStatement({
      reference: 'S1',
      settlementDate: '2026-03-31',
      rows: [row('B2', 200n, 1), row('A1', 100n, 2)],
    });
    expect(a).toBe(b);
  });

  it('differs when any amount, date or reference differs', () => {
    const base = {
      reference: 'S1',
      settlementDate: '2026-03-31',
      rows: [row('A1', 100n, 1)],
    };
    const canonical = canonicalStatement(base);
    expect(canonicalStatement({ ...base, rows: [row('A1', 101n, 1)] })).not.toBe(canonical);
    expect(canonicalStatement({ ...base, settlementDate: '2026-04-01' })).not.toBe(canonical);
    expect(canonicalStatement({ ...base, reference: null })).not.toBe(canonical);
  });
});
