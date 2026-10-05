import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';
import { isAccountSubtype, subtypeInfo, type PostingAccount } from '@elysium/domain';

import { walletsHttpError } from './wallets.errors.js';
import * as repo from './wallets.repository.js';
import * as references from './references.repository.js';

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

  /**
   * Active wallets by their ledger account code (`1100`, `1010-HQ`), with the account a
   * posting names — how M14a's wallet balance file names a wallet, because the code is
   * what an accountant sees in the chart. A code that is not an active wallet, or not a
   * wallet at all, is absent.
   */
  walletsByAccountCodes(
    tx: Tx,
    orgId: string,
    codes: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly walletId: string; readonly account: PostingAccount }>>;

  /**
   * A wallet the system itself needs, created on first use (M34, D-526): the SSLCommerz
   * clearing wallet the website's online payments land in, until the gateway settles them to
   * the bank (a wallet transfer). Org-level, never a branch's. Its ledger account is created
   * with the given code if there is none; a code that already names a different kind of
   * account is refused rather than reused.
   */
  ensureSystemWallet(
    tx: Tx,
    orgId: string,
    spec: {
      readonly code: string;
      readonly name: string;
      readonly subtype: 'wallet_bank' | 'wallet_mfs_other';
      readonly provider: string;
    },
  ): Promise<PostingAccount>;
}

/** The Nest injection token for `WalletsApi`. */
export const WALLETS_API = Symbol('WalletsApi');

/** M39a (D-633): a branch's wallets that still hold money. */
export interface WalletsBranchMoney {
  walletsHoldingMoney(tx: Tx, orgId: string, branchId: string): Promise<number>;
}

@Injectable()
export class WalletsApiService implements WalletsApi, WalletsBranchMoney {
  walletsHoldingMoney(tx: Tx, orgId: string, branchId: string): Promise<number> {
    return references.walletsHoldingMoney(tx, orgId, branchId);
  }

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

  async walletsByAccountCodes(
    tx: Tx,
    orgId: string,
    codes: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly walletId: string; readonly account: PostingAccount }>> {
    const found = new Map<string, { walletId: string; account: PostingAccount }>();
    for (const wallet of await repo.walletsByAccountCodes(tx, orgId, codes)) {
      if (!wallet.is_active || !wallet.account_is_active) continue;
      if (!isAccountSubtype(wallet.subtype) || !subtypeInfo(wallet.subtype).wallet) continue;
      found.set(wallet.code, {
        walletId: wallet.id,
        account: {
          accountId: wallet.ledger_account_id,
          subtype: wallet.subtype,
          branchId: wallet.branch_id,
        },
      });
    }
    return found;
  }

  async ensureSystemWallet(
    tx: Tx,
    orgId: string,
    spec: {
      readonly code: string;
      readonly name: string;
      readonly subtype: 'wallet_bank' | 'wallet_mfs_other';
      readonly provider: string;
    },
  ): Promise<PostingAccount> {
    // One first setup at a time per brand and provider, so two at once cannot both create one
    // (ledger re-audit N-c).
    await repo.lockSystemWallet(tx, orgId, spec.provider);
    // The provider's own wallet, whatever code it was given: never a staff wallet that
    // happens to sit at the preferred code (M34 ledger audit W4).
    const mine = await repo.systemWalletByProvider(tx, orgId, spec.provider, spec.subtype);
    if (mine !== undefined) {
      return { accountId: mine.ledger_account_id, subtype: spec.subtype, branchId: null };
    }
    const info = subtypeInfo(spec.subtype);
    // The preferred code, else the next free one after it in its ten (1120, 1121 … 1129).
    const preferred = Number.parseInt(spec.code, 10);
    const candidates = Number.isNaN(preferred)
      ? [spec.code]
      : Array.from({ length: 10 - (preferred % 10) }, (_, step) => String(preferred + step));
    let account: { id: string } | undefined;
    for (const code of candidates) {
      account = await repo.insertLedgerAccount(tx, {
        orgId,
        code,
        name: spec.name,
        subtype: spec.subtype,
        class: info.class,
        normalBalance: info.normalBalance,
        branchId: null,
      });
      if (account !== undefined) break;
    }
    if (account === undefined) {
      throw walletsHttpError(
        'LEDGER_ACCOUNT_INVALID',
        `Account codes ${candidates.join(', ')} are all taken; free one in the chart of accounts for the ${spec.name} wallet.`,
      );
    }
    await repo.insertWalletIfMissing(tx, {
      orgId,
      ledgerAccountId: account.id,
      branchId: null,
      provider: spec.provider,
      accountRefMasked: null,
      requiresDailyClosing: false,
    });
    return { accountId: account.id, subtype: spec.subtype, branchId: null };
  }
}
