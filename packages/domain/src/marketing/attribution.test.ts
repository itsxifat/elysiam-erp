import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  campaignIndex,
  resolveAttribution,
  type CampaignRef,
  type OrderAttributionSource,
} from './index.js';

/**
 * M18 acceptance check 4: "Attribution priority tests" (architecture §11).
 *
 * Three campaigns, each reachable by a different kind of id, so every step of the priority
 * can be made to disagree with the steps below it.
 */

const EXPLICIT = '00000000-0000-4000-8000-00000000000a';
const AD = '00000000-0000-4000-8000-00000000000b';
const UTM = '00000000-0000-4000-8000-00000000000c';
const PROMO = '00000000-0000-4000-8000-00000000000d';

const REFS: CampaignRef[] = [
  { campaignId: EXPLICIT, kind: 'meta_campaign', value: '120210000000001' },
  { campaignId: AD, kind: 'meta_ad', value: '120210000000777' },
  { campaignId: UTM, kind: 'utm_campaign', value: 'eid-sale' },
  // A ref to a campaign the brand does not have: ignored, never trusted.
  { campaignId: 'not-ours', kind: 'utm_campaign', value: 'ghost' },
];
const INDEX = campaignIndex([EXPLICIT, AD, UTM, PROMO], REFS);

const cases: readonly {
  readonly name: string;
  readonly source: OrderAttributionSource;
  readonly campaignId: string | null;
  readonly rule: string;
}[] = [
  {
    name: '1. our campaign id on the order wins over everything below it',
    source: { campaignId: EXPLICIT, adId: '120210000000777', utmCampaign: 'eid-sale' },
    campaignId: EXPLICIT,
    rule: 'explicit',
  },
  {
    name: '1. a Meta campaign id on the order is explicit too',
    source: { campaignId: '120210000000001', adId: '120210000000777' },
    campaignId: EXPLICIT,
    rule: 'explicit',
  },
  {
    name: '1. the promo code’s campaign is explicit, above the ad referral (D-251)',
    source: { promoCampaignId: PROMO, adId: '120210000000777', utmCampaign: 'eid-sale' },
    campaignId: PROMO,
    rule: 'explicit',
  },
  {
    name: '1. the order’s own campaign beats the promo code’s',
    source: { campaignId: EXPLICIT, promoCampaignId: PROMO },
    campaignId: EXPLICIT,
    rule: 'explicit',
  },
  {
    name: '2. the click-to-message ad referral beats a UTM',
    source: { adId: '120210000000777', utmCampaign: 'eid-sale' },
    campaignId: AD,
    rule: 'ad_referral',
  },
  {
    name: '3. a UTM maps, trimmed and case-insensitively',
    source: { utmCampaign: '  EID-Sale ' },
    campaignId: UTM,
    rule: 'utm',
  },
  {
    name: '4. nothing recorded is none',
    source: {},
    campaignId: null,
    rule: 'none',
  },
  {
    name: 'an explicit id nobody knows falls through to the ad referral',
    source: { campaignId: 'stale-123', adId: '120210000000777' },
    campaignId: AD,
    rule: 'ad_referral',
  },
  {
    name: 'an unknown ad id falls through to the UTM',
    source: { adId: '999', utmCampaign: 'eid-sale' },
    campaignId: UTM,
    rule: 'utm',
  },
  {
    name: 'a promo campaign that is not the brand’s is ignored',
    source: { promoCampaignId: 'someone-else', utmCampaign: 'eid-sale' },
    campaignId: UTM,
    rule: 'utm',
  },
  {
    name: 'a ref pointing outside the brand attributes nothing',
    source: { utmCampaign: 'ghost' },
    campaignId: null,
    rule: 'none',
  },
  {
    name: 'blank strings are not values',
    source: { campaignId: '  ', adId: '', utmCampaign: ' ' },
    campaignId: null,
    rule: 'none',
  },
];

describe('check 4: attribution follows §11’s priority', () => {
  it.each(cases)('$name', ({ source, campaignId, rule }) => {
    expect(resolveAttribution(source, INDEX)).toEqual({ campaignId, rule });
  });

  it('a matching higher step always decides, whatever the lower steps say', () => {
    const anyValue = fc.option(
      fc.constantFrom(EXPLICIT, '120210000000001', '120210000000777', 'eid-sale', 'x', ''),
      { nil: undefined },
    );
    fc.assert(
      fc.property(anyValue, anyValue, anyValue, anyValue, (campaignId, promo, ad, utm) => {
        const source = { campaignId, promoCampaignId: promo, adId: ad, utmCampaign: utm };
        const result = resolveAttribution(source, INDEX);
        const explicitHit =
          campaignId === EXPLICIT || campaignId === '120210000000001' || promo === EXPLICIT;
        if (explicitHit) return result.rule === 'explicit';
        if (ad === '120210000000777') return result.rule === 'ad_referral';
        if (utm === 'eid-sale') return result.rule === 'utm';
        return result.rule === 'none' && result.campaignId === null;
      }),
    );
  });
});
