import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

/**
 * The real stack for the order desk's Playwright run (M11 checks 1 and 4).
 *
 * Starts, in order, and stops again in the returned teardown:
 *
 * 1. **A throwaway database with throwaway users** — the server's own
 *    `desk-stack.provision.js`, built from the fixtures every server suite uses
 *    (`createTestUser`, `grantMembership`, Better Auth's reset flow, `startTestDatabase`).
 *    It stays alive for the run and drops the database when told to stop.
 * 2. **The API and the worker**, from `apps/server/dist`, pointed at that database. The
 *    worker is not optional: it is the outbox dispatcher, and check 4 is the outbox →
 *    Socket.IO path working end to end.
 * 3. **The console**, served by Vite from `e2e/stack/vite.config.ts`.
 *
 * Ports and the realtime channel key are this run's own, so it neither collides with a dev
 * server on 3000/5173 nor receives another stack's broadcasts. Every child is killed as a
 * process tree when the run ends — the machine this runs on has killed stray dev servers for
 * memory before.
 *
 * Requires `apps/server/dist` to be built (`pnpm --filter @elysium/server build`), Postgres
 * and Valkey from `infra/docker-compose.dev.yml`, and `apps/server/.env`.
 */

/**
 * The ports, overridable for a machine where another worktree's preview already holds
 * one (`E2E_API_PORT`, `E2E_CONSOLE_PORT`). The defaults are what every spec assumes.
 */
export const API_PORT = Number(process.env.E2E_API_PORT ?? 3110);
export const CONSOLE_PORT = Number(process.env.E2E_CONSOLE_PORT ?? 5183);
export const API_URL = `http://localhost:${String(API_PORT)}`;
export const CONSOLE_URL = `http://localhost:${String(CONSOLE_PORT)}`;

const CONSOLE_DIR = path.resolve(import.meta.dirname, '../..');
const SERVER_DIR = path.resolve(CONSOLE_DIR, '../server');
const LOG_DIR = path.resolve(CONSOLE_DIR, 'test-results', 'stack');

export interface StackInfo {
  readonly apiUrl: string;
  readonly orgId: string;
  readonly password: string;
  readonly users: readonly {
    readonly role: string;
    readonly email: string;
    readonly userId: string;
  }[];
  readonly skuCodes: readonly string[];
  /** A 10%-off code seeded for the brand, for M16 check 5. */
  readonly promoCode: string;
  /** A buyer whose only order was delivered a hundred days ago (M16's lapsed list). */
  readonly lapsedBuyer: { readonly id: string; readonly name: string };
  /** A pending order the desk agent works, for M17's advance claim. */
  readonly advanceOrder: { readonly id: string; readonly orderNo: string };
  /** A pending order the desk walks to delivered with the lifecycle buttons (D-392). */
  readonly lifecycleOrder: { readonly id: string; readonly orderNo: string };
  /** A confirmed order, its units held, for bulk pack (D-393). */
  readonly bulkOrder: { readonly id: string; readonly orderNo: string };
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

/** Kill a child and everything it started. `taskkill /T` on Windows, a group kill elsewhere. */
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
    const provisionLog = logTo('provision');
    provision = spawn(
      process.execPath,
      ['--env-file=.env', 'dist/modules/orders/desk-stack.provision.js', 'create'],
      {
        cwd: SERVER_DIR,
        env: { ...process.env, E2E_API_URL: API_URL, E2E_CONSOLE_URL: CONSOLE_URL },
        stdio: ['pipe', 'pipe', provisionLog],
      },
    );
    const provisioned = JSON.parse(await firstLine(provision, 240_000)) as {
      appUrl: string;
      ownerUrl: string;
      analyticsUrl: string;
      adminUrl: string;
      orgId: string;
      password: string;
      users: StackInfo['users'];
      skuCodes: string[];
      promoCode: string;
      lapsedBuyer: StackInfo['lapsedBuyer'];
      advanceOrder: StackInfo['advanceOrder'];
      lifecycleOrder: StackInfo['lifecycleOrder'];
      bulkOrder: StackInfo['bulkOrder'];
    };

    const serverEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: provisioned.appUrl,
      DATABASE_OWNER_URL: provisioned.ownerUrl,
      DATABASE_ANALYTICS_URL: provisioned.analyticsUrl,
      DATABASE_ADMIN_URL: provisioned.adminUrl,
      API_PORT: String(API_PORT),
      API_PUBLIC_URL: API_URL,
      TRUSTED_ORIGINS: CONSOLE_URL,
      APP_DOMAIN: 'localhost',
      // This run's own broadcast channel: a worker from another stack must not deliver
      // into these sockets, and this worker must not deliver into another's.
      REALTIME_ADAPTER_KEY: `e2e-desk-${randomBytes(4).toString('hex')}`,
      LOG_LEVEL: process.env.E2E_STACK_LOG_LEVEL ?? 'warn',
      // M34: the website's credentials can be kept, and email and SSLCommerz are recorders,
      // so Website → Payments and Email are exercised without reaching anything real.
      STOREFRONT_CREDENTIALS_KEY:
        process.env.STOREFRONT_CREDENTIALS_KEY ?? randomBytes(32).toString('base64'),
      NOTIFY_EMAIL_PROVIDER: 'fake',
      STOREFRONT_SSLCOMMERZ_PROVIDER: 'fake',
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
          path.join(CONSOLE_DIR, 'node_modules', 'vite', 'bin', 'vite.js'),
          '--config',
          'e2e/stack/vite.config.ts',
          '--port',
          String(CONSOLE_PORT),
          '--strictPort',
          '--host',
          'localhost',
        ],
        {
          cwd: CONSOLE_DIR,
          env: { ...process.env, VITE_API_URL: API_URL },
          stdio: ['ignore', logTo('console'), logTo('console.err')],
          detached,
        },
      ),
    );

    await waitFor(`${API_URL}/health/live`, 120_000);
    await waitFor(CONSOLE_URL, 120_000);

    const info: StackInfo = {
      apiUrl: API_URL,
      orgId: provisioned.orgId,
      password: provisioned.password,
      users: provisioned.users,
      skuCodes: provisioned.skuCodes,
      promoCode: provisioned.promoCode,
      lapsedBuyer: provisioned.lapsedBuyer,
      advanceOrder: provisioned.advanceOrder,
      lifecycleOrder: provisioned.lifecycleOrder,
      bulkOrder: provisioned.bulkOrder,
    };
    // Inherited by the test workers. Throwaway values only, and never printed.
    process.env.E2E_STACK = JSON.stringify(info);
    return teardown;
  } catch (error) {
    await teardown();
    throw error;
  }
}
