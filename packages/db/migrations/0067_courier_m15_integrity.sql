-- What M15's courier tables refuse, in the database (architecture §9, §20).
--
-- Every rule here is also held by the service that writes these rows. The duplication is
-- the one 0050 explains: a service can be refactored, called from a new worker, or
-- bypassed by the next module that needs "just one row"; a trigger cannot. Each raises a
-- message that begins with a code from `packages/contracts/src/errors.ts`, which
-- `databaseCourierCode()` turns into a 4xx.

-- Append-only, for every role.
--
-- 0066 withholds UPDATE and DELETE from `erp_app` on both tables. This closes the same door
-- for `erp_owner` and a superuser at a psql prompt: an escalation note is what a dispute
-- over a missing COD is settled with, and a fetch run is the only record that an unattended
-- job saw a statement it could not import. Neither is worth anything once it can be edited.
create or replace function courier.refuse_record_change() returns trigger
language plpgsql as $$
begin
  raise exception 'COURIER_RECORD_IMMUTABLE: this courier record is append-only; add a new one.';
end;
$$;--> statement-breakpoint

create trigger courier_escalations_immutable
before update or delete on courier.consignment_escalations
for each row execute function courier.refuse_record_change();--> statement-breakpoint

create trigger courier_settlement_fetch_runs_immutable
before update or delete on courier.settlement_fetch_runs
for each row execute function courier.refuse_record_change();--> statement-breakpoint

-- How a settlement arrived is fixed when it is imported.
--
-- `source_fingerprint` is the idempotency key the fetch job relies on. A batch whose
-- fingerprint could be cleared would let the next fetch of the same statement create a
-- second batch — and a second batch is a second approval request for cash already in the
-- bank. 0051/0052's freeze enumerates the columns that existed then, so these two are
-- guarded here rather than by editing a committed migration (invariant 9).
create or replace function courier.assert_settlement_source_fixed() returns trigger
language plpgsql as $$
begin
  if new.source <> old.source
     or new.source_fingerprint is distinct from old.source_fingerprint then
    raise exception 'SETTLEMENT_FROZEN: how a settlement arrived is fixed at import.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger courier_assert_settlement_source_fixed
before update of source, source_fingerprint on courier.settlements
for each row execute function courier.assert_settlement_source_fixed();--> statement-breakpoint

-- A parcel's zone is the zone it was booked for.
--
-- Written once, at booking, from the order's zone. The performance report groups by it, and
-- a zone that could be rewritten afterwards would let last month's delivery rate move when
-- somebody tidied an order today. Null → a value is allowed, so a parcel reserved before its
-- zone was known can still be given one; a value → anything else is not.
create or replace function courier.assert_consignment_zone_fixed() returns trigger
language plpgsql as $$
begin
  if old.delivery_zone_id is not null
     and new.delivery_zone_id is distinct from old.delivery_zone_id then
    raise exception 'CONSIGNMENT_IMMUTABLE: a parcel''s delivery zone is the zone it was booked for.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger courier_assert_consignment_zone_fixed
before update of delivery_zone_id on courier.consignments
for each row execute function courier.assert_consignment_zone_fixed();--> statement-breakpoint

-- A selection rule names a courier this org has, in a zone this org has.
--
-- The composite foreign keys in 0065 already make a cross-org reference impossible (D-047).
-- This adds the one thing they cannot: the rule's courier must be an active party. A rule
-- that routed parcels to a courier row the org had switched off would book nothing — the
-- booking refuses an inactive account — and every parcel in the zone would fall through to
-- the default without anybody being told the rule was dead.
create or replace function courier.assert_selection_rule() returns trigger
language plpgsql as $$
declare
  active boolean;
begin
  select is_active into active
  from sales.couriers
  where org_id = new.org_id and id = new.courier_id;

  if not found then
    raise exception 'COURIER_ACCOUNT_NOT_FOUND: no such courier in this organization.';
  end if;
  if new.is_active and not active then
    raise exception 'COURIER_ACCOUNT_INVALID: an active rule cannot name a courier that is switched off.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger courier_assert_selection_rule
before insert or update on courier.selection_rules
for each row execute function courier.assert_selection_rule();
--> statement-breakpoint

-- A collection is a delivery's figure, and nothing else's.
--
-- `collected_poisha` is what `settlementCandidates` tells the matcher the courier owes us, and
-- §7's delivery journal is the debit behind it — so the figure may only exist on a parcel
-- whose delivery was booked, which is exactly when `delivered_at` is written. M15 made a
-- courier's `returned_to_merchant` move the order (start_return), and Pathao's paid-return
-- carries a `collected_amount`; recorded on a returned parcel, it matched the courier's
-- statement line and the settlement credited `courier_receivable` for money no journal ever
-- debited (M15 ledger audit C1). 0052 checks the order shipped; this checks the parcel was
-- delivered. The service no longer writes it; this is the alarm if anything else does.
create or replace function courier.assert_collection_is_a_delivery() returns trigger
language plpgsql as $$
begin
  if new.collected_poisha is not null and new.delivered_at is null then
    raise exception 'CONSIGNMENT_INVALID: a collection is recorded only on a parcel whose delivery was booked.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger courier_assert_collection_is_a_delivery
before insert or update of collected_poisha, delivered_at on courier.consignments
for each row execute function courier.assert_collection_is_a_delivery();
