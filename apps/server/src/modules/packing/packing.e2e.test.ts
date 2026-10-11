import { randomUUID } from 'node:crypto';

import { base32 } from '@better-auth/utils/base32';
import { grantMembership } from '@elysium/db/testing';
import { withGlobal, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  PASSWORD,
  createBranch,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { seedProductWithSkus } from '../inventory/inventory.testing.js';
import { applyOrderMigrations, seedCustomer, seedOrder } from '../orders/orders.testing.js';
import { orderLabelsHtml, qrSvg } from './order-labels.js';

/**
 * The packing scanner and the order labels on real Postgres (M35b, D-554, D-555; M35
 * acceptance check 5): a phone signs in with a password (and the authenticator's code where
 * the account has two-step sign-in), looks a parcel up with its device token, and a revoked or
 * signed-out token — or one whose person was switched off — is refused.
 */

let harness: HttpHarness;
let admin: RoleClient;
let packer: RoleClient;
let sales: RoleClient;
let orderNo = '';
let orderId = '';
let skuCode = '';
const suffix = randomUUID().slice(0, 6);

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await harness.server.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', origin: 'https://localhost', ...headers },
    payload: JSON.stringify(body),
  });
  return {
    status: response.statusCode,
    body: JSON.parse(response.body) as Record<string, unknown>,
  };
}

async function lookup(token: string, code: string) {
  const response = await harness.server.inject({
    method: 'GET',
    url: `/v1/scanner/shipment?code=${encodeURIComponent(code)}`,
    headers: { authorization: `Bearer ${token}`, origin: 'https://localhost' },
  });
  return {
    status: response.statusCode,
    body: JSON.parse(response.body) as Record<string, unknown>,
  };
}

/** An org_admin with an authenticator, keeping the secret so the test can make codes. */
async function adminWithAuthenticator(): Promise<{
  email: string;
  secret: string;
  userId: string;
}> {
  const client = harness.client();
  const email = `scanner_admin_${suffix}@example.invalid`;
  const userId = `usr_${randomUUID()}`;
  await withGlobal(async (tx) => {
    await tx.execute(sql`
      insert into iam.users (id, email, name, email_verified)
      values (${userId}, ${email}, 'Scanner admin', true)
    `);
  });
  await grantMembership({ userId, orgId: ORG_A, role: 'org_admin' });
  await client.request('GET', '/v1/auth/login-branding');
  await harness.auth.auth.api.requestPasswordReset({
    body: { email, redirectTo: '/accept-invite' },
    headers: new Headers(),
  });
  const token = harness.tokens.take(email);
  await client.request('POST', '/api/auth/reset-password', {
    body: { newPassword: PASSWORD, token },
  });
  await client.request('POST', '/api/auth/sign-in/email', { body: { email, password: PASSWORD } });
  const enabled = await client.request('POST', '/api/auth/two-factor/enable', {
    body: { password: PASSWORD, method: 'totp' },
  });
  const { totpURI } = JSON.parse(enabled.body) as { totpURI: string };
  const secret = new TextDecoder().decode(
    base32.decode(new URL(totpURI).searchParams.get('secret') ?? ''),
  );
  const { code } = await harness.auth.auth.api.generateTOTP({ body: { secret } });
  await client.request('POST', '/api/auth/two-factor/verify-totp', { body: { code } });
  return { email, secret, userId };
}

beforeAll(async () => {
  harness = await startHttpHarness('packing');
  await applyOrderMigrations();
  admin = await harness.asRole('org_admin', ORG_A);
  packer = await harness.asRole('warehouse', ORG_A);
  sales = await harness.asRole('sales', ORG_A);
  const seeded = await seedProductWithSkus(ORG_A, `pack${suffix}`, 1);
  const sku = seeded.skus[0];
  skuCode = sku?.code ?? '';
  const customerId = await seedCustomer(ORG_A, {
    phoneE164: '+8801711000222',
    name: 'Rahim Uddin',
  });
  const order = await seedOrder(ORG_A, {
    status: 'confirmed',
    customerId,
    createdBy: admin.userId,
    lines: [
      {
        skuId: sku?.id ?? '',
        skuCode,
        productName: `Product pack${suffix}`,
        qty: 2,
        unitPricePoisha: 150_000n,
      },
    ],
  });
  orderNo = order.orderNo;
  orderId = order.id;
}, 180_000);

afterAll(async () => {
  await harness.close();
});

