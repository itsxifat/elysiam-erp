import path from 'node:path';
import { createInterface } from 'node:readline';

import { stopSharedContainer } from '@elysium/db/testing';
import { pino } from 'pino';

import type { Actor } from '../audit/audit.js';
import { BrandPools } from '../brands/pools.js';
import { createBrand, rotateOwnerLinkKey } from '../brands/registry.js';
import { bootstrapOwner } from '../cli.js';
import { secretsKeyFrom } from '../crypto/secrets.js';
import { PullService } from '../pull/pull.js';
import { startMotherDatabase } from './harness.js';
import { startPreviewBrands } from './preview-brands.js';

/**
 * The owner console's browser run, provisioned (`pnpm --filter @elysium/mother-console
 * e2e:stack`):
 *
 * - two brand databases, each seeded with its one brand and filled by the brand's own
 *   `preview:seed --brand <slug>` (M32 check 1 as written);
 * - a mother database with its first owner, both brands registered, an owner-link key for
 *   each, and one full read of each.
 *
 * Prints one JSON line (the databases' addresses and the public keys, for the brand APIs the
 * run starts), waits for `stop` on stdin, then drops every database it made.
 *
 * Needs `TEST_DATABASE_URL` (or Docker for a Testcontainer), `E2E_SECRETS_KEY` (the key
 * the mother API is started with), `E2E_PUBLIC_URL` (the console's origin) and
 * `E2E_LOG_DIR`; the brand server must be built.
 */

const SLUGS = ['elysium-lifestyle-bd', 'oura-lifestyle'] as const;

async function main(): Promise<void> {
  const secrets = secretsKeyFrom(process.env.E2E_SECRETS_KEY, 'k1');
  const publicUrl = process.env.E2E_PUBLIC_URL ?? 'http://127.0.0.1:5285';
  const logDir = process.env.E2E_LOG_DIR ?? path.resolve('test-results');
  const preview = await startPreviewBrands(SLUGS, logDir);
  const adminUrl = preview.brands[0]?.database.adminUrl ?? '';
  const mother = await startMotherDatabase(adminUrl);
  const pools = new BrandPools(() => secrets, {
    connectTimeoutSeconds: 5,
    statementTimeoutMs: 20_000,
  });

  const invite = await bootstrapOwner({
    email: 'owner@example.com',
    name: 'Test Owner',
    publicUrl,
  });
  const actor: Actor = {
    userId: invite.userId,
    email: 'owner@example.com',
    name: 'Test Owner',
    ipAddress: null,
    requestId: null,
  };
  const puller = new PullService(pools, 100, pino({ level: 'silent' }));
  const brands = [];
  for (const brand of preview.brands) {
    const row = await createBrand(
      secrets,
      {
        slug: brand.slug,
        displayName: brand.displayName,
        adminUrl: `https://admin.${brand.slug}.example`,
        readConnection: brand.database.analyticsUrl,
      },
      actor,
    );
    const key = await rotateOwnerLinkKey(secrets, row.id, actor);
    const pulled = await puller.pull(row.id, { trigger: 'first', full: true });
    if (pulled.status !== 'ok')
      throw new Error(`the first read of ${brand.slug}: ${pulled.status}`);
    brands.push({
      id: row.id,
      slug: brand.slug,
      publicKey: key.publicKey,
      database: {
        appUrl: brand.database.appUrl,
        ownerUrl: brand.database.ownerUrl,
        analyticsUrl: brand.database.analyticsUrl,
        adminUrl: brand.database.adminUrl,
      },
    });
  }

  process.stdout.write(
    `${JSON.stringify({
      motherAppUrl: mother.appUrl,
      motherOwnerUrl: mother.ownerUrl,
      inviteLink: invite.link,
      email: 'owner@example.com',
      brands,
    })}\n`,
  );

  const lines = createInterface({ input: process.stdin });
  await new Promise<void>((resolve) => {
    lines.on('line', (line) => {
      if (line.trim() === 'stop') resolve();
    });
    lines.on('close', () => resolve());
  });
  await pools.closeAll();
  await mother.stop();
  await preview.stop();
  await stopSharedContainer();
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(`provision failed: ${String(error)}\n`);
  process.exit(1);
});
