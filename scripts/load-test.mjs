#!/usr/bin/env node
/**
 * The k6 load test (M30 check 1, architecture §29).
 *
 * Usage (after `pnpm --filter @elysium/server build`, with the dev stack's Postgres and
 * Valkey up and Docker running; wrap it in the machine's heavy lock where one exists):
 *
 *   pnpm load:test                       both scenarios, the report in docs/review/M30/
 *   pnpm load:test -- desk               the order desk only
 *   pnpm load:test -- intake             the public intake only
 *
 * What it does, in order, and undoes at the end whatever happens:
 *
 * 1. A local Turnstile stub, so the intake's real siteverify client makes a real HTTP call
 *    that answers at once (the report states what Cloudflare's round trip would add).
 * 2. `dist/testing/load-stack.provision.js`: a throwaway database at §29's sizes, dropped
 *    at the end. Never `elysium_dev`.
 * 3. The built API and worker on ports of their own, against that database, with the
 *    intake's per-source limits raised — one k6 container at 20 req/s is the load being
 *    measured, not an attack — and everything else as configured.
 * 4. Sign-in of the four desk agents through Better Auth's real endpoints, and an intake
 *    site key issued through `POST /v1/intake/site-keys`.
 * 5. k6 in the official `grafana/k6` image, reaching the host as `host.docker.internal`,
 *    with the scenario files from `infra/k6/` and a `run.json` of throwaway sessions.
 * 6. The measured p95s against §29's targets, written to `docs/review/M30/load-test.md`
 *    (plus the raw summaries beside it), with the machine and commit, as `pnpm bench` does.
 *
 * Every child is killed as a process tree when it ends, as the console's stack harness
 * does, and the work directory holding the sessions is deleted.
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(REPO_ROOT, 'apps', 'server');
const K6_DIR = path.join(REPO_ROOT, 'infra', 'k6');
const OUT_DIR = path.join(REPO_ROOT, 'docs', 'review', 'M30');
const LOG_DIR = path.join(SERVER_DIR, 'test-results', 'load');
const WORK_DIR = path.join(SERVER_DIR, 'test-results', 'load-work');

const API_PORT = 3120;
const ORIGIN = 'http://localhost:5193';
const API_URL = `http://localhost:${String(API_PORT)}`;
const K6_IMAGE = process.env.K6_IMAGE ?? 'grafana/k6:latest';

/** §29's rows this run measures, by the `op` tag the scenarios set. */
export const TARGETS = [
  {
    op: 'lookup',
    row: 'Order desk customer lookup (the fraud badge was removed, D-291)',
    budgetMs: 300,
  },
  { op: 'sku_search', row: 'SKU search on 20k SKUs', budgetMs: 200 },
  { op: 'order_save', row: 'Order save', budgetMs: 400 },
  { op: 'intake', row: 'Public intake API at 20 req/s sustained', budgetMs: 500 },
  { op: 'availability', row: 'Stock availability (no §29 row; reported)', budgetMs: null },
  { op: 'queue', row: 'Order queue, 25 rows (no §29 row; reported)', budgetMs: null },
];

function logTo(name) {
  mkdirSync(LOG_DIR, { recursive: true });
  return openSync(path.join(LOG_DIR, `${name}.log`), 'w');
}

