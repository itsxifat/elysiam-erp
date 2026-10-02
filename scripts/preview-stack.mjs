/**
 * The pieces a preview is made of, shared by `pnpm preview:local` (a person trying the ERP
 * on this PC) and the console's preview smoke run (`e2e:preview`), so the run that proves
 * the preview works is the preview (D-386).
 *
 * - a database of its own on the dev stack's Postgres, made with the real bootstrap and
 *   migrations, and never `elysium_dev`;
 * - `preview:seed` (the built `apps/server/dist/main.preview.js`) against it;
 * - the API, the worker, and the console, portal and till dev servers, pointed at it.
 *
 * Plain JavaScript under `scripts/` like the other repository commands. Postgres is reached
 * through `packages/db`'s own `postgres` dependency, as `bench.mjs` does.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(REPO_ROOT, 'apps', 'server');
const DB_DIR = path.join(REPO_ROOT, 'packages', 'db');

/** The developer's own database. A preview never touches it. */
const PROTECTED = new Set(['elysium_dev', 'postgres', 'template0', 'template1']);

/** This machine's Postgres only: the preview drops and recreates its database. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The comment that marks a database as a preview. `preview:seed` refuses any database
 * without it (`apps/server/src/preview/guard.ts`, D-381).
 */
export const PREVIEW_MARKER = 'elysium-preview';

