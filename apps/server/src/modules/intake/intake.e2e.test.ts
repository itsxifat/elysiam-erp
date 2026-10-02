import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describeRoutes } from '../../platform/auth/route-map.js';
import { routeKey } from '../../platform/auth/route-matrix.manifest.js';
import { checkCsrf } from '../../platform/http/csrf.js';
import {
  APP_DOMAIN,
  ORG_A,
  ORG_B,
  ORIGIN,
  startHttpHarness,
  type Client,
  type HttpHarness,
  type InjectedResponse,
  type RoleClient,
} from '../../testing/http-harness.js';
import { seedProductWithSkus, type SeededSku } from '../inventory/inventory.testing.js';
import { IntakeModule } from './intake.module.js';
import { INTAKE_ROUTE_KEYS } from './intake.route-fixtures.js';
import { applyIntakeMigrations, setIntakeTestEnv } from './intake.testing.js';
import { bodyHash, sign } from './signature.js';

/**
 * The public intake API (M11 acceptance check 3), through the real pipeline.
 *
 * * a signed request creates a pending `landing_page` order with UTMs;
 * * a bad signature returns 401;
 * * a replayed idempotency key returns the same order;
 * * exceeding the limit returns 429.
 *
 * Turnstile is Cloudflare's, so it is stood in for by a local HTTP server answering the way
 * the siteverify documentation says it answers — and the real `CloudflareTurnstile` client
 * talks to it over real HTTP. The stand-in also checks invariant 6 from the outside: while
 * it is being asked, it looks for a transaction held open by the application, and there
 * must be none.
 */

// --- the Turnstile stand-in -----------------------------------------------------------

interface SiteverifyCall {
  readonly token: string | null;
  readonly remoteip: string | null;
  readonly idempotencyKey: string | null;
  readonly openTransactions?: number;
}

const siteverifyCalls: SiteverifyCall[] = [];
let stub: Server;

async function openTransactions(): Promise<number> {
  // Sessions of *this* test database sitting inside a transaction without running a
  // statement: what an HTTP call made inside `withOrg()` would look like from here.
  const rows = await withSystem(async (tx) =>
    tx.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
      where datname = current_database()
        and state like 'idle in transaction%'
        and pid <> pg_backend_pid()
    `),
  );
  return rows[0]?.n ?? 0;
}

async function startStub(): Promise<string> {
  stub = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    request.on('end', () => {
      void (async () => {
        const form = new URLSearchParams(raw);
        const token = form.get('response');
        const call: SiteverifyCall = {
          token,
          remoteip: form.get('remoteip'),
          idempotencyKey: form.get('idempotency_key'),
          ...(token === 'probe-tx' ? { openTransactions: await openTransactions() } : {}),
        };
        siteverifyCalls.push(call);
        response.setHeader('content-type', 'application/json');
        if (token === 'down') {
          response.statusCode = 502;
          response.end('bad gateway');
          return;
        }
        response.end(
          token === 'pass' || token === 'probe-tx'
            ? '{"success":true,"hostname":"lp.example.com","error-codes":[]}'
            : '{"success":false,"error-codes":["invalid-input-response"]}',
        );
      })();
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((stub.address() as AddressInfo).port)}/siteverify`;
}

// --- the suite ----------------------------------------------------------------------

let harness: HttpHarness;
let admin: RoleClient;
let sales: RoleClient;
let anonymous: Client;
let skus: SeededSku[] = [];
let keyId = '';
let secret = '';

beforeAll(async () => {
  const url = await startStub();
  // Before the harness: the module parses its configuration once, when it is built.
  setIntakeTestEnv({
    TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
    INTAKE_TURNSTILE_VERIFY_URL: url,
    INTAKE_RATE_VISITOR_IP_PER_MINUTE: '3',
    INTAKE_RATE_PHONE_PER_HOUR: '2',
  });

  harness = await startHttpHarness('intake', { extraModules: [IntakeModule] });
  await applyIntakeMigrations();
  ({ skus } = await seedProductWithSkus(ORG_A, 'intakee2e', 2));

  admin = await harness.asRole('org_admin', ORG_A);
  sales = await harness.asRole('sales', ORG_A);

  const issued = await admin.client.request('POST', '/v1/intake/site-keys', {
    body: {
      label: 'Eid kurta landing page',
      landingPageId: '6f1d8a52-3f7c-4c55-9b1e-1f0a5b7d2c10',
    },
  });
  expect(issued.statusCode).toBe(201);
  ({ keyId, secret } = JSON.parse(issued.body) as { keyId: string; secret: string });

  // An anonymous client holding only the CSRF double-submit pair — see `postSigned`.
  anonymous = harness.client();
  await anonymous.request('GET', '/v1/auth/login-branding');
}, 420_000);

afterAll(async () => {
  await harness?.close();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
}, 60_000);

let phoneSeed = 40_000_000 + Math.floor(Math.random() * 40_000_000);
function freshPhone(): string {
  phoneSeed += 1;
  return `01${phoneSeed % 2 === 0 ? '7' : '8'}${String(phoneSeed)}`;
}

let ipSeed = 10;
function freshIp(): string {
  ipSeed += 1;
  return `198.51.100.${String(ipSeed % 250)}`;
}

let keySeed = 0;
function freshKey(): string {
  keySeed += 1;
  return `lp-${String(Date.now())}-${String(keySeed)}`;
}

function orderBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const skuCode = skus[0]?.code ?? '';
  return {
    customer: { name: 'রহিমা খাতুন', phone: freshPhone() },
    address: { districtId: 47, thanaId: 365, area: 'Hemayetpur', addressLine: 'House 4, Road 2' },
    lines: [{ skuCode, qty: 1 }],
    utm: {
      source: 'facebook',
      medium: 'cpc',
      campaign: 'eid-2026',
      content: 'carousel-2',
      term: 'kurta',
    },
    notes: 'Call before delivery',
    turnstileToken: 'pass',
    visitor: { ip: freshIp() },
    ...overrides,
  };
}

