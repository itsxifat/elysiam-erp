import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { addDays, toIsoDate, type IsoDate } from '../dates/index.js';
import { monthDays, toPayrollMonth, weekdayOf, type WorkCalendar } from '../payroll/index.js';
import {
  deskEventFrom,
  dhakaHour,
  evaluateBonus,
  monthWeeks,
  movesTargets,
  nearestRank,
  parseBonusRule,
  pickupSamples,
  productivity,
  rollupProgress,
  splitTarget,
  TargetError,
  type AgentDayResult,
  type DeskEvent,
} from './index.js';

const FRIDAY_OFF: WorkCalendar = { weeklyOff: [5], holidays: [] };

describe('monthWeeks', () => {
  it('starts each week on Saturday and clips to the month', () => {
    // October 2026 starts on a Thursday: a two-day first week (Thu, Fri), then Saturdays.
    const weeks = monthWeeks(toPayrollMonth('2026-10'));
    expect(weeks.map((week) => [week.startsOn, week.endsOn])).toEqual([
      ['2026-10-01', '2026-10-02'],
      ['2026-10-03', '2026-10-09'],
      ['2026-10-10', '2026-10-16'],
      ['2026-10-17', '2026-10-23'],
      ['2026-10-24', '2026-10-30'],
      ['2026-10-31', '2026-10-31'],
    ]);
    for (const week of weeks.slice(1)) expect(weekdayOf(week.startsOn)).toBe(6);
  });
});

