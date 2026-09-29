-- What the pos schema refuses, in the database (M23; architecture §14, §7, §8).
--
-- Every rule below is also checked by the service that writes these rows. The
-- duplication is the one invariants 2 and 3 are built on: a service can be
-- refactored, called from a worker, or bypassed by the next module that needs
-- "just one row"; a trigger cannot. Each raises a message beginning with a code
-- (`packages/domain/src/pos/errors.ts`, proposed for contracts), so the POS
-- module turns a refusal into a 4xx a caller can act on rather than a 500.

-- A register sells from a location of its own branch, into wallets that belong
-- there: hand cash of *this* branch, and bKash or bank either org-level or this
-- branch's. A register pointed at another branch's hand cash would post one
-- showroom's takings into another showroom's till, and both closings would be
-- wrong by the same amount in opposite directions.
create or replace function pos.assert_register() returns trigger
language plpgsql as $$
declare
  location record;
  wallet record;
begin
  select branch_id, kind into location
  from org.locations
  where org_id = new.org_id and id = new.location_id;
  if not found then
    raise exception 'POS_REGISTER_INVALID: no such location in this organization.';
  end if;
  if location.branch_id is distinct from new.branch_id then
    raise exception 'POS_REGISTER_INVALID: a register sells from its own branch''s location.';
  end if;
  if location.kind::text not in ('showroom', 'warehouse') then
    raise exception 'POS_REGISTER_INVALID: a register sells from a showroom or warehouse, not % stock.', location.kind;
  end if;

  select w.branch_id, a.subtype into wallet
  from wallets.wallets w
  join ledger.accounts a on a.org_id = w.org_id and a.id = w.ledger_account_id
  where w.org_id = new.org_id and w.id = new.cash_wallet_id;
  if not found or wallet.subtype::text <> 'wallet_cash' or wallet.branch_id is distinct from new.branch_id then
    raise exception 'POS_REGISTER_INVALID: the cash tender is this branch''s own hand cash.';
  end if;

  if new.bkash_wallet_id is not null then
    select w.branch_id, a.subtype into wallet
    from wallets.wallets w
    join ledger.accounts a on a.org_id = w.org_id and a.id = w.ledger_account_id
    where w.org_id = new.org_id and w.id = new.bkash_wallet_id;
    if not found or wallet.subtype::text not in ('wallet_bkash', 'wallet_mfs_other')
       or (wallet.branch_id is not null and wallet.branch_id <> new.branch_id) then
      raise exception 'POS_REGISTER_INVALID: the bKash tender is a mobile wallet of this org or branch.';
    end if;
  end if;

  if new.card_wallet_id is not null then
    select w.branch_id, a.subtype into wallet
    from wallets.wallets w
    join ledger.accounts a on a.org_id = w.org_id and a.id = w.ledger_account_id
    where w.org_id = new.org_id and w.id = new.card_wallet_id;
    if not found or wallet.subtype::text <> 'wallet_bank'
       or (wallet.branch_id is not null and wallet.branch_id <> new.branch_id) then
      raise exception 'POS_REGISTER_INVALID: card payments settle to a bank wallet.';
    end if;
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger pos_registers_assert
before insert or update of org_id, branch_id, location_id, cash_wallet_id, bkash_wallet_id, card_wallet_id
on pos.registers
for each row execute function pos.assert_register();--> statement-breakpoint

-- A shift belongs to its register's branch, and closing it is the only change it
-- ever sees. A closed shift is final: its count is the cashier's signature, and a
-- count edited afterwards is a shortage explained away.
create or replace function pos.assert_shift() returns trigger
language plpgsql as $$
declare
  register record;
begin
  if tg_op = 'INSERT' then
    select branch_id, is_active into register
    from pos.registers
    where org_id = new.org_id and id = new.register_id;
    if not found then
      raise exception 'POS_REGISTER_NOT_FOUND: no such register in this organization.';
    end if;
    if register.branch_id <> new.branch_id then
      raise exception 'POS_SHIFT_MISMATCH: a shift belongs to its register''s branch.';
    end if;
    if not register.is_active then
      raise exception 'POS_REGISTER_INVALID: that register is deactivated.';
    end if;
    if new.status <> 'open' then
      raise exception 'POS_SHIFT_NOT_OPEN: a shift is opened before it is closed.';
    end if;
    return new;
  end if;

  if old.status <> 'open' then
    raise exception 'POS_SHIFT_NOT_OPEN: a closed shift is final.';
  end if;
  if (to_jsonb(new) - array['status', 'closed_by', 'closed_at', 'counted_cash_poisha',
                             'expected_cash_poisha', 'variance_poisha', 'close_note', 'updated_at'])
     is distinct from
     (to_jsonb(old) - array['status', 'closed_by', 'closed_at', 'counted_cash_poisha',
                             'expected_cash_poisha', 'variance_poisha', 'close_note', 'updated_at']) then
    raise exception 'POS_RECORD_IMMUTABLE: only closing may change a shift.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger pos_shifts_assert
