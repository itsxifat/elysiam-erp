import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from '../columns.js';
import { orders } from '../orders/index.js';
import { organizations } from '../org/index.js';

/**
 * The public order intake (architecture §23 "Public API", M11).
 *
 * A landing page's server posts an order here with a per-site key, an HMAC over the body
 * and the timestamp, a Cloudflare Turnstile token and an idempotency key. Two tables, and
 * both are about *who may post* and *what they already posted* — the order itself is a
 * `sales.orders` row written through `ORDERS_API` (invariant 12), so nothing here can
 * describe an order differently from the desk.
 *
 * ## No secret is stored, hashed or otherwise usable
 *
 * `site_keys` holds the public key id and `secret_sha256`, and neither is enough to sign a
 * request. The signing secret is **derived** — `HMAC-SHA256(INTAKE_KEY_SECRET, key id)` —
 * so it can be recomputed by the one process holding the master key and by nobody holding
 * a copy of this table. A leaked database dump therefore signs nothing. Storing the
 * secret encrypted would have been the same property with a key to rotate and a column to
 * leak; storing it plain would have made a read replica a forgery kit.
 *
 * `secret_sha256` is the fingerprint of the derived secret at issue time. It exists so a
 * change of master key fails closed: a key issued under the old master derives a different
 * secret now, its fingerprint no longer matches, and the request is refused rather than
 * verified against a secret the site never received.
 *
 * ## The key id carries its org
 *
 * `pk_<org id without dashes>_<random>`. A public request has no session and therefore no
 * org, and `site_keys` is a tenant table under FORCE RLS (invariant 4) — so the org is
 * read off the key id, the lookup runs inside that org's `withOrg()`, and a key id naming
 * another org simply finds nothing there. The alternative, a cross-org lookup table, would
 * be a second exception to §5 for the sake of one index.
 */
export const intake = pgSchema('intake');

export const siteKeys = intake.table(
  'site_keys',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** What the brand calls the site: "Oura Eid landing", "oura-lifestyle.com". */
    label: text('label').notNull(),
    /**
     * The channel an order from this key is filed under (§9).
     *
     * A landing page and a brand's existing website (D-024) are both public forms, and
     * they are reported separately — so the key, not the request, decides which one an
     * order is. A request that could name its own channel could file itself as `phone`.
     */
    channel: text('channel').notNull().default('landing_page'),
    /** §9's `source.landingPageId`, stamped on every order this key posts. */
    landingPageId: uuid('landing_page_id'),
    keyId: text('key_id').notNull(),
    secretSha256: text('secret_sha256').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedBy: text('revoked_by'),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('site_keys_org_id_id_key').on(table.orgId, table.id),
    index('site_keys_org_idx').on(table.orgId),
    uniqueIndex('site_keys_key_id_idx').on(table.keyId),
    check('site_keys_label_length', sql`length(${table.label}) between 1 and 120`),
    check('site_keys_channel', sql`${table.channel} in ('landing_page', 'website')`),
    check('site_keys_key_id_format', sql`${table.keyId} ~ '^pk_[0-9a-f]{32}_[a-z2-7]{20}$'`),
    check('site_keys_secret_sha256_format', sql`${table.secretSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'site_keys_revocation_complete',
      sql`(${table.revokedAt} is null) = (${table.revokedBy} is null)`,
    ),
  ],
);

/**
 * One row per idempotency key a site has used (§23: "an idempotency key is required").
 *
 * Claimed **before** the Turnstile call and completed in the transaction that creates the
 * order. Two reasons it is not simply a unique column on the order:
 *
 * * Turnstile tokens are single-use. A retry of a request that already succeeded carries
 *   the same, now spent, token — so the replay has to be recognised *before* Cloudflare
 *   is asked, or every retry of a good order answers 403.
 * * The Turnstile call is external and cannot run inside a transaction (invariant 6). The
 *   claim is what stops two concurrent copies of one request both reaching Cloudflare and
 *   both creating an order in the gap between the check and the insert.
 *
 * A claim that never completes — the process died mid-request — is taken over after two
 * minutes by a retry carrying the same body, so a crash costs a client a short wait rather
 * than a key it can never use again.
 */
export const submissions = intake.table(
  'submissions',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    siteKeyId: uuid('site_key_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    /** SHA-256 of the raw body. The same key with a different body is a conflict. */
    requestSha256: text('request_sha256').notNull(),
    status: text('status').notNull().default('pending'),
    orderId: uuid('order_id'),
    claimedAt: timestamp('claimed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    unique('submissions_org_id_id_key').on(table.orgId, table.id),
    index('submissions_org_idx').on(table.orgId),
    uniqueIndex('submissions_org_site_key_idx').on(
      table.orgId,
      table.siteKeyId,
      table.idempotencyKey,
    ),
    index('submissions_org_order_idx').on(table.orgId, table.orderId),
    foreignKey({
      name: 'submissions_org_id_site_key_id_fk',
      columns: [table.orgId, table.siteKeyId],
      foreignColumns: [siteKeys.orgId, siteKeys.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'submissions_org_id_order_id_fk',
      columns: [table.orgId, table.orderId],
      foreignColumns: [orders.orgId, orders.id],
    }).onDelete('restrict'),
    check('submissions_idempotency_key_shape', sql`${table.idempotencyKey} ~ '^[!-~]{8,255}$'`),
    check('submissions_request_sha256_format', sql`${table.requestSha256} ~ '^[0-9a-f]{64}$'`),
    check('submissions_status', sql`${table.status} in ('pending', 'completed')`),
    check(
      'submissions_completed_has_order',
      sql`(${table.status} = 'completed') = (${table.orderId} is not null and ${table.completedAt} is not null)`,
    ),
  ],
);
