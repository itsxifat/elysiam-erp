import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  deliveryRisk,
  deliverySuccessPercent,
  DELIVERY_RISK_RULES,
  type DeliveryRecord,
} from './delivery-record.js';

const record = (overrides: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  delivered: 0,
  cancelled: 0,
  reports: 0,
  reportReasons: [],
  volumeBand: null,
  volumeRange: null,
  doubtfulReports: false,
  courierLevel: null,
  ...overrides,
});

describe('a delivery record (D-918)', () => {
  it('rounds the success rate half up, and has none without parcels', () => {
    expect(deliverySuccessPercent({ delivered: 15, cancelled: 47 })).toBe(24);
    expect(deliverySuccessPercent({ delivered: 1, cancelled: 1 })).toBe(50);
    expect(deliverySuccessPercent({ delivered: 1, cancelled: 7 })).toBe(13);
    expect(deliverySuccessPercent({ delivered: 0, cancelled: 0 })).toBeNull();
  });

  it('reads Steadfast’s own example the way a person would', () => {
    // 15 delivered, 47 cancelled, 24 reports: the shape `fraud_check/score` answered.
    expect(deliveryRisk(record({ delivered: 15, cancelled: 47, reports: 24 }))).toBe('risky');
    expect(deliveryRisk(record())).toBe('new');
    expect(deliveryRisk(record({ delivered: 9, cancelled: 1 }))).toBe('good');
    expect(deliveryRisk(record({ delivered: 9, cancelled: 1, reports: 1 }))).toBe('caution');
    expect(deliveryRisk(record({ delivered: 3, cancelled: 2 }))).toBe('caution');
    expect(deliveryRisk(record({ delivered: 1, cancelled: 3 }))).toBe('risky');
  });

  it('never calls one or two cancelled parcels risky on the rate alone', () => {
    expect(deliveryRisk(record({ cancelled: 1 }))).toBe('caution');
    expect(deliveryRisk(record({ cancelled: 2 }))).toBe('caution');
  });

  it('is Good only with no report and four in five delivered, and Risky at three reports', () => {
    fc.assert(
      fc.property(fc.nat(500), fc.nat(500), fc.nat(10), (delivered, cancelled, reports) => {
        const value = record({ delivered, cancelled, reports });
        const risk = deliveryRisk(value);
        const success = deliverySuccessPercent(value);
        if (risk === 'good') {
          expect(reports).toBe(0);
          expect(success).not.toBeNull();
          expect(success ?? 0).toBeGreaterThanOrEqual(DELIVERY_RISK_RULES.goodPercent);
        }
        if (reports >= DELIVERY_RISK_RULES.riskyReports) expect(risk).toBe('risky');
        if (risk === 'new') expect(delivered + cancelled + reports).toBe(0);
      }),
    );
  });
});
