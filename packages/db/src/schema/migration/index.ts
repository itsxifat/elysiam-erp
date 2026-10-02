import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from '../columns.js';
import { journals } from '../ledger/index.js';
import { organizations } from '../org/index.js';

/**
 * Data migration: the record that a brand's opening position was imported (M14a; §7, §8).
 *
 * This schema owns the *record that an import happened* and nothing more. Opening stock
 * becomes `inventory.stock_movements`, balances become journal lines, buyers become
 * `sales.customers` — each written by the module that owns it, through its API
 * (invariant 12). What is kept here is what no other module has a column for: which file
 * was imported, by whom, what it contained once parsed, and whether the books have been
 * opened from it.
 *
 * Both tables are tenant tables: `org_id NOT NULL`, RLS ENABLE and FORCE, composite
 * foreign keys (D-047). Neither grants DELETE, and a trigger allows only the changes
 * named below.
 */
export const migrationSchema = pgSchema('migration');

/**
 * The one opening of a brand's books (D-213: a business starts keeping its books once).
 *
 * Unique per org, so a second posting cannot create a second row even if it got past
 * the ledger's own idempotency key. The sign-off is set once, by an accountant, and only
 * when the reconciliation agrees; the trigger refuses any other change.
 */
export const migrationOpenings = migrationSchema.table(
  'openings',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** The evening before go-live, as a Dhaka calendar date (invariant 8). */
    asOf: date('as_of', { mode: 'string' }).notNull(),
    journalId: uuid('journal_id').notNull(),
    postedBy: text('posted_by').notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    signedOffBy: text('signed_off_by'),
    signedOffAt: timestamp('signed_off_at', { withTimezone: true, mode: 'date' }),
    signOffNote: text('sign_off_note'),
    ...timestamps,
  },
  (table) => [
    unique('migration_openings_org_id_id_key').on(table.orgId, table.id),
    uniqueIndex('migration_openings_org_idx').on(table.orgId),
    foreignKey({
      name: 'migration_openings_org_id_journal_id_fk',
      columns: [table.orgId, table.journalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    check(
      'migration_openings_sign_off_whole',
      sql`(${table.signedOffBy} is null) = (${table.signedOffAt} is null)`,
    ),
    check(
      'migration_openings_note_length',
      sql`${table.signOffNote} is null or length(${table.signOffNote}) <= 500`,
    ),
  ],
);

/**
 * One imported file (D-215).
 *
 * `applied` kinds (SKUs, customers) took effect on commit; `rows` is null for them,
 * because the catalog and the buyer list are the record. `staged` kinds (opening stock,
 * supplier, wallet and courier balances) keep their parsed, resolved rows here until the
 * opening is posted from them — `posted`, with `opening_id` — or the accountant discards
 * the file. Purchase cost is among those rows (invariant 5), and no route returns them
 * row by row.
 *
 * `(org_id, kind, content_sha256)` is unique among batches that are not discarded, which
 * is what makes re-running the same file a no-op (check 3): the commit inserts this row
 * first, in the same transaction as everything it writes.
 */
export const migrationBatches = migrationSchema.table(
  'batches',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    /** SHA-256 of the file's text as received, lower-case hex. */
    contentSha256: text('content_sha256').notNull(),
    fileName: text('file_name').notNull(),
    rowCount: integer('row_count').notNull(),
    rows: jsonb('rows'),
    /** Counts and totals, never a row's contents. */
    summary: jsonb('summary').notNull(),
    status: text('status').notNull(),
    openingId: uuid('opening_id'),
    createdBy: text('created_by').notNull(),
    /** Who discarded or posted it, and when. */
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    unique('migration_batches_org_id_id_key').on(table.orgId, table.id),
    index('migration_batches_org_idx').on(table.orgId),
    index('migration_batches_org_kind_status_idx').on(table.orgId, table.kind, table.status),
    uniqueIndex('migration_batches_org_kind_hash_idx')
      .on(table.orgId, table.kind, table.contentSha256)
      .where(sql`status <> 'discarded'`),
    foreignKey({
      name: 'migration_batches_org_id_opening_id_fk',
      columns: [table.orgId, table.openingId],
      foreignColumns: [migrationOpenings.orgId, migrationOpenings.id],
    }).onDelete('restrict'),
    check(
      'migration_batches_kind',
      sql`${table.kind} in ('skus', 'opening_stock', 'supplier_balances', 'wallet_balances', 'courier_cod', 'customers')`,
    ),
    check(
      'migration_batches_status',
      sql`${table.status} in ('applied', 'staged', 'discarded', 'posted')`,
    ),
    check('migration_batches_hash_shape', sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`),
    check('migration_batches_file_name_length', sql`length(${table.fileName}) between 1 and 200`),
    check('migration_batches_row_count', sql`${table.rowCount} >= 0`),
    check(
      'migration_batches_posted_has_opening',
      sql`(${table.status} = 'posted') = (${table.openingId} is not null)`,
    ),
    check(
      'migration_batches_applied_has_no_rows',
      sql`(${table.status} = 'applied') = (${table.rows} is null)`,
    ),
    check(
      'migration_batches_decided_whole',
      sql`(${table.decidedBy} is null) = (${table.decidedAt} is null)
        and ((${table.status} in ('discarded', 'posted')) = (${table.decidedAt} is not null))`,
    ),
  ],
);
