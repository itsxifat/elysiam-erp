import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { poisha } from '@elysium/domain';
import { normalizeStatus, type ParcelInput } from '@elysium/domain/courier';

import type { AdapterContext, CourierAdapter } from './adapters/courier-adapter.js';
import { PathaoCourierAdapter } from './adapters/pathao.adapter.js';
import { RedxCourierAdapter } from './adapters/redx.adapter.js';
import { adapterEnabled, resetCourierEnv } from './courier.config.js';
import { CourierError } from './courier.errors.js';

/**
 * Contract tests for M15's two adapters (acceptance check 1).
 *
 * ## Recorded or transcribed? Transcribed. Neither adapter has ever spoken to its courier.
 *
 * No Pathao or RedX credentials exist in this environment, so nothing below was recorded
 * from a live exchange. Every request shape and response key is **transcribed** from the one
 * first-party source that could be read for each courier:
 *
 * - **Pathao**: `pathao-eng/courier-woocommerce-plugin` — `pathao-bridge.php` (hosts, the
 *   `external/login` body and answer, the order body with its casts, `data.consignment_id`),
 *   `plugin-api.php` (the `X-PATHAO-Signature` check, the nineteen event names, the body's
 *   `consignment_id` / `merchant_order_id` / `order_status` / `event`, the
 *   `webhook_integration` handshake and the `202` answer with its header), and
 *   `settings-page.php` (the webhook secret defaulting to the client secret). The status
 *   endpoint and the webhook's `collected_amount` / `timestamp` come from community clients
 *   and are marked where they are used.
 * - **RedX**: `redx-for-woocommerce` (ShopUp) — `RedxOrderActionsService.php` (the host, the
 *   `API-ACCESS-TOKEN: Bearer` header, `/wordpress/parcel` and its body, `tracking_id`). The
 *   status endpoint is community-described.
 *
 * The values in the fixtures (ids, amounts, times) are invented; the *keys* are the sources'.
 * What these tests prove is that each adapter speaks exactly that transcribed contract and
 * honours `CourierAdapter`'s rules — refusing bad input before a call, telling a courier
 * that is down from one that refuses, verifying a webhook in constant time and returning
 * `null` rather than throwing, and keeping the recipient out of the stored payload. What they
 * cannot prove is that Pathao and RedX agree; that takes a sandbox and credentials, and it is
 * why both adapters are `verified: false` and off by default.
 */

const PATHAO_CONTEXT: AdapterContext = {
  credentials: {
    clientId: 'client-id-0001',
    clientSecret: 'client-secret-0123456789',
    storeId: '12345',
    webhookSecret: 'merchant-webhook-secret-0123',
  },
  baseUrl: null,
  mode: 'sandbox',
  timeoutMs: 5_000,
};

const REDX_CONTEXT: AdapterContext = {
  credentials: { accessToken: 'redx-jwt-token' },
  baseUrl: 'https://redx.example.test/v1.0.0-beta',
  mode: 'sandbox',
  timeoutMs: 5_000,
};

