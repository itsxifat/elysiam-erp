import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';
import { isAccountSubtype, subtypeInfo, type PostingAccount } from '@elysium/domain';

import * as repo from './wallets.repository.js';

/**
 * The wallets module's service interface for other modules (invariant 12).
 *
 * One method, because one question is all anything outside this module has needed: a
 * settlement's net lands in a wallet (§7's "Dr W") and the posting has to name that
 * wallet's **ledger account**.
 *
 * ## Why `WalletsService.list` cannot answer it
 *
 * `list` takes an `ActiveContext` and an HTTP request, opens its own `withOrg`, and
 * returns a view with a **derived balance**. All three are wrong here. A posting has to
 * join the *caller's* transaction — the settlement rows, the journals and the wallet
 * movement commit together or not at all — a worker has no request to read a scope off,
 * and what a posting needs is the account's id, subtype and branch, not its balance.
 *
 * So this is the same arrangement `inventory.api.ts` and `ledger.api.ts` already have:
 * a thin interface over the module's own repository, taking `tx` and a plain org id.
 */
export interface WalletsApi {
  /**
   * The ledger account behind a wallet, or null.
   *
   * One answer for three different refusals — no such wallet, another org's wallet, a
   * deactivated wallet or account — and that is deliberate. Distinguishing them would
   * make this an existence oracle for another branch's tills, and the caller's only
   * sensible reaction to any of them is the same: refuse before the journal exists.
   *
   * A non-wallet account is refused too. The `wallets.wallets` row points at a ledger
   * account, and if somebody re-pointed one at, say, sales revenue, a settlement would
   * "land" in an income account and the trial balance would still be zero.
   */
  walletAccount(tx: Tx, orgId: string, walletId: string): Promise<PostingAccount | null>;
}

/** The Nest injection token for `WalletsApi`. */
export const WALLETS_API = Symbol('WalletsApi');

@Injectable()
export class WalletsApiService implements WalletsApi {
  async walletAccount(tx: Tx, orgId: string, walletId: string): Promise<PostingAccount | null> {
    const wallet = await repo.walletById(tx, orgId, walletId);
    if (wallet === undefined) return null;
    if (!wallet.is_active || !wallet.account_is_active) return null;
    if (!isAccountSubtype(wallet.subtype) || !subtypeInfo(wallet.subtype).wallet) return null;
    return {
      accountId: wallet.ledger_account_id,
      subtype: wallet.subtype,
      // The wallet row's branch, which migration 0029's trigger holds equal to the
      // account's. A posting whose line named a different branch than its account is
      // refused by `assertAccounts`, so taking the copy is only safe *because* the
      // database keeps the two the same.
      branchId: wallet.branch_id,
    };
  }
}
