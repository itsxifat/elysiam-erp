import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { API_PORT, BRAND_API_PORTS, CONSOLE_PORT } from './stack.config.js';

/**
 * The owner console's stack for one browser run (M32):
 *
 * 1. `e2e-stack.provision.js` from the mother server's build: two brand databases seeded by
 *    the brand's own `preview:seed --brand <slug>`, and a mother database with its first
 *    owner, both brands registered with an owner-link key each, and read once. It stays
 *    alive and drops every database when told to stop.
 * 2. Each brand's own API (the brand server's build), on its own port, with
 *    `ERP_BRAND_SLUG` and the mother's public key in `OWNER_LINK_PUBLIC_KEY`: the real
 *    verifier an owner link meets (M31's `POST /v1/auth/owner-link`), and the brand's own
 *    dashboard that check 1 compares the overview with.
 * 3. The mother API and worker, on this run's port, with the same secrets key.
 * 4. This console's built files under `vite preview`, proxying `/api` and `/v1` to the API.
 *
 * Needs Postgres reachable through `TEST_DATABASE_URL` (or Docker), Valkey from the dev
 * stack (the brand API's limiter), both servers built and this console built.
 */

const CONSOLE_DIR = path.resolve(import.meta.dirname, '..');
const SERVER_DIR = path.resolve(CONSOLE_DIR, '../mother-server');
const BRAND_SERVER_DIR = path.resolve(CONSOLE_DIR, '../server');
const LOG_DIR = path.resolve(CONSOLE_DIR, 'test-results', 'stack');
export const STATE_FILE = path.join(LOG_DIR, 'state.json');

export interface StackBrand {
  readonly id: string;
  readonly slug: string;
  readonly publicKey: string;
  /** Where this brand's own API answers. */
  readonly apiUrl: string;
}

export interface StackState {
  readonly inviteLink: string;
  readonly email: string;
  readonly brands: readonly StackBrand[];
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
  const detached = process.platform !== 'win32';

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
      env: {
        ...process.env,
        E2E_SECRETS_KEY: secretsKey,
        E2E_PUBLIC_URL: consoleUrl,
        E2E_LOG_DIR: LOG_DIR,
      },
      stdio: ['pipe', 'pipe', logTo('provision')],
    });
    const provisioned = JSON.parse(await firstLine(provision, 900_000)) as {
      motherAppUrl: string;
      motherOwnerUrl: string;
      inviteLink: string;
      email: string;
      brands: {
        id: string;
        slug: string;
        publicKey: string;
        database: { appUrl: string; ownerUrl: string; analyticsUrl: string; adminUrl: string };
      }[];
    };

    const brands: StackBrand[] = provisioned.brands.map((brand, index) => {
      const port = BRAND_API_PORTS[index] ?? 3231 + index;
      const apiUrl = `http://127.0.0.1:${String(port)}`;
      children.push(
        spawn(process.execPath, ['--env-file-if-exists=.env', 'dist/main.api.js'], {
          cwd: BRAND_SERVER_DIR,
          env: {
            ...process.env,
            LOG_LEVEL: process.env.E2E_STACK_LOG_LEVEL ?? 'warn',
            DATABASE_URL: brand.database.appUrl,
            DATABASE_OWNER_URL: brand.database.ownerUrl,
            DATABASE_ANALYTICS_URL: brand.database.analyticsUrl,
            DATABASE_ADMIN_URL: brand.database.adminUrl,
            API_HOST: '127.0.0.1',
            API_PORT: String(port),
            API_PUBLIC_URL: apiUrl,
            TRUSTED_ORIGINS: apiUrl,
            APP_DOMAIN: 'localhost',
            REALTIME_ADAPTER_KEY: `e2e-mother-${brand.slug}-${randomBytes(4).toString('hex')}`,
            ERP_BRAND_SLUG: brand.slug,
            OWNER_LINK_PUBLIC_KEY: brand.publicKey,
            // As the brand's own stack run starts it: nothing here reaches a real provider.
            STOREFRONT_CREDENTIALS_KEY: randomBytes(32).toString('base64'),
            NOTIFY_EMAIL_PROVIDER: 'fake',
            STOREFRONT_SSLCOMMERZ_PROVIDER: 'fake',
          },
          stdio: ['ignore', logTo(`brand-${brand.slug}`), logTo(`brand-${brand.slug}.err`)],
          detached,
        }),
      );
      return { id: brand.id, slug: brand.slug, publicKey: brand.publicKey, apiUrl };
    });

    const state: StackState = {
      inviteLink: provisioned.inviteLink,
      email: provisioned.email,
      brands,
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
    for (const brand of brands) await waitFor(`${brand.apiUrl}/health/live`, 120_000);
    await waitFor(consoleUrl, 60_000);
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}