before insert or update on pos.shifts
for each row execute function pos.assert_shift();--> statement-breakpoint

-- A sale or a return is rung on a register, in one of that register's shifts,
-- at that register's branch and location. All four are copied onto the document
-- (row scope and the stock movements need them there), so the copies are held
-- equal to the source rather than trusted.
create or replace function pos.assert_document() returns trigger
language plpgsql as $$
declare
  shift record;
  register record;
begin
  select register_id, branch_id into shift
  from pos.shifts
  where org_id = new.org_id and id = new.shift_id;
  if not found then
    raise exception 'POS_SHIFT_NOT_OPEN: no such shift in this organization.';
  end if;
  select branch_id, location_id into register
  from pos.registers
  where org_id = new.org_id and id = new.register_id;
  if not found then
    raise exception 'POS_REGISTER_NOT_FOUND: no such register in this organization.';
  end if;
  if shift.register_id <> new.register_id or shift.branch_id <> new.branch_id
     or register.branch_id <> new.branch_id or register.location_id <> new.location_id then
    raise exception 'POS_SHIFT_MISMATCH: a document belongs to its shift''s register, branch and location.';
  end if;
  if new.status = 'posted' then
    raise exception 'POS_SALE_INVALID: a document is recorded held and then posted, never inserted posted.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger pos_sales_assert
before insert on pos.sales
for each row execute function pos.assert_document();--> statement-breakpoint

create trigger pos_returns_assert
before insert on pos.returns
for each row execute function pos.assert_document();--> statement-breakpoint

-- A held document becomes posted or voided, once, and nothing else about it
-- moves. Its lines, tenders and amounts are what the customer's receipt says;
-- the journal cannot be edited to match a changed document (invariant 2), so the
-- document must not change either.
create or replace function pos.assert_document_transition() returns trigger
language plpgsql as $$
begin
  if old.status <> 'held' then
    raise exception 'POS_RECORD_IMMUTABLE: a posted or voided document is final.';
  end if;
  if new.status not in ('posted', 'voided') then
    raise exception 'POS_RECORD_IMMUTABLE: a held document is posted or voided.';
  end if;
  if (to_jsonb(new) - array['status', 'posted_on', 'cogs_poisha', 'journal_id',
                             'void_reason', 'voided_by', 'updated_at'])
     is distinct from
     (to_jsonb(old) - array['status', 'posted_on', 'cogs_poisha', 'journal_id',
                             'void_reason', 'voided_by', 'updated_at']) then
    raise exception 'POS_RECORD_IMMUTABLE: only posting or voiding may change a document.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger pos_sales_transition
before update on pos.sales
for each row execute function pos.assert_document_transition();--> statement-breakpoint

create trigger pos_returns_transition
before update on pos.returns
for each row execute function pos.assert_document_transition();--> statement-breakpoint

-- A line's unit cost is written once, when its document posts, from the stock
-- movement that recorded it. Everything else about a line is the receipt.
create or replace function pos.assert_line_cost_once() returns trigger
language plpgsql as $$
begin
  if old.unit_cost_poisha is not null then
    raise exception 'POS_RECORD_IMMUTABLE: a line''s cost is recorded once.';
  end if;
  if (to_jsonb(new) - array['unit_cost_poisha', 'updated_at'])
     is distinct from (to_jsonb(old) - array['unit_cost_poisha', 'updated_at']) then
    raise exception 'POS_RECORD_IMMUTABLE: a receipt line does not change.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger pos_sale_lines_cost_once
before update on pos.sale_lines
for each row execute function pos.assert_line_cost_once();--> statement-breakpoint

create trigger pos_return_lines_cost_once
before update on pos.return_lines
for each row execute function pos.assert_line_cost_once();--> statement-breakpoint

