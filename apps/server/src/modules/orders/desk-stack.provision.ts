import { randomBytes } from 'node:crypto';

import type { MembershipRole } from '@elysium/contracts';
import { createAuth, RecordingSmsProvider, SEED_ORG_IDS, withSystem } from '@elysium/db';
import { internalEan13 } from '@elysium/domain/barcode';
import { sql } from 'drizzle-orm';
import {
  createTestUser,
  grantMembership,
  startTestDatabase,
  type TestDatabase,
} from '@elysium/db/testing';

import { applyIntakeMigrations } from '../intake/intake.testing.js';
import { seedProductWithSkus, warehouseId } from '../inventory/inventory.testing.js';
import { seedWallet } from '../wallets/wallets.testing.js';
import { ownRiderCourier, seedCustomer, seedOrder, seedStockLevel } from './orders.testing.js';

/**
 * The order desk's real-stack Playwright run: a throwaway database with throwaway users
 * (M11 acceptance checks 1 and 4).
 *
 * Test-only, and run as a process of its own — `node --env-file=apps/server/.env
 * apps/server/dist/modules/orders/desk-stack.provision.js create` — by the console's
 * Playwright `globalSetup`, which then points a real API, a real worker and the real console
 * at what this prints. Compiled with the server because it is built from the server's own
 * test fixtures, which Playwright's transform cannot load (Nest's decorators need
 * `emitDecoratorMetadata`).
 *
 * * **A database of its own**, created by `startTestDatabase` — the harness every server
 *   suite uses — on the local Postgres the dev stack runs, so the API and the worker can
 *   reach it. This process stays alive for the run and drops the database, through the
 *   harness's own `stop()`, when `globalTeardown` writes `stop` to its stdin (or closes
 *   it). A signal would be the obvious channel and is not one on Windows. The developer's
 *   own database is never touched.
 * * **Users through the same fixtures as `asRole`**: `createTestUser`, `grantMembership`,
 *   and a password set through Better Auth's own reset flow, so it is hashed by the library
 *   and never by code here. Two `sales` agents, no second factor (§6 walls org_admin,
 *   accounts and investor behind one).
 * * **Throwaway values only** (invariant 10): `@example.invalid` addresses, a random
 *   password that exists only in this process's stdout and the Playwright process that
 *   reads it, SKU codes made from a random run id.
 *
 * Refuses to run against anything but a local server, or with `NODE_ENV=production`: a
 * script that creates users and sets passwords must not be one mistyped variable away from
 * a brand's data.
 */

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function adminUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_ADMIN_URL ?? '';
  if (url === '') throw new Error('desk-stack: DATABASE_ADMIN_URL is not set (apps/server/.env).');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('desk-stack: refusing to run with NODE_ENV=production.');
  }
  const host = new URL(url).hostname;
  if (!LOCAL.has(host)) throw new Error(`desk-stack: refusing to run against ${host}.`);
  return url;
}

