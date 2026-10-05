import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  COST_FIELDS,
  defineAbilityFor,
  findCostFields,
  serializeForStorefront,
  STOREFRONT_VISIBLE_FIELDS,
} from './permissions/index.js';
import {
  isSiteLink,
  navItemSchema,
  paymentMethodsSchema,
  productWebFieldsSchema,
  shippingRuleSchema,
  sizeChartSchema,
  storefrontSettingsPatchSchema,
} from './storefront.js';

describe('serializeForStorefront', () => {
  it('keeps every allowed key at every depth and drops everything else', () => {
    const out = serializeForStorefront({
      items: [
        {
          id: 'p',
          name: 'Shirt',
          internalNote: 'x',
          price: { min: { poisha: '100', taka: '1.00' }, secret: 'y' },
          variants: [{ skuId: 's', availableQty: 3, wacPoisha: '5', locationId: 'l' }],
          tags: ['a', 'b'],
        },
      ],
      nextCursor: null,
      debug: { sql: 'select' },
    });
    expect(out).toEqual({
      items: [
        {
          id: 'p',
          name: 'Shirt',
          price: { min: { poisha: '100', taka: '1.00' } },
          variants: [{ skuId: 's', availableQty: 3 }],
          tags: ['a', 'b'],
        },
      ],
      nextCursor: null,
    });
  });

  it('keeps a size chart’s grid of strings', () => {
    const chart = {
      sizeChart: { id: 'c', name: 'Shirts', columns: ['Size'], rows: [['M'], ['L']] },
    };
    expect(serializeForStorefront(chart)).toEqual(chart);
  });

  it('lists no cost field, and no cost field survives wherever it is put', () => {
    for (const field of COST_FIELDS) {
      expect(STOREFRONT_VISIBLE_FIELDS as readonly string[]).not.toContain(field);
    }
    const allowed = fc.constantFrom(...STOREFRONT_VISIBLE_FIELDS);
    const cost = fc.constantFrom(...COST_FIELDS);
    const leaf = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null));
    const { tree } = fc.letrec((tie) => ({
      tree: fc.oneof(
        { depthSize: 'small' },
        leaf,
        fc.array(tie('tree'), { maxLength: 3 }),
        fc.dictionary(fc.oneof(allowed, cost, fc.string()), tie('tree'), { maxKeys: 4 }),
      ),
    }));
    fc.assert(
      fc.property(tree, (payload) => {
        expect(findCostFields(serializeForStorefront(payload))).toEqual([]);
      }),
    );
  });

  it('does not mutate its input', () => {
    const input = { id: 'p', wacPoisha: '9' };
    serializeForStorefront(input);
    expect(input).toEqual({ id: 'p', wacPoisha: '9' });
  });
});

describe('the Storefront subject', () => {
  const can = (role: 'org_admin' | 'marketing' | 'sales' | 'accounts' | 'warehouse') =>
    defineAbilityFor({
      roles: [role],
      isSuperAdmin: false,
      userId: 'u',
      branchIds: [],
      branchIdsByRole: { [role]: [] },
    });

  it('is managed by org_admin and marketing, read by sales, closed to the rest', () => {
    for (const role of ['org_admin', 'marketing'] as const) {
      for (const action of ['read', 'create', 'update', 'delete'] as const) {
        expect(can(role).can(action, 'Storefront')).toBe(true);
      }
    }
    expect(can('sales').can('read', 'Storefront')).toBe(true);
    expect(can('sales').can('update', 'Storefront')).toBe(false);
    expect(can('accounts').can('read', 'Storefront')).toBe(false);
    expect(can('warehouse').can('read', 'Storefront')).toBe(false);
  });
});

describe('the storefront schemas', () => {
  it('accepts site paths and https links only', () => {
    expect(isSiteLink('/shop')).toBe(true);
    expect(isSiteLink('https://example.com')).toBe(true);
    for (const bad of ['javascript:alert(1)', '//evil.example', 'http://x.example', ' /a']) {
      expect(isSiteLink(bad)).toBe(false);
    }
  });

  it('refuses a checkout with no way to pay', () => {
    expect(paymentMethodsSchema.safeParse({ cod: false, sslcommerz: false }).success).toBe(false);
    expect(paymentMethodsSchema.safeParse({ cod: true, sslcommerz: false }).success).toBe(true);
  });

  it('takes money as poisha strings', () => {
    const zone = { feePoisha: '6000', deliveryZoneIds: [] };
    const rule = {
      freeShippingEnabled: true,
      freeShippingThresholdPoisha: '150000',
      zones: { inside_dhaka: zone, suburbs: zone, outside_dhaka: zone },
    };
    expect(shippingRuleSchema.safeParse(rule).success).toBe(true);
    expect(
      shippingRuleSchema.safeParse({ ...rule, freeShippingThresholdPoisha: 1500 }).success,
    ).toBe(false);
    expect(
      shippingRuleSchema.safeParse({ ...rule, freeShippingThresholdPoisha: '15.00' }).success,
    ).toBe(false);
  });

  it('requires a link on a link item, a category on a category item', () => {
    const base = { parentId: null, label: 'Sale', highlighted: false, isActive: true };
    expect(
      navItemSchema.safeParse({ ...base, kind: 'link', href: null, categoryId: null }).success,
    ).toBe(false);
    expect(
      navItemSchema.safeParse({ ...base, kind: 'category', href: null, categoryId: null }).success,
    ).toBe(false);
    expect(
      navItemSchema.safeParse({ ...base, kind: 'link', href: '/sale', categoryId: null }).success,
    ).toBe(true);
  });

  it('refuses a ragged size chart and an empty patch', () => {
    expect(
      sizeChartSchema.safeParse({ name: 'S', columns: ['Size', 'Chest'], rows: [['M']] }).success,
    ).toBe(false);
    expect(storefrontSettingsPatchSchema.safeParse({}).success).toBe(false);
    expect(productWebFieldsSchema.safeParse({}).success).toBe(false);
    expect(productWebFieldsSchema.safeParse({ unitCostPoisha: '1' }).success).toBe(false);
  });
});
