import type { Tx } from '@elysium/db';
import type { ContactStage, InboxChannelKind, OutboundStatus } from '@elysium/domain/inbox';
import { sql, type SQL } from 'drizzle-orm';

/**
 * The inbox's SQL (M42). Every query names `org_id` beside RLS, as every repository in this
 * repo does, and touches only the `inbox` schema: buyers, orders, products and people are asked
 * of their own modules (invariant 12).
 */

// --- the brand's Meta app and channels -----------------------------------------------------------

export interface SettingsRow extends Record<string, unknown> {
  readonly id: string;
  readonly app_secret_sealed: Buffer | null;
  readonly app_secret_fingerprint: string | null;
  readonly verify_token_sealed: Buffer | null;
  readonly verify_token_fingerprint: string | null;
  readonly updated_by: string;
  readonly updated_at: string | Date;
}

const bytes = (value: unknown): Buffer | null =>
  value === null || value === undefined ? null : Buffer.from(value as Uint8Array);

export async function settingsOf(tx: Tx, orgId: string): Promise<SettingsRow | undefined> {
  const rows = await tx.execute<SettingsRow>(sql`
    select id, app_secret_sealed, app_secret_fingerprint, verify_token_sealed,
           verify_token_fingerprint, updated_by, updated_at
    from inbox.settings where org_id = ${orgId}
  `);
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    ...row,
    app_secret_sealed: bytes(row.app_secret_sealed),
    verify_token_sealed: bytes(row.verify_token_sealed),
  };
}

export interface SealedValue {
  readonly ciphertext: Buffer;
  readonly keyId: string;
  readonly fingerprint: string;
}

/** Create the brand's settings row if it has none, then set what was given. */
export async function saveSettings(
  tx: Tx,
  orgId: string,
  values: { readonly appSecret?: SealedValue; readonly verifyToken?: SealedValue },
  userId: string,
): Promise<void> {
  await tx.execute(sql`
    insert into inbox.settings (org_id, updated_by) values (${orgId}, ${userId})
    on conflict (org_id) do nothing
  `);
  const secret = values.appSecret;
  const token = values.verifyToken;
  await tx.execute(sql`
    update inbox.settings set
      app_secret_sealed = ${secret === undefined ? sql`app_secret_sealed` : sql`${secret.ciphertext}`},
      app_secret_key_id = ${secret === undefined ? sql`app_secret_key_id` : sql`${secret.keyId}`},
      app_secret_fingerprint = ${
        secret === undefined ? sql`app_secret_fingerprint` : sql`${secret.fingerprint}`
      },
      verify_token_sealed = ${token === undefined ? sql`verify_token_sealed` : sql`${token.ciphertext}`},
      verify_token_key_id = ${token === undefined ? sql`verify_token_key_id` : sql`${token.keyId}`},
      verify_token_fingerprint = ${
        token === undefined ? sql`verify_token_fingerprint` : sql`${token.fingerprint}`
      },
      updated_by = ${userId},
      updated_at = now()
    where org_id = ${orgId}
  `);
}

export interface ChannelRow extends Record<string, unknown> {
  readonly id: string;
  readonly kind: InboxChannelKind;
  readonly external_id: string;
  readonly enabled: boolean;
  readonly access_token_sealed: Buffer | null;
  readonly access_token_fingerprint: string | null;
  readonly updated_by: string;
  readonly updated_at: string | Date;
}

function channelRow(row: ChannelRow): ChannelRow {
  return { ...row, access_token_sealed: bytes(row.access_token_sealed) };
}

const CHANNEL_COLUMNS = sql`id, kind, external_id, enabled, access_token_sealed,
  access_token_fingerprint, updated_by, updated_at`;

export async function channelsOf(tx: Tx, orgId: string): Promise<ChannelRow[]> {
  const rows = await tx.execute<ChannelRow>(sql`
    select ${CHANNEL_COLUMNS} from inbox.channels where org_id = ${orgId} order by kind
  `);
  return [...rows].map(channelRow);
}

export async function channelByKind(
  tx: Tx,
  orgId: string,
  kind: InboxChannelKind,
): Promise<ChannelRow | undefined> {
  const rows = await tx.execute<ChannelRow>(sql`
    select ${CHANNEL_COLUMNS} from inbox.channels where org_id = ${orgId} and kind = ${kind}
  `);
  const row = rows[0];
  return row === undefined ? undefined : channelRow(row);
}

export async function channelById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<ChannelRow | undefined> {
  const rows = await tx.execute<ChannelRow>(sql`
    select ${CHANNEL_COLUMNS} from inbox.channels where org_id = ${orgId} and id = ${id}
  `);
  const row = rows[0];
  return row === undefined ? undefined : channelRow(row);
}

