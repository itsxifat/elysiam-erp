import { maskPhonesInText } from '@elysium/domain';
import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';

import {
  assertValidQueue,
  DEFAULT_JOBS_SCHEMA,
  DHAKA_TZ,
  QUEUE_DEFAULTS,
  deadLetterNameFor,
  type QueueDefinition,
} from './queues.js';
import { parseEnvelope, type JobEnvelope } from './envelope.js';

/**
 * pg-boss, wrapped once (architecture §20).
 *
 * The wrapper exists for four things the library leaves to its caller, and
 * every one of them is a rule §20 states:
 *
 * 1. **Defaults.** pg-boss retries twice, immediately, and dead-letters
 *    nothing. §20 wants five retries, exponential backoff and a dead-letter
 *    queue, so `registerQueues` applies {@link QUEUE_DEFAULTS} and creates each
 *    queue's dead-letter queue alongside it.
 * 2. **Tenancy.** `pgboss.job` is pg-boss's table, not ours: no `org_id`, no
 *    RLS, no FORCE. The envelope carries the org instead, and every handler is
 *    handed a parsed one (see `envelope.ts`).
 * 3. **`job.failed`.** A dead-letter queue nobody watches is a silent failure
 *    with extra steps, so every dead-letter queue gets a handler that emits
 *    `job.failed` through the outbox.
 * 4. **Asia/Dhaka.** pg-boss reads cron in UTC unless told; §20 says Dhaka.
 *
 * ## Why the worker connects as the owner, and what that forces
 *
 * pg-boss owns its schema and migrates it itself, so the process that starts it
 * needs CREATE on the database — `erp_owner`. Writing pg-boss's tables as a
 * migration of ours instead would put a second source of truth next to
 * pg-boss's own migration store, and invariant 9 (never edit a committed
 * migration) would then make a pg-boss upgrade impossible to apply cleanly.
 *
 * That leaves `erp_app` — the role the API serves requests as, and therefore the
 * role a caller's transaction is inside when `enqueue` inserts through it — with
 * no privileges on those tables at all. `grantAppAccess` below closes that, as
 * DDL run by the owner right after the schema exists, because there is no
 * migration of ours to hang it off. The `alter default privileges` half is the
 * part that is easy to miss: pg-boss creates a table per queue through its own
 * `create_queue` function, so a one-off `grant on all tables` would cover
 * today's queues and silently miss tomorrow's.
 */

/** What a handler receives: the envelope, already parsed and checked. */
export interface JobContext<TPayload> {
  readonly jobId: string;
  readonly queue: string;
  /** Null only on a `global` queue. */
  readonly orgId: string | null;
  readonly ref: string | null;
  readonly requestId: string | null;
  readonly payload: TPayload;
}

/**
 * A job handler.
 *
 * Deliberately *not* given a transaction. A handler's first act is usually an
 * outbound call, and invariant 6 forbids one inside a transaction — a handler
 * handed a `tx` would hold a database connection open across a courier's
 * network. It opens its own `withOrg` for the writes that follow instead.
 */
export type JobHandler<TPayload = unknown> = (job: JobContext<TPayload>) => Promise<void>;

/** What a dead-lettered job reports, matching `jobFailedPayload` plus its org. */
export interface JobFailure {
  readonly queue: string;
  readonly orgId: string | null;
  readonly ref: string | null;
  readonly code: string;
}

/** Where a dead-letter handler sends its report. The worker wires this to the outbox. */
export type JobFailureReporter = (failure: JobFailure) => Promise<void>;

