import { withOrg, type Tx } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';

import type { FilePurpose } from './files.policy.js';

/**
 * Every read and write of `files.objects` (architecture §5, §22).
 *
 * Raw SQL, parameterized, and only here: `.claude/rules` puts raw SQL in
 * repositories for the reason this file demonstrates — the `where` fragments
 * are composed from a caller-supplied scope filter, and a single place that
 * does the composing is a single place to check that nothing is interpolated.
 *
 * Every function runs inside `withOrg()`, so row-level security is what bounds
 * the result set rather than a remembered `where org_id =`. The org_id in the
 * INSERT is still explicit: the policy's WITH CHECK needs a value to compare.
 */

export interface FileRow {
  readonly id: string;
  readonly orgId: string;
  readonly storageKey: string;
  readonly driver: 'local' | 'r2';
  readonly visibility: 'private' | 'public';
  readonly status: 'pending' | 'stored';
  readonly purpose: string;
  readonly ownerUserId: string | null;
  readonly mime: string;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  readonly originalName: string | null;
  readonly variants: Record<string, unknown>;
  readonly processedAt: Date | null;
  readonly createdAt: Date;
}

interface RawFileRow {
  // An index signature because `tx.execute<T>` requires one: postgres.js
  // returns rows as plain objects and the type parameter has to admit that.
  [column: string]: unknown;
  id: string;
  org_id: string;
  storage_key: string;
  driver: string;
  visibility: string;
  status: string;
  purpose: string;
  owner_user_id: string | null;
  mime: string;
  /**
   * `bigint` comes back as a string from the postgres driver, because that is
   * the only lossless representation it has. Converted once, here, rather than
   * left to every caller — a `Number(row.size_bytes)` scattered around is how
   * one of them eventually becomes a string concatenation.
   */
  size_bytes: string | null;
  sha256: string | null;
  original_name: string | null;
  variants: Record<string, unknown> | null;
  processed_at: Date | null;
  created_at: Date;
}

const COLUMNS = sql`
  id, org_id, storage_key, driver, visibility::text as visibility, status::text as status,
  purpose, owner_user_id, mime, size_bytes, sha256, original_name, variants,
  processed_at, created_at
`;

function hydrate(row: RawFileRow): FileRow {
  return {
    id: row.id,
    orgId: row.org_id,
    storageKey: row.storage_key,
    driver: row.driver as 'local' | 'r2',
    visibility: row.visibility as 'private' | 'public',
    status: row.status as 'pending' | 'stored',
    purpose: row.purpose,
    ownerUserId: row.owner_user_id,
    mime: row.mime,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    sha256: row.sha256,
    originalName: row.original_name,
    variants: row.variants ?? {},
    processedAt: row.processed_at,
    createdAt: row.created_at,
  };
}

export interface OrgUser {
  readonly orgId: string;
  readonly userId: string;
}

export interface InsertPendingFile {
  readonly id: string;
  readonly storageKey: string;
  readonly driver: 'local' | 'r2';
  readonly visibility: 'private' | 'public';
  readonly purpose: FilePurpose;
  readonly ownerUserId: string | null;
  readonly mime: string;
  readonly originalName: string | null;
}

/**
 * Reserve the row before the bytes exist.
 *
 * The id has to be allocated first because the storage key is derived from it —
 * see the `file_objects_key_matches_id` constraint — so "create the row when
 * the upload finishes" is not available. The row is `pending` until the server
 * has seen the bytes, and nothing downloads a pending row, so an abandoned
 * upload is inert rather than a hole.
 */
export async function insertPending(context: OrgUser, file: InsertPendingFile): Promise<void> {
  await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
    await tx.execute(sql`
      insert into files.objects
        (id, org_id, storage_key, driver, visibility, status, purpose, owner_user_id, mime, original_name)
      values (
        ${file.id}::uuid,
        ${context.orgId}::uuid,
        ${file.storageKey},
        ${file.driver},
        ${file.visibility}::files.file_visibility,
        'pending'::files.file_status,
        ${file.purpose},
        ${file.ownerUserId},
        ${file.mime},
        ${file.originalName}
      )
    `);
  });
}

/**
 * A file's status by its storage key, for the local driver's public bytes `PUT`, which
 * knows only the key. Inside the org the key names (`<visibility>/<orgId>/…`).
 */
/**
 * Run `work` holding the row a storage key belongs to, with its status (D-417).
 *
 * The local driver's bytes PUT writes under this lock, and the finalize examines and marks
 * the file stored under the same one, so a PUT cannot land between the finalize's size check
 * and its read, nor after it: it waits, then sees `stored` and is refused.
 */
