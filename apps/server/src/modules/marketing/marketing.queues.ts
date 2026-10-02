import type { QueueDefinition } from '../../platform/jobs/queues.js';

/**
 * The marketing module's jobs (M18; architecture §20). Crons are read in Asia/Dhaka time.
 *
 * Every Meta call happens here, in the worker, outside any transaction (invariant 6): the
 * spend import fetches and then opens a transaction to write; the conversion sender reads,
 * sends, and records in a second transaction.
 */
export const MARKETING_QUEUES = {
  importFanOut: 'marketing.schedule_spend_import',
  importSpend: 'marketing.import_meta_spend',
  capi: 'marketing.capi_delivered',
} as const;

export const MARKETING_QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    name: MARKETING_QUEUES.importFanOut,
    scope: 'global',
    // 06:00, once Meta has closed yesterday in a Dhaka ad account; each brand re-imports
    // the last three days, because Meta revises recent spend (D-254).
    cron: '0 6 * * *',
    retryLimit: 2,
    retryDelaySeconds: 300,
    expireInSeconds: 300,
  },
  {
    name: MARKETING_QUEUES.importSpend,
    scope: 'org',
    // `spend:<org>:<from>:<to>`: the same range asked for twice while one is waiting runs
    // once (D-207). A rerun after it finished is harmless anyway (check 2).
    policy: 'exclusive',
    retryLimit: 3,
    retryDelaySeconds: 600,
    expireInSeconds: 600,
  },
  {
    name: MARKETING_QUEUES.capi,
    scope: 'org',
    // `capi:<event row>`: one Purchase per delivered order, never two in flight.
    policy: 'exclusive',
    // Meta's window is seven days; five tries with backoff from five minutes stay well
    // inside it, and the job checks the window before every send.
    retryLimit: 5,
    retryDelaySeconds: 300,
    expireInSeconds: 120,
  },
];
