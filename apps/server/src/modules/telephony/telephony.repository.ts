import type { Tx } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';

import type { SealedSecret } from './telephony-secrets.js';

/**
 * Telephony's SQL (M47, D-830 to D-853). Every statement names `org_id` as well as running under
 * the brand's RLS context (invariant 4), is parameterised, and reads only this module's own
 * schema (invariant 12): buyers, orders, people and files are asked of their modules.
 */

// --- connections ------------------------------------------------------------------------------

export interface ConnectionRow extends Record<string, unknown> {
  readonly id: string;
  readonly org_id: string;
  readonly name: string;
  readonly base_url: string;
  readonly enabled: boolean;
  readonly api_key_sealed: Buffer | null;
  readonly api_key_fingerprint: string | null;
  readonly webhook_secret_sealed: Buffer | null;
  readonly webhook_secret_fingerprint: string | null;
  readonly envo_server_id: number | null;
  readonly envo_server_name: string | null;
  readonly last_tested_at: Date | string | null;
  readonly last_test_ok: boolean | null;
  readonly last_test_error: string | null;
  readonly last_webhook_at: Date | string | null;
  readonly last_webhook_event: string | null;
  readonly last_signature_failure_at: Date | string | null;
  readonly last_signature_failure_reason: string | null;
  readonly sync_cursor: Date | string | null;
  readonly last_synced_at: Date | string | null;
  readonly last_sync_error: string | null;
  readonly updated_at: Date | string;
}

const CONNECTION_COLUMNS = sql`
  id, org_id, name, base_url, enabled, api_key_sealed, api_key_fingerprint,
  webhook_secret_sealed, webhook_secret_fingerprint, envo_server_id,
  envo_server_name, last_tested_at, last_test_ok, last_test_error, last_webhook_at,
  last_webhook_event, last_signature_failure_at, last_signature_failure_reason, sync_cursor,
  last_synced_at, last_sync_error, updated_at
`;

function bytes(value: unknown): Buffer | null {
  if (value === null || value === undefined) return null;
  return Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
}

function connectionOf(row: ConnectionRow): ConnectionRow {
  return {
    ...row,
    api_key_sealed: bytes(row.api_key_sealed),
    webhook_secret_sealed: bytes(row.webhook_secret_sealed),
  };
}

export async function connectionsOf(tx: Tx, orgId: string): Promise<ConnectionRow[]> {
  const rows = await tx.execute<ConnectionRow>(sql`
    select ${CONNECTION_COLUMNS} from telephony.connections
    where org_id = ${orgId}
    order by created_at, id
  `);
  return [...rows].map(connectionOf);
}

export async function connectionById(
  tx: Tx,
  orgId: string,
  id: string,
  options: { readonly lock?: boolean } = {},
): Promise<ConnectionRow | undefined> {
  const rows = await tx.execute<ConnectionRow>(sql`
    select ${CONNECTION_COLUMNS} from telephony.connections
    where org_id = ${orgId} and id = ${id}
    ${options.lock === true ? sql`for update` : sql``}
  `);
  const row = rows[0];
  return row === undefined ? undefined : connectionOf(row);
}

