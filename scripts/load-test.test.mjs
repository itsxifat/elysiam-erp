import { describe, expect, it } from 'vitest';

import { measured, renderLoadReport } from './load-test.mjs';

/**
 * The load test's reading of k6's summary (M30 check 1), without Docker or a stack.
 */

const summary = {
  metrics: {
    'http_req_duration{op:lookup,phase:measure}': {
      count: 600,
      med: 21.5,
      'p(90)': 40.1,
      'p(95)': 52.3,
      'p(99)': 90,
      max: 120,
    },
    'http_req_failed{op:lookup,phase:measure}': { value: 0 },
    'http_req_duration{op:order_save,phase:measure}': {
      count: 300,
      med: 300,
      'p(90)': 420,
      'p(95)': 480,
      'p(99)': 700,
      max: 900,
    },
    'http_req_failed{op:order_save,phase:measure}': { value: 0.002 },
  },
};

describe('load test report', () => {
  it('reads the measured phase only, by op', () => {
    expect(measured(summary, 'lookup')).toEqual({
      count: 600,
      med: 21.5,
      p90: 40.1,
      p95: 52.3,
      p99: 90,
      max: 120,
      failedRate: 0,
    });
    expect(measured(summary, 'intake')).toBeNull();
  });

  it('calls a target met only under its budget, and missed otherwise', () => {
    const report = renderLoadReport({
      results: { lookup: measured(summary, 'lookup'), order_save: measured(summary, 'order_save') },
      machine: 'test machine',
      commit: 'abc1234',
      date: '2026-10-02',
      notes: [],
    });
    expect(report).toMatch(/Order desk customer lookup .*\| 52\.3 ms \|.*\*\*met\*\*/);
    expect(report).toMatch(/\| Order save \| p95 < 400 ms \|.*\| 480\.0 ms \|.*\*\*missed\*\*/);
    expect(report).not.toMatch(/Public intake/);
  });
});
