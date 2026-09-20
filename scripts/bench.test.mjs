import { describe, expect, it } from 'vitest';

import { bench, formatResult, percentile } from './bench.mjs';

/**
 * The benchmark harness is load-bearing for M06, M11, M13, M22 and M29: every
 * latency acceptance check measures through it, and a silently broken
 * percentile would turn a real regression into a green build.
 */

describe('percentile', () => {
  const sorted = Array.from({ length: 100 }, (_, index) => index + 1);

  it('uses nearest rank, so it returns an observation that happened', () => {
    expect(percentile(sorted, 0.5)).toBe(50);
    expect(percentile(sorted, 0.95)).toBe(95);
    expect(percentile(sorted, 0.99)).toBe(99);
  });

  it('clamps at both ends rather than reading off the array', () => {
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile(sorted, 1)).toBe(100);
    expect(percentile([], 0.5)).toBeNaN();
    expect(percentile([7], 0.95)).toBe(7);
  });
});

describe('bench', () => {
  it('reports ordered percentiles and the sample count it used', async () => {
    const result = await bench({
      name: 'unit',
      warmup: 2,
      samples: 20,
      fn: () => Math.sqrt(2),
    });

    expect(result.samples).toBe(20);
    expect(result.warmup).toBe(2);
    expect(result.min).toBeLessThanOrEqual(result.p50);
    expect(result.p50).toBeLessThanOrEqual(result.p95);
    expect(result.p95).toBeLessThanOrEqual(result.p99);
    expect(result.p99).toBeLessThanOrEqual(result.max);
  });

  it('runs the function exactly warmup + samples times', async () => {
    let calls = 0;
    await bench({ name: 'counted', warmup: 3, samples: 7, fn: () => (calls += 1) });
    expect(calls).toBe(10);
  });

  it('judges a budget against p95, not the mean', async () => {
    const pass = await bench({
      name: 'budget',
      warmup: 1,
      samples: 5,
      budgetMs: 10_000,
      fn: () => 1,
    });
    expect(pass.withinBudget).toBe(true);

    const fail = await bench({ name: 'budget', warmup: 1, samples: 5, budgetMs: -1, fn: () => 1 });
    expect(fail.withinBudget).toBe(false);
  });

  it('records the provenance a later session needs to compare runs', async () => {
    const result = await bench({ name: 'provenance', warmup: 1, samples: 5, fn: () => 1 });
    const report = formatResult(result);

    for (const field of ['samples', 'p50', 'p95', 'p99', 'commit', 'node']) {
      expect(report, `formatResult should report ${field}`).toContain(field);
    }
    expect(result.environment.node).toBe(process.version);
    expect(result.environment.cores).toBeGreaterThan(0);
  });
});
