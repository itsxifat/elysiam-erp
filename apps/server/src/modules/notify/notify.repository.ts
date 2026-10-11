import { sql } from 'drizzle-orm';
import type { Tx } from '@elysium/db';

/**
 * Every query the notify module runs (architecture §10; M16).
 *
 * Raw SQL, parameterized, filtering on `org_id` though RLS already does. Phones arrive
 * here national (`01XXXXXXXXX`), which is what the tables' CHECKs accept and what a
 * person reads; the service normalises them before they reach this file.
 *
 * `notify.messages` is append-only in every column but the send outcome — the trigger in
 * 0079 refuses anything else — so nothing below updates a message's body, recipient or
 * template after it was written.
 */

export interface TemplateRow extends Record<string, unknown> {
  readonly id: string;
  readonly key: string;
  readonly channel: string;
  readonly category: string;
  readonly body_bn: string;
  readonly body_en: string;
  readonly is_active: boolean;
  readonly updated_at: Date;
}

const TEMPLATE_COLUMNS = sql`id, key, channel, category, body_bn, body_en, is_active, updated_at`;

export async function templateByKey(
  tx: Tx,
  orgId: string,
  key: string,
  channel: string,
): Promise<TemplateRow | undefined> {
  const rows = await tx.execute<TemplateRow>(sql`
    select ${TEMPLATE_COLUMNS} from notify.templates
    where org_id = ${orgId} and key = ${key} and channel = ${channel}
  `);
  return rows[0];
}

export async function listTemplates(tx: Tx, orgId: string): Promise<TemplateRow[]> {
  const rows = await tx.execute<TemplateRow>(sql`
    select ${TEMPLATE_COLUMNS} from notify.templates
    where org_id = ${orgId} order by key
  `);
  return [...rows];
}

/**
 * Create a template, or replace its wording and category.
 *
 * Keyed by `(org, key, channel)`, the unique index, so saving `order.confirmed` twice
 * edits one row. A message already sent keeps the body it was rendered with — the
 * delivery log stores the rendered text, never a reference to the template.
 */
export async function upsertTemplate(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly key: string;
    readonly channel: string;
    readonly category: string;
    /** The English body (D-750); also written to the retired `body_bn` until it is dropped. */
    readonly bodyEn: string;
    readonly isActive: boolean;
    readonly updatedBy: string;
  },
): Promise<TemplateRow> {
  const rows = await tx.execute<TemplateRow>(sql`
    insert into notify.templates (org_id, key, channel, category, body_bn, body_en, is_active, updated_by)
    values (${input.orgId}, ${input.key}, ${input.channel}, ${input.category},
            ${input.bodyEn}, ${input.bodyEn}, ${input.isActive}, ${input.updatedBy})
    on conflict (org_id, key, channel) do update
      set category = excluded.category, body_bn = excluded.body_bn,
          body_en = excluded.body_en, is_active = excluded.is_active,
          updated_by = excluded.updated_by, updated_at = now()
    returning ${TEMPLATE_COLUMNS}
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('an upserted template returned no row');
  return row;
}

/**
 * Whether the org is the training org (M14a, D-223), whose buyers carry demo numbers in a
 * real mobile range. Read from §5's global `org` schema.
 */
export async function isTrainingOrg(tx: Tx, orgId: string): Promise<boolean> {
  const rows = await tx.execute<{ is_training: boolean }>(sql`
    select is_training from org.organizations where id = ${orgId}
  `);
  return rows[0]?.is_training === true;
}

export async function isOptedOut(
  tx: Tx,
  orgId: string,
  phone: string,
  channel: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from notify.opt_outs
    where org_id = ${orgId} and phone = ${phone} and channel = ${channel}
  `);
  return rows.length > 0;
}

/** Every number that opted out of a channel, national form. */
export async function optedOutPhones(tx: Tx, orgId: string, channel: string): Promise<string[]> {
  const rows = await tx.execute<{ phone: string }>(sql`
    select phone from notify.opt_outs where org_id = ${orgId} and channel = ${channel}
  `);
  return rows.map((row) => row.phone);
}

export interface OptOutRow extends Record<string, unknown> {
  readonly id: string;
  readonly phone: string;
  readonly channel: string;
  readonly reason: string | null;
  readonly created_at: Date;
}

export async function listOptOuts(tx: Tx, orgId: string, limit: number): Promise<OptOutRow[]> {
  const rows = await tx.execute<OptOutRow>(sql`
    select id, phone, channel, reason, created_at from notify.opt_outs
    where org_id = ${orgId} order by created_at desc limit ${limit}
  `);
  return [...rows];
}

/**
 * Idempotent: opting out twice is one opt-out. Returns the row's id either way — the
 * audit row is keyed on it, never on the number (invariant 10).
 */