export async function insertConnection(
  tx: Tx,
  input: {
    readonly id: string;
    readonly orgId: string;
    readonly name: string;
    readonly baseUrl: string;
    readonly enabled: boolean;
    readonly apiKey: SealedSecret;
    readonly webhookSecret: SealedSecret | null;
    readonly by: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into telephony.connections
      (id, org_id, name, base_url, enabled, api_key_sealed, api_key_key_id, api_key_fingerprint,
       webhook_secret_sealed, webhook_secret_key_id, webhook_secret_fingerprint,
       created_by, updated_by)
    values (${input.id}, ${input.orgId}, ${input.name}, ${input.baseUrl}, ${input.enabled},
            ${input.apiKey.ciphertext}, ${input.apiKey.keyId}, ${input.apiKey.fingerprint},
            ${input.webhookSecret?.ciphertext ?? null}, ${input.webhookSecret?.keyId ?? null},
            ${input.webhookSecret?.fingerprint ?? null},
            ${input.by}, ${input.by})
  `);
}

export async function updateConnection(
  tx: Tx,
  orgId: string,
  id: string,
  input: {
    readonly name: string;
    readonly baseUrl: string;
    readonly enabled: boolean;
    readonly apiKey?: SealedSecret;
    readonly webhookSecret?: SealedSecret;
    /** A new base URL or key means another SIP server, perhaps: forget what the last Test learned. */
    readonly forgetServer: boolean;
    readonly by: string;
  },
): Promise<void> {
  await tx.execute(sql`
    update telephony.connections set
      name = ${input.name},
      base_url = ${input.baseUrl},
      enabled = ${input.enabled},
      ${
        input.apiKey === undefined
          ? sql``
          : sql`api_key_sealed = ${input.apiKey.ciphertext},
                api_key_key_id = ${input.apiKey.keyId},
                api_key_fingerprint = ${input.apiKey.fingerprint},`
      }
      ${
        input.webhookSecret === undefined
          ? sql``
          : sql`webhook_secret_sealed = ${input.webhookSecret.ciphertext},
                webhook_secret_key_id = ${input.webhookSecret.keyId},
                webhook_secret_fingerprint = ${input.webhookSecret.fingerprint},`
      }
      ${
        input.forgetServer
          ? sql`envo_server_id = null, envo_server_name = null, last_test_ok = null,
                last_test_error = null, last_tested_at = null,`
          : sql``
      }
      updated_by = ${input.by},
      updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

export async function recordTest(
  tx: Tx,
  orgId: string,
  id: string,
  result:
    | { readonly ok: true; readonly serverId: number | null; readonly serverName: string | null }
    | { readonly ok: false; readonly error: string },
): Promise<void> {
  await tx.execute(sql`
    update telephony.connections set
      last_tested_at = now(),
      last_test_ok = ${result.ok},
      last_test_error = ${result.ok ? null : result.error.slice(0, 300)},
      ${
        result.ok
          ? sql`envo_server_id = ${result.serverId}, envo_server_name = ${result.serverName},`
          : sql``
      }
      updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

export async function recordWebhookSeen(
  tx: Tx,
  orgId: string,
  id: string,
  event: string,
): Promise<void> {
  await tx.execute(sql`
    update telephony.connections set last_webhook_at = now(), last_webhook_event = ${event.slice(0, 40)}
    where org_id = ${orgId} and id = ${id}
  `);
}

/** A refused signature, at most once a minute: a stranger's flood writes one row a minute. */
export async function recordSignatureFailure(
  tx: Tx,
  orgId: string,
  id: string,
  reason: string,
): Promise<void> {
  await tx.execute(sql`
    update telephony.connections set
      last_signature_failure_at = now(),
      last_signature_failure_reason = ${reason.slice(0, 40)}
    where org_id = ${orgId} and id = ${id}
      and (last_signature_failure_at is null
           or last_signature_failure_at < now() - interval '1 minute')
  `);
}

export async function recordSync(
  tx: Tx,
  orgId: string,
  id: string,
  result: { readonly cursor: Date | null; readonly error: string | null },
): Promise<void> {
  await tx.execute(sql`
    update telephony.connections set
      last_synced_at = now(),
      last_sync_error = ${result.error === null ? null : result.error.slice(0, 300)},
      sync_cursor = greatest(sync_cursor, ${result.cursor?.toISOString() ?? null}::timestamptz)
    where org_id = ${orgId} and id = ${id}
  `);
}

/** Every active brand's id, for a sweep that acts (the sync asks Envo for active ones only). */
export async function allOrgIds(tx: Tx): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(
    sql`select id from org.organizations where is_active order by slug`,
  );
  return [...rows].map((row) => row.id);
}

/**
 * Every brand's id, switched off or not, for a sweep that deletes personal data: a brand that
 * was switched off still owes its customers the webhook bodies' retention (D-851), as the
 * packing videos' purge walks every brand (D-612).
 */
export async function everyOrgId(tx: Tx): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(
    sql`select id from org.organizations order by slug`,
  );
  return [...rows].map((row) => row.id);
}

export async function syncableConnectionIds(tx: Tx, orgId: string): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from telephony.connections
    where org_id = ${orgId} and enabled and api_key_sealed is not null
    order by id
  `);
  return [...rows].map((row) => row.id);
}

// --- extensions ---------------------------------------------------------------------------------

export interface AssignmentRow extends Record<string, unknown> {
  readonly id: string;
  readonly connection_id: string;
  readonly extension: string;
  readonly user_id: string;
  readonly assigned_by: string;
  readonly created_at: Date | string;
}

export async function assignmentsOf(
  tx: Tx,
  orgId: string,
  connectionId?: string,
): Promise<AssignmentRow[]> {
  const rows = await tx.execute<AssignmentRow>(sql`
    select id, connection_id, extension, user_id, assigned_by, created_at
    from telephony.extension_assignments
    where org_id = ${orgId}
      ${connectionId === undefined ? sql`` : sql`and connection_id = ${connectionId}`}
    order by extension, id
  `);
  return [...rows];
}

export async function assignmentOfUser(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<AssignmentRow | undefined> {
  const rows = await tx.execute<AssignmentRow>(sql`
    select id, connection_id, extension, user_id, assigned_by, created_at
    from telephony.extension_assignments
    where org_id = ${orgId} and user_id = ${userId}
  `);
  return rows[0];
}

export async function assignmentOfExtension(
  tx: Tx,
  orgId: string,
  connectionId: string,
  extension: string,
): Promise<AssignmentRow | undefined> {
  const rows = await tx.execute<AssignmentRow>(sql`
    select id, connection_id, extension, user_id, assigned_by, created_at
    from telephony.extension_assignments
    where org_id = ${orgId} and connection_id = ${connectionId} and extension = ${extension}
  `);
  return rows[0];
}

/** Inserted, or null when the extension or the person is already taken (the unique indexes). */
export async function insertAssignment(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly connectionId: string;
    readonly extension: string;
    readonly userId: string;
    readonly by: string;
  },
): Promise<string | null> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into telephony.extension_assignments
      (org_id, connection_id, extension, user_id, assigned_by)
    values (${input.orgId}, ${input.connectionId}, ${input.extension}, ${input.userId}, ${input.by})
    on conflict do nothing
    returning id
  `);
  return rows[0]?.id ?? null;
}

export async function deleteAssignment(tx: Tx, orgId: string, id: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from telephony.extension_assignments
    where org_id = ${orgId} and id = ${id}
    returning id
  `);
  return rows.length > 0;
}

