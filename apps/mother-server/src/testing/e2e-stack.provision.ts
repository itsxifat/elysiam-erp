import { createInterface } from 'node:readline';

import { pino } from 'pino';

import type { Actor } from '../audit/audit.js';
import { BrandPools } from '../brands/pools.js';
import { createBrand, rotateOwnerLinkKey } from '../brands/registry.js';
import { bootstrapOwner } from '../cli.js';
import { secretsKeyFrom } from '../crypto/secrets.js';
import { PullService } from '../pull/pull.js';
import { startDemoBrands } from './demo-brands.js';
import { startMotherDatabase } from './harness.js';

/**
 * The owner console's browser run, provisioned (`pnpm --filter @elysium/mother-console
 * e2e:stack`): two demo brand databases, a mother database with its first owner, both
 * brands registered and read once, and an owner-link key for the first. Prints one JSON
 * line, waits for `stop` on stdin, then drops every database it made.
 *
 * Needs `TEST_DATABASE_URL` (or Docker for a Testcontainer), `E2E_SECRETS_KEY` (the key
 * the API is started with) and `E2E_PUBLIC_URL` (the console's origin).
 */

async function main(): Promise<void> {
  const secrets = secretsKeyFrom(process.env.E2E_SECRETS_KEY, 'k1');
  const publicUrl = process.env.E2E_PUBLIC_URL ?? 'http://127.0.0.1:5285';
  const demo = await startDemoBrands();
  const adminUrl = demo.brands[0]?.database.adminUrl ?? '';
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
  const brandIds: string[] = [];
  for (const brand of demo.brands) {
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
    brandIds.push(row.id);
    await puller.pull(row.id, { trigger: 'first', full: true });
  }
  const key = await rotateOwnerLinkKey(secrets, brandIds[0] ?? '', actor);

  process.stdout.write(
    `${JSON.stringify({
      motherAppUrl: mother.appUrl,
      motherOwnerUrl: mother.ownerUrl,
      inviteLink: invite.link,
      email: 'owner@example.com',
      publicKey: key.publicKey,
      brandIds,
      brandSlugs: demo.brands.map((brand) => brand.slug),
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
  await demo.stop();
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(`provision failed: ${String(error)}\n`);
  process.exit(1);
});
