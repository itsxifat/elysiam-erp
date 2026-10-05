import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * The SQL behind the packing scanner's devices (M35b, D-554). Its own schema only; the orders
 * and the catalog are asked through their interfaces. Every statement runs inside the
 * caller's `withOrg()`.
 */

export interface DeviceRow extends Record<string, unknown> {
  readonly id: string;
  readonly user_id: string;
  readonly label: string;
  readonly via: 'password' | 'console';
  readonly last_used_at: Date | string | null;
  readonly expires_at: Date | string;
  readonly revoked_at: Date | string | null;
  readonly revoked_by: string | null;
  readonly created_at: Date | string;
}

const COLUMNS = sql`id, user_id, label, via, last_used_at, expires_at, revoked_at, revoked_by, created_at`;

export async function insertDevice(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly userId: string;
    readonly label: string;
    readonly tokenSha256: string;
    readonly via: 'password' | 'console';
    readonly days: number;
  },
): Promise<DeviceRow> {
  const rows = await tx.execute<DeviceRow>(sql`
    insert into packing.scanner_devices (org_id, user_id, label, token_sha256, via, expires_at)
    values (${input.orgId}, ${input.userId}, ${input.label}, ${input.tokenSha256}, ${input.via},
            now() + make_interval(days => ${input.days}))
    returning ${COLUMNS}
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('a scanner device was not written');
  return row;
}

export async function deviceByToken(
  tx: Tx,
  orgId: string,
  tokenSha256: string,
): Promise<DeviceRow | undefined> {
  const rows = await tx.execute<DeviceRow>(sql`
    select ${COLUMNS} from packing.scanner_devices
    where org_id = ${orgId} and token_sha256 = ${tokenSha256}
  `);
  return rows[0];
}

export async function deviceById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<DeviceRow | undefined> {
  const rows = await tx.execute<DeviceRow>(sql`
    select ${COLUMNS} from packing.scanner_devices where org_id = ${orgId} and id = ${id}
    for update
  `);
  return rows[0];
}

export async function devices(
  tx: Tx,
  orgId: string,
  userId: string | null,
): Promise<(DeviceRow & { readonly user_name: string | null })[]> {
  const rows = await tx.execute<DeviceRow & { readonly user_name: string | null }>(sql`
    select d.id, d.user_id, d.label, d.via, d.last_used_at, d.expires_at, d.revoked_at,
           d.revoked_by, d.created_at, null::text as user_name
    from packing.scanner_devices d
    where d.org_id = ${orgId} ${userId === null ? sql`` : sql`and d.user_id = ${userId}`}
    order by d.created_at desc
    limit 200
  `);
  return [...rows];
}

export async function revokeDevice(
  tx: Tx,
  orgId: string,
  id: string,
  by: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update packing.scanner_devices set revoked_at = now(), revoked_by = ${by}, updated_at = now()
    where org_id = ${orgId} and id = ${id} and revoked_at is null
    returning id
  `);
  return rows.length === 1;
}

/** A device's last use, written at most every five minutes. */
export async function touchDevice(tx: Tx, orgId: string, id: string): Promise<void> {
  await tx.execute(sql`
    update packing.scanner_devices set last_used_at = now()
    where org_id = ${orgId} and id = ${id}
      and (last_used_at is null or last_used_at < now() - interval '5 minutes')
  `);
}
