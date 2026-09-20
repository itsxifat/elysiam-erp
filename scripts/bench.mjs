#!/usr/bin/env node
/**
 * One benchmark method, used by every latency acceptance check.
 *
 * M06 asserts SKU search under 200 ms p95, M13 a fraud lookup under 300 ms p95,
 * M11 an order-desk budget, M29 a Lighthouse score. If each milestone invents
 * its own timing loop, the numbers cannot be compared across sessions and a
 * regression hides inside a different sample count. So the method lives here:
 * fixed warmup, fixed sample count, percentiles from sorted samples, and the
 * machine and commit recorded beside the result.
 *
 * As a library:
 *   import { bench, formatResult } from '../scripts/bench.mjs';
 *   const result = await bench({ name: 'sku search', fn: () => search('shirt') });
 *
 * As a command:
 *   node scripts/bench.mjs --self-test
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_WARMUP = 20;
export const DEFAULT_SAMPLES = 200;

/**
 * Nearest-rank percentile over samples sorted ascending.
 *
 * Nearest-rank rather than interpolated: with a fixed sample count it returns
 * an observation that actually happened, which is what a latency budget is
 * about.
 */
export function percentile(sortedMs, fraction) {
  if (sortedMs.length === 0) return Number.NaN;
  const rank = Math.max(1, Math.ceil(fraction * sortedMs.length));
  return sortedMs[Math.min(rank, sortedMs.length) - 1];
}

function environment() {
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // A tarball checkout has no git metadata; the rest of the report still stands.
  }

  const cpus = os.cpus();
  return {
    commit,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpu: cpus[0]?.model.trim() ?? 'unknown',
    cores: cpus.length,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    at: new Date().toISOString(),
  };
}

/**
 * Time `fn` and report its distribution.
 *
 * @param {{
 *   name: string,
 *   fn: () => unknown | Promise<unknown>,
 *   warmup?: number,
 *   samples?: number,
 *   budgetMs?: number,
 * }} options
 */
export async function bench({
  name,
  fn,
  warmup = DEFAULT_WARMUP,
  samples = DEFAULT_SAMPLES,
  budgetMs,
}) {
  // Warmup runs are discarded: the first calls pay for JIT, connection setup and
  // cold caches, which is not what a p95 is meant to describe.
  for (let i = 0; i < warmup; i += 1) await fn();

  const durations = new Array(samples);
  for (let i = 0; i < samples; i += 1) {
    const started = performance.now();
    await fn();
    durations[i] = performance.now() - started;
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const total = durations.reduce((sum, value) => sum + value, 0);

  return {
    name,
    warmup,
    samples,
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
    mean: total / samples,
    budgetMs: budgetMs ?? null,
    withinBudget: budgetMs === undefined ? null : percentile(sorted, 0.95) <= budgetMs,
    environment: environment(),
  };
}

const ms = (value) => `${value.toFixed(3)} ms`;

export function formatResult(result) {
  const { environment: env } = result;
  const lines = [
    `bench: ${result.name}`,
    `  samples ${result.samples} (after ${result.warmup} warmup)`,
    `  p50 ${ms(result.p50)}   p95 ${ms(result.p95)}   p99 ${ms(result.p99)}`,
    `  min ${ms(result.min)}   mean ${ms(result.mean)}   max ${ms(result.max)}`,
  ];

  if (result.budgetMs !== null) {
    lines.push(`  budget p95 <= ${result.budgetMs} ms: ${result.withinBudget ? 'PASS' : 'FAIL'}`);
  }

  lines.push(
    `  commit ${env.commit} · node ${env.node} · ${env.platform}`,
    `  ${env.cpu} (${env.cores} cores, ${env.memoryGb} GB) · ${env.at}`,
  );

  return lines.join('\n');
}

/** Record a result so later sessions can compare like with like. */
export function writeResult(result) {
  const dir = path.join(REPO_ROOT, 'bench-results');
  mkdirSync(dir, { recursive: true });
  const slug = result.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const file = path.join(dir, `${slug}.json`);
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return file;
}

async function selfTest() {
  // A workload with a known, non-zero cost, so the harness proves it measures
  // something rather than reporting zeros.
  const result = await bench({
    name: 'self test (sort 2000 numbers)',
    warmup: 20,
    samples: 200,
    fn: () => {
      const values = new Array(2000);
      for (let i = 0; i < values.length; i += 1) values[i] = (i * 2654435761) % 100000;
      values.sort((a, b) => a - b);
      return values[0];
    },
  });

  console.log(formatResult(result));

  if (!(result.p50 > 0) || !(result.p95 >= result.p50) || !(result.p99 >= result.p95)) {
    console.error('bench: FAIL — percentiles are not ordered or are zero');
    return 1;
  }

  console.log('\nbench: self test PASS');
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exit(await selfTest());
}