export async function saveChannel(
  tx: Tx,
  orgId: string,
  kind: InboxChannelKind,
  values: {
    readonly externalId: string;
    readonly enabled: boolean;
    readonly token?: SealedValue;
  },
  userId: string,
): Promise<string> {
  const token = values.token;
  const rows = await tx.execute<{ id: string }>(sql`
    insert into inbox.channels (org_id, kind, external_id, enabled, access_token_sealed,
                                access_token_key_id, access_token_fingerprint, updated_by)
    values (${orgId}, ${kind}, ${values.externalId}, ${values.enabled},
            ${token?.ciphertext ?? null}, ${token?.keyId ?? null}, ${token?.fingerprint ?? null},
            ${userId})
    on conflict (org_id, kind) do update set
      external_id = excluded.external_id,
      enabled = excluded.enabled,
      access_token_sealed = ${
        token === undefined
          ? sql`inbox.channels.access_token_sealed`
          : sql`excluded.access_token_sealed`
      },
      access_token_key_id = ${
        token === undefined
          ? sql`inbox.channels.access_token_key_id`
          : sql`excluded.access_token_key_id`
      },
      access_token_fingerprint = ${
        token === undefined
          ? sql`inbox.channels.access_token_fingerprint`
          : sql`excluded.access_token_fingerprint`
      },
      updated_by = excluded.updated_by,
      updated_at = now()
    returning id
  `);
  return rows[0]?.id ?? '';
}

// --- webhook bodies ---------------------------------------------------------------------------

/** Store a signed body once; a body Meta sends again comes back as `duplicate`. */
export async function storeWebhook(
  tx: Tx,
  orgId: string,
  object: string,
  sha256: string,
  body: unknown,
): Promise<{ readonly id: string; readonly duplicate: boolean }> {
  const inserted = await tx.execute<{ id: string }>(sql`
    insert into inbox.webhook_events (org_id, object, body_sha256, body)
    values (${orgId}, ${object}, ${sha256}, ${JSON.stringify(body)}::jsonb)
    on conflict (org_id, body_sha256) do nothing
    returning id
  `);
  const fresh = inserted[0];
  if (fresh !== undefined) return { id: fresh.id, duplicate: false };
  const existing = await tx.execute<{ id: string }>(sql`
    select id from inbox.webhook_events where org_id = ${orgId} and body_sha256 = ${sha256}
  `);
  return { id: existing[0]?.id ?? '', duplicate: true };
}

export interface WebhookEventRow extends Record<string, unknown> {
  readonly id: string;
  readonly object: string;
  readonly body: unknown;
  readonly processed_at: string | Date | null;
}