// --- calls ----------------------------------------------------------------------------------------

export interface CallRow extends Record<string, unknown> {
  readonly id: string;
  readonly connection_id: string;
  readonly envo_call_id: string | null;
  readonly first_seen: string;
  readonly direction: string;
  readonly status: string;
  readonly from_number: string | null;
  readonly to_number: string | null;
  readonly customer_phone_e164: string | null;
  readonly extension: string | null;
  readonly user_id: string | null;
  readonly customer_id: string | null;
  readonly customer_name: string | null;
  readonly order_id: string | null;
  readonly order_no: string | null;
  readonly order_owner_user_id: string | null;
  readonly answered: boolean;
  readonly disposition: string | null;
  readonly talk_seconds: number | null;
  readonly duration_seconds: number | null;
  readonly occurred_at: Date | string;
  readonly requested_at: Date | string | null;
  readonly started_at: Date | string | null;
  readonly answered_at: Date | string | null;
  readonly ended_at: Date | string | null;
  readonly error_code: string | null;
  readonly error_detail: string | null;
  readonly recording_url: string | null;
  readonly outcome_attempt_id: string | null;
  readonly outcome: string | null;
  readonly wrap_up_result: string | null;
  readonly wrap_up_note: string | null;
  readonly wrap_up_call_back_at: Date | string | null;
  readonly wrapped_up_by_user_id: string | null;
  readonly wrapped_up_at: Date | string | null;
  readonly last_event: string | null;
}

const CALL_COLUMNS = sql`
  c.id, c.connection_id, c.envo_call_id, c.first_seen, c.direction, c.status, c.from_number,
  c.to_number, c.customer_phone_e164, c.extension, c.user_id, c.customer_id, c.customer_name,
  c.order_id, c.order_no, c.order_owner_user_id, c.answered, c.disposition, c.talk_seconds,
  c.duration_seconds, c.occurred_at, c.requested_at, c.started_at, c.answered_at, c.ended_at,
  c.error_code, c.error_detail, c.recording_url, c.outcome_attempt_id, c.outcome,
  c.wrap_up_result, c.wrap_up_note, c.wrap_up_call_back_at, c.wrapped_up_by_user_id,
  c.wrapped_up_at, c.last_event
`;