describe('a scanner phone (check 5)', () => {
  it('signs in with a password, looks a parcel up, and is refused once revoked', async () => {
    const signedIn = await post('/v1/scanner/sign-in', {
      email: packer.email,
      password: PASSWORD,
      deviceName: 'Packing table 1',
    });
    expect(signedIn.status).toBe(200);
    const token = signedIn.body.token as string;
    expect(token).toMatch(/^sdt_[0-9a-f]{32}_/);
    expect(signedIn.body.user).toMatchObject({ email: packer.email, role: 'warehouse' });
    // Only the hash is kept.
    const stored = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ n: number }>(sql`
            select count(*)::int as n from packing.scanner_devices
            where org_id = ${ORG_A} and token_sha256 = encode(sha256(${token}::bytea), 'hex')
          `)
        )[0]?.n,
      { orgId: ORG_A },
    );
    expect(stored).toBe(1);

    const found = await lookup(token, orderNo);
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({
      found: true,
      code: orderNo,
      order: {
        orderNumber: orderNo,
        status: 'confirmed',
        paid: false,
        codAmount: '3060.00',
        recipient: { name: expect.any(String) as string },
        itemCount: 1,
        totalUnits: 2,
        items: [{ sku: skuCode, quantity: 2, returnedQuantity: 0 }],
      },
    });
    expect(JSON.stringify(found.body)).not.toMatch(/cost|wac/i);

    const missing = await lookup(token, 'NO-SUCH-CODE');
    expect(missing.body).toEqual({ found: false, code: 'NO-SUCH-CODE' });

    // The device list shows it, and its owner ends it from the console.
    const list = await packer.client.request('GET', '/v1/scanner/devices');
    const devices = (
      JSON.parse(list.body) as { items: { id: string; label: string; active: boolean }[] }
    ).items;
    const device = devices.find((entry) => entry.label === 'Packing table 1');
    expect(device?.active).toBe(true);
    const revoked = await packer.client.request(
      'POST',
      `/v1/scanner/devices/${device?.id ?? ''}/revoke`,
    );
    expect(revoked.statusCode).toBe(200);
    expect((await lookup(token, orderNo)).status).toBe(401);
  });

  it('refuses a wrong password, and a token after sign-out or once its person is switched off', async () => {
    const wrong = await post('/v1/scanner/sign-in', {
      email: packer.email,
      password: 'not-it-at-all',
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('SCANNER_CREDENTIALS_INVALID');

    const first = await post('/v1/scanner/sign-in', { email: packer.email, password: PASSWORD });
    const token = first.body.token as string;
    const out = await harness.server.inject({
      method: 'POST',
      url: '/v1/scanner/sign-out',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(out.statusCode).toBe(200);
    expect((await lookup(token, orderNo)).status).toBe(401);

    const temp = await harness.asRole('warehouse', ORG_A);
    const second = await post('/v1/scanner/sign-in', { email: temp.email, password: PASSWORD });
    const live = second.body.token as string;
    expect((await lookup(live, orderNo)).status).toBe(200);
    await withSystem(
      (tx) =>
        tx.execute(
          sql`update iam.memberships set is_active = false where user_id = ${temp.userId}`,
        ),
      { orgId: ORG_A },
    );
    expect((await lookup(live, orderNo)).status).toBe(401);
  });

  it('answers the app as it ships at the old addresses, in its words', async () => {
    const person = await harness.asRole('warehouse', ORG_A);
    const wrong = await post('/api/admin/scanner/login', {
      email: person.email,
      password: 'not-it-at-all',
    });
    expect(wrong.status).toBe(401);
    // The app shows `error`.
    expect(wrong.body).toMatchObject({ code: 'SCANNER_CREDENTIALS_INVALID' });
    expect(typeof wrong.body.error).toBe('string');

    const signedIn = await post('/api/admin/scanner/login', {
      email: person.email,
      password: PASSWORD,
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.user).toMatchObject({ email: person.email, role: 'warehouse' });
    const found = await harness.server.inject({
      method: 'GET',
      url: `/api/admin/scanner/shipment?code=${encodeURIComponent(orderNo)}`,
      headers: {
        authorization: `Bearer ${signedIn.body.token as string}`,
        origin: 'https://localhost',
      },
    });
    expect(found.statusCode).toBe(200);
    expect(JSON.parse(found.body)).toMatchObject({ found: true, order: { orderNumber: orderNo } });
  });

  it('refuses a token past its thirty days', async () => {
    const token = `sdt_${ORG_A.replaceAll('-', '')}_${'x'.repeat(43)}`;
    await withSystem(
      (tx) =>
        tx.execute(sql`
          insert into packing.scanner_devices
            (org_id, user_id, label, token_sha256, via, expires_at, created_at)
          values (${ORG_A}, ${packer.userId}, 'Old phone',
                  encode(sha256(${token}::bytea), 'hex'), 'console',
                  now() - interval '1 day', now() - interval '31 days')
        `),
      { orgId: ORG_A },
    );
    expect((await lookup(token, orderNo)).status).toBe(401);
  });

  it('asks an account with two-step sign-in for its code, and takes the right one', async () => {
    const person = await adminWithAuthenticator();
    const noCode = await post('/v1/scanner/sign-in', { email: person.email, password: PASSWORD });
    expect(noCode.status).toBe(401);
    expect(noCode.body.code).toBe('SCANNER_CODE_REQUIRED');
    const { code } = await harness.auth.auth.api.generateTOTP({ body: { secret: person.secret } });
    const withCode = await post('/v1/scanner/sign-in', {
      email: person.email,
      password: PASSWORD,
      code,
    });
    expect(withCode.status).toBe(200);
    expect((await lookup(withCode.body.token as string, orderNo)).body.found).toBe(true);
  });

  it('keeps a scanner to its person’s own order scope', async () => {
    const signedIn = await post('/v1/scanner/sign-in', { email: sales.email, password: PASSWORD });
    expect(signedIn.status).toBe(200);
    // The order was made by the admin and is held by them. Since D-725 a sales agent reads
    // every order of the brand, so their scanner finds it; a branch manager kept to one branch
    // does not find a desk order, which has no branch: the scanner reads as its person does.
    await withSystem(
      (tx) =>
        tx.execute(
          sql`update sales.orders set assigned_to = ${admin.userId} where id = ${orderId}`,
        ),
      { orgId: ORG_A },
    );
    expect((await lookup(signedIn.body.token as string, orderNo)).body).toMatchObject({
      found: true,
    });
    const branch = await createBranch(ORG_A, `PK${String(Date.now()).slice(-6)}`);
    const manager = await harness.asRole('branch_manager', ORG_A, { branchIds: [branch] });
    const managerIn = await post('/v1/scanner/sign-in', {
      email: manager.email,
      password: PASSWORD,
    });
    expect(managerIn.status).toBe(200);
    expect((await lookup(managerIn.body.token as string, orderNo)).body).toEqual({
      found: false,
      code: orderNo,
    });
    await withSystem(
      (tx) => tx.execute(sql`update sales.orders set assigned_to = null where id = ${orderId}`),
      { orgId: ORG_A },
    );
  });

  it('pairs a phone from the console with a code shown once', async () => {
    const paired = await packer.client.request('POST', '/v1/scanner/devices', {
      body: { deviceName: 'Spare phone' },
    });
    expect(paired.statusCode).toBe(201);
    const token = (JSON.parse(paired.body) as { token: string }).token;
    expect((await lookup(token, orderNo)).body.found).toBe(true);
    // The console's own lookup, in the session's scope.
    const viaConsole = await packer.client.request('GET', `/v1/scanner/lookup?code=${orderNo}`);
    expect(JSON.parse(viaConsole.body)).toMatchObject({ found: true });
  });
});

describe('order labels', () => {
  it('render the old sheet with the QR of the order number and the amount to collect', async () => {
    const response = await admin.client.request('POST', '/v1/packing/labels', {
      body: { orderIds: [orderId], size: '2x3' },
    });
    expect(response.statusCode, response.body.slice(0, 200)).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.body.startsWith('%PDF')).toBe(true);

    const refused = await sales.client.request('POST', '/v1/packing/labels', {
      body: { orderIds: [randomUUID()], size: 'a4' },
    });
    expect(refused.statusCode).toBe(404);
  });

  it('draws a QR of whole black modules and escapes what a person typed', () => {
    const svg = qrSvg('TST-2609-00001', 22);
    expect(svg).toMatch(/^<svg[^>]+viewBox="0 0 (\d+) \1"/);
    expect(svg).toContain('shape-rendering="crispEdges"');
    const html = orderLabelsHtml({
      labels: [
        {
          shopName: 'Shop <b>',
          merchantId: 'M-123',
          orderNo: 'TST-1',
          date: '05/10/2026',
          scan: 'TST-1',
          consignmentNo: null,
          recipientName: '<script>x</script>',
          recipientPhone: '01711-000222',
          address: 'House 1',
          subtotal: 'Tk 3,000.00',
          discount: null,
          delivery: 'Tk 60.00',
          collect: 'Tk 3,060.00',
          total: 'Tk 3,060.00',
          paymentWords: 'Cash on delivery',
        },
      ],
      options: {
        size: '4x6',
        layout: 'portrait',
        showShopName: true,
        showQr: true,
        showPrices: true,
        showCod: true,
      },
      fonts: [],
    });
    expect(html).toContain('Not in courier yet');
    expect(html).toContain('Collect (COD)');
    expect(html).toContain('M-123');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('@page { size: 101.6mm 152.4mm');
  });
});