interface SignOptions {
  readonly key?: string;
  readonly keyId?: string;
  readonly secret?: string;
  readonly timestamp?: string;
  /** Send these bytes instead of the ones that were signed. */
  readonly tamper?: string;
  /** Leave the CSRF pair off, as a real server-to-server call would. */
  readonly withoutCsrf?: boolean;
  readonly omitIdempotencyKey?: boolean;
}

function csrfPair(): { cookie: string; token: string } {
  const cookie = anonymous.cookieHeader();
  const token = /elysium_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
  return { cookie, token };
}

/**
 * POST a signed order.
 *
 * Carries the CSRF double-submit pair unless told not to. The platform's CSRF hook
 * (`platform/http/csrf.ts`) refuses any cookie-less POST, and exempting `/public/v1/` from it
 * is an INTEGRATION line this milestone hands over rather than an edit it makes. The pair
 * authenticates nothing — a stranger can fetch one — so carrying it does not weaken what
 * these tests prove about the signature.
 */
async function postSigned(
  payload: Record<string, unknown> | string,
  options: SignOptions = {},
): Promise<InjectedResponse & { key: string }> {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const key = options.key ?? freshKey();
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = sign(options.secret ?? secret, timestamp, key, Buffer.from(raw, 'utf8'));
  const { cookie, token } = csrfPair();
  const response = await harness.server.inject({
    method: 'POST',
    url: '/public/v1/orders',
    headers: {
      host: APP_DOMAIN,
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.50',
      'x-elysium-key': options.keyId ?? keyId,
      'x-elysium-timestamp': timestamp,
      'x-elysium-signature': signature,
      ...(options.omitIdempotencyKey === true ? {} : { 'idempotency-key': key }),
      ...(options.withoutCsrf === true ? {} : { cookie, 'x-elysium-csrf': token, origin: ORIGIN }),
    },
    payload: options.tamper ?? raw,
  });
  return { statusCode: response.statusCode, body: response.body, headers: response.headers, key };
}

function json<T>(response: InjectedResponse): T {
  return JSON.parse(response.body) as T;
}

async function orderRow(orderId: string) {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{
        status: string;
        channel: string;
        source: Record<string, unknown>;
        assigned_to: string | null;
        created_by: string;
        delivery_charge_poisha: string;
      }>(sql`
        select status::text, channel::text, source, assigned_to, created_by, delivery_charge_poisha
        from sales.orders where org_id = ${ORG_A} and id = ${orderId}
      `),
    { orgId: ORG_A },
  );
  return rows[0];
}

