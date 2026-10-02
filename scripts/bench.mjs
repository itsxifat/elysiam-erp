#!/usr/bin/env node
/**
 * One benchmark method, used by every latency acceptance check.
 *
 * M06 asserts SKU search under 200 ms p95 and M11 an order-desk budget. If each milestone invents
 * its own timing loop, the numbers cannot be compared across sessions and a
 * regression hides inside a different sample count. So the method lives here:
 * fixed warmup, fixed sample count, percentiles from sorted samples, and the
 * machine and commit recorded beside the result.
 *
 * As a library:
 *   import { bench, formatResult } from '../scripts/bench.mjs';
 *   const result = await bench({ name: 'sku search', fn: () => search('shirt') });
 *
 * As a command — the one way every latency acceptance check is run:
 *   pnpm bench                the harness's own self-test
 *   pnpm bench --list         the checks it can run
 *   pnpm bench catalog        M06 check 2: SKU search p95 on 20k SKUs
 *
 * A named bench lives beside the module it measures and imports that module's
 * TypeScript directly, so it runs under tsx. Invoking one with plain `node`, as
 * their headers used to say, fails at the first import with ERR_MODULE_NOT_FOUND
 * — the `.js` specifiers name files that exist only as `.ts` — which is how both
 * M06's and M13's latency numbers came to be recorded against a command nobody
 * could run.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every latency acceptance check, by the name `pnpm bench <name>` takes.
 *
 * One table, so the list `--list` prints and the files that get run cannot
 * disagree, and so a milestone adding a budget adds a row here rather than a
 * command of its own.
 */
export const BENCHES = {
  catalog: {
    check: 'M06 check 2: SKU search under 200 ms p95 on 20k seeded SKUs',
    file: 'apps/server/src/modules/catalog/catalog-search.bench.mjs',
  },
};

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

/**
 * tsx's command-line entry, resolved through `@elysium/db`.
 *
 * `@elysium/db` already depends on tsx for its migrate and seed commands, so the
 * binary is on disk in every install. Resolving it from there rather than adding
 * tsx to the root or to `apps/server` keeps this a change with no new
 * dependency edge and no lockfile churn.
 */
function tsxCli() {
  const require = createRequire(path.join(REPO_ROOT, 'packages/db/package.json'));
  return require.resolve('tsx/cli');
}

/**
 * The database a named bench seeds into, as the benches' own headers promise.
 *
 * Each bench creates and drops a throwaway database through
 * `startTestDatabase()`, which uses `TEST_DATABASE_URL` when set and otherwise
 * starts a Testcontainer. The headers say "the dev stack must be up", so the
 * dev stack's superuser URL is used when nothing else was chosen: a second
 * PostgreSQL container on a developer machine is a gigabyte of memory to answer
 * a question the running one answers identically. An explicit
 * `TEST_DATABASE_URL` always wins, and with neither the harness falls back to a
 * Testcontainer exactly as before.
 */
function benchEnvironment() {
  const env = { ...process.env };
  if (env.TEST_DATABASE_URL !== undefined && env.TEST_DATABASE_URL !== '') return env;
  for (const candidate of ['packages/db/.env', 'apps/server/.env']) {
    const file = path.join(REPO_ROOT, candidate);
    if (!existsSync(file)) continue;
    const admin = parseEnv(readFileSync(file, 'utf8')).DATABASE_ADMIN_URL;
    if (admin !== undefined && admin !== '') {
      env.TEST_DATABASE_URL = admin;
      break;
    }
  }
  return env;
}

/**
 * The tsconfig that owns a bench file: the nearest one above it.
 *
 * tsx otherwise reads the tsconfig in its working directory, and the root has
 * none — so the server's `experimentalDecorators` was not in force and the
 * first `@Inject()` in a constructor refused to compile.
 */
function owningTsconfig(file) {
  for (let dir = path.dirname(file); dir.startsWith(REPO_ROOT); dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (existsSync(candidate)) return candidate;
    if (dir === REPO_ROOT) break;
  }
  return undefined;
}

function runNamed(name) {
  const entry = BENCHES[name];
  if (entry === undefined) {
    console.error(`bench: no bench named "${name}". Known: ${Object.keys(BENCHES).join(', ')}`);
    return 2;
  }
  console.log(`bench: ${name} — ${entry.check}\n`);
  const file = path.join(REPO_ROOT, entry.file);
  const tsconfig = owningTsconfig(file);
  const args = [tsxCli(), ...(tsconfig === undefined ? [] : ['--tsconfig', tsconfig]), file];
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env: benchEnvironment(),
    stdio: 'inherit',
  });
  if (result.error !== undefined) {
    console.error(`bench: could not start ${entry.file}: ${result.error.message}`);
    return 1;
  }
  // The bench's own verdict: non-zero when a p95 is over its budget.
  return result.status ?? 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const argument = process.argv[2];
  if (argument === undefined || argument === '--self-test') {
    process.exit(await selfTest());
  } else if (argument === '--list') {
    for (const [name, entry] of Object.entries(BENCHES))
      console.log(`${name.padEnd(10)} ${entry.check}`);
    process.exit(0);
  } else {
    process.exit(runNamed(argument));
  }
}
