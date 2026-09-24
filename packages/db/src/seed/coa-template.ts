/**
 * The chart-of-accounts template every org is seeded from (architecture §7,
 * D-027, D-084).
 *
 * One row per system account, with a stable code. Codes group by class:
 * 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx income, 5xxx expenses.
 * Hand cash is not here: it is one account per branch (`1010-<branch code>`),
 * added by the seed for every branch the org has.
 *
 * `class`, `normalBalance` and `party` repeat what the subtype implies in
 * @elysium/domain (`ACCOUNT_SUBTYPES`); a server test holds the two in step,
 * because this package cannot depend on the domain package's build.
 *
 * D-027 is OPEN: the client's accountant reviews this before go-live. Adding
 * a row is safe (the seed upserts on code); renaming is safe; changing a
 * row's subtype is not — the database refuses it once the account exists.
 */

export type TemplateClass = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export type TemplateParty =
  'supplier' | 'courier' | 'reseller' | 'investor' | 'employee' | 'lender';

export interface TemplateAccount {
  readonly code: string;
  readonly name: string;
  readonly subtype: string;
  readonly class: TemplateClass;
  readonly normalBalance: 'debit' | 'credit';
  readonly party: TemplateParty | null;
}

const row = (
  code: string,
  name: string,
  subtype: string,
  cls: TemplateClass,
  normalBalance: 'debit' | 'credit',
  party: TemplateParty | null = null,
): TemplateAccount => ({ code, name, subtype, class: cls, normalBalance, party });

/** Hand cash, one per branch. */
export const BRANCH_CASH_CODE_PREFIX = '1010';

export const COA_TEMPLATE: readonly TemplateAccount[] = [
  // Assets
  row('1100', 'Bank', 'wallet_bank', 'asset', 'debit'),
  row('1110', 'bKash', 'wallet_bkash', 'asset', 'debit'),
  row('1200', 'Courier receivable', 'courier_receivable', 'asset', 'debit', 'courier'),
  row('1300', 'Inventory', 'inventory', 'asset', 'debit'),
  row('1310', 'Goods in transit', 'goods_in_transit', 'asset', 'debit'),
  row('1400', 'Supplier advances', 'supplier_advance', 'asset', 'debit', 'supplier'),
  row('1500', 'Employee loans', 'employee_loan_receivable', 'asset', 'debit', 'employee'),
  row('1900', 'Other receivables', 'other_receivable', 'asset', 'debit'),

  // Liabilities
  row('2100', 'Supplier payables', 'supplier_payable', 'liability', 'credit', 'supplier'),
  row('2200', 'Reseller payables', 'reseller_payable', 'liability', 'credit', 'reseller'),
  row('2300', 'Salary payable', 'salary_payable', 'liability', 'credit'),
  row('2400', 'Investor payables', 'investor_payable', 'liability', 'credit', 'investor'),
  row('2500', 'Loans payable', 'loan_payable', 'liability', 'credit', 'lender'),
  row('2600', 'Customer advances', 'customer_advance', 'liability', 'credit'),
  row('2900', 'Other payables', 'other_payable', 'liability', 'credit'),

  // Equity
  row('3100', 'Owner capital', 'owner_capital', 'equity', 'credit'),
  row('3200', 'Investor capital', 'investor_capital', 'equity', 'credit', 'investor'),
  row('3300', 'Retained earnings', 'retained_earnings', 'equity', 'credit'),
  row('3400', 'Profit distribution', 'profit_distribution', 'equity', 'debit'),

  // Income
  row('4100', 'Sales revenue', 'sales_revenue', 'income', 'credit'),
  row('4110', 'Sales discounts', 'sales_discounts', 'income', 'debit'),
  row('4200', 'Delivery charge income', 'delivery_charge_income', 'income', 'credit'),
  row('4300', 'Other income', 'other_income', 'income', 'credit'),
  row('4400', 'Inventory adjustment gain', 'inventory_adjustment_gain', 'income', 'credit'),

  // Expenses
  row('5100', 'Cost of goods sold', 'cogs', 'expense', 'debit'),
  row('5200', 'Courier charges', 'courier_charges', 'expense', 'debit'),
  row('5210', 'Return charges', 'return_charges', 'expense', 'debit'),
  row('5300', 'Ad spend', 'ad_spend', 'expense', 'debit'),
  row('5400', 'Salary expense', 'salary_expense', 'expense', 'debit'),
  row('5410', 'Bonus expense', 'bonus_expense', 'expense', 'debit'),
  row('5500', 'Interest expense', 'interest_expense', 'expense', 'debit'),
  row('5600', 'Inventory write-off', 'inventory_writeoff', 'expense', 'debit'),
  row('5610', 'Purchase price variance', 'purchase_price_variance', 'expense', 'debit'),
  row('5700', 'Cash over/short', 'cash_over_short', 'expense', 'debit'),
  row('5710', 'Bank charges', 'bank_charges', 'expense', 'debit'),
  row('5800', 'Rent', 'operating_expense', 'expense', 'debit'),
  row('5810', 'Utilities', 'operating_expense', 'expense', 'debit'),
  row('5820', 'Packaging', 'operating_expense', 'expense', 'debit'),
  row('5830', 'Transport', 'operating_expense', 'expense', 'debit'),
  row('5890', 'Miscellaneous expense', 'operating_expense', 'expense', 'debit'),
];

/** The code of a branch's hand-cash wallet: `1010-HQ`. */
export function branchCashCode(branchCode: string): string {
  const safe = branchCode
    .toUpperCase()
    .replace(/[^0-9A-Z-]/g, '-')
    .slice(0, 27);
  return `${BRANCH_CASH_CODE_PREFIX}-${safe}`;
}
