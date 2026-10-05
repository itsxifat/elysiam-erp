import { sql } from 'drizzle-orm';
import type { Tx } from '@elysium/db';

/**
 * The email channel's queries (M34, D-529): the brand's server settings and the outbox.
 *
 * The recipient is stored because it is the address; it never reaches a log unmasked
 * (invariant 10). The body is sealed and cleared once the email is sent or has failed for
 * good, so the log keeps what was sent to whom and nothing a reader could reuse.
 */

export interface EmailSettingsRow extends Record<string, unknown> {
  readonly org_id: string;
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly username: string;
  readonly password_sealed: Buffer | null;
  readonly key_id: string | null;
  readonly fingerprint: string | null;
  readonly from_name: string;
  readonly from_email: string;
  readonly updated_by: string;
  readonly updated_at: Date | string;
}

export async function emailSettings(tx: Tx, orgId: string): Promise<EmailSettingsRow | undefined> {
  const rows = await tx.execute<EmailSettingsRow>(sql`
    select org_id, enabled, host, port, secure, username, password_sealed, key_id, fingerprint,
           from_name, from_email, updated_by, updated_at
    from notify.email_settings where org_id = ${orgId}
  `);
  const row = rows[0];
  if (row === undefined) return undefined;
  const sealed = row.password_sealed as unknown;
  return {
    ...row,
    password_sealed:
      sealed === null || sealed === undefined ? null : Buffer.from(sealed as Uint8Array),
  };
}

export async function upsertEmailSettings(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly enabled: boolean;
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly username: string;
    /** Undefined keeps the stored password; a value replaces it. */
    readonly password?: {
      readonly sealed: Buffer;
      readonly keyId: string;
      readonly fingerprint: string;
    };
    readonly fromName: string;
    readonly fromEmail: string;
    readonly updatedBy: string;
  },
): Promise<void> {
  const password = input.password;
  await tx.execute(sql`
    insert into notify.email_settings
      (org_id, enabled, host, port, secure, username, password_sealed, key_id, fingerprint,
       from_name, from_email, updated_by)
    values (${input.orgId}, ${input.enabled}, ${input.host}, ${input.port}, ${input.secure},
            ${input.username}, ${password?.sealed ?? null}, ${password?.keyId ?? null},
            ${password?.fingerprint ?? null}, ${input.fromName}, ${input.fromEmail},
            ${input.updatedBy})
    on conflict (org_id) do update set
      enabled = excluded.enabled, host = excluded.host, port = excluded.port,
      secure = excluded.secure, username = excluded.username,
      password_sealed = ${password === undefined ? sql`notify.email_settings.password_sealed` : sql`excluded.password_sealed`},
      key_id = ${password === undefined ? sql`notify.email_settings.key_id` : sql`excluded.key_id`},
      fingerprint = ${password === undefined ? sql`notify.email_settings.fingerprint` : sql`excluded.fingerprint`},
      from_name = excluded.from_name, from_email = excluded.from_email,
      updated_by = excluded.updated_by, updated_at = now()
  `);
}

export interface EmailRow extends Record<string, unknown> {
  readonly id: string;
  readonly template_key: string;
  readonly locale: string;
  readonly to_email: string;
  readonly subject: string;
  readonly body_sealed: Buffer | null;
  readonly state: string;
  readonly attempts: number;
  readonly provider_message_id: string | null;
  readonly error: string | null;
  readonly sent_at: Date | string | null;
  readonly ref_type: string | null;
  readonly ref_id: string | null;
  readonly created_at: Date | string;
}

const EMAIL_COLUMNS = sql`id, template_key, locale, to_email, subject, body_sealed, state, attempts,
  provider_message_id, error, sent_at, ref_type, ref_id, created_at`;

function withBuffer(row: EmailRow): EmailRow {
  const sealed = row.body_sealed as unknown;
  return {
    ...row,
    body_sealed: sealed === null || sealed === undefined ? null : Buffer.from(sealed as Uint8Array),
  };
}

/**
 * Write one email. With a `dedupeKey`, a second email for the same key is not written and the
 * first one's id comes back with `created: false`.
 */
export async function insertEmail(
  tx: Tx,
  input: {
    readonly id: string;
    readonly orgId: string;
    readonly templateKey: string;
    readonly locale: string;
    readonly toEmail: string;
    readonly subject: string;
    readonly bodySealed: Buffer | null;
    readonly state: 'queued' | 'skipped';
    readonly error: string | null;
    readonly refType: string | null;
    readonly refId: string | null;
    readonly dedupeKey: string | null;
  },
): Promise<{ readonly id: string; readonly created: boolean }> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into notify.emails
      (id, org_id, template_key, locale, to_email, subject, body_sealed, state, error, ref_type,
       ref_id, dedupe_key)
    values (${input.id}, ${input.orgId}, ${input.templateKey}, ${input.locale}, ${input.toEmail},
            ${input.subject}, ${input.bodySealed}, ${input.state}, ${input.error},
            ${input.refType}, ${input.refId}::uuid, ${input.dedupeKey})
    on conflict (org_id, dedupe_key) where dedupe_key is not null do nothing
    returning id
  `);
  const created = rows[0]?.id;
  if (created !== undefined) return { id: created, created: true };
  const existing = await tx.execute<{ id: string }>(sql`
    select id from notify.emails where org_id = ${input.orgId} and dedupe_key = ${input.dedupeKey}
  `);
  const id = existing[0]?.id;
  if (id === undefined) throw new Error('an email collided on its dedupe key and was not found');
  return { id, created: false };
}

export async function emailById(tx: Tx, orgId: string, id: string): Promise<EmailRow | undefined> {
  const rows = await tx.execute<EmailRow>(sql`
    select ${EMAIL_COLUMNS} from notify.emails where org_id = ${orgId} and id = ${id}
  `);
  const row = rows[0];
  return row === undefined ? undefined : withBuffer(row);
}

/** The outcome of one attempt; a final one clears the body. */
export async function recordEmailOutcome(
  tx: Tx,
  orgId: string,
  id: string,
  outcome:
    | { readonly state: 'sent'; readonly providerMessageId: string | null }
    | { readonly state: 'failed'; readonly error: string }
    | { readonly state: 'retry'; readonly error: string },
): Promise<void> {
  if (outcome.state === 'sent') {
    await tx.execute(sql`
      update notify.emails set state = 'sent', sent_at = now(), attempts = attempts + 1,
        provider_message_id = ${outcome.providerMessageId}, body_sealed = null, error = null,
        updated_at = now()
      where org_id = ${orgId} and id = ${id} and state = 'queued'
    `);
    return;
  }
  if (outcome.state === 'failed') {
    await tx.execute(sql`
      update notify.emails set state = 'failed', attempts = attempts + 1,
        error = ${outcome.error}, body_sealed = null, updated_at = now()
      where org_id = ${orgId} and id = ${id} and state = 'queued'
    `);
    return;
  }
  await tx.execute(sql`
    update notify.emails set attempts = attempts + 1, error = ${outcome.error}, updated_at = now()
    where org_id = ${orgId} and id = ${id} and state = 'queued'
  `);
}

/** The latest emails, newest first, without bodies. */
export async function listEmails(tx: Tx, orgId: string, limit: number): Promise<EmailRow[]> {
  const rows = await tx.execute<EmailRow>(sql`
    select id, template_key, locale, to_email, subject, null::bytea as body_sealed, state,
           attempts, provider_message_id, error, sent_at, ref_type, ref_id, created_at
    from notify.emails where org_id = ${orgId}
    order by created_at desc, id desc limit ${limit}
  `);
  return [...rows];
}