export async function underKeyLock<T>(
  orgId: string,
  storageKey: string,
  work: (status: 'pending' | 'stored' | null) => Promise<T>,
): Promise<T> {
  return withOrg({ orgId }, async (tx) => {
    const rows = await tx.execute<{ status: string }>(sql`
      select status::text as status from files.objects
      where storage_key = ${storageKey}
      for update
    `);
    return work(statusOf(rows[0]?.status));
  });
}

/** `underKeyLock`, by the file's id, for the finalize; `work` marks it stored through `tx`. */
export async function underFileLock<T>(
  context: OrgUser,
  id: string,
  work: (status: 'pending' | 'stored' | null, tx: Tx) => Promise<T>,
): Promise<T> {
  return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
    const rows = await tx.execute<{ status: string }>(sql`
      select status::text as status from files.objects where id = ${id}::uuid for update
    `);
    return work(statusOf(rows[0]?.status), tx);
  });
}

function statusOf(status: string | undefined): 'pending' | 'stored' | null {
  return status === 'pending' || status === 'stored' ? status : null;
}

/**
 * One file, or null.
 *
 * `scope` is the caller's row filter, rendered by `scopeWhere` — a reseller
 * sees only rows they own. Passed in rather than computed here so the
 * ScopeInterceptor's "did the handler apply it" check stays honest: a
 * repository that decided its own scope could not be caught forgetting.
 */
export async function findById(context: OrgUser, id: string, scope: SQL): Promise<FileRow | null> {
  const rows = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) =>
    tx.execute<RawFileRow>(sql`
      select ${COLUMNS} from files.objects where id = ${id}::uuid and ${scope}
    `),
  );
  const row = rows[0];
  return row === undefined ? null : hydrate(row);
}

export interface FinalizeInput {
  readonly id: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly mime: string;
}

/**
 * Record that the bytes arrived and what they turned out to be.
 *
 * Guarded by `status = 'pending'` in the WHERE rather than by reading first and
 * writing after: two finalize calls for the same upload race otherwise, and the
 * loser would overwrite a `stored` row's hash with its own. The conditional
 * UPDATE makes the second one a no-op, which the caller sees as `false`.
 *
 * The `mime` is the *sniffed* type, not the declared one. Recording what the
 * client claimed would make the download endpoint's `Content-Type` a value an
 * uploader controls, and `text/html` served from our own origin is stored XSS.
 */
export async function markStored(context: OrgUser, input: FinalizeInput): Promise<boolean> {
  return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) =>
    markStoredIn(tx, input),
  );
}

/** `markStored` inside a transaction that already holds the row (`underFileLock`). */
export async function markStoredIn(tx: Tx, input: FinalizeInput): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
      update files.objects
      set status = 'stored'::files.file_status,
          size_bytes = ${String(input.sizeBytes)}::bigint,
          sha256 = ${input.sha256},
          mime = ${input.mime},
          updated_at = now()
      where id = ${input.id}::uuid and status = 'pending'::files.file_status
      returning id
    `);
  return rows.length === 1;
}

/** Record the image job's output. Idempotent: running it twice is harmless. */
export async function recordVariants(
  context: OrgUser,
  id: string,
  variants: Record<string, unknown>,
): Promise<void> {
  await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
    await tx.execute(sql`
      update files.objects
      set variants = ${JSON.stringify(variants)}::jsonb,
          processed_at = now(),
          updated_at = now()
      where id = ${id}::uuid
    `);
  });
}

/**
 * Create a row for something the server produced, already stored.
 *
 * A rendered invoice never passes through `pending`: the bytes exist before the
 * row does, so the two states would be a lie about the order things happened
 * in. Takes an open transaction, so the row and whatever caused it commit
 * together — a PDF recorded for a journal that rolled back is an orphan nobody
 * will ever explain.
 */
export async function insertStored(
  tx: Tx,
  orgId: string,
  file: InsertPendingFile & { readonly sizeBytes: number; readonly sha256: string },
): Promise<void> {
  await tx.execute(sql`
    insert into files.objects
      (id, org_id, storage_key, driver, visibility, status, purpose, owner_user_id,
       mime, original_name, size_bytes, sha256)
    values (
      ${file.id}::uuid,
      ${orgId}::uuid,
      ${file.storageKey},
      ${file.driver},
      ${file.visibility}::files.file_visibility,
      'stored'::files.file_status,
      ${file.purpose},
      ${file.ownerUserId},
      ${file.mime},
      ${file.originalName},
      ${String(file.sizeBytes)}::bigint,
      ${file.sha256}
    )
  `);
}