-- A tender names the wallet the register is configured to take it into. The
-- service picks the wallet from the register rather than from the payload, and
-- this is what keeps a direct insert from paying a sale into some other till.
create or replace function pos.assert_tender_wallet() returns trigger
language plpgsql as $$
declare
  document record;
  expected uuid;
begin
  if tg_table_name = 'sale_tenders' then
    select r.cash_wallet_id, r.bkash_wallet_id, r.card_wallet_id into document
    from pos.sales s join pos.registers r on r.org_id = s.org_id and r.id = s.register_id
    where s.org_id = new.org_id and s.id = new.sale_id;
  else
    select r.cash_wallet_id, r.bkash_wallet_id, r.card_wallet_id into document
    from pos.returns s join pos.registers r on r.org_id = s.org_id and r.id = s.register_id
    where s.org_id = new.org_id and s.id = new.return_id;
  end if;
  if not found then
    raise exception 'POS_SALE_NOT_FOUND: no such document in this organization.';
  end if;
  expected := case new.tender
    when 'cash' then document.cash_wallet_id
    when 'bkash' then document.bkash_wallet_id
    else document.card_wallet_id
  end;
  if expected is null or expected <> new.wallet_id then
    raise exception 'POS_REGISTER_INVALID: a % tender goes to the register''s % wallet.', new.tender, new.tender;
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger pos_sale_tenders_wallet
before insert on pos.sale_tenders
for each row execute function pos.assert_tender_wallet();--> statement-breakpoint

create trigger pos_return_tenders_wallet
before insert on pos.return_tenders
for each row execute function pos.assert_tender_wallet();--> statement-breakpoint

-- A review item is resolved once. Until then the server may refresh its reasons
-- and evidence on a retry; afterwards it is the record of what a manager decided.
create or replace function pos.assert_review_item() returns trigger
language plpgsql as $$
begin
  if old.status <> 'open' then
    raise exception 'POS_REVIEW_RESOLVED: that review item is already resolved.';
  end if;
  if (new.id, new.org_id, new.branch_id, new.kind, new.sale_id, new.return_id, new.created_at)
     is distinct from
     (old.id, old.org_id, old.branch_id, old.kind, old.sale_id, old.return_id, old.created_at) then
    raise exception 'POS_RECORD_IMMUTABLE: a review item always names the same document.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger pos_review_items_assert
before update on pos.review_items
for each row execute function pos.assert_review_item();--> statement-breakpoint

-- Refused for every role, `erp_owner` included — the grants in 0069 bind only
-- `erp_app`, and the role that owns the tables would otherwise be exempt.
create or replace function pos.refuse_change() returns trigger
language plpgsql as $$
begin
  raise exception 'POS_RECORD_IMMUTABLE: % on pos.% is not allowed.', tg_op, tg_table_name;
end;
$$;--> statement-breakpoint

create trigger pos_sale_tenders_append_only
before update or delete on pos.sale_tenders
for each row execute function pos.refuse_change();--> statement-breakpoint

create trigger pos_return_tenders_append_only
before update or delete on pos.return_tenders
for each row execute function pos.refuse_change();--> statement-breakpoint

create trigger pos_branch_closings_append_only
before update or delete on pos.branch_closings
for each row execute function pos.refuse_change();--> statement-breakpoint

create trigger pos_branch_closing_wallets_append_only
before update or delete on pos.branch_closing_wallets
for each row execute function pos.refuse_change();--> statement-breakpoint

create trigger pos_registers_no_delete
before delete on pos.registers
for each row execute function pos.refuse_change();--> statement-breakpoint

create trigger pos_shifts_no_delete
before delete on pos.shifts
for each row execute function pos.refuse_change();--> statement-breakpoint

create trigger pos_sales_no_delete
before delete on pos.sales
for each row execute function pos.refuse_change();--> statement-breakpoint

create trigger pos_sale_lines_no_delete
before delete on pos.sale_lines
for each row execute function pos.refuse_change();--> statement-breakpoint

create trigger pos_returns_no_delete
before delete on pos.returns
for each row execute function pos.refuse_change();--> statement-breakpoint

create trigger pos_return_lines_no_delete
before delete on pos.return_lines
for each row execute function pos.refuse_change();--> statement-breakpoint

create trigger pos_review_items_no_delete
before delete on pos.review_items
for each row execute function pos.refuse_change();
