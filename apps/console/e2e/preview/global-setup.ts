import { mkdirSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  bootstrapAndMigrate,
  databaseUrls,
  dropDatabase,
  killTree,
  postgresReady,
  recreateDatabase,
  seedPreview,
  startStack,
  waitForStack,
} from '../../../../scripts/preview-stack.mjs';

/**
 * A throwaway preview for the smoke run, made exactly as `pnpm preview:local` makes the
 * owner's: a fresh `elysium_preview_e2e` database, migrated, `preview:seed`, then the API,
 * the worker and the three apps on this run's own ports. The sign-ins are read back from
 * the credentials file the seed wrote, as the owner reads them. Torn down afterwards,
 * database included.
 */

export const PREVIEW_PORTS = { api: 3130, console: 5193, portal: 5194, pos: 5195 } as const;
const DATABASE = 'elysium_preview_e2e';
const CONSOLE_DIR = path.resolve(import.meta.dirname, '../..');
const RESULTS_DIR = path.resolve(CONSOLE_DIR, 'test-results', 'preview');

export interface PreviewLoginInfo {
  readonly label: string;
  readonly email: string;
  readonly password: string;
  readonly twoFactor: boolean;
}

export interface PreviewInfo {
  /** By the email's local part: `superadmin`, `admin`, `accounts`, `sales`, … */
  readonly logins: Readonly<Record<string, PreviewLoginInfo>>;
  readonly tracking: { readonly orderNo: string; readonly digits: string } | null;
  readonly urls: { readonly console: string; readonly portal: string; readonly pos: string };
}

/** The credentials file's table rows and its tracking line, as the owner would read them. */
export function parseCredentials(text: string): Omit<PreviewInfo, 'urls'> {
  const logins: Record<string, PreviewLoginInfo> = {};
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const email = /^`([^`]+@[^`]+)`$/.exec(cells[3] ?? '')?.[1];
    const password = /^`([^`]+)`$/.exec(cells[4] ?? '')?.[1];
    if (email === undefined || password === undefined) continue;
    logins[email.split('@')[0] ?? email] = {
      label: cells[1] ?? '',
      email,
      password,
      twoFactor: (cells[5] ?? '').startsWith('Yes'),
    };
  }
  const tracking = /order number `([^`]+)` and phone digits `(\d{4})`/.exec(text);
  return {
    logins,
    tracking:
      tracking?.[1] === undefined || tracking[2] === undefined
        ? null
        : { orderNo: tracking[1], digits: tracking[2] },
  };
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const urls = databaseUrls(DATABASE);
  if (!(await postgresReady(urls))) {
    throw new Error('Postgres is not answering: start infra/docker-compose.dev.yml first.');
  }
  await recreateDatabase(urls);
  await bootstrapAndMigrate(urls);

  const out = path.join(RESULTS_DIR, 'preview-credentials.md');
  const seedLog = openSync(path.join(RESULTS_DIR, 'seed.log'), 'w');
  await seedPreview(urls, PREVIEW_PORTS, { out, stdio: ['ignore', seedLog, seedLog] });

  const info: PreviewInfo = {
    ...parseCredentials(readFileSync(out, 'utf8')),
    urls: {
      console: `http://localhost:${String(PREVIEW_PORTS.console)}`,
      portal: `http://localhost:${String(PREVIEW_PORTS.portal)}`,
      pos: `http://localhost:${String(PREVIEW_PORTS.pos)}`,
    },
  };
  process.env.E2E_PREVIEW = JSON.stringify(info);

  const children = startStack(urls, PREVIEW_PORTS, { logDir: RESULTS_DIR });
  const teardown = async () => {
    for (const child of children) killTree(child);
    await dropDatabase(urls);
  };
  try {
    await waitForStack(PREVIEW_PORTS);
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}