export async function callById(
  tx: Tx,
  orgId: string,
  id: string,
  options: { readonly lock?: boolean; readonly scope?: SQL } = {},
): Promise<CallRow | undefined> {
  const rows = await tx.execute<CallRow>(sql`
    select ${CALL_COLUMNS} from telephony.calls c
    where c.org_id = ${orgId} and c.id = ${id}
      and ${options.scope ?? sql`true`}
    ${options.lock === true ? sql`for update` : sql``}
  `);
  return rows[0];
}

export async function callByEnvoId(
  tx: Tx,
  orgId: string,
  connectionId: string,
  envoCallId: string,
): Promise<CallRow | undefined> {
  const rows = await tx.execute<CallRow>(sql`
    select ${CALL_COLUMNS} from telephony.calls c
    where c.org_id = ${orgId} and c.connection_id = ${connectionId}
      and c.envo_call_id = ${envoCallId}
    for update
  `);
  return rows[0];
}

/** The same, for a screen: no lock. */
export async function callByEnvoIdReadOnly(
  tx: Tx,
  orgId: string,
  connectionId: string,
  envoCallId: string,
): Promise<CallRow | undefined> {
  const rows = await tx.execute<CallRow>(sql`
    select ${CALL_COLUMNS} from telephony.calls c
    where c.org_id = ${orgId} and c.connection_id = ${connectionId}
      and c.envo_call_id = ${envoCallId}
  `);
  return rows[0];
}

/**
 * Serialises everything done about one Envo call of one connection for the transaction, so two
 * of its webhooks (or a webhook and the sync) processed at once create one row and match one
 * click (D-835).
 */
export async function lockEnvoCall(
  tx: Tx,
  orgId: string,
  connectionId: string,
  envoCallId: string,
): Promise<void> {
  await tx.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(${`telephony:${orgId}:${connectionId}:${envoCallId}`}, 0))
  `);
}

/** Serialises one person's clicks, so a double press becomes one call (D-834). */
export async function lockPersonCalls(tx: Tx, orgId: string, userId: string): Promise<void> {
  await tx.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(${`telephony-click:${orgId}:${userId}`}, 0))
  `);
}

/** Clicks of the connection Envo has not named yet, asked for between `from` and `to`. */
export async function pendingClicks(
  tx: Tx,
  orgId: string,
  connectionId: string,
  from: Date,
  to: Date,
): Promise<CallRow[]> {
  const rows = await tx.execute<CallRow>(sql`
    select ${CALL_COLUMNS} from telephony.calls c
    where c.org_id = ${orgId} and c.connection_id = ${connectionId}
      and c.envo_call_id is null and c.status in ('requested', 'dialing')
      and c.requested_at between ${from.toISOString()}::timestamptz and ${to.toISOString()}::timestamptz
    order by c.requested_at desc
    for update
  `);
  return [...rows];
}

/** This person's click to this number in the last `seconds`, still going, if any. */
export async function recentClick(
  tx: Tx,
  orgId: string,
  userId: string,
  phoneE164: string,
  seconds: number,
): Promise<CallRow | undefined> {
  const rows = await tx.execute<CallRow>(sql`
    select ${CALL_COLUMNS} from telephony.calls c
    where c.org_id = ${orgId} and c.user_id = ${userId} and c.first_seen = 'click'
      and c.customer_phone_e164 = ${phoneE164}
      and c.status in ('requested', 'dialing', 'ringing', 'answered')
      and c.requested_at > now() - make_interval(secs => ${seconds})
    order by c.requested_at desc
    limit 1
  `);
  return rows[0];
}

export interface NewCall {
  readonly orgId: string;
  readonly connectionId: string;
  readonly envoCallId: string | null;
  readonly firstSeen: 'click' | 'webhook' | 'sync';
  readonly direction: string;
  readonly status: string;
  readonly fromNumber: string | null;
  readonly toNumber: string | null;
  readonly customerPhoneE164: string | null;
  readonly extension: string | null;
  readonly userId: string | null;
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly orderId: string | null;
  readonly orderNo: string | null;
  readonly orderOwnerUserId: string | null;
  readonly occurredAt: Date;
  readonly requestedAt: Date | null;
}

