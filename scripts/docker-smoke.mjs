#!/usr/bin/env node
/**
 * Smoke-test the production server image end to end, locally (M14b, D-340).
 *
 *   docker build -f infra/docker/server.Dockerfile -t elysium-server .
 *   node scripts/docker-smoke.mjs [image]
 *
 * What staging will do, on throwaway containers: a Postgres whose admin is NOT a superuser
 * (the managed shape, D-341), Valkey with a password, then from the image itself:
 * bootstrap the three roles, run the release step (migrations as erp_owner, the job
 * queues), seed, boot the worker and the API, and probe them. Every password is random
 * for the run and lives in an env file deleted at the end; nothing is published but the
 * API, on a random local port. Everything it starts is removed, pass or fail.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const IMAGE = process.argv[2] ?? 'elysium-server:m14b';
const RUN = `elysium-smoke-${randomBytes(3).toString('hex')}`;
const NETWORK = RUN;
const DB = `${RUN}-db`;
const VALKEY = `${RUN}-valkey`;
const WORKER = `${RUN}-worker`;
const API = `${RUN}-api`;
const API_PORT = 39_000 + Math.floor(Math.random() * 900);
const secret = (bytes = 24) => randomBytes(bytes).toString('hex');

const pw = {
  root: secret(),
  admin: secret(),
  owner: secret(),
  app: secret(),
  analytics: secret(),
  valkey: secret(),
};
const url = (user, password) => `postgres://${user}:${password}@${DB}:5432/elysium`;

const dir = mkdtempSync(path.join(tmpdir(), 'elysium-smoke-'));
const envFile = path.join(dir, 'server.env');
const results = [];

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}
function tryDocker(args) {
  return spawnSync('docker', args, { encoding: 'utf8' });
}
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(1_000);
  }
}
function oneShot(command, extraEnv = []) {
  const started = Date.now();
  const result = spawnSync(
    'docker',
    ['run', '--rm', '--network', NETWORK, '--env-file', envFile, ...extraEnv, IMAGE, ...command],
    { encoding: 'utf8' },
  );
  return { ...result, ms: Date.now() - started };
}

async function main() {
  writeFileSync(
    envFile,
    [
      'NODE_ENV=production',
      'LOG_LEVEL=info',
      `DATABASE_URL=${url('erp_app', pw.app)}`,
      `DATABASE_OWNER_URL=${url('erp_owner', pw.owner)}`,
      `DATABASE_ANALYTICS_URL=${url('erp_analytics', pw.analytics)}`,
      `VALKEY_URL=redis://:${pw.valkey}@${VALKEY}:6379`,
      'APP_DOMAIN=smoke.example',
      `API_PUBLIC_URL=http://localhost:${API_PORT}`,
      'TRUSTED_ORIGINS=https://console.smoke.example',
      `AUTH_SECRET=${secret(32)}`,
      `HR_FIELD_KEY=${randomBytes(32).toString('base64')}`,
      `INTAKE_KEY_SECRET=${secret(32)}`,
      'REALTIME_ADAPTER_KEY=elysium:smoke',
      '',
    ].join('\n'),
  );

  docker(['network', 'create', NETWORK]);
  docker([
    'run',
    '-d',
    '--name',
    DB,
    '--network',
    NETWORK,
    '-e',
    `POSTGRES_PASSWORD=${pw.root}`,
    'postgres:17.11-alpine',
  ]);
  docker([
    'run',
    '-d',
    '--name',
    VALKEY,
    '--network',
    NETWORK,
    'valkey/valkey:8.1-alpine',
    'valkey-server',
    '--save',
    '',
    '--appendonly',
    'no',
    '--requirepass',
    pw.valkey,
  ]);
  await until(
    'postgres',
    () => tryDocker(['exec', DB, 'pg_isready', '-U', 'postgres']).status === 0,
    60_000,
  );
  await sleep(2_000);

  // The managed provider's shape: an admin with CREATEROLE and CREATEDB, owning the database.
  docker([
    'exec',
    DB,
    'psql',
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'postgres',
    '-c',
    `create role managed_admin with login password '${pw.admin}' createrole createdb`,
  ]);
  docker([
    'exec',
    DB,
    'psql',
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'postgres',
    '-c',
    'create database elysium owner managed_admin',
  ]);

  const bootstrap = oneShot(
    ['node', 'node_modules/@elysium/db/dist/cli/bootstrap.js'],
    ['-e', `DATABASE_ADMIN_URL=${url('managed_admin', pw.admin)}`],
  );
  check(
    'bootstrap.js creates the three roles as a non-superuser admin',
    bootstrap.status === 0,
    bootstrap.status === 0 ? `${bootstrap.ms} ms` : bootstrap.stderr.slice(-400),
  );

  const release = oneShot(['node', 'dist/main.release.js']);
  check(
    'the release step migrates as erp_owner and installs the job queues',
    release.status === 0,
    release.status === 0 ? `${release.ms} ms` : (release.stderr + release.stdout).slice(-600),
  );
  const again = oneShot(['node', 'dist/main.release.js']);
  check('the release step is a no-op the second time', again.status === 0, `${again.ms} ms`);

  const seed = oneShot(['node', 'node_modules/@elysium/db/dist/cli/seed.js']);
  check(
    'the seed loads the five brands',
    seed.status === 0 && /\d+ organizations/.test(seed.stdout),
    seed.stdout.trim().split('\n').pop() ?? seed.stderr.slice(-300),
  );

  docker([
    'run',
    '-d',
    '--name',
    WORKER,
    '--network',
    NETWORK,
    '--env-file',
    envFile,
    IMAGE,
    'node',
    '--import',
    './dist/instrument.js',
    'dist/main.worker.js',
  ]);
  const workerReady = await until(
    'the worker',
    () => /"msg":"ready"/.test(tryDocker(['logs', WORKER]).stdout),
    90_000,
  ).catch(() => false);
  check('the worker boots and says ready', workerReady === true);

  docker([
    'run',
    '-d',
    '--name',
    API,
    '--network',
    NETWORK,
    '--env-file',
    envFile,
    '-p',
    `127.0.0.1:${API_PORT}:3000`,
    IMAGE,
  ]);
  const base = `http://127.0.0.1:${API_PORT}`;
  await until(
    'the API',
    async () => (await fetch(`${base}/health/live`).catch(() => null))?.ok === true,
    90_000,
  );

  const ready = await fetch(`${base}/health/ready`);
  const body = await ready.json();
  check(
    '/health/ready is 200 with database, jobs and valkey ok',
    ready.status === 200 &&
      body.checks?.database === 'ok' &&
      body.checks?.jobs === 'ok' &&
      body.checks?.valkey === 'ok',
    JSON.stringify(body),
  );
  check(
    'responses carry the security headers',
    ready.headers.get('x-content-type-options') === 'nosniff' &&
      ready.headers.get('cache-control') === 'no-store',
  );
  const me = await fetch(`${base}/v1/me`);
  check('an anonymous /v1/me is refused', me.status === 401, String(me.status));

  const who = docker([
    'exec',
    API,
    'sh',
    '-c',
    'id -u; find /app -name ".env*" | head -1; find /app/dist -name "*.test.js" | head -1; ls /app/node_modules/@elysium/db/migrations | wc -l',
  ])
    .trim()
    .split('\n');
  check('the API runs as uid 1000, not root', who[0] === '1000', who[0]);
  check(
    'no .env file and no compiled test is in the image',
    who.length === 2,
    who.slice(1).join(' | '),
  );
  check('the migrations travel with @elysium/db', Number(who.at(-1)) > 90, who.at(-1));

  docker(['stop', VALKEY]);
  await sleep(1_500);
  const down = await fetch(`${base}/health/ready`);
  const downBody = await down.json();
  check(
    '/health/ready is 503 naming valkey when Valkey stops',
    down.status === 503 && downBody.checks?.valkey === 'failed',
    JSON.stringify(downBody),
  );
  const logs = tryDocker(['logs', API]).stdout + tryDocker(['logs', WORKER]).stdout;
  check('no password reaches the logs', !Object.values(pw).some((value) => logs.includes(value)));
}

try {
  await main();
} catch (error) {
  check('the smoke run completed', false, String(error));
} finally {
  for (const name of [API, WORKER, VALKEY, DB]) tryDocker(['rm', '-f', '-v', name]);
  tryDocker(['network', 'rm', NETWORK]);
  rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\ndocker-smoke: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
