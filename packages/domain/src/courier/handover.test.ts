import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ORDER_STATUSES, transitionFor, type OrderStatus } from '../orders/state.js';
import {
  courierTriggersFor,
  LEFT_THE_MERCHANT,
  orderTriggerFor,
  PARCEL_STATUSES,
  type ParcelStatus,
} from './index.js';

/**
 * A courier status ships an order the warehouse never marked shipped (D-390).
 *
 * §9 performs `ship` at the "handover to courier". Until this, only a person could perform
 * it, so an order whose parcel the courier picked up — or delivered — stayed `confirmed` or
 * `packed`, and the delivery was recorded and ignored. These tests pin the two halves: which
 * statuses prove the parcel left, and that every sequence produced is a walk through §9's own
 * table that a duplicate of the same status cannot extend.
 */

const parcelStatus = fc.constantFrom(...PARCEL_STATUSES);
const orderStatus = fc.constantFrom(...ORDER_STATUSES);

describe('the handover, on the courier’s word', () => {
  it('ships a confirmed or packed order for every status that proves the parcel left', () => {
    for (const from of ['confirmed', 'packed'] as const) {
      for (const status of LEFT_THE_MERCHANT) {
        expect(orderTriggerFor(status, from)).toBe('ship');
        expect(courierTriggersFor(status, from)[0]).toBe('ship');
      }
    }
  });

  it('then applies what the same status means from shipped, in the same breath', () => {
    expect(courierTriggersFor('picked_up', 'packed')).toEqual(['ship']);
    expect(courierTriggersFor('in_transit', 'confirmed')).toEqual(['ship']);
    expect(courierTriggersFor('out_for_delivery', 'packed')).toEqual(['ship']);
    expect(courierTriggersFor('delivered', 'packed')).toEqual(['ship', 'deliver']);
    expect(courierTriggersFor('delivered', 'confirmed')).toEqual(['ship', 'deliver']);
    expect(courierTriggersFor('partial_delivered', 'packed', { collectedKnown: true })).toEqual([
      'ship',
      'deliver_partially',
    ]);
    expect(courierTriggersFor('return_in_transit', 'packed')).toEqual(['ship', 'start_return']);
    expect(courierTriggersFor('returned_to_merchant', 'packed')).toEqual(['ship', 'start_return']);
  });

  it('ships but does not guess a partial collection the courier did not report (M15)', () => {
    expect(courierTriggersFor('partial_delivered', 'packed', { collectedKnown: false })).toEqual([
      'ship',
    ]);
  });

  it('moves nothing before shipment on a status that does not prove the parcel left', () => {
    const notProof: readonly ParcelStatus[] = [
      'booked',
      'pickup_pending',
      'hold',
      'cancelled',
      'unknown',
    ];
    for (const from of ['confirmed', 'packed'] as const) {
      for (const status of notProof) {
        expect(courierTriggersFor(status, from)).toEqual([]);
      }
    }
  });

  it('never moves a pending order or one on hold', () => {
    fc.assert(
      fc.property(parcelStatus, fc.boolean(), (status, known) => {
        for (const from of ['pending', 'on_hold'] as const) {
          expect(courierTriggersFor(status, from, { collectedKnown: known })).toEqual([]);
        }
      }),
    );
  });

  it('answers exactly as before once the order has shipped', () => {
    fc.assert(
      fc.property(parcelStatus, fc.boolean(), (status, known) => {
        const single = orderTriggerFor(status, 'shipped', { collectedKnown: known });
        expect(courierTriggersFor(status, 'shipped', { collectedKnown: known })).toEqual(
          single === null ? [] : [single],
        );
      }),
    );
  });
});

describe('every sequence is a walk through §9’s table', () => {
  it('is at most two steps, each a row of the machine, never a cancel or a received return', () => {
    fc.assert(
      fc.property(parcelStatus, orderStatus, fc.boolean(), (status, from, known) => {
        const triggers = courierTriggersFor(status, from, { collectedKnown: known });
        expect(triggers.length).toBeLessThanOrEqual(2);
        let at: OrderStatus = from;
        for (const trigger of triggers) {
          expect(trigger).not.toBe('cancel');
          expect(trigger).not.toBe('receive_return');
          const row = transitionFor(at, trigger);
          expect(row, `${at} --${trigger}-->`).toBeDefined();
          at = row?.to ?? at;
        }
      }),
    );
  });

  it('cannot be extended by the same status arriving again (check 3’s second layer)', () => {
    fc.assert(
      fc.property(parcelStatus, orderStatus, fc.boolean(), (status, from, known) => {
        let at: OrderStatus = from;
        for (const trigger of courierTriggersFor(status, from, { collectedKnown: known })) {
          at = transitionFor(at, trigger)?.to ?? at;
        }
        expect(courierTriggersFor(status, at, { collectedKnown: known })).toEqual([]);
      }),
    );
  });
});
