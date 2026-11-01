import { describe, expect, it } from 'vitest';

import { deliveredFromLots } from './order-actions-logic.js';

/** A partial delivery fills its quantities from the lots that were delivered (M53, D-948). */
describe('deliveredFromLots', () => {
  const lines = [
    { skuId: 'shirt', qty: 3 },
    { skuId: 'cap', qty: 1 },
  ];
  const lots = [
    {
      lot: 1,
      items: [
        { skuId: 'shirt', qty: 2 },
        { skuId: 'cap', qty: 1 },
      ],
    },
    { lot: 2, items: [{ skuId: 'shirt', qty: 1 }] },
  ];

  it('gives each line what the chosen lots hold, and nothing for what they do not', () => {
    expect(deliveredFromLots(lots, new Set([1]), lines)).toEqual({ shirt: '2', cap: '1' });
    expect(deliveredFromLots(lots, new Set([2]), lines)).toEqual({ shirt: '1', cap: '0' });
  });

  it('adds lots up, and choosing none delivers nothing', () => {
    expect(deliveredFromLots(lots, new Set([1, 2]), lines)).toEqual({ shirt: '3', cap: '1' });
    expect(deliveredFromLots(lots, new Set(), lines)).toEqual({ shirt: '0', cap: '0' });
  });

  it('never gives more than the order has, if the order was edited after packing', () => {
    const edited = [{ skuId: 'shirt', qty: 1 }];
    expect(deliveredFromLots(lots, new Set([1, 2]), edited)).toEqual({ shirt: '1' });
  });
});
