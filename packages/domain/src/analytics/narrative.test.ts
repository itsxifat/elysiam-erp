import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Insight, InsightMonth } from './insights.js';
import {
  assertNarrativePayloadSafe,
  buildNarrativePayload,
  narrativePrompt,
  NarrativePayloadError,
  type NarrativeInput,
} from './narrative.js';

/**
 * M24 acceptance check 4: the LLM payload contains no PII (§18, invariant 10, D-327).
 *
 * The approach is to **plant** personal data everywhere the builder's inputs could carry
 * it — names, Bangladeshi phone numbers in both forms, an email, an address — and then
 * look for every planted string in the finished prompt. Three layers:
 *
 * 1. a hand-written input with PII in every string field and in fields the type does not
 *    even declare;
 * 2. a property: whatever strings are planted, none survives;
 * 3. the guard: `assertNarrativePayloadSafe` refuses a payload that carries any key or
 *    value outside the allow-list, so a later change to the builder fails closed.
 */

const CHANNELS = [
  'facebook',
  'whatsapp',
  'instagram',
  'tiktok',
  'landing_page',
  'website',
  'phone',
  'walk_in',
  'reseller',
];

const monthFigures = (seed: number): InsightMonth => ({
  ordersConfirmed: 120 + seed,
  ordersDelivered: 90 + seed,
  ordersReturned: 12,
  ordersCancelled: 4,
  deliveredRevenuePoisha: 13_500_000n,
  spendPoisha: 2_000_000n,
  pickupCount: 80,
  pickupSeconds: 24_000,
  deliveredOutsideDhaka: 40,
  returnedOutsideDhaka: 9,
});

const PLANTED = [
  'Rahim Uddin',
  'রহিম উদ্দিন',
  '01711223344',
  '+8801711223344',
  '8801711223344',
  'rahim@example.com',
  'House 12, Road 5, Dhanmondi',
  'Eid Sale for Karim',
];

function plantedInput(): NarrativeInput {
  const insights: Insight[] = [
    {
      code: 'campaign_below_break_even',
      severity: 'warning',
      params: {
        campaignId: 'Eid Sale for Karim',
        roasBps: '7500',
        spendPoisha: '600000',
        // Not a parameter any rule produces: a name and a phone smuggled in.
        buyerName: 'Rahim Uddin',
        buyerPhone: '01711223344',
      },
    },
    {
      code: 'channel_returns',
      severity: 'info',
      // A channel that is not a channel code: a person's name typed into the wrong box.
      params: { channel: 'রহিম উদ্দিন', rateBps: '3000', brandRateBps: '2000' },
    },
    {
      code: 'outside_dhaka_returns',
      severity: 'warning',
      params: { rateBps: '1837', medianBps: '1200', gapBps: '637', note: 'rahim@example.com' },
    },
  ];
  const input = {
    month: '2026-09',
    current: { ...monthFigures(0), agentName: 'Rahim Uddin', phone: '+8801711223344' },
    previous: monthFigures(5),
    insights,
    channelCodes: CHANNELS,
    // Fields the type does not declare, as a careless caller might pass a whole row.
    buyers: [
      { name: 'Rahim Uddin', phone: '8801711223344', address: 'House 12, Road 5, Dhanmondi' },
    ],
    orgName: 'Eid Sale for Karim',
  };
  return input;
}

