import type { QueueDefinition } from '../../platform/jobs/queues.js';

/**
 * The inbox's jobs (M42; architecture §20). Every Meta call happens here, in the worker,
 * outside any transaction (invariant 6).
 *
 * - `inbox.process_webhook`: thread a stored, signed webhook body into conversations. Keyed by
 *   the stored row, so the same body is processed once however often it is enqueued; the
 *   handler is idempotent anyway (a message is unique by Meta's id).
 * - `inbox.send_message`: send one queued reply. Keyed by the message, so a reply is never in
 *   flight twice; the handler re-reads the message and sends only one still `queued`.
 * - `inbox.offer_dispatch`, `inbox.offer_expire` and `inbox.offer_sweep` (D-748): the
 *   conversation auto-offer, the twins of M41's `orders.offer_*` (D-717). Dispatch offers one
 *   conversation (`conversationId`) or every waiting one (`null`); expire is one offer's
 *   deadline, starting once it has passed; the sweep runs every minute in every brand, lapsing
 *   what ran out and offering what waits. Every handler is idempotent. Nothing calls Meta.
 * - `inbox.fetch_profile` (M44a, D-761): ask Meta's User Profile API for one Messenger or
 *   Instagram sender's name and photo. Keyed by the identity, so a burst of messages asks once;
 *   the handler checks the answer is still due. `inbox.profile_sweep` runs every six hours in
 *   every brand and queues the people still writing whose photo may have expired.
 */
export const INBOX_QUEUES = {
  processWebhook: {
    name: 'inbox.process_webhook',
    scope: 'org',
    policy: 'exclusive',
    retryLimit: 5,
    retryDelaySeconds: 10,
    expireInSeconds: 300,
  },
  sendMessage: {
    name: 'inbox.send_message',
    scope: 'org',
    policy: 'exclusive',
    // A person is waiting on the other end: three tries over about a minute, then the reply
    // shows as failed and the agent can send it again.
    retryLimit: 3,
    retryDelaySeconds: 10,
    expireInSeconds: 120,
  },
  offerDispatch: {
    name: 'inbox.offer_dispatch',
    scope: 'org',
    retryLimit: 3,
    retryDelaySeconds: 2,
    expireInSeconds: 120,
  },
  offerExpire: {
    name: 'inbox.offer_expire',
    scope: 'org',
    retryLimit: 3,
    retryDelaySeconds: 2,
    expireInSeconds: 120,
  },
  fetchProfile: {
    name: 'inbox.fetch_profile',
    scope: 'org',
    policy: 'exclusive',
    retryLimit: 3,
    retryDelaySeconds: 60,
    expireInSeconds: 120,
  },
  profileSweep: {
    name: 'inbox.profile_sweep',
    scope: 'global',
    cron: '17 */6 * * *',
    retryLimit: 0,
    expireInSeconds: 300,
  },
  offerSweep: {
    name: 'inbox.offer_sweep',
    scope: 'global',
    cron: '* * * * *',
    retryLimit: 0,
    expireInSeconds: 50,
  },
} as const satisfies Record<string, QueueDefinition>;

export const INBOX_QUEUE_DEFINITIONS: readonly QueueDefinition[] = Object.values(INBOX_QUEUES);
