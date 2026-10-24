import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ORG_A,
  auditRowsFor,
  startHttpHarness,
  type HttpHarness,
  type InjectedResponse,
  type RoleClient,
} from '../../testing/http-harness.js';
import { resetCourierEnv } from './courier.config.js';
import { applyCourierMigrations, makeBankWallet } from './courier.testing.js';

/**
 * Connecting a courier in one step (D-913), through the real API against real Postgres.
 *
 * The orders module that owns the courier parties and the delivery zones is the real one, so
 * "the party is created" and "it is the default" are read back out of `sales.couriers` and
 * `sales.delivery_zones`, not out of a double. The one stand-in is Steadfast itself: `fetch` is
 * replaced for Steadfast's host only, answering a status question as a courier would — a 401
 * for keys it does not know, an answer about the parcel for keys it does.
 */

const STEADFAST = 'https://portal.packzy.com/api/v1/';
/** An API address override, as Advanced saves one: answered like Steadfast's own host. */
const SANDBOX = 'https://sandbox.packzy.example/api/v1';
const GOOD = { apiKey: 'sf-good-api-key-1234', secretKey: 'sf-good-secret-key-5678' };
const NEWER = { apiKey: 'sf-rotated-api-key-9012', secretKey: 'sf-rotated-secret-3456' };
const KNOWN = new Set([`${GOOD.apiKey}:${GOOD.secretKey}`, `${NEWER.apiKey}:${NEWER.secretKey}`]);

let harness: HttpHarness;
let admin: RoleClient;
let hr: RoleClient;
/** `update CourierSettlement` but only `read Catalog`: may connect, may not move the default. */
let accounts: RoleClient;
const realFetch = globalThis.fetch;
const courierCalls: { url: string; headers: Record<string, string> }[] = [];

function json<T>(response: InjectedResponse): T {
  return JSON.parse(response.body) as T;
}

function connect(client: RoleClient, body: unknown): Promise<InjectedResponse> {
  return client.client.request('POST', '/v1/courier/connections', { body });
}

async function parties(code: string): Promise<{ id: string; name: string; is_active: boolean }[]> {
  return withSystem(
    async (tx) => [
      ...(await tx.execute<{ id: string; name: string; is_active: boolean }>(sql`
        select id, name, is_active from sales.couriers where org_id = ${ORG_A} and code = ${code}
      `)),
    ],
    { orgId: ORG_A },
  );
}

async function accountsFor(provider: string) {
  return withSystem(
    async (tx) => [
      ...(await tx.execute<{
        id: string;
        courier_id: string;
        label: string;
        mode: string;
        base_url: string | null;
        is_active: boolean;
        has_credentials: boolean;
        credentials_fingerprint: string | null;
        poll_after_hours: number;
        settlement_wallet_id: string | null;
        has_webhook_secret: boolean;
      }>(sql`
        select id, courier_id, label, mode, base_url, is_active,
               credentials is not null as has_credentials, credentials_fingerprint,
               poll_after_hours, settlement_wallet_id,
               webhook_secret is not null as has_webhook_secret
        from courier.courier_accounts where org_id = ${ORG_A} and provider_code = ${provider}
      `)),
    ],
    { orgId: ORG_A },
  );
}

async function zoneDefaults(): Promise<(string | null)[]> {
  return withSystem(
    async (tx) =>
      [
        ...(await tx.execute<{ default_courier_id: string | null }>(sql`
          select default_courier_id from sales.delivery_zones where org_id = ${ORG_A} order by code
        `)),
      ].map((row) => row.default_courier_id),
    { orgId: ORG_A },
  );
}

