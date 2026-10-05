import { Inject, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { businessDate, poisha } from '@elysium/domain';
import { normalizeStatus, statusDedupeKey, type ParcelInput } from '@elysium/domain/courier';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope } from '../../platform/auth/scope.js';
import { emit } from '../../platform/events/outbox.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import type { ActiveContext } from '../../platform/http/context.js';
import {
  COURIER_ADAPTERS,
  type AdapterContext,
  type CourierAdapterRegistry,
} from './adapters/courier-adapter.js';
import { adapterEnabled, courierEnv } from './courier.config.js';
import { CourierError, databaseCourierCode } from './courier.errors.js';
import * as repo from './courier.repository.js';
import {
  COURIER_QUEUES,
  type BookParcelPayload,
  type CancelParcelPayload,
} from './courier.queues.js';
import { openCredentials } from './credentials.js';
import { CourierBookingRegistry } from '../orders/ports/courier-booking.port.js';
import { ORDERS_PORT, type OrdersPort } from './ports/orders.port.js';

/**
 * Booking a parcel, and the job that actually does it (architecture §9, §20; invariant 6).
 *
 * ## The shape invariant 6 forces
 *
 * Booking is an HTTP call to a courier. It may not happen inside the transaction that
 * confirms or packs the order, because that transaction holds a database connection and a
 * courier's slow afternoon would become our outage. So the flow is in two halves and the
 * seam between them is a pg-boss row:
 *
 *  1. `reserveConsignment(tx, …)` — **inside** the caller's transaction. It writes the
 *     consignment row in `pending` and enqueues `delivery.book_parcel` with
 *     `enqueue(tx, …)`. Both commit with the order's status change, or neither does. An
 *     order that rolled back has no parcel queued; an order that committed has exactly one.
 *  2. `runBooking(job)` — in the worker, with **no** transaction open. It reads what it
 *     needs, calls the courier, and then opens its own short transaction to record the
 *     answer.
 *
 * Nothing in this file calls an adapter inside a `withOrg`, and the two halves are separate
 * methods rather than one with a flag precisely so that reading it makes the rule obvious.
 *
 * ## Why the courier call sits between two transactions and not inside one
 *
 * The uncomfortable consequence is a window in which the courier has the parcel and we have
 * not recorded its number. §9 closes it by requiring `createParcel` to be idempotent on our
 * reference: the retry gets the same consignment number back rather than creating a second
 * parcel. That is the property that makes at-least-once delivery safe here, and it is why
 * `markBooked` is written to be a no-op when the number already matches.
 */

export interface BookingOutcome {
  readonly consignmentId: string;
  readonly enqueued: boolean;
}

@Injectable()
export class BookingService implements OnModuleInit {
  constructor(
    @Inject(COURIER_ADAPTERS) private readonly adapters: CourierAdapterRegistry,
    @Inject(ORDERS_PORT) private readonly orders: OrdersPort,
    private readonly audit: AuditService,
    private readonly bookings: CourierBookingRegistry,
  ) {}

  /**
   * Hand this service to the orders module, the way the settlements service hands its
   * executor to the approvals module.
   *
   * §9's `enqueue_courier_booking` and `enqueue_courier_cancel` are effects of a transition
   * and must run inside the transaction that moved the order, so the orders module has to
   * reach this class — while `reserveConsignment` has to reach the orders module for the
   * parcel's address. That is a provider cycle, not just a module one, and registration at
   * startup is how this codebase already breaks it: one arrow (courier → orders) and a
   * registry, rather than a `forwardRef` proxy around a cycle that is still there. See
   * `modules/orders/ports/courier-booking.port.ts`.
   */
  onModuleInit(): void {
    this.bookings.register(this);
  }

  /**
   * Whether a parcel is live with a courier for this order (§9's cancel).
   *
   * `pending` counts. A booking job that has not run yet is a parcel the courier is about
   * to be told about, and a cancel that ignored it would race the booking it is meant to
   * undo — the cancel job finds nothing, the booking job then creates the parcel, and a
   * cancelled order has a live consignment.
   */
  async hasLiveParcel(tx: Tx, orgId: string, orderId: string): Promise<boolean> {
    const existing = await repo.consignmentByOrder(tx, orgId, orderId);
    if (existing === undefined) return false;
    return existing.booking_state === 'pending' || existing.booking_state === 'booked';
  }

