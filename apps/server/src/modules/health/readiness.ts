import { Inject, Injectable } from '@nestjs/common';
import { withGlobal } from '@elysium/db';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import { DEFAULT_JOBS_SCHEMA } from '../../platform/jobs/queues.js';
import { createLogger } from '../../platform/logging/logger.js';

/** One dependency the API cannot serve without. Resolves when it answers. */
export type ReadinessProbe = () => Promise<unknown>;
export type ReadinessProbes = Readonly<Record<string, ReadinessProbe>>;

export type CheckResult = 'ok' | 'failed';

export interface ReadinessReport {
  readonly status: 'ok' | 'unavailable';
  readonly checks: Readonly<Record<string, CheckResult>>;
}

/** Extra probes the composition root adds; Valkey's is the one `main.api.ts` adds (§26). */
export const EXTRA_READINESS_PROBES = Symbol('EXTRA_READINESS_PROBES');

/**
 * How long one probe may take. A probe that hangs is a dependency that is not answering,
 * and kamal-proxy gives the whole request five seconds.
 */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * How long a finished report is reused. The route is public and each check is a query, so
 * a burst of probes (or of anybody) costs one round of checks per second at most.
 */
const REPORT_TTL_MS = 1_000;

/**
 * The two probes every API has (architecture §26).
 *
 * - **database**: a query on the `erp_app` pool, the one every request uses. Through
 *   `withGlobal`, which clears the tenant settings, so it reads nothing.
 * - **jobs**: pg-boss's own version table, as `erp_app`. The worker installs that schema;
 *   until it has, the API cannot enqueue, so it is not ready to take a request that might.
 */
export const builtInProbes: ReadinessProbes = {
  database: () => withGlobal((tx) => tx.execute(sql`select 1`)),
  jobs: () =>
    withGlobal((tx) => tx.execute(sql.raw(`select version from ${DEFAULT_JOBS_SCHEMA}.version`))),
};

function withTimeout(probe: ReadinessProbe, ms: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no answer within ${String(ms)} ms`));
    }, ms);
    probe().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Run every probe at once and report each by name.
 *
 * The report names a failing dependency and says nothing else: the route is public, and
 * an error message is a connection string or a hostname. The error goes to the log.
 */
export async function checkReadiness(
  probes: ReadinessProbes,
  onFailure: (check: string, error: unknown) => void,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ReadinessReport> {
  const names = Object.keys(probes).sort();
  const results = await Promise.allSettled(
    names.map((name) => {
      const probe = probes[name];
      return probe === undefined ? Promise.resolve() : withTimeout(probe, timeoutMs);
    }),
  );

  const checks: Record<string, CheckResult> = {};
  names.forEach((name, index) => {
    const result = results[index];
    if (result?.status === 'rejected') {
      checks[name] = 'failed';
      onFailure(name, result.reason);
    } else {
      checks[name] = 'ok';
    }
  });

  const ready = Object.values(checks).every((check) => check === 'ok');
  return { status: ready ? 'ok' : 'unavailable', checks };
}

@Injectable()
export class ReadinessService {
  private readonly probes: ReadinessProbes;
  private cached: { readonly at: number; readonly report: ReadinessReport } | undefined;
  private inFlight: Promise<ReadinessReport> | undefined;
  private logger: Logger | undefined;

  constructor(@Inject(EXTRA_READINESS_PROBES) extra: ReadinessProbes) {
    this.probes = { ...builtInProbes, ...extra };
  }

  async check(now = Date.now()): Promise<ReadinessReport> {
    if (this.cached !== undefined && now - this.cached.at < REPORT_TTL_MS) {
      return this.cached.report;
    }
    this.inFlight ??= checkReadiness(this.probes, (check, error) => {
      // Built on first failure: `createLogger` parses the whole server configuration.
      this.logger ??= createLogger('health');
      this.logger.warn({ check, err: error }, 'readiness check failed');
    })
      .then((report) => {
        this.cached = { at: Date.now(), report };
        return report;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }
}
