-- What the supply schema refuses, in the database (M09; architecture §7, §8).
--
-- Every rule below is also checked by the service that writes these rows. The reason
-- for the duplication is the one invariants 2, 3 and 5 are built on: a service can be
-- refactored, called from a worker, or bypassed by the next module that needs "just
-- one row"; a trigger cannot. Each raises a message beginning with a code from
-- `packages/contracts/src/errors.ts`, so `databaseSupplyCode()` turns a refusal into a
-- 4xx a caller can act on rather than a 500 and a constraint name.
--
-- The rule doing the most work here is the last one. An advance application that
-- exceeded the advance actually held would leave `supplier_advance` — an asset —
-- carrying a credit balance, and the balance sheet would show a negative asset for a
-- supplier who is in fact owed money. Two clerks applying the same advance to two
-- different supplies at the same time is how that happens, and neither transaction can
-- see the other's uncommitted row: so the trigger takes a row lock on the payment
-- before it sums, which is what makes the two serialize rather than both pass.

-- A supply and a return belong to the branch of the location the goods are at.
--
-- `branch_id` is repeated on the header because row scope (§6 `branch`) and the
-- composite branch foreign key both need it there. Two copies of one fact is exactly
-- the shape that drifts, and the drift here would be a delivery a branch manager of
-- another branch can see the cost of. So the copy is derived rather than trusted — and
-- the location has to be somewhere stock is actually kept, because a receipt into the
-- `in_transit` or `damaged` location would blend purchase cost into an average nothing
-- sells from.
create or replace function supply.assert_stock_location() returns trigger
language plpgsql as $$
declare
  place record;
begin
  select branch_id, kind into place
  from org.locations
  where org_id = new.org_id and id = new.location_id;

  -- `not found`, not `place is null`: an org-level warehouse legitimately has a
  -- null `branch_id`, so a record whose columns are all null is indistinguishable
  -- from one that was never selected.
  if not found then
    raise exception 'STOCK_LOCATION_INVALID: no such location in this organization.';
  end if;
  if place.kind::text not in ('warehouse', 'showroom') then
    raise exception 'STOCK_LOCATION_INVALID: goods are received into a warehouse or a showroom, not a % location.', place.kind;
  end if;

  new.branch_id := place.branch_id;
  return new;
end;
$$;--> statement-breakpoint

create trigger supplies_assert_location
before insert or update of org_id, location_id, branch_id on supply.supplies
for each row execute function supply.assert_stock_location();--> statement-breakpoint

create trigger supply_returns_assert_location
before insert or update of org_id, location_id, branch_id on supply.returns
for each row execute function supply.assert_stock_location();--> statement-breakpoint

-- Nothing is bought from a supplier who has been deactivated.
--
-- On insert only. Deactivating a supplier must not freeze the entries and payments
-- already made to them: their statement still has to be readable, and an outstanding
-- payable still has to be payable.
create or replace function supply.assert_supplier_active() returns trigger
language plpgsql as $$
declare
  active boolean;
begin
  select is_active into active
  from supply.suppliers
  where org_id = new.org_id and id = new.supplier_id;

  if not found then
    raise exception 'SUPPLY_NOT_FOUND: no such supplier in this organization.';
  end if;
  if not active then
    raise exception 'SUPPLIER_INACTIVE: that supplier is no longer active.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger supplies_assert_supplier_active
before insert on supply.supplies
for each row execute function supply.assert_supplier_active();--> statement-breakpoint

create trigger supplier_payments_assert_supplier_active
before insert on supply.supplier_payments
for each row execute function supply.assert_supplier_active();--> statement-breakpoint

-- A received supply is history: it has moved stock, blended a weighted average and
-- posted a journal, and none of those can be taken back (invariants 2 and 3).
--
-- So the columns that decided all three are frozen, and the row cannot be deleted at
-- all. DELETE exists on this table only for the draft flow — a delivery recorded twice
-- before anyone priced it — and without this trigger that same grant would let a
-- posted purchase vanish while its journal and its stock movements stayed behind,
-- leaving inventory with a value no entry explains. The attachment is deliberately
-- still editable: the scanned challan often arrives after the goods.
create or replace function supply.guard_received_supply() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'received' then
      raise exception 'SUPPLY_IMMUTABLE: a received supply cannot be deleted; reverse it with a supplier return.';
    end if;
    return old;
  end if;

  if old.status = 'received' then
    if new.status <> old.status
      or new.supplier_id <> old.supplier_id
      or new.location_id <> old.location_id
      or coalesce(new.invoice_number, '') <> coalesce(old.invoice_number, '')
      or new.occurred_at <> old.occurred_at
      or new.business_date <> old.business_date
      or new.journal_id <> old.journal_id
      or new.received_by <> old.received_by
    then
      raise exception 'SUPPLY_IMMUTABLE: a received supply cannot be changed.';
    end if;
  end if;

  -- Draft → received only. Un-receiving would need the journal reversed and the
  -- movements undone, and neither is something an UPDATE can do.
  if old.status = 'draft' and new.status not in ('draft', 'received') then
    raise exception 'SUPPLY_IMMUTABLE: a draft becomes received, and nothing else.';
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger supplies_guard_received
before update or delete on supply.supplies
for each row execute function supply.guard_received_supply();--> statement-breakpoint

