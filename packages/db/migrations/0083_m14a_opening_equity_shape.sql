-- `opening_equity` in the database's own description of each subtype (M14a, D-213).
--
-- Migration 0080 appended the enum value, but `ledger.subtype_shape` (0015) is what the
-- account trigger checks an account's class, normal balance and party against, and it
-- did not know the new subtype: seeding the chart failed with LEDGER_ACCOUNT_INVALID on
-- every database migrated past 0080. The function is restated whole, with the one row
-- added, because `create or replace` has no way to append a row.
create or replace function ledger.subtype_shape(p_subtype ledger.account_subtype)
returns table (class ledger.account_class, normal_balance ledger.normal_balance, party_type ledger.party_type)
language sql
immutable
set search_path = pg_catalog, ledger
as $$
  select s.class::ledger.account_class, s.normal_balance::ledger.normal_balance,
         s.party_type::ledger.party_type
  from (values
    ('wallet_cash', 'asset', 'debit', null),
    ('wallet_bank', 'asset', 'debit', null),
    ('wallet_bkash', 'asset', 'debit', null),
    ('wallet_mfs_other', 'asset', 'debit', null),
    ('courier_receivable', 'asset', 'debit', 'courier'),
    ('inventory', 'asset', 'debit', null),
    ('goods_in_transit', 'asset', 'debit', null),
    ('supplier_advance', 'asset', 'debit', 'supplier'),
    ('employee_loan_receivable', 'asset', 'debit', 'employee'),
    ('other_receivable', 'asset', 'debit', null),
    ('supplier_payable', 'liability', 'credit', 'supplier'),
    ('reseller_payable', 'liability', 'credit', 'reseller'),
    ('salary_payable', 'liability', 'credit', null),
    ('investor_payable', 'liability', 'credit', 'investor'),
    ('loan_payable', 'liability', 'credit', 'lender'),
    ('customer_advance', 'liability', 'credit', null),
    ('other_payable', 'liability', 'credit', null),
    ('owner_capital', 'equity', 'credit', null),
    ('investor_capital', 'equity', 'credit', 'investor'),
    ('retained_earnings', 'equity', 'credit', null),
    ('opening_equity', 'equity', 'credit', null),
    ('profit_distribution', 'equity', 'debit', null),
    ('sales_revenue', 'income', 'credit', null),
    ('sales_discounts', 'income', 'debit', null),
    ('delivery_charge_income', 'income', 'credit', null),
    ('other_income', 'income', 'credit', null),
    ('inventory_adjustment_gain', 'income', 'credit', null),
    ('cogs', 'expense', 'debit', null),
    ('courier_charges', 'expense', 'debit', null),
    ('return_charges', 'expense', 'debit', null),
    ('ad_spend', 'expense', 'debit', null),
    ('salary_expense', 'expense', 'debit', null),
    ('bonus_expense', 'expense', 'debit', null),
    ('interest_expense', 'expense', 'debit', null),
    ('inventory_writeoff', 'expense', 'debit', null),
    ('purchase_price_variance', 'expense', 'debit', null),
    ('cash_over_short', 'expense', 'debit', null),
    ('bank_charges', 'expense', 'debit', null),
    ('operating_expense', 'expense', 'debit', null)
  ) as s(subtype, class, normal_balance, party_type)
  where s.subtype = p_subtype::text
$$;