beforeAll(async () => {
  process.env.COURIER_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString('base64');
  // The switches the brand servers set (D-908); the honesty gate itself is tested elsewhere.
  process.env.COURIER_STEADFAST_ENABLED = 'true';
  process.env.COURIER_PATHAO_ENABLED = 'true';
  resetCourierEnv();

  harness = await startHttpHarness('courier-connections');
  await applyCourierMigrations();
  admin = await harness.asRole('org_admin', ORG_A);
  hr = await harness.asRole('hr', ORG_A);
  accounts = await harness.asRole('accounts', ORG_A);

  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(STEADFAST) && !url.startsWith(SANDBOX)) return realFetch(input, init);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    courierCalls.push({ url, headers });
    const known = KNOWN.has(`${headers['api-key'] ?? ''}:${headers['secret-key'] ?? ''}`);
    return known
      ? new Response(JSON.stringify({ status: 404, message: 'Consignment not found.' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response(JSON.stringify({ message: 'Unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
  });
}, 420_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.COURIER_STEADFAST_ENABLED;
  delete process.env.COURIER_PATHAO_ENABLED;
  resetCourierEnv();
  await harness?.close();
}, 60_000);

beforeEach(() => {
  courierCalls.length = 0;
});

describe('the couriers a brand can choose', () => {
  it('lists Steadfast and Pathao by API and Carrybee by its panel, with names and keys', async () => {
    const response = await admin.client.request('GET', '/v1/courier/providers');
    expect(response.statusCode, response.body).toBe(200);
    const { items } = json<{
      items: {
        code: string;
        name: string;
        connect: string;
        enabled: boolean;
        credentialFields: string[];
        verified: boolean;
      }[];
    }>(response);
    const byCode = new Map(items.map((item) => [item.code, item]));

    expect(items.slice(0, 3).map((item) => item.code)).toEqual(['steadfast', 'pathao', 'carrybee']);
    expect(byCode.get('steadfast')).toMatchObject({
      name: 'Steadfast',
      connect: 'api',
      enabled: true,
      credentialFields: ['apiKey', 'secretKey'],
      verified: false,
    });
    expect(byCode.get('pathao')).toMatchObject({
      name: 'Pathao',
      connect: 'api',
      enabled: true,
      credentialFields: ['clientId', 'clientSecret', 'storeId'],
    });
    expect(byCode.get('carrybee')).toMatchObject({
      name: 'Carrybee',
      connect: 'panel',
      enabled: true,
      credentialFields: [],
    });
  });
});

describe('the default as the delivery zones have it', () => {
  it('names the own rider as the default though it has no account, and says when zones differ', async () => {
    const listed = await admin.client.request('GET', '/v1/courier/accounts');
    expect(listed.statusCode, listed.body).toBe(200);
    const [ownRider] = await parties('own_rider');
    expect(json<Record<string, unknown>>(listed)).toMatchObject({
      defaultCourierId: ownRider?.id,
      defaultCourierName: 'Own rider',
      zonesMixed: false,
    });

    // One zone given no courier: the zones no longer agree, so there is no one default.
    const [zone] = await withSystem(
      async (tx) => [
        ...(await tx.execute<{ id: string }>(sql`
          update sales.delivery_zones set default_courier_id = null
          where org_id = ${ORG_A} and code = 'outside_dhaka' returning id
        `)),
      ],
      { orgId: ORG_A },
    );
    try {
      const mixed = await admin.client.request('GET', '/v1/courier/accounts');
      expect(json<Record<string, unknown>>(mixed)).toMatchObject({
        defaultCourierId: null,
        defaultCourierName: null,
        zonesMixed: true,
      });
    } finally {
      await withSystem(
        (tx) =>
          tx.execute(sql`
            update sales.delivery_zones set default_courier_id = ${ownRider?.id ?? null}::uuid
            where org_id = ${ORG_A} and id = ${zone?.id ?? null}::uuid
          `),
        { orgId: ORG_A },
      );
    }
  });
});

describe('connecting Steadfast', () => {
  it('refuses keys Steadfast does not accept with a 400, and saves nothing', async () => {
    const response = await connect(admin, {
      provider: 'steadfast',
      credentials: { apiKey: 'sf-wrong-key', secretKey: 'sf-wrong-secret' },
      isDefault: true,
    });

    expect(response.statusCode, response.body).toBe(400);
    const problem = json<{ code: string; detail: string }>(response);
    expect(problem.code).toBe('COURIER_CREDENTIALS_REJECTED');
    expect(problem.detail).toMatch(/Steadfast did not accept these keys/);
    expect(response.body).not.toContain('sf-wrong-secret');

    // Asked once, with the keys typed, about a consignment that cannot exist.
    expect(courierCalls).toHaveLength(1);
    expect(courierCalls[0]?.url).toBe(`${STEADFAST}status_by_cid/0`);
    expect(courierCalls[0]?.headers['api-key']).toBe('sf-wrong-key');

    expect(await parties('steadfast')).toEqual([]);
    expect(await accountsFor('steadfast')).toEqual([]);
  });

  it('refuses a key Steadfast does not take, and a missing one, before asking it', async () => {
    const extra = await connect(admin, {
      provider: 'steadfast',
      credentials: { ...GOOD, storeId: '12' },
      isDefault: false,
    });
    expect(extra.statusCode, extra.body).toBe(400);
    expect(json<{ code: string; detail: string }>(extra).detail).toMatch(/does not take storeId/);

    const missing = await connect(admin, {
      provider: 'steadfast',
      credentials: { apiKey: GOOD.apiKey },
      isDefault: false,
    });
    expect(missing.statusCode, missing.body).toBe(400);
    expect(json<{ detail: string }>(missing).detail).toMatch(/needs secretKey/);

    const blank = await connect(admin, {
      provider: 'steadfast',
      credentials: { apiKey: '   ', secretKey: GOOD.secretKey },
      isDefault: false,
    });
    expect(blank.statusCode, blank.body).toBe(400);

    expect(courierCalls).toHaveLength(0);
    expect(await accountsFor('steadfast')).toEqual([]);
  });

  it('connects good keys: party made, account active and live, default, audited, no secret back', async () => {
    const response = await connect(admin, {
      provider: 'steadfast',
      // A paste's stray spaces are not part of a key.
      credentials: { apiKey: ` ${GOOD.apiKey} `, secretKey: GOOD.secretKey },
      isDefault: true,
    });

    expect(response.statusCode, response.body).toBe(200);
    const result = json<{
      courierId: string;
      accountId: string | null;
      connected: boolean;
      isDefault: boolean;
      message: string;
    }>(response);
    expect(result).toMatchObject({ connected: true, isDefault: true });
    expect(result.message).toMatch(/Steadfast is connected/);
    expect(response.body).not.toContain(GOOD.secretKey);
    expect(response.body).not.toContain(GOOD.apiKey);
    expect(courierCalls[0]?.headers['api-key']).toBe(GOOD.apiKey);

    const [party] = await parties('steadfast');
    expect(party).toMatchObject({ id: result.courierId, name: 'Steadfast', is_active: true });

    const [account] = await accountsFor('steadfast');
    expect(account).toMatchObject({
      id: result.accountId,
      courier_id: result.courierId,
      label: 'Steadfast',
      mode: 'live',
      base_url: null,
      is_active: true,
      has_credentials: true,
      poll_after_hours: 6,
    });
    expect(account?.credentials_fingerprint).toMatch(/^[0-9a-f]{12}$/);

    // §9's default: every delivery zone now gives a new order Steadfast.
    const defaults = await zoneDefaults();
    expect(defaults.length).toBeGreaterThan(0);
    expect(new Set(defaults)).toEqual(new Set([result.courierId]));

    const accountAudit = await auditRowsFor(ORG_A, result.accountId ?? '');
    expect(accountAudit.map((row) => row.action)).toContain('courier.account.connected');
    expect(accountAudit[0]?.actor_user_id).toBe(admin.userId);
    expect(JSON.stringify(accountAudit)).not.toContain(GOOD.secretKey);
    const defaultAudit = await auditRowsFor(ORG_A, result.courierId);
    expect(defaultAudit.map((row) => row.action)).toContain('courier.default.changed');

    const listed = await admin.client.request('GET', '/v1/courier/accounts');
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.body).not.toContain(GOOD.secretKey);
    const items = json<{ items: { id: string; name: string; isDefault: boolean }[] }>(listed).items;
    expect(items.find((item) => item.id === result.accountId)).toMatchObject({
      name: 'Steadfast',
      isDefault: true,
    });
    expect(json<Record<string, unknown>>(listed)).toMatchObject({
      defaultCourierId: result.courierId,
      defaultCourierName: 'Steadfast',
      zonesMixed: false,
    });
  });
});

describe('Carrybee, booked in its own panel', () => {
  it('makes its party with no account and no call, and can take the default from Steadfast', async () => {
    const response = await connect(admin, {
      provider: 'carrybee',
      credentials: {},
      isDefault: true,
    });

    expect(response.statusCode, response.body).toBe(200);
    const result = json<{
      courierId: string;
      accountId: string | null;
      connected: boolean;
      isDefault: boolean;
      message: string;
    }>(response);
    expect(result).toMatchObject({ accountId: null, connected: false, isDefault: true });
    expect(result.message).toMatch(/Carrybee has no API connection yet/);
    expect(courierCalls).toHaveLength(0);

    const [party] = await parties('carrybee');
    expect(party).toMatchObject({ id: result.courierId, name: 'Carrybee', is_active: true });
    expect(await accountsFor('carrybee')).toEqual([]);
    expect(new Set(await zoneDefaults())).toEqual(new Set([result.courierId]));

    // Steadfast is no longer the default, and the list says so.
    const listed = await admin.client.request('GET', '/v1/courier/accounts');
    const items = json<{ items: { providerCode: string; isDefault: boolean }[] }>(listed).items;
    expect(items.find((item) => item.providerCode === 'steadfast')?.isDefault).toBe(false);

    const keys = await connect(admin, {
      provider: 'carrybee',
      credentials: { apiKey: 'x' },
      isDefault: false,
    });
    expect(keys.statusCode, keys.body).toBe(400);
  });
});

describe('re-connecting', () => {
  it('replaces the keys on the same account and moves the default back', async () => {
    const [before] = await accountsFor('steadfast');
    const response = await connect(admin, {
      provider: 'steadfast',
      credentials: NEWER,
      isDefault: true,
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = json<{ courierId: string; accountId: string; isDefault: boolean }>(response);

    const accounts = await accountsFor('steadfast');
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.id).toBe(before?.id);
    expect(accounts[0]?.credentials_fingerprint).not.toBe(before?.credentials_fingerprint);
    expect(result.isDefault).toBe(true);
    expect(new Set(await zoneDefaults())).toEqual(new Set([result.courierId]));
    expect(await parties('steadfast')).toHaveLength(1);
  });

  it('leaves the default where it is when the default is not asked for', async () => {
    const response = await connect(admin, {
      provider: 'carrybee',
      credentials: {},
      isDefault: false,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(json<{ isDefault: boolean }>(response).isDefault).toBe(false);
    const [steadfast] = await parties('steadfast');
    expect(new Set(await zoneDefaults())).toEqual(new Set([steadfast?.id]));
  });

  it('keeps the mode, API address, label, polling, wallet and webhook secret set in Advanced', async () => {
    const [steadfast] = await parties('steadfast');
    const wallet = await makeBankWallet(ORG_A);
    const advanced = await admin.client.request('POST', '/v1/courier/accounts', {
      body: {
        courierId: steadfast?.id,
        providerCode: 'steadfast',
        label: 'Steadfast (main store)',
        mode: 'sandbox',
        baseUrl: SANDBOX,
        webhookSecret: 'whsec-0123456789abcdef',
        pollAfterHours: 12,
        settlementWalletId: wallet,
        isActive: true,
      },
    });
    expect(advanced.statusCode, advanced.body).toBeLessThan(300);
    const [before] = await accountsFor('steadfast');

    const response = await connect(admin, {
      provider: 'steadfast',
      credentials: GOOD,
      isDefault: true,
    });
    expect(response.statusCode, response.body).toBe(200);

    // Checked against the account's own address, not the installation's.
    expect(courierCalls).toHaveLength(1);
    expect(courierCalls[0]?.url).toBe(`${SANDBOX}/status_by_cid/0`);
    const [after] = await accountsFor('steadfast');
    expect(after).toMatchObject({
      id: before?.id,
      label: 'Steadfast (main store)',
      mode: 'sandbox',
      base_url: SANDBOX,
      poll_after_hours: 12,
      settlement_wallet_id: wallet,
      has_webhook_secret: true,
      is_active: true,
    });
    expect(after?.credentials_fingerprint).not.toBe(before?.credentials_fingerprint);

    // Back to Steadfast's own host for the tests after this one.
    const live = await admin.client.request('POST', '/v1/courier/accounts', {
      body: {
        courierId: steadfast?.id,
        providerCode: 'steadfast',
        label: 'Steadfast',
        mode: 'live',
        pollAfterHours: 6,
        isActive: true,
      },
    });
    expect(live.statusCode, live.body).toBeLessThan(300);
  });
});

describe('"Make default" alone', () => {
  it('moves the default to a connected courier with no keys typed, and leaves its account be', async () => {
    const away = await connect(admin, { provider: 'carrybee', credentials: {}, isDefault: true });
    expect(away.statusCode, away.body).toBe(200);
    const [before] = await accountsFor('steadfast');
    courierCalls.length = 0;

    const response = await connect(admin, {
      provider: 'steadfast',
      credentials: {},
      isDefault: true,
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = json<{
      courierId: string;
      accountId: string;
      connected: boolean;
      isDefault: boolean;
      message: string;
    }>(response);
    expect(result).toMatchObject({ accountId: before?.id, connected: true, isDefault: true });
    expect(result.message).toMatch(/Steadfast keeps its saved keys/);
    // Nothing asked of Steadfast, nothing re-saved.
    expect(courierCalls).toHaveLength(0);
    expect(await accountsFor('steadfast')).toEqual([before]);
    expect(new Set(await zoneDefaults())).toEqual(new Set([result.courierId]));
    const audit = await auditRowsFor(ORG_A, result.courierId);
    expect(audit.map((row) => row.action)).toContain('courier.default.changed');
  });

  it('still asks for the keys of a courier with none saved', async () => {
    const response = await connect(admin, { provider: 'pathao', credentials: {}, isDefault: true });
    expect(response.statusCode, response.body).toBe(400);
    expect(json<{ detail: string }>(response).detail).toMatch(/Pathao needs clientId/);
    expect(await accountsFor('pathao')).toEqual([]);
  });
});

describe('a role that settles couriers but cannot edit delivery zones (accounts)', () => {
  it('connects a courier without the default, but cannot move the default', async () => {
    const [steadfast] = await parties('steadfast');
    const zonesBefore = await zoneDefaults();
    expect(new Set(zonesBefore)).toEqual(new Set([steadfast?.id]));

    const add = await connect(accounts, {
      provider: 'carrybee',
      credentials: {},
      isDefault: false,
    });
    expect(add.statusCode, add.body).toBe(200);

    const panel = await connect(accounts, {
      provider: 'carrybee',
      credentials: {},
      isDefault: true,
    });
    expect(panel.statusCode, panel.body).toBe(403);
    expect(json<{ code: string; detail: string }>(panel)).toMatchObject({ code: 'FORBIDDEN' });
    expect(json<{ detail: string }>(panel).detail).toMatch(/cannot edit delivery zones/);

    const noKeys = await connect(accounts, {
      provider: 'steadfast',
      credentials: {},
      isDefault: true,
    });
    // Steadfast already is the default: nothing to change, so nothing to refuse.
    expect(noKeys.statusCode, noKeys.body).toBe(200);
    expect(json<{ isDefault: boolean }>(noKeys).isDefault).toBe(true);
    expect(await zoneDefaults()).toEqual(zonesBefore);
  });

  it('is refused before the courier is asked when the keys come with a new default', async () => {
    const away = await connect(admin, { provider: 'carrybee', credentials: {}, isDefault: true });
    expect(away.statusCode, away.body).toBe(200);
    const zonesBefore = await zoneDefaults();
    const [before] = await accountsFor('steadfast');
    courierCalls.length = 0;

    const response = await connect(accounts, {
      provider: 'steadfast',
      credentials: GOOD,
      isDefault: true,
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(courierCalls).toHaveLength(0);
    expect(await accountsFor('steadfast')).toEqual([before]);
    expect(await zoneDefaults()).toEqual(zonesBefore);

    // The same keys without the default are the accounts role's to save.
    const keysOnly = await connect(accounts, {
      provider: 'steadfast',
      credentials: GOOD,
      isDefault: false,
    });
    expect(keysOnly.statusCode, keysOnly.body).toBe(200);
    expect(json<{ isDefault: boolean }>(keysOnly).isDefault).toBe(false);
    expect(await zoneDefaults()).toEqual(zonesBefore);

    const back = await connect(admin, { provider: 'steadfast', credentials: {}, isDefault: true });
    expect(back.statusCode, back.body).toBe(200);
  });
});

describe('the other refusals', () => {
  it('refuses a Pathao store id that is not a number without calling Pathao', async () => {
    const response = await connect(admin, {
      provider: 'pathao',
      credentials: { clientId: '123', clientSecret: 'pathao-secret', storeId: 'my-store' },
      isDefault: false,
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(json<{ code: string }>(response).code).toBe('COURIER_CREDENTIALS_REJECTED');
    expect(await accountsFor('pathao')).toEqual([]);
  });

  it('refuses a courier nobody offers, and a body with anything else in it', async () => {
    const unknown = await connect(admin, {
      provider: 'ecourier',
      credentials: {},
      isDefault: false,
    });
    expect(unknown.statusCode, unknown.body).toBe(400);
    const extra = await connect(admin, {
      provider: 'carrybee',
      credentials: {},
      isDefault: false,
      label: 'Mine',
    });
    expect(extra.statusCode, extra.body).toBe(400);
  });

  it('refuses a role without update CourierSettlement', async () => {
    const response = await connect(hr, { provider: 'carrybee', credentials: {}, isDefault: true });
    expect(response.statusCode, response.body).toBe(403);
  });
});