describe('check 4: the LLM payload carries no personal data', () => {
  it('drops every planted name, phone, email and address', () => {
    const payload = buildNarrativePayload(plantedInput());
    const prompt = narrativePrompt(payload);
    const sent = `${prompt.system}\n${prompt.user}`;
    for (const planted of PLANTED) expect(sent, planted).not.toContain(planted);
    // And no digit run as long as a phone number, in any form.
    expect(prompt.user).not.toMatch(/(?:\+?88)?01[3-9]\d{8}/);
  });

  it('keeps the figures, the codes and a campaign label in place of its id', () => {
    const payload = buildNarrativePayload(plantedInput());
    expect(payload.current.ordersDelivered).toBe(90);
    expect(payload.current.deliveredRevenuePoisha).toBe('13500000');
    expect(payload.current.returnRateBps).toBe('1176');
    expect(payload.insights.map((insight) => insight.code)).toEqual([
      'campaign_below_break_even',
      'channel_returns',
      'outside_dhaka_returns',
    ]);
    expect(payload.insights[0]?.params).toEqual({
      campaign: 'campaign_1',
      roasBps: '7500',
      spendPoisha: '600000',
    });
    expect(payload.insights[1]?.params).toEqual({ rateBps: '3000', brandRateBps: '2000' });
    expect(payload.insights[2]?.params).toEqual({
      rateBps: '1837',
      medianBps: '1200',
      gapBps: '637',
    });
  });

  it('passes its own guard', () => {
    const payload = buildNarrativePayload(plantedInput());
    expect(() => {
      assertNarrativePayloadSafe(payload, CHANNELS);
    }).not.toThrow();
  });

  it('never lets a planted string through, whatever it is', () => {
    const phone = fc
      .tuple(fc.constantFrom('', '+88', '88'), fc.constantFrom('3', '4', '5', '6', '7', '8', '9'))
      .chain(([prefix, operator]) =>
        fc
          .array(fc.integer({ min: 0, max: 9 }), { minLength: 8, maxLength: 8 })
          .map((digits) => `${prefix}01${operator}${digits.join('')}`),
      );
    const words = fc
      .stringMatching(/^[A-Za-zঀ-৿][A-Za-zঀ-৿ ,.@-]{3,30}$/)
      .filter((value) => !CHANNELS.includes(value));
    const planted = fc.oneof(phone, words, fc.emailAddress());

    fc.assert(
      fc.property(planted, planted, planted, (a, b, c) => {
        const input = {
          ...plantedInput(),
          insights: [
            {
              code: 'campaign_below_break_even',
              severity: 'warning',
              params: { campaignId: a, roasBps: '100', spendPoisha: '700000', extra: b },
            },
            { code: 'channel_returns', severity: 'info', params: { channel: c, rateBps: '1' } },
          ],
          stray: { a, b, c },
        } as unknown as NarrativeInput;
        const sent = narrativePrompt(buildNarrativePayload(input)).user;
        expect(sent).not.toContain(a);
        expect(sent).not.toContain(b);
        expect(sent).not.toContain(c);
      }),
      { numRuns: 300 },
    );
  });
});

describe('the guard refuses anything outside the allow-list', () => {
  const safe = () =>
    JSON.parse(JSON.stringify(buildNarrativePayload(plantedInput()))) as Record<string, unknown>;

  it.each([
    ['a new top-level key', (p: Record<string, unknown>) => ({ ...p, orgName: 'Rahim' })],
    [
      'a name in a figure',
      (p: Record<string, unknown>) => ({
        ...p,
        current: { ...(p.current as object), deliveredRevenuePoisha: 'Rahim' },
      }),
    ],
    [
      'an unknown figure',
      (p: Record<string, unknown>) => ({
        ...p,
        current: { ...(p.current as object), topAgent: 'Rahim' },
      }),
    ],
    [
      'a free-text insight parameter',
      (p: Record<string, unknown>) => ({
        ...p,
        insights: [{ code: 'slow_pickup', severity: 'info', params: { note: 'call Rahim' } }],
      }),
    ],
    [
      'a phone in a numeric parameter name it does not own',
      (p: Record<string, unknown>) => ({
        ...p,
        insights: [{ code: 'slow_pickup', severity: 'info', params: { phone: '01711223344' } }],
      }),
    ],
    [
      'a channel that is not a channel',
      (p: Record<string, unknown>) => ({
        ...p,
        insights: [{ code: 'channel_returns', severity: 'info', params: { channel: 'Rahim' } }],
      }),
    ],
    [
      'an unknown insight code',
      (p: Record<string, unknown>) => ({
        ...p,
        insights: [{ code: 'call_rahim', severity: 'info', params: {} }],
      }),
    ],
  ])('refuses %s', (_label, tamper) => {
    expect(() => {
      assertNarrativePayloadSafe(tamper(safe()), CHANNELS);
    }).toThrow(NarrativePayloadError);
  });

  it('refuses a month that is not a month', () => {
    expect(() => buildNarrativePayload({ ...plantedInput(), month: 'Rahim' })).toThrow(RangeError);
  });
});
