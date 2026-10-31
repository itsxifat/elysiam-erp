/**
 * A buyer's delivery record with a courier, and what it says about the next order (D-918).
 *
 * Steadfast's official `GET /fraud_check/score/{phone}` answers, for a phone number, how many
 * parcels to it were delivered and how many were cancelled across every merchant Steadfast
 * carries for, and how many times merchants reported the number and why. It replaces the
 * `fraudjs` scraper D-010 waited for: the courier's own API, with the brand's own keys.
 *
 * This file is the arithmetic: the success rate from the two counts, and one of four words a
 * person at the order desk reads in a glance. The courier call and the parsing of its body
 * are the adapter's.
 *
 * The record is advice, never a gate. Confirming an order stays the state machine alone
 * (D-291); an agent who sees "Risky" calls the buyer or asks for an advance (M17).
 */

export interface DeliveryRecord {
  /** Parcels to this phone the courier delivered (any merchant). */
  readonly delivered: number;
  /** Parcels to this phone the courier cancelled and brought back. */
  readonly cancelled: number;
  /** Times merchants reported this phone to the courier. */
  readonly reports: number;
  /** The reports by the courier's reason code (`fake_order`, `no_response`, …), largest first. */
  readonly reportReasons: readonly { readonly code: string; readonly count: number }[];
  /** The courier's own volume band for the phone (`low`, `medium`, `high`), when it says. */
  readonly volumeBand: string | null;
  /** The courier's own volume range for the phone (`50+`), when it says. */
  readonly volumeRange: string | null;
  /** The courier marks some reports as doubtful. */
  readonly doubtfulReports: boolean;
  /** The courier's own risk level, only when its scoring is switched on (null otherwise). */
  readonly courierLevel: string | null;
}

export type DeliveryRisk = 'new' | 'good' | 'caution' | 'risky';

/**
 * Where the words change (ASSUMED, D-918).
 *
 * Good is four in five delivered and nobody's report; Risky is fewer than half delivered over
 * at least three parcels, or three reports. A buyer with one or two parcels is never Risky on
 * the rate alone: one cancelled first order is a change of mind as often as a fraud.
 */
export const DELIVERY_RISK_RULES = {
  goodPercent: 80,
  riskyPercent: 50,
  riskyMinParcels: 3,
  riskyReports: 3,
} as const;

/** Parcels the record counts: delivered and cancelled. */
export function recordParcels(record: Pick<DeliveryRecord, 'delivered' | 'cancelled'>): number {
  return record.delivered + record.cancelled;
}

/** Delivered as a whole percentage of the parcels, rounded half up; null with no parcels. */
export function deliverySuccessPercent(
  record: Pick<DeliveryRecord, 'delivered' | 'cancelled'>,
): number | null {
  const parcels = recordParcels(record);
  if (parcels === 0) return null;
  return Math.floor((record.delivered * 200 + parcels) / (parcels * 2));
}

export function deliveryRisk(record: DeliveryRecord): DeliveryRisk {
  const parcels = recordParcels(record);
  if (parcels === 0 && record.reports === 0) return 'new';
  if (record.reports >= DELIVERY_RISK_RULES.riskyReports) return 'risky';
  const success = deliverySuccessPercent(record);
  if (
    success !== null &&
    parcels >= DELIVERY_RISK_RULES.riskyMinParcels &&
    success < DELIVERY_RISK_RULES.riskyPercent
  ) {
    return 'risky';
  }
  if (record.reports > 0 || (success !== null && success < DELIVERY_RISK_RULES.goodPercent)) {
    return 'caution';
  }
  return 'good';
}
