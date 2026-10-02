/**
 * Account classes and system subtypes (architecture §7 "Chart of accounts").
 *
 * The subtype is what posting rules and reports reason about; the account
 * code is what a person reads. A subtype fixes the account's class, which side
 * its balance normally sits on, and whether every line on it must name a
 * party. The database mirrors these lists (`ledger.account_subtype`), and a
 * test holds the two in step.
 *
 * Adding a subtype needs the §7 table and a decisions.md row
 * (.claude/rules/money-and-ledger.md).
 */

import { sub, type Poisha } from '../money/index.js';

export const ACCOUNT_CLASSES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountClass = (typeof ACCOUNT_CLASSES)[number];

/** The counterparty on a ledger line (§2 glossary). */
export const PARTY_TYPES = [
  'supplier',
  'courier',
  'reseller',
  'investor',
  'employee',
  'lender',
] as const;
export type PartyType = (typeof PARTY_TYPES)[number];

export type NormalBalance = 'debit' | 'credit';

export interface SubtypeInfo {
  readonly class: AccountClass;
  readonly normalBalance: NormalBalance;
  /** Every line on an account of this subtype must name a party of this type. */
  readonly party: PartyType | null;
  /** A cash-like account a cash book can be drawn for (§2 "Wallet"). */
  readonly wallet: boolean;
  /**
   * The balance reveals purchase cost, WAC or a supplier balance (§6
   * protected fields, invariant 5), so ledger reports withhold it from roles
   * without `read:cost` (D-085).
   */
  readonly cost: boolean;
}

const asset = (extra: Partial<SubtypeInfo> = {}): SubtypeInfo => ({
  class: 'asset',
  normalBalance: 'debit',
  party: null,
  wallet: false,
  cost: false,
  ...extra,
});
const liability = (extra: Partial<SubtypeInfo> = {}): SubtypeInfo => ({
  class: 'liability',
  normalBalance: 'credit',
  party: null,
  wallet: false,
  cost: false,
  ...extra,
});
const equity = (extra: Partial<SubtypeInfo> = {}): SubtypeInfo => ({
  class: 'equity',
  normalBalance: 'credit',
  party: null,
  wallet: false,
  cost: false,
  ...extra,
});
const income = (extra: Partial<SubtypeInfo> = {}): SubtypeInfo => ({
  class: 'income',
  normalBalance: 'credit',
  party: null,
  wallet: false,
  cost: false,
  ...extra,
});
const expense = (extra: Partial<SubtypeInfo> = {}): SubtypeInfo => ({
  class: 'expense',
  normalBalance: 'debit',
  party: null,
  wallet: false,
  cost: false,
  ...extra,
});

/** §7's system subtypes, plus `operating_expense` for the operating categories (D-084). */
export const ACCOUNT_SUBTYPES = {
  // Assets
  wallet_cash: asset({ wallet: true }),
  wallet_bank: asset({ wallet: true }),
  wallet_bkash: asset({ wallet: true }),
  wallet_mfs_other: asset({ wallet: true }),
  courier_receivable: asset({ party: 'courier' }),
  inventory: asset({ cost: true }),
  goods_in_transit: asset({ cost: true }),
  supplier_advance: asset({ party: 'supplier', cost: true }),
  employee_loan_receivable: asset({ party: 'employee' }),
  other_receivable: asset(),

  // Liabilities
  supplier_payable: liability({ party: 'supplier', cost: true }),
  reseller_payable: liability({ party: 'reseller' }),
  salary_payable: liability(),
  investor_payable: liability({ party: 'investor' }),
  loan_payable: liability({ party: 'lender' }),
  customer_advance: liability(),
  other_payable: liability(),

  // Equity
  owner_capital: equity(),
  investor_capital: equity({ party: 'investor' }),
  retained_earnings: equity(),
  // Distributions reduce equity, so the balance normally sits on the debit side.
  profit_distribution: equity({ normalBalance: 'debit' }),

  // Income
  sales_revenue: income(),
  // Contra-revenue: a discount reduces revenue, so it is debit-normal.
  sales_discounts: income({ normalBalance: 'debit' }),
  delivery_charge_income: income(),
  other_income: income(),
  inventory_adjustment_gain: income({ cost: true }),

  // Expenses
  cogs: expense({ cost: true }),
  courier_charges: expense(),
  return_charges: expense(),
  ad_spend: expense(),
  salary_expense: expense(),
  bonus_expense: expense(),
  interest_expense: expense(),
  inventory_writeoff: expense({ cost: true }),
  purchase_price_variance: expense({ cost: true }),
  cash_over_short: expense(),
  bank_charges: expense(),
  operating_expense: expense(),

  /**
   * The balancing figure when a brand's books are opened mid-life (M14a, D-213).
   *
   * Its own account rather than `retained_earnings`, because the two are different
   * facts: retained earnings is what the business has actually earned, and this is
   * "what we were holding on the day we started recording". An accountant clears this
   * to the real equity accounts once they have agreed the opening figures, and they can
   * only do that if it is visible.
   *
   * Last in this list, not beside the other equity subtypes, because
   * `ledger-sync.test.ts` compares it to the database enum in order and
   * `ALTER TYPE … ADD VALUE` appends.
   */
  opening_equity: equity(),
} as const satisfies Record<string, SubtypeInfo>;

export type AccountSubtype = keyof typeof ACCOUNT_SUBTYPES;

export const ACCOUNT_SUBTYPE_NAMES = Object.keys(ACCOUNT_SUBTYPES) as AccountSubtype[];

export function subtypeInfo(subtype: AccountSubtype): SubtypeInfo {
  return ACCOUNT_SUBTYPES[subtype];
}

export function isAccountSubtype(value: string): value is AccountSubtype {
  return Object.hasOwn(ACCOUNT_SUBTYPES, value);
}

export const WALLET_SUBTYPES = ACCOUNT_SUBTYPE_NAMES.filter(
  (name) => ACCOUNT_SUBTYPES[name].wallet,
);

/** Subtypes whose balances are cost information (D-085). */
export const COST_SUBTYPES = ACCOUNT_SUBTYPE_NAMES.filter((name) => ACCOUNT_SUBTYPES[name].cost);

/** Subtypes that require a party on every line, and which party. */
export const PARTY_SUBTYPES = ACCOUNT_SUBTYPE_NAMES.filter(
  (name) => ACCOUNT_SUBTYPES[name].party !== null,
);

/**
 * `normalBalanceOf` for report aggregates: plain `bigint`, with no ±9e15 bound.
 *
 * `Poisha` refuses anything past 9e15 as a sanity check on a single amount.
 * A *sum* of stored, balanced journals is not an amount anyone typed, and a
 * report that throws on one would be a report nobody can open again — the
 * journals behind it are immutable (M03 security review M2).
 */
export function aggregateBalanceOf(
  normalBalance: NormalBalance,
  debitPoisha: bigint,
  creditPoisha: bigint,
): bigint {
  return normalBalance === 'debit' ? debitPoisha - creditPoisha : creditPoisha - debitPoisha;
}

/**
 * A balance expressed on the account's normal side: positive means the
 * account holds what it normally holds (cash in a wallet, money owed on a
 * payable), negative means it has gone the other way.
 */
export function normalBalanceOf(
  normalBalance: NormalBalance,
  debitPoisha: Poisha,
  creditPoisha: Poisha,
): Poisha {
  return normalBalance === 'debit'
    ? sub(debitPoisha, creditPoisha)
    : sub(creditPoisha, debitPoisha);
}
