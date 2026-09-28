import { Inject, Injectable } from '@nestjs/common';
import { withGlobal, withOrg, type Tx } from '@elysium/db';
import { businessDate, poisha } from '@elysium/domain';
import {
  isTerminalParcelStatus,
  normalizeStatus,
  orderTriggerFor,
  statusDedupeKey,
  type ParcelStatus,
} from '@elysium/domain/courier';
import { transitionFor } from '@elysium/domain';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { assertInScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import {
  COURIER_ADAPTERS,
  type AdapterContext,
  type CourierAdapterRegistry,
} from './adapters/courier-adapter.js';
import { courierEnv } from './courier.config.js';
import { CourierError } from './courier.errors.js';
import * as repo from './courier.repository.js';
import {
  COURIER_QUEUES,
  type PollOrgPayload,
  type ProcessWebhookPayload,
} from './courier.queues.js';
import { bodyHash, openCredentials } from './credentials.js';
import { ORDERS_PORT, type OrdersPort } from './ports/orders.port.js';
import type { ManualStatusInput } from './courier.schemas.js';

/**
 * Status sync: webhooks, polling, and the one place a courier status moves an order
 * (architecture §9, §20; M12 acceptance checks 2 and 3).
 *
 * ## Three layers stop a duplicate, and all three are wanted
 *
 * Acceptance check 3 is that "duplicate webhooks or polls never double-transition or
 * double-post". It is defended three times over, deliberately, because each layer catches
 * something the others cannot:
 *
 * 1. **The dedupe row.** `insertConsignmentEvent` is `on conflict (org_id, dedupe_key) do
 *    nothing`, and the key is `(consignment, status, occurred_at-to-the-second)` built by
 *    the domain so a webhook and a poll describing one fact produce one key. A duplicate
 *    returns no row and `apply` returns immediately: the state machine is never called.
 *    This is the only layer that also prevents the *attempt*, which matters — an attempt
 *    that the machine refuses is logged as a failure and eventually dead-letters a
 *    perfectly healthy webhook.
 * 2. **The state machine.** `orderTriggerFor(status, from)` returns null when the order is
 *    already where the status would put it. This is the layer that saves us when the
 *    courier reports the same delivery with two different timestamps — different keys, one
 *    fact.
 * 3. **The ledger's idempotency key.** The delivery journal is `order:<id>:delivered`, so
 *    even a transition that somehow ran twice posts one journal (§7, D-082).
 *
 * ## Why the webhook route stores and enqueues rather than processing inline
 *
 * §20: "raw payload is stored before processing". A courier retries aggressively when a
 * webhook is slow, and processing inline means the transition, the stock movements and the
 * journals all happen inside the request the courier is timing. So the route verifies
 * authenticity, stores the body, enqueues `delivery.process_webhook` and answers — and the
 * work happens in the worker where a retry is free.
 */
@Injectable()
export class CourierSyncService {
  constructor(
    @Inject(COURIER_ADAPTERS) private readonly adapters: CourierAdapterRegistry,
    @Inject(ORDERS_PORT) private readonly orders: OrdersPort,
    private readonly audit: AuditService,
  ) {}

  // --- the webhook entry point --------------------------------------------------

  /**
   * Accept a webhook (§9: "verify authenticity … store the raw payload … process in a job").
   *
   * The org comes from the URL and the *authenticity* comes from the secret, which is the
   * right way round: an org id is not a secret — it is in every API response — and a
   * routing scheme that treated it as one would be a scheme where knowing a uuid is enough
   * to mark parcels delivered. The secret is what decides, and it is compared in constant
   * time (`secretMatches`).
   *
   * The account read runs in `withOrg` for the org the URL names: a webhook has no session, so
   * there is no `ActiveContext` and no user, but the tenant policy still applies and the query
   * still runs as `erp_app`. Only *verified* deliveries are stored — a row in a tenant table is
   * a row somebody wrote into that tenant's data, and storing unauthenticated bodies would make
   * this table a place anyone on the internet could fill on a brand's behalf.
   */
  async acceptWebhook(input: {
    orgId: string;
    providerCode: string;
    headers: Readonly<Record<string, string | undefined>>;
    raw: Buffer;
  }): Promise<{ accepted: boolean; deliveryId: string | null; duplicate: boolean }> {
    const adapter = this.adapters.get(input.providerCode);
    if (adapter?.parseWebhook === undefined) {
      // A provider we have no adapter for, or one with no webhook. 401 rather than 404: a
      // public endpoint that distinguishes "no such courier" from "wrong secret" is an
      // endpoint that tells an attacker which providers an installation uses.
      throw new CourierError('WEBHOOK_SIGNATURE_INVALID', 'That webhook was not accepted.');
    }

    /*
     * `withOrg`, not `withSystem`.
     *
     * A webhook has no session, so there is no `ActiveContext` — but the org context still
     * comes from the URL and the transaction still runs as `erp_app` under the tenant policy.
     * The owner role would have worked and was wrong twice over: it is documented for
     * migrations and seeds only, and using it here would make `DATABASE_OWNER_URL` a runtime
     * requirement of the API process — for the one public, unauthenticated route in the module.
     *
     * `userId` is a marker, not a person: nothing on this path writes an audit row attributed
     * to a user, because no user did it.
     */
    const account = await withOrg({ orgId: input.orgId, userId: 'system:courier' }, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        select id from courier.courier_accounts
        where org_id = ${input.orgId} and provider_code = ${input.providerCode}
          and is_active and supports_webhook
      `);
      const id = rows[0]?.id;
      return id === undefined ? undefined : await repo.accountById(tx, input.orgId, id);
    });

    if (account === undefined) {
      throw new CourierError('WEBHOOK_SIGNATURE_INVALID', 'That webhook was not accepted.');
    }

    const context = this.adapterContext(input.orgId, account);
    const events = await adapter.parseWebhook(context, {
      headers: input.headers,
      raw: input.raw,
    });
    if (events === null) {
      throw new CourierError('WEBHOOK_SIGNATURE_INVALID', 'That webhook was not accepted.');
    }

    const stored = await withOrg({ orgId: input.orgId, userId: 'system:courier' }, async (tx) => {
      const delivery = await repo.insertWebhookDelivery(tx, {
        orgId: input.orgId,
        courierAccountId: account.id,
        providerCode: input.providerCode,
        bodyHash: bodyHash(input.raw),
        /*
         * The **normalized events**, not just their payloads.
         *
         * Storing `events.map((event) => event.payload)` lost the one field that decides how
         * much money a delivery is worth: neither adapter's payload allow-list carries a
         * collected amount — correctly, because that list exists to keep the recipient's name,
         * phone and address out of a jsonb column — so `collectedPoisha` was dropped here and
         * the worker fell back to the full COD. Every partial delivery arriving by webhook was
         * then booked as a full collection: revenue and `courier_receivable` overstated by the
         * shortfall, and the courier's own statement flagged as an `amount_mismatch` a person
         * had to clear by hand, per parcel.
         *
         * A collected amount is money, not PII, so it belongs in the stored row. The
         * recipient's details still do not: `payload` is the adapter's stripped allow-list and
         * is carried through unchanged.
         */
        body: events.map((event) => ({
          consignmentNo: event.consignmentNo,
          reference: event.reference,
          rawStatus: event.rawStatus,
          occurredAt: event.occurredAt?.toISOString() ?? null,
          collectedPoisha: event.collectedPoisha,
          payload: event.payload,
        })),
        // An allow-list of headers. `Authorization` must never land here: it is the
        // courier's bearer token, which is also our stored secret (invariant 10).
        headers: pickHeaders(input.headers),
      });

      if (delivery.created) {
        const payload: ProcessWebhookPayload = {
          deliveryId: delivery.id,
          courierAccountId: account.id,
        };
        // Enqueued inside the same transaction as the stored body, so the two cannot
        // disagree: a stored payload always has a job, and a job always has a payload.
        await enqueue(tx, COURIER_QUEUES.webhook, payload, {
          orgId: input.orgId,
          ref: delivery.id,
          singletonKey: `webhook:${delivery.id}`,
        });
      }
      return delivery;
    });

    // A retransmission answers 200, not 409. A courier that gets an error for re-sending a
    // body it already sent will send it again, sooner.
    return { accepted: true, deliveryId: stored.id, duplicate: !stored.created };
  }

  /** Process one stored webhook body. Runs in the worker (§20). */
  async runWebhook(job: { orgId: string; payload: ProcessWebhookPayload }): Promise<void> {
    const { orgId, payload } = job;
    const actor = { orgId, userId: 'system:courier' };

    const prepared = await withOrg(actor, async (tx) => {
      const rows = await tx.execute<{ body: unknown; processed_at: string | null }>(sql`
        select body, processed_at from courier.webhook_deliveries
        where org_id = ${orgId} and id = ${payload.deliveryId}
      `);
      const row = rows[0];
      // Gone, or already processed. Both mean there is nothing to do, and both have to be
      // silent rather than thrown: a retry of a job whose work is done would otherwise spend
      // the queue's attempts and dead-letter a webhook that was handled correctly.
      if ((row?.processed_at ?? null) !== null || row === undefined) return null;
      const account = await repo.accountById(tx, orgId, payload.courierAccountId);
      if (account === undefined) return null;
      return { body: row.body, account };
    });
    if (prepared === null) return;

    const adapter = this.adapters.get(prepared.account.provider_code);
    if (adapter === undefined) return;

    /*
     * The stored body is the adapter's normalized events — not the courier's raw bytes.
     * Re-verifying a signature here would be impossible (the headers are gone) and pointless:
     * the row exists only because verification passed at the door.
     *
     * Parsed against a schema rather than read field by field. `courier.webhook_deliveries` is
     * a table this application writes, so the shape is ours — but it is also a table a *past
     * deploy* wrote, and a hand-rolled read of `row.collectedPoisha` would silently see
     * `undefined` for a row written before that field existed and fall back to the full COD.
     * A parse says so instead.
     */
    const entries = storedEventsSchema.safeParse(prepared.body);
    if (!entries.success) {
      await withOrg(actor, (tx) =>
        repo.markWebhookProcessed(tx, {
          orgId,
          id: payload.deliveryId,
          eventCount: 0,
          error: 'This webhook was stored in a shape this deploy cannot read.',
        }),
      );
      return;
    }

    let applied = 0;
    let failure: string | null = null;

    for (const event of entries.data) {
      if (event.consignmentNo === null || event.rawStatus === null) continue;

      const at = event.occurredAt === null ? null : new Date(event.occurredAt);

      try {
        const outcome = await this.applyStatus({
          orgId,
          courierAccountId: prepared.account.id,
          consignmentNo: event.consignmentNo,
          rawStatus: event.rawStatus,
          occurredAt: at !== null && !Number.isNaN(at.getTime()) ? at : new Date(),
          // The figure §7's delivery journal debits `courier_receivable` with. Null only when
          // the courier genuinely did not say, which is what the fallback in `applyStatusIn`
          // is for — and that fallback is now reached only in that case.
          collectedPoisha: event.collectedPoisha,
          source: 'webhook',
          webhookDeliveryId: payload.deliveryId,
          statusMapCode: prepared.account.provider_code,
          actorUserId: 'system:courier',
        });
        if (outcome.recorded) applied += 1;
      } catch (error) {
        // Recorded on the delivery row and re-thrown, so the job retries: the payload is
        // durable, so a retry is cheap, and three attempts is the queue's budget.
        failure = error instanceof Error ? error.message.slice(0, 500) : 'Unknown failure.';
        await withOrg(actor, (tx) =>
          repo.markWebhookProcessed(tx, {
            orgId,
            id: payload.deliveryId,
            eventCount: applied,
            error: failure,
          }),
        );
        throw error;
      }
    }

    await withOrg(actor, (tx) =>
      repo.markWebhookProcessed(tx, {
        orgId,
        id: payload.deliveryId,
        eventCount: applied,
        error: null,
      }),
    );
  }

  // --- the polling fallback -----------------------------------------------------

  /**
   * §20's cron: fan one tenant job out per org.
   *
   * The cron queue is global because it fires once for the installation; this is the handler
   * that turns that into one tenant job per org, each of which opens its own `withOrg`. Doing
   * the courier calls here instead would mean one org's rate limit blocking every other org's
   * parcels.
   *
   * ## Why the org list comes from `org.organizations` and not from the accounts
   *
   * The obvious query — `select distinct org_id from courier.courier_accounts where is_active`
   * — returns **nothing, ever**. `courier_accounts` is FORCE row-level security with the
   * standard policy, and there is no tenant to be inside while deciding which tenants exist:
   * `app.org_id` is unset, the policy evaluates `org_id = NULL`, and no row matches. Not even
   * `erp_owner` is exempt, because FORCE is exactly what removes the owner's exemption. The
   * first version of this method did that, and it made the half-hourly cron a silent no-op:
   * nothing enqueued, nothing logged, and for any courier whose webhook was missing or missed,
   * no status ever synced — so no delivery journal, no receivable, and then every row of that
   * courier's statement unmatched, with the COD sitting at the courier unrecorded.
   *
   * `org.organizations` is global by design (§5 exception 5) and carries no tenant policy, so
   * it is the only table that can answer "which tenants exist". Whether a given org has an
   * active courier account is then a question asked **inside** that org's context — which is
   * where the answer is knowable, and which is the pattern M07's nightly reconciliation
   * already uses (`inventory/reconcile.service.ts`).
   */
  async runPollFanOut(): Promise<number> {
    const orgIds = await withGlobal(async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        select id from org.organizations where is_active order by slug
      `);
      return [...rows].map((row) => row.id);
    });

    let enqueued = 0;
    for (const orgId of orgIds) {
      // Inside the org, so the policy can see the account. An org with no active courier is
      // skipped rather than given a job that would find nothing to poll.
      const hasCourier = await withOrg({ orgId, userId: 'system:courier' }, async (tx) => {
        const rows = await tx.execute<{ present: boolean }>(sql`
          select exists (
            select 1 from courier.courier_accounts where org_id = ${orgId} and is_active
          ) as present
        `);
        return rows[0]?.present === true;
      });
      if (!hasCourier) continue;

      await withOrg({ orgId, userId: 'system:courier' }, async (tx) => {
        const payload: PollOrgPayload = { limit: 100 };
        await enqueue(tx, COURIER_QUEUES.pollOrg, payload, {
          orgId,
          ref: orgId,
          // While a sweep for this org is queued, another is dropped. Two overlapping sweeps
          // would double the courier's rate-limit consumption for no new information.
          singletonKey: `poll:${orgId}`,
        });
      });
      enqueued += 1;
    }

    return enqueued;
  }

  /** Ask the courier about one org's stale parcels (§9's polling fallback). */
  async runPollOrg(job: { orgId: string; payload: PollOrgPayload }): Promise<number> {
    const { orgId, payload } = job;
    const actor = { orgId, userId: 'system:courier' };

    const stale = await withOrg(actor, (tx) => repo.staleConsignments(tx, orgId, payload.limit));
    let moved = 0;

    for (const consignment of stale) {
      if (consignment.consignment_no === null) continue;

      const account = await withOrg(actor, (tx) =>
        repo.accountById(tx, orgId, consignment.courier_account_id),
      );
      if (account === undefined) continue;
      const adapter = this.adapters.get(account.provider_code);
      if (adapter === undefined) continue;

      let answer;
      try {
        // Outside any transaction, one parcel at a time. A courier that starts refusing
        // mid-sweep leaves the parcels it already answered about recorded, which is why the
        // poll is not one big transaction.
        answer = await adapter.getStatus(this.adapterContext(orgId, account), {
          consignmentNo: consignment.consignment_no,
          reference: consignment.reference,
          trackingCode: consignment.tracking_code,
        });
      } catch {
        // A courier that cannot answer about one parcel should not stop the sweep. The row
        // is marked polled so the next sweep does not start with the same parcel.
        await withOrg(actor, (tx) => repo.markPolled(tx, orgId, consignment.id, new Date()));
        continue;
      }

      await withOrg(actor, (tx) => repo.markPolled(tx, orgId, consignment.id, new Date()));

      const outcome = await this.applyStatus({
        orgId,
        courierAccountId: account.id,
        consignmentNo: consignment.consignment_no,
        rawStatus: answer.rawStatus,
        /*
         * The courier's instant when it gives one, ours when it does not.
         *
         * A status endpoint that returns no timestamp — Steadfast's does not — makes the
         * dedupe key weaker, because the same unchanged status polled an hour later produces
         * a different key and a second event row. That is the right trade: the *transition*
         * is still deduped by `orderTriggerFor` returning null for an order already in that
         * state, so the cost is a duplicate row in the timeline rather than a double posting.
         */
        occurredAt: answer.occurredAt ?? new Date(),
        collectedPoisha: answer.collectedPoisha,
        source: 'poll',
        webhookDeliveryId: null,
        statusMapCode: account.provider_code,
        actorUserId: 'system:courier',
      });
      if (outcome.transitioned) moved += 1;
    }

    return moved;
  }

  // --- the manual fallback ------------------------------------------------------

  /**
   * A status a person sets because the courier's sync has not caught up (§9).
   *
   * "Until courier sync covers a status, staff can set `delivered`, `partially_delivered`
   * and `returned` manually, with a reason. The postings are the same." The postings are
   * the same because this takes the identical path: the same event row, the same dedupe
   * key, the same `applyTrigger`. A second code path that posted its own journals is how
   * the manual and automatic routes would come to disagree.
   */
  async setStatusManually(
    context: ActiveContext,
    request: AuditableRequest,
    consignmentId: string,
    input: ManualStatusInput,
  ) {
    const at = input.occurredAt === undefined ? new Date() : new Date(input.occurredAt);

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const consignment = await repo.consignmentForUpdate(tx, context.orgId, consignmentId);
      if (consignment === undefined) {
        throw new CourierError('CONSIGNMENT_NOT_FOUND', 'No such consignment.');
      }
      // Before anything moves: this fallback posts §7's journals, so a caller outside the
      // parcel's branch must be refused here rather than by a later constraint.
      assertInScope(request, { branchId: consignment.branch_id });

      const outcome = await this.applyStatusIn(tx, {
        orgId: context.orgId,
        consignment,
        status: input.status,
        rawStatus: input.rawStatus,
        occurredAt: at,
        collectedPoisha: input.collectedPoisha ?? null,
        source: 'manual',
        webhookDeliveryId: null,
        actorUserId: context.userId,
        reason: input.reason,
        deliveredLines: input.deliveredLines,
        request,
        context,
      });

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'courier.status.set_manually',
        entityType: 'Order',
        entityId: consignment.order_id,
        before: { status: consignment.status },
        after: {
          status: input.status,
          rawStatus: input.rawStatus,
          reason: input.reason,
          recorded: outcome.recorded,
          orderTo: outcome.orderTo,
        },
        requestId: context.requestId,
        request,
      });

      return outcome;
    });
  }

  // --- the one place a courier status is applied --------------------------------

  /**
   * Apply one courier status, in its own transaction.
   *
   * The consignment is located by the courier's number and **locked** before anything is
   * decided, because a webhook and a poll arriving in the same second would otherwise both
   * read `shipped`, both decide to deliver, and both perform their effects before one of
   * their updates lost. The dedupe index catches the second insert — but only after the
   * second transition has already posted a journal.
   */
  private async applyStatus(input: {
    orgId: string;
    courierAccountId: string;
    consignmentNo: string;
    rawStatus: string;
    occurredAt: Date;
    collectedPoisha: string | null;
    source: 'webhook' | 'poll';
    webhookDeliveryId: string | null;
    statusMapCode: string;
    actorUserId: string;
  }): Promise<{ recorded: boolean; transitioned: boolean; orderTo: string | null }> {
    const adapter = this.adapters.get(input.statusMapCode);
    if (adapter === undefined) {
      throw new CourierError(
        'COURIER_ACCOUNT_INVALID',
        `No adapter is built for "${input.statusMapCode}".`,
      );
    }
    const normalized = normalizeStatus(adapter.statusMap, input.rawStatus);

    return withOrg({ orgId: input.orgId, userId: input.actorUserId }, async (tx) => {
      const consignment = await repo.consignmentByNumber(
        tx,
        input.orgId,
        input.courierAccountId,
        input.consignmentNo,
      );
      if (consignment === undefined) {
        /*
         * A status for a parcel we have no row for.
         *
         * Not an error. A courier that also carries another system's parcels, or a webhook
         * for a parcel booked before this installation existed, both look like this — and
         * throwing would retry it three times and then dead-letter a webhook nobody can act
         * on. Recorded as nothing, and the delivery row's `event_count` shows the gap.
         */
        return { recorded: false, transitioned: false, orderTo: null };
      }

      return this.applyStatusIn(tx, {
        orgId: input.orgId,
        consignment,
        status: normalized.status,
        rawStatus: normalized.raw,
        occurredAt: input.occurredAt,
        collectedPoisha: input.collectedPoisha,
        source: input.source,
        webhookDeliveryId: input.webhookDeliveryId,
        actorUserId: input.actorUserId,
        reason: null,
        request: undefined,
        context: undefined,
      });
    });
  }

  /** The body of `applyStatus`, inside a transaction the caller owns. */
  private async applyStatusIn(
    tx: Tx,
    input: {
      orgId: string;
      consignment: repo.ConsignmentRow;
      status: ParcelStatus;
      rawStatus: string;
      occurredAt: Date;
      collectedPoisha: string | null;
      source: 'webhook' | 'poll' | 'manual';
      webhookDeliveryId: string | null;
      actorUserId: string;
      reason: string | null;
      deliveredLines?: readonly { skuId: string; deliveredQty: number }[] | undefined;
      request?: AuditableRequest | undefined;
      context?: ActiveContext | undefined;
    },
  ): Promise<{ recorded: boolean; transitioned: boolean; orderTo: string | null }> {
    const { consignment } = input;

    /*
     * Layer 1 of acceptance check 3.
     *
     * The event row goes in first, and its absence ends the call. `do nothing` on the dedupe
     * index means this exact fact has been recorded before, so nothing is transitioned and
     * nothing is posted — and, just as importantly, nothing is *attempted*, so a duplicate
     * webhook does not show up in the logs as a refused transition.
     */
    const dedupeKey = statusDedupeKey({
      consignmentId: consignment.id,
      status: input.status,
      occurredAt: input.occurredAt,
    });

    const order = await this.orders.statusOf(tx, input.orgId, consignment.order_id);
    if (order === null) {
      throw new CourierError('ORDER_NOT_FOUND', 'That consignment’s order is gone.');
    }

    // Layer 2: the machine has nothing to do for a status the order has already taken.
    const trigger = orderTriggerFor(input.status, order.status);

    const event = await repo.insertConsignmentEvent(tx, {
      orgId: input.orgId,
      consignmentId: consignment.id,
      source: input.source,
      status: input.status,
      rawStatus: input.rawStatus,
      occurredAt: input.occurredAt,
      businessDate: businessDate(input.occurredAt),
      dedupeKey,
      payload: { rawStatus: input.rawStatus },
      webhookDeliveryId: input.webhookDeliveryId,
      appliedTrigger: trigger,
      orderFromStatus: order.status,
      /*
       * Where the order is about to be, written now rather than updated after.
       *
       * `courier.consignment_events` is append-only — `erp_app` holds no UPDATE on it and
       * migration 0050 raises on one — because an event is the record of what a courier said.
       * So the destination cannot be filled in once the transition has run, and it does not
       * need to be: §9's table determines `to` from `(from, trigger)`, and if the transition
       * then fails the whole transaction rolls back, so a recorded destination is never one
       * the order did not reach.
       */
      orderToStatus: trigger === null ? null : (transitionFor(order.status, trigger)?.to ?? null),
    });
    if (event === undefined) {
      return { recorded: false, transitioned: false, orderTo: null };
    }

    const collected = input.collectedPoisha === null ? null : BigInt(input.collectedPoisha);

    /*
     * The tracking half of the row: where the courier says the parcel is, and when it last
     * said anything. Always written, because it is true whatever the order is doing — and the
     * poller's staleness window depends on `last_status_at` moving.
     */
    await repo.applyConsignmentStatus(tx, {
      orgId: input.orgId,
      consignmentId: consignment.id,
      status: input.status,
      rawStatus: input.rawStatus,
      occurredAt: input.occurredAt,
    });

    if (trigger === null) {
      /*
       * Recorded, and deliberately **nothing else**.
       *
       * `collected_poisha`, `delivered_at` and `returned_at` are *not* written here, and that
       * is the whole point of this early return being where it is. Those three are the money
       * half of the row: `settlementCandidates` reports `collected_poisha` as what the courier
       * owes us for this parcel, and §7's delivery journal is what puts the matching debit on
       * `courier_receivable`. Writing the figure without the journal — which is what happens
       * whenever a `delivered` event reaches an order that is not `shipped`, so a late webhook
       * after a return, or a parcel whose order never shipped — would make the consignment a
       * matchable settlement candidate whose credit has no debit behind it. The two journals
       * would then drive the courier's balance *negative*, and the only symptom would be a
       * variance in the reconciliation report.
       *
       * So the money columns are written by the branch below, after the transition has
       * actually happened. The event row still records what the courier said, which is what
       * makes the discrepancy investigable.
       */
      return { recorded: true, transitioned: false, orderTo: null };
    }

    /*
     * Layer 3 lives in the orders module: every journal it posts carries
     * `order:<id>:<event>` as its idempotency key, so the same transition somehow run twice
     * posts one journal (§7, D-082).
     *
     * `receive_return` is never reached from here: `orderTriggerFor` returns null for
     * `returned_to_merchant`, because §9 gives that move to the warehouse receiving and
     * inspecting. `ReturnsService` is the only caller that produces it.
     */
    const context =
      input.context ?? ({ orgId: input.orgId, userId: input.actorUserId } as ActiveContext);
    const applied = await this.orders.applyTrigger(tx, context, input.request, {
      orderId: consignment.order_id,
      trigger,
      occurredAt: input.occurredAt,
      reason: input.reason,
      ...(input.status === 'delivered' || input.status === 'partial_delivered'
        ? {
            collectedPoisha: poisha(collected ?? BigInt(consignment.cod_amount_poisha)),
          }
        : {}),
      ...(input.deliveredLines === undefined ? {} : { deliveredLines: input.deliveredLines }),
    });

    if (applied !== null) {
      /*
       * The money half, now that the journal exists.
       *
       * `collectedPoisha` is what §7's delivery journal just debited `courier_receivable` with,
       * so this column and that debit are the same number by construction — which is the
       * property the settlement matcher and acceptance check 5 both rest on.
       *
       * The fallback to the full COD is for a courier that reports "delivered" without an
       * amount: it collected everything, and recording null would leave the matcher expecting
       * zero from every such parcel. It is reached only when the courier genuinely said nothing,
       * because the webhook path now carries the reported figure through the stored event.
       */
      await repo.recordConsignmentOutcome(tx, {
        orgId: input.orgId,
        consignmentId: consignment.id,
        occurredAt: input.occurredAt,
        collectedPoisha:
          input.status === 'delivered' || input.status === 'partial_delivered'
            ? (collected ?? BigInt(consignment.cod_amount_poisha))
            : collected,
        delivered: input.status === 'delivered' || input.status === 'partial_delivered',
        returned: input.status === 'returned_to_merchant',
      });
    }

    return {
      recorded: true,
      transitioned: applied !== null,
      orderTo: applied?.to ?? null,
    };
  }

  /** The timeline for one parcel (M12's tracking bullet). */
  async timeline(context: ActiveContext, request: object, consignmentId: string) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const consignment = await repo.consignmentById(tx, context.orgId, consignmentId);
      if (consignment === undefined) {
        throw new CourierError('CONSIGNMENT_NOT_FOUND', 'No such consignment.');
      }
      // §6's branch narrowing, on the parcel's own branch, exactly as the returns screen
      // applies it. Without it a branch manager could read another showroom's parcel — and
      // the scope backstop answers 500 rather than letting that happen silently.
      assertInScope(request, { branchId: consignment.branch_id });
      const events = await repo.consignmentTimeline(tx, context.orgId, consignmentId);
      return {
        consignment: {
          id: consignment.id,
          orderId: consignment.order_id,
          orderNo: consignment.reference,
          courierId: consignment.courier_id,
          consignmentNo: consignment.consignment_no,
          trackingCode: consignment.tracking_code,
          bookingState: consignment.booking_state,
          bookingAttempts: consignment.booking_attempts,
          bookingFailureCode: consignment.booking_failure_code,
          status: consignment.status,
          rawStatus: consignment.raw_status,
          codAmountPoisha: consignment.cod_amount_poisha,
          collectedPoisha: consignment.collected_poisha,
          bookedAt: consignment.booked_at,
          handoverConfirmedAt: consignment.handover_confirmed_at,
          deliveredAt: consignment.delivered_at,
          returnedAt: consignment.returned_at,
          settlementId: consignment.settlement_id,
          settledAt: consignment.settled_at,
          isFinal: isTerminalParcelStatus(consignment.status as ParcelStatus),
        },
        events: events.map((event) => ({
          id: event.id,
          source: event.source,
          status: event.status,
          rawStatus: event.raw_status,
          occurredAt: event.occurred_at,
          businessDate: event.business_date,
          appliedTrigger: event.applied_trigger,
          orderFromStatus: event.order_from_status,
          orderToStatus: event.order_to_status,
        })),
      };
    });
  }

  /** Confirming a rider physically took the parcel (M12's handover bullet). */
  async confirmHandover(
    context: ActiveContext,
    request: AuditableRequest,
    consignmentId: string,
    input: { occurredAt?: string | undefined; note?: string | undefined },
  ) {
    const at = input.occurredAt === undefined ? new Date() : new Date(input.occurredAt);

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const consignment = await repo.consignmentForUpdate(tx, context.orgId, consignmentId);
      if (consignment === undefined) {
        throw new CourierError('CONSIGNMENT_NOT_FOUND', 'No such consignment.');
      }
      assertInScope(request, { branchId: consignment.branch_id });
      if (consignment.booking_state !== 'booked') {
        // Handover is a fact about a parcel the courier has accepted. Confirming it for an
        // unbooked parcel would mean the warehouse had handed a box to a rider with no
        // consignment number on it — worth refusing rather than recording.
        throw new CourierError(
          'CONSIGNMENT_INVALID',
          'This parcel is not booked with the courier yet.',
        );
      }

      /*
       * The handover **does not** move the order.
       *
       * §9 gives `confirmed → shipped` and `packed → shipped` the trigger `ship`, whose
       * effects are consuming the reservation, the dispatch movement and the goods-in-transit
       * journal — and the warehouse performs that when the box leaves, through the orders
       * module. This is the courier-side confirmation that a rider signed for it, which is
       * what an argument about a lost parcel is settled with. Making it also ship the order
       * would give one physical event two owners and two chances to post the handover journal.
       */
      const confirmed = await repo.confirmHandover(tx, {
        orgId: context.orgId,
        consignmentId,
        at,
        by: context.userId,
      });

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'courier.handover.confirmed',
        entityType: 'Order',
        entityId: consignment.order_id,
        before: { handoverConfirmedAt: consignment.handover_confirmed_at },
        after: { handoverConfirmedAt: at, note: input.note ?? null, changed: confirmed },
        requestId: context.requestId,
        request,
      });

      return {
        consignmentId,
        // An ISO string either way: the row's own value is the driver's text, and a response
        // that returned a string on one path and a Date on the other would serialise
        // differently depending on whether the caller was first.
        handoverConfirmedAt: confirmed
          ? at.toISOString()
          : new Date(consignment.handover_confirmed_at ?? at).toISOString(),
      };
    });
  }

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
}

