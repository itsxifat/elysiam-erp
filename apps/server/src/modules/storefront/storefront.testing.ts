import { createHash, randomUUID } from 'node:crypto';

import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import {
  deriveStorefrontSecret,
  fingerprint,
  KEY_HEADER,
  newKeyId,
  signStorefront,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from './signature.js';

/**
 * Test helpers for the website module (M33). Test-only: nothing here is imported by the
 * application.
 */

/** The master key the test environment sets (`testing/test-env.ts`). */
export const TEST_MASTER_KEY = 'test-intake-key-secret-at-least-32-characters';

export interface TestSiteKey {
  readonly id: string;
  readonly keyId: string;
  readonly secret: string;
}

/**
 * A website key written straight into the table, the way the issue route would write it.
 * The suites that are not about issuing keys use this, so they do not depend on a session.
 */
export async function insertTestSiteKey(
  orgId: string,
  options: { readonly master?: string; readonly revoked?: boolean } = {},
): Promise<TestSiteKey> {
  const keyId = newKeyId(orgId);
  const secret = deriveStorefrontSecret(options.master ?? TEST_MASTER_KEY, keyId);
  const id = await withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into storefront.site_keys
          (org_id, label, key_id, secret_sha256, created_by, revoked_at, revoked_by)
        values (${orgId}, 'Test website', ${keyId}, ${fingerprint(secret)}, 'usr_storefront_test',
                ${options.revoked === true ? sql`now()` : null},
                ${options.revoked === true ? 'usr_storefront_test' : null})
        returning id
      `);
      const row = rows[0];
      if (row === undefined) throw new Error('seeding a website key returned no id');
      return row.id;
    },
    { orgId },
  );
  return { id, keyId, secret };
}

/** The signed headers for a GET of `pathAndQuery`, at `now` unless told otherwise. */
export function signedHeaders(
  key: { readonly keyId: string; readonly secret: string },
  pathAndQuery: string,
  options: { readonly timestamp?: string; readonly method?: string } = {},
): Record<string, string> {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  return {
    [KEY_HEADER]: key.keyId,
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: signStorefront(key.secret, {
      timestamp,
      method: options.method ?? 'GET',
      pathAndQuery,
    }),
  };
}

/** A signed GET through the real application. */
export async function signedGet(
  server: FastifyInstance,
  key: { readonly keyId: string; readonly secret: string },
  pathAndQuery: string,
  extra: Record<string, string> = {},
) {
  return server.inject({
    method: 'GET',
    url: pathAndQuery,
    headers: { ...signedHeaders(key, pathAndQuery), ...extra },
  });
}

/**
 * A stored public image row with its three sizes recorded, without bytes. Enough for every
 * route that only checks a file is a public website image; the media path's own tests upload
 * real bytes through the files routes.
 */
export async function insertPublicImageRow(
  orgId: string,
  purpose: 'storefront-image' | 'category-image' | 'product-image' = 'storefront-image',
): Promise<string> {
  const id = randomUUID();
  const sha = createHash('sha256').update(id).digest('hex');
  const variant = (name: string, width: number, height: number) => ({
    key: `public/${orgId}/test/${id}-${name}.webp`,
    width,
    height,
    sizeBytes: 10,
    mime: 'image/webp',
    sha256: sha,
  });
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into files.objects
          (id, org_id, storage_key, driver, visibility, status, purpose, mime, size_bytes, sha256,
           variants, processed_at)
        values (${id}, ${orgId}, ${`public/${orgId}/test/${id}.png`}, 'local', 'public', 'stored',
                ${purpose}, 'image/png', 10, ${sha},
                ${JSON.stringify({
                  thumb: variant('thumb', 160, 62),
                  card: variant('card', 640, 250),
                  full: variant('full', 1600, 625),
                })}::jsonb, now())
      `);
    },
    { orgId },
  );
  return id;
}