export async function insertCall(tx: Tx, call: NewCall): Promise<CallRow> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into telephony.calls
      (org_id, connection_id, envo_call_id, first_seen, direction, status, from_number, to_number,
       customer_phone_e164, extension, user_id, customer_id, customer_name, order_id, order_no,
       order_owner_user_id, occurred_at, requested_at)
    values (${call.orgId}, ${call.connectionId}, ${call.envoCallId}, ${call.firstSeen},
            ${call.direction}, ${call.status}, ${call.fromNumber}, ${call.toNumber},
            ${call.customerPhoneE164}, ${call.extension}, ${call.userId}, ${call.customerId},
            ${call.customerName?.slice(0, 120) ?? null}, ${call.orderId}, ${call.orderNo},
            ${call.orderOwnerUserId}, ${call.occurredAt.toISOString()}::timestamptz,
            ${call.requestedAt?.toISOString() ?? null}::timestamptz)
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('the call was not recorded');
  const row = await callById(tx, call.orgId, id);
  if (row === undefined) throw new Error('the call was not recorded');
  return row;
}

/** What may change on a call, each field only when given (the trigger keeps the rest). */
export interface CallChange {
  readonly envoCallId?: string;
  readonly direction?: string;
  readonly status?: string;
  readonly fromNumber?: string | null;
  readonly toNumber?: string | null;
  readonly customerPhoneE164?: string;
  readonly extension?: string;
  readonly userId?: string;
  readonly customerId?: string;
  readonly customerName?: string | null;
  readonly orderId?: string;
  readonly orderNo?: string;
  readonly orderOwnerUserId?: string | null;
  readonly answered?: boolean;
  readonly disposition?: string | null;
  readonly talkSeconds?: number | null;
  readonly durationSeconds?: number | null;
  readonly startedAt?: Date;
  readonly answeredAt?: Date;
  readonly endedAt?: Date;
  readonly errorCode?: string;
  readonly errorDetail?: string | null;
  readonly recordingUrl?: string;
  readonly outcomeAttemptId?: string;
  readonly outcome?: string;
  readonly wrapUpResult?: string;
  readonly wrapUpNote?: string | null;
  readonly wrapUpCallBackAt?: Date | null;
  readonly wrappedUpByUserId?: string;
  readonly wrappedUpAt?: Date;
  readonly lastEvent?: string;
}

const CHANGE_COLUMNS: Readonly<Record<keyof CallChange, string>> = {
  envoCallId: 'envo_call_id',
  direction: 'direction',
  status: 'status',
  fromNumber: 'from_number',
  toNumber: 'to_number',
  customerPhoneE164: 'customer_phone_e164',
  extension: 'extension',
  userId: 'user_id',
  customerId: 'customer_id',
  customerName: 'customer_name',
  orderId: 'order_id',
  orderNo: 'order_no',
  orderOwnerUserId: 'order_owner_user_id',
  answered: 'answered',
  disposition: 'disposition',
  talkSeconds: 'talk_seconds',
  durationSeconds: 'duration_seconds',
  startedAt: 'started_at',
  answeredAt: 'answered_at',
  endedAt: 'ended_at',
  errorCode: 'error_code',
  errorDetail: 'error_detail',
  recordingUrl: 'recording_url',
  outcomeAttemptId: 'outcome_attempt_id',
  outcome: 'outcome',
  wrapUpResult: 'wrap_up_result',
  wrapUpNote: 'wrap_up_note',
  wrapUpCallBackAt: 'wrap_up_call_back_at',
  wrappedUpByUserId: 'wrapped_up_by_user_id',
  wrappedUpAt: 'wrapped_up_at',
  lastEvent: 'last_event',
};

export async function updateCall(
  tx: Tx,
  orgId: string,
  id: string,
  change: CallChange,
): Promise<CallRow> {
  const sets: SQL[] = [];
  for (const [key, column] of Object.entries(CHANGE_COLUMNS) as [keyof CallChange, string][]) {
    if (!(key in change)) continue;
    const value = change[key];
    if (value === undefined) continue;
    const bound = value instanceof Date ? sql`${value.toISOString()}::timestamptz` : sql`${value}`;
    sets.push(sql`${sql.identifier(column)} = ${bound}`);
  }
  if (change.lastEvent !== undefined) sets.push(sql`last_event_at = now()`);
  if (sets.length > 0) {
    sets.push(sql`updated_at = now()`);
    await tx.execute(sql`
      update telephony.calls set ${sql.join(sets, sql`, `)}
      where org_id = ${orgId} and id = ${id}
    `);
  }
  const row = await callById(tx, orgId, id);
  if (row === undefined) throw new Error('the call disappeared');
  return row;
}