function killTree(child) {
  if (child?.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

async function firstLine(child, timeoutMs) {
  const lines = createInterface({ input: child.stdout });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('provisioning timed out')), timeoutMs);
    lines.once('line', (line) => {
      clearTimeout(timer);
      resolve(line);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`provisioning exited with ${String(code)}; see ${LOG_DIR}/provision.log`));
    });
  });
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      last = new Error(`${url} answered ${String(response.status)}`);
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${url} never came up: ${String(last)}`);
}

/** A cookie jar of one: name → value, from `Set-Cookie` headers. */
function absorb(jar, response) {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const index = pair.indexOf('=');
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (value === '') jar.delete(name);
    else jar.set(name, value);
  }
}

const cookieHeader = (jar) => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

async function call(jar, method, url, body) {
  const headers = { origin: ORIGIN, accept: 'application/json' };
  if (jar.size > 0) headers.cookie = cookieHeader(jar);
  const csrf = jar.get('elysium_csrf');
  if (csrf !== undefined) headers['x-elysium-csrf'] = csrf;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${API_URL}${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  absorb(jar, response);
  return response;
}

/** Sign in through Better Auth's real endpoints and enter the brand. */
async function signIn(email, password, orgId) {
  const jar = new Map();
  await call(jar, 'GET', '/v1/auth/login-branding');
  const signedIn = await call(jar, 'POST', '/api/auth/sign-in/email', { email, password });
  if (!signedIn.ok) throw new Error(`sign-in failed: ${String(signedIn.status)}`);
  const entered = await call(jar, 'POST', '/v1/me/active-org', { orgId });
  if (entered.status !== 201) throw new Error(`active-org failed: ${String(entered.status)}`);
  await call(jar, 'GET', '/v1/me');
  const csrf = jar.get('elysium_csrf');
  if (csrf === undefined) throw new Error('no CSRF cookie after sign-in');
  return { jar, cookie: cookieHeader(jar), csrf };
}

function startTurnstileStub() {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          success: true,
          challenge_ts: new Date().toISOString(),
          hostname: 'localhost',
          'error-codes': [],
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function runK6(scenario, env) {
  const args = [
    'run',
    '--rm',
    '--add-host=host.docker.internal:host-gateway',
    '-v',
    `${K6_DIR}:/scripts:ro`,
    '-v',
    `${WORK_DIR}:/work`,
    K6_IMAGE,
    'run',
    '--quiet',
    '--summary-export',
    `/work/${scenario}-summary.json`,
    ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    `/scripts/${scenario}.js`,
  ];
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  // 99 is k6's "a threshold failed": the numbers are still the result.
  if (result.status !== 0 && result.status !== 99) {
    throw new Error(`k6 ${scenario} exited with ${String(result.status)}`);
  }
  return JSON.parse(readFileSync(path.join(WORK_DIR, `${scenario}-summary.json`), 'utf8'));
}

/** Pull one op's measured-phase trend and failure rate out of a k6 summary export. */
export function measured(summary, op) {
  const trend = summary.metrics[`http_req_duration{op:${op},phase:measure}`];
  const failed = summary.metrics[`http_req_failed{op:${op},phase:measure}`];
  if (trend === undefined) return null;
  return {
    count: trend.count,
    med: trend.med,
    p90: trend['p(90)'],
    p95: trend['p(95)'],
    p99: trend['p(99)'],
    max: trend.max,
    failedRate: failed?.value ?? 0,
  };
}

const ms = (value) => (value === undefined || value === null ? '—' : `${value.toFixed(1)} ms`);

export function renderLoadReport({ results, machine, commit, date, notes }) {
  const lines = [
    '# Load test',
    '',
    `Run by \`pnpm load:test\` on ${date} at commit \`${commit}\` (M30 check 1, §29).`,
    '',
    `Machine: ${machine}. The API, the worker, Postgres, Valkey and k6 all share it, so these`,
    'are upper bounds on the server-side latency production will see, not production figures.',
    '',
    '| §29 row | Target | Samples | Median | p95 | p99 | Errors | Verdict |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const target of TARGETS) {
    const result = results[target.op];
    if (result === undefined || result === null) continue;
    const verdict =
      target.budgetMs === null
        ? 'reported'
        : result.p95 < target.budgetMs && result.failedRate < 0.01
          ? '**met**'
          : '**missed**';
    lines.push(
      `| ${target.row} | ${target.budgetMs === null ? '—' : `p95 < ${String(target.budgetMs)} ms`} | ${String(result.count)} | ${ms(result.med)} | ${ms(result.p95)} | ${ms(result.p99)} | ${(result.failedRate * 100).toFixed(2)}% | ${verdict} |`,
    );
  }
  lines.push('', ...notes, '');
  return lines.join('\n');
}

function machineLine() {
  const cpus = os.cpus();
  return `${cpus[0]?.model.trim() ?? 'unknown CPU'} × ${String(cpus.length)}, ${String(Math.round(os.totalmem() / 2 ** 30))} GB, ${os.platform()} ${os.release()}, Node ${process.version}`;
}

