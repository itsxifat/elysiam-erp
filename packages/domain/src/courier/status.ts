import { transitionFor, type OrderStatus, type OrderTrigger } from '../orders/state.js';

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
 *
 * `in_review` and `pending` are the owner's own reading of Steadfast (D-902): a parcel is
 * `in_review` from its booking until Steadfast's hub has it, and `pending` from then until
 * it is delivered or cancelled. So `pending` is the courier's word that it has the parcel,
 * `picked_up`, and a parcel still `in_review` hours after its handover never reached the hub
 * (D-903).
 */
export const STEADFAST_STATUS_MAP: ProviderStatusMap = {
  code: 'steadfast',
  statuses: {
    pending: 'picked_up',
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

/**
 * Pathao's words, as its own open-source WooCommerce plugin receives them (D-006, M15).
 *
 * **UNVERIFIED**, and the provenance is worth stating exactly because it is better than
 * Steadfast's and still not the real thing. Pathao's merchant API document is a
 * JavaScript page behind the merchant portal that could not be read from here. What *could*
 * be read is `pathao-eng/courier-woocommerce-plugin` — Pathao's own engineering
 * organisation's code, which is first-party in authorship even though it is not a
 * specification. Its webhook handler maps nineteen `event` names to nineteen
 * `order_status` words, and stores either the body's `order_status` or the mapped word
 * into one field — so the two lists are one vocabulary seen from two sides, and both are
 * here. `pending` is added because the create response reports it, per every published
 * client; it is the only word not taken from Pathao's own code.
 *
 * The entries worth reading twice:
 *
 * - **`exchange` / `order.exchanged` → `unknown`.** An exchange is a delivery that also
 *   takes a parcel back, at a COD that need not be the order's. Mapping it to `delivered`
 *   would recognise the full COD as revenue on a courier's word about a transaction we
 *   did not book; `unknown` records it, moves nothing, and leaves the parcel in the
 *   stuck-parcel queue where a person settles it with the manual status route.
 * - **`payment_invoice` / `order.paid` → `unknown`.** Pathao paying *us* is a settlement
 *   fact, not a place the parcel is. It arrives after delivery, and `trackingStatusAfter`
 *   keeps a delivered parcel delivered, so the word is recorded and changes nothing.
 * - **`order_updated` → `unknown`** for the same reason: the order's details changed, the
 *   parcel did not move.
 * - **`delivery_failed` → `hold`**, not a return. A failed attempt is re-attempted as often
 *   as it is returned, and a return here would start §9's return path on a parcel that is
 *   still going to be delivered.
 * - **`paid_return` → `returned_to_merchant`.** The customer paid the delivery charge and
 *   refused the goods, so the courier *collected* money on a returned parcel. We book no
 *   revenue for it here; the courier's statement then shows a collection against a parcel
 *   our books expect nothing from, and the matcher lists it as an `amount_mismatch` for a
 *   person — visible, rather than silently absorbed.
 */
export const PATHAO_STATUS_VOCABULARY: readonly string[] = [
  // The webhook's `event` names, verbatim from the plugin's `$orderEventsStatusMap` keys.
  'order.created',
  'order.updated',
  'order.pickup-requested',
  'order.assigned-for-pickup',
  'order.picked',
  'order.pickup-failed',
  'order.pickup-cancelled',
  'order.at-the-sorting-hub',
  'order.in-transit',
  'order.received-at-last-mile-hub',
  'order.assigned-for-delivery',
  'order.delivered',
  'order.partial-delivery',
  'order.returned',
  'order.delivery-failed',
  'order.on-hold',
  'order.paid-return',
  'order.exchanged',
  'order.paid',
  // The `order_status` words the same map produces, lower-cased as `normalizeStatus` reads.
  'order_created',
  'order_updated',
  'pickup_requested',
  'assigned_for_pickup',
  'picked',
  'pickup_failed',
  'pickup_cancelled',
  'at_the_sorting_hub',
  'in_transit',
  'received_at_last_mile_hub',
  'assigned_for_delivery',
  'delivered',
  'partial_delivery',
  'return',
  'delivery_failed',
  'on_hold',
  'paid_return',
  'exchange',
  'payment_invoice',
  // The create response's word, per every published client.
  'pending',
];

export const PATHAO_STATUS_MAP: ProviderStatusMap = {
  code: 'pathao',
  statuses: {
    'order.created': 'booked',
    'order.updated': 'unknown',
    'order.pickup-requested': 'pickup_pending',
    'order.assigned-for-pickup': 'pickup_pending',
    'order.picked': 'picked_up',
    // A failed pickup leaves the parcel on our shelf, still waiting for a rider.
    'order.pickup-failed': 'pickup_pending',
    'order.pickup-cancelled': 'cancelled',
    'order.at-the-sorting-hub': 'in_transit',
    'order.in-transit': 'in_transit',
    'order.received-at-last-mile-hub': 'in_transit',
    'order.assigned-for-delivery': 'out_for_delivery',
    'order.delivered': 'delivered',
    'order.partial-delivery': 'partial_delivered',
    'order.returned': 'returned_to_merchant',
    'order.delivery-failed': 'hold',
    'order.on-hold': 'hold',
    'order.paid-return': 'returned_to_merchant',
    'order.exchanged': 'unknown',
    'order.paid': 'unknown',
    order_created: 'booked',
    order_updated: 'unknown',
    pickup_requested: 'pickup_pending',
    assigned_for_pickup: 'pickup_pending',
    picked: 'picked_up',
    pickup_failed: 'pickup_pending',
    pickup_cancelled: 'cancelled',
    at_the_sorting_hub: 'in_transit',
    in_transit: 'in_transit',
    received_at_last_mile_hub: 'in_transit',
    assigned_for_delivery: 'out_for_delivery',
    delivered: 'delivered',
    partial_delivery: 'partial_delivered',
    return: 'returned_to_merchant',
    delivery_failed: 'hold',
    on_hold: 'hold',
    paid_return: 'returned_to_merchant',
    exchange: 'unknown',
    payment_invoice: 'unknown',
    pending: 'pickup_pending',
  },
};

/**
 * RedX's words (D-006, M15).
 *
 * **UNVERIFIED, and weaker than Pathao's. There is no source for this list** (D-200).
 *
 * The `redx-for-woocommerce` WordPress plugin was downloaded and read for M15's gap pass:
 * it has no status handling, no webhook route and no status constants, and it is a
 * community plugin — authored by an individual, with `shopupwp` among its contributors —
 * rather than RedX's own SDK, which an earlier version of this comment called it.
 * `redx.com.bd/developer-documentation/` now 301s to a 404, and the developer portal
 * renders nothing without a merchant session.
 *
 * So the seven words below are recalled, not read. They are believed to be RedX's webhook
 * statuses; whether `GET /parcel/info` answers in the same vocabulary is not known, and
 * neither is whether the list is complete. A word it sends that is not here becomes `unknown`
 * with the raw text kept (§9), changes nothing (`trackingStatusAfter`), and leaves the
 * parcel in the stuck-parcel queue with that word showing — which is how the first person
 * with a RedX sandbox finds out what to add.
 *
 * `agent-area-change` is `in_transit`: the parcel is being re-routed to another hub, which
 * is movement, not a hold.
 */
export const REDX_STATUS_VOCABULARY: readonly string[] = [
  'ready-for-delivery',
  'delivery-in-progress',
  'delivered',
  'agent-hold',
  'agent-returning',
  'returned',
  'agent-area-change',
];

export const REDX_STATUS_MAP: ProviderStatusMap = {
  code: 'redx',
  statuses: {
    'ready-for-delivery': 'in_transit',
    'delivery-in-progress': 'out_for_delivery',
    delivered: 'delivered',
    'agent-hold': 'hold',
    'agent-returning': 'return_in_transit',
    returned: 'returned_to_merchant',
    'agent-area-change': 'in_transit',
  },
};

/**
 * Steadfast's `delivery_status` values, transcribed.
 *
 * Source: the "Delivery Statuses" table in `steadfast-it/SteadFast-Courier-Laravel-Package`'s
 * README (the same first-party-authored document the map above was built from), read again
 * for M15. Eleven values, in the README's order. Typed out rather than taken from the map's
 * keys: M12's completeness test used `Object.keys(map.statuses)` as the vocabulary, which
 * makes "every word is mapped" true by construction and the test unable to fail.
 */
export const STEADFAST_STATUS_VOCABULARY: readonly string[] = [
  'pending',
  'delivered_approval_pending',
  'partial_delivered_approval_pending',
  'cancelled_approval_pending',
  'unknown_approval_pending',
  'delivered',
  'partial_delivered',
  'cancelled',
  'hold',
  'in_review',
  'unknown',
];

/**
 * The fake courier's vocabulary, transcribed.
 *
 * Source: `apps/server/src/modules/courier/adapters/fake.adapter.ts` — the words its
 * `createParcel`, `cancelParcel` and the tests' `advance()` calls put on a parcel. Its own
 * definition, but a separate list all the same, so the map is tested against something it
 * was not derived from.
 */
export const FAKE_STATUS_VOCABULARY: readonly string[] = [
  'created',
  'awaiting_pickup',
  'collected',
  'moving',
  'with_rider',
  'paused',
  'handed_to_customer',
  'part_handed',
  'coming_back',
  'back_at_warehouse',
  'called_off',
  'weird',
];

/**
 * Each provider's declared vocabulary, beside its map.
 *
 * Every list is typed out from the source named on it, never derived from the map: the
 * acceptance check is that the map *equals* the vocabulary, and a vocabulary derived from
 * the map is equal to it by construction, which proves nothing. The tests assert the two
 * agree in both directions.
 */
export const PROVIDER_VOCABULARIES: Readonly<Record<string, readonly string[]>> = {
  steadfast: STEADFAST_STATUS_VOCABULARY,
  fake: FAKE_STATUS_VOCABULARY,
  pathao: PATHAO_STATUS_VOCABULARY,
  redx: REDX_STATUS_VOCABULARY,
};

/**
 * Where each provider's vocabulary came from (M15 check 1, D-200).
 *
 * `document` means the words were transcribed from a cited source the provider (or,
 * for the fake, this codebase) publishes. `recalled` means they were not: no source
 * could be read, so the list is a best effort, and the completeness tests prove only
 * that the map and the list agree with each other. A provider moves to `document` when
 * somebody transcribes its words from a source, and the decision row closes with it.
 */
export const VOCABULARY_PROVENANCE: Readonly<Record<string, 'document' | 'recalled'>> = {
  steadfast: 'document',
  fake: 'document',
  pathao: 'document',
  redx: 'recalled',
};

const BUILT_IN_MAPS: readonly ProviderStatusMap[] = [
  STEADFAST_STATUS_MAP,
  FAKE_STATUS_MAP,
  PATHAO_STATUS_MAP,
  REDX_STATUS_MAP,
];

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
 * The courier statuses that prove a parcel has left our hands (D-390).
 *
 * Everything a rider can only say once the box is with them. `booked` and `pickup_pending`
 * are said while it is still on our shelf; `hold` is ambiguous (Steadfast says it of an order
 * it has not reviewed yet, Pathao of a failed delivery attempt); `cancelled` before pickup is
 * the desk's call (see `orderTriggerFor`); `unknown` proves nothing.
 */
export const LEFT_THE_MERCHANT: readonly ParcelStatus[] = [
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'partial_delivered',
  'return_in_transit',
  'returned_to_merchant',
];

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
 * `returned_to_merchant` never produces `receive_return`. §9 gives
 * `return_in_transit → returned` the trigger `receive_return`, performed when the
 * "Warehouse receives and inspects" — units go back on a shelf and a journal posts.
 * A courier saying the parcel reached its own warehouse is not our warehouse
 * receiving it, and letting a webhook perform it would put stock back on a shelf
 * nobody has looked in.
 *
 * It does produce `start_return` from `shipped` (M15). Pathao reports a return only
 * once it is complete, never the leg in between, and without this the order stayed
 * `shipped` for ever — and `receive_return` is refused from `shipped`, so the
 * warehouse could not receive a parcel that was physically on its floor. `start_return`
 * has no effects in §9's table; it only says the parcel is on its way back, which a
 * parcel that has arrived back certainly was.
 *
 * ## A partial delivery needs the courier's figure
 *
 * `collectedKnown: false` makes `partial_delivered` produce nothing. The delivery journal
 * debits `courier_receivable` with what the courier collected, and when the courier does
 * not say, the only figure available is the full COD — which is wrong by definition for a
 * *partial* delivery. M12 found the same class of bug the hard way (D-129: a stored
 * payload that dropped the figure booked every webhook delivery at full COD). A courier
 * whose partial-delivery event carries no amount now leaves the order `shipped`, the event
 * recorded, and the parcel for a person to settle through the manual status route, which
 * takes the amount and the delivered lines. A full delivery keeps the fallback: a rider
 * who delivered everything collected the COD.
 */
export function orderTriggerFor(
  status: ParcelStatus,
  from: OrderStatus,
  options: { readonly collectedKnown?: boolean } = {},
): OrderTrigger | null {
  /*
   * The handover, on the courier's word (D-390).
   *
   * §9 gives `confirmed → shipped` and `packed → shipped` the trigger `ship`, performed at the
   * "handover to courier". A courier reporting the parcel picked up, moving, out with a rider,
   * delivered or on its way back is the courier's own evidence that the handover happened —
   * and until this, nothing but a person pressing Ship moved the order, so a brand whose
   * warehouse forgot (or whose courier, like Steadfast, never says "picked up") had an order
   * sitting `packed` while its parcel was delivered, the delivery recorded and ignored, and no
   * revenue posted. `hold`, `cancelled`, `booked`, `pickup_pending` and `unknown` do not prove
   * the parcel left (Steadfast's `in_review` is a `hold` before pickup), so they still move
   * nothing before shipment. An order `on_hold` is not moved either: a hold is "do not ship",
   * and a person decides what to do about a courier that took the box anyway.
   */
  if ((from === 'confirmed' || from === 'packed') && LEFT_THE_MERCHANT.includes(status)) {
    return 'ship';
  }
  switch (status) {
    case 'delivered':
      return from === 'shipped' ? 'deliver' : null;
    case 'partial_delivered':
      if (options.collectedKnown === false) return null;
      return from === 'shipped' ? 'deliver_partially' : null;
    case 'return_in_transit':
    case 'returned_to_merchant':
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
    case 'unknown':
      return null;
  }
}

/**
 * Every trigger one courier status justifies, in the order to perform them (D-390).
 *
 * At most two: the handover a status proves (`ship`, from `confirmed` or `packed`) and then
 * whatever the same status justifies from `shipped` — a `delivered` reaching a `packed` order
 * ships it and delivers it, in one transaction, with the handover journal posted before the
 * delivery journal relieves it. Each step is still one of §9's rows, applied through the
 * machine by the caller; this only says which rows. Empty means "record the event and change
 * nothing", exactly as `orderTriggerFor` returning null does.
 */
export function courierTriggersFor(
  status: ParcelStatus,
  from: OrderStatus,
  options: { readonly collectedKnown?: boolean } = {},
): readonly OrderTrigger[] {
  const triggers: OrderTrigger[] = [];
  let at: OrderStatus = from;
  for (let step = 0; step < 2; step += 1) {
    const next = orderTriggerFor(status, at, options);
    if (next === null) break;
    const row = transitionFor(at, next);
    if (row === undefined) break;
    triggers.push(next);
    at = row.to;
  }
  return triggers;
}

/**
 * The status a consignment should hold after the courier says `incoming` (M15).
 *
 * M12 wrote every event's status straight onto the consignment, and two things a courier
 * routinely does made that wrong once a second and third courier arrived:
 *
 * - **It speaks after the story has ended.** Pathao sends `order.paid` after
 *   `order.delivered`, and `order.updated` whenever a detail changes. Both map to
 *   `unknown`, and overwriting `delivered` with `unknown` made a finished parcel *active*
 *   again — back in the poller's working set and, after N days, in the stuck-parcel queue
 *   next to parcels that genuinely are missing, where the real ones get lost among it.
 * - **It says things we cannot map.** `unknown` replacing `in_transit` hid where the
 *   parcel last really was, which is the one fact a person chasing it needs.
 *
 * So: an `unknown` word never replaces a status (the event row keeps it, raw, per §9), and
 * a finished parcel stays finished. The one exception is a partial delivery, whose
 * undelivered remainder then really does travel back — `partial_delivered` may become
 * `return_in_transit` or `returned_to_merchant`.
 *
 * This decides tracking only. Whether the *order* moves is `orderTriggerFor`'s question,
 * asked against the order's own status, so nothing here can suppress or cause a posting.
 */
export function trackingStatusAfter(current: ParcelStatus, incoming: ParcelStatus): ParcelStatus {
  if (incoming === 'unknown') return current;
  if (current === 'unknown') return incoming;
  if (!isTerminalParcelStatus(current)) return incoming;
  if (
    current === 'partial_delivered' &&
    (incoming === 'return_in_transit' || incoming === 'returned_to_merchant')
  ) {
    return incoming;
  }
  return current;
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