async function create(): Promise<void> {
  // `startTestDatabase` creates its database on TEST_DATABASE_URL's server, or starts a
  // container that dies with this process — which would take the database away from the
  // API before the first request. The local server it is, then.
  process.env.TEST_DATABASE_URL = adminUrl();
  const database: TestDatabase = await startTestDatabase('deske2e');
  await applyIntakeMigrations();

  const orgId = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
  const run = randomBytes(4).toString('hex');
  const password = randomBytes(18).toString('base64url');

  const tokens = new Map<string, string>();
  const created = createAuth({
    baseUrl: process.env.E2E_API_URL ?? 'http://localhost:3110',
    secret: process.env.AUTH_SECRET ?? randomBytes(32).toString('hex'),
    trustedOrigins: [process.env.E2E_CONSOLE_URL ?? 'http://localhost:5183'],
    sms: new RecordingSmsProvider(),
    rateLimitEnabled: false,
    onPasswordToken: ({ email, token }) => {
      tokens.set(email, token);
      return Promise.resolve();
    },
  });
  const { auth } = created;

  const otherOrgId = SEED_ORG_IDS['oura-lifestyle'] ?? '';

  /*
   * Who the browser suites sign in as.
   *
   * `desk` and `queue` are the two sales sessions M11's checks need. The other two exist
   * for M05's navigation check: `accounts` is given the role and nothing else, so the
   * suite has to pass §6's two-factor enrolment through the real screen before it sees a
   * single page, and `switcher` holds a different role in each of two brands, which is
   * the only way "switching org changes the navigation" can be observed. `treasurer` is a
   * second accounts user for the money screens' run, so neither suite depends on whether
   * the other has already enrolled its second factor.
   */
  const people: readonly {
    label: string;
    grants: readonly { orgId: string; role: MembershipRole }[];
  }[] = [
    { label: 'desk', grants: [{ orgId, role: 'sales' }] },
    { label: 'queue', grants: [{ orgId, role: 'sales' }] },
    { label: 'accounts', grants: [{ orgId, role: 'accounts' }] },
    { label: 'treasurer', grants: [{ orgId, role: 'accounts' }] },
    // M16's buyer and campaign screens: promo codes, templates and the lapsed list are
    // marketing's (D-203, D-205, D-208).
    { label: 'marketing', grants: [{ orgId, role: 'marketing' }] },
    // M17: an accounts user of its own for the advance queue, so its second-factor
    // enrolment does not depend on whether another suite has already done its own.
    { label: 'checker', grants: [{ orgId, role: 'accounts' }] },
    // The console gaps (D-394): an org admin for the settings screens, behind §6's 2FA wall.
    { label: 'admin', grants: [{ orgId, role: 'org_admin' }] },
    {
      label: 'switcher',
      grants: [
        { orgId, role: 'sales' },
        { orgId: otherOrgId, role: 'warehouse' },
      ],
    },
    // gaps-users-auth: two org admins for the staff screen — one asks for a reset, the
    // other approves it — and an accountant whose lost phone is the reset (users.stack.ts).
    // The first is an org admin of its own, not the `admin` above: order-lifecycle enrols
    // that one's second factor earlier in the run, and the staff spec expects the wall.
    { label: 'staffadmin', grants: [{ orgId, role: 'org_admin' }] },
    { label: 'admin2', grants: [{ orgId, role: 'org_admin' }] },
    { label: 'locked', grants: [{ orgId, role: 'accounts' }] },
    // catalog-stock-ux: an org admin of its own for the product and stock screens
    // (catalog-stock.stack.ts), so its two-step enrolment never races another suite's.
    { label: 'merchandiser', grants: [{ orgId, role: 'org_admin' }] },
    // M38a: an org admin for barcodes.stack.ts (stock in hand, stickers, the scanner), its
    // own for the same reason as the merchandiser's.
    { label: 'stocker', grants: [{ orgId, role: 'org_admin' }] },
    // M34: an org admin of its own for Website → Payments and Email (website-buying.stack.ts),
    // the only role that may change the website's credentials (D-528).
    { label: 'webadmin', grants: [{ orgId, role: 'org_admin' }] },
    // M39b: an org admin of its own for variant prices and buying prices
    // (variant-pricing.stack.ts), its two-step enrolment its own like the merchandiser's.
    { label: 'pricer', grants: [{ orgId, role: 'org_admin' }] },
    // M39a: an org admin for delete-archive.stack.ts (deleting and archiving everywhere), its
    // own so its two-step enrolment never races another suite's.
    { label: 'remover', grants: [{ orgId, role: 'org_admin' }] },
    // M38b: a warehouse packer for the packing station (packing.stack.ts). The warehouse has
    // no two-step wall, which is how the packing desk signs in.
    { label: 'packer', grants: [{ orgId, role: 'warehouse' }] },
    // M40: a sales person of their own for My account (account.stack.ts): their name,
    // password and two-step sign-in change there, so nobody else may share them.
    { label: 'self', grants: [{ orgId, role: 'sales' }] },
    // M41: the order workflow's supervisor (order-workflow.stack.ts), an org admin of their own
    // so their two-step enrolment never races another suite's.
    { label: 'supervisor', grants: [{ orgId, role: 'org_admin' }] },
  ];

  const users: { role: string; email: string; userId: string }[] = [];
  for (const { label, grants } of people) {
    const email = `e2e.${label}.${run}@example.invalid`;
    const user = await createTestUser({ email, name: `E2E ${label} agent` });
    for (const grant of grants) {
      await grantMembership({ userId: user.id, orgId: grant.orgId, role: grant.role });
    }
    await auth.api.requestPasswordReset({ body: { email, redirectTo: '/accept-invite' } });
    const token = tokens.get(email);
    if (token === undefined) throw new Error(`desk-stack: no reset token for ${label}.`);
    await auth.api.resetPassword({ body: { newPassword: password, token } });
    users.push({ role: label, email, userId: user.id });
  }
  await created.close();

  const { skus } = await seedProductWithSkus(orgId, `e2e${run}`, 2);
  const location = await warehouseId(orgId);
  for (const sku of skus) {
    await seedStockLevel(orgId, {
      skuId: sku.id,
      locationId: location,
      qty: 50,
      unitCostPoisha: 40_000n,
    });
  }

  // The head office's hand cash and the bank, as wallets: the seed creates their ledger
  // accounts, and a wallet is the row a person picks on the accounts screens.
  await seedWallet(orgId, '1010-HQ', { provider: 'Till' });
  await seedWallet(orgId, '1100', { provider: 'Bank' });

  // M16 check 5: a code the desk can apply. 10% off, no minimum, no limit, so a rerun of the
  // spec against the same stack still finds it applicable. Seeded rather than created
  // through the API because the stack's agents hold `read LandingPage` (apply a code), not
  // `create` — exactly the split §6 draws between the desk and marketing (D-203).
  const promoCode = `E2E${run.slice(0, 6).toUpperCase()}`;
  await withSystem(
    (tx) =>
      tx.execute(sql`
        insert into promo.codes (org_id, code, kind, value_bps, created_by)
        values (${orgId}, ${promoCode}, 'percent', 1000, 'usr_stack_provision')
        on conflict (org_id, code) do nothing
      `),
    { orgId },
  );

  // M16: a buyer the lapsed list must find — one delivered order, placed a hundred days
  // ago, and nothing since. Written as the order transitions would have left it: the order
  // delivered, the line's delivered quantity set, the buyer's counters moved.
  const [firstSku] = skus;
  if (firstSku === undefined) throw new Error('desk-stack: no SKU to seed a lapsed buyer with.');
  const lapsedPhone = `+88017${String(10_000_000 + Math.floor(Math.random() * 89_999_999))}`;
  const lapsedBuyer = await seedCustomer(orgId, { phoneE164: lapsedPhone, name: 'Lapsed Buyer' });
  const { id: lapsedOrder } = await seedOrder(orgId, {
    customerId: lapsedBuyer,
    status: 'delivered',
    lines: [
      {
        skuId: firstSku.id,
        skuCode: firstSku.code,
        productName: 'E2E Product',
        qty: 2,
        unitPricePoisha: 120_000n,
        deliveredQty: 2,
      },
    ],
  });
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        update sales.orders
        set created_at = now() - interval '100 days', delivered_at = now() - interval '98 days'
        where org_id = ${orgId} and id = ${lapsedOrder}
      `);
      await tx.execute(sql`
        update sales.customers
        set orders_total = 1, delivered_count = 1, ltv_poisha = 240000,
            first_order_at = now() - interval '100 days', last_order_at = now() - interval '100 days'
        where org_id = ${orgId} and id = ${lapsedBuyer}
      `);
    },
    { orgId },
  );

  /*
   * M17: a pending order the desk agent works, for the advance claim; and a parcel that came
   * back with its reason recorded today, so the returns report has a line to show. Written
   * as the transitions would have left them: the reason row beside the returned order.
   */
  const desk = users.find((entry) => entry.role === 'desk');
  if (desk === undefined) throw new Error('desk-stack: no desk user.');
  const advanceBuyer = await seedCustomer(orgId, {
    phoneE164: `+88019${String(10_000_000 + Math.floor(Math.random() * 89_999_999))}`,
    name: 'Advance Buyer',
  });
  const firstLine = {
    skuId: firstSku.id,
    skuCode: firstSku.code,
    productName: 'E2E Product',
    qty: 1,
    unitPricePoisha: 150_000n,
  };
  const advanceOrder = await seedOrder(orgId, {
    customerId: advanceBuyer,
    status: 'pending',
    lines: [firstLine],
    locationId: location,
    createdBy: desk.userId,
    assignedTo: desk.userId,
  });
  const { id: returnedOrder } = await seedOrder(orgId, {
    customerId: advanceBuyer,
    status: 'returned',
    lines: [{ ...firstLine, returnedQty: 1 }],
    createdBy: desk.userId,
    assignedTo: desk.userId,
  });
  await withSystem(
    (tx) =>
      tx.execute(sql`
        insert into sales.order_returns
          (org_id, order_id, kind, reason_code, note, business_date, recorded_by)
        values (${orgId}, ${returnedOrder}, 'return', 'customer_refused', 'Refused at the door',
                (now() at time zone 'Asia/Dhaka')::date, ${desk.userId})
      `),
    { orgId },
  );

  /*
   * The console gaps (D-392, D-393): a pending order the desk agent walks to delivered with
   * the lifecycle buttons, and a confirmed one (its units held) for bulk pack. Both carry the
   * brand's own rider as their courier, because the delivery journal names one (§7).
   */
  const rider = await ownRiderCourier(orgId);
  const lifecycleOrder = await seedOrder(orgId, {
    customerId: advanceBuyer,
    status: 'pending',
    lines: [firstLine],
    locationId: location,
    courierId: rider,
    createdBy: desk.userId,
    assignedTo: desk.userId,
  });
  const bulkOrder = await seedOrder(orgId, {
    customerId: advanceBuyer,
    status: 'confirmed',
    lines: [firstLine],
    locationId: location,
    courierId: rider,
    reserve: true,
    createdBy: desk.userId,
    assignedTo: desk.userId,
  });

  /*
   * M38b: an order for the packing station. Two of the first product's pieces (the first SKU),
   * with the second SKU (the same product in another size) and a second product's SKU to be
   * scanned by mistake; each SKU with an internal EAN-13, as M38a gives every new one.
   */
  const { skus: otherSkus } = await seedProductWithSkus(orgId, `pk${run}`, 1);
  const barcodes: string[] = [];
  for (const [index, sku] of [...skus, ...otherSkus].entries()) {
    const barcode = internalEan13(
      90_000_000_000 + Math.floor(Math.random() * 900_000_000) * 10 + index,
    );
    barcodes.push(barcode);
    await withSystem(
      (tx) =>
        tx.execute(
          sql`update catalog.skus set barcode = ${barcode} where org_id = ${orgId} and id = ${sku.id}`,
        ),
      { orgId },
    );
  }
  const packOrder = await seedOrder(orgId, {
    customerId: advanceBuyer,
    status: 'confirmed',
    lines: [{ ...firstLine, qty: 2 }],
    locationId: location,
    courierId: rider,
    reserve: true,
    createdBy: desk.userId,
    assignedTo: desk.userId,
  });

  process.stdout.write(
    `${JSON.stringify({
      databaseName: database.databaseName,
      appUrl: database.appUrl,
      ownerUrl: database.ownerUrl,
      analyticsUrl: database.analyticsUrl,
      adminUrl: database.adminUrl,
      orgId,
      password,
      users,
      skuCodes: skus.map((sku) => sku.code),
      promoCode,
      lapsedBuyer: { id: lapsedBuyer, name: 'Lapsed Buyer' },
      advanceOrder: { id: advanceOrder.id, orderNo: advanceOrder.orderNo },
      lifecycleOrder,
      bulkOrder,
      packOrder,
      packSkus: {
        right: { code: firstSku.code, barcode: barcodes[0] ?? '' },
        wrongSize: { code: skus[1]?.code ?? '', barcode: barcodes[1] ?? '' },
        wrongItem: { code: otherSkus[0]?.code ?? '', barcode: barcodes[2] ?? '' },
      },
    })}\n`,
  );

  // Hold the database open until the run is over, then drop it the harness's way.
  await new Promise<void>((resolve) => {
    let buffered = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      buffered += chunk;
      if (buffered.includes('stop')) resolve();
    });
    process.stdin.on('end', () => resolve());
  });
  await database.stop();
}

const [command] = process.argv.slice(2);
const work =
  command === 'create'
    ? create()
    : Promise.reject(new Error('usage: desk-stack.provision.js create'));

work.then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `desk-stack failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  },
);
