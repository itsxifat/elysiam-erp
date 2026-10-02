import { describe, expect, it } from 'vitest';

import type { WalletRow } from '../accounts/api.js';
import { walletsFor } from './logic.js';
import { SETTINGS_TABS } from './tabs.js';
import { settingsEn } from './messages.js';

/**
 * The settings screens' pure parts (D-394): which wallets each till tender may use, and that
 * every tab has a label.
 */

function wallet(overrides: Partial<WalletRow>): WalletRow {
  return {
    id: 'w',
    ledgerAccountId: 'a',
    code: '1000',
    name: 'Wallet',
    subtype: 'wallet_cash',
    branchId: null,
    provider: null,
    accountRefMasked: null,
    requiresDailyClosing: false,
    isActive: true,
    balancePoisha: '0',
    ...overrides,
  };
}

describe('the register form offers what the server accepts', () => {
  const wallets = [
    wallet({ id: 'cash-a', subtype: 'wallet_cash', branchId: 'A' }),
    wallet({ id: 'cash-b', subtype: 'wallet_cash', branchId: 'B' }),
    wallet({ id: 'cash-org', subtype: 'wallet_cash', branchId: null }),
    wallet({ id: 'bkash-org', subtype: 'wallet_bkash', branchId: null }),
    wallet({ id: 'nagad-a', subtype: 'wallet_mfs_other', branchId: 'A' }),
    wallet({ id: 'bank-b', subtype: 'wallet_bank', branchId: 'B' }),
    wallet({ id: 'bank-org', subtype: 'wallet_bank', branchId: null }),
    wallet({ id: 'bank-closed', subtype: 'wallet_bank', branchId: null, isActive: false }),
  ];
  const ids = (tender: 'cash' | 'bkash' | 'card') =>
    walletsFor(wallets, 'A', tender).map((entry) => entry.id);

  it('takes cash only from the branch’s own hand-cash wallet', () => {
    expect(ids('cash')).toEqual(['cash-a']);
  });

  it('takes bKash from a mobile wallet of the branch or the brand', () => {
    expect(ids('bkash')).toEqual(['bkash-org', 'nagad-a']);
  });

  it('takes card into an active bank wallet of the branch or the brand', () => {
    expect(ids('card')).toEqual(['bank-org']);
  });
});

describe('the settings tabs', () => {
  it('each has an English label and a distinct path', () => {
    for (const tab of SETTINGS_TABS) expect(settingsEn[tab.labelKey]).toBeTruthy();
    expect(new Set(SETTINGS_TABS.map((tab) => tab.path)).size).toBe(SETTINGS_TABS.length);
  });
});
