import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startTestDatabase, type TestDatabase } from '@elysium/db/testing';
import postgres from 'postgres';

/**
 * Brand databases the way a brand's own ERP is previewed (D-470): each its own database,
 * bootstrapped and migrated by `@elysium/db`, seeded with one brand (`db:seed --brand`),
 * then filled by the brand's own `preview:seed --brand <slug>`, which works a few weeks of
 * a brand's business through the brand server's real routes and checks its books.
 *
 * The brand's seed is run as the brand ships it: its built CLI
 * (`apps/server/dist/main.preview.js`) in a child process. Nothing of the brand server is
 * imported here. Needs the brand server built and Valkey from the dev stack.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRAND_SERVER = path.resolve(HERE, '../../../server');
const PREVIEW_MARKER = 'elysium-preview';

export interface PreviewBrand {
  readonly slug: string;
  readonly displayName: string;
  readonly database: TestDatabase;
}

const NAMES: Readonly<Record<string, string>> = {
  'elysium-lifestyle-bd': 'Elysium Lifestyle BD',
  'oura-lifestyle': 'Oura Lifestyle',
  orvo: 'Orvo',
  'wear-x-clothing': 'Wear X Clothing',
  beownz: 'Beownz',
};

async function runPreviewSeed(slug: string, database: TestDatabase, logDir: string): Promise<void> {
  mkdirSync(logDir, { recursive: true });
  const log = createWriteStream(path.join(logDir, `preview-seed-${slug}.log`));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--env-file-if-exists=.env', 'dist/main.preview.js', '--brand', slug, '--out', '-'],
      {
        cwd: BRAND_SERVER,
        env: {
          ...process.env,
          DATABASE_URL: database.appUrl,
          DATABASE_OWNER_URL: database.ownerUrl,
          DATABASE_ANALYTICS_URL: database.analyticsUrl,
          DATABASE_ADMIN_URL: database.adminUrl,
          ERP_BRAND_SLUG: slug,
          PREVIEW_LOG_LEVEL: 'warn',
        },
        // stdout is the sign-ins file; nobody needs it here.
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    child.stderr.pipe(log);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`preview:seed --brand ${slug} exited ${String(code)}; see ${logDir}`));
    });
  });
}

/** Mark a throwaway database as a preview, which `preview:seed` insists on. */
async function markPreview(database: TestDatabase): Promise<void> {
  const admin = postgres(database.adminUrl, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`comment on database "${database.databaseName}" is '${PREVIEW_MARKER}'`);
  } finally {
    await admin.end();
  }
}

export async function startPreviewBrands(
  slugs: readonly string[],
  logDir: string,
): Promise<{ readonly brands: readonly PreviewBrand[]; stop(): Promise<void> }> {
  const brands: PreviewBrand[] = [];
  const provided = process.env.TEST_DATABASE_URL;
  try {
    for (const slug of slugs) {
      // `db:seed --brand`: this database holds this brand and no other.
      const database = await startTestDatabase(`pv_${slug.slice(0, 8).replace(/-/g, '_')}`, {
        brands: [slug],
      });
      // The next brand on the same server: its own database beside this one.
      process.env.TEST_DATABASE_URL = database.adminUrl;
      await markPreview(database);
      await runPreviewSeed(slug, database, logDir);
      brands.push({ slug, displayName: NAMES[slug] ?? slug, database });
    }
  } finally {
    if (provided === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = provided;
  }
  return {
    brands,
    async stop() {
      for (const brand of [...brands].reverse()) await brand.database.stop();
    },
  };
}