export interface JobsRuntimeOptions {
  /**
   * `worker` installs and migrates the schema, creates queues, runs handlers and
   * cron. `client` only enqueues, so it neither migrates nor supervises: two
   * processes both running maintenance is wasted work, and a `client` that could
   * migrate would be an API deploy racing a worker deploy over DDL.
   */
  readonly role: 'worker' | 'client';
  readonly connectionString: string;
  readonly queues: readonly QueueDefinition[];
  readonly logger: Logger;
  /** pg-boss's own schema. Overridden per test suite so parallel suites never share queues. */
  readonly schema?: string;
  /**
   * The role that will enqueue through a caller's transaction, granted DML on
   * pg-boss's tables. Defaults to the user in the connection string, which in
   * every environment is the owner — so pass this whenever the two differ.
   */
  readonly appRole?: string;
  /** How often a worker polls, in seconds. Shortened in tests, where waiting dominates. */
  readonly pollingIntervalSeconds?: number;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * A role or schema name safe to put in DDL.
 *
 * Neither can be a bind parameter — GRANT takes an identifier, not a value — so
 * this check stands in for parameterisation. It is narrower than PostgreSQL
 * allows on purpose: every identifier this repo creates is lower-case
 * snake_case, so anything else is a configuration mistake worth failing on
 * rather than quoting around.
 */
function assertIdentifier(value: string, what: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`refusing to build DDL for ${what} "${value}"`);
  }
  return value;
}

export class JobsRuntime {
  private readonly definitions: Map<string, QueueDefinition>;
  private readonly pollingIntervalSeconds: number | undefined;
  /** Queues whose dead letters are already watched, so registering twice is idempotent. */
  private readonly watchedDeadLetters = new Set<string>();
  private stopped = false;

  private constructor(
    readonly boss: PgBoss,
    private readonly logger: Logger,
    definitions: readonly QueueDefinition[],
    pollingIntervalSeconds: number | undefined,
  ) {
    this.definitions = new Map(definitions.map((definition) => [definition.name, definition]));
    this.pollingIntervalSeconds = pollingIntervalSeconds;
  }

  /**
   * Start pg-boss and, for a worker, put the schema and the queues in place.
   *
   * Registers itself as this process's active runtime, so the free function
   * `enqueue(tx, …)` can find it — see the note on `activeRuntime`.
   */
  static async start(options: JobsRuntimeOptions): Promise<JobsRuntime> {
    for (const definition of options.queues) assertValidQueue(definition);

    const schema = assertIdentifier(options.schema ?? DEFAULT_JOBS_SCHEMA, 'pg-boss schema');
    const isWorker = options.role === 'worker';

    const boss = new PgBoss({
      connectionString: options.connectionString,
      schema,
      // Named so `pg_stat_activity` says which process holds a connection.
      // Debugging a connection leak without this is guesswork.
      application_name: `elysium-jobs-${options.role}`,
      max: isWorker ? 5 : 2,
      migrate: isWorker,
      createSchema: isWorker,
      supervise: isWorker,
      schedule: isWorker,
    });

    // pg-boss reports operational trouble through events rather than by
    // throwing: a maintenance query that failed, a queue whose backlog is
    // growing. With no listener, `error` on an EventEmitter takes the process
    // down, and `warning` vanishes — and those two are the only notice anyone
    // gets that the queue is unwell.
    boss.on('error', (error: unknown) => {
      options.logger.error({ err: describeError(error) }, 'pg-boss error');
    });
    boss.on('warning', (warning: unknown) => {
      options.logger.warn({ warning }, 'pg-boss warning');
    });

    await boss.start();

    const runtime = new JobsRuntime(
      boss,
      options.logger,
      options.queues,
      options.pollingIntervalSeconds,
    );

    if (isWorker) {
      // Queues first, then the grant. Creating a queue is what can add a table,
      // so granting before would cover the schema as it was a moment ago — and
      // the symptom of that is a permission error on the *first request after a
      // deploy that added a queue*, which is the hardest kind to reproduce.
      await runtime.registerQueues();
      await grantAppAccess(schema, options.appRole ?? appRoleFrom(options.connectionString));
    }

    setActiveRuntime(runtime);
    return runtime;
  }

  /** The definition a queue was registered with. `enqueue` checks its scope. */
  definitionFor(queue: string): QueueDefinition | undefined {
    return this.definitions.get(queue);
  }

