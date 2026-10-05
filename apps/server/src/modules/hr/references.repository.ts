import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * What HR holds that keeps a branch open (M39a, D-633): people still employed there, active
 * or suspended. A branch with staff on its books is not switched off; move them first.
 */
export async function employeesAtBranch(tx: Tx, orgId: string, branchId: string): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from hr.employees
    where org_id = ${orgId} and branch_id = ${branchId} and status in ('active', 'suspended')
  `);
  return rows[0]?.n ?? 0;
}
