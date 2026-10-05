import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from '../columns.js';
import { users } from '../iam/index.js';
import { organizations } from '../org/index.js';

/**
 * Packing (M35b, D-554): the scanner phones staff pack parcels with.
 *
 * A tenant table with the full treatment (invariant 4). M38b's scan-to-pack builds on it.
 */
export const packing = pgSchema('packing');

/**
 * A scanner device's sign-in (D-554): the old site's 30-day bearer token, kept as a SHA-256
 * and revocable, for one staff member in one brand. The token itself carries the brand's id
 * (`sdt_<org id>_…`) so it is looked up inside that brand only. The person's roles are read
 * again on every request, so a deactivated account or a role taken away stops the phone at
 * once; revoking ends the device whatever its expiry says.
 */
export const scannerDevices = packing.table(
  'scanner_devices',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    label: text('label').notNull(),
    tokenSha256: text('token_sha256').notNull(),
    /** `password` (signed in on the phone) or `console` (paired from a signed-in console). */
    via: text('via').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedBy: text('revoked_by'),
    ...timestamps,
  },
  (table) => [
    unique('scanner_devices_org_id_id_key').on(table.orgId, table.id),
    index('scanner_devices_org_idx').on(table.orgId),
    index('scanner_devices_org_user_idx').on(table.orgId, table.userId, table.createdAt),
    uniqueIndex('scanner_devices_token_idx').on(table.tokenSha256),
    check('scanner_devices_label_length', sql`length(${table.label}) between 1 and 80`),
    check('scanner_devices_token_shape', sql`${table.tokenSha256} ~ '^[0-9a-f]{64}$'`),
    check('scanner_devices_via', sql`${table.via} in ('password', 'console')`),
    check(
      'scanner_devices_revocation_complete',
      sql`(${table.revokedAt} is null) = (${table.revokedBy} is null)`,
    ),
    check('scanner_devices_expiry', sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);