function parcel(overrides: Partial<ParcelInput> = {}): ParcelInput {
  return {
    reference: 'CUR-2609-00001',
    address: {
      recipientName: 'Rahim Uddin',
      recipientPhoneE164: '+8801712345678',
      district: 'Dhaka',
      thana: 'Gulshan',
      area: 'Niketan',
      addressLine: 'House 12, Road 3',
    },
    codAmountPoisha: poisha(248_000),
    itemDescription: 'Kurti',
    note: 'Call before coming',
    weightGrams: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

// --- Pathao ------------------------------------------------------------------------------

/** `pathao-bridge.php` reads `access_token`, `refresh_token`, `expires_in` off the login. */
const PATHAO_LOGIN = {
  token_type: 'Bearer',
  expires_in: 432000,
  access_token: 'pathao-access-token',
  refresh_token: 'pathao-refresh-token',
};

/** `plugin-api.php` reads `data.consignment_id` and `data.delivery_fee` off the create. */
const PATHAO_CREATED = {
  message: 'Order Created Successfully',
  type: 'success',
  code: 200,
  data: {
    consignment_id: 'DL121224VS8TTJ',
    merchant_order_id: 'CUR-2609-00001',
    order_status: 'Pending',
    delivery_fee: 80,
  },
};

describe('the Pathao adapter (UNVERIFIED — see the file comment)', () => {
  let adapter: PathaoCourierAdapter;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetCourierEnv();
    adapter = new PathaoCourierAdapter();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetCourierEnv();
    delete process.env.COURIER_PATHAO_ENABLED;
  });

  it('logs in with the client pair, then creates the order with the plugin’s fields', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(PATHAO_LOGIN))
      .mockResolvedValueOnce(jsonResponse(PATHAO_CREATED));

    const result = await adapter.createParcel(PATHAO_CONTEXT, parcel());
    expect(result).toEqual({
      consignmentNo: 'DL121224VS8TTJ',
      trackingCode: 'DL121224VS8TTJ',
      rawStatus: 'Pending',
    });

    const [loginUrl, loginInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Sandbox mode → the plugin's "Staging" host.
    expect(loginUrl).toBe('https://courier-api-sandbox.pathao.com/aladdin/api/v1/external/login');
    expect(bodyOf(loginInit)).toEqual({
      client_id: 'client-id-0001',
      client_secret: 'client-secret-0123456789',
    });

    const [orderUrl, orderInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(orderUrl).toBe('https://courier-api-sandbox.pathao.com/aladdin/api/v1/orders');
    expect(headersOf(orderInit).Authorization).toBe('Bearer pathao-access-token');
    const body = bodyOf(orderInit);
    expect(body).toMatchObject({
      store_id: 12345,
      merchant_order_id: 'CUR-2609-00001',
      recipient_name: 'Rahim Uddin',
      // The local form a rider's app dials.
      recipient_phone: '01712345678',
      delivery_type: 48,
      item_type: 2,
      item_quantity: 1,
      // 500 g, the configured default, in the kilograms the plugin sends.
      item_weight: 0.5,
      // Whole taka as an integer: the plugin casts it with `(int)`.
      amount_to_collect: 2480,
      item_description: 'Kurti',
      special_instruction: 'Call before coming',
    });
    expect(body.recipient_address).toBe('House 12, Road 3, Niketan, Gulshan, Dhaka');
    // No Pathao location ids: this ERP has no mapping to them, and none are invented.
    expect(body).not.toHaveProperty('recipient_city');
    expect(body).not.toHaveProperty('recipient_zone');
  });

  it('uses the live host for a live account', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(PATHAO_LOGIN))
      .mockResolvedValueOnce(jsonResponse(PATHAO_CREATED));
    await adapter.createParcel({ ...PATHAO_CONTEXT, mode: 'live' }, parcel());
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://api-hermes.pathao.com/aladdin/api/v1/external/login',
    );
  });

  it('refuses a COD with poisha in it before any call, and never retries it', async () => {
    // Rounding would send a rider for a different amount than the books expect.
    await expect(
      adapter.createParcel(PATHAO_CONTEXT, parcel({ codAmountPoisha: poisha(248_050) })),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CourierError && error.code === 'CONSIGNMENT_INVALID' && !error.retryable,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a bad parcel without making a call at all (§20)', async () => {
    await expect(
      adapter.createParcel(
        PATHAO_CONTEXT,
        parcel({ address: { ...parcel().address, recipientPhoneE164: '+880123' } }),
      ),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs in once and reuses the token, and logs in again once when it is refused', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(PATHAO_LOGIN))
      .mockResolvedValueOnce(jsonResponse({ data: { order_status_slug: 'In_Transit' } }))
      .mockResolvedValueOnce(jsonResponse({ data: { order_status_slug: 'In_Transit' } }))
      // The cached token revoked early: 401, a fresh login, then the call succeeds.
      .mockResolvedValueOnce(jsonResponse({ message: 'Unauthenticated.' }, 401))
      .mockResolvedValueOnce(jsonResponse({ ...PATHAO_LOGIN, access_token: 'second-token' }))
      .mockResolvedValueOnce(jsonResponse({ data: { order_status_slug: 'Delivered' } }));

    const ref = { consignmentNo: 'DL121224VS8TTJ', reference: 'CUR-2609-00001', trackingCode: null };
    await adapter.getStatus(PATHAO_CONTEXT, ref);
    await adapter.getStatus(PATHAO_CONTEXT, ref);
    const third = await adapter.getStatus(PATHAO_CONTEXT, ref);

    expect(third.rawStatus).toBe('Delivered');
    const urls = fetchMock.mock.calls.map((call) => (call as [string])[0]);
    expect(urls.filter((url) => url.endsWith('/external/login'))).toHaveLength(2);
    expect(headersOf((fetchMock.mock.calls[5] as [string, RequestInit])[1]).Authorization).toBe(
      'Bearer second-token',
    );
  });

  it('treats credentials refused twice as permanent, and a 5xx as retryable', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Unauthenticated.' }, 401));
    await expect(adapter.createParcel(PATHAO_CONTEXT, parcel())).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CourierError &&
        error.code === 'COURIER_CREDENTIALS_MISSING' &&
        !error.retryable,
    );

    adapter.resetTokens();
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(PATHAO_LOGIN))
      .mockResolvedValueOnce(jsonResponse({ message: 'oops' }, 502));
    await expect(adapter.createParcel(PATHAO_CONTEXT, parcel())).rejects.toSatisfy(
      (error: unknown) => error instanceof CourierError && error.retryable,
    );
  });

  it('never puts the courier’s refusal body in its error (invariant 10)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(PATHAO_LOGIN))
      .mockResolvedValueOnce(
        jsonResponse({ message: 'recipient_phone 01712345678 is invalid' }, 422),
      );
    await expect(adapter.createParcel(PATHAO_CONTEXT, parcel())).rejects.toSatisfy(
      (error: unknown) => error instanceof Error && !error.message.includes('01712345678'),
    );
  });

  it('reads a polled status from the info answer (community-described)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(PATHAO_LOGIN))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            consignment_id: 'DL121224VS8TTJ',
            order_status: 'Delivered',
            order_status_slug: 'Delivered',
            updated_at: '2026-03-05 15:30:00',
          },
        }),
      );
    const status = await adapter.getStatus(PATHAO_CONTEXT, {
      consignmentNo: 'DL121224VS8TTJ',
      reference: 'CUR-2609-00001',
      trackingCode: null,
    });
    expect(normalizeStatus(adapter.statusMap, status.rawStatus).status).toBe('delivered');
    // A bare datetime is Dhaka wall time: 15:30 +06:00 is 09:30 UTC (invariant 8).
    expect(status.occurredAt?.toISOString()).toBe('2026-03-05T09:30:00.000Z');
    // The info answer has no collected figure; null means "not said".
    expect(status.collectedPoisha).toBeNull();
    expect((fetchMock.mock.calls[1] as [string])[0]).toBe(
      'https://courier-api-sandbox.pathao.com/aladdin/api/v1/orders/DL121224VS8TTJ/info',
    );
  });

  describe('its webhook', () => {
    const delivered = {
      consignment_id: 'DL121224VS8TTJ',
      merchant_order_id: 'CUR-2609-00001',
      order_status: 'Delivered',
      event: 'order.delivered',
      collected_amount: 2480,
      delivery_fee: 80,
      updated_at: '2026-03-05 15:30:00',
      timestamp: '2026-03-05T09:30:00+00:00',
      store_id: 12345,
      // What a courier echoes and what invariant 10 keeps out of our stored payload.
      recipient_name: 'Rahim Uddin',
      recipient_phone: '01712345678',
      recipient_address: 'House 12, Road 3',
    };
    const raw = (body: unknown) => Buffer.from(JSON.stringify(body), 'utf8');

    it('accepts only the merchant’s secret in X-PATHAO-Signature, and never throws for it', async () => {
      await expect(
        adapter.parseWebhook(PATHAO_CONTEXT, { headers: {}, raw: raw(delivered) }),
      ).resolves.toBeNull();
      await expect(
        adapter.parseWebhook(PATHAO_CONTEXT, {
          headers: { 'x-pathao-signature': 'client-secret-0123456789' },
          raw: raw(delivered),
        }),
      ).resolves.toBeNull();

      const events = await adapter.parseWebhook(PATHAO_CONTEXT, {
        headers: { 'x-pathao-signature': 'merchant-webhook-secret-0123' },
        raw: raw(delivered),
      });
      expect(events).toHaveLength(1);
    });

    it('falls back to the client secret, as Pathao’s plugin does, when no webhook secret is set', async () => {
      const context = {
        ...PATHAO_CONTEXT,
        credentials: { ...PATHAO_CONTEXT.credentials, webhookSecret: undefined },
      } as unknown as AdapterContext;
      const events = await adapter.parseWebhook(context, {
        headers: { 'x-pathao-signature': 'client-secret-0123456789' },
        raw: raw(delivered),
      });
      expect(events).toHaveLength(1);
    });

    it('reads the event, the collection and the instant, and keeps no recipient data', async () => {
      const events = await adapter.parseWebhook(PATHAO_CONTEXT, {
        headers: { 'x-pathao-signature': 'merchant-webhook-secret-0123' },
        raw: raw(delivered),
      });
      const event = events?.[0];
      expect(event).toMatchObject({
        consignmentNo: 'DL121224VS8TTJ',
        reference: 'CUR-2609-00001',
        rawStatus: 'Delivered',
        // Taka to poisha from the field's text, never through a float.
        collectedPoisha: '248000',
      });
      expect(event?.occurredAt?.toISOString()).toBe('2026-03-05T09:30:00.000Z');
      expect(normalizeStatus(adapter.statusMap, event?.rawStatus ?? '').status).toBe('delivered');

      const kept = JSON.stringify(event?.payload ?? {});
      expect(kept).not.toContain('01712345678');
      expect(kept).not.toContain('Rahim');
      expect(kept).not.toContain('House 12');
    });

    it('uses the event name when the body carries no status word', async () => {
      const { order_status: _dropped, ...withoutStatus } = delivered;
      const events = await adapter.parseWebhook(PATHAO_CONTEXT, {
        headers: { 'x-pathao-signature': 'merchant-webhook-secret-0123' },
        raw: raw({ ...withoutStatus, event: 'order.partial-delivery' }),
      });
      expect(events?.[0]?.rawStatus).toBe('order.partial-delivery');
      expect(normalizeStatus(adapter.statusMap, 'order.partial-delivery').status).toBe(
        'partial_delivered',
      );
    });

    it('accepts the integration handshake as authentic and names no parcel in it', async () => {
      const events = await adapter.parseWebhook(PATHAO_CONTEXT, {
        headers: { 'x-pathao-signature': 'merchant-webhook-secret-0123' },
        raw: raw({ event: 'webhook_integration' }),
      });
      expect(events).toEqual([]);
      // Pathao's panel registers a callback URL only if it answers 202 with this header.
      expect(adapter.webhookAcknowledgement.status).toBe(202);
      expect(
        adapter.webhookAcknowledgement.headers['X-Pathao-Merchant-Webhook-Integration-Secret'],
      ).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('refuses an order event that names no parcel rather than skipping it', async () => {
      await expect(
        adapter.parseWebhook(PATHAO_CONTEXT, {
          headers: { 'x-pathao-signature': 'merchant-webhook-secret-0123' },
          raw: raw({ event: 'order.delivered' }),
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof CourierError && error.code === 'CONSIGNMENT_EVENT_INVALID',
      );
    });

    it('reports no collected figure when the body gives none — never the full COD', async () => {
      const { collected_amount: _none, ...noAmount } = delivered;
      const events = await adapter.parseWebhook(PATHAO_CONTEXT, {
        headers: { 'x-pathao-signature': 'merchant-webhook-secret-0123' },
        raw: raw({ ...noAmount, event: 'order.partial-delivery', order_status: 'Partial_Delivery' }),
      });
      expect(events?.[0]?.collectedPoisha).toBeNull();
    });
  });

  it('is off until its switch is set, and the switch is read at every use', () => {
    expect(adapterEnabled(adapter)).toBe(false);
    process.env.COURIER_PATHAO_ENABLED = 'true';
    resetCourierEnv();
    expect(adapterEnabled(adapter)).toBe(true);
  });
});

// --- RedX --------------------------------------------------------------------------------

describe('the RedX adapter (UNVERIFIED — see the file comment)', () => {
  let adapter: RedxCourierAdapter;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetCourierEnv();
    adapter = new RedxCourierAdapter();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetCourierEnv();
    delete process.env.COURIER_REDX_ENABLED;
    delete process.env.COURIER_REDX_SANDBOX_BASE_URL;
  });

  it('creates a parcel with the plugin’s header, path and fields', async () => {
    // `RedxOrderActionsService.php` reads `tracking_id` off the answer.
    fetchMock.mockResolvedValue(jsonResponse({ tracking_id: '20A316TUAHFB' }));

    const result = await adapter.createParcel(REDX_CONTEXT, parcel({ weightGrams: 750 }));
    expect(result).toEqual({
      consignmentNo: '20A316TUAHFB',
      trackingCode: '20A316TUAHFB',
      rawStatus: null,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://redx.example.test/v1.0.0-beta/wordpress/parcel');
    expect(headersOf(init)['API-ACCESS-TOKEN']).toBe('Bearer redx-jwt-token');
    expect(bodyOf(init)).toEqual({
      customer_name: 'Rahim Uddin',
      customer_phone: '01712345678',
      customer_address: 'House 12, Road 3, Niketan, Gulshan, Dhaka',
      merchant_invoice_id: 'CUR-2609-00001',
      // Taka as a two-decimal string (invariant 1).
      cash_collection_amount: '2480.00',
      parcel_weight: 750,
      instruction: 'Call before coming',
      value: '2480.00',
    });
  });

  it('uses the live host for a live account with no override', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tracking_id: 'T1' }));
    await adapter.createParcel({ ...REDX_CONTEXT, baseUrl: null, mode: 'live' }, parcel());
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://openapi.redx.com.bd/v1.0.0-beta/wordpress/parcel',
    );
  });

  it('refuses a sandbox account when no sandbox host is configured — no guessed host', async () => {
    await expect(
      adapter.createParcel({ ...REDX_CONTEXT, baseUrl: null, mode: 'sandbox' }, parcel()),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CourierError && error.code === 'COURIER_ACCOUNT_INVALID' && !error.retryable,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a bad parcel without making a call at all (§20)', async () => {
    await expect(
      adapter.createParcel(REDX_CONTEXT, parcel({ codAmountPoisha: poisha(-1) })),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a 4xx as permanent and a 5xx or a silent network as retryable', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'bad area' }, 400));
    await expect(adapter.createParcel(REDX_CONTEXT, parcel())).rejects.toSatisfy(
      (error: unknown) => error instanceof CourierError && !error.retryable,
    );
    fetchMock.mockResolvedValue(jsonResponse({ message: 'down' }, 503));
    await expect(adapter.createParcel(REDX_CONTEXT, parcel())).rejects.toSatisfy(
      (error: unknown) => error instanceof CourierError && error.retryable,
    );
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(adapter.createParcel(REDX_CONTEXT, parcel())).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CourierError && error.retryable && error.code === 'COURIER_UNAVAILABLE',
    );
  });

  it('treats an accepted parcel with no tracking id as retryable, not failed', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'ok' }));
    await expect(adapter.createParcel(REDX_CONTEXT, parcel())).rejects.toSatisfy(
      (error: unknown) => error instanceof CourierError && error.retryable,
    );
  });

  it('reads a polled status (community-described)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ parcel: { tracking_id: '20A316TUAHFB', status: 'delivery-in-progress' } }),
    );
    const status = await adapter.getStatus(REDX_CONTEXT, {
      consignmentNo: '20A316TUAHFB',
      reference: 'CUR-2609-00001',
      trackingCode: '20A316TUAHFB',
    });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://redx.example.test/v1.0.0-beta/parcel/info/20A316TUAHFB',
    );
    expect(normalizeStatus(adapter.statusMap, status.rawStatus).status).toBe('out_for_delivery');
  });

  it('has no webhook — RedX specifies no way to prove a callback is RedX’s', () => {
    const contract: CourierAdapter = adapter;
    expect(contract.supportsWebhook).toBe(false);
    expect('parseWebhook' in contract).toBe(false);
  });

  it('has no settlement API, like every real courier', () => {
    const redx: CourierAdapter = adapter;
    const pathao: CourierAdapter = new PathaoCourierAdapter();
    expect('fetchSettlements' in redx).toBe(false);
    expect('fetchSettlements' in pathao).toBe(false);
  });

  it('is off until its switch is set', () => {
    expect(adapterEnabled(adapter)).toBe(false);
    process.env.COURIER_REDX_ENABLED = 'true';
    resetCourierEnv();
    expect(adapterEnabled(adapter)).toBe(true);
  });
});
