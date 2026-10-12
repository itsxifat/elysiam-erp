import type { Tx } from '@elysium/db';
import type { CallStatus, InboxChannelKind, KeptMediaKind } from '@elysium/domain/inbox';
import { sql } from 'drizzle-orm';

/**
 * M45's SQL (D-780 to D-788): the media the inbox keeps and its calls. Every query names
 * `org_id` beside RLS, as M42's repository does, and touches only the `inbox` schema.
 */

const iso = (value: string | Date | null | undefined): string | null =>
  value === null || value === undefined ? null : new Date(value).toISOString();

// --- kept media ----------------------------------------------------------------------------------

export interface MediaInsert {
  readonly messageId: string;
  readonly conversationId: string;
  readonly position: number;
  readonly kind: KeptMediaKind;
  readonly direction: 'inbound' | 'outbound';
  readonly status: 'pending' | 'stored';
  readonly fileId: string | null;
  readonly mime: string | null;
  readonly sizeBytes: number | null;
  readonly durationMs: number | null;
  readonly occurredAt: Date;
}

/** One kept attachment; nothing when this message's attachment already has its row. */
export async function insertMedia(
  tx: Tx,
  orgId: string,
  media: MediaInsert,
): Promise<string | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into inbox.media (org_id, message_id, conversation_id, position, kind, direction,
                             status, file_id, mime, size_bytes, duration_ms, occurred_at)
    values (${orgId}, ${media.messageId}, ${media.conversationId}, ${media.position},
            ${media.kind}, ${media.direction}, ${media.status}, ${media.fileId}, ${media.mime},
            ${media.sizeBytes}, ${media.durationMs}, ${media.occurredAt.toISOString()}::timestamptz)
    on conflict (org_id, message_id, position) do nothing
    returning id
  `);
  return rows[0]?.id;
}

export interface MediaForFetch extends Record<string, unknown> {
  readonly id: string;
  readonly message_id: string;
  readonly conversation_id: string;
  readonly position: number;
  readonly kind: KeptMediaKind;
  readonly status: 'pending' | 'stored' | 'failed' | 'expired';
  readonly attempts: number;
  readonly attachment: Record<string, unknown> | null;
  readonly channel_kind: InboxChannelKind;
  readonly channel_id: string;
  readonly occurred_at: string | Date;
}

/** A pending download with what it needs: the attachment Meta described and its channel. */
export async function mediaForFetch(
  tx: Tx,
  orgId: string,
  mediaId: string,
): Promise<MediaForFetch | undefined> {
  const rows = await tx.execute<MediaForFetch>(sql`
    select d.id, d.message_id, d.conversation_id, d.position, d.kind, d.status, d.attempts,
           m.attachments -> d.position as attachment, ch.kind as channel_kind,
           v.channel_id, d.occurred_at
    from inbox.media d
    join inbox.messages m on m.org_id = d.org_id and m.id = d.message_id
    join inbox.conversations v on v.org_id = d.org_id and v.id = d.conversation_id
    join inbox.channels ch on ch.org_id = v.org_id and ch.id = v.channel_id
    where d.org_id = ${orgId} and d.id = ${mediaId}
    for update of d
  `);
  return rows[0];
}

export async function markMediaStored(
  tx: Tx,
  orgId: string,
  mediaId: string,
  file: { readonly fileId: string; readonly mime: string; readonly sizeBytes: number },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update inbox.media
    set status = 'stored', file_id = ${file.fileId}, mime = ${file.mime},
        size_bytes = ${file.sizeBytes}, error_code = null, attempts = attempts + 1,
        updated_at = now()
    where org_id = ${orgId} and id = ${mediaId} and status in ('pending', 'failed')
    returning id
  `);
  return rows.length === 1;
}

export async function markMediaFailed(
  tx: Tx,
  orgId: string,
  mediaId: string,
  code: string,
): Promise<void> {
  await tx.execute(sql`
    update inbox.media
    set status = 'failed', error_code = ${code.slice(0, 40)}, attempts = attempts + 1,
        updated_at = now()
    where org_id = ${orgId} and id = ${mediaId} and status in ('pending', 'failed')
  `);
}

/** One more download tried, for a retry that is still worth making. */
export async function bumpMediaAttempts(tx: Tx, orgId: string, mediaId: string): Promise<void> {
  await tx.execute(sql`
    update inbox.media set attempts = attempts + 1, updated_at = now()
    where org_id = ${orgId} and id = ${mediaId} and status in ('pending', 'failed')
  `);
}

export interface MediaByFile extends Record<string, unknown> {
  readonly id: string;
  readonly message_id: string;
  readonly conversation_id: string;
  readonly kind: KeptMediaKind;
  readonly status: string;
  readonly mime: string | null;
}

