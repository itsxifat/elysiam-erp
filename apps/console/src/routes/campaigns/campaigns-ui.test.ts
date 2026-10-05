import { describe, expect, it } from 'vitest';

import { dhakaLocalToIso, isoToDhakaLocal } from './dhaka-time.js';
import {
  checkDiscountForm,
  EMPTY_DISCOUNT,
  offerParts,
  percentToBps,
  type DiscountFormValues,
} from './discount-form.js';
import { checkFlashForm, EMPTY_FLASH, percentOff, type FlashItemValues } from './flash-form.js';

const blank: DiscountFormValues = { ...EMPTY_DISCOUNT, code: 'EID25', percent: '10' };

describe('percentToBps', () => {
  it.each([
    ['10', 1000],
    ['12.5', 1250],
    ['0.29', 29],
    ['0.01', 1],
    ['100', 10_000],
  ])('reads %s as %d basis points, without floating point', (input, bps) => {
    expect(percentToBps(input)).toBe(bps);
  });

  it.each(['0', '100.01', '101', '-5', '12.345', 'ten', ''])('refuses %j', (input) => {
    expect(percentToBps(input)).toBeNull();
  });
});

describe('checkDiscountForm: M16 codes send what they sent before', () => {
  it('sends only what was filled in', () => {
    expect(checkDiscountForm(blank)).toEqual({
      ok: true,
      body: { code: 'EID25', kind: 'percent', valueBps: 1000 },
    });
  });

  it('turns taka into poisha and keeps a percent code’s cap', () => {
    const result = checkDiscountForm({
      ...blank,
      minOrder: '1,500',
      maxDiscount: '200.50',
      totalLimit: '100',
      perCustomerLimit: '1',
      channels: ['facebook'],
    });
    expect(result).toEqual({
      ok: true,
      body: {
        code: 'EID25',
        kind: 'percent',
        valueBps: 1000,
        minOrderPoisha: '150000',
        maxDiscountPoisha: '20050',
        totalLimit: 100,
        perCustomerLimit: 1,
        channels: ['facebook'],
      },
    });
  });

  it('needs an amount for a flat code, and sends no rate or cap with it', () => {
    expect(checkDiscountForm({ ...blank, kind: 'flat', amount: '' })).toMatchObject({
      ok: false,
      errors: { amount: 'campaigns.codes.form.invalidAmount' },
    });
    expect(checkDiscountForm({ ...blank, kind: 'flat', amount: '150', maxDiscount: '50' })).toEqual(
      { ok: true, body: { code: 'EID25', kind: 'flat', valuePoisha: '15000' } },
    );
  });

  it('needs nothing but a code for free delivery', () => {
    expect(checkDiscountForm({ ...blank, kind: 'free_delivery', percent: '' })).toEqual({
      ok: true,
      body: { code: 'EID25', kind: 'free_delivery' },
    });
  });

  it('names every field that is wrong, at once', () => {
    const result = checkDiscountForm({
      ...blank,
      code: 'x',
      percent: '150',
      totalLimit: '0',
      perCustomerLimit: '1.5',
      startsAt: '2026-10-31T10:00',
      endsAt: '2026-10-01T10:00',
    });
    expect(result).toEqual({
      ok: false,
      errors: {
        code: 'campaigns.codes.form.invalidCode',
        percent: 'campaigns.codes.form.invalidPercent',
        totalLimit: 'campaigns.codes.form.invalidCount',
        perCustomerLimit: 'campaigns.codes.form.invalidCount',
        endsAt: 'campaigns.codes.form.invalidWindow',
      },
    });
  });
});

describe('checkDiscountForm: M35a kinds (D-541)', () => {
  it('sends an automatic discount with a title and no code', () => {
    expect(
      checkDiscountForm({ ...blank, method: 'automatic', code: '', title: ' Puja week ' }),
    ).toEqual({
      ok: true,
      body: { method: 'automatic', title: 'Puja week', kind: 'percent', valueBps: 1000 },
    });
    expect(checkDiscountForm({ ...blank, method: 'automatic', code: '' })).toMatchObject({
      ok: false,
      errors: { title: 'campaigns.discounts.form.titleRequired' },
    });
  });

  it('sends buy X get Y, leaving out a free unit’s 100%', () => {
    expect(
      checkDiscountForm({ ...blank, kind: 'buy_x_get_y', buyQuantity: '2', getQuantity: '1' }),
    ).toEqual({
      ok: true,
      body: { code: 'EID25', kind: 'buy_x_get_y', buyQuantity: 2, getQuantity: 1 },
    });
    expect(checkDiscountForm({ ...blank, kind: 'buy_x_get_y', getPercent: '50' })).toMatchObject({
      ok: true,
      body: { getDiscountBps: 5000 },
    });
  });

  it('sends tiers in poisha and basis points, and names a bad tier', () => {
    const tiers = [
      { minSubtotal: '2,000', kind: 'percent' as const, value: '5' },
      { minSubtotal: '5000', kind: 'flat' as const, value: '500' },
    ];
    expect(checkDiscountForm({ ...blank, kind: 'tiered', tiers })).toEqual({
      ok: true,
      body: {
        code: 'EID25',
        kind: 'tiered',
        tiers: [
          { minSubtotalPoisha: '200000', kind: 'percent', valueBps: 500 },
          { minSubtotalPoisha: '500000', kind: 'flat', valuePoisha: '50000' },
        ],
      },
    });
    expect(
      checkDiscountForm({
        ...blank,
        kind: 'tiered',
        tiers: [...tiers, { minSubtotal: '', kind: 'percent', value: '5' }],
      }),
    ).toMatchObject({ ok: false, errors: { tier2: 'campaigns.discounts.form.invalidTier' } });
  });

  it('sends the scope, the conditions, the window in Dhaka time, stacking and priority', () => {
    expect(
      checkDiscountForm({
        ...blank,
        scope: 'categories',
        categoryIds: ['cat-1'],
        minQuantity: '3',
        firstOrderOnly: true,
        startsAt: '2026-10-20T21:00',
        endsAt: '2026-10-25T23:59',
        allowStacking: true,
        priority: '5',
      }),
    ).toEqual({
      ok: true,
      body: {
        code: 'EID25',
        kind: 'percent',
        valueBps: 1000,
        categoryIds: ['cat-1'],
        minQuantity: 3,
        firstOrderOnly: true,
        startsAt: '2026-10-20T15:00:00.000Z',
        endsAt: '2026-10-25T17:59:00.000Z',
        allowStacking: true,
        priority: 5,
      },
    });
    expect(checkDiscountForm({ ...blank, scope: 'products' })).toMatchObject({
      ok: false,
      errors: { scope: 'campaigns.discounts.form.scopeRequired' },
    });
  });
});

