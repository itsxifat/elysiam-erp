import { businessDate, type IsoDate } from '../dates/index.js';
import { isReturnReasonCode, type ReturnReasonCode } from './returns.js';

/**
 * The order state machine (architecture §9, invariant 7).
 *
 * Invariant 7 says order status changes only through this table, and the reason is
 * not tidiness. Every transition in §9 has effects attached — reserve stock, consume
 * a reservation, post revenue, put units back on a shelf — and each effect is
 * irreversible in a different way. A status column that anything could set would let
 * an order reach `delivered` without ever having been `shipped`, which means revenue
 * recognised against goods in transit that was never debited: a journal that balances
 * and a goods-in-transit account that never returns to zero.
 *
 * So the table below is the whole of the machine, it is exhaustive, and the only way
 * to move an order is `transition()`. A caller that wants to know whether a move is
 * legal before offering the button asks `canTransition()`; a caller that wants the
 * effects it must perform reads them off the result rather than deciding for itself.
 *
 * ## Why the effects are declared rather than performed
 *
 * This module is pure (invariant 11): it cannot reserve stock or post a journal, and
 * it must not try. It names what has to happen, in order, and
 * `apps/server/src/modules/orders/transitions.service.ts` performs exactly that list
 * inside one transaction. Keeping the list here is what makes it reviewable — §9's
 * "Effects" column and `TRANSITIONS` can be read side by side — and what makes
 * "cancelling a booked order also cancels the parcel" a fact about the machine
 * rather than a line somebody remembered to write in one of three cancel paths.
 */

/** §9's eleven statuses, closed. */
export const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'on_hold',
  'packed',
  'shipped',
  'delivered',
  'partially_delivered',
  'return_in_transit',
  'returned',
  'cancelled',
  'exchange',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

/**
 * What a person or a courier did, as opposed to where the order ended up.
 *
 * Triggers are named rather than inferred from `(from, to)` because two of §9's
 * rows share a destination for different reasons: `confirmed → cancelled` and
 * `packed → cancelled` are one trigger applied twice, while `partially_delivered →
 * returned` and `return_in_transit → returned` are the same trigger reached by two
 * routes. A UI offers triggers; the table answers whether this order can take one.
 */
export const ORDER_TRIGGERS = [
  'confirm',
  'cancel',
  'hold',
  'release_hold',
  'pack',
  'ship',
  'deliver',
  'deliver_partially',
  'start_return',
  'receive_return',
  'exchange',
] as const;

export type OrderTrigger = (typeof ORDER_TRIGGERS)[number];

/**
 * Something the server must do in the same transaction as the status change.
 *
 * Ordered by dependency where it matters: `consume_reservation` before
 * `create_dispatch_movement` before `post_handover`, because the handover journal's
 * value is the weighted average the dispatch movement recorded.
 */
export const ORDER_EFFECTS = [
  /** Hold the units with M07's atomic conditional UPDATE. */
  'reserve_stock',
  /** Give the units back. Cancelling before dispatch. */
  'release_reservation',
  /** The units are leaving: the reservation becomes a real movement. */
  'consume_reservation',
  'create_dispatch_movement',
  /** Dr Goods in transit / Cr Inventory at the average recorded on the movement. */
  'post_handover',
  /** Dr Courier receivable (+ Customer advance) / Cr Revenue + Delivery income, and Dr COGS / Cr GIT. */
  'post_revenue',
  /** The same for the delivered lines only, with the collection difference to Sales discounts. */
  'post_partial_revenue',
  /** Units back on a shelf at their dispatch cost, and Dr Inventory / Cr Goods in transit. */
  'receive_return_stock',
  'post_return',
  /** The replacement order, with `exchange_of_order_id` set. */
  'create_exchange_order',
  /** §9: only if the org's booking setting is `on_confirm` / `on_pack`. */
  'enqueue_courier_booking',
  /** §9: only if the parcel was already booked. */
  'enqueue_courier_cancel',
  /** Delivered, returned and cancelled all move a buyer's counters. */
  'update_customer_stats',
  /**
   * M16, D-204: a promo code's use goes back. On every cancel and on nothing else —
   * a cancel is only reachable before the order ships, and once it ships the use is
   * kept, returned or not. Its own effect, not a step inside the stats effect, because
   * a cancel from `pending` declares no stats effect at all and the use still has to go
   * back; hanging it off another effect made it depend on a list that does not mention it.
   */
  'release_promo',
  /**
   * M17, D-233: the delivery journal relieved Customer advance by the applicable amount, and
   * each verified advance records its share of it, oldest first. After `post_revenue` /
   * `post_partial_revenue`, which is what computes the amount.
   */
  'apply_advances',
  /**
   * M17, D-232: whatever is left of each verified advance is refunded or kept, per the
   * brand's policy. On every cancel and on a received return. Never on a delivery: a partial
   * delivery's leftover waits for the return that follows it.
   */
  'settle_advances',
  /** M17, D-234: the return reason, on every return and every exchange. */
  'record_return_reason',
] as const;

