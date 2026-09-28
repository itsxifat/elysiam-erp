import type { Tx } from '@elysium/db';
import type { PostingAccount } from '@elysium/domain';

/**
 * What this module needs from `modules/wallets` (invariant 12).
 *
 * A settlement's net lands in a wallet (§7's "Dr W"), and this module has to name that
 * wallet's **ledger account** to build the posting. `WalletsService` is the wallets
 * module's public surface and it cannot answer that question in the shape needed here:
 * its `list` takes an `ActiveContext` and an HTTP request, opens its own `withOrg`, and
 * returns a view with a derived balance. A posting has to join the *caller's*
 * transaction — the settlement rows, the journals and the consignment links commit
 * together or not at all — and it needs the account's subtype and branch, not its
 * balance.
 *
 * So this is a narrow port with one method, and the INTEGRATION notes ask for a
 * `wallets.api.ts` that implements it — the same arrangement `inventory.api.ts` already
 * has, and for the same reason: §7 pairs a wallet movement with a journal, and the
 * pairing only holds if one transaction does both.
 */
export interface WalletsPort {
  /**
   * The ledger account behind a wallet, or null when the wallet is not this org's.
   *
   * Refuses an inactive wallet by answering null, exactly as it answers for a wallet
   * that does not exist: a settlement posted into a deactivated bank account is money
   * that reconciles against nothing, and the refusal has to happen before the journal
   * exists. The two cases give one answer because distinguishing them would let a caller
   * enumerate another branch's tills.
   */
  walletAccount(tx: Tx, orgId: string, walletId: string): Promise<PostingAccount | null>;
}

export const WALLETS_PORT = Symbol('WalletsPort');
