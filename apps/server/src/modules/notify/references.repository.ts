import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/** What notify holds about one of its templates, for a delete (M39a, D-632). */

export interface TemplateImage extends Record<string, unknown> {
  readonly id: string;
  readonly key: string;
  readonly channel: string;
  readonly category: string;
  readonly is_active: boolean;
}

export async function lockTemplate(
  tx: Tx,
  orgId: string,
  id: string,
  lock = true,
): Promise<TemplateImage | undefined> {
  const rows = await tx.execute<TemplateImage>(sql`
    select t.* from notify.templates t where t.org_id = ${orgId} and t.id = ${id}
    ${lock ? sql`for update` : sql``}
  `);
  return rows[0];
}

/** Messages ever queued under the template's key (sent, skipped or failed). */
export async function messagesWithKey(tx: Tx, orgId: string, key: string): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from notify.messages where org_id = ${orgId} and template_key = ${key}
  `);
  return rows[0]?.n ?? 0;
}

export async function deleteTemplate(tx: Tx, orgId: string, id: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from notify.templates where org_id = ${orgId} and id = ${id} returning id
  `);
  return rows.length === 1;
}