export type OrderEffect = (typeof ORDER_EFFECTS)[number];

export interface OrderTransition {
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  readonly trigger: OrderTrigger;
  /** In the order the server must perform them. */
  readonly effects: readonly OrderEffect[];
  /**
   * Whether the caller must supply a reason.
   *
   * Every one of these is a move that costs somebody money or takes an order away
   * from the person who was working it, and "why" is the only thing that makes the
   * audit row useful six weeks later when a return rate is being argued about.
   */
  readonly requiresReason: boolean;
}

/**
 * §9's transition table, transcribed row for row.
 *
 * Fifteen entries. Every pair not listed here is refused, and the test asserts every
 * one of the 11 × 11 pairs is either present with its trigger or absent — which is
 * acceptance check 1, and the reason the table is data rather than a `switch`.
 */
export const TRANSITIONS: readonly OrderTransition[] = [
  {
    from: 'pending',
    to: 'confirmed',
    trigger: 'confirm',
    // §9: reserve stock; book the courier here if the org books on confirm.
    effects: ['reserve_stock', 'enqueue_courier_booking'],
    requiresReason: false,
  },
  {
    from: 'pending',
    to: 'cancelled',
    trigger: 'cancel',
    effects: ['release_promo', 'settle_advances'],
    requiresReason: true,
  },
  {
    from: 'confirmed',
    to: 'on_hold',
    trigger: 'hold',
    // §9 is explicit: the reservation stays. A hold is "do not ship yet", not
    // "give the stock back" — releasing it would let the units be sold twice over
    // while an agent waits for the customer to answer their phone.
    effects: [],
    requiresReason: true,
  },
  { from: 'on_hold', to: 'confirmed', trigger: 'release_hold', effects: [], requiresReason: false },
  {
    from: 'confirmed',
    to: 'packed',
    trigger: 'pack',
    effects: ['enqueue_courier_booking'],
    requiresReason: false,
  },
  {
    from: 'confirmed',
    to: 'cancelled',
    trigger: 'cancel',
    effects: [
      'release_reservation',
      'enqueue_courier_cancel',
      'update_customer_stats',
      'release_promo',
      'settle_advances',
    ],
    requiresReason: true,
  },
  {
    from: 'packed',
    to: 'cancelled',
    trigger: 'cancel',
    effects: [
      'release_reservation',
      'enqueue_courier_cancel',
      'update_customer_stats',
      'release_promo',
      'settle_advances',
    ],
    requiresReason: true,
  },
  {
    from: 'confirmed',
    to: 'shipped',
    trigger: 'ship',
    effects: ['consume_reservation', 'create_dispatch_movement', 'post_handover'],
    requiresReason: false,
  },
  {
    from: 'packed',
    to: 'shipped',
    trigger: 'ship',
    effects: ['consume_reservation', 'create_dispatch_movement', 'post_handover'],
    requiresReason: false,
  },
  {
    from: 'shipped',
    to: 'delivered',
    trigger: 'deliver',
    effects: ['post_revenue', 'apply_advances', 'update_customer_stats'],
    requiresReason: false,
  },
  {
    from: 'shipped',
    to: 'partially_delivered',
    trigger: 'deliver_partially',
    effects: ['post_partial_revenue', 'apply_advances', 'update_customer_stats'],
    requiresReason: false,
  },
  {
    from: 'shipped',
    to: 'return_in_transit',
    trigger: 'start_return',
    effects: [],
    requiresReason: false,
  },
  {
    from: 'return_in_transit',
    to: 'returned',
    trigger: 'receive_return',
    effects: [
      'receive_return_stock',
      'post_return',
      'update_customer_stats',
      'settle_advances',
      'record_return_reason',
    ],
    requiresReason: true,
  },
  {
    from: 'partially_delivered',
    to: 'returned',
    trigger: 'receive_return',
    effects: ['receive_return_stock', 'post_return', 'settle_advances', 'record_return_reason'],
    requiresReason: true,
  },
  {
    from: 'delivered',
    to: 'exchange',
    trigger: 'exchange',
    effects: ['create_exchange_order', 'record_return_reason'],
    requiresReason: true,
  },
];

