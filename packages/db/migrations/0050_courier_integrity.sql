-- What the courier schema refuses, in the database (M12; architecture §7, §9).
--
-- Every rule below is also checked by the service that writes these rows. The
-- duplication is the one invariants 2, 3 and 6 are built on: a service can be
-- refactored, called from a worker, or bypassed by the next module that needs
-- "just one row"; a trigger cannot. Each raises a message beginning with a code
-- from `packages/contracts/src/errors.ts`, so `databaseLedgerCode()` turns a
-- refusal into a 4xx a caller can act on rather than a 500 and a constraint name.

-- A consignment's courier is its account's courier, and its order's courier.
--
-- Three copies of one fact, which is the shape that drifts — and the drift here
-- is not cosmetic. `courier_id` on this row is the `party_id` §7's receivable is
-- booked against, so a consignment that named a different courier than the
-- account that booked it would settle one courier's statement against another
-- courier's balance, and both balances would look plausible for months.
create or replace function courier.assert_consignment_parties() returns trigger
language plpgsql as $$
declare
  account record;
  ord record;
begin
  select courier_id, is_active into account
  from courier.courier_accounts
  where org_id = new.org_id and id = new.courier_account_id;

  if not found then
    raise exception 'COURIER_ACCOUNT_NOT_FOUND: no such courier account in this organization.';
  end if;
  if account.courier_id <> new.courier_id then
    raise exception 'COURIER_ACCOUNT_INVALID: a consignment''s courier is its account''s courier.';
  end if;
  -- Only on insert. An account deactivated later must not freeze the parcels it
  -- already booked: those still have to be delivered, returned and settled.
  if tg_op = 'INSERT' and not account.is_active then
    raise exception 'COURIER_ACCOUNT_INVALID: that courier account is not active.';
  end if;

  select branch_id into ord
  from sales.orders
  where org_id = new.org_id and id = new.order_id;

  if not found then
    raise exception 'ORDER_NOT_FOUND: no such order in this organization.';
  end if;
  -- Row scope (§6) is applied to `branch_id` on this row, so a consignment
  -- attached to the wrong branch would be visible to the wrong branch manager and
  -- invisible to the right one.
  if coalesce(new.branch_id::text, '') <> coalesce(ord.branch_id::text, '') then
    raise exception 'CONSIGNMENT_INVALID: a consignment belongs to its order''s branch.';
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger courier_assert_consignment_parties
before insert or update of org_id, order_id, courier_account_id, courier_id, branch_id
on courier.consignments
for each row execute function courier.assert_consignment_parties();--> statement-breakpoint

-- One order, one live parcel.
--
-- §9 allows an order to be rebooked with another courier after a refusal, so this
-- is not a unique index on `order_id`: it is a check that at most one consignment
-- for an order is in a state where the courier still has the parcel. Without it, a
-- double `enqueue_courier_booking` — the effect appears on two transitions and the
-- org's policy picks one, so a policy change mid-order can fire both — would book
-- the same parcel twice, and the second courier would collect the COD a second
-- time.
--
-- `pg_advisory_xact_lock` on the order, not a unique index, because the condition
-- is over a set of rows rather than one row's columns. The lock is per (org, order)
-- via hashtextextended over both, so two concurrent bookings for one order
-- serialise while bookings for different orders do not.
create or replace function courier.assert_single_live_consignment() returns trigger
language plpgsql as $$
declare
  live int;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.org_id::text || ':' || new.order_id::text, 0));

  select count(*) into live
  from courier.consignments
  where org_id = new.org_id
    and order_id = new.order_id
    and id <> new.id
    and booking_state in ('pending', 'booked')
    and status not in ('delivered', 'partial_delivered', 'returned_to_merchant', 'cancelled');

  if live > 0 and new.booking_state in ('pending', 'booked') then
    raise exception 'CONSIGNMENT_ALREADY_BOOKED: this order already has a parcel with a courier.';
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger courier_assert_single_live_consignment
before insert or update of booking_state, status on courier.consignments
for each row execute function courier.assert_single_live_consignment();--> statement-breakpoint

