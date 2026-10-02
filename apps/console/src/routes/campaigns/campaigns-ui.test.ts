import { describe, expect, it } from 'vitest';

import { checkPromoForm, offerParts, percentToBps, type PromoFormValues } from './promo-form.js';

const blank: PromoFormValues = {
  code: 'EID25',
  kind: 'percent',
  percent: '10',
  amount: '',
  minOrder: '',
  maxDiscount: '',
  totalLimit: '',
  perCustomerLimit: '',
  validFrom: '',
  validTo: '',
  channels: [],
};

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

describe('checkPromoForm', () => {
  it('sends only what was filled in', () => {
    expect(checkPromoForm(blank)).toEqual({
      ok: true,
      body: { code: 'EID25', kind: 'percent', valueBps: 1000 },
    });
  });

  it('turns taka into poisha and keeps a percent code’s cap', () => {
    const result = checkPromoForm({
      ...blank,
      minOrder: '1,500',
      maxDiscount: '200.50',
      totalLimit: '100',
      perCustomerLimit: '1',
      validFrom: '2026-10-01',
      validTo: '2026-10-31',
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
        validFrom: '2026-10-01',
        validTo: '2026-10-31',
        channels: ['facebook'],
      },
    });
  });

  it('needs an amount for a flat code, and sends no rate or cap with it', () => {
    expect(checkPromoForm({ ...blank, kind: 'flat', amount: '' })).toMatchObject({
      ok: false,
      errors: { amount: 'campaigns.codes.form.invalidAmount' },
    });
    expect(checkPromoForm({ ...blank, kind: 'flat', amount: '150', maxDiscount: '50' })).toEqual({
      ok: true,
      body: { code: 'EID25', kind: 'flat', valuePoisha: '15000' },
    });
  });

  it('needs nothing but a code for free delivery', () => {
    expect(checkPromoForm({ ...blank, kind: 'free_delivery', percent: '' })).toEqual({
      ok: true,
      body: { code: 'EID25', kind: 'free_delivery' },
    });
  });

  it('names every field that is wrong, at once', () => {
    const result = checkPromoForm({
      ...blank,
      code: 'x',
      percent: '150',
      totalLimit: '0',
      perCustomerLimit: '1.5',
      validFrom: '2026-10-31',
      validTo: '2026-10-01',
    });
    expect(result).toEqual({
      ok: false,
      errors: {
        code: 'campaigns.codes.form.invalidCode',
        percent: 'campaigns.codes.form.invalidPercent',
        totalLimit: 'campaigns.codes.form.invalidCount',
        perCustomerLimit: 'campaigns.codes.form.invalidCount',
        validTo: 'campaigns.codes.form.invalidWindow',
      },
    });
  });
});

describe('offerParts', () => {
  it('reads a rate back the way it was typed', () => {
    expect(offerParts({ kind: 'percent', valueBps: 1000, valuePoisha: null })).toEqual({
      percent: '10%',
    });
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
  });
});
