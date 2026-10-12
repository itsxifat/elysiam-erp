import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * The inbox's saved replies (M44a, D-763): their SQL, named by `org_id` beside RLS.
 */

export interface SavedReplyRow extends Record<string, unknown> {
  readonly id: string;
  readonly title: string;
  readonly shortcut: string;
  readonly body: string;
  readonly category: string | null;
  readonly usage_count: number;
  readonly last_used_at: string | Date | null;
  readonly created_by: string;
  readonly updated_by: string;
  readonly created_at: string | Date;
  readonly updated_at: string | Date;
}

const COLUMNS = sql`id, title, shortcut, body, category, usage_count, last_used_at, created_by,
  updated_by, created_at, updated_at`;

/** Every saved reply of the brand, the most used first (the picker's own order). */
export async function listSavedReplies(tx: Tx, orgId: string): Promise<SavedReplyRow[]> {
  const rows = await tx.execute<SavedReplyRow>(sql`
    select ${COLUMNS} from inbox.saved_replies
    where org_id = ${orgId}
    order by usage_count desc, shortcut
    limit 500
  `);
  return [...rows];
}

export async function savedReplyById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<SavedReplyRow | undefined> {
  const rows = await tx.execute<SavedReplyRow>(sql`
    select ${COLUMNS} from inbox.saved_replies where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

export interface SavedReplyValues {
  readonly title: string;
  readonly shortcut: string;
  readonly body: string;
  readonly category: string | null;
}

/** A new saved reply, or undefined when the shortcut is taken. */
export async function insertSavedReply(
  tx: Tx,
  orgId: string,
  values: SavedReplyValues,
  userId: string,
): Promise<SavedReplyRow | undefined> {
  const rows = await tx.execute<SavedReplyRow>(sql`
    insert into inbox.saved_replies (org_id, title, shortcut, body, category, created_by, updated_by)
    values (${orgId}, ${values.title}, ${values.shortcut}, ${values.body}, ${values.category},
            ${userId}, ${userId})
    on conflict (org_id, shortcut) do nothing
    returning ${COLUMNS}
  `);
  return rows[0];
}

/** Change one; undefined when it is gone. A taken shortcut raises the unique violation. */
export async function updateSavedReply(
  tx: Tx,
  orgId: string,
  id: string,
  values: SavedReplyValues,
  userId: string,
): Promise<SavedReplyRow | undefined> {
  const rows = await tx.execute<SavedReplyRow>(sql`
    update inbox.saved_replies set
      title = ${values.title}, shortcut = ${values.shortcut}, body = ${values.body},
      category = ${values.category}, updated_by = ${userId}, updated_at = now()
    where org_id = ${orgId} and id = ${id}
    returning ${COLUMNS}
  `);
  return rows[0];
}

/** Whether another saved reply of the brand has this shortcut. */
export async function shortcutTaken(
  tx: Tx,
  orgId: string,
  shortcut: string,
  exceptId: string | null,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from inbox.saved_replies
    where org_id = ${orgId} and shortcut = ${shortcut}
      ${exceptId === null ? sql`` : sql`and id <> ${exceptId}`}
  `);
  return rows.length > 0;
}

export async function deleteSavedReply(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<SavedReplyRow | undefined> {
  const rows = await tx.execute<SavedReplyRow>(sql`
    delete from inbox.saved_replies where org_id = ${orgId} and id = ${id}
    returning ${COLUMNS}
  `);
  return rows[0];
}

/** One more use; the new count, or undefined when it is gone. */
export async function bumpSavedReply(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<number | undefined> {
  const rows = await tx.execute<{ usage_count: number }>(sql`
    update inbox.saved_replies set usage_count = usage_count + 1, last_used_at = now()
    where org_id = ${orgId} and id = ${id}
    returning usage_count
  `);
  return rows[0]?.usage_count;
}