  /**
   * Run `handler` for `queue`, and report whatever it gives up on.
   *
   * Registering the dead-letter handler here rather than leaving it to the
   * caller is the difference between §20's `job.failed` rule holding for every
   * queue and holding for the queues somebody remembered. `report` is passed in
   * so this file does not depend on the outbox: the worker entrypoint wires the
   * two together, and a test can watch what was reported without one.
   */
  async work<TPayload>(
    queue: string,
    handler: JobHandler<TPayload>,
    report: JobFailureReporter,
  ): Promise<void> {
    const definition = this.definitions.get(queue);
    if (definition === undefined) {
      throw new Error(`queue "${queue}" was not registered with this runtime`);
    }

    await this.boss.work<unknown>(queue, this.workOptions(), async (jobs) => {
      for (const job of jobs) {
        const envelope = parseEnvelope(queue, job.data);
        assertScope(definition, envelope);

        try {
          await handler({
            jobId: job.id,
            queue,
            orgId: envelope.orgId,
            ref: envelope.ref,
            requestId: envelope.requestId,
            payload: envelope.payload as TPayload,
          });
        } catch (error) {
          // Re-thrown masked, because pg-boss persists the rejection into
          // `pgboss.job.output` and the failed-jobs endpoint reads it back. An
          // error message routinely quotes the input that caused it, and for
          // this product that input is a customer's phone number (invariant 10).
          throw maskedError(error);
        }
      }
    });

    await this.workDeadLetters(queue, report);
  }

  /**
   * Watch one queue's dead-letter queue and report what lands in it.
   *
   * Separate from `work` because the worker entrypoint watches every registered
   * queue's dead letters whether or not this process also handles the queue
   * itself — a queue whose handler lives elsewhere would otherwise dead-letter
   * silently. It also keeps the dead-letter handler from inheriting the source
   * queue's retry policy: it has none of its own, because retrying the *report*
   * of a failure five times puts five identical `job.failed` events in front of
   * one org_admin.
   *
   * Registering twice for the same queue is a no-op rather than an error. `work`
   * calls this, and so does the entrypoint's sweep over every definition; two
   * watchers on one dead-letter queue would each claim some of the jobs, so the
   * events would arrive but each one from a different process — attributed, at
   * random, to whichever happened to fetch it.
   */
  async workDeadLetters(queue: string, report: JobFailureReporter): Promise<void> {
    if (this.watchedDeadLetters.has(queue)) return;
    this.watchedDeadLetters.add(queue);

    // `includeMetadata` is spelled out in the type argument rather than left to
    // inference: pg-boss picks the handler's own signature from a *literal*
    // `includeMetadata: true`, and spreading the polling options in beside it
    // widens the property to `boolean` — at which point the handler is typed as
    // if the metadata were absent and `sourceName` does not exist.
    const options: { includeMetadata: true; pollingIntervalSeconds?: number } = {
      includeMetadata: true,
      ...this.workOptions(),
    };

    await this.boss.work<unknown, void, typeof options>(
      deadLetterNameFor(queue),
      options,
      async (jobs) => {
        for (const job of jobs) {
          // The moved job keeps the original's payload, so the envelope — and
          // with it the org the event must be addressed to — survives the move.
          // `sourceName` and `sourceId` are pg-boss's record of where it came
          // from; the envelope's own `ref` is what a human recognises.
          const envelope = parseEnvelope(queue, job.data);
          await report({
            queue: job.sourceName ?? queue,
            orgId: envelope.orgId,
            ref: envelope.ref ?? job.sourceId,
            code: failureCode(job.output),
          });
        }
      },
    );
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (activeRuntime === this) activeRuntime = undefined;
    // `graceful` waits for in-flight handlers. Abandoning one means, for a
    // courier booking, a parcel booked at the courier and not recorded here.
    await this.boss.stop({ graceful: true, close: true });
  }

