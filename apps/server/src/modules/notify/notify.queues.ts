import type { QueueDefinition } from '../../platform/jobs/queues.js';

/**
 * One message, sent (§20; M16).
 *
 * Enqueued in the same transaction that writes the message row, with `startAfter` set to
 * the end of quiet hours when the message was queued inside them — so a marketing text
 * written at 23:00 Dhaka is a job that does not exist to the worker until 09:00. The job
 * checks the clock again before sending, because a queue that was down overnight
 * delivers its backlog in a burst and some of that burst can land back inside 21:00.
 *
 * Three retries a minute apart cover a gateway's brief outage. A refusal the gateway
 * names — an empty balance, a disabled sender id — is not retried at all: the job marks
 * the message failed and stops, because the next attempt would be refused the same way.
 */
export const NOTIFY_SEND_QUEUE: QueueDefinition = {
  name: 'notify.send',
  scope: 'org',
  retryLimit: 3,
  retryDelaySeconds: 60,
  expireInSeconds: 60,
};

export const NOTIFY_QUEUES: readonly QueueDefinition[] = [NOTIFY_SEND_QUEUE];
