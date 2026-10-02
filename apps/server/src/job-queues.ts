import { PLATFORM_QUEUES, type QueueDefinition } from './platform/jobs/queues.js';
import { COURIER_QUEUE_DEFINITIONS } from './modules/courier/courier.queues.js';
import { HR_QUEUE_DEFINITIONS } from './modules/hr/performance.queues.js';
import { NOTIFY_QUEUES } from './modules/notify/notify.queues.js';
import { CRM_QUEUE_DEFINITIONS } from './modules/orders/crm.queues.js';
import { INVENTORY_QUEUES } from './modules/inventory/reconcile.service.js';

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
  ...HR_QUEUE_DEFINITIONS,
];