// --- check 3 ------------------------------------------------------------------------

describe('check 3: a signed request', () => {
  it('creates a pending landing_page order with its UTMs, in the unassigned queue', async () => {
    const response = await postSigned(orderBody());
    expect(response.statusCode).toBe(201);
    const receipt = json<{ orderId: string; orderNo: string; status: string }>(response);
    expect(receipt.status).toBe('pending');

    const row = await orderRow(receipt.orderId);
    expect(row).toMatchObject({ status: 'pending', channel: 'landing_page', assigned_to: null });
    expect(row?.source).toEqual({
      landingPageId: '6f1d8a52-3f7c-4c55-9b1e-1f0a5b7d2c10',
      utmSource: 'facebook',
      utmMedium: 'cpc',
      utmCampaign: 'eid-2026',
      utmContent: 'carousel-2',
      utmTerm: 'kurta',
    });
    // Priced by the zone, not by the page: Savar has a mapped zone with a charge.
    expect(BigInt(row?.delivery_charge_poisha ?? '0')).toBeGreaterThan(0n);
    expect(row?.created_by).toMatch(/^intake:/);

    // The desk sees it at the front door.
    const queue = json<{ items: { id: string }[] }>(
      await sales.client.request('GET', '/v1/orders?queue=unassigned&limit=100'),
    );
    expect(queue.items.map((item) => item.id)).toContain(receipt.orderId);

    // Turnstile was asked with the visitor's address and the claim's id as its key.
    const call = siteverifyCalls.at(-1);
    expect(call?.token).toBe('pass');
    expect(call?.remoteip).toMatch(/^198\.51\.100\./);
    expect(call?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  }, 60_000);

  it('asks Turnstile with no transaction held open (invariant 6)', async () => {
    const response = await postSigned(orderBody({ turnstileToken: 'probe-tx' }));
    expect(response.statusCode).toBe(201);
    const probe = siteverifyCalls.find((call) => call.token === 'probe-tx');
    expect(probe?.openTransactions).toBe(0);
  }, 60_000);
});

describe('check 3: a bad signature', () => {
  it('is 401, with the same answer for every way a request can be unauthentic', async () => {
    const body = orderBody();
    const now = Math.floor(Date.now() / 1000);
    const attempts = [
      await postSigned(body, { secret: `${secret}x` }),
      await postSigned(body, {
        tamper: JSON.stringify({ ...body, notes: 'changed after signing' }),
      }),
      await postSigned(body, { timestamp: String(now - 301) }),
      // Taken afresh and well clear of the edge: a future timestamp drifts *into* the
      // window as time passes, and `now` above is several requests old by here. Under a
      // loaded full run, `now + 301` arrived inside the window and was accepted. The exact
      // edge is pinned by `signature.test.ts`; this asserts the HTTP answer.
      await postSigned(body, { timestamp: String(Math.floor(Date.now() / 1000) + 360) }),
      await postSigned(body, { keyId: `${keyId.slice(0, -1)}${keyId.endsWith('a') ? 'b' : 'a'}` }),
      await postSigned(body, { keyId: 'not-a-key' }),
      // A key id naming another org finds nothing there: the lookup runs in that org's RLS.
      await postSigned(body, {
        keyId: keyId.replace(ORG_A.replace(/-/g, ''), ORG_B.replace(/-/g, '')),
      }),
    ];
    const bodies = new Set(attempts.map((attempt) => json<{ detail?: string }>(attempt).detail));
    for (const attempt of attempts) {
      expect(attempt.statusCode).toBe(401);
      expect(json<{ code: string }>(attempt).code).toBe('UNAUTHENTICATED');
    }
    expect(bodies.size).toBe(1);
  }, 60_000);

  it('checks the signature before it will even say the body is malformed', async () => {
    const unsigned = await postSigned({ nonsense: true }, { secret: 'sk_wrong' });
    expect(unsigned.statusCode).toBe(401);
    const signed = await postSigned({ nonsense: true });
    expect(signed.statusCode).toBe(400);
    expect(json<{ code: string }>(signed).code).toBe('VALIDATION_FAILED');
  }, 60_000);

  it('refuses a revoked key, and a key issued under a different master key', async () => {
    const issued = json<{ id: string; keyId: string; secret: string }>(
      await admin.client.request('POST', '/v1/intake/site-keys', {
        body: { label: 'Soon revoked' },
      }),
    );
    expect(
      (await postSigned(orderBody(), { keyId: issued.keyId, secret: issued.secret })).statusCode,
    ).toBe(201);

    const revoked = await admin.client.request('POST', `/v1/intake/site-keys/${issued.id}/revoke`);
    expect(revoked.statusCode).toBe(201);
    expect(
      (await postSigned(orderBody(), { keyId: issued.keyId, secret: issued.secret })).statusCode,
    ).toBe(401);

    const other = json<{ id: string; keyId: string; secret: string }>(
      await admin.client.request('POST', '/v1/intake/site-keys', { body: { label: 'Re-keyed' } }),
    );
    // As if INTAKE_KEY_SECRET had changed since issue: the stored fingerprint no longer
    // matches the secret the server derives today.
    await withSystem(
      async (tx) =>
        tx.execute(sql`
          update intake.site_keys set secret_sha256 = repeat('0', 64)
          where org_id = ${ORG_A} and id = ${other.id}
        `),
      { orgId: ORG_A },
    );
    expect(
      (await postSigned(orderBody(), { keyId: other.keyId, secret: other.secret })).statusCode,
    ).toBe(401);
  }, 60_000);

  it('requires an idempotency key', async () => {
    const response = await postSigned(orderBody(), { omitIdempotencyKey: true });
    expect(response.statusCode).toBe(400);
    expect(json<{ code: string }>(response).code).toBe('IDEMPOTENCY_KEY_INVALID');
  }, 60_000);
});

describe('check 3: a replayed idempotency key', () => {
  it('returns the same order, without asking Turnstile again', async () => {
    const body = orderBody();
    const first = await postSigned(body);
    expect(first.statusCode).toBe(201);
    const callsAfterFirst = siteverifyCalls.length;

    // A retry is re-signed with a new timestamp, exactly as a client retrying would.
    const again = await postSigned(body, { key: first.key });
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(json<{ orderId: string }>(again).orderId).toBe(json<{ orderId: string }>(first).orderId);
    expect(siteverifyCalls.length).toBe(callsAfterFirst);

    const orders = await withSystem(
      async (tx) =>
        tx.execute<{ n: number }>(sql`
          select count(*)::int as n from intake.submissions
          where org_id = ${ORG_A} and idempotency_key = ${first.key}
        `),
      { orgId: ORG_A },
    );
    expect(orders[0]?.n).toBe(1);
  }, 60_000);

  it('refuses the same key for a different order', async () => {
    const first = await postSigned(orderBody());
    const other = await postSigned(orderBody(), { key: first.key });
    expect(other.statusCode).toBe(409);
    expect(json<{ code: string }>(other).code).toBe('IDEMPOTENCY_CONFLICT');
  }, 60_000);

  it('lets a request refused by Turnstile be retried with the same key', async () => {
    const refused = await postSigned(orderBody({ turnstileToken: 'robot' }));
    expect(refused.statusCode).toBe(403);
    expect(json<{ code: string }>(refused).code).toBe('FORBIDDEN');

    const down = await postSigned(orderBody({ turnstileToken: 'down' }));
    expect(down.statusCode).toBe(503);

    const retried = await postSigned(orderBody(), { key: refused.key });
    expect(retried.statusCode).toBe(201);
  }, 60_000);
});

describe('an idempotency key whose first request never finished', () => {
  it('is taken over by a retry once the claim is stale, instead of answering 409 for ever', async () => {
    const body = orderBody();
    // A request that died mid-flight: a pending claim nobody will complete.
    const first = await postSigned(body, { key: freshKey() });
    expect(first.statusCode).toBe(201);
    const orphanKey = freshKey();
    const [site] = await withSystem(
      async (tx) =>
        tx.execute<{ id: string }>(sql`
          select id from intake.site_keys where org_id = ${ORG_A} and key_id = ${keyId}
        `),
      { orgId: ORG_A },
    );
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    await withSystem(
      async (tx) =>
        tx.execute(sql`
          insert into intake.submissions
            (org_id, site_key_id, idempotency_key, request_sha256, claimed_at)
          values (${ORG_A}, ${site?.id ?? ''}, ${orphanKey}, ${bodyHash(raw)}, now())
        `),
      { orgId: ORG_A },
    );

    // While it is fresh, a retry is told to wait.
    const early = await postSigned(body, { key: orphanKey });
    expect(early.statusCode).toBe(409);
    expect(json<{ code: string }>(early).code).toBe('IDEMPOTENCY_IN_FLIGHT');

    // Once it is stale, the retry takes it over and the order is created.
    await withSystem(
      async (tx) =>
        tx.execute(sql`
          update intake.submissions set claimed_at = now() - interval '10 minutes'
          where org_id = ${ORG_A} and idempotency_key = ${orphanKey}
        `),
      { orgId: ORG_A },
    );
    const retried = await postSigned(body, { key: orphanKey });
    expect(retried.statusCode).toBe(201);
    const again = await postSigned(body, { key: orphanKey });
    expect(json<{ orderId: string }>(again).orderId).toBe(
      json<{ orderId: string }>(retried).orderId,
    );
  }, 60_000);

  it('keeps the claim through a 503, so the retry asks Cloudflare with the same key', async () => {
    const body = orderBody({ turnstileToken: 'down' });
    const down = await postSigned(body);
    expect(down.statusCode).toBe(503);
    const firstAsk = siteverifyCalls.at(-1)?.idempotencyKey;

    // The same request, unchanged, once Cloudflare is back: the stand-in answers `down`
    // again for this token, and what matters is that it was asked under the same key.
    await postSigned(body, { key: down.key });
    expect(siteverifyCalls.at(-1)?.idempotencyKey).toBe(firstAsk);
  }, 60_000);
});

describe('a returning buyer', () => {
  it('keeps their saved default address whatever a public form sends', async () => {
    const phone = freshPhone();
    const saved = await sales.client.request('POST', '/v1/customers', {
      body: {
        phone,
        name: 'Saved Buyer',
        address: { districtId: 47, thanaId: 366, addressLine: 'The real address, Dhamrai' },
      },
    });
    expect(saved.statusCode).toBe(201);
    const { id } = json<{ id: string }>(saved);

    const posted = await postSigned(orderBody({ customer: { name: 'Someone', phone } }));
    expect(posted.statusCode).toBe(201);

    const addresses = await withSystem(
      async (tx) =>
        tx.execute<{ thana_id: number; is_default: boolean }>(sql`
          select thana_id, is_default from sales.customer_addresses
          where org_id = ${ORG_A} and customer_id = ${id}
        `),
      { orgId: ORG_A },
    );
    expect(addresses).toEqual([{ thana_id: 366, is_default: true }]);
    // The order itself went where the form said.
    expect((await orderRow(json<{ orderId: string }>(posted).orderId))?.status).toBe('pending');
  }, 60_000);
});

describe('check 3: exceeding the limit', () => {
  it('is 429 per visitor address, with Retry-After', async () => {
    const ip = '192.0.2.77';
    const statuses: number[] = [];
    let last: InjectedResponse | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      last = await postSigned(orderBody({ visitor: { ip } }));
      statuses.push(last.statusCode);
    }
    // INTAKE_RATE_VISITOR_IP_PER_MINUTE=3 for this suite.
    expect(statuses).toEqual([201, 201, 201, 429]);
    expect(json<{ code: string }>(last!).code).toBe('RATE_LIMITED');
    expect(Number(last?.headers['retry-after'])).toBeGreaterThan(0);
  }, 60_000);

  it('is 429 per phone number, whatever address it comes from', async () => {
    const phone = freshPhone();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await postSigned(
        orderBody({ customer: { name: 'Same Buyer', phone }, visitor: { ip: freshIp() } }),
      );
      statuses.push(response.statusCode);
    }
    // INTAKE_RATE_PHONE_PER_HOUR=2 for this suite.
    expect(statuses).toEqual([201, 201, 429]);
  }, 60_000);

  it('does not count a replay against the limit', async () => {
    const ip = '192.0.2.88';
    const first = await postSigned(orderBody({ visitor: { ip } }));
    const body = JSON.parse(JSON.stringify(orderBody({ visitor: { ip } }))) as Record<
      string,
      unknown
    >;
    const second = await postSigned(body);
    const third = await postSigned(orderBody({ visitor: { ip } }));
    expect([first.statusCode, second.statusCode, third.statusCode]).toEqual([201, 201, 201]);
    // Three created; replaying the second five times is still three.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await postSigned(body, { key: second.key })).statusCode).toBe(201);
    }
    expect((await postSigned(orderBody({ visitor: { ip } }))).statusCode).toBe(429);
  }, 60_000);
});

