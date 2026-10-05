import { randomUUID } from 'node:crypto';

import { withOrg, withSystem } from '@elysium/db';
import { poisha } from '@elysium/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INVENTORY_API, type InventoryApi } from '../../modules/inventory/inventory.api.js';
import { seedCustomer, seedOrder } from '../../modules/orders/orders.testing.js';
import { seedWallet } from '../../modules/wallets/wallets.testing.js';
import {
  ORG_A,
  ORG_B,
  auditRowsFor,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';

/**
 * Deleting and archiving everything that is not the catalog (M39a, D-628 to D-634; M39
 * check 1), over HTTP on a real PostgreSQL: stock locations, suppliers, discounts, flash
 * sales, SMS templates, ad campaigns, size charts and the menu; branches renamed and switched
 * off; expense and income heads. Each unused row is deleted with its content in the audit
 * log, each used one is refused with its module's `*_IN_USE` and kept, and another brand
 * never reaches it.
 */

let harness: HttpHarness;
let admin: RoleClient;
let marketing: RoleClient;
let accounts: RoleClient;
let sales: RoleClient;
let otherAdmin: RoleClient;
let inventory: InventoryApi;

interface Called<T> {
  readonly status: number;
  readonly body: T;
  readonly raw: string;
}

async function call<T = Record<string, unknown>>(
  who: RoleClient,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<Called<T>> {
  const response = await who.client.request(
    method,
    url,
    payload === undefined ? {} : { body: payload },
  );
  return {
    status: response.statusCode,
    body: (response.body === '' ? {} : JSON.parse(response.body)) as T,
    raw: response.body,
  };
}

async function ok<T = Record<string, unknown>>(
  who: RoleClient,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<T> {
  const result = await call<T>(who, method, url, payload);
  expect(result.status, `${method} ${url}: ${result.raw}`).toBeLessThan(300);
  return result.body;
}

const token = (length = 6) => randomUUID().replace(/-/g, '').slice(0, length).toUpperCase();

async function count(query: ReturnType<typeof sql>): Promise<number> {
  return withSystem(async (tx) => Number((await tx.execute<{ n: string }>(query))[0]?.n ?? 0), {
    orgId: ORG_A,
  });
}

async function run(query: ReturnType<typeof sql>): Promise<void> {
  await withSystem((tx) => tx.execute(query), { orgId: ORG_A });
}

interface Usage {
  readonly canDelete: boolean;
  readonly canArchive: boolean;
  readonly canEmptyAndDelete: boolean;
  readonly archived: boolean;
  readonly uses: readonly {
    readonly reason: string;
    readonly count: number;
    readonly examples: readonly { readonly id: string; readonly label: string }[];
  }[];
}

const reasons = (usage: Usage) =>
  Object.fromEntries(usage.uses.map((use) => [use.reason, use.count]));

async function deletedWithBefore(entityId: string, action: string): Promise<unknown> {
  const rows = await auditRowsFor(ORG_A, entityId);
  const row = rows.find((entry) => entry.action === action);
  expect(row?.operation, action).toBe('delete');
  return row?.before;
}

async function aProduct(): Promise<{ id: string; skuId: string }> {
  const created = await ok<{ id: string; skus: { id: string }[] }>(
    admin,
    'POST',
    '/v1/catalog/products',
    { name: `Item ${token()}`, slug: `item-${token(8).toLowerCase()}`, pricePoisha: '150000' },
  );
  return { id: created.id, skuId: created.skus[0]?.id ?? '' };
}

beforeAll(async () => {
  harness = await startHttpHarness('m39a-deletes');
  admin = await harness.asRole('org_admin', ORG_A);
  marketing = await harness.asRole('marketing', ORG_A);
  accounts = await harness.asRole('accounts', ORG_A);
  sales = await harness.asRole('sales', ORG_A);
  otherAdmin = await harness.asRole('org_admin', ORG_B);
  inventory = harness.app.get<InventoryApi>(INVENTORY_API, { strict: false });
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

describe('stock locations (D-629)', () => {
  async function location(): Promise<string> {
    return (
      await ok<{ id: string }>(admin, 'POST', '/v1/inventory/locations', {
        code: `LOC-${token(8)}`,
        name: 'Typo warehouse',
        kind: 'warehouse',
      })
    ).id;
  }

  it('deletes a location nothing named, with its empty stock rows, for org_admin only', async () => {
    const id = await location();
    const product = await aProduct();
    await run(sql`
      insert into inventory.stock_levels (org_id, sku_id, location_id, reorder_level)
      values (${ORG_A}, ${product.skuId}, ${id}, 3)
    `);
    expect((await ok<Usage>(admin, 'GET', `/v1/inventory/locations/${id}/usage`)).canDelete).toBe(
      true,
    );
    expect((await call(marketing, 'DELETE', `/v1/inventory/locations/${id}`)).status).toBe(403);
    expect((await call(otherAdmin, 'DELETE', `/v1/inventory/locations/${id}`)).status).toBe(404);
    expect((await call(otherAdmin, 'GET', `/v1/inventory/locations/${id}/usage`)).status).toBe(404);
    await ok(admin, 'DELETE', `/v1/inventory/locations/${id}`);
    expect(await count(sql`select count(*)::text as n from org.locations where id = ${id}`)).toBe(
      0,
    );
    expect(
      await count(
        sql`select count(*)::text as n from inventory.stock_levels where location_id = ${id}`,
      ),
    ).toBe(0);
    expect(await deletedWithBefore(id, 'inventory.location.deleted')).toMatchObject({
      name: 'Typo warehouse',
    });
  });

  it('keeps a location that moved stock, refuses to switch it off while it holds any, and switches an empty one off and on', async () => {
    const id = await location();
    const product = await aProduct();
    const actor = { orgId: ORG_A, userId: 'usr_m39a_e2e' };
    await withOrg(actor, (tx) =>
      inventory.receiveSupply(tx, actor, {
        supplyId: randomUUID(),
        supplierId: randomUUID(),
        locationId: id,
        branchId: null,
        occurredAt: new Date(),
        lines: [{ skuId: product.skuId, qty: 2, unitCostPoisha: poisha(50_000) }],
      }),
    );
    const usage = await ok<Usage>(admin, 'GET', `/v1/inventory/locations/${id}/usage`);
    expect(reasons(usage)).toMatchObject({ stock_movements: 1, stock_on_hand: 1 });
    const refused = await call<{ code: string }>(admin, 'DELETE', `/v1/inventory/locations/${id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('INVENTORY_IN_USE');
    expect(
      (await call<{ code: string }>(admin, 'POST', `/v1/inventory/locations/${id}/archive`)).body
        .code,
    ).toBe('STOCK_LOCATION_INVALID');

    const empty = await location();
    await ok(admin, 'POST', `/v1/inventory/locations/${empty}/archive`);
    expect((await ok<Usage>(admin, 'GET', `/v1/inventory/locations/${empty}/usage`)).archived).toBe(
      true,
    );
    await ok(admin, 'POST', `/v1/inventory/locations/${empty}/restore`);
    expect((await ok<Usage>(admin, 'GET', `/v1/inventory/locations/${empty}/usage`)).archived).toBe(
      false,
    );
  });

  it('keeps a location the website sells from', async () => {
    const id = await location();
    await run(
      sql`insert into storefront.web_locations (org_id, location_id) values (${ORG_A}, ${id})`,
    );
    expect(
      reasons(await ok<Usage>(admin, 'GET', `/v1/inventory/locations/${id}/usage`)),
    ).toMatchObject({
      web_locations: 1,
    });
    expect((await call(admin, 'DELETE', `/v1/inventory/locations/${id}`)).status).toBe(409);
  });
});

describe('suppliers (D-630)', () => {
  it('deletes a duplicate supplier with its contacts, and keeps one that supplied', async () => {
    const duplicate = await ok<{ id: string }>(admin, 'POST', '/v1/supply/suppliers', {
      code: `DUP-${token(6)}`,
      name: 'Duplicate Mills',
    });
    await ok(admin, 'POST', `/v1/supply/suppliers/${duplicate.id}/contacts`, {
      name: 'Rahim',
      role: 'Sales',
    });
    expect((await call(accounts, 'DELETE', `/v1/supply/suppliers/${duplicate.id}`)).status).toBe(
      403,
    );
    expect((await call(otherAdmin, 'DELETE', `/v1/supply/suppliers/${duplicate.id}`)).status).toBe(
      404,
    );
    await ok(admin, 'DELETE', `/v1/supply/suppliers/${duplicate.id}`);
    expect(await deletedWithBefore(duplicate.id, 'supply.supplier.deleted')).toMatchObject({
      name: 'Duplicate Mills',
      contacts: [expect.objectContaining({ name: 'Rahim' })],
    });

    const real = await ok<{ id: string }>(admin, 'POST', '/v1/supply/suppliers', {
      code: `REAL-${token(6)}`,
      name: 'Real Mills',
    });
    const product = await aProduct();
    const warehouse = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ id: string }>(sql`
          select id from org.locations where org_id = ${ORG_A} and kind = 'warehouse' and is_active
          order by code limit 1
        `)
        )[0]?.id ?? '',
      { orgId: ORG_A },
    );
    await ok(admin, 'POST', '/v1/supply/drafts', {
      draftId: randomUUID(),
      supplierId: real.id,
      locationId: warehouse,
      lines: [{ skuId: product.skuId, qty: 1 }],
    });
    // Accounts may ask what names it (it deactivates suppliers), not delete it.
    const usage = await ok<Usage>(accounts, 'GET', `/v1/supply/suppliers/${real.id}/usage`);
    expect(reasons(usage)).toMatchObject({ supply_entries: 1 });
    const refused = await call<{ code: string }>(
      admin,
      'DELETE',
      `/v1/supply/suppliers/${real.id}`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('SUPPLY_IN_USE');
  });
});

describe('discounts (D-631)', () => {
  it('deletes a discount nobody used with its tiers, and keeps one an order names', async () => {
    const tiered = await ok<{ id: string }>(admin, 'POST', '/v1/promo/codes', {
      code: `TIER${token(6)}`,
      kind: 'tiered',
      tiers: [
        { minSubtotalPoisha: '100000', kind: 'percent', valueBps: 500 },
        { minSubtotalPoisha: '300000', kind: 'percent', valueBps: 1000 },
      ],
    });
    expect((await call(marketing, 'DELETE', `/v1/promo/codes/${tiered.id}`)).status).toBe(403);
    expect(
      (await ok<Usage>(marketing, 'GET', `/v1/promo/codes/${tiered.id}/usage`)).canDelete,
    ).toBe(true);
    await ok(admin, 'DELETE', `/v1/promo/codes/${tiered.id}`);
    expect(
      await count(
        sql`select count(*)::text as n from promo.discount_tiers where code_id = ${tiered.id}`,
      ),
    ).toBe(0);
    expect(await deletedWithBefore(tiered.id, 'promo.code.deleted')).toMatchObject({
      tiers: [expect.anything(), expect.anything()],
    });

    const used = await ok<{ id: string }>(admin, 'POST', '/v1/promo/codes', {
      code: `USED${token(6)}`,
      kind: 'percent',
      valueBps: 1000,
    });
    const customer = await seedCustomer(ORG_A, {
      phoneE164: '+8801711000321',
      name: 'Promo buyer',
    });
    const product = await aProduct();
    const order = await seedOrder(ORG_A, {
      customerId: customer,
      status: 'pending',
      lines: [
        { skuId: product.skuId, skuCode: 'X', productName: 'X', qty: 1, unitPricePoisha: 150_000n },
      ],
    });
    await run(sql`update sales.orders set promo_code_id = ${used.id} where id = ${order.id}`);
    expect(
      reasons(await ok<Usage>(admin, 'GET', `/v1/promo/codes/${used.id}/usage`)),
    ).toMatchObject({ orders: 1 });
    const refused = await call<{ code: string }>(admin, 'DELETE', `/v1/promo/codes/${used.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('PROMO_IN_USE');
  });

  it('brings an archived discount back paused, never straight to active', async () => {
    const code = await ok<{ id: string }>(admin, 'POST', '/v1/promo/codes', {
      code: `ARCH${token(6)}`,
      kind: 'percent',
      valueBps: 1000,
    });
    await ok(marketing, 'PATCH', `/v1/promo/codes/${code.id}`, { status: 'archived' });
    const straight = await call<{ code: string }>(
      marketing,
      'PATCH',
      `/v1/promo/codes/${code.id}`,
      {
        status: 'active',
      },
    );
    expect(straight.status).toBe(400);
    expect(straight.body.code).toBe('PROMO_INVALID');
    expect(
      (await ok<{ status: string }>(marketing, 'POST', `/v1/promo/codes/${code.id}/restore`))
        .status,
    ).toBe('paused');
  });
});

describe('flash sales (D-631)', () => {
  it('deletes a sale that sold nothing with its items; archives and restores one that sold', async () => {
    const product = await aProduct();
    const unsold = await ok<{ id: string }>(admin, 'POST', '/v1/promo/flash-sales', {
      title: 'Never ran',
      slug: `never-ran-${token(6).toLowerCase()}`,
      items: [{ skuId: product.skuId, salePricePoisha: '100000', unitLimit: 3 }],
    });
    await ok(admin, 'DELETE', `/v1/promo/flash-sales/${unsold.id}`);
    expect(
      await count(
        sql`select count(*)::text as n from promo.flash_sale_items where flash_sale_id = ${unsold.id}`,
      ),
    ).toBe(0);
    expect(await deletedWithBefore(unsold.id, 'promo.flash_sale.deleted')).toMatchObject({
      title: 'Never ran',
      items: [expect.objectContaining({ sku_id: product.skuId })],
    });

    const sold = await ok<{ id: string }>(admin, 'POST', '/v1/promo/flash-sales', {
      title: 'Sold out',
      slug: `sold-out-${token(6).toLowerCase()}`,
      items: [{ skuId: product.skuId, salePricePoisha: '100000', unitLimit: 3 }],
    });
    await run(
      sql`update promo.flash_sale_items set units_sold = 1 where flash_sale_id = ${sold.id}`,
    );
    const refused = await call<{ code: string }>(
      admin,
      'DELETE',
      `/v1/promo/flash-sales/${sold.id}`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('PROMO_IN_USE');

    await ok(marketing, 'POST', `/v1/promo/flash-sales/${sold.id}/archive`);
    const current = await ok<{ items: { id: string }[] }>(
      marketing,
      'GET',
      '/v1/promo/flash-sales',
    );
    expect(current.items.some((item) => item.id === sold.id)).toBe(false);
    const archived = await ok<{ items: { id: string; enabled: boolean }[] }>(
      marketing,
      'GET',
      '/v1/promo/flash-sales?archived=true',
    );
    expect(archived.items.find((item) => item.id === sold.id)?.enabled).toBe(false);
    expect(
      (await call(marketing, 'PATCH', `/v1/promo/flash-sales/${sold.id}`, { enabled: true }))
        .status,
    ).toBe(400);
    await ok(marketing, 'POST', `/v1/promo/flash-sales/${sold.id}/restore`);
    const back = await ok<{ items: { id: string }[] }>(marketing, 'GET', '/v1/promo/flash-sales');
    expect(back.items.some((item) => item.id === sold.id)).toBe(true);
  });
});

describe('SMS templates and ad campaigns (D-632)', () => {
  async function template(key: string, category = 'marketing'): Promise<string> {
    await ok(admin, 'PUT', '/v1/notify/templates', {
      key,
      category,
      bodyBn: 'হ্যালো {name}',
      bodyEn: 'Hello {name}',
    });
    const listed = await ok<{ items: { id: string; key: string }[] }>(
      admin,
      'GET',
      '/v1/notify/templates',
    );
    return listed.items.find((item) => item.key === key)?.id ?? '';
  }

  it('deletes a template that never went out; keeps a sent one and one the system sends', async () => {
    const unused = await template(`promo.eid_${token(4).toLowerCase()}`);
    expect((await call(marketing, 'DELETE', `/v1/notify/templates/${unused}`)).status).toBe(403);
    await ok(admin, 'DELETE', `/v1/notify/templates/${unused}`);
    expect(await deletedWithBefore(unused, 'notify.template.deleted')).toMatchObject({
      category: 'marketing',
    });

    const birthday = await template('occasion.birthday');
    expect(
      reasons(await ok<Usage>(marketing, 'GET', `/v1/notify/templates/${birthday}/usage`)),
    ).toMatchObject({
      system_template: 1,
    });
    expect((await call(admin, 'DELETE', `/v1/notify/templates/${birthday}`)).status).toBe(409);

    const key = `promo.sent_${token(4).toLowerCase()}`;
    const sent = await template(key);
    await run(sql`
      insert into notify.messages (org_id, template_key, category, phone, body, send_after)
      values (${ORG_A}, ${key}, 'marketing', '01700000999', 'Hello', now())
    `);
    const refused = await call<{ code: string }>(admin, 'DELETE', `/v1/notify/templates/${sent}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('NOTIFY_IN_USE');
  });

  it('deletes a campaign created by mistake with its refs; keeps one with spend or a discount', async () => {
    const mistake = await ok<{ id: string }>(admin, 'POST', '/v1/marketing/campaigns', {
      name: 'Mistake campaign',
      platform: 'other',
    });
    await ok(admin, 'POST', `/v1/marketing/campaigns/${mistake.id}/refs`, {
      kind: 'utm_campaign',
      value: `mistake-${token(6).toLowerCase()}`,
    });
    await ok(admin, 'DELETE', `/v1/marketing/campaigns/${mistake.id}`);
    expect(await deletedWithBefore(mistake.id, 'marketing.campaign.deleted')).toMatchObject({
      name: 'Mistake campaign',
      refs: [expect.objectContaining({ kind: 'utm_campaign' })],
    });

    const promoted = await ok<{ id: string }>(admin, 'POST', '/v1/marketing/campaigns', {
      name: 'Promoted campaign',
      platform: 'meta',
    });
    await ok(admin, 'POST', '/v1/promo/codes', {
      code: `CAMP${token(6)}`,
      kind: 'percent',
      valueBps: 500,
      campaignId: promoted.id,
    });
    expect(
      reasons(await ok<Usage>(marketing, 'GET', `/v1/marketing/campaigns/${promoted.id}/usage`)),
    ).toMatchObject({
      discounts: 1,
    });
    const refused = await call<{ code: string }>(
      admin,
      'DELETE',
      `/v1/marketing/campaigns/${promoted.id}`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('MARKETING_IN_USE');
  });
});

describe('the website: size charts and the menu (D-628)', () => {
  async function chart(name: string): Promise<string> {
    return (
      await ok<{ id: string }>(admin, 'POST', '/v1/storefront/size-charts', {
        name: `${name} ${token(4)}`,
        columns: ['Size', 'Chest'],
        rows: [['M', '40']],
      })
    ).id;
  }

  it('names the products on a chart, and empties it into another chart or none before deleting it', async () => {
    const old = await chart('Old chart');
    const replacement = await chart('New chart');
    const first = await aProduct();
    const second = await aProduct();
    for (const product of [first, second]) {
      await ok(admin, 'PUT', `/v1/storefront/products/${product.id}`, { sizeChartId: old });
    }
    const refused = await call<{ code: string; detail: string }>(
      admin,
      'DELETE',
      `/v1/storefront/size-charts/${old}`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('STOREFRONT_IN_USE');
    expect(refused.body.detail).toContain('Item');

    const usage = await ok<Usage>(marketing, 'GET', `/v1/storefront/size-charts/${old}/usage`);
    expect(usage).toMatchObject({ canDelete: false, canEmptyAndDelete: true });
    expect(usage.uses[0]?.examples.map((example) => example.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );

    await ok(marketing, 'POST', `/v1/storefront/size-charts/${old}/empty-and-delete`, {
      replacementId: replacement,
    });
    expect(
      await count(
        sql`select count(*)::text as n from catalog.products where size_chart_id = ${replacement}`,
      ),
    ).toBe(2);
    expect(
      await count(sql`select count(*)::text as n from storefront.size_charts where id = ${old}`),
    ).toBe(0);

    await ok(marketing, 'POST', `/v1/storefront/size-charts/${replacement}/empty-and-delete`, {
      replacementId: null,
    });
    expect(
      await count(
        sql`select count(*)::text as n from catalog.products where id in (${first.id}, ${second.id}) and size_chart_id is null`,
      ),
    ).toBe(2);
    expect(
      await deletedWithBefore(replacement, 'storefront.size_chart.emptied_and_deleted'),
    ).toMatchObject({
      columns: ['Size', 'Chest'],
    });

    const unused = await chart('Unused chart');
    await ok(admin, 'DELETE', `/v1/storefront/size-charts/${unused}`);
    expect(await deletedWithBefore(unused, 'storefront.size_chart.deleted')).toMatchObject({
      rows: [['M', '40']],
    });
  });

  it('says how many items go with a dropdown, and audits every item it deletes', async () => {
    const item = (body: Record<string, unknown>) =>
      ok<{ id: string }>(admin, 'POST', '/v1/storefront/nav-items', {
        parentId: null,
        kind: 'link',
        label: 'Link',
        href: '/shop',
        categoryId: null,
        highlighted: false,
        isActive: true,
        ...body,
      });
    const dropdown = await item({ kind: 'dropdown', label: 'More', href: null });
    await item({ parentId: dropdown.id, label: 'Sale', href: '/sale' });
    await item({ parentId: dropdown.id, label: 'New in', href: '/new' });
    const usage = await ok<{ children: number }>(
      marketing,
      'GET',
      `/v1/storefront/nav-items/${dropdown.id}/usage`,
    );
    expect(usage.children).toBe(2);
    await ok(marketing, 'DELETE', `/v1/storefront/nav-items/${dropdown.id}`);
    expect(await deletedWithBefore(dropdown.id, 'storefront.nav_item.deleted')).toMatchObject({
      label: 'More',
      children: [
        expect.objectContaining({ label: 'Sale' }),
        expect.objectContaining({ label: 'New in' }),
      ],
    });
  });
});

describe('branches: renamed and switched off, never deleted (D-633)', () => {
  async function branch(): Promise<string> {
    return withSystem(
      async (tx) =>
        (
          await tx.execute<{ id: string }>(sql`
            insert into org.branches (org_id, code, name, kind)
            values (${ORG_A}, ${`B${token(5)}`}, 'Test branch', 'showroom') returning id
          `)
        )[0]?.id ?? '',
      { orgId: ORG_A },
    );
  }

  it('switches off a branch where nothing runs, and refuses one with a till switched on', async () => {
    const quiet = await branch();
    expect((await call(accounts, 'PATCH', `/v1/pos/branches/${quiet}`, { name: 'X' })).status).toBe(
      403,
    );
    expect(
      (await call(otherAdmin, 'PATCH', `/v1/pos/branches/${quiet}`, { name: 'X' })).status,
    ).toBe(404);
    const holds = await ok<{ canDeactivate: boolean }>(
      admin,
      'GET',
      `/v1/pos/branches/${quiet}/holds`,
    );
    expect(holds.canDeactivate).toBe(true);
    await ok(admin, 'PATCH', `/v1/pos/branches/${quiet}`, { name: 'Renamed branch' });
    await ok(admin, 'PATCH', `/v1/pos/branches/${quiet}`, { isActive: false });
    await ok(admin, 'PATCH', `/v1/pos/branches/${quiet}`, { isActive: true });

    const busy = await branch();
    const location = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ id: string }>(sql`
            insert into org.locations (org_id, branch_id, code, name, kind)
            values (${ORG_A}, ${busy}, ${`L${token(6)}`}, 'Busy showroom', 'showroom') returning id
          `)
        )[0]?.id ?? '',
      { orgId: ORG_A },
    );
    const cash = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ id: string }>(sql`
            insert into ledger.accounts (org_id, code, name, class, subtype, normal_balance, branch_id)
            values (${ORG_A}, ${`1010-${token(5)}`}, 'Busy hand cash', 'asset', 'wallet_cash', 'debit', ${busy})
            returning id
          `)
        )[0]?.id ?? '',
      { orgId: ORG_A },
    );
    const wallet = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ id: string }>(sql`
            insert into wallets.wallets (org_id, ledger_account_id, branch_id)
            values (${ORG_A}, ${cash}, ${busy}) returning id
          `)
        )[0]?.id ?? '',
      { orgId: ORG_A },
    );
    const bank = await seedWallet(ORG_A, '1100', { provider: 'Bank' });
    const manager = await harness.asRole('branch_manager', ORG_A, { branchIds: [busy] });
    await ok(manager, 'POST', '/v1/pos/registers', {
      branchId: busy,
      locationId: location,
      code: `R${token(3)}`,
      name: 'Busy till',
      cashWalletId: wallet,
      cardWalletId: bank.id,
    });
    const held = await ok<{ canDeactivate: boolean; holds: { registers: number } }>(
      admin,
      'GET',
      `/v1/pos/branches/${busy}/holds`,
    );
    expect(held).toMatchObject({ canDeactivate: false, holds: { registers: 1 } });
    const refused = await call<{ code: string }>(admin, 'PATCH', `/v1/pos/branches/${busy}`, {
      isActive: false,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('BRANCH_IN_USE');
  });
});

describe('expense and income heads (D-634)', () => {
  it('adds, renames, archives and restores a head; the standard heads stay; nothing is deleted', async () => {
    const head = await ok<{ id: string; code: string }>(accounts, 'POST', '/v1/accounts/heads', {
      name: 'Electricity',
      kind: 'expense',
    });
    expect(head.code).toMatch(/^59\d\d$/);
    const income = await ok<{ code: string }>(admin, 'POST', '/v1/accounts/heads', {
      name: 'Scrap sale',
      kind: 'income',
    });
    expect(income.code).toMatch(/^45\d\d$/);

    await ok(accounts, 'PATCH', `/v1/accounts/heads/${head.id}`, { name: 'Electricity bill' });
    await ok(accounts, 'PATCH', `/v1/accounts/heads/${head.id}`, { isActive: false });
    const picker = await ok<{ items: { id: string }[] }>(
      accounts,
      'GET',
      '/v1/accounts/categories',
    );
    expect(picker.items.some((item) => item.id === head.id)).toBe(false);
    await ok(accounts, 'PATCH', `/v1/accounts/heads/${head.id}`, { isActive: true });
    const again = await ok<{ items: { id: string }[] }>(accounts, 'GET', '/v1/accounts/categories');
    expect(again.items.some((item) => item.id === head.id)).toBe(true);

    const heads = await ok<{ items: { id: string; code: string; isSystem: boolean }[] }>(
      accounts,
      'GET',
      '/v1/accounts/heads',
    );
    const rent = heads.items.find((item) => item.code === '5800');
    expect(rent?.isSystem).toBe(true);
    const refused = await call<{ code: string }>(
      accounts,
      'PATCH',
      `/v1/accounts/heads/${rent?.id ?? ''}`,
      {
        name: 'Shop rent',
      },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('LEDGER_ACCOUNT_INVALID');

    expect((await call(sales, 'GET', '/v1/accounts/heads')).status).toBe(403);
    expect((await call(admin, 'DELETE', `/v1/accounts/heads/${head.id}`)).status).toBe(404);
    expect(
      await count(sql`select count(*)::text as n from ledger.accounts where id = ${head.id}`),
    ).toBe(1);
  });
});