  /** The booked parcel's codes, for the buyer's tracking (M34, D-524). Null before booking. */
  async parcelTracking(
    tx: Tx,
    orgId: string,
    orderId: string,
  ): Promise<{
    courierId: string;
    consignmentNo: string | null;
    trackingCode: string | null;
  } | null> {
    const parcel = await repo.consignmentByOrder(tx, orgId, orderId);
    if (parcel?.booking_state !== 'booked') return null;
    return {
      courierId: parcel.courier_id,
      consignmentNo: parcel.consignment_no,
      trackingCode: parcel.tracking_code,
    };
  }

  /**
   * Create the consignment row and queue the booking, inside the caller's transaction.
   *
   * The method the orders module's `enqueue_courier_booking` effect calls, and the method a
   * desk's "book now" route calls for an org whose policy is `manual` (§9). Idempotent: an
   * order that already has a live parcel returns it rather than creating a second one, and
   * migration 0050's advisory-locked check refuses the second one anyway if two callers
   * race.
   */
  async reserveConsignment(
    tx: Tx,
    actor: { orgId: string; userId: string; requestId?: string | null },
    input: { orderId: string; courierId?: string | null },
  ): Promise<BookingOutcome> {
    // Locked: the COD copied onto the consignment below must be the one an advance
    // verification racing this booking either already lowered or will see as booked (D-231).
    const order = await this.orders.bookingSnapshot(tx, actor.orgId, input.orderId, {
      forUpdate: true,
    });
    if (order === null) {
      throw new CourierError('ORDER_NOT_FOUND', 'No such order in this organization.');
    }

    const existing = await repo.consignmentByOrder(tx, actor.orgId, input.orderId);
    if (
      existing !== undefined &&
      (existing.booking_state === 'pending' || existing.booking_state === 'booked')
    ) {
      // Already going. Returning it rather than refusing, because the two callers that get
      // here — the transition effect and the desk's button — both mean "make sure this is
      // booked", and an error would make the desk's button unusable after a policy change.
      return { consignmentId: existing.id, enqueued: false };
    }

    /*
     * The parcel goes with **the order's** courier, and only that one (M15).
     *
     * §7's delivery journal debits `courier_receivable` against the order's `courier_id` —
     * `TransitionsService.courierFor` takes the party from the order — while a settlement
     * credits the *consignment's* courier. A parcel booked with any other courier therefore
     * splits one COD across two parties: the order's courier carries a receivable no
     * statement ever relieves, the parcel's courier goes negative by the same amount, and
     * the org-wide total still balances, so nothing but a per-courier variance in the
     * reconciliation report ever shows it. M12 let the desk name a different courier here
     * ("overrides the order's own courier"), which did exactly that; M15's selection rules
     * would have done it for every rule-routed parcel.
     *
     * So the rules decide the *order's* courier — the desk applies the recommendation from
     * `GET /v1/courier/selection/preview` to the order, and the INTEGRATION notes ask the
     * orders module to consult them when it takes an order — and booking only ever uses the
     * courier the order already names. A different courier named here is refused with the fix.
     */
    const courierId = order.courierId;
    if (courierId === null) {
      throw new CourierError(
        'CONSIGNMENT_INVALID',
        'This order names no courier and its delivery zone has no default (§9). Set the order’s courier first.',
      );
    }
    if (
      input.courierId !== undefined &&
      input.courierId !== null &&
      input.courierId !== courierId
    ) {
      throw new CourierError(
        'CONSIGNMENT_INVALID',
        'This order is set to a different courier. Change the order’s courier first: the delivery’s receivable is booked against it (§7).',
      );
    }
    // The zone, copied onto the consignment so the performance report can group by it
    // without reading `sales.orders`.
    const facts = await this.orders.summary(tx, actor.orgId, input.orderId);
    const deliveryZoneId = facts?.deliveryZoneId ?? null;

    const account = await repo.accountByCourier(tx, actor.orgId, courierId);
    if (account === undefined) {
      throw new CourierError(
        'COURIER_ACCOUNT_NOT_FOUND',
        'That courier has no account set up in this organization.',
      );
    }
    if (!account.is_active) {
      throw new CourierError('COURIER_ACCOUNT_INVALID', 'That courier account is not active.');
    }
    const adapter = this.adapters.get(account.provider_code);
    if (adapter === undefined) {
      throw new CourierError(
        'COURIER_ACCOUNT_INVALID',
        `No adapter is built for "${account.provider_code}".`,
      );
    }
    if (!adapterEnabled(adapter)) {
      /*
       * An unverified adapter whose switch is off. Refused here, inside the transaction that
       * would have queued the booking, so no job is ever created for a courier the
       * installation has not agreed to trust (M15: the switch is read at every use).
       */
      throw new CourierError(
        'COURIER_ACCOUNT_INVALID',
        `The ${adapter.code} adapter is UNVERIFIED and switched off; set COURIER_${adapter.code.toUpperCase()}_ENABLED=true to book with it.`,
      );
    }

    const consignmentId = await repo.insertConsignment(tx, {
      orgId: actor.orgId,
      orderId: order.orderId,
      courierAccountId: account.id,
      courierId,
      branchId: order.branchId,
      // The order *number*, not its id. It is what the courier echoes on a settlement sheet
      // and what the settlement matcher's secondary key compares against, and a uuid on a
      // printed manifest is unreadable.
      reference: order.orderNo,
      codAmountPoisha: order.codAmountPoisha,
      createdBy: actor.userId,
      deliveryZoneId,
    });

    /*
     * The line invariant 6 exists for.
     *
     * `enqueue(tx, …)` writes the job through the caller's transaction, so the parcel is
     * queued if and only if the order's status change commits. `singletonKey` collapses a
     * second enqueue for the same consignment while one is still queued, which is what
     * makes it safe for two paths to both mean "make sure this is booked".
     */
    const payload: BookParcelPayload = {
      consignmentId,
      orderId: order.orderId,
      actorUserId: actor.userId,
    };
    await enqueue(tx, COURIER_QUEUES.book, payload, {
      orgId: actor.orgId,
      ref: consignmentId,
      requestId: actor.requestId ?? null,
      singletonKey: `book:${consignmentId}`,
    });

    return { consignmentId, enqueued: true };
  }

