import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * The migration module's own tables, and the brand's stock locations (M14a).
 *
 * `migration.batches` and `migration.openings` are this module's; `org.locations` is §5's
 * global footprint, which every module resolves against. Everything else an import writes
 * — products, buyers, stock movements, the opening journal — goes through the owning
 * module's `*.api.ts` (invariant 12), so nothing here names another module's schema.
 */

export interface BatchRow extends Record<string, unknown> {
  readonly id: string;
  readonly kind: string;
  readonly content_sha256: string;
  readonly file_name: string;
  readonly row_count: number;
  readonly rows: unknown;
  readonly summary: Record<string, unknown>;
  readonly status: 'applied' | 'staged' | 'discarded' | 'posted';
  readonly opening_id: string | null;
  readonly created_by: string;
  readonly created_at: string;
}

const BATCH_COLUMNS = sql`id, kind, content_sha256, file_name, row_count, rows, summary,
  status, opening_id, created_by, created_at::text as created_at`;

/**
 * Record an imported file, unless the same file is already recorded.
 *
 * `on conflict … do nothing` against the partial unique index, so a second commit of the
 * same file — even a concurrent one, which waits for the first to commit — inserts
 * nothing and returns `undefined`, and the caller answers with the first batch (check 3).
 */
export async function insertBatch(
  tx: Tx,
  batch: {
    readonly orgId: string;
    readonly kind: string;
    readonly contentSha256: string;
    readonly fileName: string;
    readonly rowCount: number;
    readonly rows: unknown;
    readonly summary: Record<string, unknown>;
    readonly status: 'applied' | 'staged';
    readonly createdBy: string;
  },
): Promise<string | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into migration.batches
      (org_id, kind, content_sha256, file_name, row_count, rows, summary, status, created_by)
    values (${batch.orgId}, ${batch.kind}, ${batch.contentSha256}, ${batch.fileName},
            ${batch.rowCount},
            ${batch.rows === null ? null : JSON.stringify(batch.rows)}::jsonb,
            ${JSON.stringify(batch.summary)}::jsonb, ${batch.status}, ${batch.createdBy})
    on conflict (org_id, kind, content_sha256) where status <> 'discarded' do nothing
    returning id
  `);
  return rows[0]?.id;
}

/** The live (not discarded) batch of this kind with this content, if any. */
export async function batchByHash(
  tx: Tx,
  orgId: string,
  kind: string,
  contentSha256: string,
): Promise<BatchRow | undefined> {
  const rows = await tx.execute<BatchRow>(sql`
    select ${BATCH_COLUMNS} from migration.batches
    where org_id = ${orgId} and kind = ${kind} and content_sha256 = ${contentSha256}
      and status <> 'discarded'
  `);
  return rows[0];
}

export async function batchById(tx: Tx, orgId: string, id: string): Promise<BatchRow | undefined> {
  const rows = await tx.execute<BatchRow>(sql`
    select ${BATCH_COLUMNS} from migration.batches where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

/** Batches in a state, optionally of one kind, oldest first. */
export async function batchesWithStatus(
  tx: Tx,
  orgId: string,
  status: BatchRow['status'],
  kind?: string,
): Promise<BatchRow[]> {
  const rows = await tx.execute<BatchRow>(sql`
    select ${BATCH_COLUMNS} from migration.batches
    where org_id = ${orgId} and status = ${status}
      and ${kind === undefined ? sql`true` : sql`kind = ${kind}`}
    order by created_at, id
  `);
  return [...rows];
}

export async function listBatches(tx: Tx, orgId: string): Promise<BatchRow[]> {
  const rows = await tx.execute<BatchRow>(sql`
    select ${BATCH_COLUMNS} from migration.batches where org_id = ${orgId}
    order by created_at, id
  `);
  return [...rows];
}

/** A staged batch, discarded. False when it was not staged (the trigger is the backstop). */
export async function discardBatch(
  tx: Tx,
  orgId: string,
  id: string,
  by: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update migration.batches
    set status = 'discarded', decided_by = ${by}, decided_at = now(), updated_at = now()
    where org_id = ${orgId} and id = ${id} and status = 'staged'
    returning id
  `);
  return rows.length === 1;
}

/**
 * These staged batches, posted into this opening. Returns how many.
 *
 * By id, never "every staged batch": the posting wrote the rows it read, and a batch
 * staged after that read must not be marked as posted without its rows ever reaching
 * stock or the ledger.
 */
export async function markPosted(
  tx: Tx,
  orgId: string,
  batchIds: readonly string[],
  openingId: string,
  by: string,
): Promise<number> {
  if (batchIds.length === 0) return 0;
  const rows = await tx.execute<{ id: string }>(sql`
    update migration.batches
    set status = 'posted', opening_id = ${openingId}, decided_by = ${by}, decided_at = now(),
        updated_at = now()
    where org_id = ${orgId} and status = 'staged'
      and id = any (${sql.param([...batchIds])}::uuid[])
    returning id
  `);
  return rows.length;
}

/**
 * One migration step at a time per brand.
 *
 * A commit, a discard, the posting and the sign-off each take this transaction-scoped
 * lock first, so a balance file cannot be staged while the books are being opened from
 * the files staged before it, and two files cannot both pass their review against a
 * staged set that neither can see the other in.
 */
export async function lockOrg(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`migration:${orgId}`}, 0))`);
}

export interface OpeningRow extends Record<string, unknown> {
  readonly id: string;
  readonly as_of: string;
  readonly journal_id: string;
  readonly posted_by: string;
  readonly posted_at: string;
  readonly signed_off_by: string | null;
  readonly signed_off_at: string | null;
  readonly sign_off_note: string | null;
}

export async function openingOf(tx: Tx, orgId: string): Promise<OpeningRow | undefined> {
  const rows = await tx.execute<OpeningRow>(sql`
    select id, to_char(as_of, 'YYYY-MM-DD') as as_of, journal_id, posted_by,
           posted_at::text as posted_at, signed_off_by, signed_off_at::text as signed_off_at,
           sign_off_note
    from migration.openings where org_id = ${orgId}
  `);
  return rows[0];
}

export async function insertOpening(
  tx: Tx,
  opening: {
    readonly id: string;
    readonly orgId: string;
    readonly asOf: string;
    readonly journalId: string;
    readonly postedBy: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into migration.openings (id, org_id, as_of, journal_id, posted_by)
    values (${opening.id}, ${opening.orgId}, ${opening.asOf}::date, ${opening.journalId},
            ${opening.postedBy})
  `);
}

/** The sign-off, once. False when the opening was already signed off. */
export async function signOff(
  tx: Tx,
  orgId: string,
  by: string,
  note: string | null,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update migration.openings
    set signed_off_by = ${by}, signed_off_at = now(), sign_off_note = ${note}, updated_at = now()
    where org_id = ${orgId} and signed_off_at is null
    returning id
  `);
  return rows.length === 1;
}

/** Active stock locations by code (§5's global `org` schema). */
export async function locationsByCodes(
  tx: Tx,
  orgId: string,
  codes: readonly string[],
): Promise<{ id: string; code: string }[]> {
  if (codes.length === 0) return [];
  const rows = await tx.execute<{ id: string; code: string }>(sql`
    select id, code from org.locations
    where org_id = ${orgId} and is_active and kind <> 'in_transit'
      and code = any (${sql.param([...new Set(codes)])}::text[])
  `);
  return [...rows];
}
