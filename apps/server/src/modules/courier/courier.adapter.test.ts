import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { poisha } from '@elysium/domain';
import {
  normalizeStatus,
  PARCEL_STATUSES,
  PROVIDER_VOCABULARIES,
  unmappedStatuses,
  type ParcelInput,
} from '@elysium/domain/courier';

import { FakeCourierAdapter } from './adapters/fake.adapter.js';
import { PathaoCourierAdapter } from './adapters/pathao.adapter.js';
import { RedxCourierAdapter } from './adapters/redx.adapter.js';
import { SteadfastCourierAdapter } from './adapters/steadfast.adapter.js';
import { parseCsvStatement } from './adapters/csv-statement.js';
import type { AdapterContext, CourierAdapter } from './adapters/courier-adapter.js';
import { resetCourierEnv } from './courier.config.js';
import { CourierError } from './courier.errors.js';

/**
 * Adapter contract tests (M12 acceptance checks 1 and 2; architecture §9, §21).
 *
 * ## What "recorded fixtures" means here, honestly
 *
 * Check 1 is "adapter contract tests pass against recorded fixtures. A live sandbox smoke test
 * runs if credentials exist; otherwise it is skipped and noted in the report."
 *
 * The Steadfast fixtures below are **transcribed, not recorded**. Steadfast's API document is
 * behind a merchant-portal login this build had no account for; the request and response
 * shapes come from Steadfast's own `steadfast-it/SteadFast-Courier-Laravel-Package` README,
 * which is first-party in authorship and second-hand as a specification. That is why the
 * adapter reports `verified: false`, why activating an account on it needs
 * `COURIER_STEADFAST_ENABLED=true`, and why D-176 records it as UNVERIFIED.
 *
 * **The live sandbox smoke test is skipped**, because no credentials exist in this
 * environment. It is written out below rather than omitted, so the first person with a
 * sandbox key runs one command; the skip is unconditional on `COURIER_SMOKE_API_KEY` being
 * absent, and it is stated in the milestone report.
 *
 * ## What the contract tests do prove
 *
 * That both adapters honour the interface `CourierAdapter` declares, in the ways the rest of
 * the system depends on:
 *
 * - `createParcel` refuses bad input **before** the call, so a parcel the courier will always
 *   refuse does not cost five retries (§20);
 * - `createParcel` is idempotent on our reference (§9), which is what makes a retried job
 *   safe when the first attempt reached the courier and only its answer was lost;
 * - a courier that does not answer is `retryable`, and one that refuses the parcel is not;
 * - a webhook with the wrong secret returns `null` rather than throwing, so the route can
 *   answer 401 and store nothing;
 * - the status vocabulary each adapter declares is exactly the one the domain maps
 *   (**check 2**).
 */

const CONTEXT: AdapterContext = {
  credentials: { apiKey: 'k', secretKey: 's', webhookToken: 'token-0123456789abcdef' },
  baseUrl: 'https://courier.example.test/api/v1',
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
    note: null,
    weightGrams: 500,
    ...overrides,
  };
}

/*
 * The transcribed Steadfast fixtures.
 *
 * Kept as literals in this file rather than as JSON on disk, so that a reader of the adapter
 * sees the shape it was built against without opening a second file — and so that the
 * "transcribed, not recorded" caveat above sits next to them.
 */
const CREATE_ORDER_RESPONSE = {
  status: 200,
  message: 'Consignment has been created successfully.',
  consignment: {
    consignment_id: 1424107,
    invoice: 'CUR-2609-00001',
    tracking_code: '15BAEB8A',
    recipient_name: 'Rahim Uddin',
    recipient_phone: '01712345678',
    recipient_address: 'House 12, Road 3, Niketan, Gulshan, Dhaka',
    cod_amount: 2480,
    status: 'in_review',
    note: null,
    created_at: '2026-03-04T10:11:12.000000Z',
    updated_at: '2026-03-04T10:11:12.000000Z',
  },
};

const STATUS_RESPONSE = { status: 200, delivery_status: 'delivered' };

