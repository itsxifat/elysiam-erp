import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';

import * as repo from './hr.repository.js';

/**
 * HR's service interface for other modules (invariant 12).
 *
 * Deliberately tiny, and the shape is the point: what other modules need from HR is
 * "which employee is this user", and nothing else. M20's targets attach to an employee,
 * M18's productivity metrics are per agent, and the reseller and investor slices have an
 * employee somewhere in their audit trail — all of them need the identity, none of them
 * needs a salary.
 *
 * So there is no `salaryOf`, no `payrollTotals` and no `loanBalance` here. Those are
 * `Payroll`-scoped reads (§6: hr, accounts, org_admin), and an internal interface that
 * handed them over would be a way around that grant: a module that legitimately holds
 * `read Order` could read what the order desk earns. A later milestone that genuinely
 * needs a payroll figure adds a method for that figure, with a comment saying who may
 * call it — not a general accessor.
 *
 * Every method takes the caller's `Tx`, so a read joins the caller's `withOrg`
 * transaction and is bound by the same RLS context.
 */
export interface EmployeeIdentity {
  readonly id: string;
  readonly code: string;
  readonly fullName: string;
  readonly branchId: string | null;
  readonly userId: string | null;
  readonly status: string;
  readonly joinDate: string;
  readonly leaveDate: string | null;
}

export interface HrApi {
  /** The employee record for a login, or undefined for a user who is not staff. */
  employeeForUser(tx: Tx, orgId: string, userId: string): Promise<EmployeeIdentity | undefined>;

  /** One employee's identity by id. No salary, by design — see the file comment. */
  employeeById(tx: Tx, orgId: string, employeeId: string): Promise<EmployeeIdentity | undefined>;
}

/** The Nest injection token for `HrApi`. */
export const HR_API = Symbol('HrApi');

@Injectable()
export class HrApiService implements HrApi {
  async employeeForUser(
    tx: Tx,
    orgId: string,
    userId: string,
  ): Promise<EmployeeIdentity | undefined> {
    const row = await repo.employeeByUser(tx, orgId, userId);
    return row === undefined ? undefined : identity(row);
  }

  async employeeById(
    tx: Tx,
    orgId: string,
    employeeId: string,
  ): Promise<EmployeeIdentity | undefined> {
    const row = await repo.employeeById(tx, orgId, employeeId);
    return row === undefined ? undefined : identity(row);
  }
}

function identity(row: repo.EmployeeRow): EmployeeIdentity {
  return {
    id: row.id,
    code: row.code,
    fullName: row.full_name,
    branchId: row.branch_id,
    userId: row.user_id,
    status: row.status,
    joinDate: row.join_date,
    leaveDate: row.leave_date,
  };
}
