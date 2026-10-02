import type { WalletRow } from '../accounts/api.js';

/** Wallets a tender may land in, as the server checks them. */
export function walletsFor(
  wallets: readonly WalletRow[],
  branchId: string,
  tender: 'cash' | 'bkash' | 'card',
): readonly WalletRow[] {
  return wallets.filter((wallet) => {
    if (!wallet.isActive) return false;
    if (tender === 'cash') return wallet.subtype === 'wallet_cash' && wallet.branchId === branchId;
    const subtypes = tender === 'bkash' ? ['wallet_bkash', 'wallet_mfs_other'] : ['wallet_bank'];
    return (
      subtypes.includes(wallet.subtype) &&
      (wallet.branchId === null || wallet.branchId === branchId)
    );
  });
}