describe('offerParts', () => {
  it('reads every kind back the way it was set', () => {
    expect(offerParts({ kind: 'percent', valueBps: 1250, valuePoisha: null })).toEqual({
      percent: '12.5%',
    });
    expect(offerParts({ kind: 'percent', valueBps: 29, valuePoisha: null })).toEqual({
      percent: '0.29%',
    });
    expect(offerParts({ kind: 'flat', valueBps: null, valuePoisha: '15000' })).toEqual({
      poisha: '15000',
    });
    expect(offerParts({ kind: 'free_delivery', valueBps: null, valuePoisha: null })).toEqual({
      freeDelivery: true,
    });
    expect(
      offerParts({
        kind: 'buy_x_get_y',
        valueBps: null,
        valuePoisha: null,
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountBps: 10_000,
      }),
    ).toEqual({ buy: 2, get: 1, getPercent: '100%' });
    expect(offerParts({ kind: 'tiered', valueBps: null, valuePoisha: null, tiers: [] })).toEqual({
      tiers: 0,
    });
  });
});

describe('Dhaka wall time (D-545)', () => {
  it('reads datetime-local text as +06:00 whatever the browser zone', () => {
    expect(dhakaLocalToIso('2026-10-05T21:00')).toBe('2026-10-05T15:00:00.000Z');
    expect(dhakaLocalToIso('2026-10-06T03:00')).toBe('2026-10-05T21:00:00.000Z');
    expect(isoToDhakaLocal('2026-10-05T21:00:00.000Z')).toBe('2026-10-06T03:00');
    expect(isoToDhakaLocal(null)).toBe('');
  });

  it('refuses a date that does not exist', () => {
    expect(dhakaLocalToIso('2026-02-31T10:00')).toBeNull();
    expect(dhakaLocalToIso('tomorrow')).toBeNull();
  });
});

describe('checkFlashForm (D-542)', () => {
  const item: FlashItemValues = {
    skuId: 'sku-1',
    skuCode: 'ELY-1',
    productName: 'Panjabi',
    variantLabel: 'M',
    shelfPricePoisha: '150000',
    salePrice: '1,199',
    allStock: false,
    limit: '5',
    unitsSold: 2,
  };

  it('sends prices in poisha, a limit or all stock, and the window in Dhaka time', () => {
    expect(
      checkFlashForm({
        ...EMPTY_FLASH,
        title: ' Eid flash ',
        enabled: true,
        startsAt: '2026-10-20T20:00',
        items: [item, { ...item, skuId: 'sku-2', allStock: true, limit: '' }],
      }),
    ).toEqual({
      ok: true,
      body: {
        title: 'Eid flash',
        subtitle: '',
        description: '',
        bannerFileId: null,
        enabled: true,
        showOnHome: true,
        priority: 0,
        startsAt: '2026-10-20T14:00:00.000Z',
        endsAt: null,
        items: [
          { skuId: 'sku-1', salePricePoisha: '119900', unitLimit: 5 },
          { skuId: 'sku-2', salePricePoisha: '119900', unitLimit: null },
        ],
      },
    });
  });

  it('refuses a price not below the shelf, a limit below what sold, and switching on nothing', () => {
    const result = checkFlashForm({
      ...EMPTY_FLASH,
      title: 'Sale',
      slug: 'Bad Slug',
      items: [
        { ...item, salePrice: '1500' },
        { ...item, skuId: 'sku-2', limit: '1' },
      ],
    });
    expect(result).toEqual({
      ok: false,
      errors: {
        fields: { slug: 'campaigns.flash.form.invalidSlug' },
        items: {
          'sku-1': 'campaigns.flash.form.priceNotBelow',
          'sku-2': 'campaigns.flash.form.limitBelowSold',
        },
      },
    });
    expect(checkFlashForm({ ...EMPTY_FLASH, title: 'Sale', enabled: true })).toMatchObject({
      ok: false,
      errors: { fields: { enabled: 'campaigns.flash.form.nothingOnSale' } },
    });
  });

  it('shows the percent off as a whole number, and nothing for no discount', () => {
    expect(percentOff('150000', '1,200')).toBe(20);
    expect(percentOff('150000', '1500')).toBeNull();
    expect(percentOff('150000', 'abc')).toBeNull();
  });
});