/**
 * Statuses nothing leaves.
 *
 * Derived from the table rather than listed, so it cannot disagree with it. §9's
 * note — "once an order is shipped it can't be cancelled; it becomes a return" — is
 * visible here as the absence of any `shipped → cancelled` row, not as a special
 * case somebody has to remember.
 */
export const TERMINAL_STATUSES: readonly OrderStatus[] = ORDER_STATUSES.filter(
  (status) => !TRANSITIONS.some((entry) => entry.from === status),
);

export type OrderErrorCode =
  | 'ORDER_TRANSITION_INVALID'
  | 'ORDER_REASON_REQUIRED'
  | 'ORDER_RETURN_REASON_REQUIRED'
  | 'ORDER_TOTAL_INVALID'
  | 'ORDER_LINES_INVALID'
  | 'ORDER_PHONE_INVALID';

export class OrderError extends Error {
  constructor(
    readonly code: OrderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OrderError';
  }
}

/** The transition for one (from, trigger), or nothing if the machine refuses it. */
export function transitionFor(
  from: OrderStatus,
  trigger: OrderTrigger,
): OrderTransition | undefined {
  return TRANSITIONS.find((entry) => entry.from === from && entry.trigger === trigger);
}

/** Whether §9 allows this exact move. Used by the UI to decide what to offer. */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS.some((entry) => entry.from === from && entry.to === to);
}

/** Every trigger this order could take right now. */
export function triggersFrom(from: OrderStatus): readonly OrderTrigger[] {
  return TRANSITIONS.filter((entry) => entry.from === from).map((entry) => entry.trigger);
}

export interface TransitionRequest {
  readonly from: OrderStatus;
  readonly trigger: OrderTrigger;
  readonly at: Date;
  /** Required by the transitions marked `requiresReason`. */
  readonly reason?: string | null;
  /** The org's courier booking policy (§9). `manual` enqueues nothing. */
  readonly bookingPolicy?: 'on_confirm' | 'on_pack' | 'manual';
  /** Whether a parcel already exists with the courier, which decides the cancel. */
  readonly parcelBooked?: boolean;
  /** Why the goods came back: required on `receive_return` and `exchange` (M17, D-234). */
  readonly returnReason?: string | null | undefined;
}

export interface TransitionResult {
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  readonly trigger: OrderTrigger;
  /** The declared effects, with the two conditional ones resolved. */
  readonly effects: readonly OrderEffect[];
  readonly reason: string | null;
  /** Set exactly when the effects include `record_return_reason`. */
  readonly returnReason: ReturnReasonCode | null;
  readonly businessDate: IsoDate;
}

