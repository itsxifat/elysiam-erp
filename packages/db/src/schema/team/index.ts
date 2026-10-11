import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { timestamps } from '../columns.js';
import { users } from '../iam/index.js';
import { locations, organizations } from '../org/index.js';

/**
 * The people at the desks (M41, D-713, D-714): who is working in the ERP right now, and what
 * each person may be offered.
 *
 * Its own schema and module (`team`), because presence and desk profiles are about people, not
 * orders: the inbox (M42) offers conversations to the same people by the same rules. The orders
 * module reads them only through `TeamApi` (invariant 12).
 *
 * Tenant tables with the full treatment (invariant 4): `org_id NOT NULL`, RLS ENABLE and FORCE
 * with the standard policy (the M41 policies migration), and the hub location's foreign key
 * carries `org_id` on both sides (D-047). Neither table is ever deleted from: a person who
 * leaves keeps their last presence and profile, which nothing offers work to once their
 * membership is off.
 */
export const team = pgSchema('team');

/**
 * One row per person per brand, upserted by the console's heartbeat (D-713).
 *
 * Two instants and a switch are the facts; "active", "idle" and "away" are derived from them at
 * the moment of asking (`presenceState` in `@elysium/domain/assignment`), so nobody has to write
 * a row for a person to become away. `state` is what the last report said (active or idle),
 * kept only so a report can tell whether it changed something worth auditing.
 */
export const presence = team.table(
  'presence',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** When the last report arrived. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** The last moment the person was known to be at the ERP's tab; null if never. */
    lastActiveAt: timestamp('last_active_at', { withTimezone: true, mode: 'date' }),
    /** What the last report said. */
    state: text('state').notNull(),
    /** "Not taking orders". */
    paused: boolean('paused').notNull().default(false),
    pausedAt: timestamp('paused_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    primaryKey({ name: 'presence_pkey', columns: [table.orgId, table.userId] }),
    index('presence_org_idx').on(table.orgId),
    check('presence_state', sql`${table.state} in ('active', 'idle')`),
    check('presence_paused_at', sql`(${table.paused}) = (${table.pausedAt} is not null)`),
  ],
);

/**
 * A staff member's desk (D-714): the work they may be offered, and the hub they pack at.
 *
 * No row reads as the role's default (`defaultWorkTypes`: a sales agent takes orders and
 * messages, nobody else anything; no hub location means every location).
 */
export const deskProfiles = team.table(
  'desk_profiles',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    workTypes: text('work_types')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    hubLocationId: uuid('hub_location_id'),
    updatedBy: text('updated_by').notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ name: 'desk_profiles_pkey', columns: [table.orgId, table.userId] }),
    index('desk_profiles_org_idx').on(table.orgId),
    foreignKey({
      name: 'desk_profiles_org_id_hub_location_id_fk',
      columns: [table.orgId, table.hubLocationId],
      foreignColumns: [locations.orgId, locations.id],
    }).onDelete('restrict'),
    check(
      'desk_profiles_work_types',
      sql`${table.workTypes} <@ array['orders', 'messages']::text[]`,
    ),
  ],
);
