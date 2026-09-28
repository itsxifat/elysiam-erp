import { type OrderStatus, type OrderTrigger } from '../orders/state.js';

/**
 * Normalising what a courier says (architecture §9 "Couriers", invariant 7).
 *
 * §9 fixes twelve normalized statuses and this module is the only place a provider's
 * own vocabulary is turned into one of them. The reason it is a data table rather
 * than a `switch` in each adapter is acceptance check 2: "every provider status is
 * covered by a mapping test". A table can be enumerated, so the test can assert that
 * the mapping's key set **equals** the provider's declared vocabulary — no missing
 * key, no invented one. A `switch` with a `default` passes every test anyone would
 * think to write and silently sends a new provider status to `unknown` forever.
 *
 * ## Two mappings, not one
 *
 * There is the courier's word for where the parcel is, and there is what our order
 * has to do about it. Collapsing them is the mistake that looks harmless: mapping
 * Steadfast's `cancelled` straight onto our `cancelled` order status would try to
 * move a shipped order to cancelled, which §9 forbids outright ("once an order is
 * shipped it can't be cancelled; it becomes a return") and which the state machine
 * would refuse — turning a routine courier event into a dead-lettered job.
 *
 * So `normalizeStatus` is faithful to the courier, and `orderTriggerFor` decides,
 * given where the order actually is, which of §9's triggers (if any) this status
 * justifies. Most statuses justify none: they are tracking, not accounting.
 */

/** §9's normalized statuses, closed. */
export const PARCEL_STATUSES = [
  'booked',
  'pickup_pending',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'hold',
  'delivered',
  'partial_delivered',
  'return_in_transit',
  'returned_to_merchant',
  'cancelled',
  /** §9: "For `unknown`, keep the raw status." Never a silent drop. */
  'unknown',
] as const;

export type ParcelStatus = (typeof PARCEL_STATUSES)[number];

export function isParcelStatus(value: string): value is ParcelStatus {
  return (PARCEL_STATUSES as readonly string[]).includes(value);
}

/**
 * Statuses nothing can follow, from the courier's side.
 *
 * Used by the polling job to stop asking: §20 polls "stale active parcels", and a
 * parcel that has been delivered is not active. Without this the poller would keep
 * every parcel we ever shipped in its working set, and the courier's rate limit
 * would be spent on parcels whose story ended in March.
 */
export const TERMINAL_PARCEL_STATUSES: readonly ParcelStatus[] = [
  'delivered',
  'partial_delivered',
  'returned_to_merchant',
  'cancelled',
];

export function isTerminalParcelStatus(status: ParcelStatus): boolean {
  return TERMINAL_PARCEL_STATUSES.includes(status);
}

/**
 * One provider's vocabulary, and what each of its words means here.
 *
 * `Record<string, ParcelStatus>` rather than a partial map: a provider status with
 * no entry is a programming mistake this module can detect (`unmappedStatuses`),
 * and the adapter contract test asserts the set is complete.
 */
export interface ProviderStatusMap {
  /** The courier's code, matching `sales.couriers.code`. */
  readonly code: string;
  readonly statuses: Readonly<Record<string, ParcelStatus>>;
}

/**
 * Steadfast's `delivery_status` values (D-006).
 *
 * **UNVERIFIED.** Taken from Steadfast's own Laravel package README, which is the
 * closest thing to first-party documentation reachable without a portal account;
 * the merchant portal's API document could not be fetched. The vocabulary is
 * therefore configuration-shaped rather than hard truth — `courierStatusMap` accepts
 * an override so an operator can correct a word without a deploy — and the adapter
 * that uses it is behind a flag (see `decisions.md`, D-176).
 *
 * The four `*_approval_pending` values are the ones worth reading twice. They mean
 * the rider has reported an outcome and Steadfast's office has not confirmed it. If
 * `delivered_approval_pending` mapped to `delivered`, we would recognise revenue
 * (D-003) on a rider's unconfirmed word and then have to reverse it when the office
 * disagreed — reversals in a closed month, every month. So they map to states that
 * move nothing: the parcel is still out, or on hold.
 */
export const STEADFAST_STATUS_MAP: ProviderStatusMap = {
  code: 'steadfast',
  statuses: {
    pending: 'pickup_pending',
    in_review: 'hold',
    hold: 'hold',
    delivered_approval_pending: 'out_for_delivery',
    partial_delivered_approval_pending: 'out_for_delivery',
    cancelled_approval_pending: 'hold',
    unknown_approval_pending: 'hold',
    delivered: 'delivered',
    partial_delivered: 'partial_delivered',
    cancelled: 'cancelled',
    unknown: 'unknown',
  },
};

/**
 * The fake courier's vocabulary, which covers all twelve normalized statuses.
 *
 * Not a toy. It is the only adapter whose every branch can be exercised, so the
 * contract tests, the duplicate-webhook test and the book → deliver → settle
 * scenario all run against it — and it is what a developer with no courier account
 * develops against. Its words are deliberately *not* Steadfast's, so a test that
 * accidentally depends on one provider's spelling fails on the other.
 */
