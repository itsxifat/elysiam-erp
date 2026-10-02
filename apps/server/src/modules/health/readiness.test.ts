import { describe, expect, it, vi } from 'vitest';

import { checkReadiness } from './readiness.js';

/** The probe runner behind `/health/ready` (architecture §26), without a database. */
describe('checkReadiness', () => {
  it('is ok when every probe answers', async () => {
    const report = await checkReadiness(
      { database: () => Promise.resolve(1), valkey: () => Promise.resolve('PONG') },
      () => undefined,
    );
    expect(report).toEqual({ status: 'ok', checks: { database: 'ok', valkey: 'ok' } });
  });

  it('names the failing dependency, and hands its error to the log and nowhere else', async () => {
    const onFailure = vi.fn();
    const secret = 'connect ECONNREFUSED postgres://erp_app:hunter2@db.internal:5432';
    const report = await checkReadiness(
      {
        database: () => Promise.reject(new Error(secret)),
        jobs: () => Promise.resolve(),
        valkey: () => Promise.resolve('PONG'),
      },
      onFailure,
    );

    expect(report).toEqual({
      status: 'unavailable',
      checks: { database: 'failed', jobs: 'ok', valkey: 'ok' },
    });
    expect(JSON.stringify(report)).not.toContain('hunter2');
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0]?.[0]).toBe('database');
  });

  it('fails a probe that does not answer in time instead of hanging the request', async () => {
    const started = Date.now();
    const report = await checkReadiness(
      { valkey: () => new Promise(() => undefined), database: () => Promise.resolve() },
      () => undefined,
      50,
    );
    expect(report.checks).toEqual({ database: 'ok', valkey: 'failed' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
