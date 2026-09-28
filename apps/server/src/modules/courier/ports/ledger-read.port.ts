import type { Tx } from '@elysium/db';
import type { AccountSubtype, PostingAccount } from '@elysium/domain';

/**
 * The two ledger reads this module needs (invariant 12).
 *
 * `LedgerApi` is the ledger's service interface and it has exactly two methods — `post`
 * and `reverse` — because that is all any module has needed so far. Posting the
 * settlement journals needs two things it cannot provide, and neither is a write:
 *
 * 1. **Which account is this org's `courier_receivable`.** §7's journals name accounts by
 *    subtype and the chart-of-accounts template seeds all forty (D-084). Resolving one
 *    means reading `ledger.accounts`, which is the ledger's table. `inventory.api.ts`
 *    has the identical need and answers it with a private helper over its own
 *    repository — a courier-module copy of that query would be this module reading
 *    another module's tables, which invariant 12 does not allow.
 * 2. **How much is each courier holding.** The COD reconciliation report's "outstanding"
 *    column is Σ debit − Σ credit on `courier_receivable` per courier party, over
 *    `ledger.journal_lines`. Derived on every read, deliberately: a maintained
 *    `receivable_poisha` column drifts the first time a journal posts by a path that
 *    forgot to update it, and nobody finds out until a courier disputes a statement.
 *
 * Both join the caller's transaction, so a settlement's reads and writes see one
 * consistent picture. The INTEGRATION notes ask for these two methods on
 * `ledger.api.ts`; the ledger's `reports.service.ts` already computes the second for its
 * party-balances report, so the implementation is a move rather than new arithmetic.
 */
export interface LedgerReadPort {
  /**
   * One of the chart's system accounts, by subtype (§7, D-084).
   *
   * Null when the org's chart has no such account, which means the chart is broken — the
   * template seeds all forty. The caller says so rather than posting the value somewhere
   * else.
   */
  accountBySubtype(tx: Tx, orgId: string, subtype: AccountSubtype): Promise<PostingAccount | null>;

  /**
   * Σ debit − Σ credit on `courier_receivable`, per courier party, as of a business date.
   *
   * Keyed by `party_id`, which is `sales.couriers.id` — the same party §7's delivery and
   * settlement journals name, so "how much is Steadfast holding of ours" is answerable
   * by construction rather than by reconciliation.
   */
  courierReceivables(tx: Tx, orgId: string, asOf: string): Promise<ReadonlyMap<string, bigint>>;
}

export const LEDGER_READ_PORT = Symbol('LedgerReadPort');