/**
 * What `courier.webhook_deliveries.body` holds, as a schema.
 *
 * One row per normalized event the adapter produced. `payload` is the adapter's own stripped
 * allow-list and is not inspected here — it exists so a mapping that turns out wrong can be
 * corrected against what the courier actually said.
 *
 * `collectedPoisha` is required rather than optional on purpose: a row written before this
 * field existed fails the parse and is marked with a message, instead of silently reading as
 * "the courier said nothing" and booking the full COD.
 */
const storedEventsSchema = z.array(
  z
    .object({
      consignmentNo: z.string().nullable(),
      reference: z.string().nullable(),
      rawStatus: z.string().nullable(),
      occurredAt: z.string().nullable(),
      collectedPoisha: z.string().nullable(),
      payload: z.unknown(),
    })
    .strip(),
);

/**
 * The headers worth keeping, by name.
 *
 * An allow-list, because the one that must never be stored is `authorization` — the
 * courier's bearer token, which is also the secret we hold for it — and a deny-list is one
 * forgotten spelling away from writing it into every backup (invariant 10, §25).
 */
function pickHeaders(
  headers: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of ['content-type', 'user-agent', 'x-request-id']) {
    const value = headers[name];
    if (value !== undefined) kept[name] = value.slice(0, 200);
  }
  return kept;
}
