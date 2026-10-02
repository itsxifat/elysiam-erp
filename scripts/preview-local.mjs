#!/usr/bin/env node
/**
 * `pnpm preview:local` — the whole ERP on this PC, with demo data, for a person to try.
 *
 *   pnpm preview:local            a fresh preview: new database, new demo data, new passwords
 *   pnpm preview:local --keep     start again on the existing preview data
 *   pnpm preview:local --no-start prepare the database and stop (no servers)
 *
 * Steps: start Docker's Postgres and Valkey if they are not up, build the server, make a
 * fresh `elysium_preview` database (never `elysium_dev`), migrate it, run `preview:seed`,
 * then start the API, the worker, the staff console, the investor/tracking portal and the
 * showroom till, and print where to open them. Ctrl+C stops everything.
 *
 * The sign-ins are in `preview-credentials.local.md` at the repository root (gitignored).
 * The server logs are in `.preview/logs/`. See docs/testing-guide.md.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  bootstrapAndMigrate,
  databaseExists,
  databaseUrls,
  killTree,
  pnpm,
  portInUse,
  postgresReady,
  recreateDatabase,
  REPO_ROOT,
  run,
  seedPreview,
  startStack,
  waitForStack,
} from './preview-stack.mjs';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const noStart = args.includes('--no-start');
const database = process.env.PREVIEW_DATABASE ?? 'elysium_preview';
const ports = {
  api: Number(process.env.PREVIEW_API_PORT ?? 3000),
  console: Number(process.env.PREVIEW_CONSOLE_PORT ?? 5173),
  portal: Number(process.env.PREVIEW_PORTAL_PORT ?? 5174),
  pos: Number(process.env.PREVIEW_POS_PORT ?? 5175),
};
const credentials = path.join(REPO_ROOT, 'preview-credentials.local.md');
const logDir = path.join(REPO_ROOT, '.preview', 'logs');

function say(text) {
  process.stdout.write(`${text}\n`);
}

async function main() {
  say('preview:local');

  if (!existsSync(path.join(REPO_ROOT, 'apps', 'server', '.env'))) {
    say('- writing local settings (pnpm setup:env)');
    await pnpm(['setup:env']);
  }

  let urls = databaseUrls(database);
  if (!(await postgresReady(urls))) {
    say('- starting Postgres and Valkey in Docker');
    await run('docker', ['compose', '-f', 'infra/docker-compose.dev.yml', 'up', '-d', '--wait']);
  }

  if (!noStart) {
    const busy = [];
    for (const [name, port] of Object.entries(ports)) {
      if (await portInUse(port)) busy.push(`${name} ${String(port)}`);
    }
    if (busy.length > 0) {
      throw new Error(
        `Port(s) already in use: ${busy.join(', ')}. Stop \`pnpm dev\` or the other preview first.`,
      );
    }
  }

  say('- building the server (fast when nothing changed)');
  await pnpm([
    'exec',
    'turbo',
    'run',
    'build',
    '--filter=@elysium/server',
    '--output-logs=errors-only',
  ]);

  const exists = await databaseExists(urls);
  if (keep && exists) {
    say(`- keeping the existing ${database} database and its data`);
  } else {
    say(`- making a fresh ${database} database`);
    await recreateDatabase(urls);
    urls = databaseUrls(database);
    await bootstrapAndMigrate(urls);
    say('- filling it with demo data (about a minute)');
    await seedPreview(urls, ports, { out: credentials });
  }

  if (noStart) {
    say(`Prepared. Sign-ins: ${credentials}`);
    return;
  }

  say('- starting the API, the worker and the three apps');
  const children = startStack(urls, ports, { logDir });
  const stop = () => {
    for (const child of children) killTree(child);
  };
  process.once('SIGINT', () => {
    say('\nStopping the preview…');
    stop();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    stop();
    process.exit(0);
  });
  for (const child of children) {
    child.once('exit', (code) => {
      if (code !== 0 && code !== null) {
        say(`A preview process stopped (exit ${String(code)}). Logs: ${logDir}`);
      }
    });
  }
  try {
    await waitForStack(ports);
  } catch (error) {
    stop();
    throw error;
  }

  say('');
  say('The preview is running. Open these in Chrome or Edge:');
  say(`  Staff console          http://localhost:${String(ports.console)}`);
  say(`  Investor portal        http://localhost:${String(ports.portal)}`);
  say(
    `  Order tracking         http://localhost:${String(ports.portal)}/track/elysium-lifestyle-bd`,
  );
  say(`  Showroom till          http://localhost:${String(ports.pos)}`);
  say('');
  say(`Sign-ins (emails and passwords): ${credentials}`);
  say('What to try: docs/testing-guide.md');
  say('Press Ctrl+C here to stop the preview.');
  await new Promise(() => undefined);
}

main().catch((error) => {
  process.stderr.write(
    `preview:local failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
