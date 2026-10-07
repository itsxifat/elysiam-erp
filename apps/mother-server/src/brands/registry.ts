import { randomUUID } from 'node:crypto';

import type {
  BrandCreateInput,
  BrandStatusWire,
  BrandUpdateInput,
  OwnerLinkKeyWire,
  SchemaStatus,
} from '@elysium/mother-shared';
import type { Sql, TransactionSql } from 'postgres';

import { recordAudit, type Actor } from '../audit/audit.js';
import { generateOwnerLinkKeyPair } from '../crypto/owner-link.js';
import { fingerprint, open, seal, type SecretsKey } from '../crypto/secrets.js';
import { inMother, motherSql } from '../db/client.js';
import { MotherError } from '../http/errors.js';
import { expectedBrandSchema } from './reader.js';

/**
 * The brand registry (D-481, D-490): which brands the mother reads, how to reach each one,
 * and the key that signs each one's owner links.
 *
 * Secrets go in sealed and come out only to the code that uses them: a read connection to
 * the pool that opens it, a private key to the minter. No response, log line or audit row
 * carries either; they carry a fingerprint, which says which one is set and nothing more.
 */

export interface BrandRow {
  readonly id: string;
  readonly slug: string;
  readonly display_name: string;
  readonly admin_url: string;
  readonly read_connection_cipher: Buffer;
  readonly read_connection_key_id: string;
  readonly read_connection_fingerprint: string;
  readonly owner_link_key_cipher: Buffer | null;
  readonly owner_link_key_fingerprint: string | null;
  readonly owner_link_key_created_at: Date | null;
  readonly is_active: boolean;
  readonly position: number;
  readonly brand_org_id: string | null;
  readonly schema_status: SchemaStatus;
  readonly brand_migrations: number | null;
  readonly last_attempt_at: Date | null;
  readonly figures_at: Date | null;
  readonly last_error_code: string | null;
  readonly last_error_at: Date | null;
  readonly created_at: Date;
}

const COLUMNS = `id, slug, display_name, admin_url, read_connection_cipher, read_connection_key_id,
  read_connection_fingerprint, owner_link_key_cipher, owner_link_key_fingerprint,
  owner_link_key_created_at, is_active, position, brand_org_id::text as brand_org_id,
  schema_status, brand_migrations, last_attempt_at, figures_at, last_error_code, last_error_at,
  created_at`;

export async function listBrands(sql: Sql | TransactionSql = motherSql()): Promise<BrandRow[]> {
  return [
    ...(await sql<BrandRow[]>`
      select ${sql.unsafe(COLUMNS)} from mother.brands order by position, display_name, slug
    `),
  ];
}

export async function findBrand(
  id: string,
  sql: Sql | TransactionSql = motherSql(),
): Promise<BrandRow | undefined> {
  const [row] = await sql<BrandRow[]>`
    select ${sql.unsafe(COLUMNS)} from mother.brands where id = ${id}
  `;
  return row;
}

export async function requireBrand(id: string): Promise<BrandRow> {
  const row = await findBrand(id);
  if (row === undefined) throw new MotherError('NOT_FOUND', 'No such brand.');
  return row;
}

export function brandStatusWire(row: BrandRow): BrandStatusWire {
  const expected = expectedBrandSchema();
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    adminUrl: row.admin_url,
    isActive: row.is_active,
    figuresAt: row.figures_at?.toISOString() ?? null,
    lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
    lastError:
      row.last_error_code === null || row.last_error_at === null
        ? null
        : { code: row.last_error_code, at: row.last_error_at.toISOString() },
    schema: row.schema_status,
    brandMigrations: row.brand_migrations,
    expectedMigrations: expected.count,
    hasOwnerLinkKey: row.owner_link_key_cipher !== null,
    ownerLinkKeyFingerprint: row.owner_link_key_fingerprint,
    connectionFingerprint: row.read_connection_fingerprint,
  };
}

/** The read connection, opened for the pool that uses it. */
export function readConnectionOf(secrets: SecretsKey, row: BrandRow): string {
  return open(secrets, row.read_connection_cipher, {
    brandId: row.id,
    field: 'read_connection',
  }).toString('utf8');
}

export function ownerLinkKeyOf(secrets: SecretsKey, row: BrandRow): Buffer {
  if (row.owner_link_key_cipher === null) {
    throw new MotherError(
      'OWNER_LINK_KEY_MISSING',
      'This brand has no owner sign-in key yet. Make one under Brands first.',
    );
  }
  return open(secrets, row.owner_link_key_cipher, { brandId: row.id, field: 'owner_link_key' });
}

function sealedConnection(secrets: SecretsKey, brandId: string, url: string) {
  const sealed = seal(secrets, Buffer.from(url, 'utf8'), { brandId, field: 'read_connection' });
  return { ...sealed, fingerprint: fingerprint(url) };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === '23505';
}