describe('the public endpoint’s edges', () => {
  it('refuses a body over 64 KiB before reading it all', async () => {
    const response = await postSigned(orderBody({ notes: 'x'.repeat(70 * 1024) }));
    expect(response.statusCode).toBe(413);
  }, 60_000);

  it('answers a server-to-server call with no cookies at all, once the CSRF exemption is in', async () => {
    /*
     * A landing page's server carries no cookie, so without the INTEGRATION line that
     * exempts `/public/v1/` from the platform's CSRF check every real call is a 403. This
     * test states what production needs and reports honestly which side of the line the
     * tree is on: until the exemption lands it asserts the 403, after it the 201.
     */
    const exempt = checkCsrf(
      { method: 'POST', url: '/public/v1/orders', headers: {} } as unknown as FastifyRequest,
      { trustedOrigins: [ORIGIN] },
    ).ok;
    const response = await postSigned(orderBody(), { withoutCsrf: true });
    expect(response.statusCode).toBe(exempt ? 201 : 403);
  }, 60_000);
});

describe('the route gate (D-070), scoped to this module', () => {
  it('registers exactly the fixtures’ routes plus one public route, and nothing undeclared', () => {
    const mine = describeRoutes(harness.app).filter((route) =>
      ['PublicIntakeController', 'SiteKeysController'].includes(route.controller),
    );
    const guarded = mine.filter((route) => route.declared?.startsWith('public') !== true);
    expect(guarded.map(routeKey).sort()).toEqual([...INTAKE_ROUTE_KEYS].sort());
    expect(mine.filter((route) => route.declared === null)).toEqual([]);
    // One public route and it is the intake: everything else here needs a session.
    expect(
      mine.filter((route) => route.declared?.startsWith('public') === true).map(routeKey),
    ).toEqual(['POST /public/v1/orders']);
  });
});