const WEBHOOK_BODY = {
  consignment_id: 1424107,
  invoice: 'CUR-2609-00001',
  cod_amount: 2480,
  status: 'delivered',
  updated_at: '2026-03-05T09:00:00.000000Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('the adapter registry contract', () => {
  const adapters: readonly CourierAdapter[] = [
    new FakeCourierAdapter(),
    new SteadfastCourierAdapter(),
    // M15. Their own contract tests are in `courier.m15-adapters.test.ts`.
    new PathaoCourierAdapter(),
    new RedxCourierAdapter(),
  ];

  it('declares a status vocabulary the domain maps completely (check 2)', () => {
    for (const adapter of adapters) {
      /*
       * The provider's *transcribed* vocabulary (`PROVIDER_VOCABULARIES`, each list citing its
       * source), never the map's own keys. M12 used `Object.keys(adapter.statusMap.statuses)`
       * here, which made "every word is mapped" true by construction.
       */
      const vocabulary = PROVIDER_VOCABULARIES[adapter.code] ?? [];
      expect(vocabulary.length).toBeGreaterThan(0);
      // Every word the courier can send has a mapping…
      expect(unmappedStatuses(adapter.statusMap, vocabulary)).toEqual([]);
      // …and the map holds no word the courier does not send.
      expect(Object.keys(adapter.statusMap.statuses).sort()).toEqual([...vocabulary].sort());
      // …and every mapping points at one of §9's twelve.
      for (const word of vocabulary) {
        expect(PARCEL_STATUSES).toContain(normalizeStatus(adapter.statusMap, word).status);
      }
      // The adapter's code and its map's code are the same thing, or the registry resolves
      // an adapter whose vocabulary belongs to a different courier.
      expect(adapter.statusMap.code).toBe(adapter.code);
    }
  });

  it('says whether it was built from the courier’s own documentation (§21, D-006)', () => {
    const fake = adapters.find((adapter) => adapter.code === 'fake');
    const steadfast = adapters.find((adapter) => adapter.code === 'steadfast');
    // The fake's documentation is its own source file.
    expect(fake?.verified).toBe(true);
    // D-176. The gate in `AccountsService` reads exactly this.
    expect(steadfast?.verified).toBe(false);
    // M15: neither new adapter was built from its courier's API document.
    expect(adapters.find((adapter) => adapter.code === 'pathao')?.verified).toBe(false);
    expect(adapters.find((adapter) => adapter.code === 'redx')?.verified).toBe(false);
  });
});

describe('the fake courier', () => {
  let adapter: FakeCourierAdapter;

  beforeEach(() => {
    adapter = new FakeCourierAdapter();
  });

  it('refuses a bad parcel before assigning a number', async () => {
    await expect(
      adapter.createParcel(CONTEXT, parcel({ address: { ...parcel().address, addressLine: '' } })),
    ).rejects.toThrow();
    expect(adapter.snapshot()).toHaveLength(0);
  });

  it('is idempotent on our reference (§9)', async () => {
    const first = await adapter.createParcel(CONTEXT, parcel());
    const second = await adapter.createParcel(CONTEXT, parcel());
    expect(second.consignmentNo).toBe(first.consignmentNo);
    expect(adapter.snapshot()).toHaveLength(1);
  });

  it('distinguishes a courier that is down from one that refuses the parcel', async () => {
    adapter.failNextBookings = 1;
    await expect(adapter.createParcel(CONTEXT, parcel())).rejects.toSatisfy(
      (error: unknown) => error instanceof CourierError && error.retryable,
    );

    adapter.rejectNextBookings = 1;
    await expect(adapter.createParcel(CONTEXT, parcel())).rejects.toSatisfy(
      (error: unknown) => error instanceof CourierError && !error.retryable,
    );
  });

  it('reports the collection once the parcel is handed over', async () => {
    const created = await adapter.createParcel(CONTEXT, parcel());
    adapter.advance(created.consignmentNo, 'handed_to_customer');
    const status = await adapter.getStatus(CONTEXT, {
      consignmentNo: created.consignmentNo,
      reference: 'CUR-2609-00001',
      trackingCode: null,
    });
    expect(normalizeStatus(adapter.statusMap, status.rawStatus).status).toBe('delivered');
    expect(status.collectedPoisha).toBe('248000');
  });

  it('refuses a webhook with the wrong secret, and never throws for it', async () => {
    const created = await adapter.createParcel(CONTEXT, parcel());
    const body = Buffer.from(JSON.stringify(adapter.webhookBody(created.consignmentNo)), 'utf8');

    const context: AdapterContext = {
      ...CONTEXT,
      credentials: { webhookSecret: 'the-real-secret-0123456789' },
    };
    // `null`, not a throw: the route answers 401 and stores nothing, and a thrown error would
    // be indistinguishable from the adapter itself being broken.
    await expect(
      adapter.parseWebhook(context, {
        headers: { 'x-fake-courier-secret': 'wrong' },
        raw: body,
      }),
    ).resolves.toBeNull();

    const events = await adapter.parseWebhook(context, {
      headers: { 'x-fake-courier-secret': 'the-real-secret-0123456789' },
      raw: body,
    });
    expect(events).toHaveLength(1);
    expect(events?.[0]?.consignmentNo).toBe(created.consignmentNo);
  });

  it('strips the recipient out of the payload it stores (invariant 10)', async () => {
    const created = await adapter.createParcel(CONTEXT, parcel());
    const body = adapter.webhookBody(created.consignmentNo);
    // The fake sends them, as a real courier does…
    expect(body.recipient_phone).toBe('+8801712345678');

    const events = await adapter.parseWebhook(
      { ...CONTEXT, credentials: {} },
      { headers: {}, raw: Buffer.from(JSON.stringify(body), 'utf8') },
    );
    // …and the payload we keep has neither the name nor the number in it.
    const kept = JSON.stringify(events?.[0]?.payload ?? {});
    expect(kept).not.toContain('8801712345678');
    expect(kept).not.toContain('Rahim');
  });
});