/** The kept attachment a file belongs to, for the media route. */
export async function mediaByFile(
  tx: Tx,
  orgId: string,
  fileId: string,
): Promise<MediaByFile | undefined> {
  const rows = await tx.execute<MediaByFile>(sql`
    select id, message_id, conversation_id, kind, status, mime from inbox.media
    where org_id = ${orgId} and file_id = ${fileId}
  `);
  return rows[0];
}

export interface MediaOfMessage extends Record<string, unknown> {
  readonly message_id: string;
  readonly position: number;
  readonly kind: KeptMediaKind;
  readonly status: 'pending' | 'stored' | 'failed' | 'expired';
  readonly file_id: string | null;
  readonly mime: string | null;
  readonly duration_ms: number | null;
  readonly error_code: string | null;
}

/** The kept attachments of a page of a thread. */
export async function mediaOfMessages(
  tx: Tx,
  orgId: string,
  messageIds: readonly string[],
): Promise<MediaOfMessage[]> {
  if (messageIds.length === 0) return [];
  const rows = await tx.execute<MediaOfMessage>(sql`
    select message_id, position, kind, status, file_id, mime, duration_ms, error_code
    from inbox.media
    where org_id = ${orgId}
      and message_id in (${sql.join(
        messageIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  `);
  return [...rows];
}

/** The file of an outbound voice message, for its send job. */
export async function voiceFileOf(
  tx: Tx,
  orgId: string,
  messageId: string,
): Promise<{ file_id: string | null; status: string } | undefined> {
  const rows = await tx.execute<{ file_id: string | null; status: string }>(sql`
    select file_id, status from inbox.media
    where org_id = ${orgId} and message_id = ${messageId} and position = 0
      and direction = 'outbound' and kind = 'audio'
  `);
  return rows[0];
}

/** Kept files whose message is older than the retention rule, oldest first (D-783). */
export async function expiredMedia(
  tx: Tx,
  orgId: string,
  before: Date,
  limit: number,
): Promise<{ id: string; file_id: string }[]> {
  const rows = await tx.execute<{ id: string; file_id: string }>(sql`
    select id, file_id from inbox.media
    where org_id = ${orgId} and status = 'stored' and occurred_at < ${before.toISOString()}::timestamptz
    order by occurred_at
    limit ${limit}
    for update skip locked
  `);
  return [...rows];
}

export async function expireMedia(tx: Tx, orgId: string, mediaId: string): Promise<void> {
  await tx.execute(sql`
    update inbox.media set status = 'expired', file_id = null, updated_at = now()
    where org_id = ${orgId} and id = ${mediaId} and status = 'stored'
  `);
}

/** Which of these files a kept attachment refers to (the orphan sweep keeps those). */
export async function referencedFiles(
  tx: Tx,
  orgId: string,
  fileIds: readonly string[],
): Promise<Set<string>> {
  if (fileIds.length === 0) return new Set();
  const rows = await tx.execute<{ file_id: string }>(sql`
    select file_id from inbox.media
    where org_id = ${orgId}
      and file_id in (${sql.join(
        fileIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  `);
  return new Set([...rows].map((row) => row.file_id));
}