describe('site keys', () => {
  it('shows the secret once, on issue, and never in a list', async () => {
    const list = await admin.client.request('GET', '/v1/intake/site-keys');
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(secret);
    expect(list.body).not.toMatch(/"secret"|secret_sha256|secretSha256/);
    const items = json<{ items: { keyId: string; lastUsedAt: string | null }[] }>(list).items;
    expect(items.find((item) => item.keyId === keyId)?.lastUsedAt).not.toBeNull();
  }, 60_000);

  it('are issued by the people §6 lets edit landing pages', async () => {
    const refused = await sales.client.request('POST', '/v1/intake/site-keys', {
      body: { label: 'Sales should not' },
    });
    expect(refused.statusCode).toBe(403);
    // Sales may read landing pages, so the list (which holds no secret) is theirs to see.
    expect((await sales.client.request('GET', '/v1/intake/site-keys')).statusCode).toBe(200);
  }, 60_000);

  it('write no secret into the audit log', async () => {
    const rows = await withSystem(
      async (tx) =>
        tx.execute<{ after: unknown }>(sql`
          select after from audit.audit_log
          where org_id = ${ORG_A} and action = 'intake.site_key_issued'
        `),
      { orgId: ORG_A },
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain('sk_');
  }, 60_000);
});

/*
 * M30 security review, D2. The address ids were checked only as positive integers, so an
 * unknown thana reached the insert and failed its foreign key as a 500, with the driver's
 * error quoting the buyer's name, phone and address into the log. A thana from another
 * district was accepted at the claimed district's delivery charge.
 */
describe('M30: an address the reference data does not have is a 400', () => {
  it.each([
    ['an unknown thana', { districtId: 47, thanaId: 99_999 }],
    ['a thana in another district', { districtId: 47, thanaId: 1 }],
    ['an id past the integer range', { districtId: 47, thanaId: 3_000_000_000 }],
  ])('refuses %s, and creates nothing', async (_label, area) => {
    const response = await postSigned(
      orderBody({ address: { ...area, addressLine: 'House 4, Road 2' } }),
    );
    expect(response.statusCode, response.body).toBe(400);
    expect(json<{ code: string }>(response).code).toBe('VALIDATION_FAILED');
  });
});