describe('the Steadfast adapter (UNVERIFIED — see the file comment)', () => {
  const adapter = new SteadfastCourierAdapter();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetCourierEnv();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetCourierEnv();
  });

  it('sends the fields the transcribed contract names, with COD in taka', async () => {
    fetchMock.mockResolvedValue(jsonResponse(CREATE_ORDER_RESPONSE));

    const result = await adapter.createParcel(CONTEXT, parcel());

    expect(result.consignmentNo).toBe('1424107');
    expect(result.trackingCode).toBe('15BAEB8A');
    expect(result.rawStatus).toBe('in_review');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://courier.example.test/api/v1/create_order');
    expect((init.headers as Record<string, string>)['Api-Key']).toBe('k');
    expect((init.headers as Record<string, string>)['Secret-Key']).toBe('s');

    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    expect(body.invoice).toBe('CUR-2609-00001');
    // Taka, as a string. Every Bangladeshi courier API takes taka, and a string is the one
    // form no float can get hold of (invariant 1).
    expect(body.cod_amount).toBe('2480.00');
    // The local form, because Steadfast's own examples are all `01…` and a rider's app cannot
    // dial `+880…`.
    expect(body.recipient_phone).toBe('01712345678');
    expect(body.recipient_address).toContain('Gulshan');
  });

  it('refuses a bad parcel without making a call at all (§20)', async () => {
    await expect(
      adapter.createParcel(CONTEXT, parcel({ codAmountPoisha: poisha(-1) })),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a revoked key as permanent and a 5xx as retryable', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'unauthorised' }, 401));
    await expect(adapter.createParcel(CONTEXT, parcel())).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CourierError &&
        !error.retryable &&
        error.code === 'COURIER_CREDENTIALS_MISSING',
    );

    fetchMock.mockResolvedValue(jsonResponse({ message: 'oops' }, 503));
    await expect(adapter.createParcel(CONTEXT, parcel())).rejects.toSatisfy(
      (error: unknown) => error instanceof CourierError && error.retryable,
    );

    // A 4xx that is not auth: the parcel is wrong, so retrying it unchanged is pointless.
    fetchMock.mockResolvedValue(jsonResponse({ message: 'bad address' }, 422));
    await expect(adapter.createParcel(CONTEXT, parcel())).rejects.toSatisfy(
      (error: unknown) => error instanceof CourierError && !error.retryable,
    );
  });

  it('treats an accepted parcel with no consignment id as retryable, not failed', async () => {
    /*
     * The dangerous case. The courier has a real parcel with a real COD and we cannot say
     * which. Retryable, because `create_order` keys on the invoice, so the retry returns the
     * same parcel rather than creating a second one — and treating it as a failure would
     * leave a parcel out there that our books know nothing about.
     */
    fetchMock.mockResolvedValue(jsonResponse({ status: 200, consignment: { invoice: 'x' } }));
    await expect(adapter.createParcel(CONTEXT, parcel())).rejects.toSatisfy(
      (error: unknown) => error instanceof CourierError && error.retryable,
    );
  });

  it('reads a status by consignment id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(STATUS_RESPONSE));
    const status = await adapter.getStatus(CONTEXT, {
      consignmentNo: '1424107',
      reference: 'CUR-2609-00001',
      trackingCode: null,
    });
    expect(status.rawStatus).toBe('delivered');
    // No timestamp in the response, and none invented: the caller uses the poll time and the
    // dedupe key is weaker for it, which is stated where that decision is made.
    expect(status.occurredAt).toBeNull();
    expect(String((fetchMock.mock.calls[0] as [string])[0])).toContain('status_by_cid/1424107');
  });

  it('verifies the bearer token before it reads a webhook body', async () => {
    const raw = Buffer.from(JSON.stringify(WEBHOOK_BODY), 'utf8');

    await expect(adapter.parseWebhook(CONTEXT, { headers: {}, raw })).resolves.toBeNull();
    await expect(
      adapter.parseWebhook(CONTEXT, { headers: { authorization: 'Bearer nope' }, raw }),
    ).resolves.toBeNull();

    const events = await adapter.parseWebhook(CONTEXT, {
      headers: { authorization: 'Bearer token-0123456789abcdef' },
      raw,
    });
    expect(events).toHaveLength(1);
    expect(events?.[0]?.consignmentNo).toBe('1424107');
    expect(events?.[0]?.rawStatus).toBe('delivered');
    expect(events?.[0]?.collectedPoisha).toBe('248000');
    expect(events?.[0]?.occurredAt?.toISOString()).toBe('2026-03-05T09:00:00.000Z');
  });

  it('accepts nothing when no webhook token is configured', async () => {
    /*
     * The default that matters. "Accept everything when no secret is set" is what turns a
     * public URL into a way of marking any parcel delivered — which posts revenue and a
     * courier receivable for cash nobody collected.
     */
    await expect(
      adapter.parseWebhook(
        { ...CONTEXT, credentials: { apiKey: 'k', secretKey: 's' } },
        { headers: { authorization: 'Bearer anything' }, raw: Buffer.from('{}', 'utf8') },
      ),
    ).resolves.toBeNull();
  });
});