const MAX_REASON = 500;

/**
 * Move an order, or refuse.
 *
 * The refusals, in the order they are checked:
 *
 * 1. the pair is not in §9's table (`ORDER_TRANSITION_INVALID`);
 * 2. a transition that needs a reason was given none (`ORDER_REASON_REQUIRED`);
 * 3. a return or an exchange was given no reason code from the fixed list
 *    (`ORDER_RETURN_REASON_REQUIRED`, M17 check 3).
 */
export function transition(request: TransitionRequest): TransitionResult {
  const entry = transitionFor(request.from, request.trigger);
  if (entry === undefined) {
    /*
     * One message for "wrong trigger for this status" and "no such move", because
     * they are the same mistake from the caller's side and distinguishing them
     * would invite a caller to probe the table. The status and trigger are both
     * named: an error that says only "invalid transition" is the one that gets
     * pasted into a bug report with nothing else.
     */
    throw new OrderError(
      'ORDER_TRANSITION_INVALID',
      `An order that is ${request.from} cannot be ${describeTrigger(request.trigger)}.`,
    );
  }

  const reason = normaliseReason(request.reason);
  if (entry.requiresReason && reason === null) {
    throw new OrderError(
      'ORDER_REASON_REQUIRED',
      `Moving an order from ${entry.from} to ${entry.to} needs a reason.`,
    );
  }

  /*
   * Every return and every exchange says why, from the fixed list (D-234). Checked here so no
   * caller (the desk, the courier's returns screen, a job) can move goods back without one,
   * and the database refuses the same thing at commit if anything bypasses this.
   */
  const recordsReturn = entry.effects.includes('record_return_reason');
  const returnReason = isReturnReasonCode(request.returnReason) ? request.returnReason : null;
  if (recordsReturn && returnReason === null) {
    throw new OrderError(
      'ORDER_RETURN_REASON_REQUIRED',
      `Moving an order from ${entry.from} to ${entry.to} needs a return reason from the list.`,
    );
  }

  const policy = request.bookingPolicy ?? 'manual';
  const effects = entry.effects.filter((effect) => {
    if (effect === 'enqueue_courier_booking') {
      // §9 attaches booking to whichever of the two transitions the org chose, so
      // the same effect appears on both rows and exactly one of them fires. An org
      // on `manual` books from the desk and neither fires.
      return (
        (policy === 'on_confirm' && entry.to === 'confirmed') ||
        (policy === 'on_pack' && entry.to === 'packed')
      );
    }
    if (effect === 'enqueue_courier_cancel') return request.parcelBooked === true;
    return true;
  });

  return {
    from: entry.from,
    to: entry.to,
    trigger: entry.trigger,
    effects,
    reason,
    returnReason: recordsReturn ? returnReason : null,
    businessDate: businessDateOf(request.at),
  };
}

function describeTrigger(trigger: OrderTrigger): string {
  switch (trigger) {
    case 'confirm':
      return 'confirmed';
    case 'cancel':
      return 'cancelled';
    case 'hold':
      return 'put on hold';
    case 'release_hold':
      return 'taken off hold';
    case 'pack':
      return 'packed';
    case 'ship':
      return 'handed to a courier';
    case 'deliver':
      return 'marked delivered';
    case 'deliver_partially':
      return 'marked partially delivered';
    case 'start_return':
      return 'sent back';
    case 'receive_return':
      return 'received as a return';
    case 'exchange':
      return 'exchanged';
  }
}

function normaliseReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null;
  const trimmed = reason.trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, MAX_REASON);
}

/**
 * The Asia/Dhaka calendar date of the event (invariant 8).
 *
 * Carried on the result rather than left to the caller, so a status change and the
 * journal it causes cannot land on different business dates — which is exactly what
 * happens when one of them takes `new Date()` in UTC and it is half past nine at
 * night in Dhaka.
 */
function businessDateOf(at: Date): IsoDate {
  return businessDate(at);
}