  /**
   * Create every registered queue, its dead-letter queue, and its cron schedule.
   *
   * `createQueue` is idempotent, so this runs on every worker boot rather than
   * once ever. That is the point: a queue added in a release exists the moment
   * the new worker starts, with no separate migration step a deploy could skip.
   *
   * The dead-letter queue is created **first**. pg-boss requires a queue's
   * `deadLetter` target to exist when the queue is created, so the other order
   * fails on a fresh database and succeeds on an existing one — the worst kind
   * of ordering bug, because staging would never show it.
   */
  /** Queues whose stored policy is not the one their definition asks for (W7). */
  private readonly drift: string[] = [];

  /** For the boot log's reader and the tests: which queues have drifted, if any. */
  policyDrift(): readonly string[] {
    return [...this.drift];
  }

  private async registerQueues(): Promise<void> {
    for (const definition of this.definitions.values()) {
      const deadLetter = deadLetterNameFor(definition.name);

      await this.boss.createQueue(deadLetter, {
        retryLimit: 0,
        expireInSeconds: QUEUE_DEFAULTS.expireInSeconds,
      });

      await this.boss.createQueue(definition.name, {
        deadLetter,
        retryLimit: definition.retryLimit ?? QUEUE_DEFAULTS.retryLimit,
        retryDelay: definition.retryDelaySeconds ?? QUEUE_DEFAULTS.retryDelaySeconds,
        retryBackoff: true,
        retryDelayMax: definition.retryDelayMaxSeconds ?? QUEUE_DEFAULTS.retryDelayMaxSeconds,
        expireInSeconds: definition.expireInSeconds ?? QUEUE_DEFAULTS.expireInSeconds,
        ...(definition.policy === undefined ? {} : { policy: definition.policy }),
      });

      /*
       * `createQueue` does nothing to a queue that exists, and pg-boss cannot change a
       * queue's policy afterwards (`updateQueue` throws). So a database created before a
       * queue became `exclusive` keeps `standard`, and its singleton keys are enforced by
       * nothing — silently, which is the failure D-207 was about. Said loudly instead, on
       * every boot, with the way out (ledger audit W7).
       */
      if (definition.policy !== undefined) {
        const stored = await this.boss.getQueue(definition.name);
        const storedPolicy = stored?.policy ?? 'standard';
        if (storedPolicy !== definition.policy) {
          this.drift.push(definition.name);
          this.logger.error(
            { queue: definition.name, stored: storedPolicy, wanted: definition.policy },
            'queue policy drift: this queue was created before its policy changed, so its singleton keys are not enforced; see docs/runbooks/queue-policy.md',
          );
        }
      }

      if (definition.cron !== undefined) {
        // `missed: 'once'` rather than pg-boss's default `skip`: a nightly
        // reconciliation that a deploy window ate should still run, and running
        // it once covers however many occurrences were missed, because each pass
        // recomputes from current state. `skip` would silently drop the night a
        // release landed, which is the night you most want it.
        // A cron job's envelope has no tenant and no request behind it, which is
        // what `scope: 'global'` on a cron queue means and why `assertValidQueue`
        // refuses the tenant-scoped case: there would be no org to put here.
        const envelope: JobEnvelope = { orgId: null, ref: null, requestId: null, payload: {} };
        await this.boss.schedule(definition.name, definition.cron, envelope, {
          tz: DHAKA_TZ,
          missed: 'once',
        });
        this.logger.info(
          { queue: definition.name, cron: definition.cron, tz: DHAKA_TZ },
          'cron schedule registered',
        );
      }
    }
  }

  private workOptions(): { pollingIntervalSeconds?: number } {
    return this.pollingIntervalSeconds === undefined
      ? {}
      : { pollingIntervalSeconds: this.pollingIntervalSeconds };
  }
}

