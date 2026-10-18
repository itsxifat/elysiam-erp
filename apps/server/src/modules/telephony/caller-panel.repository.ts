import type { Tx } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * The caller panel's own reads of telephony's tables (M47, D-860). Raw SQL because each query
 * reads a computed scope expression (the call's D-841 scope) or a set of columns no Drizzle
 * builder shapes as plainly; every query names `org_id` beside RLS (invariant 4).
 */

/** Whose call it is: the buyer or number it was with. Within the caller's call scope (D-841). */
export interface CallPartyRow extends Record<string, unknown> {
  id: string;
  direction: string;
  from_number: string | null;
  to_number: string | null;
  customer_phone_e164: string | null;
  customer_id: string | null;
  customer_name: string | null;
}

export async function callParty(
  tx: Tx,
  orgId: string,
  callId: string,
  scope: SQL,
): Promise<CallPartyRow | undefined> {
  const rows = await tx.execute<CallPartyRow>(sql`
    select c.id, c.direction, c.from_number, c.to_number, c.customer_phone_e164,
           c.customer_id, c.customer_name
    from telephony.calls c
    where c.org_id = ${orgId} and c.id = ${callId} and ${scope}
  `);
  return rows[0];
}

/** One call with the buyer or number, whoever had it, as the panel's history shows it. */
export interface PanelCallRow extends Record<string, unknown> {
  id: string;
  user_id: string | null;
  direction: 'inbound' | 'outbound' | 'internal' | 'unknown';
  status: 'requested' | 'dialing' | 'failed' | 'ringing' | 'answered' | 'ended';
  answered: boolean;
  occurred_at: Date | string;
  talk_seconds: number | null;
  duration_seconds: number | null;
  order_id: string | null;
  order_no: string | null;
  wrap_up_result: 'reached' | 'no_answer' | 'busy' | 'wrong_number' | 'call_back' | null;
  wrap_up_note: string | null;
  wrap_up_call_back_at: Date | string | null;
  wrapped_up_by_user_id: string | null;
  wrapped_up_at: Date | string | null;
  has_recording: boolean;
  /** Within the viewer's own call scope (D-841): who may hear its recording. */
  in_scope: boolean;
}

/** The party a call was with: a buyer, a number, or both (either may be null). */
export interface Party {
  readonly customerId: string | null;
  readonly phoneE164: string | null;
}

function partyMatch(party: Party): SQL | null {
  const clauses: SQL[] = [];
  if (party.customerId !== null) clauses.push(sql`c.customer_id = ${party.customerId}`);
  if (party.phoneE164 !== null) {
    clauses.push(sql`c.customer_phone_e164 = ${party.phoneE164}`);
    // An inbound call Envo sent before it was linked keeps the caller's number as it came.
    clauses.push(
      sql`(c.direction in ('inbound', 'unknown') and c.from_number = ${party.phoneE164})`,
    );
  }
  return clauses.length === 0 ? null : sql`(${sql.join(clauses, sql` or `)})`;
}

/**
 * Every call with the party, newest first (D-860: "previously another staff was managing"): the
 * history is not cut to the viewer's scope, only whether they may hear each one (`in_scope`).
 */
export async function callsWith(
  tx: Tx,
  orgId: string,
  party: Party,
  scope: SQL,
  limit: number,
): Promise<readonly PanelCallRow[]> {
  const match = partyMatch(party);
  if (match === null) return [];
  const rows = await tx.execute<PanelCallRow>(sql`
    select c.id, c.user_id, c.direction, c.status, c.answered, c.occurred_at, c.talk_seconds,
           c.duration_seconds, c.order_id, c.order_no, c.wrap_up_result, c.wrap_up_note,
           c.wrap_up_call_back_at, c.wrapped_up_by_user_id, c.wrapped_up_at,
           (c.recording_url is not null) as has_recording,
           coalesce((${scope}), false) as in_scope
    from telephony.calls c
    where c.org_id = ${orgId} and ${match}
    order by c.occurred_at desc, c.id desc
    limit ${limit}
  `);
  return [...rows];
}

/**
 * Whether the viewer is on a call with the party now, or was within `endedSince` (D-860): their
 * own call (a Call they placed, an inbound call they answered), or an inbound call still ringing
 * on their connection that nobody has yet. A placement that never rang anyone does not count: a
 * Call button call whose ring-back the person never picked up (Envo had not dialled the customer,
 * `wrapUpAsked`'s rule). Nor a call still open from before `liveSince` (one whose end Envo never
 * sent), or an unanswered one from before `ringingSince` (Envo's trunk dial gives up long before).
 */
export async function onCallWith(
  tx: Tx,
  orgId: string,
  viewer: { readonly userId: string; readonly connectionId: string | null },
  party: Party,
  window: { readonly liveSince: Date; readonly ringingSince: Date; readonly endedSince: Date },
): Promise<boolean> {
  const match = partyMatch(party);
  if (match === null) return false;
  const ringingHere =
    viewer.connectionId === null
      ? sql`false`
      : sql`(c.user_id is null and c.connection_id = ${viewer.connectionId}
              and c.direction in ('inbound', 'unknown')
              and c.status in ('ringing', 'answered') and c.ended_at is null)`;
  const rows = await tx.execute<{ one: number }>(sql`
    select 1 as one from telephony.calls c
    where c.org_id = ${orgId}
      and (c.user_id = ${viewer.userId} or ${ringingHere})
      and c.status <> 'failed' and c.error_code is null
      and (c.first_seen <> 'click' or c.answered)
      and ${match}
      and (
        (c.ended_at is null and c.answered
          and c.occurred_at >= ${window.liveSince.toISOString()}::timestamptz)
        or (c.ended_at is null and not c.answered
          and c.occurred_at >= ${window.ringingSince.toISOString()}::timestamptz)
        or c.ended_at >= ${window.endedSince.toISOString()}::timestamptz
      )
    limit 1
  `);
  return rows.length > 0;
}