/** `KEY=value` lines, without touching `process.env`. */
function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const values = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match === null || match[1] === undefined) continue;
    values[match[1]] = (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

/**
 * The dev stack's four connection strings, from the environment or `packages/db/.env`,
 * each pointed at `database` instead of whatever database they name.
 */
export function databaseUrls(database) {
  if (PROTECTED.has(database) || !/^elysium_preview[a-z0-9_]*$/.test(database)) {
    throw new Error(
      `A preview database must be called elysium_preview…, never "${database}": ` +
        'the preview drops and recreates it.',
    );
  }
  const file = readEnvFile(path.join(DB_DIR, '.env'));
  const pick = (key) => process.env[key] ?? file[key];
  const urls = {
    admin: pick('DATABASE_ADMIN_URL'),
    owner: pick('DATABASE_OWNER_URL'),
    app: pick('DATABASE_URL'),
    analytics: pick('DATABASE_ANALYTICS_URL'),
  };
  for (const [key, value] of Object.entries(urls)) {
    if (value === undefined || value === '') {
      throw new Error(
        `No ${key} database URL. Run \`pnpm setup:env\` first (it writes packages/db/.env).`,
      );
    }
    const host = new URL(value).hostname;
    if (!LOCAL_HOSTS.has(host)) {
      throw new Error(
        `The ${key} database URL points at ${host}. A local preview uses this machine's ` +
          'Postgres only; the preview server has its own runbook (docs/runbooks/preview-kit.md).',
      );
    }
  }
  const at = (url, name) => {
    const parsed = new URL(url);
    parsed.pathname = `/${name}`;
    return parsed.toString();
  };
  return {
    database,
    admin: at(urls.admin, database),
    /** The server's maintenance database, for CREATE and DROP: never the developer's. */
    maintenance: at(urls.admin, 'postgres'),
    owner: at(urls.owner, database),
    app: at(urls.app, database),
    analytics: at(urls.analytics, database),
  };
}

function postgresClient(url) {
  const require = createRequire(path.join(DB_DIR, 'package.json'));
  const postgres = require('postgres');
  return postgres(url, { max: 1, onnotice: () => undefined });
}

/** Is Postgres answering at all? */
export async function postgresReady(urls) {
  const sql = postgresClient(urls.maintenance);
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

export async function databaseExists(urls) {
  const sql = postgresClient(urls.maintenance);
  try {
    const rows = await sql`select 1 from pg_database where datname = ${urls.database}`;
    return rows.length > 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Drop (if there) and create the preview database. Only ever an `elysium_preview…` one. */
export async function recreateDatabase(urls) {
  databaseUrls(urls.database);
  const sql = postgresClient(urls.maintenance);
  try {
    await sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${urls.database} and pid <> pg_backend_pid()`;
    await sql.unsafe(`drop database if exists "${urls.database}"`);
    await sql.unsafe(`create database "${urls.database}"`);
    await sql.unsafe(`comment on database "${urls.database}" is '${PREVIEW_MARKER}'`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function dropDatabase(urls) {
  databaseUrls(urls.database);
  const sql = postgresClient(urls.maintenance);
  try {
    await sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${urls.database} and pid <> pg_backend_pid()`;
    await sql.unsafe(`drop database if exists "${urls.database}"`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** The four variables every server process and db command reads, for this database. */
export function databaseEnv(urls) {
  return {
    DATABASE_ADMIN_URL: urls.admin,
    DATABASE_OWNER_URL: urls.owner,
    DATABASE_URL: urls.app,
    DATABASE_ANALYTICS_URL: urls.analytics,
  };
}

/** Run a command to completion, its output on this terminal. */
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: { ...process.env, ...options.env },
      stdio: options.stdio ?? 'inherit',
      shell: options.shell ?? false,
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`${path.basename(command)} ${args.join(' ')} exited with ${String(code)}`),
          ),
    );
  });
}

/** `pnpm` as a spawnable command on every platform. */
export function pnpm(args, options = {}) {
  return process.platform === 'win32'
    ? run('cmd.exe', ['/d', '/s', '/c', 'pnpm', ...args], options)
    : run('pnpm', args, options);
}

/** The roles and the schema, as `pnpm db:bootstrap` and `pnpm db:migrate` make them. */
export async function bootstrapAndMigrate(urls) {
  const env = databaseEnv(urls);
  await run(process.execPath, [path.join(DB_DIR, 'dist', 'cli', 'bootstrap.js')], {
    cwd: DB_DIR,
    env,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await run(process.execPath, [path.join(DB_DIR, 'dist', 'cli', 'migrate.js')], {
    cwd: DB_DIR,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

export function serverEnv(urls, ports, extra = {}) {
  const origins = [ports.console, ports.portal, ports.pos].map(
    (port) => `http://localhost:${port}`,
  );
  return {
    ...databaseEnv(urls),
    NODE_ENV: 'development',
    API_PORT: String(ports.api),
    API_PUBLIC_URL: `http://localhost:${ports.api}`,
    TRUSTED_ORIGINS: origins.join(','),
    APP_DOMAIN: 'localhost',
    // This preview's own realtime channel and rate-limit namespace, apart from `pnpm dev`'s.
    REALTIME_ADAPTER_KEY: `preview:${urls.database}`,
    PREVIEW_CONSOLE_URL: origins[0],
    PREVIEW_PORTAL_URL: origins[1],
    PREVIEW_POS_URL: origins[2],
    ...extra,
  };
}

/** `preview:seed`, built, against this database. */
export async function seedPreview(
  urls,
  ports,
  { out, extraArgs = [], stdio = 'inherit', env = {} },
) {
  await run(
    process.execPath,
    [
      '--env-file-if-exists=.env',
      '--enable-source-maps',
      'dist/main.preview.js',
      '--out',
      out,
      ...extraArgs,
    ],
    { cwd: SERVER_DIR, env: { ...serverEnv(urls, ports), ...env }, stdio },
  );
}

/** Whether something is already listening on a localhost port. */
export function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: 'localhost' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

export async function waitFor(url, timeoutMs) {
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

/** Kill a child and everything it started. `taskkill /T` on Windows, a group kill elsewhere. */
export function killTree(child) {
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

/**
 * The API, the worker and the three apps, pointed at this database. Returns the children;
 * their output goes to `logDir`.
 */
export function startStack(urls, ports, { logDir, env = {} }) {
  mkdirSync(logDir, { recursive: true });
  const log = (name) => openSync(path.join(logDir, `${name}.log`), 'w');
  const detached = process.platform !== 'win32';
  const server = { ...process.env, ...serverEnv(urls, ports), LOG_LEVEL: 'warn', ...env };
  const children = [
    spawn(process.execPath, ['--env-file-if-exists=.env', 'dist/main.api.js'], {
      cwd: SERVER_DIR,
      env: server,
      stdio: ['ignore', log('api'), log('api.err')],
      detached,
    }),
    spawn(process.execPath, ['--env-file-if-exists=.env', 'dist/main.worker.js'], {
      cwd: SERVER_DIR,
      env: server,
      stdio: ['ignore', log('worker'), log('worker.err')],
      detached,
    }),
  ];
  for (const [app, port] of [
    ['console', ports.console],
    ['portal', ports.portal],
    ['pos', ports.pos],
  ]) {
    const dir = path.join(REPO_ROOT, 'apps', app);
    children.push(
      spawn(
        process.execPath,
        [
          path.join(dir, 'node_modules', 'vite', 'bin', 'vite.js'),
          '--port',
          String(port),
          '--strictPort',
          '--host',
          'localhost',
        ],
        {
          cwd: dir,
          env: { ...process.env, VITE_API_URL: `http://localhost:${ports.api}` },
          stdio: ['ignore', log(app), log(`${app}.err`)],
          detached,
        },
      ),
    );
  }
  return children;
}

export async function waitForStack(ports, timeoutMs = 120_000) {
  await waitFor(`http://localhost:${ports.api}/health/live`, timeoutMs);
  for (const port of [ports.console, ports.portal, ports.pos]) {
    await waitFor(`http://localhost:${port}`, timeoutMs);
  }
}