export async function webhookForProcessing(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<WebhookEventRow | undefined> {
  const rows = await tx.execute<WebhookEventRow>(sql`
    select id, object, body, processed_at from inbox.webhook_events
    where org_id = ${orgId} and id = ${id}
    for update
  `);
  return rows[0];
}

export async function markWebhookProcessed(
  tx: Tx,
  orgId: string,
  id: string,
  outcome: Record<string, number>,
): Promise<void> {
  await tx.execute(sql`
    update inbox.webhook_events
    set processed_at = now(), body = null, outcome = ${JSON.stringify(outcome)}::jsonb
    where org_id = ${orgId} and id = ${id} and processed_at is null
  `);
}

// --- contacts, identities, conversations -------------------------------------------------------

export async function identityOf(
  tx: Tx,
  orgId: string,
  channelId: string,
  externalUserId: string,
): Promise<{ id: string; contact_id: string } | undefined> {
  const rows = await tx.execute<{ id: string; contact_id: string }>(sql`
    select id, contact_id from inbox.identities
    where org_id = ${orgId} and channel_id = ${channelId} and external_user_id = ${externalUserId}
  `);
  return rows[0];
}

/**
 * The identity for a sender, created with its contact the first time they write. Two webhooks
 * racing for a new sender both end on the one identity the unique index lets in.
 */
export async function ensureIdentity(
  tx: Tx,
  orgId: string,
  channelId: string,
  externalUserId: string,
  profileName: string | null,
): Promise<{ readonly id: string; readonly contactId: string; readonly created: boolean }> {
  const existing = await identityOf(tx, orgId, channelId, externalUserId);
  if (existing !== undefined) {
    if (profileName !== null) {
      await tx.execute(sql`
        update inbox.contacts set display_name = ${profileName}, updated_at = now()
        where org_id = ${orgId} and id = ${existing.contact_id} and display_name is null
      `);
    }
    return { id: existing.id, contactId: existing.contact_id, created: false };
  }
  const contact = await tx.execute<{ id: string }>(sql`
    insert into inbox.contacts (org_id, display_name) values (${orgId}, ${profileName})
    returning id
  `);
  const contactId = contact[0]?.id ?? '';
  const inserted = await tx.execute<{ id: string }>(sql`
    insert into inbox.identities (org_id, contact_id, channel_id, external_user_id, profile_name)
    values (${orgId}, ${contactId}, ${channelId}, ${externalUserId}, ${profileName})
    on conflict (org_id, channel_id, external_user_id) do nothing
    returning id
  `);
  const fresh = inserted[0];
  if (fresh !== undefined) return { id: fresh.id, contactId, created: true };
  // Lost the race: another transaction made the identity. Ours is a contact with no identity,
  // which nothing reads; use the winner's.
  const winner = await identityOf(tx, orgId, channelId, externalUserId);
  if (winner === undefined) throw new Error('inbox identity vanished during its own insert');
  return { id: winner.id, contactId: winner.contact_id, created: false };
}

/** The identity's conversation, opened the first time. */
export async function ensureConversation(
  tx: Tx,
  orgId: string,
  values: {
    readonly channelId: string;
    readonly contactId: string;
    readonly identityId: string;
    /** The first message's time, so the list orders by when people wrote, not when Meta told us. */
    readonly at: Date;
  },
): Promise<{ readonly id: string; readonly created: boolean }> {
  const inserted = await tx.execute<{ id: string }>(sql`
    insert into inbox.conversations (org_id, channel_id, contact_id, identity_id, last_message_at)
    values (${orgId}, ${values.channelId}, ${values.contactId}, ${values.identityId},
            ${values.at.toISOString()}::timestamptz)
    on conflict (org_id, identity_id) do nothing
    returning id
  `);
  const fresh = inserted[0];
  if (fresh !== undefined) return { id: fresh.id, created: true };
  const rows = await tx.execute<{ id: string }>(sql`
    select id from inbox.conversations
    where org_id = ${orgId} and identity_id = ${values.identityId}
  `);
  return { id: rows[0]?.id ?? '', created: false };
}

export interface MessageInsert {
  readonly id?: string;
  readonly conversationId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly body: string | null;
  readonly attachments: readonly Record<string, string>[];
  readonly providerMessageId: string | null;
  readonly status: 'received' | OutboundStatus;
  readonly sentBy: string | null;
  readonly occurredAt: Date;
  readonly sentAt?: Date | null;
}

/** One message, or nothing when Meta's id is already recorded (a repeated delivery). */
export async function insertMessage(
  tx: Tx,
  orgId: string,
  message: MessageInsert,
): Promise<string | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into inbox.messages (id, org_id, conversation_id, direction, body, attachments,
                                provider_message_id, status, sent_by, occurred_at, sent_at)
    values (coalesce(${message.id ?? null}::uuid, gen_random_uuid()), ${orgId},
            ${message.conversationId}, ${message.direction}, ${message.body},
            ${JSON.stringify(message.attachments)}::jsonb, ${message.providerMessageId},
            ${message.status}, ${message.sentBy}, ${message.occurredAt.toISOString()}::timestamptz,
            ${message.sentAt === undefined || message.sentAt === null ? null : message.sentAt.toISOString()}::timestamptz)
    ${
      message.id === undefined
        ? sql`on conflict (org_id, provider_message_id) where provider_message_id is not null do nothing`
        : sql`on conflict (id) do nothing`
    }
    returning id
  `);
  return rows[0]?.id;
}

/** The list's summary after a message: newest time, preview, direction, unread and the window. */
export async function touchConversation(
  tx: Tx,
  orgId: string,
  conversationId: string,
  message: {
    readonly direction: 'inbound' | 'outbound';
    readonly at: Date;
    readonly preview: string;
  },
): Promise<{ assigned_to: string | null; status: string } | undefined> {
  const inbound = message.direction === 'inbound';
  const at = message.at.toISOString();
  const rows = await tx.execute<{ assigned_to: string | null; status: string }>(sql`
    update inbox.conversations set
      last_preview = case when ${at}::timestamptz >= last_message_at or last_preview is null
                          then ${message.preview} else last_preview end,
      last_direction = case when ${at}::timestamptz >= last_message_at or last_direction is null
                            then ${message.direction} else last_direction end,
      last_message_at = greatest(last_message_at, ${at}::timestamptz),
      last_inbound_at = ${
        inbound
          ? sql`greatest(coalesce(last_inbound_at, ${at}::timestamptz), ${at}::timestamptz)`
          : sql`last_inbound_at`
      },
      unread_count = ${inbound ? sql`unread_count + 1` : sql`unread_count`},
      status = ${inbound ? sql`'open'` : sql`status`},
      updated_at = now()
    where org_id = ${orgId} and id = ${conversationId}
    returning assigned_to, status
  `);
  return rows[0];
}

export interface ConversationRow extends Record<string, unknown> {
  readonly id: string;
  readonly channel_id: string;
  readonly channel_kind: InboxChannelKind;
  readonly contact_id: string;
  readonly identity_id: string;
  readonly external_user_id: string;
  readonly assigned_to: string | null;
  readonly assigned_at: string | Date | null;
  readonly status: 'open' | 'closed';
  readonly last_message_at: string | Date;
  readonly last_inbound_at: string | Date | null;
  readonly last_preview: string | null;
  readonly last_direction: 'inbound' | 'outbound' | null;
  readonly unread_count: number;
  readonly display_name: string | null;
  readonly profile_name: string | null;
  /** M44a (D-761): Meta's photo and Instagram's username. */
  readonly avatar_url: string | null;
  readonly handle: string | null;
  readonly stage: ContactStage;
  readonly phone_e164: string | null;
  readonly customer_id: string | null;
  readonly created_at: string | Date;
}

const CONVERSATION_SELECT = sql`
  select v.id, v.channel_id, ch.kind as channel_kind, v.contact_id, v.identity_id,
         i.external_user_id, v.assigned_to, v.assigned_at, v.status, v.last_message_at,
         v.last_inbound_at, v.last_preview, v.last_direction, v.unread_count,
         c.display_name, i.profile_name, c.avatar_url, c.handle, c.stage, c.phone_e164,
         c.customer_id, v.created_at
  from inbox.conversations v
  join inbox.channels ch on ch.org_id = v.org_id and ch.id = v.channel_id
  join inbox.contacts c on c.org_id = v.org_id and c.id = v.contact_id
  join inbox.identities i on i.org_id = v.org_id and i.id = v.identity_id`;

export async function conversationById(
  tx: Tx,
  orgId: string,
  id: string,
  options: { readonly lock?: boolean } = {},
): Promise<ConversationRow | undefined> {
  const rows = await tx.execute<ConversationRow>(sql`
    ${CONVERSATION_SELECT}
    where v.org_id = ${orgId} and v.id = ${id}
    ${options.lock === true ? sql`for update of v` : sql``}
  `);
  return rows[0];
}

export interface ListFilter {
  readonly view: 'all' | 'mine' | 'unassigned';
  readonly userId: string;
  readonly channel?: InboxChannelKind | undefined;
  readonly stage?: ContactStage | undefined;
  readonly status: 'open' | 'closed' | 'any';
  readonly unread: boolean;
  /** A name fragment, or digits of a phone in E.164. */
  readonly q?: { readonly name: string; readonly phoneDigits: string | null } | undefined;
  readonly before?: string | undefined;
  readonly limit: number;
}

export async function listConversations(
  tx: Tx,
  orgId: string,
  filter: ListFilter,
): Promise<ConversationRow[]> {
  const where: SQL[] = [sql`v.org_id = ${orgId}`];
  if (filter.view === 'mine') where.push(sql`v.assigned_to = ${filter.userId}`);
  if (filter.view === 'unassigned') where.push(sql`v.assigned_to is null`);
  if (filter.channel !== undefined) where.push(sql`ch.kind = ${filter.channel}`);
  if (filter.stage !== undefined) where.push(sql`c.stage = ${filter.stage}`);
  if (filter.status !== 'any') where.push(sql`v.status = ${filter.status}`);
  if (filter.unread) where.push(sql`v.unread_count > 0`);
  if (filter.before !== undefined) {
    where.push(sql`v.last_message_at < ${filter.before}::timestamptz`);
  }
  if (filter.q !== undefined) {
    const pattern = `%${filter.q.name.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    where.push(
      filter.q.phoneDigits === null
        ? sql`(c.display_name ilike ${pattern} or i.profile_name ilike ${pattern})`
        : sql`(c.display_name ilike ${pattern} or i.profile_name ilike ${pattern}
               or c.phone_e164 like ${`%${filter.q.phoneDigits}%`})`,
    );
  }
  const rows = await tx.execute<ConversationRow>(sql`
    ${CONVERSATION_SELECT}
    where ${sql.join(where, sql` and `)}
    order by v.last_message_at desc, v.id desc
    limit ${filter.limit}
  `);
  return [...rows];
}

