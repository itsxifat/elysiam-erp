/**
 * What a queue is, and what every queue gets by default (architecture §20).
 *
 * §20's rules are short — "every job is idempotent, retries with exponential
 * backoff and has a dead-letter queue", and "a job that lands in the dead-letter
 * queue emits `job.failed`". None of those survive being restated per module.
 * The defaults here are the retry policy, and `registerQueues` applies them to
 * every queue it creates, so a module that registers a queue and says nothing
 * else still gets backoff and a dead-letter queue rather than pg-boss's
 * defaults — which are two retries with **no** delay, and no dead-lettering at
 * all.
 */

/**
 * §20: "Cron schedules run in Asia/Dhaka time."
 *
 * pg-boss evaluates a cron expression in UTC unless told otherwise, and the
 * difference is not academic: `0 2 * * *` in UTC is 08:00 in Dhaka, so
 * `inventory.reconcile_levels` would run in the middle of the working day
 * against stock that is moving. It is also not a constant offset to correct by
 * hand — Bangladesh has used daylight saving before (2009) and could again,
 * which is exactly why this is a zone name and not `+06:00`.
 */
export const DHAKA_TZ = 'Asia/Dhaka';

/**
 * The schema pg-boss owns.
 *
 * pg-boss's own default, named here because two places need to agree on it: the
 * runtime that installs it and the failed-jobs read that queries it. A test
 * suite overrides the runtime's copy so parallel suites never share queues; the
 * read does not, because a request in production always means the real one.
 */
export const DEFAULT_JOBS_SCHEMA = 'pgboss';

/** The suffix that turns a queue name into its dead-letter queue's name. */
export const DEAD_LETTER_SUFFIX = '.dead';

/**
 * The dead-letter queue a queue's exhausted jobs are copied into.
 *
 * Derived rather than configured, because the alternative is one dead-letter
 * queue shared by every queue in the system: cheaper to set up, and it loses
 * the one thing an operator needs at 3am, which is which queue is broken.
 * `sourceName` on the moved job does carry it, but a shared queue also means a
 * single flapping queue can bury every other queue's failures under its own.
 */
export function deadLetterNameFor(queue: string): string {
  return `${queue}${DEAD_LETTER_SUFFIX}`;
}

/** True for a name this module generated with {@link deadLetterNameFor}. */
export function isDeadLetterName(queue: string): boolean {
  return queue.endsWith(DEAD_LETTER_SUFFIX);
}

/**
 * Whether a queue's jobs belong to one tenant or to the installation.
 *
 * Almost everything in §20's table is a tenant's work: a parcel is booked for
 * an order in one org, an SMS goes to one org's customer. Those carry an
 * `orgId` in their envelope and their handler runs inside `withOrg`, so a job
 * cannot read another tenant's rows even though `pgboss.job` itself has no
 * `org_id` and no RLS (see the note in `enqueue`).
 *
 * `global` exists for the cron fan-outs. "Nightly 02:00" fires once, not once
 * per org, so the job that wakes up has no tenant of its own and its handler's
 * work is to enqueue one tenant job per org. Marking it rather than allowing a
 * null `orgId` everywhere keeps the common case honest: a tenant queue that
 * forgot its org id is a thrown error at the enqueue site.
 */
export type QueueScope = 'org' | 'global';

export interface QueueDefinition {
  /** `module.action`, per §20. */
  readonly name: string;
  readonly scope: QueueScope;
  /** Retries after the first attempt. Defaults to {@link QUEUE_DEFAULTS}. */
  readonly retryLimit?: number;
  /** The first retry's delay in seconds; doubles from there. */
  readonly retryDelaySeconds?: number;
  /** The ceiling the doubling stops at, in seconds. */
  readonly retryDelayMaxSeconds?: number;
  /** How long a handler may hold a job before it is considered dead. */
  readonly expireInSeconds?: number;
  /**
   * A cron expression, evaluated in {@link DHAKA_TZ}.
   *
   * Only for `global` queues. A cron schedule on a tenant queue would have to
   * invent an org id from nowhere, and the one it would invent is whichever org
   * happened to be first in the seed.
   */
  readonly cron?: string;
}

/**
 * The retry policy every queue inherits.
 *
 * Five retries because §20's only stated number is `delivery.book_parcel`'s
 * five, and one house default is better than a per-queue guess. With
 * `retryDelaySeconds` of 5 and exponential backoff, the attempts land roughly
 * 5s, 10s, 20s, 40s and 80s after the failure — about three minutes end to end,
 * which outlasts a courier's restart without holding an order hostage for an
 * afternoon.
 *
 * `retryDelayMaxSeconds` matters for the queues that will raise the retry limit
 * later: doubling is unbounded, so a queue with twelve retries would put its
 * last attempt five hours out. An hour is the cap.
 */
export const QUEUE_DEFAULTS = {
  retryLimit: 5,
  retryDelaySeconds: 5,
  retryDelayMaxSeconds: 3600,
  /**
   * 15 minutes, pg-boss's own default, restated because it is load-bearing:
   * every outbound call in this system has a timeout well under it, so a job
   * still active after 15 minutes means the worker died holding it, and the
   * right answer is to retry it rather than wait.
   */
  expireInSeconds: 900,
} as const;

/**
 * The queues that exist today.
 *
 * Empty, deliberately, and for the same reason `packages/contracts/src/events.ts`
 * lists only the events something already emits: §20's table is a roadmap of
 * sixteen queues owned by milestones that have not landed, and a registered
 * queue is not free. A cron queue in particular is actively harmful without its
 * handler — pg-boss would create a job every night, nothing would fetch it, and
 * the backlog would grow until somebody noticed the warning. A queue arrives
 * with the module that both enqueues and works it.
 *
 * Modules register theirs by passing their own definitions to
 * `startJobsRuntime`, which is what "queue registration per module" means here.
 */
export const PLATFORM_QUEUES: readonly QueueDefinition[] = [];

const QUEUE_NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/**
 * Refuse a malformed definition before pg-boss creates anything.
 *
 * §20 names queues `module.action`, and the convention earns its keep in the
 * failed-jobs view and in the logs: the module is the first thing an operator
 * needs and a free-form name buries it. Checked here rather than trusted
 * because pg-boss accepts any string, so the mistake would show up as a queue
 * nobody can attribute months later.
 *
 * A cron on a tenant queue is refused for the reason given on `cron` above.
 */
export function assertValidQueue(definition: QueueDefinition): void {
  if (!QUEUE_NAME.test(definition.name)) {
    throw new Error(
      `queue "${definition.name}" is not named module.action (§20), e.g. delivery.book_parcel`,
    );
  }
  if (isDeadLetterName(definition.name)) {
    throw new Error(
      `queue "${definition.name}" ends in ${DEAD_LETTER_SUFFIX}, which this module reserves for the dead-letter queue it creates for you`,
    );
  }
  if (definition.cron !== undefined && definition.scope !== 'global') {
    throw new Error(
      `queue "${definition.name}" has a cron schedule but is scoped to an org; a cron fires once, not once per tenant, so the queue it fires must be global`,
    );
  }
}
