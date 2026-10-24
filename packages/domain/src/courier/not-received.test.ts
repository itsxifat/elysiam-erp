import { describe, expect, it } from 'vitest';

import {
  courierHadParcel,
  notReceivedByCourier,
  PATHAO_STATUS_MAP,
  STEADFAST_STATUS_MAP,
} from './index.js';

/**
 * A parcel the courier never received (D-903), and the parcels that only look like one: a
 * parcel taken and later held (a failed delivery, a cancellation waiting for approval), and a
 * Steadfast parcel whose `pending` was stored as `pickup_pending` before D-902.
 */

const HANDED = new Date('2026-10-24T08:00:00Z');
const at = (hours: number) => new Date(HANDED.getTime() + hours * 3_600_000);

describe('the courier had the parcel', () => {
  it('when it says so now, or ever said a word that proves it', () => {
    expect(courierHadParcel({ status: 'picked_up', map: STEADFAST_STATUS_MAP, events: [] })).toBe(
      true,
    );
    // Taken, then held by the courier: Steadfast's cancellation awaiting approval.
    expect(
      courierHadParcel({
        status: 'hold',
        map: STEADFAST_STATUS_MAP,
        events: [
          { status: 'hold', rawStatus: 'in_review' },
          { status: 'picked_up', rawStatus: 'pending' },
          { status: 'hold', rawStatus: 'cancelled_approval_pending' },
        ],
      }),
    ).toBe(true);
    // A Pathao delivery attempt that failed, after pickup.
    expect(
      courierHadParcel({
        status: 'hold',
        map: PATHAO_STATUS_MAP,
        events: [
          { status: 'in_transit', rawStatus: null },
          { status: 'hold', rawStatus: null },
        ],
      }),
    ).toBe(true);
  });

  it('reads an old word through today’s vocabulary: Steadfast `pending` stored before D-902', () => {
    expect(
      courierHadParcel({
        status: 'hold',
        map: STEADFAST_STATUS_MAP,
        events: [{ status: 'pickup_pending', rawStatus: 'pending' }],
      }),
    ).toBe(true);
  });

  it('not while it has said only in_review', () => {
    expect(
      courierHadParcel({
        status: 'hold',
        map: STEADFAST_STATUS_MAP,
        events: [{ status: 'hold', rawStatus: 'in_review' }],
      }),
    ).toBe(false);
  });
});

describe('not received by the courier', () => {
  const missing = {
    bookingState: 'booked',
    status: 'hold' as const,
    handedOverAt: HANDED,
    courierHadIt: false,
    hours: 5,
  };

  it('from the brand’s hours after the handover, not before', () => {
    expect(notReceivedByCourier({ ...missing, now: at(4.9) })).toBe(false);
    expect(notReceivedByCourier({ ...missing, now: at(5) })).toBe(true);
  });

  it('never for a parcel the courier had, one never handed over, or one not booked', () => {
    expect(notReceivedByCourier({ ...missing, courierHadIt: true, now: at(30) })).toBe(false);
    expect(notReceivedByCourier({ ...missing, handedOverAt: null, now: at(30) })).toBe(false);
    expect(notReceivedByCourier({ ...missing, bookingState: 'failed', now: at(30) })).toBe(false);
    expect(notReceivedByCourier({ ...missing, status: 'in_transit', now: at(30) })).toBe(false);
  });
});