export async function createBrand(
  secrets: SecretsKey,
  input: BrandCreateInput,
  actor: Actor,
): Promise<BrandRow> {
  const id = randomUUID();
  const connection = sealedConnection(secrets, id, input.readConnection);
  try {
    return await inMother(async (tx) => {
      const [position] = await tx<{ next: number }[]>`
        select coalesce(max(position), 0)::int + 1 as next from mother.brands
      `;
      await tx`
        insert into mother.brands
          (id, slug, display_name, admin_url, read_connection_cipher, read_connection_key_id,
           read_connection_fingerprint, position, created_by)
        values (${id}, ${input.slug}, ${input.displayName}, ${input.adminUrl},
                ${connection.ciphertext}, ${connection.keyId}, ${connection.fingerprint},
                ${position?.next ?? 1}, ${actor.userId})
      `;
      await recordAudit(
        {
          actorUserId: actor.userId,
          action: 'brand.added',
          entityType: 'brand',
          entityId: id,
          detail: {
            slug: input.slug,
            displayName: input.displayName,
            adminUrl: input.adminUrl,
            connectionFingerprint: connection.fingerprint,
          },
          ipAddress: actor.ipAddress,
          requestId: actor.requestId,
        },
        tx,
      );
      const row = await findBrand(id, tx);
      if (row === undefined) throw new Error('the brand insert returned nothing');
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new MotherError('BRAND_SLUG_TAKEN', 'A brand with that slug is already registered.');
    }
    throw error;
  }
}

export async function updateBrand(
  secrets: SecretsKey,
  id: string,
  input: BrandUpdateInput,
  actor: Actor,
): Promise<BrandRow> {
  return inMother(async (tx) => {
    const [before] = await tx<BrandRow[]>`
      select ${tx.unsafe(COLUMNS)} from mother.brands where id = ${id} for update
    `;
    if (before === undefined) throw new MotherError('NOT_FOUND', 'No such brand.');
    const connection =
      input.readConnection === undefined
        ? undefined
        : sealedConnection(secrets, id, input.readConnection);
    await tx`
      update mother.brands set
        display_name = ${input.displayName ?? before.display_name},
        admin_url = ${input.adminUrl ?? before.admin_url},
        is_active = ${input.isActive ?? before.is_active},
        read_connection_cipher = ${connection?.ciphertext ?? before.read_connection_cipher},
        read_connection_key_id = ${connection?.keyId ?? before.read_connection_key_id},
        read_connection_fingerprint = ${connection?.fingerprint ?? before.read_connection_fingerprint},
        -- A new connection is a new source: what it says about the schema is unknown again.
        schema_status = ${connection === undefined ? before.schema_status : 'unknown'},
        updated_at = now()
      where id = ${id}
    `;
    const changed: Record<string, unknown> = {};
    if (input.displayName !== undefined && input.displayName !== before.display_name) {
      changed.displayName = { from: before.display_name, to: input.displayName };
    }
    if (input.adminUrl !== undefined && input.adminUrl !== before.admin_url) {
      changed.adminUrl = { from: before.admin_url, to: input.adminUrl };
    }
    if (input.isActive !== undefined && input.isActive !== before.is_active) {
      changed.isActive = { from: before.is_active, to: input.isActive };
    }
    if (connection !== undefined) {
      changed.connectionFingerprint = {
        from: before.read_connection_fingerprint,
        to: connection.fingerprint,
      };
    }
    await recordAudit(
      {
        actorUserId: actor.userId,
        action: 'brand.changed',
        entityType: 'brand',
        entityId: id,
        detail: { slug: before.slug, changed },
        ipAddress: actor.ipAddress,
        requestId: actor.requestId,
      },
      tx,
    );
    const row = await findBrand(id, tx);
    if (row === undefined) throw new Error('the brand vanished mid-update');
    return row;
  });
}

/**
 * A new owner-link key pair for a brand (D-490). The private key is sealed and stored; the
 * public key is returned once, to paste into the brand's `OWNER_LINK_PUBLIC_KEY`. Links
 * minted with the old key stop working at the brand as soon as its env holds the new one.
 */
export async function rotateOwnerLinkKey(
  secrets: SecretsKey,
  id: string,
  actor: Actor,
): Promise<OwnerLinkKeyWire> {
  const pair = generateOwnerLinkKeyPair();
  const sealed = seal(secrets, pair.privateKeyDer, { brandId: id, field: 'owner_link_key' });
  return inMother(async (tx) => {
    const [before] = await tx<{ slug: string; owner_link_key_fingerprint: string | null }[]>`
      select slug, owner_link_key_fingerprint from mother.brands where id = ${id} for update
    `;
    if (before === undefined) throw new MotherError('NOT_FOUND', 'No such brand.');
    await tx`
      update mother.brands set
        owner_link_key_cipher = ${sealed.ciphertext},
        owner_link_key_id = ${sealed.keyId},
        owner_link_key_fingerprint = ${pair.fingerprint},
        owner_link_key_created_at = now(),
        updated_at = now()
      where id = ${id}
    `;
    await recordAudit(
      {
        actorUserId: actor.userId,
        action:
          before.owner_link_key_fingerprint === null
            ? 'brand.owner_link_key.created'
            : 'brand.owner_link_key.rotated',
        entityType: 'brand',
        entityId: id,
        detail: {
          slug: before.slug,
          from: before.owner_link_key_fingerprint,
          to: pair.fingerprint,
        },
        ipAddress: actor.ipAddress,
        requestId: actor.requestId,
      },
      tx,
    );
    return {
      publicKey: pair.publicKeyBase64,
      fingerprint: pair.fingerprint,
      envLine: `OWNER_LINK_PUBLIC_KEY=${pair.publicKeyBase64}`,
    };
  });
}