  /** The desk's "book this now" route, for an org whose policy is `manual` (§9). */
  async bookFromDesk(
    context: ActiveContext,
    request: AuditableRequest,
    input: { orderId: string; courierId?: string | undefined },
  ): Promise<BookingOutcome> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      /*
       * §6's branch narrowing, before the row exists.
       *
       * The order's branch is the parcel's branch, so it is what the caller's scope is
       * checked against — and it has to be checked *before* `reserveConsignment`, because
       * that method writes the consignment and enqueues the courier call. The scope backstop
       * answers 500 for a route that never applies scope, which is how this omission
       * surfaced: a branch manager booking another showroom's parcel is the thing it is
       * there to stop.
       */
      const order = await this.orders.statusOf(tx, context.orgId, input.orderId);
      if (order === null) {
        throw new CourierError('ORDER_NOT_FOUND', 'No such order in this organization.');
      }
      assertInScope(request, { branchId: order.branchId });

      const outcome = await this.reserveConsignment(
        tx,
        { orgId: context.orgId, userId: context.userId, requestId: context.requestId },
        { orderId: input.orderId, courierId: input.courierId ?? null },
      );

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'courier.booking.queued',
        entityType: 'Order',
        entityId: input.orderId,
        before: null,
        after: { consignmentId: outcome.consignmentId, enqueued: outcome.enqueued },
        requestId: context.requestId,
        request,
      });

      return outcome;
    });
  }

  /**
   * Book many orders from the desk at once (M15's bulk booking).
   *
   * One transaction **per order**, not one for the batch. A batch transaction would make one
   * order with a bad address roll back the forty good ones beside it, and the desk would have
   * to find the bad one by bisecting. Each order is scope-checked, reserved and enqueued on
   * its own, and the answer says what happened to every one.
   *
   * No courier is called here — each reservation enqueues `delivery.book_parcel` in its own
   * transaction, exactly as the single booking does (invariant 6).
   */
  async bookMany(
    context: ActiveContext,
    request: AuditableRequest,
    input: { orderIds: readonly string[]; courierId?: string | undefined },
  ): Promise<{
    results: readonly {
      orderId: string;
      consignmentId: string | null;
      enqueued: boolean;
      code: string | null;
    }[];
  }> {
    const results: {
      orderId: string;
      consignmentId: string | null;
      enqueued: boolean;
      code: string | null;
    }[] = [];

    // Distinct, in the order given: a pasted list with a repeat is one booking, not two.
    for (const orderId of [...new Set(input.orderIds)]) {
      try {
        const outcome = await this.bookFromDesk(context, request, {
          orderId,
          ...(input.courierId === undefined ? {} : { courierId: input.courierId }),
        });
        results.push({
          orderId,
          consignmentId: outcome.consignmentId,
          enqueued: outcome.enqueued,
          code: null,
        });
      } catch (error) {
        /*
         * One order's refusal is that order's answer. An order outside the caller's scope
         * answers exactly as a missing one does, so a bulk request cannot be used to learn
         * which ids exist in another branch.
         */
        const code =
          error instanceof CourierError
            ? error.code
            : error instanceof NotFoundException
              ? 'ORDER_NOT_FOUND'
              : (databaseCourierCode(error)?.code ?? null);
        if (code === null) throw error;
        results.push({ orderId, consignmentId: null, enqueued: false, code });
      }
    }

    return { results };
  }

  /** Queue a cancellation with the courier, inside the caller's transaction (§9). */
  async cancelConsignment(
    tx: Tx,
    actor: { orgId: string; userId: string; requestId?: string | null },
    orderId: string,
  ): Promise<{ consignmentId: string | null }> {
    const existing = await repo.consignmentByOrder(tx, actor.orgId, orderId);
    if (existing === undefined || existing.booking_state === 'cancelled') {
      return { consignmentId: null };
    }

    const payload: CancelParcelPayload = {
      consignmentId: existing.id,
      actorUserId: actor.userId,
    };
    await enqueue(tx, COURIER_QUEUES.cancel, payload, {
      orgId: actor.orgId,
      ref: existing.id,
      requestId: actor.requestId ?? null,
      singletonKey: `cancel:${existing.id}`,
    });
    return { consignmentId: existing.id };
  }

  // --- the worker half ----------------------------------------------------------

  /**
   * Book one parcel. Runs in the worker, with no transaction open.
   *
   * Reads, calls, then writes. The read and the write are separate short transactions with
   * the courier's network between them, which is the only arrangement invariant 6 allows —
   * and the reason `markBooked` is conditional rather than a plain UPDATE: between the two,
   * the same job may have been retried by another worker.
   */
  async runBooking(job: { orgId: string; payload: BookParcelPayload }): Promise<void> {
    const { orgId, payload } = job;
    const actor = { orgId, userId: payload.actorUserId };

    const prepared = await withOrg(actor, async (tx) => {
      const consignment = await repo.consignmentById(tx, orgId, payload.consignmentId);
      if (consignment === undefined) {
        // The order was cancelled and its transaction rolled back after the job was
        // enqueued — impossible with `enqueue(tx, …)` — or somebody is replaying an old
        // job. Either way there is nothing to book, and throwing would retry it five times.
        return null;
      }
      if (consignment.booking_state === 'booked' || consignment.booking_state === 'cancelled') {
        return null;
      }

      const account = await repo.accountById(tx, orgId, consignment.courier_account_id);
      if (account === undefined) {
        throw new CourierError('COURIER_ACCOUNT_NOT_FOUND', 'That courier account is gone.');
      }
      const order = await this.orders.bookingSnapshot(tx, orgId, consignment.order_id);
      if (order === null) {
        throw new CourierError('ORDER_NOT_FOUND', 'That order is gone.');
      }
      return { consignment, account, order };
    });

    if (prepared === null) return;
    const { consignment, account, order } = prepared;

    const adapter = this.adapters.get(account.provider_code);
    if (adapter === undefined || !adapterEnabled(adapter)) {
      /*
       * No adapter, or an unverified one switched off since the booking was queued. Nothing
       * any retry can change, so the parcel is flagged failed now rather than after five
       * attempts — see the non-retryable branch below.
       */
      await this.reportBookingFailed({
        orgId,
        consignmentId: consignment.id,
        code: 'COURIER_ACCOUNT_INVALID',
      });
      return;
    }

    const parcel: ParcelInput = {
      reference: consignment.reference,
      address: {
        recipientName: order.recipientName,
        recipientPhoneE164: order.recipientPhoneE164,
        district: order.district,
        thana: order.thana,
        area: order.area,
        addressLine: order.addressLine,
      },
      codAmountPoisha: poisha(BigInt(consignment.cod_amount_poisha)),
      itemDescription: order.itemSummary,
      note: order.notes,
      // The order's weight when every variant in it is weighed (M39b, D-645); otherwise the
      // adapter's configured default.
      weightGrams: order.weightGrams,
    };

    let result;
    try {
      // The outbound call. No transaction is open here, and that is the whole point.
      result = await adapter.createParcel(this.adapterContext(orgId, account), parcel);
    } catch (error) {
      if (error instanceof CourierError && !error.retryable) {
        /*
         * A refusal no retry can change: the courier rejected the parcel, the credentials, or
         * the COD (Pathao takes whole taka only). M12's comments said such a booking
         * "dead-letters on the first attempt", but nothing read `retryable` — every refusal
         * was re-thrown and pg-boss spent all five attempts, with backoff, before the order
         * was flagged. So the flag is raised here, now, through the same
         * `reportBookingFailed` the dead-letter handler uses, and the job completes: there is
         * nothing left for it to do.
         */
        await this.reportBookingFailed({
          orgId,
          consignmentId: consignment.id,
          code: error.code,
          // The adapter's own sentence, which is written never to quote the courier's body.
          message: error.message.slice(0, 500),
        });
        return;
      }
      await this.recordFailure(actor, consignment.id, error);
      throw error;
    }

    const normalized = normalizeStatus(
      adapter.statusMap,
      result.rawStatus ?? Object.keys(adapter.statusMap.statuses)[0] ?? 'booked',
    );

    await withOrg(actor, async (tx) => {
      const booked = await repo.markBooked(tx, {
        orgId,
        consignmentId: consignment.id,
        consignmentNo: result.consignmentNo,
        trackingCode: result.trackingCode,
        rawStatus: result.rawStatus,
        // A courier's own word for "created" maps to `booked` for most providers; when it
        // maps to something else we take the courier's word, because it knows.
        status: result.rawStatus === null ? 'booked' : normalized.status,
        at: new Date(),
      });
      if (!booked) return;

      const at = new Date();
      await repo.insertConsignmentEvent(tx, {
        orgId,
        consignmentId: consignment.id,
        source: 'poll',
        status: result.rawStatus === null ? 'booked' : normalized.status,
        rawStatus: result.rawStatus ?? 'booked',
        occurredAt: at,
        businessDate: businessDate(at),
        dedupeKey: statusDedupeKey({
          consignmentId: consignment.id,
          status: result.rawStatus === null ? 'booked' : normalized.status,
          occurredAt: at,
        }),
        payload: { consignmentNo: result.consignmentNo, trackingCode: result.trackingCode },
        webhookDeliveryId: null,
        appliedTrigger: null,
        orderFromStatus: null,
        orderToStatus: null,
      });

      await this.audit.record(tx, {
        orgId,
        actorUserId: payload.actorUserId,
        operation: 'update',
        action: 'courier.parcel.booked',
        entityType: 'Order',
        entityId: consignment.order_id,
        before: { bookingState: consignment.booking_state },
        after: { bookingState: 'booked', consignmentNo: result.consignmentNo },
      });
    });
  }

  /** Cancel one parcel with the courier. Runs in the worker. */
  async runCancel(job: { orgId: string; payload: CancelParcelPayload }): Promise<void> {
    const { orgId, payload } = job;
    const actor = { orgId, userId: payload.actorUserId };

    const prepared = await withOrg(actor, async (tx) => {
      const consignment = await repo.consignmentById(tx, orgId, payload.consignmentId);
      if (consignment === undefined || consignment.booking_state === 'cancelled') return null;
      const account = await repo.accountById(tx, orgId, consignment.courier_account_id);
      if (account === undefined) return null;
      return { consignment, account };
    });
    if (prepared === null) return;

    const adapter = this.adapters.get(prepared.account.provider_code);
    // An unverified adapter switched off is not called at all (M15: the switch is read at every
    // use). The parcel then comes back as a return, like one whose courier has no cancel.
    if (adapter !== undefined && !adapterEnabled(adapter)) return;
    // A courier with no cancel endpoint is not an error: §9 marks `cancelParcel` optional,
    // and the parcel simply comes back as a return. Marking it cancelled on our side would
    // be a lie about what the courier is holding.
    if (adapter?.cancelParcel === undefined || prepared.consignment.consignment_no === null) {
      return;
    }

    await adapter.cancelParcel(this.adapterContext(orgId, prepared.account), {
      consignmentNo: prepared.consignment.consignment_no,
      reference: prepared.consignment.reference,
      trackingCode: prepared.consignment.tracking_code,
    });

    await withOrg(actor, async (tx) => {
      await repo.markCancelled(tx, orgId, prepared.consignment.id);
    });
  }

  /**
   * Every retry spent (§20's dead letter; M12 acceptance check 6).
   *
   * Called by the dead-letter handler. Three things happen, and all three are the check:
   * the consignment is flagged `failed` so the order desk can see why nothing is moving,
   * `delivery.booking_failed` goes into the outbox for every org_admin (§19), and an audit
   * row records it. The event carries ids and the failure code — never the courier's error
   * body, which quotes the address and phone number we sent (§19, invariant 10).
   */
  async reportBookingFailed(input: {
    orgId: string;
    consignmentId: string;
    code: string;
    /** Why, when the caller knows better than "every attempt failed" (M15). */
    message?: string;
  }): Promise<void> {
    const actor = { orgId: input.orgId, userId: 'system:courier' };
    await withOrg(actor, async (tx) => {
      const consignment = await repo.consignmentById(tx, input.orgId, input.consignmentId);
      if (
        consignment === undefined ||
        consignment.booking_state === 'booked' ||
        // Already flagged. A dead-letter redelivery must not raise a second alert for one
        // failure, and a non-retryable refusal that already flagged it has said so once.
        consignment.booking_state === 'failed' ||
        consignment.booking_state === 'cancelled'
      ) {
        return;
      }

      await repo.recordBookingAttempt(tx, {
        orgId: input.orgId,
        consignmentId: input.consignmentId,
        code: input.code,
        message: input.message ?? 'Every booking attempt failed.',
        exhausted: true,
      });

      await emit(
        tx,
        'delivery.booking_failed',
        {
          orderId: consignment.order_id,
          orderNo: consignment.reference,
          consignmentId: consignment.id,
          courierId: consignment.courier_id,
          // An `ErrorCode`, never the courier's own message: its refusal body quotes the
          // recipient's name, address and phone number, and this event reaches every
          // org_admin through a socket that has no `serializeFor` in front of it
          // (§19, invariant 10).
          code: input.code,
          attempts: consignment.booking_attempts + 1,
        },
        { orgId: input.orgId },
      );

      await this.audit.record(tx, {
        orgId: input.orgId,
        actorUserId: null,
        operation: 'update',
        action: 'courier.booking.failed',
        entityType: 'Order',
        entityId: consignment.order_id,
        before: { bookingState: consignment.booking_state },
        after: { bookingState: 'failed', code: input.code },
      });
    });
  }

  /**
   * Decrypt at the moment of use, and hold the plaintext no longer than the call.
   *
   * A field on the service would keep every org's keys in memory for the life of the
   * process, where a heap dump or a `console.log` of `this` would have them all (§25).
   */
  private adapterContext(orgId: string, account: repo.CourierAccountRow): AdapterContext {
    const credentials: Record<string, string> = {};
    if (account.credentials !== null) {
      Object.assign(
        credentials,
        openCredentials(account.credentials, {
          orgId,
          accountId: account.courier_id,
          field: 'credentials',
        }),
      );
    }
    if (account.webhook_secret !== null) {
      const opened = openCredentials(account.webhook_secret, {
        orgId,
        accountId: account.courier_id,
        field: 'webhook_secret',
      });
      if (opened.webhookSecret !== undefined) {
        credentials.webhookSecret = opened.webhookSecret;
        // Steadfast's adapter calls it a bearer token; the fake calls it a secret. One
        // stored value, both names, so an operator configures it once.
        credentials.webhookToken ??= opened.webhookSecret;
      }
    }
    return {
      credentials: credentials,
      baseUrl: account.base_url,
      mode: account.mode,
      timeoutMs: courierEnv().COURIER_HTTP_TIMEOUT_MS,
    };
  }

  private async recordFailure(
    actor: { orgId: string; userId: string },
    consignmentId: string,
    error: unknown,
  ): Promise<void> {
    const code = error instanceof CourierError ? error.code : 'COURIER_UNAVAILABLE';
    await withOrg(actor, async (tx) => {
      await repo.recordBookingAttempt(tx, {
        orgId: actor.orgId,
        consignmentId,
        code,
        // The adapter's own message, which is written not to quote the courier's body. The
        // courier's body echoes the recipient's address and phone (invariant 10).
        message: error instanceof Error ? error.message.slice(0, 500) : 'Unknown failure.',
        exhausted: false,
      });
    });
  }
}
