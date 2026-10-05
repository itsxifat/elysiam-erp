import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { HR_API, type HrApi, type HrBranchStaff } from '../hr/hr.api.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import { WALLETS_API, type WalletsApi, type WalletsBranchMoney } from '../wallets/wallets.api.js';
import * as refs from './references.repository.js';

/** What still runs at a branch, so it is not switched off yet (D-633). */
export interface BranchHolds {
  /** Tills still switched on there. */
  readonly registers: number;
  readonly openShifts: number;
  /** Wallets of the branch (its hand cash) that still hold money. */
  readonly walletsWithMoney: number;
  /** People employed there, active or suspended. */
  readonly employees: number;
  /** Places at its locations that hold or reserve stock. */
  readonly stockPlaces: number;
}

/**
 * Renaming a branch and switching it off (M39a, D-633). Never deleting one: from its first
 * day ledger lines, wallets, staff, orders and stock name it.
 *
 * Switching off is refused while anything still runs there, each part asked of the module
 * that owns it (invariant 12): its tills and shifts (here), its wallets' money (wallets),
 * its staff (HR) and the stock at its locations (inventory). The code stays: it is in every
 * order number and hand-cash account already made.
 */
@Injectable()
export class BranchAdminService {
  constructor(
    private readonly audit: AuditService,
    @Inject(HR_API) private readonly hr: HrApi & HrBranchStaff,
    @Inject(WALLETS_API) private readonly wallets: WalletsApi & WalletsBranchMoney,
    @Inject(INVENTORY_API) private readonly inventory: InventoryApi,
  ) {}

  async holds(context: ActiveContext, id: string) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const branch = await refs.lockBranch(tx, context.orgId, id);
      if (branch === undefined) throw notFound();
      const holds = await this.holdsOf(tx, context.orgId, id);
      return {
        id,
        code: branch.code,
        name: branch.name,
        isActive: branch.is_active,
        holds,
        canDeactivate: branch.is_active && nothingHeld(holds),
      };
    });
  }

  async update(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    patch: { readonly name?: string | undefined; readonly isActive?: boolean | undefined },
  ) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const branch = await refs.lockBranch(tx, context.orgId, id);
      if (branch === undefined) throw notFound();
      if (patch.isActive === false && branch.is_active) {
        const holds = await this.holdsOf(tx, context.orgId, id);
        if (!nothingHeld(holds)) {
          throw new ConflictException({
            code: 'BRANCH_IN_USE',
            message: `${branch.name} still has ${describeHolds(holds)}. Close or move them first; a branch is switched off only when nothing runs there.`,
          });
        }
      }
      await refs.updateBranch(tx, context.orgId, id, patch);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'org.branch.updated',
        entityType: 'Branch',
        entityId: id,
        before: { name: branch.name, isActive: branch.is_active },
        after: { ...patch },
        requestId: context.requestId,
        request,
      });
      return { id, name: patch.name ?? branch.name, isActive: patch.isActive ?? branch.is_active };
    });
  }

  private async holdsOf(tx: Tx, orgId: string, branchId: string): Promise<BranchHolds> {
    const tills = await refs.tillsAtBranch(tx, orgId, branchId);
    return {
      registers: tills.registers,
      openShifts: tills.openShifts,
      walletsWithMoney: await this.wallets.walletsHoldingMoney(tx, orgId, branchId),
      employees: await this.hr.employeesAtBranch(tx, orgId, branchId),
      stockPlaces: await this.inventory.stockAtBranch(tx, orgId, branchId),
    };
  }
}

function nothingHeld(holds: BranchHolds): boolean {
  return Object.values(holds).every((count) => count === 0);
}

function describeHolds(holds: BranchHolds): string {
  const parts = [
    holds.registers > 0 ? `${String(holds.registers)} till(s) switched on` : null,
    holds.openShifts > 0 ? `${String(holds.openShifts)} open shift(s)` : null,
    holds.walletsWithMoney > 0 ? `${String(holds.walletsWithMoney)} wallet(s) with money` : null,
    holds.employees > 0 ? `${String(holds.employees)} employee(s)` : null,
    holds.stockPlaces > 0 ? `stock at ${String(holds.stockPlaces)} place(s)` : null,
  ].filter((part): part is string => part !== null);
  return parts.join(', ');
}

function notFound(): NotFoundException {
  return new NotFoundException({ code: 'NOT_FOUND', message: 'No such branch.' });
}
