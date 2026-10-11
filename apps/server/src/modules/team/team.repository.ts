import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * The team module's SQL (M41, D-713, D-714): `team.presence` and `team.desk_profiles`, and the
 * one global read a desk profile needs (is that stock location this brand's).
 *
 * Every query runs inside the caller's `withOrg` transaction, so RLS bounds it to the brand
 * whatever the WHERE says; the `org_id` in each WHERE is the second lock, not the only one.
 * People (names, roles) are not read here: they come from `IamApi` (invariant 12).
 */

export interface PresenceRow extends Record<string, unknown> {
  readonly user_id: string;
  readonly last_seen_at: Date | string;
  readonly last_active_at: Date | string | null;
  readonly state: 'active' | 'idle';
  readonly paused: boolean;
  readonly paused_at: Date | string | null;
}

export interface DeskProfileRow extends Record<string, unknown> {
  readonly user_id: string;
  readonly work_types: readonly string[];
  readonly hub_location_id: string | null;
  readonly updated_by: string;
  readonly updated_at: Date | string;
}

export async function transactionNow(tx: Tx): Promise<Date> {
  const [row] = await tx.execute<{ now: Date | string }>(sql`select now() as now`);
  if (row === undefined) throw new Error('the database did not say what time it is');
  return new Date(row.now);
}

/** One person's presence, locked so two tabs reporting at once are applied one after the other. */
export async function presenceForUpdate(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<PresenceRow | undefined> {
  const rows = await tx.execute<PresenceRow>(sql`
    select user_id, last_seen_at, last_active_at, state, paused, paused_at
    from team.presence where org_id = ${orgId} and user_id = ${userId}
    for update
  `);
  return rows[0];
}

/** Write a person's presence: the first report inserts, every later one updates. */
export async function savePresence(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly userId: string;
    readonly lastSeenAt: Date;
    readonly lastActiveAt: Date | null;
    readonly state: 'active' | 'idle';
    readonly paused: boolean;
    readonly pausedAt: Date | null;
  },
): Promise<void> {
  const lastActive = input.lastActiveAt === null ? null : input.lastActiveAt.toISOString();
  const pausedAt = input.pausedAt === null ? null : input.pausedAt.toISOString();
  await tx.execute(sql`
    insert into team.presence
      (org_id, user_id, last_seen_at, last_active_at, state, paused, paused_at)
    values (
      ${input.orgId}, ${input.userId}, ${input.lastSeenAt.toISOString()}::timestamptz,
      ${lastActive}::timestamptz, ${input.state}, ${input.paused}, ${pausedAt}::timestamptz
    )
    on conflict (org_id, user_id) do update set
      last_seen_at = excluded.last_seen_at,
      last_active_at = excluded.last_active_at,
      state = excluded.state,
      paused = excluded.paused,
      paused_at = excluded.paused_at,
      updated_at = now()
  `);
}

/** Every presence row in the brand. Small: one per person who ever reported. */
export async function allPresence(tx: Tx, orgId: string): Promise<PresenceRow[]> {
  const rows = await tx.execute<PresenceRow>(sql`
    select user_id, last_seen_at, last_active_at, state, paused, paused_at
    from team.presence where org_id = ${orgId}
  `);
  return [...rows];
}

export async function allDeskProfiles(tx: Tx, orgId: string): Promise<DeskProfileRow[]> {
  const rows = await tx.execute<DeskProfileRow>(sql`
    select user_id, work_types, hub_location_id, updated_by, updated_at
    from team.desk_profiles where org_id = ${orgId}
  `);
  return [...rows];
}

export async function deskProfileOf(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<DeskProfileRow | undefined> {
  const rows = await tx.execute<DeskProfileRow>(sql`
    select user_id, work_types, hub_location_id, updated_by, updated_at
    from team.desk_profiles where org_id = ${orgId} and user_id = ${userId}
  `);
  return rows[0];
}

export async function deskProfileForUpdate(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<DeskProfileRow | undefined> {
  const rows = await tx.execute<DeskProfileRow>(sql`
    select user_id, work_types, hub_location_id, updated_by, updated_at
    from team.desk_profiles where org_id = ${orgId} and user_id = ${userId}
    for update
  `);
  return rows[0];
}

export async function saveDeskProfile(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly userId: string;
    readonly workTypes: readonly string[];
    readonly hubLocationId: string | null;
    readonly updatedBy: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into team.desk_profiles (org_id, user_id, work_types, hub_location_id, updated_by)
    values (${input.orgId}, ${input.userId}, ${sql.param([...input.workTypes])}::text[],
            ${input.hubLocationId}::uuid, ${input.updatedBy})
    on conflict (org_id, user_id) do update set
      work_types = excluded.work_types,
      hub_location_id = excluded.hub_location_id,
      updated_by = excluded.updated_by,
      updated_at = now()
  `);
}

/**
 * Is this an active stock location of the brand that orders can ship from (a warehouse or a
 * showroom)? `org` is global (§5), so this is no other module's table.
 */
export async function isHubLocation(tx: Tx, orgId: string, locationId: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from org.locations
    where org_id = ${orgId} and id = ${locationId} and is_active
      and kind::text in ('warehouse', 'showroom')
  `);
  return rows.length > 0;
}
