import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { API_PORT, CONSOLE_PORT } from './stack.config.js';

/**
 * The owner console's stack for one browser run (M32):
 *
 * 1. `e2e-stack.provision.js` from the mother server's build: two demo brand databases and
 *    a mother database with its first owner and both brands read once. It stays alive and
 *    drops every database when told to stop.
 * 2. The mother API and worker, on this run's port, with the same secrets key.
 * 3. This console's built files under `vite preview`, proxying `/api` and `/v1` to the API,
 *    one origin as in production.
 *
 * Needs Postgres reachable through `TEST_DATABASE_URL` (or Docker for a Testcontainer).
 */

const CONSOLE_DIR = path.resolve(import.meta.dirname, '..');
const SERVER_DIR = path.resolve(CONSOLE_DIR, '../mother-server');
const LOG_DIR = path.resolve(CONSOLE_DIR, 'test-results', 'stack');
export const STATE_FILE = path.join(LOG_DIR, 'state.json');

export interface StackState {
  readonly inviteLink: string;
  readonly email: string;
  readonly publicKey: string;
  readonly brandIds: readonly string[];
  readonly brandSlugs: readonly string[];
}

function logTo(name: string): number {
  mkdirSync(LOG_DIR, { recursive: true });
  return openSync(path.join(LOG_DIR, `${name}.log`), 'w');
}

async function firstLine(child: ChildProcess, timeoutMs: number): Promise<string> {
  if (child.stdout === null) throw new Error('provision has no stdout');
  const lines = createInterface({ input: child.stdout });
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('provisioning timed out')), timeoutMs);
    lines.once('line', (line) => {
      clearTimeout(timer);
      resolve(line);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`provisioning exited with ${String(code)}; see test-results/stack`));
    });
  });
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
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

function killTree(child: ChildProcess | undefined): void {
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

export default async function globalSetup(): Promise<() => Promise<void>> {
  const children: ChildProcess[] = [];
  let provision: ChildProcess | undefined;
  const consoleUrl = `http://127.0.0.1:${String(CONSOLE_PORT)}`;
  const secretsKey = randomBytes(32).toString('base64');

  const teardown = async () => {
    for (const child of children.reverse()) killTree(child);
    if (provision?.exitCode === null) {
      provision.stdin?.write('stop\n');
      provision.stdin?.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          killTree(provision);
          resolve();
        }, 60_000);
        provision?.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };

  try {
    provision = spawn(process.execPath, ['dist/testing/e2e-stack.provision.js'], {
      cwd: SERVER_DIR,
      env: { ...process.env, E2E_SECRETS_KEY: secretsKey, E2E_PUBLIC_URL: consoleUrl },
      stdio: ['pipe', 'pipe', logTo('provision')],
    });
    const provisioned = JSON.parse(await firstLine(provision, 300_000)) as StackState & {
      motherAppUrl: string;
      motherOwnerUrl: string;
    };
    const state: StackState = {
      inviteLink: provisioned.inviteLink,
      email: provisioned.email,
      publicKey: provisioned.publicKey,
      brandIds: provisioned.brandIds,
      brandSlugs: provisioned.brandSlugs,
    };
    writeFileSync(STATE_FILE, JSON.stringify(state));

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production',
      LOG_LEVEL: process.env.E2E_STACK_LOG_LEVEL ?? 'warn',
      MOTHER_API_HOST: '127.0.0.1',
      MOTHER_API_PORT: String(API_PORT),
      MOTHER_DATABASE_URL: provisioned.motherAppUrl,
      MOTHER_DATABASE_OWNER_URL: provisioned.motherOwnerUrl,
      MOTHER_PUBLIC_URL: consoleUrl,
      MOTHER_AUTH_SECRET: randomBytes(32).toString('hex'),
      MOTHER_SECRETS_KEY: secretsKey,
      MOTHER_TRUSTED_PROXIES: '127.0.0.1',
    };
    const detached = process.platform !== 'win32';
    children.push(
      spawn(process.execPath, ['dist/main.worker.js'], {
        cwd: SERVER_DIR,
        env,
        stdio: ['ignore', logTo('worker'), logTo('worker.err')],
        detached,
      }),
      spawn(process.execPath, ['dist/main.api.js'], {
        cwd: SERVER_DIR,
        env,
        stdio: ['ignore', logTo('api'), logTo('api.err')],
        detached,
      }),
      spawn(
        process.execPath,
        [
          path.join(CONSOLE_DIR, 'node_modules', 'vite', 'bin', 'vite.js'),
          'preview',
          '--port',
          String(CONSOLE_PORT),
          '--strictPort',
          '--host',
          '127.0.0.1',
        ],
        {
          cwd: CONSOLE_DIR,
          env: { ...process.env, MOTHER_API_ORIGIN: `http://127.0.0.1:${String(API_PORT)}` },
          stdio: ['ignore', logTo('console'), logTo('console.err')],
          detached,
        },
      ),
    );
    await waitFor(`http://127.0.0.1:${String(API_PORT)}/v1/health/ready`, 120_000);
    await waitFor(consoleUrl, 60_000);
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}