export const FAKE_STATUS_MAP: ProviderStatusMap = {
  code: 'fake',
  statuses: {
    created: 'booked',
    awaiting_pickup: 'pickup_pending',
    collected: 'picked_up',
    moving: 'in_transit',
    with_rider: 'out_for_delivery',
    paused: 'hold',
    handed_to_customer: 'delivered',
    part_handed: 'partial_delivered',
    coming_back: 'return_in_transit',
    back_at_warehouse: 'returned_to_merchant',
    called_off: 'cancelled',
    weird: 'unknown',
  },
};

const BUILT_IN_MAPS: readonly ProviderStatusMap[] = [STEADFAST_STATUS_MAP, FAKE_STATUS_MAP];

export function courierStatusMap(code: string): ProviderStatusMap | undefined {
  return BUILT_IN_MAPS.find((map) => map.code === code);
}

/** Every provider whose vocabulary this module knows. Drives the mapping test. */
export const MAPPED_COURIER_CODES: readonly string[] = BUILT_IN_MAPS.map((map) => map.code);

export interface NormalizedStatus {
  readonly status: ParcelStatus;
  /** Exactly what the courier said, always kept (§9). */
  readonly raw: string;
}

/**
 * One courier status, normalized.
 *
 * Case and surrounding space are ignored because a webhook body and a status poll
 * from the same courier have been seen to disagree on both, and a mapping that
 * treats `Delivered` as unknown would leave the parcel `shipped` with money in the
 * rider's pocket and nothing in the books.
 *
 * `raw` is the courier's string as it arrived, not the trimmed one: §9 says keep the
 * raw status, and the value of keeping it is being able to show an operator the
 * exact text when a mapping turns out to be wrong.
 */
export function normalizeStatus(map: ProviderStatusMap, raw: string): NormalizedStatus {
  const key = raw.trim().toLowerCase();
  const mapped = Object.hasOwn(map.statuses, key) ? map.statuses[key] : undefined;
  return { status: mapped ?? 'unknown', raw };
}

/** Provider statuses in `vocabulary` that the map has no entry for. Empty, or a bug. */
export function unmappedStatuses(
  map: ProviderStatusMap,
  vocabulary: readonly string[],
): readonly string[] {
  return vocabulary.filter((word) => !Object.hasOwn(map.statuses, word.trim().toLowerCase()));
}

/**
 * Which of §9's triggers this courier status justifies, from where the order is.
 *
 * `null` means "record the event and change nothing", which is the answer for most
 * statuses and for every status arriving at an order that has already moved past it.
 * That second half is what makes a duplicate webhook harmless at this layer: a
 * second `delivered` for an order that is already `delivered` returns `null`, so
 * nothing is attempted and nothing is posted (acceptance check 3). The dedupe row
 * and the ledger's idempotency key are the other two layers.
 *
 * `returned_to_merchant` deliberately produces no trigger. §9 gives
 * `return_in_transit → returned` the trigger `receive_return`, performed when the
 * "Warehouse receives and inspects" — units go back on a shelf and a journal posts.
 * A courier saying the parcel reached its own warehouse is not our warehouse
 * receiving it, and letting a webhook perform it would put stock back on a shelf
 * nobody has looked in.
 */
export function orderTriggerFor(status: ParcelStatus, from: OrderStatus): OrderTrigger | null {
  switch (status) {
    case 'delivered':
      return from === 'shipped' ? 'deliver' : null;
    case 'partial_delivered':
      return from === 'shipped' ? 'deliver_partially' : null;
    case 'return_in_transit':
      return from === 'shipped' ? 'start_return' : null;
    case 'cancelled':
      /*
       * A cancellation after the parcel left is a return, not a cancelled order.
       * Before it left, a courier's cancellation is news rather than a decision: the
       * units are still ours, the order is still confirmed or packed, and whether to
       * cancel or rebook is a person's call. Returning `null` there keeps that call
       * with the desk instead of releasing a reservation on a webhook.
       */
      return from === 'shipped' ? 'start_return' : null;
    case 'booked':
    case 'pickup_pending':
    case 'picked_up':
    case 'in_transit':
    case 'out_for_delivery':
    case 'hold':
    case 'returned_to_merchant':
    case 'unknown':
      return null;
  }
}

/**
 * The dedupe key §9 asks for: `(courier, consignment, status, occurred_at)`.
 *
 * Keyed on **our** consignment id rather than the courier's number. The consignment
 * row already names the courier and the account, so our id carries §9's first two
 * components and carries them more precisely: a parcel rebooked with a second courier
 * is a second consignment, and its events must not collide with the first's. The
 * courier's own number is also absent until a booking succeeds, and an empty string
 * there would make two unbooked parcels' manual events collide.
 *
 * Built here rather than at the two call sites so the webhook path and the polling
 * path produce identical keys for identical facts. They must: a poll that arrives
 * first and a webhook that arrives second describe one event, and if their keys
 * differed the order would be transitioned twice — refused the second time by the
 * state machine, but only after the second attempt had already been made and logged
 * as a failure.
 *
 * `occurredAt` is truncated to the second, and the database's own check recomputes it
 * the same way. Couriers report whole seconds; a millisecond that differs between two
 * representations of one instant is exactly the difference this key exists to ignore.
 */
export function statusDedupeKey(input: {
  readonly consignmentId: string;
  readonly status: ParcelStatus;
  readonly occurredAt: Date;
}): string {
  const seconds = Math.floor(input.occurredAt.getTime() / 1000);
  return [input.consignmentId.toLowerCase(), input.status, String(seconds)].join('|');
}