-- A line's `status` is the header's, and a received line never changes again.
--
-- The denormalized column exists so `supply_lines_costed_when_received` can be a
-- CHECK: a CHECK sees only its own row, and the rule it enforces — a received line has
-- a unit cost, a draft line need not (D-005) — is about the header's state. Derived
-- here rather than written by the caller, because the failure mode of two copies of
-- one fact is a received line with no cost, which is a purchase whose value entered
-- inventory as null.
create or replace function supply.guard_supply_line() returns trigger
language plpgsql as $$
declare
  header_status text;
begin
  if tg_op = 'DELETE' then
    select status::text into header_status
    from supply.supplies
    where org_id = old.org_id and id = old.supply_id;
    -- `not found` is the cascade from deleting a draft header; let it through.
    if found and header_status = 'received' then
      raise exception 'SUPPLY_IMMUTABLE: a received supply line cannot be removed.';
    end if;
    return old;
  end if;

  select status::text into header_status
  from supply.supplies
  where org_id = new.org_id and id = new.supply_id;
  if not found then
    raise exception 'SUPPLY_NOT_FOUND: no such supply entry in this organization.';
  end if;

  /*
   * Judged on the *line's own* previous status, not the header's current one.
   *
   * Receiving an entry flips the header and then updates its lines to match, so at
   * that moment the header already says `received` while each line still says
   * `draft` — testing the header would refuse the very update that records the
   * receipt. Testing `old.status` refuses every later one, which is the rule.
   */
  if tg_op = 'UPDATE' and old.status = 'received' then
    raise exception 'SUPPLY_IMMUTABLE: a received supply line cannot be changed.';
  end if;

  new.status := header_status::supply.supply_status;
  return new;
end;
$$;--> statement-breakpoint

create trigger supply_lines_guard
before insert or update or delete on supply.supply_lines
for each row execute function supply.guard_supply_line();--> statement-breakpoint

create or replace function supply.sync_line_status() returns trigger
language plpgsql as $$
begin
  update supply.supply_lines
  set status = new.status, updated_at = now()
  where org_id = new.org_id and supply_id = new.id and status <> new.status;
  return null;
end;
$$;--> statement-breakpoint

create trigger supplies_sync_line_status
after update of status on supply.supplies
for each row when (old.status is distinct from new.status)
execute function supply.sync_line_status();--> statement-breakpoint

-- A supplier is paid from a wallet, and the payment carries that wallet's branch.
--
-- The subtype check is what keeps §7's rule true: `Dr Supplier payable / Cr W`, where W
-- is a wallet. Crediting anything else — an income account, another payable — would
-- balance the journal and misstate where the money came from, and the posting rule's
-- own check can be bypassed by anything that writes this table without going through
-- it.
create or replace function supply.assert_payment_wallet() returns trigger
language plpgsql as $$
declare
  account record;
begin
  select subtype, branch_id, is_active into account
  from ledger.accounts
  where org_id = new.org_id and id = new.wallet_account_id;

  if not found then
    raise exception 'LEDGER_ACCOUNT_INVALID: no such ledger account in this organization.';
  end if;
  if account.subtype::text not like 'wallet\_%' then
    raise exception 'LEDGER_ACCOUNT_INVALID: a supplier is paid from a wallet, not from a % account.', account.subtype;
  end if;
  if tg_op = 'INSERT' and not account.is_active then
    raise exception 'LEDGER_ACCOUNT_INVALID: that wallet is closed.';
  end if;

  new.branch_id := account.branch_id;
  return new;
end;
$$;--> statement-breakpoint

create trigger supplier_payments_assert_wallet
before insert or update of org_id, wallet_account_id, branch_id on supply.supplier_payments
for each row execute function supply.assert_payment_wallet();--> statement-breakpoint

