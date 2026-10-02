import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { startHttpHarness, type HttpHarness } from '../../testing/http-harness.js';

/**
 * `/health/live` and `/health/ready` over HTTP, against real Postgres (M14b, §26).
 *
 * The harness boots without Valkey, so readiness here is the two checks every API has:
 * the database and the job queue's schema. The schema is the worker's to install, which
 * makes the order of these cases the order of a first deploy: the API is up before the
 * worker has run, and it says so.
 */

let harness: HttpHarness;
let jobs: JobsRuntime | undefined;

beforeAll(async () => {
  harness = await startHttpHarness('health');
}, 120_000);

afterAll(async () => {
  await jobs?.stop();
  await harness.close();
});

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('GET /health/live', () => {
  it('answers 200 without a session', async () => {
    const response = await harness.client().request('GET', '/health/live');
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ status: 'ok' });
  });
});

describe('GET /health/ready', () => {
  it('is 503 naming the job queue until the worker has installed its schema', async () => {
    const response = await harness.client().request('GET', '/health/ready');

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      status: 'unavailable',
      checks: { database: 'ok', jobs: 'failed' },
    });
    expect(response.headers['cache-control']).toBe('no-store');
    // A public route says which dependency is down and nothing about why.
    expect(response.body).not.toMatch(/postgres:|erp_app|relation|does not exist/i);
  });

  it('is 200 once the worker has run', async () => {
    jobs = await JobsRuntime.start({
      role: 'worker',
      connectionString: harness.database.ownerUrl,
      appRole: 'erp_app',
      queues: [],
      logger: pino({ level: 'silent' }),
    });
    // The last report is reused for a second, so a burst of probes costs one round.
    await settle(1_100);

    const response = await harness.client().request('GET', '/health/ready');
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      status: 'ok',
      checks: { database: 'ok', jobs: 'ok' },
    });
  });
});
