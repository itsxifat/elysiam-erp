import { PLATFORM_QUEUES, type QueueDefinition } from './platform/jobs/queues.js';
import { ANALYTICS_QUEUE_DEFINITIONS } from './modules/analytics/analytics.queues.js';
import { COURIER_QUEUE_DEFINITIONS } from './modules/courier/courier.queues.js';
import { HR_QUEUE_DEFINITIONS } from './modules/hr/performance.queues.js';
import { NOTIFY_QUEUES } from './modules/notify/notify.queues.js';
import { CRM_QUEUE_DEFINITIONS } from './modules/orders/crm.queues.js';
import { INVENTORY_QUEUES } from './modules/inventory/reconcile.service.js';
import { MARKETING_QUEUE_DEFINITIONS } from './modules/marketing/marketing.queues.js';
import { LOANS_QUEUE_DEFINITIONS } from './modules/loans/loans.queues.js';
import { STOREFRONT_QUEUE_DEFINITIONS } from './modules/storefront/storefront.queues.js';
import { MARKETPLACE_QUEUE_DEFINITIONS } from './modules/marketplace/marketplace.queues.js';
import { FILES_QUEUE_DEFINITIONS } from './modules/files/files.queues.js';
import { PACKING_QUEUE_DEFINITIONS } from './modules/packing/packing.queues.js';
import { INBOX_QUEUE_DEFINITIONS } from './modules/inbox/inbox.queues.js';
import { VOICE_CALLS_QUEUE_DEFINITIONS } from './modules/inbox/voice-calls.queues.js';
import { OFFER_QUEUE_DEFINITIONS } from './modules/orders/offers.queues.js';
import { TELEPHONY_QUEUE_DEFINITIONS } from './modules/telephony/telephony.queues.js';

/**
 * Every pg-boss queue the application defines, for both entrypoints.
 *
 * The API enqueues and the worker runs, and they must agree on the list: `enqueue`
 * refuses a queue its runtime was not started with, so a queue the worker knows and
 * the API does not is a request that throws. Two hand-kept copies of this list would
 * drift the way the three copies of the test-boot environment did, so there is one.
 *
 * It lives beside `app.module.ts` rather than under `platform/jobs/` because it names
 * modules, and the platform layer does not depend on modules. A module that adds a
 * queue adds it here in the same change as its handler.
 */
export const ALL_QUEUES: readonly QueueDefinition[] = [
  ...PLATFORM_QUEUES,
  ...COURIER_QUEUE_DEFINITIONS,
  ...INVENTORY_QUEUES,
  ...NOTIFY_QUEUES,
  ...CRM_QUEUE_DEFINITIONS,
  ...MARKETING_QUEUE_DEFINITIONS,
  ...HR_QUEUE_DEFINITIONS,
  ...ANALYTICS_QUEUE_DEFINITIONS,
  ...LOANS_QUEUE_DEFINITIONS,
  ...STOREFRONT_QUEUE_DEFINITIONS,
  ...MARKETPLACE_QUEUE_DEFINITIONS,
  // M38b: the packing video's retention, and removing a deleted file's bytes.
  ...FILES_QUEUE_DEFINITIONS,
  ...PACKING_QUEUE_DEFINITIONS,
  // M42: threading Meta's webhooks, and sending the inbox's replies.
  ...INBOX_QUEUE_DEFINITIONS,
  // M45: keeping customers' voice messages and pictures, sending recorded ones, call deadlines.
  ...VOICE_CALLS_QUEUE_DEFINITIONS,
  // M41: auto-assign's offers, their deadlines and the minute sweep.
  ...OFFER_QUEUE_DEFINITIONS,
  // M47: Envo's webhooks applied, the call history synced, old webhook bodies pruned.
  ...TELEPHONY_QUEUE_DEFINITIONS,
];