describe('the settlement CSV parser', () => {
  it('reads the columns a portal export carries, with a BOM and quotes', () => {
    const file = Buffer.from(
      '﻿Consignment ID,Invoice,COD Amount,Delivery Charge,Return Charge,Other Charge,Net Amount\n' +
        '1424107,"CUR-2609-00001","৳2,480.00",80.00,0,10.00,2390.00\n',
      'utf8',
    );
    const { rows } = parseCsvStatement(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.codCollectedPoisha).toBe(248_000n);
    expect(rows[0]?.deliveryChargePoisha).toBe(8_000n);
    expect(rows[0]?.otherChargePoisha).toBe(1_000n);
    expect(rows[0]?.netPoisha).toBe(239_000n);
    expect(rows[0]?.reference).toBe('CUR-2609-00001');
  });

  it('refuses a file rather than skipping a row it cannot read', () => {
    // A skipped row is a parcel whose cash silently never arrives, and the totals still add
    // up because the row is not in them either.
    expect(() => parseCsvStatement('consignment_id,cod_amount\n1424107,not-an-amount\n')).toThrow(
      /amount in taka/,
    );
    expect(() => parseCsvStatement('consignment_id,cod_amount\n,\n')).toThrow(
      /names no consignment/,
    );
    expect(() => parseCsvStatement('invoice,delivery_charge\nX,10\n')).toThrow(
      /collected-amount column/,
    );
    expect(() => parseCsvStatement('nothing_useful\nx\n')).toThrow(/consignment or invoice/);
  });

  it('treats an absent charge column as zero and an absent net as unstated', () => {
    const { rows } = parseCsvStatement('consignment_id,cod_amount\n1424107,2480\n');
    expect(rows[0]?.deliveryChargePoisha).toBe(0n);
    expect(rows[0]?.netPoisha).toBeNull();
  });
});

/**
 * The live sandbox smoke test (check 1's second half).
 *
 * **Skipped in this environment: no Steadfast sandbox credentials exist.** Stated in the
 * milestone report as required by CLAUDE.md's definition of done.
 *
 * It is written out rather than omitted because its value is entirely in being runnable the
 * moment a key arrives: set `COURIER_SMOKE_API_KEY` and `COURIER_SMOKE_SECRET_KEY` and it
 * books one parcel against the sandbox and reads its status back. It asserts only the two
 * things a transcribed contract cannot guarantee — that the endpoint exists and that the
 * response carries a consignment id — because everything else is already covered above
 * against fixtures, and a smoke test that asserted field names would fail for the right
 * reason in a way nobody could tell from the wrong reason.
 */
const smokeKey = process.env.COURIER_SMOKE_API_KEY;
const smokeSecret = process.env.COURIER_SMOKE_SECRET_KEY;

describe.skipIf(smokeKey === undefined || smokeSecret === undefined)(
  'Steadfast sandbox smoke test',
  () => {
    it('books a parcel and reads its status back', async () => {
      const adapter = new SteadfastCourierAdapter();
      const context: AdapterContext = {
        credentials: { apiKey: smokeKey ?? '', secretKey: smokeSecret ?? '' },
        baseUrl: process.env.COURIER_SMOKE_BASE_URL ?? null,
        mode: 'sandbox',
        timeoutMs: 20_000,
      };

      const created = await adapter.createParcel(
        context,
        parcel({ reference: `SMOKE-${Date.now().toString(36)}`, codAmountPoisha: poisha(100) }),
      );
      expect(created.consignmentNo).toMatch(/\S/);

      const status = await adapter.getStatus(context, {
        consignmentNo: created.consignmentNo,
        reference: 'smoke',
        trackingCode: created.trackingCode,
      });
      // Whatever word it is, the mapping has to know it — an unmapped status here is the
      // single most useful thing this test can find.
      expect(unmappedStatuses(adapter.statusMap, [status.rawStatus])).toEqual([]);
    }, 60_000);
  },
);