/** Clicks Envo took and never described, older than `before`. */
export async function staleClicks(
  tx: Tx,
  orgId: string,
  connectionId: string,
  before: Date,
): Promise<CallRow[]> {
  const rows = await tx.execute<CallRow>(sql`
    select ${CALL_COLUMNS} from telephony.calls c
    where c.org_id = ${orgId} and c.connection_id = ${connectionId}
      and c.envo_call_id is null and c.status in ('requested', 'dialing')
      and c.requested_at < ${before.toISOString()}::timestamptz
    order by c.requested_at
    limit 200
    for update
  `);
  return [...rows];
}

/**
 * The person's own calls that wait for their wrap-up (D-859): ended since `since`, not yet wrapped
 * up, and asking for one (`wrapUpAsked` in SQL: no error, not internal, and a Call button call
 * only once its ring-back was answered). Newest first.
 */
export async function wrapUpsOf(
  tx: Tx,
  orgId: string,
  userId: string,
  since: Date,
  limit: number,
): Promise<CallRow[]> {
  const rows = await tx.execute<CallRow>(sql`
    select ${CALL_COLUMNS} from telephony.calls c
    where c.org_id = ${orgId} and c.user_id = ${userId}
      and c.status = 'ended' and c.wrapped_up_at is null
      and c.ended_at >= ${since.toISOString()}::timestamptz
      and c.error_code is null and c.direction <> 'internal'
      and (c.first_seen <> 'click' or c.answered)
    order by c.ended_at desc, c.id desc
    limit ${limit}
  `);
  return [...rows];
}

export interface CallFilters {
  readonly from?: Date;
  readonly to?: Date;
  readonly userId?: string;
  readonly direction?: string;
  readonly answered?: boolean;
  readonly orderNo?: string;
  readonly phoneE164?: string;
  readonly phoneRaw?: string;
  readonly orderId?: string;
  readonly customerId?: string;
  readonly cursor?: { readonly occurredAt: string; readonly id: string };
  readonly limit: number;
}

export async function listCalls(
  tx: Tx,
  orgId: string,
  filters: CallFilters,
  scope: SQL,
): Promise<CallRow[]> {
  const where: SQL[] = [sql`c.org_id = ${orgId}`, scope];
  if (filters.from !== undefined) {
    where.push(sql`c.occurred_at >= ${filters.from.toISOString()}::timestamptz`);
  }
  if (filters.to !== undefined) {
    where.push(sql`c.occurred_at < ${filters.to.toISOString()}::timestamptz`);
  }
  if (filters.userId !== undefined) where.push(sql`c.user_id = ${filters.userId}`);
  if (filters.direction !== undefined) where.push(sql`c.direction = ${filters.direction}`);
  if (filters.answered !== undefined) where.push(sql`c.answered = ${filters.answered}`);
  if (filters.orderNo !== undefined) where.push(sql`c.order_no = ${filters.orderNo}`);
  if (filters.orderId !== undefined) where.push(sql`c.order_id = ${filters.orderId}`);
  if (filters.customerId !== undefined) where.push(sql`c.customer_id = ${filters.customerId}`);
  if (filters.phoneE164 !== undefined) {
    where.push(sql`c.customer_phone_e164 = ${filters.phoneE164}`);
  } else if (filters.phoneRaw !== undefined) {
    where.push(sql`(c.from_number = ${filters.phoneRaw} or c.to_number = ${filters.phoneRaw})`);
  }
  if (filters.cursor !== undefined) {
    where.push(
      sql`(c.occurred_at, c.id) < (${filters.cursor.occurredAt}::timestamptz, ${filters.cursor.id}::uuid)`,
    );
  }
  const rows = await tx.execute<CallRow>(sql`
    select ${CALL_COLUMNS} from telephony.calls c
    where ${sql.join(where, sql` and `)}
    order by c.occurred_at desc, c.id desc
    limit ${filters.limit}
  `);
  return [...rows];
}

function fromThisNumber(phone: { readonly e164: string | null; readonly raw: string }): SQL {
  return phone.e164 === null
    ? sql`c.from_number = ${phone.raw}`
    : sql`(c.customer_phone_e164 = ${phone.e164} or c.from_number = ${phone.raw})`;
}