/** An outbound voice message of ours still waiting to be sent, for D-745's echo rule. */
export async function voiceInFlight(
  tx: Tx,
  orgId: string,
  conversationId: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    select m.id from inbox.messages m
    join inbox.media d on d.org_id = m.org_id and d.message_id = m.id
    where m.org_id = ${orgId} and m.conversation_id = ${conversationId}
      and m.direction = 'outbound' and m.sent_by is not null and m.status = 'queued'
      and d.direction = 'outbound' and d.kind = 'audio'
    limit 1
  `);
  return rows.length > 0;
}

// --- calls ---------------------------------------------------------------------------------------

export interface CallRow extends Record<string, unknown> {
  readonly id: string;
  readonly conversation_id: string;
  readonly channel_id: string;
  readonly channel_kind: InboxChannelKind;
  readonly provider_call_id: string;
  readonly direction: 'inbound' | 'outbound';
  readonly status: CallStatus;
  readonly offer_sdp: string | null;
  readonly rang_user_ids: string[];
  readonly answered_by: string | null;
  readonly declined_by: string | null;
  readonly started_at: string | Date;
  readonly claimed_at: string | Date | null;
  readonly connected_at: string | Date | null;
  readonly ended_at: string | Date | null;
  readonly duration_seconds: number | null;
  readonly end_reason: string | null;
  readonly callback_needed: boolean;
  readonly callback_done_by: string | null;
  readonly callback_done_at: string | Date | null;
  readonly message_id: string | null;
  readonly assigned_to: string | null;
  readonly contact_name: string | null;
  readonly external_user_id: string;
}

const CALL_SELECT = sql`
  select k.id, k.conversation_id, k.channel_id, ch.kind as channel_kind, k.provider_call_id,
         k.direction, k.status, k.offer_sdp, k.rang_user_ids, k.answered_by, k.declined_by,
         k.started_at, k.claimed_at, k.connected_at, k.ended_at, k.duration_seconds,
         k.end_reason, k.callback_needed, k.callback_done_by, k.callback_done_at, k.message_id,
         v.assigned_to, coalesce(c.display_name, i.profile_name) as contact_name,
         i.external_user_id
  from inbox.calls k
  join inbox.channels ch on ch.org_id = k.org_id and ch.id = k.channel_id
  join inbox.conversations v on v.org_id = k.org_id and v.id = k.conversation_id
  join inbox.contacts c on c.org_id = v.org_id and c.id = v.contact_id
  join inbox.identities i on i.org_id = v.org_id and i.id = v.identity_id`;

export async function callById(
  tx: Tx,
  orgId: string,
  id: string,
  options: { readonly lock?: boolean } = {},
): Promise<CallRow | undefined> {
  const rows = await tx.execute<CallRow>(sql`
    ${CALL_SELECT}
    where k.org_id = ${orgId} and k.id = ${id}
    ${options.lock === true ? sql`for update of k` : sql``}
  `);
  return rows[0];
}

export async function callByProviderId(
  tx: Tx,
  orgId: string,
  providerCallId: string,
): Promise<CallRow | undefined> {
  const rows = await tx.execute<CallRow>(sql`
    ${CALL_SELECT}
    where k.org_id = ${orgId} and k.provider_call_id = ${providerCallId}
    for update of k
  `);
  return rows[0];
}

/** A new call, or nothing when Meta's id is already recorded (a repeated delivery). */
export async function insertCall(
  tx: Tx,
  orgId: string,
  call: {
    readonly conversationId: string;
    readonly channelId: string;
    readonly providerCallId: string;
    readonly status: CallStatus;
    readonly offerSdp: string | null;
    readonly rangUserIds: readonly string[];
    readonly startedAt: Date;
    readonly endedAt?: Date | null;
    readonly durationSeconds?: number | null;
    readonly callbackNeeded?: boolean;
  },
): Promise<string | undefined> {
  const rang = sql`array[${sql.join(
    call.rangUserIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::text[]`;
  const rows = await tx.execute<{ id: string }>(sql`
    insert into inbox.calls (org_id, conversation_id, channel_id, provider_call_id, status,
                             offer_sdp, rang_user_ids, started_at, ended_at, duration_seconds,
                             callback_needed)
    values (${orgId}, ${call.conversationId}, ${call.channelId}, ${call.providerCallId},
            ${call.status}, ${call.offerSdp},
            ${call.rangUserIds.length === 0 ? sql`'{}'::text[]` : rang},
            ${call.startedAt.toISOString()}::timestamptz,
            ${iso(call.endedAt ?? null)}::timestamptz, ${call.durationSeconds ?? null},
            ${call.callbackNeeded ?? false})
    on conflict (org_id, provider_call_id) do nothing
    returning id
  `);
  return rows[0]?.id;
}

export async function setCallMessage(
  tx: Tx,
  orgId: string,
  callId: string,
  messageId: string,
): Promise<void> {
  await tx.execute(sql`
    update inbox.calls set message_id = ${messageId}, updated_at = now()
    where org_id = ${orgId} and id = ${callId} and message_id is null
  `);
}

/** The one conditional update that lets exactly one agent pick a ringing call up. */
export async function claimCall(
  tx: Tx,
  orgId: string,
  callId: string,
  userId: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update inbox.calls
    set status = 'answering', answered_by = ${userId}, claimed_at = now(), updated_at = now()
    where org_id = ${orgId} and id = ${callId} and status = 'ringing'
    returning id
  `);
  return rows.length === 1;
}

/** Back to ringing for everyone: the claimant's browser could not connect. */
export async function releaseCall(
  tx: Tx,
  orgId: string,
  callId: string,
  userId: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update inbox.calls
    set status = 'ringing', answered_by = null, claimed_at = null, updated_at = now()
    where org_id = ${orgId} and id = ${callId} and status = 'answering'
      and answered_by = ${userId}
    returning id
  `);
  return rows.length === 1;
}

export async function connectCall(
  tx: Tx,
  orgId: string,
  callId: string,
  userId: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update inbox.calls
    set status = 'connected', connected_at = now(), offer_sdp = null, updated_at = now()
    where org_id = ${orgId} and id = ${callId} and status = 'answering'
      and answered_by = ${userId}
    returning id
  `);
  return rows.length === 1;
}

/** A call over: its outcome, when it ended, Meta's duration and reason, and the call-back. */
export async function finishCall(
  tx: Tx,
  orgId: string,
  callId: string,
  end: {
    readonly status: CallStatus;
    readonly endedAt: Date;
    readonly durationSeconds: number | null;
    readonly endReason: string | null;
    readonly declinedBy?: string | null;
    readonly callbackNeeded: boolean;
  },
): Promise<void> {
  await tx.execute(sql`
    update inbox.calls
    set status = ${end.status},
        ended_at = coalesce(ended_at, ${end.endedAt.toISOString()}::timestamptz),
        duration_seconds = coalesce(${end.durationSeconds}, duration_seconds),
        end_reason = coalesce(${end.endReason}, end_reason),
        declined_by = coalesce(declined_by, ${end.declinedBy ?? null}),
        answered_by = case when ${end.status} in ('missed', 'declined') then null else answered_by end,
        offer_sdp = null,
        callback_needed = case when callback_done_at is null then ${end.callbackNeeded}
                               else callback_needed end,
        updated_at = now()
    where org_id = ${orgId} and id = ${callId}
  `);
}

/** Meta's last word on a call already over: only its end, duration and reason. */
export async function recordCallEnd(
  tx: Tx,
  orgId: string,
  callId: string,
  end: {
    readonly endedAt: Date;
    readonly durationSeconds: number | null;
    readonly endReason: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    update inbox.calls
    set ended_at = ${end.endedAt.toISOString()}::timestamptz,
        duration_seconds = coalesce(${end.durationSeconds}, duration_seconds),
        end_reason = coalesce(end_reason, ${end.endReason}),
        offer_sdp = null,
        updated_at = now()
    where org_id = ${orgId} and id = ${callId}
  `);
}

export async function markCallbackDone(
  tx: Tx,
  orgId: string,
  callId: string,
  userId: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update inbox.calls
    set callback_needed = false, callback_done_by = ${userId}, callback_done_at = now(),
        updated_at = now()
    where org_id = ${orgId} and id = ${callId} and callback_needed and callback_done_at is null
    returning id
  `);
  return rows.length === 1;
}

/** The caller's live calls: ringing for them, or picked up by them and not over. */
export async function liveCallsFor(tx: Tx, orgId: string, userId: string): Promise<CallRow[]> {
  const rows = await tx.execute<CallRow>(sql`
    ${CALL_SELECT}
    where k.org_id = ${orgId}
      and ((k.status = 'ringing' and ${userId} = any(k.rang_user_ids))
           or (k.status in ('answering', 'connected') and k.answered_by = ${userId}))
    order by k.started_at desc
    limit 10
  `);
  return [...rows];
}

/** Calls still ringing or connecting past their deadline (the sweep's, D-786). */
export async function staleCalls(tx: Tx, orgId: string, before: Date): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from inbox.calls
    where org_id = ${orgId} and status in ('ringing', 'answering')
      and started_at < ${before.toISOString()}::timestamptz
    limit 100
  `);
  return [...rows].map((row) => row.id);
}

/** The calls a page of a thread names, for its entries. */
export async function callsByIds(
  tx: Tx,
  orgId: string,
  ids: readonly string[],
): Promise<CallRow[]> {
  if (ids.length === 0) return [];
  const rows = await tx.execute<CallRow>(sql`
    ${CALL_SELECT}
    where k.org_id = ${orgId}
      and k.id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  `);
  return [...rows];
}

/**
 * The list's summary after a call: newest time and preview, and one unread item for a missed
 * call. Unlike a message, a call does not open the 24-hour reply window (D-788).
 */
export async function touchForCall(
  tx: Tx,
  orgId: string,
  conversationId: string,
  touch: { readonly at: Date; readonly preview: string; readonly unread: boolean },
): Promise<{ assigned_to: string | null } | undefined> {
  const at = touch.at.toISOString();
  const rows = await tx.execute<{ assigned_to: string | null }>(sql`
    update inbox.conversations set
      last_preview = case when ${at}::timestamptz >= last_message_at or last_preview is null
                          then ${touch.preview} else last_preview end,
      last_direction = case when ${at}::timestamptz >= last_message_at or last_direction is null
                            then 'inbound' else last_direction end,
      last_message_at = greatest(last_message_at, ${at}::timestamptz),
      unread_count = ${touch.unread ? sql`unread_count + 1` : sql`unread_count`},
      status = 'open',
      updated_at = now()
    where org_id = ${orgId} and id = ${conversationId}
    returning assigned_to
  `);
  return rows[0];
}

/** Every brand's id, for the daily sweeps. */
export async function allOrgIds(tx: Tx): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(
    sql`select id from org.organizations order by slug`,
  );
  return [...rows].map((row) => row.id);
}