export async function addOptOut(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly phone: string;
    readonly channel: string;
    readonly reason: string | null;
    readonly createdBy: string;
  },
): Promise<{ readonly id: string; readonly created: boolean }> {
  const inserted = await tx.execute<{ id: string }>(sql`
    insert into notify.opt_outs (org_id, phone, channel, reason, created_by)
    values (${input.orgId}, ${input.phone}, ${input.channel}, ${input.reason}, ${input.createdBy})
    on conflict (org_id, phone, channel) do nothing
    returning id
  `);
  const fresh = inserted[0]?.id;
  if (fresh !== undefined) return { id: fresh, created: true };
  const existing = await tx.execute<{ id: string }>(sql`
    select id from notify.opt_outs
    where org_id = ${input.orgId} and phone = ${input.phone} and channel = ${input.channel}
  `);
  const id = existing[0]?.id;
  if (id === undefined) throw new Error('an opt-out conflicted and then could not be found');
  return { id, created: false };
}

export async function removeOptOut(
  tx: Tx,
  orgId: string,
  phone: string,
  channel: string,
): Promise<string | null> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from notify.opt_outs
    where org_id = ${orgId} and phone = ${phone} and channel = ${channel}
    returning id
  `);
  return rows[0]?.id ?? null;
}

/**
 * A queued or failed message that will now never be sent: its number opted out after it
 * was queued. Final, like `sent` (0079's trigger).
 */
export async function suppressMessage(tx: Tx, orgId: string, id: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update notify.messages set state = 'suppressed', updated_at = now()
    where org_id = ${orgId} and id = ${id} and state in ('queued', 'failed')
    returning id
  `);
  return rows.length > 0;
}

export interface MessageRow extends Record<string, unknown> {
  readonly id: string;
  readonly template_key: string;
  readonly channel: string;
  readonly category: string;
  readonly phone: string;
  readonly locale: string;
  readonly body: string;
  readonly state: string;
  readonly send_after: Date;
  readonly attempts: number;
  readonly provider: string | null;
  readonly provider_message_id: string | null;
  readonly error: string | null;
  readonly sent_at: Date | null;
  readonly ref_type: string | null;
  readonly ref_id: string | null;
  readonly created_at: Date;
}

const MESSAGE_COLUMNS = sql`
  id, template_key, channel, category, phone, locale, body, state, send_after, attempts,
  provider, provider_message_id, error, sent_at, ref_type, ref_id, created_at
`;

export async function insertMessage(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly templateKey: string;
    readonly channel: string;
    readonly category: string;
    readonly phone: string;
    readonly locale: string;
    readonly body: string;
    readonly state: 'queued' | 'suppressed';
    readonly sendAfter: Date;
    readonly refType: string | null;
    readonly refId: string | null;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into notify.messages (
      org_id, template_key, channel, category, phone, locale, body, state, send_after,
      ref_type, ref_id)
    values (${input.orgId}, ${input.templateKey}, ${input.channel}, ${input.category},
            ${input.phone}, ${input.locale}, ${input.body}, ${input.state},
            ${input.sendAfter.toISOString()}, ${input.refType}, ${input.refId})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('an inserted message returned no id');
  return id;
}

export async function messageById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<MessageRow | undefined> {
  const rows = await tx.execute<MessageRow>(sql`
    select ${MESSAGE_COLUMNS} from notify.messages where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

/**
 * Record what the gateway said. Conditional on the message still being sendable, so two
 * workers that both picked up a job — a redelivery after a crash — cannot both mark it
 * sent, and the trigger's "sent is final" never has to be the thing that refuses.
 */
export async function recordOutcome(
  tx: Tx,
  orgId: string,
  id: string,
  outcome:
    | {
        readonly state: 'sent';
        readonly provider: string;
        readonly providerMessageId: string | null;
      }
    | { readonly state: 'failed'; readonly provider: string; readonly error: string },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(
    outcome.state === 'sent'
      ? sql`
          update notify.messages
          set state = 'sent', sent_at = now(), attempts = attempts + 1,
              provider = ${outcome.provider}, provider_message_id = ${outcome.providerMessageId},
              error = null, updated_at = now()
          where org_id = ${orgId} and id = ${id} and state in ('queued', 'failed')
          returning id
        `
      : sql`
          update notify.messages
          set state = 'failed', attempts = attempts + 1,
              provider = ${outcome.provider}, error = ${outcome.error}, updated_at = now()
          where org_id = ${orgId} and id = ${id} and state in ('queued', 'failed')
          returning id
        `,
  );
  return rows.length > 0;
}

/** Push a queued message to a later send time: the job woke inside quiet hours. */
export async function deferMessage(
  tx: Tx,
  orgId: string,
  id: string,
  sendAfter: Date,
): Promise<void> {
  await tx.execute(sql`
    update notify.messages set send_after = ${sendAfter.toISOString()}, updated_at = now()
    where org_id = ${orgId} and id = ${id} and state = 'queued'
  `);
}

export async function listMessages(
  tx: Tx,
  orgId: string,
  filters: { readonly state?: string | undefined; readonly limit: number },
): Promise<MessageRow[]> {
  const rows = await tx.execute<MessageRow>(sql`
    select ${MESSAGE_COLUMNS} from notify.messages
    where org_id = ${orgId}
      and ${filters.state === undefined ? sql`true` : sql`state = ${filters.state}`}
    order by created_at desc
    limit ${filters.limit}
  `);
  return [...rows];
}
