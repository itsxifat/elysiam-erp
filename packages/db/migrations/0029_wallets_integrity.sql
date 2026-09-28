-- What the wallets schema refuses, in the database (M08; architecture §6, §7).
--
-- Every rule below is also checked by the service that writes these rows. The
-- reason for the duplication is the one invariant 2 and 3 are built on: a
-- service can be refactored, called from a worker, or bypassed by the next
-- module that needs "just one row"; a trigger cannot. Each raises a message
-- beginning with a code from `packages/contracts/src/errors.ts`, so
-- `databaseLedgerCode()` turns a refusal into a 4xx a caller can act on rather
-- than a 500 and a constraint name.

-- A wallet must *be* a wallet: its ledger account has a `wallet_*` subtype, and
-- the branch on the wallet row is the branch on the account.
--
-- `branch_id` is repeated on the wallet row because row scope (§6 `branch`) and
-- the composite branch foreign key both need it there. Two copies of one fact is
-- exactly the shape that drifts, and the drift here would be a hand-cash wallet
-- that a branch manager of another branch can see and post from. So the copy is
-- held equal to the account's rather than trusted.
create or replace function wallets.assert_wallet_account() returns trigger
language plpgsql as $$
declare
  account record;
begin
  select subtype, branch_id, is_active into account
  from ledger.accounts
  where org_id = new.org_id and id = new.ledger_account_id;

  -- `not found`, not `account is null`: a record whose every column happens to
  -- be null is indistinguishable from one that was never selected, and
  -- `branch_id` is legitimately null on an org-level wallet.
  if not found then
    raise exception 'LEDGER_ACCOUNT_INVALID: no such ledger account in this organization.';
  end if;
  if account.subtype::text not like 'wallet\_%' then
    raise exception 'LEDGER_ACCOUNT_INVALID: account is a % account, not a wallet.', account.subtype;
  end if;
  if coalesce(new.branch_id::text, '') <> coalesce(account.branch_id::text, '') then
    raise exception 'LEDGER_ACCOUNT_INVALID: a wallet belongs to the same branch as its ledger account.';
  end if;
  -- Only on insert: an account deactivated later must not freeze the wallet row
  -- it belongs to, which still needs to be deactivated itself.
  if tg_op = 'INSERT' and not account.is_active then
    raise exception 'LEDGER_ACCOUNT_INVALID: that ledger account is inactive.';
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger wallets_assert_account
before insert or update of org_id, ledger_account_id, branch_id on wallets.wallets
for each row execute function wallets.assert_wallet_account();--> statement-breakpoint

-- A cash entry's category must be the right *class* of account for its
-- direction, its branch must be its wallet's branch, and a petty-cash receipt
-- must be a **private** file.
--
-- The last one is check 2's second half, and it is here rather than only in the
-- service because a public receipt is not a smaller version of the same thing:
-- the public bucket is served by the CDN with no authorization at all, so a
-- receipt photographed with a customer's address in it would be readable by
-- anyone with the URL. `files.objects.visibility` is the column that decides
-- that, and this is the one place that can see both rows at once.
create or replace function wallets.assert_cash_entry() returns trigger
language plpgsql as $$
declare
  wallet record;
  category record;
  receipt record;
