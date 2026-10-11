import type { Tx } from '@elysium/db';
import type { InboxChannelKind } from '@elysium/domain/inbox';
import { sql } from 'drizzle-orm';

/**
 * The inbox's auto-offer SQL (D-748): conversation offers and the per-person counts the engine
 * weighs, in the inbox's own schema (invariant 12). The same shape as M41's order offers
 * (`orders/offers.repository.ts`, D-717): one live offer per conversation and per person is two
 * partial unique indexes, an answer is a conditional UPDATE on `status = 'offered'`, and
 * accepting is one statement that takes the conversation only while it is open and nobody's.
 *
 * Every statement runs in the caller's `withOrg` transaction, so RLS bounds it to the brand.
 */

export interface ConversationOfferRow extends Record<string, unknown> {
  readonly id: string;
  readonly conversation_id: string;
  readonly user_id: string;
  readonly status: string;
  readonly offered_at: Date | string;
  readonly expires_at: Date | string;
  readonly responded_at: Date | string | null;
}

const OFFER_COLUMNS = sql`f.id, f.conversation_id, f.user_id, f.status, f.offered_at,
  f.expires_at, f.responded_at`;

/**
 * Offer a conversation to one person until `now + seconds`, unless the conversation or the
 * person already holds a live offer (the two partial unique indexes). Undefined when the insert
 * lost that race.
 */
export async function insertOffer(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly conversationId: string;
    readonly userId: string;
    readonly seconds: number;
  },
): Promise<ConversationOfferRow | undefined> {
  const rows = await tx.execute<ConversationOfferRow>(sql`
    insert into inbox.conversation_offers as f
      (org_id, conversation_id, user_id, status, offered_at, expires_at)
    values (${input.orgId}, ${input.conversationId}, ${input.userId}, 'offered', now(),
            now() + make_interval(secs => ${input.seconds}))
    on conflict do nothing
    returning ${OFFER_COLUMNS}
  `);
  return rows[0];
}

export async function offerById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<ConversationOfferRow | undefined> {
  const rows = await tx.execute<ConversationOfferRow>(sql`
    select ${OFFER_COLUMNS} from inbox.conversation_offers f
    where f.org_id = ${orgId} and f.id = ${id}
  `);
  return rows[0];
}

/** The conversation's live offer, unexpired. */
export async function liveOfferFor(
  tx: Tx,
  orgId: string,
  conversationId: string,
): Promise<ConversationOfferRow | undefined> {
  const rows = await tx.execute<ConversationOfferRow>(sql`
    select ${OFFER_COLUMNS} from inbox.conversation_offers f
    where f.org_id = ${orgId} and f.conversation_id = ${conversationId}
      and f.status = 'offered' and f.expires_at > now()
  `);
  return rows[0];
}

/**
 * Accept: one statement that gives the person the conversation and answers the offer, only
 * while the offer is live and the conversation is still open and nobody's. A concurrent take or
 * a second accept waits on the row locks and then matches nothing, so exactly one wins.
 */
export async function acceptOffer(
  tx: Tx,
  input: { readonly orgId: string; readonly offerId: string; readonly userId: string },
): Promise<{ conversation_id: string } | undefined> {
  const rows = await tx.execute<{ conversation_id: string }>(sql`
    with live as (
      select f.id, f.conversation_id
      from inbox.conversation_offers f
      join inbox.conversations v on v.org_id = f.org_id and v.id = f.conversation_id
      where f.org_id = ${input.orgId} and f.id = ${input.offerId}
        and f.user_id = ${input.userId}
        and f.status = 'offered' and f.expires_at > now()
        and v.status = 'open' and v.assigned_to is null
      for update of f, v
    ),
    taken as (
      update inbox.conversations v
      set assigned_to = ${input.userId}, assigned_at = now(), updated_at = now()
      from live
      where v.org_id = ${input.orgId} and v.id = live.conversation_id and v.assigned_to is null
      returning v.id
    )
    update inbox.conversation_offers f
    set status = 'accepted', responded_at = now(), updated_at = now()
    from live, taken
    where f.org_id = ${input.orgId} and f.id = live.id and taken.id = live.conversation_id
    returning f.conversation_id
  `);
  return rows[0];
}

