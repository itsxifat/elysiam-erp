import { describe, expect, it } from 'vitest';

import { GraphMetaGateway, MetaApiError } from './meta-gateway.js';

/**
 * The Graph adapters against a stub, never against Meta (D-257: unverified).
 *
 * What is pinned is what was read in Meta's documentation on 2026-10-02: the paths, the
 * parameters, the body, the fields read back — and that the token, which travels in the
 * query string, never reaches an error message.
 */

const TOKEN = 'EAAB-stub-token-never-real-0000000001';
const BASE = 'https://graph.example.test';

interface Seen {
  readonly url: URL;
  readonly init: RequestInit;
}

function stub(responses: readonly { status: number; body: unknown }[]) {
  const seen: Seen[] = [];
  let index = 0;
  const fetch = (url: string, init: RequestInit) => {
    seen.push({ url: new URL(url), init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(
      new Response(JSON.stringify(next?.body ?? {}), { status: next?.status ?? 200 }),
    );
  };
  const gateway = new GraphMetaGateway({
    baseUrl: BASE,
    apiVersion: 'v25.0',
    timeoutMs: 1000,
    fetch,
  });
  return { gateway, seen };
}

describe('Insights (spend import)', () => {
  it('asks for ad-level daily spend on the ad account, and follows paging on its own host', async () => {
    const { gateway, seen } = stub([
      {
        status: 200,
        body: {
          data: [
            {
              campaign_id: '1202',
              campaign_name: 'Eid',
              ad_id: '9001',
              spend: '5339.5',
              account_currency: 'BDT',
              date_start: '2026-10-01',
              date_stop: '2026-10-01',
            },
          ],
          paging: { next: `${BASE}/v25.0/act_42/insights?after=abc&access_token=${TOKEN}` },
        },
      },
      {
        status: 200,
        body: {
          data: [
            {
              campaign_id: '1202',
              campaign_name: 'Eid',
              ad_id: '9002',
              spend: '10',
              account_currency: 'BDT',
              date_start: '2026-10-02',
              date_stop: '2026-10-02',
            },
          ],
          paging: { next: `https://elsewhere.test/v25.0/act_42/insights?access_token=${TOKEN}` },
        },
      },
    ]);
    const rows = await gateway.fetchInsights({
      adAccountId: '42',
      token: TOKEN,
      since: '2026-10-01',
      until: '2026-10-02',
    });

    const first = seen[0]?.url;
    expect(first?.pathname).toBe('/v25.0/act_42/insights');
    expect(first?.searchParams.get('level')).toBe('ad');
    expect(first?.searchParams.get('time_increment')).toBe('1');
    expect(JSON.parse(first?.searchParams.get('time_range') ?? '{}')).toEqual({
      since: '2026-10-01',
      until: '2026-10-02',
    });
    expect(first?.searchParams.get('fields')?.split(',')).toEqual([
      'campaign_id',
      'campaign_name',
      'ad_id',
      'spend',
      'account_currency',
      'date_start',
      'date_stop',
    ]);
    // Page two on the configured host is followed; a next page anywhere else is not.
    expect(seen).toHaveLength(2);
    expect(rows.map((row) => [row.adId, row.spend, row.dateStart])).toEqual([
      ['9001', '5339.5', '2026-10-01'],
      ['9002', '10', '2026-10-02'],
    ]);
  });

  it('turns Meta’s error into a non-retryable refusal that never carries the token', async () => {
    const { gateway } = stub([
      {
        status: 400,
        body: {
          error: { message: 'Invalid OAuth access token.', code: 190, fbtrace_id: 'Abc' },
        },
      },
    ]);
    const failure = await gateway
      .fetchInsights({ adAccountId: '42', token: TOKEN, since: '2026-10-01', until: '2026-10-01' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MetaApiError);
    expect(failure).toMatchObject({
      retryable: false,
      status: 400,
      metaCode: 190,
      fbtraceId: 'Abc',
    });
    expect(String((failure as Error).message)).not.toContain(TOKEN);
  });

  it('treats a 5xx as worth retrying', async () => {
    const { gateway } = stub([{ status: 503, body: {} }]);
    await expect(
      gateway.fetchInsights({
        adAccountId: '42',
        token: TOKEN,
        since: '2026-10-01',
        until: '2026-10-01',
      }),
    ).rejects.toMatchObject({ retryable: true, status: 503 });
  });
});

describe('Conversions API (purchase sender)', () => {
  it('posts the events to the pixel with the test code, and reads the receipt', async () => {
    const { gateway, seen } = stub([
      { status: 200, body: { events_received: 1, messages: [], fbtrace_id: 'Xyz' } },
    ]);
    const event = {
      event_name: 'Purchase',
      event_time: 1_790_843_400,
      event_id: 'order-1',
      action_source: 'chat',
      user_data: { ph: ['a'.repeat(64)], country: ['b'.repeat(64)], external_id: ['c'.repeat(64)] },
      custom_data: {
        currency: 'BDT',
        value: 10,
        order_id: 'order-1',
        content_type: 'product',
        contents: [],
      },
    } as const;
    const receipt = await gateway.sendEvents({
      pixelId: '5550001',
      token: TOKEN,
      events: [event],
      testEventCode: 'TEST123',
    });

    expect(receipt).toEqual({ eventsReceived: 1, fbtraceId: 'Xyz', messages: [] });
    const call = seen[0];
    expect(call?.init.method).toBe('POST');
    expect(call?.url.pathname).toBe('/v25.0/5550001/events');
    expect(call?.url.searchParams.get('access_token')).toBe(TOKEN);
    expect(JSON.parse(call?.init.body as string)).toEqual({
      data: [event],
      test_event_code: 'TEST123',
    });
  });

  it('reports an unreachable Meta as retryable, without the URL', async () => {
    const gateway = new GraphMetaGateway({
      baseUrl: BASE,
      apiVersion: 'v25.0',
      timeoutMs: 1000,
      fetch: () => Promise.reject(new TypeError(`fetch failed for ${BASE}?access_token=${TOKEN}`)),
    });
    const failure = await gateway
      .sendEvents({ pixelId: '1', token: TOKEN, events: [], testEventCode: null })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ retryable: true, status: null });
    expect(String((failure as Error).message)).not.toContain(TOKEN);
  });
});