/**
 * This process's runtime, for the free function `enqueue(tx, …)`.
 *
 * Module state, which is not the shape anyone reaches for first. The alternative
 * is threading a pg-boss handle through every service that might enqueue —
 * `ledger.post()` down to the posting rules — so that a domain service's
 * constructor knows which queue library this application uses. The outbox's
 * `emit(tx, …)` made the same call for the same reason, and the two read the
 * same way at the call site, which is worth more than purity here.
 */
let activeRuntime: JobsRuntime | undefined;

function setActiveRuntime(runtime: JobsRuntime): void {
  activeRuntime = runtime;
}

/** The runtime `enqueue` will use, or undefined if none has started. */
export function activeJobsRuntime(): JobsRuntime | undefined {
  return activeRuntime;
}

function appRoleFrom(connectionString: string): string {
  const user = decodeURIComponent(new URL(connectionString).username);
  return user === '' ? 'erp_app' : user;
}

function assertScope(definition: QueueDefinition, envelope: JobEnvelope): void {
  if (definition.scope === 'org' && envelope.orgId === null) {
    throw new Error(
      `job on ${definition.name} carries no orgId, but the queue is tenant-scoped; its handler would have no tenant to open withOrg for`,
    );
  }
}

function describeError(error: unknown): { message: string } {
  return { message: maskPhonesInText(error instanceof Error ? error.message : String(error)) };
}

function maskedError(error: unknown): Error {
  const masked = new Error(
    maskPhonesInText(error instanceof Error ? error.message : String(error)),
  );
  // The class name survives so `failureCode` has something specific to report,
  // and so a log reader can tell a `TypeError` from a refused courier booking.
  if (error instanceof Error) masked.name = error.name;
  return masked;
}

/**
 * A short code for `job.failed`, out of whatever pg-boss stored.
 *
 * `job.failed` carries a code, not a message, on purpose: §19 addresses it to
 * every org_admin and every super admin, and a message is exactly where the
 * payload that caused the failure leaks. The error's class name is the most
 * specific thing that is reliably safe to forward.
 */
function failureCode(output: unknown): string {
  if (output !== null && typeof output === 'object') {
    const named = output as { name?: unknown; code?: unknown };
    if (typeof named.code === 'string' && named.code !== '') return named.code;
    if (typeof named.name === 'string' && named.name !== '') return named.name;
  }
  return 'JOB_FAILED';
}

/**
 * Give the application role what it needs on pg-boss's own tables.
 *
 * Runs as `erp_owner`, which owns them, after pg-boss has installed or migrated
 * its schema and after every queue has been created. Idempotent, so it runs on
 * every worker boot: a pg-boss upgrade that adds a table would otherwise leave
 * `enqueue` failing with a permission error at the first request after the
 * deploy — and only in production, because a fresh test database gets the grant
 * on its first boot anyway.
 *
 * **Not** `alter default privileges`, which is the obvious way to cover tables
 * pg-boss creates later and is the wrong one here: a default privilege is a
 * standing grant on every future table in the schema, and the RLS guard test
 * (`findDefaultPrivileges`) asserts this database has none, because that is
 * precisely how a new table ships without its policy. Re-granting on every boot
 * covers the same ground and grants nothing that does not exist yet.
 *
 * DELETE is withheld. `enqueue` inserts, and pg-boss's own maintenance — which
 * runs in the worker, as the owner — is the only thing that removes a job. An
 * application role able to delete from the job table is a role able to make a
 * pending courier booking disappear with no audit row anywhere.
 */
export async function grantAppAccess(schema: string, appRole: string): Promise<void> {
  const safeSchema = assertIdentifier(schema, 'pg-boss schema');
  const safeRole = assertIdentifier(appRole, 'application role');

  await withSystem(async (tx) => {
    await tx.execute(
      sql.raw(`
        grant usage on schema ${safeSchema} to ${safeRole};
        grant select, insert, update on all tables in schema ${safeSchema} to ${safeRole};
        grant usage, select on all sequences in schema ${safeSchema} to ${safeRole};
        grant execute on all functions in schema ${safeSchema} to ${safeRole};
      `),
    );
  });
}
