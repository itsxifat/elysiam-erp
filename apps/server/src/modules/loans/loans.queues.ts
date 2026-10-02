import type { QueueDefinition } from '../../platform/jobs/queues.js';

/**
 * The loan reminder jobs (M26; architecture §20, "daily 10:00"). Every cron is read in
 * Asia/Dhaka time.
 *
 * Two queues, the shape `crm.queues.ts` set: a global job on a schedule that only
 * enumerates the active brands, and an org-scoped job per brand that does the work. One
 * brand's failure retries on its own, and each per-brand job carries the date it was
 * scheduled for, so a retry after midnight still reminds for the day it was meant to.
 */
export const LOANS_QUEUES = {
  remindersFanOut: 'loans.schedule_reminders',
  reminders: 'loans.remind_instalments',
} as const;

export const LOANS_QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    name: LOANS_QUEUES.remindersFanOut,
    scope: 'global',
    // 10:00, after quiet hours end (09:00): the SMS goes out when it is queued.
    cron: '0 10 * * *',
    retryLimit: 2,
    retryDelaySeconds: 300,
    expireInSeconds: 300,
  },
  {
    name: LOANS_QUEUES.reminders,
    scope: 'org',
    // Every job carries `reminders:<org>:<date>`, so a second fan-out the same day is
    // dropped rather than run twice (D-207).
    policy: 'exclusive',
    // Idempotent per instalment (check 3), so a retry reminds only what the first missed.
    retryLimit: 3,
    retryDelaySeconds: 300,
    expireInSeconds: 900,
  },
];