-- A payment's terms are fixed from the moment it is raised, and it has exactly one
-- transition.
--
-- The same shape M02b gives an approval request, and for the same reason: the amount a
-- checker approved has to be the amount that gets paid. Without this, the row a
-- checker read and the row the executor pays could differ by an UPDATE in between —
-- which is the classic maker-checker bypass, and it needs no privileges beyond the
-- UPDATE this table already grants.
create or replace function supply.guard_payment_terms() returns trigger
language plpgsql as $$
begin
  if old.status <> 'pending_approval' then
    raise exception 'SUPPLY_PAYMENT_FROZEN: a % supplier payment cannot change.', old.status;
  end if;
  if new.supplier_id <> old.supplier_id
    or new.wallet_account_id <> old.wallet_account_id
    or new.kind <> old.kind
    or new.amount_poisha <> old.amount_poisha
    or new.occurred_at <> old.occurred_at
    or new.business_date <> old.business_date
    or coalesce(new.approval_request_id::text, '') <> coalesce(old.approval_request_id::text, '')
  then
    raise exception 'SUPPLY_PAYMENT_FROZEN: a supplier payment''s terms are fixed once it is raised.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger supplier_payments_guard_terms
before update on supply.supplier_payments
for each row execute function supply.guard_payment_terms();--> statement-breakpoint

-- An advance can only be applied to a received supply, only from a posted advance to
-- the same supplier, and only up to what is actually held.
--
-- The row lock is the whole point. Two clerks applying one ৳1,00,000 advance to two
-- different deliveries at the same time each sum the applications they can see —
-- neither can see the other's uncommitted row — so both would pass, and
-- `supplier_advance` would end up credit-balanced: an asset account holding a negative
-- asset, for a supplier the books would then claim owes us money. Locking the payment
-- row first makes the second transaction wait and then see the first's row.
create or replace function supply.assert_advance_application() returns trigger
language plpgsql as $$
declare
  payment record;
  supply_row record;
  applied bigint;
begin
  select kind, status, supplier_id, amount_poisha into payment
  from supply.supplier_payments
  where org_id = new.org_id and id = new.payment_id
  for update;

  if not found then
    raise exception 'SUPPLY_NOT_FOUND: no such supplier payment in this organization.';
  end if;
  if payment.kind <> 'advance' or payment.status <> 'posted' then
    raise exception 'SUPPLY_ADVANCE_INVALID: only a posted advance can be applied to a supply.';
  end if;
  if payment.supplier_id <> new.supplier_id then
    raise exception 'SUPPLY_ADVANCE_INVALID: that advance belongs to a different supplier.';
  end if;

  select status, supplier_id into supply_row
  from supply.supplies
  where org_id = new.org_id and id = new.supply_id;

  if not found then
    raise exception 'SUPPLY_NOT_FOUND: no such supply entry in this organization.';
  end if;
  if supply_row.status <> 'received' then
    raise exception 'SUPPLY_ADVANCE_INVALID: an advance is applied to a received supply, not to a draft.';
  end if;
  if supply_row.supplier_id <> new.supplier_id then
    raise exception 'SUPPLY_ADVANCE_INVALID: that supply entry belongs to a different supplier.';
  end if;

  select coalesce(sum(amount_poisha), 0) into applied
  from supply.advance_applications
  where org_id = new.org_id and payment_id = new.payment_id;

  if applied + new.amount_poisha > payment.amount_poisha then
    raise exception 'SUPPLY_ADVANCE_INVALID: that advance holds only % poisha unapplied.',
      payment.amount_poisha - applied;
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger advance_applications_assert
before insert on supply.advance_applications
for each row execute function supply.assert_advance_application();--> statement-breakpoint

-- Append-only, enforced for **every** role rather than by the grants alone.
--
-- `erp_app` holds no UPDATE or DELETE on these tables (0036), but the migration role
-- does, and so would any future role somebody grants in a hurry. A return and an
-- advance application each name a journal, and a journal never changes after posting
-- (invariant 2): a row that could be edited afterwards would let the paperwork and the
-- ledger disagree about what happened, with the ledger — correctly — refusing to move.
create or replace function supply.refuse_change() returns trigger
language plpgsql as $$
begin
  raise exception 'SUPPLY_IMMUTABLE: %.% is append-only; correct it with a reversal.',
    tg_table_schema, tg_table_name;
end;
$$;--> statement-breakpoint

create trigger supply_returns_append_only
before update or delete on supply.returns
for each row execute function supply.refuse_change();--> statement-breakpoint

create trigger supply_return_lines_append_only
before update or delete on supply.return_lines
for each row execute function supply.refuse_change();--> statement-breakpoint

create trigger advance_applications_append_only
before update or delete on supply.advance_applications
for each row execute function supply.refuse_change();--> statement-breakpoint

create trigger supplier_notes_append_only
before update or delete on supply.supplier_notes
for each row execute function supply.refuse_change();