-- A consignment event belongs to a consignment of this org, and its dedupe key is
-- the one the domain builds.
--
-- The second half is the part worth having. `consignment_events_org_dedupe_idx`
-- makes a *duplicate* key impossible, but it cannot make a *wrong* key impossible
-- — and a writer that built the key from the instant it received the webhook
-- rather than the instant the courier reported would produce a fresh key for every
-- retransmission, defeating the index entirely and double-transitioning the order.
-- So the key is recomputed here from the row's own columns and compared.
--
-- `floor(date_part('epoch', ...))` truncates to the second, matching
-- `statusDedupeKey`: couriers report whole seconds, and a millisecond that differs
-- between two representations of one instant is exactly the difference this key
-- exists to ignore.
create or replace function courier.assert_consignment_event() returns trigger
language plpgsql as $$
declare
  expected text;
begin
  if not exists (
    select 1 from courier.consignments
    where org_id = new.org_id and id = new.consignment_id
  ) then
    raise exception 'CONSIGNMENT_NOT_FOUND: no such consignment in this organization.';
  end if;

  expected := lower(new.consignment_id::text)
    || '|' || new.status::text
    || '|' || floor(date_part('epoch', new.occurred_at))::bigint::text;

  if new.dedupe_key <> expected then
    raise exception 'CONSIGNMENT_EVENT_INVALID: the dedupe key does not match the event it is on (§9).';
  end if;

  -- Invariant 8: the business date of a courier event is its Asia/Dhaka calendar
  -- date. A webhook at 01:30 Dhaka on the 1st is the 1st's business, and computing
  -- it in UTC would put it on the previous day — which is how a month's COD
  -- reconciliation ends up one parcel short at the boundary, every month.
  if new.business_date <> (new.occurred_at at time zone 'Asia/Dhaka')::date then
    raise exception 'CONSIGNMENT_EVENT_INVALID: business_date is the Asia/Dhaka date of occurred_at (invariant 8).';
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger courier_assert_consignment_event
before insert on courier.consignment_events
for each row execute function courier.assert_consignment_event();--> statement-breakpoint

-- Events never change and never go away.
--
-- The grants in 0049 already withhold UPDATE and DELETE from `erp_app`, so this is
-- for every other role — `erp_owner`, which runs migrations and seeds, and a
-- superuser at a psql prompt during an incident. Invariant 3's movements have the
-- same pair of defences for the same reason: the grant is the lock and the trigger
-- is the alarm.
create or replace function courier.refuse_event_change() returns trigger
language plpgsql as $$
begin
  raise exception 'CONSIGNMENT_EVENT_IMMUTABLE: a courier event is a record of what the courier said; add a new one.';
end;
$$;--> statement-breakpoint

create trigger courier_events_immutable
before update or delete on courier.consignment_events
for each row execute function courier.refuse_event_change();--> statement-breakpoint

create trigger courier_settlement_lines_immutable
before update or delete on courier.settlement_lines
for each row execute function courier.refuse_event_change();--> statement-breakpoint

create trigger courier_return_receipt_lines_immutable
before update or delete on courier.return_receipt_lines
for each row execute function courier.refuse_event_change();--> statement-breakpoint

-- A return receipt's inspection has to be receivable, and its locations have to be
-- real locations of this org.
--
-- The damaged location is required exactly when something was damaged, and refused
-- when nothing was — §7 sends damaged units to the `damaged` location and writing
-- them off is a separate, approved step, so a receipt that recorded damage without
-- saying where it went would have created stock movements into the sellable shelf.
-- Checked as a constraint trigger, because the lines are inserted after the header
-- in the same transaction and a BEFORE trigger on the header would see none of them.
create or replace function courier.assert_return_receipt() returns trigger
language plpgsql as $$
declare
  receipt record;
  damaged int;
  sellable int;
