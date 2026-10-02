import type { QueueDefinition } from '../../platform/jobs/queues.js';

/**
 * The CRM's jobs (M16; architecture §20). Every cron is read in Asia/Dhaka time.
 *
 * Each kind of work is two queues, the shape `courier.queues.ts` set: a global job on a
 * schedule that only enumerates the active brands, and an org-scoped job per brand that
 * does the work. So one brand's failure retries on its own and never holds the others,
 * and each per-brand job carries the date it was scheduled for — a retry that lands after
 * midnight still greets the day it was meant to.
 */
export const CRM_QUEUES = {
  occasionsFanOut: 'crm.schedule_greetings',
  occasions: 'crm.greet_occasions',
  rfmFanOut: 'crm.schedule_segments',
  rfm: 'crm.score_segments',
} as const;

export const CRM_QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    name: CRM_QUEUES.occasionsFanOut,
    scope: 'global',
    // 09:00, the minute quiet hours end (D-206): a greeting queued now goes out now, not
    // at nine the next morning.
    cron: '0 9 * * *',
    retryLimit: 2,
    retryDelaySeconds: 300,
    expireInSeconds: 300,
  },
  {
    name: CRM_QUEUES.occasions,
    scope: 'org',
    // Every job carries `<kind>:<org>:<date>`, so a second fan-out the same day is
    // dropped rather than run twice (D-207).
    policy: 'exclusive',
    // Idempotent per buyer, occasion and year (check 2), so a retry greets only who the
    // first attempt did not reach.
    retryLimit: 3,
    retryDelaySeconds: 300,
    expireInSeconds: 900,
  },
  {
    name: CRM_QUEUES.rfmFanOut,
    scope: 'global',
    // 02:30, after the day's deliveries have posted and before anybody opens a buyer list.
    cron: '30 2 * * *',
    retryLimit: 2,
    retryDelaySeconds: 300,
    expireInSeconds: 300,
  },
  {
    name: CRM_QUEUES.rfm,
    scope: 'org',
    // Every job carries `<kind>:<org>:<date>`, so a second fan-out the same day is
    // dropped rather than run twice (D-207).
    policy: 'exclusive',
    // Replaces every buyer's segment, so a rerun is harmless.
    retryLimit: 2,
    retryDelaySeconds: 600,
    expireInSeconds: 1800,
  },
];