/** Answer a live offer with something other than yes. The person's own, when `userId` is set. */
export async function closeOffer(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly offerId: string;
    readonly status: 'declined' | 'expired' | 'withdrawn';
    /** Only the offered person may decline; expiry and withdrawal are the system's. */
    readonly userId?: string;
    /** For an expiry: only once the deadline has passed. */
    readonly onlyIfOverdue?: boolean;
  },
): Promise<ConversationOfferRow | undefined> {
  const rows = await tx.execute<ConversationOfferRow>(sql`
    update inbox.conversation_offers f
    set status = ${input.status}, responded_at = now(), updated_at = now()
    where f.org_id = ${input.orgId} and f.id = ${input.offerId} and f.status = 'offered'
      and ${input.userId === undefined ? sql`true` : sql`f.user_id = ${input.userId}`}
      and ${input.onlyIfOverdue === true ? sql`f.expires_at <= now()` : sql`true`}
    returning ${OFFER_COLUMNS}
  `);
  return rows[0];
}

/** Withdraw the conversation's live offers: it was taken another way, handed over or closed. */
export async function withdrawOffersOf(
  tx: Tx,
  orgId: string,
  conversationId: string,
): Promise<ConversationOfferRow[]> {
  const rows = await tx.execute<ConversationOfferRow>(sql`
    update inbox.conversation_offers f
    set status = 'withdrawn', responded_at = now(), updated_at = now()
    where f.org_id = ${orgId} and f.conversation_id = ${conversationId} and f.status = 'offered'
    returning ${OFFER_COLUMNS}
  `);
  return [...rows];
}

/** Every unanswered offer in the brand, its deadline passed or not, oldest first. */
export async function openOffers(
  tx: Tx,
  orgId: string,
  limit: number,
): Promise<ConversationOfferRow[]> {
  const rows = await tx.execute<ConversationOfferRow>(sql`
    select ${OFFER_COLUMNS} from inbox.conversation_offers f
    where f.org_id = ${orgId} and f.status = 'offered'
    order by f.expires_at
    limit ${limit}
  `);
  return [...rows];
}

/** Every unanswered offer past its deadline, oldest first: what the sweep expires. */
export async function overdueOffers(
  tx: Tx,
  orgId: string,
  limit: number,
): Promise<ConversationOfferRow[]> {
  const rows = await tx.execute<ConversationOfferRow>(sql`
    select ${OFFER_COLUMNS} from inbox.conversation_offers f
    where f.org_id = ${orgId} and f.status = 'offered' and f.expires_at <= now()
    order by f.expires_at
    limit ${limit}
  `);
  return [...rows];
}

/** A conversation's unanswered offers whose deadline has passed. */
export async function overdueOffersOf(
  tx: Tx,
  orgId: string,
  conversationId: string,
): Promise<ConversationOfferRow[]> {
  const rows = await tx.execute<ConversationOfferRow>(sql`
    select ${OFFER_COLUMNS} from inbox.conversation_offers f
    where f.org_id = ${orgId} and f.conversation_id = ${conversationId}
      and f.status = 'offered' and f.expires_at <= now()
  `);
  return [...rows];
}

/** Everyone holding an unanswered conversation offer, its deadline passed or not. */
export async function offeredUsers(tx: Tx, orgId: string): Promise<Set<string>> {
  const rows = await tx.execute<{ user_id: string }>(sql`
    select distinct user_id from inbox.conversation_offers
    where org_id = ${orgId} and status = 'offered'
  `);
  return new Set([...rows].map((row) => row.user_id));
}

