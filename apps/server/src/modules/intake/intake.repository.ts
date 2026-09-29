import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * Every statement the intake module runs (tenancy rules: raw SQL in repositories only,
 * parameterised, inside the caller's `withOrg()`).
 *
 * The order itself is not written here. It is `ORDERS_API.createOrder`'s, in the same
 * transaction as `completeSubmission` (invariant 12).
 */

export interface SiteKeyRow extends Record<string, unknown> {
  readonly id: string;
  readonly label: string;
  readonly channel: string;
  readonly landing_page_id: string | null;
  readonly key_id: string;
  readonly secret_sha256: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
  readonly created_by: string;
  readonly created_at: string;
}

const SITE_KEY_COLUMNS = sql`k.id, k.label, k.channel, k.landing_page_id, k.key_id, k.secret_sha256,
  k.last_used_at, k.revoked_at, k.created_by, k.created_at`;

export async function siteKeyByKeyId(
  tx: Tx,
  orgId: string,
  keyId: string,
): Promise<SiteKeyRow | undefined> {
  const rows = await tx.execute<SiteKeyRow>(sql`
    select ${SITE_KEY_COLUMNS} from intake.site_keys k
    where k.org_id = ${orgId} and k.key_id = ${keyId}
  `);
  return rows[0];
}

export async function listSiteKeys(tx: Tx, orgId: string): Promise<SiteKeyRow[]> {
  const rows = await tx.execute<SiteKeyRow>(sql`
    select ${SITE_KEY_COLUMNS} from intake.site_keys k
    where k.org_id = ${orgId}
    order by k.revoked_at is not null, k.created_at desc
  `);
  return [...rows];
}

export async function insertSiteKey(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly label: string;
    readonly channel: string;
    readonly landingPageId: string | null;
    readonly keyId: string;
    readonly secretSha256: string;
    readonly createdBy: string;
  },
): Promise<SiteKeyRow> {
  const rows = await tx.execute<SiteKeyRow>(sql`
    insert into intake.site_keys
      (org_id, label, channel, landing_page_id, key_id, secret_sha256, created_by)
    values (${input.orgId}, ${input.label}, ${input.channel}, ${input.landingPageId}::uuid,
            ${input.keyId}, ${input.secretSha256}, ${input.createdBy})
    returning id, label, channel, landing_page_id, key_id, secret_sha256, last_used_at,
              revoked_at, created_by, created_at
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('intake.site_keys insert returned nothing');
  return row;
}

/** Revoke once. A second revoke matches nothing, and the first revoker stays on record. */
export async function revokeSiteKey(
  tx: Tx,
  input: { readonly orgId: string; readonly id: string; readonly revokedBy: string },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update intake.site_keys
    set revoked_at = now(), revoked_by = ${input.revokedBy}, updated_at = now()
    where org_id = ${input.orgId} and id = ${input.id} and revoked_at is null
    returning id
  `);
  return rows.length > 0;
}

export async function siteKeyById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<SiteKeyRow | undefined> {
  const rows = await tx.execute<SiteKeyRow>(sql`
    select ${SITE_KEY_COLUMNS} from intake.site_keys k where k.org_id = ${orgId} and k.id = ${id}
  `);
  return rows[0];
}

export async function touchSiteKey(tx: Tx, orgId: string, id: string): Promise<void> {
  await tx.execute(sql`
    update intake.site_keys set last_used_at = now(), updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

// --- the idempotency record ---------------------------------------------------

export interface SubmissionRow extends Record<string, unknown> {
  readonly id: string;
  readonly request_sha256: string;
  readonly status: string;
  readonly order_id: string | null;
}

export async function submissionFor(
  tx: Tx,
  orgId: string,
  siteKeyId: string,
  idempotencyKey: string,
): Promise<SubmissionRow | undefined> {
  const rows = await tx.execute<SubmissionRow>(sql`
    select s.id, s.request_sha256, s.status, s.order_id
    from intake.submissions s
    where s.org_id = ${orgId} and s.site_key_id = ${siteKeyId}
      and s.idempotency_key = ${idempotencyKey}
  `);
  return rows[0];
}

/** How long a claim may sit `pending` before a retry of the same request may take it over. */
export const STALE_CLAIM_SECONDS = 120;

/**
 * Claim an idempotency key, in one statement.
 *
 * The insert wins or the row already exists; the unique index decides, so two copies of
 * one request cannot both claim it. The `do update` branch is the takeover: a `pending`
 * claim for the **same body** that has sat past `STALE_CLAIM_SECONDS` belonged to a process
 * that died mid-request, and the retry inherits it — same row, same id, which is what keeps
 * Cloudflare's `idempotency_key` stable across the takeover. Any other existing row comes
 * back empty-handed and the caller reads it to decide between replay, conflict and
 * in-flight.
 */
export async function claimSubmission(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly siteKeyId: string;
    readonly idempotencyKey: string;
    readonly requestSha256: string;
  },
): Promise<string | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into intake.submissions (org_id, site_key_id, idempotency_key, request_sha256)
    values (${input.orgId}, ${input.siteKeyId}, ${input.idempotencyKey}, ${input.requestSha256})
    on conflict (org_id, site_key_id, idempotency_key) do update
      set claimed_at = now(), updated_at = now()
      where intake.submissions.status = 'pending'
        and intake.submissions.request_sha256 = excluded.request_sha256
        and intake.submissions.claimed_at < now() - make_interval(secs => ${STALE_CLAIM_SECONDS}::double precision)
    returning id
  `);
  return rows[0]?.id;
}

export async function completeSubmission(
  tx: Tx,
  input: { readonly orgId: string; readonly id: string; readonly orderId: string },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update intake.submissions
    set status = 'completed', order_id = ${input.orderId}, completed_at = now(), updated_at = now()
    where org_id = ${input.orgId} and id = ${input.id} and status = 'pending'
    returning id
  `);
  return rows.length > 0;
}

/**
 * Let go of a claim whose request failed, so the client may retry with the same key.
 *
 * Only a `pending` row: a completed one has an order behind it and is the record that makes
 * a later replay return that order.
 */
export async function releaseSubmission(tx: Tx, orgId: string, id: string): Promise<void> {
  await tx.execute(sql`
    delete from intake.submissions where org_id = ${orgId} and id = ${id} and status = 'pending'
  `);
}