/**
 * Unread messages for the tab's title and the desk's ears (M44a, D-764): in the caller's own
 * open conversations, and in open ones nobody has.
 */
export async function unreadCounts(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<{ readonly mine: number; readonly unassigned: number }> {
  const rows = await tx.execute<{
    mine: number | string | null;
    unassigned: number | string | null;
  }>(sql`
    select coalesce(sum(unread_count) filter (where assigned_to = ${userId}), 0) as mine,
           coalesce(sum(unread_count) filter (where assigned_to is null), 0) as unassigned
    from inbox.conversations
    where org_id = ${orgId} and status = 'open' and unread_count > 0
  `);
  return { mine: Number(rows[0]?.mine ?? 0), unassigned: Number(rows[0]?.unassigned ?? 0) };
}

/** Take a conversation nobody has. Zero rows means someone else got there first. */
export async function takeIfUnassigned(
  tx: Tx,
  orgId: string,
  id: string,
  userId: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update inbox.conversations
    set assigned_to = ${userId}, assigned_at = now(), updated_at = now()
    where org_id = ${orgId} and id = ${id} and assigned_to is null
    returning id
  `);
  return rows.length === 1;
}

export async function setAssignee(
  tx: Tx,
  orgId: string,
  id: string,
  userId: string | null,
): Promise<void> {
  await tx.execute(sql`
    update inbox.conversations
    set assigned_to = ${userId},
        assigned_at = ${userId === null ? null : sql`now()`},
        updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

export async function setConversationStatus(
  tx: Tx,
  orgId: string,
  id: string,
  status: 'open' | 'closed',
): Promise<void> {
  await tx.execute(sql`
    update inbox.conversations set status = ${status}, updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

export async function markConversationRead(tx: Tx, orgId: string, id: string): Promise<void> {
  await tx.execute(sql`
    update inbox.conversations set unread_count = 0, updated_at = now()
    where org_id = ${orgId} and id = ${id} and unread_count > 0
  `);
}

// --- messages -----------------------------------------------------------------------------------

export interface MessageRow extends Record<string, unknown> {
  readonly id: string;
  readonly direction: 'inbound' | 'outbound';
  readonly body: string | null;
  readonly attachments: unknown;
  readonly status: 'received' | OutboundStatus;
  readonly sent_by: string | null;
  readonly occurred_at: string | Date;
  readonly sent_at: string | Date | null;
  readonly delivered_at: string | Date | null;
  readonly read_at: string | Date | null;
  readonly failed_at: string | Date | null;
  readonly error_code: string | null;
  readonly error_detail: string | null;
}

const MESSAGE_COLUMNS = sql`id, direction, body, attachments, status, sent_by, occurred_at,
  sent_at, delivered_at, read_at, failed_at, error_code, error_detail`;

/** A page of a thread, newest `limit` before `before`, returned oldest first. */
export async function messagesOf(
  tx: Tx,
  orgId: string,
  conversationId: string,
  page: { readonly before?: string | undefined; readonly limit: number },
): Promise<MessageRow[]> {
  const rows = await tx.execute<MessageRow>(sql`
    select ${MESSAGE_COLUMNS} from inbox.messages
    where org_id = ${orgId} and conversation_id = ${conversationId}
      ${page.before === undefined ? sql`` : sql`and occurred_at < ${page.before}::timestamptz`}
    order by occurred_at desc, created_at desc
    limit ${page.limit}
  `);
  return [...rows].reverse();
}

export async function messageById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<(MessageRow & { conversation_id: string }) | undefined> {
  const rows = await tx.execute<MessageRow & { conversation_id: string }>(sql`
    select ${MESSAGE_COLUMNS}, conversation_id from inbox.messages
    where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

/** The text of the newest inbound messages, for the phone numbers found in a chat. */
export async function recentInboundTexts(
  tx: Tx,
  orgId: string,
  conversationId: string,
  limit: number,
): Promise<string[]> {
  const rows = await tx.execute<{ body: string | null }>(sql`
    select body from inbox.messages
    where org_id = ${orgId} and conversation_id = ${conversationId} and direction = 'inbound'
      and body is not null
    order by occurred_at desc
    limit ${limit}
  `);
  return [...rows].map((row) => row.body ?? '').filter((body) => body !== '');
}

/** What the send job needs: the message, its conversation's channel and recipient. */
export interface OutboundForSend extends Record<string, unknown> {
  readonly id: string;
  readonly conversation_id: string;
  readonly body: string | null;
  readonly status: OutboundStatus;
  readonly provider_message_id: string | null;
  readonly channel_id: string;
  readonly channel_kind: InboxChannelKind;
  readonly recipient_id: string;
  readonly last_inbound_at: string | Date | null;
}

export async function outboundForSend(
  tx: Tx,
  orgId: string,
  messageId: string,
): Promise<OutboundForSend | undefined> {
  const rows = await tx.execute<OutboundForSend>(sql`
    select m.id, m.conversation_id, m.body, m.status, m.provider_message_id, v.channel_id,
           ch.kind as channel_kind, i.external_user_id as recipient_id, v.last_inbound_at
    from inbox.messages m
    join inbox.conversations v on v.org_id = m.org_id and v.id = m.conversation_id
    join inbox.channels ch on ch.org_id = v.org_id and ch.id = v.channel_id
    join inbox.identities i on i.org_id = v.org_id and i.id = v.identity_id
    where m.org_id = ${orgId} and m.id = ${messageId} and m.direction = 'outbound'
    for update of m
  `);
  return rows[0];
}

export async function markSent(
  tx: Tx,
  orgId: string,
  messageId: string,
  providerMessageId: string,
): Promise<boolean> {
  /*
   * Meta's id goes on the row unless an echo of the same message was recorded first (D-745):
   * then the id is that row's, and this one is marked sent without it rather than tripping the
   * unique index and sending the reply again on the retry.
   */
  const rows = await tx.execute<{ id: string }>(sql`
    update inbox.messages m
    set status = case when m.status = 'queued' then 'sent' else m.status end,
        provider_message_id = case
          when exists (select 1 from inbox.messages x
                       where x.org_id = m.org_id and x.provider_message_id = ${providerMessageId})
          then null else ${providerMessageId} end,
        sent_at = coalesce(m.sent_at, now())
    where m.org_id = ${orgId} and m.id = ${messageId} and m.provider_message_id is null
      and m.status = 'queued'
    returning m.id
  `);
  return rows.length === 1;
}

/** When a queued reply was written, for the send job's give-up rule. */
export async function messageCreatedAt(
  tx: Tx,
  orgId: string,
  messageId: string,
): Promise<Date | null> {
  const rows = await tx.execute<{ created_at: string | Date }>(sql`
    select created_at from inbox.messages where org_id = ${orgId} and id = ${messageId}
  `);
  const value = rows[0]?.created_at;
  return value === undefined ? null : new Date(value);
}

export async function markFailed(
  tx: Tx,
  orgId: string,
  messageId: string,
  error: { readonly code: string; readonly detail: string | null },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update inbox.messages
    set status = 'failed', failed_at = now(), error_code = ${error.code},
        error_detail = ${error.detail === null ? null : error.detail.slice(0, 500)}
    where org_id = ${orgId} and id = ${messageId} and status in ('queued', 'sent')
    returning id
  `);
  return rows.length === 1;
}

export interface ReceiptTarget extends Record<string, unknown> {
  readonly id: string;
  readonly conversation_id: string;
  readonly status: OutboundStatus;
}

/** Our messages Meta names by id, of this brand. */
export async function outboundByProviderIds(
  tx: Tx,
  orgId: string,
  providerIds: readonly string[],
): Promise<ReceiptTarget[]> {
  if (providerIds.length === 0) return [];
  const rows = await tx.execute<ReceiptTarget>(sql`
    select id, conversation_id, status from inbox.messages
    where org_id = ${orgId} and direction = 'outbound'
      and provider_message_id = any (${sql.param([...providerIds])}::text[])
    for update
  `);
  return [...rows];
}

/** Our messages to one person on one channel sent at or before a watermark. */
export async function outboundUpTo(
  tx: Tx,
  orgId: string,
  channelId: string,
  externalUserId: string,
  watermark: Date,
): Promise<ReceiptTarget[]> {
  const rows = await tx.execute<ReceiptTarget>(sql`
    select m.id, m.conversation_id, m.status from inbox.messages m
    join inbox.conversations v on v.org_id = m.org_id and v.id = m.conversation_id
    join inbox.identities i on i.org_id = v.org_id and i.id = v.identity_id
    where m.org_id = ${orgId} and v.channel_id = ${channelId}
      and i.external_user_id = ${externalUserId}
      and m.direction = 'outbound' and m.status in ('sent', 'delivered')
      and m.sent_at <= ${watermark.toISOString()}::timestamptz
    order by m.sent_at desc
    limit 200
    for update of m
  `);
  return [...rows];
}

export async function applyStatus(
  tx: Tx,
  orgId: string,
  messageId: string,
  status: OutboundStatus,
  at: Date,
  error: { readonly code: string; readonly detail: string | null } | null,
): Promise<void> {
  const when = at.toISOString();
  const moved = sql`${status}::text`;
  await tx.execute(sql`
    update inbox.messages set
      status = ${moved},
      sent_at = case when ${moved} in ('sent', 'delivered', 'read')
                     then coalesce(sent_at, ${when}::timestamptz) else sent_at end,
      delivered_at = case when ${moved} in ('delivered', 'read')
                          then coalesce(delivered_at, ${when}::timestamptz) else delivered_at end,
      read_at = case when ${moved} = 'read' then coalesce(read_at, ${when}::timestamptz)
                     else read_at end,
      failed_at = case when ${moved} = 'failed' then coalesce(failed_at, ${when}::timestamptz)
                       else failed_at end,
      error_code = ${error === null ? sql`error_code` : sql`${error.code}`},
      error_detail = ${error === null ? sql`error_detail` : sql`${error.detail}`}
    where org_id = ${orgId} and id = ${messageId}
  `);
}

// --- the contact panel --------------------------------------------------------------------------

export interface ContactRow extends Record<string, unknown> {
  readonly id: string;
  readonly display_name: string | null;
  readonly stage: ContactStage;
  readonly stage_set_by: string | null;
  readonly stage_set_at: string | Date | null;
  readonly phone_e164: string | null;
  readonly customer_id: string | null;
  readonly district_id: number | null;
  readonly thana_id: number | null;
  readonly area: string | null;
  readonly address_line: string | null;
  readonly tags: string[];
}

export async function contactById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<ContactRow | undefined> {
  const rows = await tx.execute<ContactRow>(sql`
    select id, display_name, stage, stage_set_by, stage_set_at, phone_e164, customer_id,
           district_id, thana_id, area, address_line, tags
    from inbox.contacts where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

export async function setContactPhone(
  tx: Tx,
  orgId: string,
  id: string,
  phoneE164: string,
  customerId: string | null,
): Promise<void> {
  await tx.execute(sql`
    update inbox.contacts set phone_e164 = ${phoneE164}, customer_id = ${customerId},
                              updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

export async function linkCustomer(
  tx: Tx,
  orgId: string,
  id: string,
  customerId: string,
  phoneE164: string,
): Promise<void> {
  await tx.execute(sql`
    update inbox.contacts
    set customer_id = ${customerId}, phone_e164 = coalesce(phone_e164, ${phoneE164}),
        updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

export async function setContactAddress(
  tx: Tx,
  orgId: string,
  id: string,
  address: {
    readonly districtId: number;
    readonly thanaId: number;
    readonly area: string | null;
    readonly addressLine: string;
  },
): Promise<void> {
  await tx.execute(sql`
    update inbox.contacts
    set district_id = ${address.districtId}, thana_id = ${address.thanaId},
        area = ${address.area}, address_line = ${address.addressLine}, updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

export async function setContactStage(
  tx: Tx,
  orgId: string,
  id: string,
  stage: ContactStage,
  setBy: string,
): Promise<void> {
  await tx.execute(sql`
    update inbox.contacts
    set stage = ${stage}, stage_set_by = ${setBy}, stage_set_at = now(), updated_at = now()
    where org_id = ${orgId} and id = ${id} and stage is distinct from ${stage}
  `);
}

export async function setContactTags(
  tx: Tx,
  orgId: string,
  id: string,
  tags: readonly string[],
): Promise<void> {
  await tx.execute(sql`
    update inbox.contacts set tags = ${sql.param([...tags])}::text[], updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

/** Contacts with this phone or this customer, for the order-created listener (D-738). */
export async function contactsForBuyer(
  tx: Tx,
  orgId: string,
  customerId: string,
  phoneE164: string,
): Promise<{ id: string; stage: ContactStage; customer_id: string | null }[]> {
  const rows = await tx.execute<{
    id: string;
    stage: ContactStage;
    customer_id: string | null;
  }>(sql`
    select id, stage, customer_id from inbox.contacts
    where org_id = ${orgId} and (customer_id = ${customerId} or phone_e164 = ${phoneE164})
    for update
  `);
  return [...rows];
}

/** Is any contact with this phone marked fraud, and which (for the order desk's warning). */
export async function fraudContactsByPhone(
  tx: Tx,
  orgId: string,
  phoneE164: string,
): Promise<{ id: string; display_name: string | null; conversation_id: string | null }[]> {
  const rows = await tx.execute<{
    id: string;
    display_name: string | null;
    conversation_id: string | null;
  }>(sql`
    select c.id, c.display_name,
           (select v.id from inbox.conversations v
             where v.org_id = c.org_id and v.contact_id = c.id
             order by v.last_message_at desc limit 1) as conversation_id
    from inbox.contacts c
    where c.org_id = ${orgId} and c.phone_e164 = ${phoneE164} and c.stage = 'fraud'
    limit 5
  `);
  return [...rows];
}

export interface NoteRow extends Record<string, unknown> {
  readonly id: string;
  readonly body: string;
  readonly author_user_id: string;
  readonly created_at: string | Date;
}

export async function notesOf(tx: Tx, orgId: string, contactId: string): Promise<NoteRow[]> {
  const rows = await tx.execute<NoteRow>(sql`
    select id, body, author_user_id, created_at from inbox.notes
    where org_id = ${orgId} and contact_id = ${contactId}
    order by created_at desc
    limit 100
  `);
  return [...rows];
}

export async function insertNote(
  tx: Tx,
  orgId: string,
  contactId: string,
  body: string,
  authorUserId: string,
): Promise<NoteRow> {
  const rows = await tx.execute<NoteRow>(sql`
    insert into inbox.notes (org_id, contact_id, body, author_user_id)
    values (${orgId}, ${contactId}, ${body}, ${authorUserId})
    returning id, body, author_user_id, created_at
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('note insert returned nothing');
  return row;
}

export interface InterestRow extends Record<string, unknown> {
  readonly id: string;
  readonly product_id: string;
  readonly sku_id: string | null;
  readonly added_by: string;
  readonly created_at: string | Date;
}

export async function interestsOf(
  tx: Tx,
  orgId: string,
  contactId: string,
): Promise<InterestRow[]> {
  const rows = await tx.execute<InterestRow>(sql`
    select id, product_id, sku_id, added_by, created_at from inbox.interests
    where org_id = ${orgId} and contact_id = ${contactId}
    order by created_at desc
    limit 50
  `);
  return [...rows];
}

export async function insertInterest(
  tx: Tx,
  orgId: string,
  values: {
    readonly contactId: string;
    readonly productId: string;
    readonly skuId: string | null;
    readonly addedBy: string;
  },
): Promise<string | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into inbox.interests (org_id, contact_id, product_id, sku_id, added_by)
    values (${orgId}, ${values.contactId}, ${values.productId}, ${values.skuId}, ${values.addedBy})
    on conflict (org_id, contact_id, product_id) do nothing
    returning id
  `);
  return rows[0]?.id;
}

export async function deleteInterest(
  tx: Tx,
  orgId: string,
  contactId: string,
  interestId: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from inbox.interests
    where org_id = ${orgId} and contact_id = ${contactId} and id = ${interestId}
    returning id
  `);
  return rows.length === 1;
}

// --- what the catalog asks (D-621) ---------------------------------------------------------

/** Contacts' interests naming any of the products, or any of the SKUs. */
export async function interestsFor(
  tx: Tx,
  orgId: string,
  column: 'product_id' | 'sku_id',
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from inbox.interests
    where org_id = ${orgId}
      and ${column === 'product_id' ? sql`product_id` : sql`sku_id`} = any (${sql.param([...ids])}::uuid[])
  `);
  return rows[0]?.n ?? 0;
}

// --- geography, for addresses found in a chat (reference data, `ref`) ------------------------

export interface AreaNameRow extends Record<string, unknown> {
  readonly thana_id: number;
  readonly district_id: number;
  readonly thana_en: string;
  readonly thana_bn: string;
  readonly district_en: string;
  readonly district_bn: string;
}

/** Every thana with its district, both languages: global reference data, read once. */
export async function areaNames(tx: Tx): Promise<AreaNameRow[]> {
  const rows = await tx.execute<AreaNameRow>(sql`
    select t.id as thana_id, t.district_id, t.name_en as thana_en, t.name_bn as thana_bn,
           d.name_en as district_en, d.name_bn as district_bn
    from ref.thanas t
    join ref.districts d on d.id = t.district_id
  `);
  return [...rows];
}

// --- M47: a buyer's inbox, for the caller panel (D-860) ------------------------------------------

export interface BuyerContactRow extends Record<string, unknown> {
  readonly id: string;
  readonly display_name: string | null;
  readonly handle: string | null;
  readonly stage: ContactStage;
  readonly phone_e164: string | null;
}

/** The contacts linked to this buyer or holding this phone, newest first (at most `limit`). */
export async function contactsOfBuyer(
  tx: Tx,
  orgId: string,
  who: { readonly customerId: string | null; readonly phoneE164: string | null },
  limit: number,
): Promise<BuyerContactRow[]> {
  const matches: SQL[] = [];
  if (who.customerId !== null) matches.push(sql`c.customer_id = ${who.customerId}`);
  if (who.phoneE164 !== null) matches.push(sql`c.phone_e164 = ${who.phoneE164}`);
  if (matches.length === 0) return [];
  const rows = await tx.execute<BuyerContactRow>(sql`
    select c.id, c.display_name, c.handle, c.stage, c.phone_e164
    from inbox.contacts c
    where c.org_id = ${orgId} and (${sql.join(matches, sql` or `)})
    order by c.updated_at desc, c.id
    limit ${limit}
  `);
  return [...rows];
}

export interface BuyerIdentityRow extends Record<string, unknown> {
  readonly contact_id: string;
  readonly channel: InboxChannelKind;
  readonly profile_name: string | null;
}

/** These contacts' identities on the brand's channels, with each channel's kind. */
export async function identitiesOfContacts(
  tx: Tx,
  orgId: string,
  contactIds: readonly string[],
): Promise<BuyerIdentityRow[]> {
  if (contactIds.length === 0) return [];
  const rows = await tx.execute<BuyerIdentityRow>(sql`
    select i.contact_id, ch.kind as channel, i.profile_name
    from inbox.identities i
    join inbox.channels ch on ch.org_id = i.org_id and ch.id = i.channel_id
    where i.org_id = ${orgId} and i.contact_id = any (${sql.param([...contactIds])}::uuid[])
    order by i.created_at
  `);
  return [...rows];
}

export interface BuyerConversationRow extends Record<string, unknown> {
  readonly id: string;
  readonly contact_id: string;
  readonly channel: InboxChannelKind;
  readonly status: 'open' | 'closed';
  readonly last_message_at: string | Date;
  readonly assigned_to: string | null;
  readonly last_preview: string | null;
}

/** These contacts' conversations, the latest message first (at most `limit`). */
export async function conversationsOfContacts(
  tx: Tx,
  orgId: string,
  contactIds: readonly string[],
  limit: number,
): Promise<BuyerConversationRow[]> {
  if (contactIds.length === 0) return [];
  const rows = await tx.execute<BuyerConversationRow>(sql`
    select v.id, v.contact_id, ch.kind as channel, v.status, v.last_message_at, v.assigned_to,
           v.last_preview
    from inbox.conversations v
    join inbox.channels ch on ch.org_id = v.org_id and ch.id = v.channel_id
    where v.org_id = ${orgId} and v.contact_id = any (${sql.param([...contactIds])}::uuid[])
    order by v.last_message_at desc, v.id
    limit ${limit}
  `);
  return [...rows];
}
