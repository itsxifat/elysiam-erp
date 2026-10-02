import { describe, expect, it } from 'vitest';

import { poisha } from '../money/index.js';
import {
  aggregateMetaSpend,
  audiencePhoneHashes,
  buildPurchaseEvent,
  capiActionSource,
  capiEventTimeAllowed,
  metaAudienceCsv,
  metaCity,
  metaName,
  metaPhone,
  MetaSpendError,
  type MetaInsightRow,
  type PurchaseEventInput,
} from './index.js';

/** A visible stand-in for SHA-256, so the test can see what was hashed. */
const fakeHash = (value: string) => `h(${value})`;

const INPUT: PurchaseEventInput = {
  orderId: '7f1c2e9a-0000-4000-8000-000000000001',
  customerId: '7f1c2e9a-0000-4000-8000-0000000000c1',
  channel: 'facebook',
  deliveredAt: new Date('2026-10-01T08:30:00.000Z'),
  valuePoisha: poisha(245_050),
  phoneE164: '+8801712345678',
  name: 'Nusrat  Jahan-Khan',
  city: 'Cox’s Bazar',
  includeNameAndCity: false,
  contents: [
    { id: 'SAREE-RED-M', quantity: 1 },
    { id: 'KURTI-L', quantity: 0 },
  ],
};

describe('normalising for Meta', () => {
  it('a phone is digits with the country code and no plus', () => {
    expect(metaPhone('+8801712345678')).toBe('8801712345678');
  });

  it('a name is lower-case without punctuation, in any script', () => {
    expect(metaName('  Nusrat-Jahan  O’Neil ')).toBe('nusratjahan oneil');
    expect(metaName('নুসরাত জাহান')).toBe('নুসরাত জাহান');
  });

  it('a city loses spaces and punctuation as well', () => {
    expect(metaCity('Cox’s Bazar')).toBe('coxsbazar');
    expect(metaCity('New York')).toBe('newyork');
  });
});

describe('the Purchase event', () => {
  it('hashes the phone, the country and the buyer id, and nothing else by default', () => {
    const event = buildPurchaseEvent(INPUT, fakeHash);
    expect(event.user_data).toEqual({
      ph: ['h(8801712345678)'],
      country: ['h(bd)'],
      external_id: ['h(7f1c2e9a-0000-4000-8000-0000000000c1)'],
    });
  });

  it('adds hashed first name, last name and city only with consent', () => {
    const event = buildPurchaseEvent({ ...INPUT, includeNameAndCity: true }, fakeHash);
    expect(event.user_data.fn).toEqual(['h(nusrat)']);
    expect(event.user_data.ln).toEqual(['h(jahankhan)']);
    expect(event.user_data.ct).toEqual(['h(coxsbazar)']);
  });

  it('uses the order id as event_id and order_id, and the delivery as the event time', () => {
    const event = buildPurchaseEvent(INPUT, fakeHash);
    expect(event.event_id).toBe(INPUT.orderId);
    expect(event.custom_data.order_id).toBe(INPUT.orderId);
    expect(event.event_time).toBe(Date.parse('2026-10-01T08:30:00.000Z') / 1000);
    expect(event.event_name).toBe('Purchase');
  });

  it('values the delivered revenue in BDT, and drops lines with nothing delivered', () => {
    const event = buildPurchaseEvent(INPUT, fakeHash);
    expect(event.custom_data.value).toBe(2450.5);
    expect(JSON.stringify(event.custom_data.value)).toBe('2450.5');
    expect(event.custom_data.currency).toBe('BDT');
    expect(event.custom_data.contents).toEqual([{ id: 'SAREE-RED-M', quantity: 1 }]);
  });

  it('maps channels to documented action sources', () => {
    expect(capiActionSource('whatsapp')).toBe('chat');
    expect(capiActionSource('phone')).toBe('phone_call');
    expect(capiActionSource('walk_in')).toBe('physical_store');
    expect(capiActionSource('landing_page')).toBe('other');
  });

  it('refuses an event older than Meta’s seven days', () => {
    const delivered = new Date('2026-10-01T00:00:00Z');
    expect(capiEventTimeAllowed(delivered, new Date('2026-10-07T22:00:00Z'))).toBe(true);
    expect(capiEventTimeAllowed(delivered, new Date('2026-10-08T00:00:00Z'))).toBe(false);
  });
});

function row(fields: Partial<MetaInsightRow>): MetaInsightRow {
  return {
    campaignId: '1202',
    campaignName: 'Eid',
    adId: 'ad-1',
    accountCurrency: 'BDT',
    dateStart: '2026-10-01',
    dateStop: '2026-10-01',
    spend: '0',
    ...fields,
  };
}

describe('aggregating Insights rows', () => {
  it('sums ad-level spend per campaign per day exactly, then rounds once', () => {
    const result = aggregateMetaSpend([
      row({ adId: 'ad-1', spend: '100.005' }),
      row({ adId: 'ad-2', spend: '100.005' }),
      row({ adId: 'ad-1', dateStart: '2026-10-02', dateStop: '2026-10-02', spend: '5339.5' }),
      row({ campaignId: '1303', campaignName: 'Puja', adId: 'ad-9', spend: '12' }),
    ]);
    expect(result.days).toEqual([
      { metaCampaignId: '1202', campaignName: 'Eid', spendOn: '2026-10-01', amountPoisha: 20_001n },
      { metaCampaignId: '1303', campaignName: 'Puja', spendOn: '2026-10-01', amountPoisha: 1_200n },
      {
        metaCampaignId: '1202',
        campaignName: 'Eid',
        spendOn: '2026-10-02',
        amountPoisha: 533_950n,
      },
    ]);
    expect(result.adsByCampaign.get('1202')).toEqual(['ad-1', 'ad-2']);
  });

  it('refuses a non-BDT account, a multi-day row and a malformed spend', () => {
    expect(() => aggregateMetaSpend([row({ accountCurrency: 'USD' })])).toThrow(MetaSpendError);
    expect(() => aggregateMetaSpend([row({ dateStop: '2026-10-02' })])).toThrow(MetaSpendError);
    expect(() => aggregateMetaSpend([row({ spend: '1e3' })])).toThrow(MetaSpendError);
  });
});

describe('the hashed custom-audience file', () => {
  it('normalises, de-duplicates and hashes each phone, and never writes a number', () => {
    const hashes = audiencePhoneHashes(
      ['+8801712345678', '+8801712345678', '+8801812345678'],
      fakeHash,
    );
    expect(hashes).toEqual(['h(8801712345678)', 'h(8801812345678)']);
    expect(metaAudienceCsv(hashes)).toBe('phone\nh(8801712345678)\nh(8801812345678)\n');
  });
});
