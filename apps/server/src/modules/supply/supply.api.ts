import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';

import * as repo from './supply.repository.js';

/**
 * The supply module's service interface for other modules (invariant 12).
 *
 * One question so far: M14a's supplier balance file names suppliers by code, and the
 * opening journal names them by id as the party of a payable or an advance (§7). The
 * balances themselves are not here and never will be — a supplier's due is derived from
 * journal lines, which the ledger answers.
 */
export interface SupplyApi {
  /** Supplier ids by code. A code that is no supplier of this brand is absent. */
  suppliersByCodes(
    tx: Tx,
    orgId: string,
    codes: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly id: string; readonly isActive: boolean }>>;

  /**
   * The suppliers among these ids that still exist, held `for key share` until the caller's
   * transaction ends: a supplier delete waits, then finds the journal line naming it (M39a).
   */
  lockSuppliers(tx: Tx, orgId: string, ids: readonly string[]): Promise<ReadonlySet<string>>;
}

/** The Nest injection token for `SupplyApi`. */
export const SUPPLY_API = Symbol('SupplyApi');

@Injectable()
export class SupplyApiService implements SupplyApi {
  async suppliersByCodes(
    tx: Tx,
    orgId: string,
    codes: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly id: string; readonly isActive: boolean }>> {
    const rows = await repo.suppliersByCodes(tx, orgId, codes);
    return new Map(rows.map((row) => [row.code, { id: row.id, isActive: row.is_active }]));
  }

  async lockSuppliers(tx: Tx, orgId: string, ids: readonly string[]) {
    return new Set(await repo.lockSuppliersById(tx, orgId, ids));
  }
}