describe('the weekly split (M20 check 1)', () => {
  const month = fc
    .tuple(fc.integer({ min: 2000, max: 2099 }), fc.integer({ min: 1, max: 12 }))
    .map(([year, monthNo]) =>
      toPayrollMonth(`${String(year)}-${String(monthNo).padStart(2, '0')}`),
    );

  /** A random calendar: any set of weekly offs, and random holidays inside the month. */
  const calendarFor = (days: readonly IsoDate[]) =>
    fc.record({
      weeklyOff: fc.uniqueArray(fc.integer({ min: 0, max: 6 }), { maxLength: 7 }),
      holidays: fc.subarray([...days]),
    });

  const scenario = month.chain((m) =>
    fc.record({
      month: fc.constant(m),
      calendar: calendarFor(monthDays(m)),
      total: fc.oneof(
        fc.bigInt({ min: 0n, max: 1_000n }),
        fc.bigInt({ min: 0n, max: 900_000_000_000n }),
      ),
      weekStartsOn: fc.integer({ min: 0, max: 6 }),
    }),
  );

  it('sums exactly to the target for random months, calendars and targets', () => {
    fc.assert(
      fc.property(scenario, ({ month: m, calendar, total, weekStartsOn }) => {
        const weeks = splitTarget(total, m, calendar, weekStartsOn);
        expect(weeks.reduce((sum, week) => sum + week.planned, 0n)).toBe(total);
      }),
      { numRuns: 500 },
    );
  });

  it('never plans a negative week, and tiles the month with no gap or overlap', () => {
    fc.assert(
      fc.property(scenario, ({ month: m, calendar, total, weekStartsOn }) => {
        const weeks = splitTarget(total, m, calendar, weekStartsOn);
        const days = monthDays(m);
        expect(weeks[0]?.startsOn).toBe(days[0]);
        expect(weeks[weeks.length - 1]?.endsOn).toBe(days[days.length - 1]);
        for (const [index, week] of weeks.entries()) {
          expect(week.planned >= 0n).toBe(true);
          const next = weeks[index + 1];
          if (next !== undefined) expect(next.startsOn).toBe(addDays(week.endsOn, 1));
        }
        expect(weeks.reduce((sum, week) => sum + week.calendarDays, 0)).toBe(days.length);
      }),
      { numRuns: 300 },
    );
  });

  it('gives each week its working-day share, off by less than one unit', () => {
    fc.assert(
      fc.property(scenario, ({ month: m, calendar, total, weekStartsOn }) => {
        const weeks = splitTarget(total, m, calendar, weekStartsOn);
        const working = weeks.reduce((sum, week) => sum + week.workingDays, 0);
        const weightOf = (week: (typeof weeks)[number]) =>
          BigInt(working === 0 ? week.calendarDays : week.workingDays);
        const totalWeight = weeks.reduce((sum, week) => sum + weightOf(week), 0n);
        for (const week of weeks) {
          // |planned − total × w / W| < 1, in integers: |planned × W − total × w| < W.
          const gap = week.planned * totalWeight - total * weightOf(week);
          expect(gap < totalWeight && -gap < totalWeight).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('asks less of the week with the Eid holidays', () => {
    // March 2026, Fridays off, Eid on Thu 19 – Sun 22 (one of them a Friday anyway).
    const calendar: WorkCalendar = {
      weeklyOff: [5],
      holidays: ['2026-03-19', '2026-03-20', '2026-03-21', '2026-03-22'].map(toIsoDate),
    };
    const weeks = splitTarget(270n, toPayrollMonth('2026-03'), calendar);
    expect(weeks.map((week) => week.workingDays)).toEqual([5, 6, 5, 4, 4]);
    expect(weeks.map((week) => week.planned)).toEqual([56n, 68n, 56n, 45n, 45n]);
    expect(weeks.reduce((sum, week) => sum + week.planned, 0n)).toBe(270n);
  });

  it('gives a one-order target to the earliest of the fullest weeks', () => {
    const weeks = splitTarget(1n, toPayrollMonth('2026-10'), FRIDAY_OFF);
    expect(weeks.map((week) => week.planned)).toEqual([0n, 1n, 0n, 0n, 0n, 0n]);
  });

  it('splits a month with no working days by calendar days instead of losing it', () => {
    const calendar: WorkCalendar = { weeklyOff: [0, 1, 2, 3, 4, 5, 6], holidays: [] };
    const weeks = splitTarget(31n, toPayrollMonth('2026-10'), calendar);
    expect(weeks.map((week) => week.workingDays)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(weeks.map((week) => week.planned)).toEqual([2n, 7n, 7n, 7n, 7n, 1n]);
  });

  it('refuses a negative target', () => {
    expect(() => splitTarget(-1n, toPayrollMonth('2026-10'), FRIDAY_OFF)).toThrow(TargetError);
  });
});

describe('progress rollup', () => {
  const weeks = splitTarget(100n, toPayrollMonth('2026-10'), FRIDAY_OFF);
  const day = (userId: string, date: string, confirmed: number, delivered = 0, revenue = 0n) =>
    ({
      userId,
      businessDate: toIsoDate(date),
      confirmedOrders: confirmed,
      deliveredOrders: delivered,
      deliveredRevenuePoisha: revenue,
    }) satisfies AgentDayResult;

  it('adds members’ days into their weeks and ignores everybody else', () => {
    const progress = rollupProgress({
      metric: 'confirmed_orders',
      targetValue: 100n,
      weeks,
      memberUserIds: ['usr_a', 'usr_b'],
      results: [
        day('usr_a', '2026-10-01', 3),
        day('usr_b', '2026-10-02', 2),
        day('usr_a', '2026-10-05', 10),
        day('usr_c', '2026-10-05', 99),
        day('usr_a', '2026-09-30', 50),
        day('usr_a', '2026-11-01', 50),
      ],
    });
    expect(progress.weeks.slice(0, 2)).toEqual([
      { weekNo: 1, achieved: 5n },
      { weekNo: 2, achieved: 10n },
    ]);
    expect(progress.achieved).toBe(15n);
    expect(progress.pctBps).toBe(1500);
  });

  it('sums revenue in poisha for a revenue target', () => {
    const progress = rollupProgress({
      metric: 'delivered_revenue',
      targetValue: 10_000_000n,
      weeks,
      memberUserIds: ['usr_a'],
      results: [day('usr_a', '2026-10-10', 0, 2, 2_500_050n)],
    });
    expect(progress.achieved).toBe(2_500_050n);
    expect(progress.pctBps).toBe(2500);
  });
});

describe('the bonus evaluator (M20 check 2)', () => {
  // §12's example, verbatim.
  const example = parseBonusRule({
    metric: 'delivered_orders',
    tiers: [
      { gte_pct: 100, amount_poisha: 200000 },
      { gte_pct: 120, per_unit_above_target_poisha: 5000 },
    ],
  });

  const table: readonly [string, bigint, bigint, bigint][] = [
    // label, target, achieved, expected bonus (poisha)
    ['nothing below the first tier', 100n, 99n, 0n],
    ['the flat amount exactly at 100%', 100n, 100n, 200_000n],
    ['still only flat at 119%', 100n, 119n, 200_000n],
    ['flat plus every unit above target at 120%', 100n, 120n, 200_000n + 20n * 5_000n],
    ['flat plus 50 units at 150%', 100n, 150n, 200_000n + 50n * 5_000n],
    ['exact threshold on an odd target: 37 of 37', 37n, 37n, 200_000n],
    ['36 of 37 is 97.3%, not 100%', 37n, 36n, 0n],
    ['45 of 37 is 121.6%: 8 units above', 37n, 45n, 200_000n + 8n * 5_000n],
    ['44 of 37 is 118.9%: below 120%', 37n, 44n, 200_000n],
    ['nothing achieved', 100n, 0n, 0n],
  ];

  it.each(table)('%s', (_label, targetValue, achieved, expected) => {
    expect(evaluateBonus(example, { targetValue, achieved }).amountPoisha).toBe(expected);
  });

  it('reports which tiers were met', () => {
    const result = evaluateBonus(example, { targetValue: 100n, achieved: 125n });
    expect(result.tiers.map((tier) => [tier.gtePct, tier.met, tier.amountPoisha])).toEqual([
      [100, true, 200_000n],
      [120, true, 125_000n],
    ]);
    expect(result.pctBps).toBe(12_500);
    expect(result.capped).toBe(false);
  });

  const revenue = parseBonusRule({
    metric: 'delivered_revenue',
    tiers: [
      { gte_pct: 90, amount_poisha: '100000' },
      { gte_pct: 100, bps_of_excess: 250 },
    ],
    cap_poisha: 500000,
  });

  const revenueTable: readonly [string, bigint, bigint, bigint, boolean][] = [
    ['below 90%', 1_000_000_00n, 89_999_999n, 0n, false],
    ['90% pays the flat amount', 1_000_000_00n, 90_000_000n, 100_000n, false],
    // 2.5% of ৳10,000.01 excess = 25,000.025 poisha → 25,000 (half away from zero).
    ['2.5% of the excess, rounded once', 100_000_000n, 101_000_001n, 100_000n + 25_000n, false],
    // 2.5% of a 3-poisha excess is 0.075 poisha, which rounds to nothing.
    ['a tiny excess rounds to nothing', 100_000_000n, 100_000_003n, 100_000n, false],
    ['the cap holds', 100_000_000n, 200_000_000n, 500_000n, true],
  ];

  it.each(revenueTable)('revenue: %s', (_label, targetValue, achieved, expected, capped) => {
    const result = evaluateBonus(revenue, { targetValue, achieved });
    expect(result.amountPoisha).toBe(expected);
    expect(result.capped).toBe(capped);
  });

  const refusals: readonly [string, unknown][] = [
    ['not an object', 'delivered_orders'],
    ['an unknown metric', { metric: 'leads', tiers: [{ gte_pct: 100, amount_poisha: 1 }] }],
    ['no tiers', { metric: 'delivered_orders', tiers: [] }],
    [
      'a misspelt amount key',
      { metric: 'delivered_orders', tiers: [{ gte_pct: 100, amount_poisa: 200000 }] },
    ],
    [
      'two kinds in one tier',
      {
        metric: 'delivered_orders',
        tiers: [{ gte_pct: 100, amount_poisha: 1, per_unit_above_target_poisha: 1 }],
      },
    ],
    [
      'falling thresholds',
      {
        metric: 'delivered_orders',
        tiers: [
          { gte_pct: 120, amount_poisha: 1 },
          { gte_pct: 100, amount_poisha: 1 },
        ],
      },
    ],
    [
      'a fractional threshold',
      { metric: 'delivered_orders', tiers: [{ gte_pct: 99.5, amount_poisha: 1 }] },
    ],
    [
      'a float amount',
      { metric: 'delivered_orders', tiers: [{ gte_pct: 100, amount_poisha: 2000.5 }] },
    ],
    ['a zero amount', { metric: 'delivered_orders', tiers: [{ gte_pct: 100, amount_poisha: 0 }] }],
    [
      'per unit on revenue',
      { metric: 'delivered_revenue', tiers: [{ gte_pct: 100, per_unit_above_target_poisha: 5 }] },
    ],
    [
      'a share of an order count',
      { metric: 'confirmed_orders', tiers: [{ gte_pct: 100, bps_of_excess: 100 }] },
    ],
    [
      'an unknown top-level key',
      { metric: 'delivered_orders', tiers: [{ gte_pct: 100, amount_poisha: 1 }], floor: 1 },
    ],
  ];

  it.each(refusals)('refuses %s', (_label, input) => {
    expect(() => parseBonusRule(input)).toThrow(TargetError);
  });

  it('refuses to evaluate against a zero target', () => {
    expect(() => evaluateBonus(example, { targetValue: 0n, achieved: 5n })).toThrow(TargetError);
  });

  it('never pays more than the cap, and never less than zero (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000n }),
        fc.bigInt({ min: 0n, max: 30_000n }),
        (targetValue, achieved) => {
          const capped = parseBonusRule({
            metric: 'delivered_orders',
            tiers: [
              { gte_pct: 100, amount_poisha: 200000 },
              { gte_pct: 120, per_unit_above_target_poisha: 5000 },
            ],
            cap_poisha: 1_000_000,
          });
          const amount = evaluateBonus(capped, { targetValue, achieved }).amountPoisha;
          expect(amount >= 0n && amount <= 1_000_000n).toBe(true);
          if (achieved * 100n < targetValue * 100n) expect(amount).toBe(0n);
        },
      ),
    );
  });
});

describe('pickup time on seeded event streams (M20 check 3)', () => {
  const T0 = Date.parse('2026-10-05T04:00:00Z'); // 10:00 in Dhaka
  const at = (seconds: number) => new Date(T0 + seconds * 1000);
  let seq = 0;
  const ev = (
    orderId: string,
    kind: DeskEvent['kind'],
    s: number,
    who: { assignee?: string; actor?: string } = {},
  ): DeskEvent => {
    seq += 1;
    return {
      eventId: `e${String(seq).padStart(4, '0')}`,
      orderId,
      kind,
      at: at(s),
      assignee: who.assignee ?? null,
      actor: who.actor ?? null,
    };
  };
  const brief = (events: readonly DeskEvent[]) =>
    pickupSamples(events).map((sample) => [
      sample.orderId,
      sample.agent,
      sample.seconds,
      sample.via,
    ]);

  it('a queue order claimed four minutes later: 240 s for the claimer', () => {
    const events = [
      ev('o1', 'created', 0, { actor: 'usr_intake' }),
      ev('o1', 'claimed', 240, { assignee: 'usr_a', actor: 'usr_a' }),
      ev('o1', 'confirmed', 300, { actor: 'usr_a' }),
    ];
    expect(brief(events)).toEqual([['o1', 'usr_a', 240, 'claimed']]);
  });

  it('assigned at creation by a supervisor, confirmed by the assignee', () => {
    const events = [
      ev('o2', 'created', 0, { assignee: 'usr_a', actor: 'usr_sup' }),
      ev('o2', 'confirmed', 95, { actor: 'usr_a' }),
    ];
    expect(brief(events)).toEqual([['o2', 'usr_a', 95, 'confirmed']]);
  });

  it('reassignment before pickup resets the clock for the new assignee only', () => {
    const events = [
      ev('o3', 'created', 0, { assignee: 'usr_a', actor: 'usr_sup' }),
      ev('o3', 'assigned', 600, { assignee: 'usr_b', actor: 'usr_sup' }),
      ev('o3', 'cancelled', 660, { actor: 'usr_b' }),
    ];
    // usr_a held it ten minutes and lost it: no sample. usr_b took 60 s, not 660.
    expect(brief(events)).toEqual([['o3', 'usr_b', 60, 'cancelled']]);
  });

  it('reassignment after pickup gives the new assignee their own first action', () => {
    const events = [
      ev('o4', 'created', 0, { assignee: 'usr_a', actor: 'usr_sup' }),
      ev('o4', 'confirmed', 30, { actor: 'usr_a' }),
      ev('o4', 'assigned', 1000, { assignee: 'usr_b', actor: 'usr_sup' }),
      ev('o4', 'cancelled', 1120, { actor: 'usr_b' }),
    ];
    expect(brief(events)).toEqual([
      ['o4', 'usr_a', 30, 'confirmed'],
      ['o4', 'usr_b', 120, 'cancelled'],
    ]);
  });

  it('assigned to the same person again does not restart their clock', () => {
    const events = [
      ev('o5', 'created', 0, { assignee: 'usr_a', actor: 'usr_sup' }),
      ev('o5', 'assigned', 100, { assignee: 'usr_a', actor: 'usr_sup' }),
      ev('o5', 'confirmed', 130, { actor: 'usr_a' }),
    ];
    expect(brief(events)).toEqual([['o5', 'usr_a', 130, 'confirmed']]);
  });

  it('a supervisor confirming the assignee’s order stops the clock with no sample', () => {
    const events = [
      ev('o6', 'created', 0, { assignee: 'usr_a', actor: 'usr_sup' }),
      ev('o6', 'confirmed', 500, { actor: 'usr_sup' }),
      ev('o6', 'cancelled', 900, { actor: 'usr_a' }),
    ];
    expect(brief(events)).toEqual([]);
  });

  it('an order the agent typed in themselves is not a pickup', () => {
    const events = [
      ev('o7', 'created', 0, { assignee: 'usr_a', actor: 'usr_a' }),
      ev('o7', 'confirmed', 25, { actor: 'usr_a' }),
    ];
    expect(brief(events)).toEqual([]);
  });

  it('confirmed straight from the queue counts for whoever confirmed it, from creation', () => {
    const events = [
      ev('o8', 'created', 0, { actor: 'usr_intake' }),
      ev('o8', 'confirmed', 75, { actor: 'usr_c' }),
    ];
    expect(brief(events)).toEqual([['o8', 'usr_c', 75, 'confirmed']]);
  });

  it('is unmoved by a duplicated and shuffled stream', () => {
    const events = [
      ev('o9', 'created', 0, { assignee: 'usr_a', actor: 'usr_sup' }),
      ev('o9', 'assigned', 200, { assignee: 'usr_b', actor: 'usr_sup' }),
      ev('o9', 'confirmed', 290, { actor: 'usr_b' }),
    ];
    const expected = brief(events);
    expect(expected).toEqual([['o9', 'usr_b', 90, 'confirmed']]);
    fc.assert(
      fc.property(fc.shuffledSubarray([...events, ...events], { minLength: 6 }), (shuffled) => {
        expect(brief(shuffled)).toEqual(expected);
      }),
    );
  });

  it('a claim at the same instant as creation is a zero-second pickup, not a lost one', () => {
    const events = [
      ev('o10', 'claimed', 0, { assignee: 'usr_a', actor: 'usr_a' }),
      ev('o10', 'created', 0, { actor: 'usr_intake' }),
    ];
    expect(brief(events)).toEqual([['o10', 'usr_a', 0, 'claimed']]);
  });
});

describe('productivity per agent', () => {
  const T0 = Date.parse('2026-10-05T04:00:00Z'); // 10:00 Dhaka
  const at = (minutes: number) => new Date(T0 + minutes * 60_000);
  let seq = 0;
  const ev = (
    orderId: string,
    kind: DeskEvent['kind'],
    minutes: number,
    who: { assignee?: string; actor?: string } = {},
  ): DeskEvent => {
    seq += 1;
    return {
      eventId: `p${String(seq)}`,
      orderId,
      kind,
      at: at(minutes),
      assignee: who.assignee ?? null,
      actor: who.actor ?? null,
    };
  };

  it('reports median and p90 pickup and orders per active hour', () => {
    const events: DeskEvent[] = [];
    // usr_a claims ten queue orders after 1..10 minutes, across two Dhaka hours.
    for (let i = 1; i <= 10; i += 1) {
      events.push(ev(`q${String(i)}`, 'created', i * 5, { actor: 'usr_intake' }));
      events.push(ev(`q${String(i)}`, 'claimed', i * 5 + i, { assignee: 'usr_a', actor: 'usr_a' }));
    }
    const [a] = productivity(events, { from: at(0), to: at(24 * 60) }).filter(
      (row) => row.agent === 'usr_a',
    );
    expect(a?.pickups).toBe(10);
    expect(a?.medianPickupSeconds).toBe(5 * 60);
    expect(a?.p90PickupSeconds).toBe(9 * 60);
    expect(a?.handledOrders).toBe(10);
    // Claims at 10:06 … 11:00: the 10 o'clock and 11 o'clock hours.
    expect(a?.activeHours).toBe(2);
    expect(a?.ordersPerActiveHour).toBe(5);
  });

  it('counts a pickup in the window it was picked up in, timed from before it', () => {
    const events = [
      ev('w1', 'created', 0, { actor: 'usr_intake' }),
      ev('w1', 'claimed', 120, { assignee: 'usr_a', actor: 'usr_a' }),
    ];
    const rows = productivity(events, { from: at(60), to: at(180) });
    expect(rows).toEqual([
      {
        agent: 'usr_a',
        pickups: 1,
        medianPickupSeconds: 7200,
        p90PickupSeconds: 7200,
        handledOrders: 1,
        activeHours: 1,
        ordersPerActiveHour: 1,
      },
    ]);
  });

  it('nearest rank is an observed value', () => {
    expect(nearestRank([], 50)).toBeNull();
    expect(nearestRank([7], 90)).toBe(7);
    expect(nearestRank([1, 2, 3, 4], 50)).toBe(2);
    expect(nearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
  });

  it('buckets hours in Asia/Dhaka, not UTC', () => {
    expect(dhakaHour(new Date('2026-10-05T18:30:00Z'))).toBe('2026-10-06 00');
  });
});

describe('which outbox events are desk events', () => {
  const id = '00000000-0000-4000-8000-000000000001';

  it.each([
    [
      'order.created',
      { id, assignedTo: 'usr_a' },
      { kind: 'created', orderId: id, assignee: 'usr_a' },
    ],
    ['order.created', { id, assignedTo: null }, { kind: 'created', orderId: id, assignee: null }],
    [
      'order.assigned',
      { id, assignedTo: 'usr_b' },
      { kind: 'assigned', orderId: id, assignee: 'usr_b' },
    ],
    [
      'order.claimed',
      { id, assignedTo: 'usr_a' },
      { kind: 'claimed', orderId: id, assignee: 'usr_a' },
    ],
    [
      'order.status_changed',
      { id, to: 'confirmed' },
      { kind: 'confirmed', orderId: id, assignee: null },
    ],
    [
      'order.status_changed',
      { id, to: 'cancelled' },
      { kind: 'cancelled', orderId: id, assignee: null },
    ],
    ['order.status_changed', { id, to: 'shipped' }, null],
    ['stock.low', { id }, null],
  ] as const)('%s %j', (name, payload, expected) => {
    expect(deskEventFrom(name, payload)).toEqual(expected);
  });

  it('moves targets only on the statuses a target counts', () => {
    for (const to of ['confirmed', 'delivered', 'partially_delivered', 'returned', 'cancelled']) {
      expect(movesTargets(to)).toBe(true);
    }
    for (const to of ['pending', 'on_hold', 'packed', 'shipped', 'return_in_transit', 'exchange']) {
      expect(movesTargets(to)).toBe(false);
    }
  });
});