/** People who declined this conversation or let an offer of it expire. */
export async function declinedBy(
  tx: Tx,
  orgId: string,
  conversationId: string,
): Promise<Set<string>> {
  const rows = await tx.execute<{ user_id: string }>(sql`
    select distinct user_id from inbox.conversation_offers
    where org_id = ${orgId} and conversation_id = ${conversationId}
      and status in ('declined', 'expired')
  `);
  return new Set([...rows].map((row) => row.user_id));
}

/** When each person was last offered a conversation, in the last day. */
export async function lastOfferedAt(tx: Tx, orgId: string): Promise<Map<string, Date>> {
  const rows = await tx.execute<{ user_id: string; at: Date | string }>(sql`
    select user_id, max(offered_at) as at from inbox.conversation_offers
    where org_id = ${orgId} and offered_at > now() - interval '1 day'
    group by user_id
  `);
  return new Map([...rows].map((row) => [row.user_id, new Date(row.at)]));
}

/** Each person's open conversations: the load the cap is weighed against. */
export async function openLoads(tx: Tx, orgId: string): Promise<Map<string, number>> {
  const rows = await tx.execute<{ assigned_to: string; open: number }>(sql`
    select assigned_to, count(*)::int as open from inbox.conversations
    where org_id = ${orgId} and assigned_to is not null and status = 'open'
    group by assigned_to
  `);
  return new Map([...rows].map((row) => [row.assigned_to, row.open]));
}

/** The conversation, locked: an offer, an accept and a take of it run one after the other. */
export async function conversationForUpdate(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<
  | {
      readonly id: string;
      readonly status: string;
      readonly assigned_to: string | null;
      readonly last_direction: string | null;
    }
  | undefined
> {
  const rows = await tx.execute<{
    id: string;
    status: string;
    assigned_to: string | null;
    last_direction: string | null;
  }>(sql`
    select id, status, assigned_to, last_direction from inbox.conversations
    where org_id = ${orgId} and id = ${id}
    for update
  `);
  return rows[0];
}

/**
 * Open conversations nobody has, whose customer wrote last, with no live offer: what the sweep
 * and a person becoming available offer. Oldest message first, so nobody waits longest twice.
 */
export async function waitingConversations(
  tx: Tx,
  orgId: string,
  limit: number,
): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select v.id from inbox.conversations v
    where v.org_id = ${orgId} and v.status = 'open' and v.assigned_to is null
      and v.last_direction = 'inbound'
      and not exists (
        select 1 from inbox.conversation_offers f
        where f.org_id = v.org_id and f.conversation_id = v.id and f.status = 'offered'
          and f.expires_at > now()
      )
    order by v.last_message_at
    limit ${limit}
  `);
  return [...rows].map((row) => row.id);
}

export interface ConversationOfferCardRow extends ConversationOfferRow {
  readonly channel_kind: InboxChannelKind;
  readonly contact_name: string | null;
  readonly last_preview: string | null;
  readonly unread_count: number;
}

/** The person's live offers with what the offer card shows: who, on which channel, what. */
export async function offerCardsFor(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<ConversationOfferCardRow[]> {
  const rows = await tx.execute<ConversationOfferCardRow>(sql`
    select ${OFFER_COLUMNS}, ch.kind as channel_kind,
           coalesce(c.display_name, i.profile_name) as contact_name,
           v.last_preview, v.unread_count
    from inbox.conversation_offers f
    join inbox.conversations v on v.org_id = f.org_id and v.id = f.conversation_id
    join inbox.channels ch on ch.org_id = v.org_id and ch.id = v.channel_id
    join inbox.contacts c on c.org_id = v.org_id and c.id = v.contact_id
    join inbox.identities i on i.org_id = v.org_id and i.id = v.identity_id
    where f.org_id = ${orgId} and f.user_id = ${userId} and f.status = 'offered'
      and f.expires_at > now()
    order by f.offered_at
  `);
  return [...rows];
}
