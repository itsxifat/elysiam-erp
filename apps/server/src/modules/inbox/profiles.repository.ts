import type { Tx } from '@elysium/db';
import type { InboxChannelKind } from '@elysium/domain/inbox';
import { sql } from 'drizzle-orm';

/**
 * A sender's name and photo (M44a, D-761): the SQL behind fetching them from Meta and keeping
 * them on the contact. Every query names `org_id` beside RLS and stays in the `inbox` schema.
 */

const bytes = (value: unknown): Buffer | null =>
  value === null || value === undefined ? null : Buffer.from(value as Uint8Array);

export interface ProfileTarget extends Record<string, unknown> {
  readonly identity_id: string;
  readonly contact_id: string;
  readonly external_user_id: string;
  readonly profile_name: string | null;
  readonly channel_kind: InboxChannelKind;
  readonly channel_enabled: boolean;
  readonly display_name: string | null;
  readonly avatar_url: string | null;
  readonly handle: string | null;
  readonly profile_fetched_at: string | Date | null;
}

/** The identity to ask Meta about, with its channel and its contact as they stand. */
export async function profileTarget(
  tx: Tx,
  orgId: string,
  identityId: string,
): Promise<ProfileTarget | undefined> {
  const rows = await tx.execute<ProfileTarget>(sql`
    select i.id as identity_id, i.contact_id, i.external_user_id, i.profile_name,
           ch.kind as channel_kind, ch.enabled as channel_enabled,
           c.display_name, c.avatar_url, c.handle, c.profile_fetched_at
    from inbox.identities i
    join inbox.channels ch on ch.org_id = i.org_id and ch.id = i.channel_id
    join inbox.contacts c on c.org_id = i.org_id and c.id = i.contact_id
    where i.org_id = ${orgId} and i.id = ${identityId}
  `);
  return rows[0];
}

/** A channel's sealed token by kind, for the Page token Instagram's profile is read with. */
export async function channelToken(
  tx: Tx,
  orgId: string,
  kind: InboxChannelKind,
): Promise<{ readonly enabled: boolean; readonly sealed: Buffer | null } | undefined> {
  const rows = await tx.execute<{ enabled: boolean; access_token_sealed: unknown }>(sql`
    select enabled, access_token_sealed from inbox.channels
    where org_id = ${orgId} and kind = ${kind}
  `);
  const row = rows[0];
  return row === undefined
    ? undefined
    : { enabled: row.enabled, sealed: bytes(row.access_token_sealed) };
}

/** When the contact behind a conversation's identity was last asked about. */
export async function profileFetchedAt(
  tx: Tx,
  orgId: string,
  contactId: string,
): Promise<Date | null> {
  const rows = await tx.execute<{ profile_fetched_at: string | Date | null }>(sql`
    select profile_fetched_at from inbox.contacts where org_id = ${orgId} and id = ${contactId}
  `);
  const value = rows[0]?.profile_fetched_at ?? null;
  return value === null ? null : new Date(value);
}

/** Meta was asked and had nothing (or refused): remember when, so it is not asked at once again. */
export async function markProfileFetched(
  tx: Tx,
  orgId: string,
  contactId: string,
  at: Date,
): Promise<void> {
  await tx.execute(sql`
    update inbox.contacts set profile_fetched_at = ${at.toISOString()}::timestamptz
    where org_id = ${orgId} and id = ${contactId}
  `);
}

/** Keep what Meta said: the identity's own name, and the contact's name, photo and handle. */
export async function saveProfile(
  tx: Tx,
  orgId: string,
  values: {
    readonly identityId: string;
    readonly contactId: string;
    readonly profileName: string | null;
    readonly displayName: string | null;
    readonly avatarUrl: string | null | undefined;
    readonly handle: string | null | undefined;
    readonly fetchedAt: Date | null;
  },
): Promise<void> {
  await tx.execute(sql`
    update inbox.identities set profile_name = ${values.profileName}
    where org_id = ${orgId} and id = ${values.identityId}
  `);
  await tx.execute(sql`
    update inbox.contacts set
      display_name = ${values.displayName},
      avatar_url = ${values.avatarUrl === undefined ? sql`avatar_url` : sql`${values.avatarUrl}`},
      handle = ${values.handle === undefined ? sql`handle` : sql`${values.handle}`},
      profile_fetched_at = ${
        values.fetchedAt === null
          ? sql`profile_fetched_at`
          : sql`${values.fetchedAt.toISOString()}::timestamptz`
      },
      updated_at = now()
    where org_id = ${orgId} and id = ${values.contactId}
  `);
}

/** The contact's conversations, newest first, for the event that tells screens to refetch. */
export async function conversationIdsOfContact(
  tx: Tx,
  orgId: string,
  contactId: string,
): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from inbox.conversations
    where org_id = ${orgId} and contact_id = ${contactId}
    order by last_message_at desc limit 10
  `);
  return [...rows].map((row) => row.id);
}

/**
 * Messenger and Instagram identities whose contact wrote in the last `activeWithinDays` and was
 * never asked about, or not since `staleBefore`: the sweep's work, oldest question first.
 */
export async function identitiesDue(
  tx: Tx,
  orgId: string,
  staleBefore: Date,
  limit: number,
  activeWithinDays = 30,
): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select i.id
    from inbox.identities i
    join inbox.channels ch on ch.org_id = i.org_id and ch.id = i.channel_id
    join inbox.contacts c on c.org_id = i.org_id and c.id = i.contact_id
    join inbox.conversations v on v.org_id = i.org_id and v.identity_id = i.id
    where i.org_id = ${orgId}
      and ch.kind in ('messenger', 'instagram') and ch.enabled
      and (c.profile_fetched_at is null or c.profile_fetched_at < ${staleBefore.toISOString()}::timestamptz)
      and v.last_inbound_at > now() - make_interval(days => ${activeWithinDays})
    order by c.profile_fetched_at nulls first, i.id
    limit ${limit}
  `);
  return [...rows].map((row) => row.id);
}