async function main() {
  const which = process.argv[2] ?? 'all';
  if (!['all', 'desk', 'intake'].includes(which)) {
    throw new Error('usage: load-test.mjs [all|desk|intake]');
  }
  const provisionScript = path.join(SERVER_DIR, 'dist', 'testing', 'load-stack.provision.js');
  if (!existsSync(provisionScript)) {
    throw new Error('apps/server/dist is not built: run `pnpm --filter @elysium/server build`.');
  }

  const children = [];
  let provision;
  let stub;
  const teardown = async () => {
    for (const child of children.reverse()) killTree(child);
    if (provision !== undefined && provision.exitCode === null) {
      provision.stdin.write('stop\n');
      provision.stdin.end();
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          killTree(provision);
          resolve();
        }, 30_000);
        provision.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    stub?.close();
    rmSync(WORK_DIR, { recursive: true, force: true });
  };

  try {
    stub = await startTurnstileStub();
    const stubPort = stub.address().port;

    provision = spawn(
      process.execPath,
      ['--env-file=.env', 'dist/testing/load-stack.provision.js', 'create'],
      {
        cwd: SERVER_DIR,
        env: { ...process.env, LOAD_API_URL: API_URL, LOAD_ORIGIN: ORIGIN },
        stdio: ['pipe', 'pipe', logTo('provision')],
      },
    );
    console.log('load-test: provisioning a throwaway database at §29 sizes …');
    const provisioned = JSON.parse(await firstLine(provision, 600_000));
    console.log(
      `load-test: ${String(provisioned.skuCount)} SKUs, ${String(provisioned.customers)} buyers.`,
    );

    const serverEnv = {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: process.env.LOAD_LOG_LEVEL ?? 'warn',
      DATABASE_URL: provisioned.appUrl,
      DATABASE_OWNER_URL: provisioned.ownerUrl,
      DATABASE_ANALYTICS_URL: provisioned.analyticsUrl,
      DATABASE_ADMIN_URL: provisioned.adminUrl,
      // Every interface, so the k6 container reaches it through host.docker.internal.
      API_HOST: '0.0.0.0',
      API_PORT: String(API_PORT),
      API_PUBLIC_URL: API_URL,
      TRUSTED_ORIGINS: ORIGIN,
      APP_DOMAIN: 'localhost',
      TRUSTED_PROXY_COUNT: '0',
      REALTIME_ADAPTER_KEY: `load-${randomBytes(4).toString('hex')}`,
      INTAKE_KEY_SECRET: randomBytes(32).toString('hex'),
      TURNSTILE_SECRET_KEY: 'load-test-turnstile-secret',
      INTAKE_TURNSTILE_BYPASS: 'false',
      INTAKE_TURNSTILE_VERIFY_URL: `http://127.0.0.1:${String(stubPort)}/siteverify`,
      INTAKE_RATE_LIMIT_STORE: 'valkey',
      // One container is every "visitor" and every "server" here: raised for the run only.
      INTAKE_RATE_SOURCE_IP_PER_MINUTE: '100000',
      INTAKE_RATE_SITE_PER_MINUTE: '100000',
      INTAKE_RATE_VISITOR_IP_PER_MINUTE: '1000',
      INTAKE_RATE_PHONE_PER_HOUR: '1000',
    };
    const detached = process.platform !== 'win32';
    children.push(
      spawn(process.execPath, ['--env-file=.env', 'dist/main.worker.js'], {
        cwd: SERVER_DIR,
        env: serverEnv,
        stdio: ['ignore', logTo('worker'), logTo('worker.err')],
        detached,
      }),
      spawn(process.execPath, ['--env-file=.env', 'dist/main.api.js'], {
        cwd: SERVER_DIR,
        env: serverEnv,
        stdio: ['ignore', logTo('api'), logTo('api.err')],
        detached,
      }),
    );
    await waitFor(`${API_URL}/health/live`, 180_000);
    console.log('load-test: API up; signing in …');

    const byLabel = new Map(provisioned.users.map((user) => [user.label, user]));
    const sessions = [];
    for (const label of ['desk1', 'desk2', 'desk3', 'desk4']) {
      const { cookie, csrf } = await signIn(
        byLabel.get(label).email,
        provisioned.password,
        provisioned.orgId,
      );
      sessions.push({ cookie, csrf });
    }
    const marketing = await signIn(
      byLabel.get('marketing').email,
      provisioned.password,
      provisioned.orgId,
    );
    const issued = await call(marketing.jar, 'POST', '/v1/intake/site-keys', {
      label: 'Load test',
      channel: 'landing_page',
    });
    if (issued.status !== 201) throw new Error(`site key: ${String(issued.status)}`);
    const { keyId, secret } = await issued.json();

    mkdirSync(WORK_DIR, { recursive: true });
    writeFileSync(
      path.join(WORK_DIR, 'run.json'),
      JSON.stringify({
        apiUrl: `http://host.docker.internal:${String(API_PORT)}`,
        origin: ORIGIN,
        sessions,
        skus: provisioned.skus,
        locationId: provisioned.locationId,
        area: provisioned.area,
        phonePrefix: provisioned.phonePrefix,
        customers: provisioned.customers,
        intake: { keyId, secret },
      }),
    );

    const results = {};
    const env = {
      WARMUP: process.env.LOAD_WARMUP ?? '15s',
      DURATION: process.env.LOAD_DURATION ?? '60s',
    };
    if (which !== 'desk') {
      console.log('load-test: intake at 20 req/s …');
      const summary = runK6('intake', { ...env, RATE: process.env.LOAD_INTAKE_RATE ?? '20' });
      writeFileSync(path.join(OUT_DIR, 'k6-intake-summary.json'), JSON.stringify(summary, null, 2));
      results.intake = measured(summary, 'intake');
    }
    if (which !== 'intake') {
      console.log('load-test: order desk …');
      const summary = runK6('order-desk', { ...env, SCALE: process.env.LOAD_DESK_SCALE ?? '1' });
      writeFileSync(
        path.join(OUT_DIR, 'k6-order-desk-summary.json'),
        JSON.stringify(summary, null, 2),
      );
      for (const op of ['lookup', 'sku_search', 'order_save', 'availability', 'queue']) {
        results[op] = measured(summary, op);
      }
    }

    let commit = 'unknown';
    try {
      commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }).trim();
    } catch {
      // No git metadata.
    }
    const report = renderLoadReport({
      results,
      machine: machineLine(),
      commit,
      date: new Date().toISOString().slice(0, 10),
      notes: [],
    });
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(path.join(OUT_DIR, 'load-test.generated.md'), report);
    console.log(`\n${report}`);
  } finally {
    await teardown();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(`load-test failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