/**
 * The newest inbound call from this number on the connection that nobody has yet and that is
 * still going (ringing or answered, not ended) (D-836): a missed or finished call from the same
 * number is never claimed by the person answering the next one.
 */
export async function unclaimedInbound(
  tx: Tx,
  orgId: string,
  connectionId: string,
  phone: { readonly e164: string | null; readonly raw: string },
  since: Date,
  options: { readonly lock: boolean },
): Promise<CallRow | undefined> {
  const rows = await tx.execute<CallRow>(sql`
    select ${CALL_COLUMNS} from telephony.calls c
    where c.org_id = ${orgId} and c.connection_id = ${connectionId}
      and c.direction in ('inbound', 'unknown') and c.user_id is null
      and c.status in ('ringing', 'answered') and c.ended_at is null
      and c.occurred_at >= ${since.toISOString()}::timestamptz
      and ${fromThisNumber(phone)}
    order by c.occurred_at desc
    limit 1
    ${options.lock ? sql`for update` : sql``}
  `);
  return rows[0];
}

/**
 * An inbound call from this number on the connection, ringing or answered right now, nobody's
 * yet or this person's (the screen pop's reason to name a caller, D-843).
 */
export async function liveInboundFrom(
  tx: Tx,
  orgId: string,
  connectionId: string,
  phone: { readonly e164: string | null; readonly raw: string },
  since: Date,
  userId: string,
): Promise<{ id: string } | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    select c.id from telephony.calls c
    where c.org_id = ${orgId} and c.connection_id = ${connectionId}
      and c.direction in ('inbound', 'unknown')
      and (c.user_id is null or c.user_id = ${userId})
      and c.status in ('ringing', 'answered') and c.ended_at is null
      and c.occurred_at >= ${since.toISOString()}::timestamptz
      and ${fromThisNumber(phone)}
    limit 1
  `);
  return rows[0];
}

// --- webhook bodies -------------------------------------------------------------------------------

export async function storeWebhookEvent(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly connectionId: string;
    readonly event: string;
    readonly envoCallId: string;
    readonly deliveryId: string | null;
    readonly body: unknown;
  },
): Promise<{ readonly id: string | null; readonly duplicate: boolean }> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into telephony.webhook_events
      (org_id, connection_id, event, envo_call_id, delivery_id, body)
    values (${input.orgId}, ${input.connectionId}, ${input.event}, ${input.envoCallId},
            ${input.deliveryId}, ${JSON.stringify(input.body)}::jsonb)
    on conflict (org_id, connection_id, envo_call_id, event) do nothing
    returning id
  `);
  const id = rows[0]?.id ?? null;
  return { id, duplicate: id === null };
}

export interface WebhookEventRow extends Record<string, unknown> {
  readonly id: string;
  readonly connection_id: string;
  readonly event: string;
  readonly body: unknown;
  readonly processed_at: Date | string | null;
}

export async function webhookForProcessing(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<WebhookEventRow | undefined> {
  const rows = await tx.execute<WebhookEventRow>(sql`
    select id, connection_id, event, body, processed_at
    from telephony.webhook_events
    where org_id = ${orgId} and id = ${id}
    for update
  `);
  return rows[0];
}

/**
 * Stored bodies processed before `before` (thirty days, D-851), deleted: the call rows keep what
 * they said. The trigger refuses an unprocessed or younger one.
 */
export async function deleteProcessedWebhooks(
  tx: Tx,
  orgId: string,
  before: Date,
  limit: number,
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from telephony.webhook_events
    where org_id = ${orgId} and id in (
      select id from telephony.webhook_events
      where org_id = ${orgId} and processed_at is not null
        and processed_at < least(${before.toISOString()}::timestamptz, now() - interval '30 days')
      order by processed_at
      limit ${limit}
    )
    returning id
  `);
  return rows.length;
}

export async function markWebhookProcessed(
  tx: Tx,
  orgId: string,
  id: string,
  outcome: string,
): Promise<void> {
  await tx.execute(sql`
    update telephony.webhook_events set processed_at = now(), outcome = ${outcome.slice(0, 40)},
      updated_at = now()
    where org_id = ${orgId} and id = ${id} and processed_at is null
  `);
}
