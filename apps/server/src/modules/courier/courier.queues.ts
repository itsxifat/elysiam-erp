import { z } from 'zod';

import type { QueueDefinition } from '../../platform/jobs/queues.js';

/**
 * The courier module's queues (architecture §20, invariant 6).
 *
 * §20's table names four, and all four are here because this module both enqueues and
 * works every one of them — `PLATFORM_QUEUES` is empty on purpose, and a queue without
 * its handler is a backlog nobody is draining.
 *
 * Invariant 6 is why these exist at all. Booking a parcel is an HTTP call to Steadfast,
 * and it may not happen inside the transaction that confirms or packs the order: a
 * courier's slow afternoon would hold a database connection open and turn their outage
 * into ours. So the transition enqueues `delivery.book_parcel` with `enqueue(tx, …)`, the
 * job row commits with the status change, and the outbound call happens in the worker
 * where no transaction is open.
 *
 * `delivery.book_parcel` keeps §20's stated five retries, which is also the house default
 * — restated here rather than omitted because it is the one number §20 gives, and a
 * future change to `QUEUE_DEFAULTS` should not silently change the courier's retry
 * budget.
 *
 * ## `delivery.import_settlement` is deliberately not here
 *
 * §20 lists it for "on upload or API fetch". The upload half needs no job: parsing a CSV
 * and matching it against our own consignments involves no outbound call, so invariant 6
 * does not apply — and a job would move a parse that can fail into a place where its
 * failure is a dead-letter row rather than a message on the screen of the person who just
 * chose the file. Posting is not in the job either: it happens inside the transaction
 * that approves the batch, through the approvals executor (§9: "→ approval → posting").
 *
 * The API-fetch half *is* an outbound call and does need the queue. It arrives with M15,
 * which is where `fetchSettlements` on the adapter becomes real.
 */
export const COURIER_QUEUES = {
  book: 'delivery.book_parcel',
  cancel: 'delivery.cancel_parcel',
  webhook: 'delivery.process_webhook',
  /** §20's cron. Global: it fires once and fans out one tenant job per org. */
  poll: 'delivery.poll_status',
  /** The per-org half of the poll, which is where the courier calls actually happen. */
  pollOrg: 'delivery.poll_org',
} as const;

export const COURIER_QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    name: COURIER_QUEUES.book,
    scope: 'org',
    // §20: "5 retries, then dead-letter → booking_failed".
    retryLimit: 5,
    retryDelaySeconds: 5,
    retryDelayMaxSeconds: 900,
    // A courier's API answers in seconds or not at all, and the adapter's own timeout is
    // well under a minute. Two minutes rather than §20's fifteen, so a worker that died
    // holding a booking gets it retried inside the window a customer is still on the
    // phone.
    expireInSeconds: 120,
  },
  {
    name: COURIER_QUEUES.cancel,
    scope: 'org',
    retryLimit: 5,
    retryDelaySeconds: 5,
    expireInSeconds: 120,
  },
  {
    name: COURIER_QUEUES.webhook,
    scope: 'org',
    /*
     * §20: "Raw payload is stored before processing."
     *
     * Three retries rather than five. The payload is already durable, so a retry here is
     * only re-running the transition — and a webhook that has failed three times is
     * failing for a reason retrying will not fix (an order in a state the machine
     * refuses), so the fourth attempt is just a slower way of dead-lettering.
     */
    retryLimit: 3,
    retryDelaySeconds: 3,
    expireInSeconds: 120,
  },
  {
    name: COURIER_QUEUES.poll,
    /*
     * Global, because §20's "every 30 min for stale active parcels" fires once for the
     * installation. Its handler fans out one tenant job per org — which is what
     * `assertValidQueue` insists on: a cron on a tenant queue would have to invent an org
     * id, and the one it would invent is whichever org is first in the seed.
     */
    scope: 'global',
    cron: '*/30 * * * *',
    retryLimit: 2,
    retryDelaySeconds: 60,
    // A sweep across every org's stale parcels, each a courier round trip. Ten minutes,
    // because the default fifteen is longer than the cron interval and two overlapping
    // sweeps would double every courier's rate-limit consumption.
    expireInSeconds: 600,
  },
  {
    name: COURIER_QUEUES.pollOrg,
    scope: 'org',
    retryLimit: 2,
    retryDelaySeconds: 30,
    expireInSeconds: 300,
  },
];

/*
 * The payloads.
 *
 * Parsed rather than cast on the way out of the queue, for the reason `envelope.ts` gives
 * about `pgboss.job`: it is not our table, it has no RLS, and a handler that trusted a
 * cast payload would happily book a parcel for whatever consignment id it found. Money is
 * a decimal string, because JSON has no integer wide enough (invariant 1).
 */

export const bookParcelPayload = z
  .object({
    consignmentId: z.string().uuid(),
    orderId: z.string().uuid(),
    /** Who caused the booking, for the audit row the transition writes. */
    actorUserId: z.string().min(1).max(200),
  })
  .strict();

export const cancelParcelPayload = z
  .object({ consignmentId: z.string().uuid(), actorUserId: z.string().min(1).max(200) })
  .strict();

export const processWebhookPayload = z
  .object({ deliveryId: z.string().uuid(), courierAccountId: z.string().uuid() })
  .strict();

export const pollOrgPayload = z.object({ limit: z.number().int().min(1).max(500) }).strict();

export type BookParcelPayload = z.infer<typeof bookParcelPayload>;
export type CancelParcelPayload = z.infer<typeof cancelParcelPayload>;
export type ProcessWebhookPayload = z.infer<typeof processWebhookPayload>;
export type PollOrgPayload = z.infer<typeof pollOrgPayload>;