begin
  select branch_id into wallet
  from wallets.wallets
  where org_id = new.org_id and id = new.wallet_id;

  -- `not found` rather than a null check: an org-level wallet's `branch_id` is
  -- null, so the record would read as missing.
  if not found then
    raise exception 'LEDGER_ACCOUNT_INVALID: no such wallet in this organization.';
  end if;
  if coalesce(new.branch_id::text, '') <> coalesce(wallet.branch_id::text, '') then
    raise exception 'LEDGER_ACCOUNT_INVALID: a cash entry belongs to its wallet''s branch.';
  end if;

  select class, is_active into category
  from ledger.accounts
  where org_id = new.org_id and id = new.category_account_id;

  if not found then
    raise exception 'LEDGER_ACCOUNT_INVALID: no such category account in this organization.';
  end if;
  if not category.is_active then
    raise exception 'LEDGER_ACCOUNT_INVALID: that category is inactive.';
  end if;
  if new.kind = 'cash_in' and category.class <> 'income' then
    raise exception 'JOURNAL_LINE_INVALID: cash in is credited to an income category.';
  end if;
  if new.kind in ('cash_out', 'petty_cash') and category.class <> 'expense' then
    raise exception 'JOURNAL_LINE_INVALID: cash out is charged to an expense category.';
  end if;

  if new.receipt_file_id is not null then
    select visibility into receipt
    from files.objects
    where org_id = new.org_id and id = new.receipt_file_id;

    if not found then
      raise exception 'LEDGER_ACCOUNT_INVALID: no such receipt file in this organization.';
    end if;
    if receipt.visibility <> 'private' then
      raise exception 'JOURNAL_LINE_INVALID: a receipt is a private file (§22).';
    end if;
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger cash_entries_assert_shape
before insert on wallets.cash_entries
for each row execute function wallets.assert_cash_entry();--> statement-breakpoint

-- The only UPDATE either of these tables has: a row waiting for a checker
-- becomes posted or rejected, once.
--
-- Everything else about the row is frozen. Without this, UPDATE — which
-- `wallets.cash_entries` and `wallets.closings` need for exactly that one
-- transition — would also allow rewriting the amount, the wallet or the
-- category of an entry whose journal has already been posted, leaving the
-- paperwork and the ledger describing different events. The journal cannot be
-- edited to match (invariant 2), so the paperwork must not be either.
create or replace function wallets.assert_settlement_only() returns trigger
language plpgsql as $$
begin
  if old.status <> 'pending_approval' then
    raise exception 'LEDGER_IMMUTABLE: a % row cannot be changed.', old.status;
  end if;
  if new.status not in ('posted', 'rejected') then
    raise exception 'LEDGER_IMMUTABLE: a waiting row is either posted or rejected.';
  end if;
  if new.approval_request_id is distinct from old.approval_request_id then
    raise exception 'LEDGER_IMMUTABLE: the approval that decided this row is fixed.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger cash_entries_settlement_only
before update on wallets.cash_entries
for each row execute function wallets.assert_settlement_only();--> statement-breakpoint

create trigger wallet_closings_settlement_only
before update on wallets.closings
for each row execute function wallets.assert_settlement_only();--> statement-breakpoint

-- Columns that may change on that one transition. Anything else on the row is
-- the same row it was, whatever the service intended.
create or replace function wallets.assert_frozen_terms() returns trigger
language plpgsql as $$
begin
  if to_jsonb(new) - 'status' - 'journal_id' - 'updated_at'
     <> to_jsonb(old) - 'status' - 'journal_id' - 'updated_at' then
    raise exception 'LEDGER_IMMUTABLE: only the status and the journal of a waiting row may change.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger cash_entries_frozen_terms
before update on wallets.cash_entries
for each row execute function wallets.assert_frozen_terms();--> statement-breakpoint

create trigger wallet_closings_frozen_terms
before update on wallets.closings
for each row execute function wallets.assert_frozen_terms();--> statement-breakpoint

-- A wallet is deactivated, never removed, and the same for the paperwork. The
-- grants in 0028 are the control; this is the backstop for a future grant
-- written by hand, and it applies to every role including the owner.
create or replace function wallets.refuse_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'LEDGER_IMMUTABLE: rows in % are never deleted; deactivate or reverse instead.',
    tg_table_name;
end;
$$;--> statement-breakpoint

create trigger wallets_refuse_delete before delete on wallets.wallets
for each row execute function wallets.refuse_delete();--> statement-breakpoint

create trigger cash_entries_refuse_delete before delete on wallets.cash_entries
for each row execute function wallets.refuse_delete();--> statement-breakpoint

create trigger wallet_transfers_refuse_delete before delete on wallets.transfers
for each row execute function wallets.refuse_delete();--> statement-breakpoint

create trigger wallet_closings_refuse_delete before delete on wallets.closings
for each row execute function wallets.refuse_delete();