begin
  select * into receipt from courier.return_receipts
  where org_id = new.org_id and id = new.id;

  -- Deleted later in the same transaction. Nothing to check.
  if not found then
    return null;
  end if;

  select coalesce(sum(damaged_qty), 0), coalesce(sum(sellable_qty), 0)
  into damaged, sellable
  from courier.return_receipt_lines
  where org_id = receipt.org_id and receipt_id = receipt.id;

  if damaged + sellable = 0 then
    raise exception 'RETURN_RECEIPT_INVALID: a return receipt records at least one unit.';
  end if;
  if damaged > 0 and receipt.damaged_location_id is null then
    raise exception 'RETURN_RECEIPT_INVALID: damaged units need the damaged location naming (§7).';
  end if;
  if damaged = 0 and receipt.damaged_location_id is not null then
    raise exception 'RETURN_RECEIPT_INVALID: nothing was damaged, so no damaged location is named.';
  end if;
  if receipt.damaged_location_id = receipt.location_id then
    raise exception 'RETURN_RECEIPT_INVALID: damaged units go to a different location than sellable ones (§7).';
  end if;
  if receipt.business_date <> (receipt.received_at at time zone 'Asia/Dhaka')::date then
    raise exception 'RETURN_RECEIPT_INVALID: business_date is the Asia/Dhaka date of received_at (invariant 8).';
  end if;

  return null;
end;
$$;--> statement-breakpoint

create constraint trigger courier_assert_return_receipt
after insert or update on courier.return_receipts
deferrable initially deferred
for each row execute function courier.assert_return_receipt();--> statement-breakpoint

-- A webhook delivery is stored once and processed once.
--
-- The only legitimate change to one of these rows is the outcome of processing it:
-- when it was processed, how many events came out, and what went wrong. Letting the
-- body or the account change afterwards would make the stored payload stop being
-- evidence — which is the entire reason §9 says to store it.
create or replace function courier.assert_webhook_delivery_update() returns trigger
language plpgsql as $$
begin
  if new.org_id <> old.org_id
     or new.courier_account_id <> old.courier_account_id
     or new.provider_code <> old.provider_code
     or new.body_hash <> old.body_hash
     or new.body::text <> old.body::text
     or new.received_at <> old.received_at then
    raise exception 'WEBHOOK_DELIVERY_IMMUTABLE: only the outcome of processing a webhook may change.';
  end if;
  if old.processed_at is not null and new.processed_at is distinct from old.processed_at then
    raise exception 'WEBHOOK_DELIVERY_IMMUTABLE: this webhook has already been processed.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger courier_webhook_delivery_update
before update on courier.webhook_deliveries
for each row execute function courier.assert_webhook_delivery_update();--> statement-breakpoint

-- Nothing in this schema may be deleted by anyone.
--
-- 0049 withholds DELETE from `erp_app` on every table here. This closes the same
-- door for `erp_owner` and for a superuser session, because the rows are the record
-- of money a third party held: a deleted consignment is a COD nobody can prove was
-- ever collected, and a deleted settlement is a bank credit with no explanation.
create or replace function courier.refuse_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'COURIER_RECORD_IMMUTABLE: courier records are the evidence of cash a third party held; they are never deleted.';
end;
$$;--> statement-breakpoint

create trigger courier_accounts_no_delete
before delete on courier.courier_accounts
for each row execute function courier.refuse_delete();--> statement-breakpoint

create trigger courier_consignments_no_delete
before delete on courier.consignments
for each row execute function courier.refuse_delete();--> statement-breakpoint

create trigger courier_webhook_deliveries_no_delete
before delete on courier.webhook_deliveries
for each row execute function courier.refuse_delete();--> statement-breakpoint

create trigger courier_return_receipts_no_delete
before delete on courier.return_receipts
for each row execute function courier.refuse_delete();--> statement-breakpoint

create trigger courier_settlements_no_delete
before delete on courier.settlements
for each row execute function courier.refuse_delete();
