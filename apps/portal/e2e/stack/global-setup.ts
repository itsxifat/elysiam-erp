import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

/**
 * The real stack for the investor portal's Playwright run (M25 check 1).
 *
 * Starts, in order, and stops again in the returned teardown:
 *
 * 1. **A throwaway database** seeded through the real API —
 *    `investor-portal-stack.provision.js`, compiled with the server. It stays alive for the
 *    run and drops the database when told to stop.
 * 2. **The API and the worker**, from `apps/server/dist`, pointed at that database. The
 *    spec only reads — the money was posted inside the provisioning — but the API will not
 *    start until the worker has installed the job queue's schema, so the worker comes too.
 * 3. **The portal**, served by Vite from its own config.
 *
 * Its own ports (3120, 5185), so it collides neither with a dev server nor with the
 * console's stack run (3110, 5183). `localhost` throughout, never 127.0.0.1: the CSRF cookie
 * is read by script and scoped by host (D-053). Every child is killed as a process tree when
 * the run ends.
 */

export const API_PORT = 3120;
export const PORTAL_PORT = 5185;
export const API_URL = `http://localhost:${String(API_PORT)}`;
export const PORTAL_URL = `http://localhost:${String(PORTAL_PORT)}`;

const PORTAL_DIR = path.resolve(import.meta.dirname, '../..');
const SERVER_DIR = path.resolve(PORTAL_DIR, '../server');
const LOG_DIR = path.resolve(PORTAL_DIR, 'test-results', 'stack');

export interface StackInfo {
  readonly apiUrl: string;
  readonly password: string;
  readonly users: readonly { readonly role: 'alpha' | 'beta'; readonly email: string }[];
  readonly brands: {
    readonly elysium: { readonly orgId: string; readonly alpha: string; readonly beta: string };
    readonly oura: { readonly orgId: string; readonly alpha: string };
  };
  readonly documents: { readonly alpha: string; readonly beta: string };
  readonly betaWithdrawal: string;
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
      reject(
        new Error(`provisioning exited with ${String(code)}; see test-results/stack/provision.log`),
      );
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

  const teardown = async () => {
    for (const child of children.reverse()) killTree(child);
    if (provision?.exitCode === null) {
      provision.stdin?.write('stop\n');
      provision.stdin?.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          killTree(provision);
          resolve();
        }, 30_000);
        provision?.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };

  try {
    provision = spawn(
      process.execPath,
      ['--env-file=.env', 'dist/modules/investors/investor-portal-stack.provision.js', 'create'],
      { cwd: SERVER_DIR, env: process.env, stdio: ['pipe', 'pipe', logTo('provision')] },
    );
    const provisioned = JSON.parse(await firstLine(provision, 300_000)) as {
      appUrl: string;
      ownerUrl: string;
      analyticsUrl: string;
      adminUrl: string;
    } & Omit<StackInfo, 'apiUrl'>;

    const serverEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: provisioned.appUrl,
      DATABASE_OWNER_URL: provisioned.ownerUrl,
      DATABASE_ANALYTICS_URL: provisioned.analyticsUrl,
      DATABASE_ADMIN_URL: provisioned.adminUrl,
      API_PORT: String(API_PORT),
      API_PUBLIC_URL: API_URL,
      TRUSTED_ORIGINS: PORTAL_URL,
      APP_DOMAIN: 'localhost',
      // This run's own broadcast channel: no other stack's worker delivers into it, and
      // this one delivers into no other.
      REALTIME_ADAPTER_KEY: `e2e-portal-${randomBytes(4).toString('hex')}`,
      LOG_LEVEL: process.env.E2E_STACK_LOG_LEVEL ?? 'warn',
    };

    const detached = process.platform !== 'win32';
    children.push(
      spawn(process.execPath, ['--env-file=.env', 'dist/main.api.js'], {
        cwd: SERVER_DIR,
        env: serverEnv,
        stdio: ['ignore', logTo('api'), logTo('api.err')],
        detached,
      }),
      spawn(process.execPath, ['--env-file=.env', 'dist/main.worker.js'], {
        cwd: SERVER_DIR,
        env: serverEnv,
        stdio: ['ignore', logTo('worker'), logTo('worker.err')],
        detached,
      }),
      spawn(
        process.execPath,
        [
          path.join(PORTAL_DIR, 'node_modules', 'vite', 'bin', 'vite.js'),
          '--port',
          String(PORTAL_PORT),
          '--strictPort',
          '--host',
          'localhost',
        ],
        {
          cwd: PORTAL_DIR,
          // Wins over `apps/portal/.env`: Vite never overwrites a variable already set.
          env: { ...process.env, VITE_API_URL: API_URL },
          stdio: ['ignore', logTo('portal'), logTo('portal.err')],
          detached,
        },
      ),
    );

    await waitFor(`${API_URL}/health/live`, 120_000);
    await waitFor(PORTAL_URL, 120_000);

    const info: StackInfo = {
      apiUrl: API_URL,
      password: provisioned.password,
      users: provisioned.users,
      brands: provisioned.brands,
      documents: provisioned.documents,
      betaWithdrawal: provisioned.betaWithdrawal,
    };
    // Inherited by the test workers. Throwaway values only, and never printed.
    process.env.E2E_STACK = JSON.stringify(info);
    return teardown;
  } catch (error) {
    await teardown();
    throw error;
  }
}
