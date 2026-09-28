-- What the inventory schema refuses, in the database (M07; architecture §8,
-- invariant 3).
--
-- Every rule below is also checked by the service that writes these rows. The
-- duplication is the point: a service can be refactored, called from a worker, or
-- bypassed by the next module that needs "just one row"; a trigger cannot. Each
-- raises a message beginning with a code from
-- `packages/contracts/src/errors.ts`, so `databaseStockCode()` turns a refusal
-- into a 4xx a caller can act on rather than a 500 and a constraint name.
--
-- The first two are the ones invariant 3 rests on.

-- Movements are append-only, for **every** role.
--
-- `erp_app` holds no UPDATE or DELETE on this table (migration 0032), which is the
-- real control. This trigger is for the roles the grant does not bind: `erp_owner`
-- runs migrations and seeds, and a repair script connecting as the owner is
-- exactly the situation in which somebody decides to "just fix" a movement. The
-- fix for a wrong movement is an opposing movement — `count_correction` or an
-- adjustment — because the log is what every level, every valuation and every
-- reconciliation is derived from. Editing it rewrites all three and leaves nothing
-- that disagrees.
create or replace function inventory.refuse_movement_change() returns trigger
language plpgsql as $$
begin
  raise exception 'STOCK_MOVEMENT_IMMUTABLE: stock movements are append-only; record an opposing movement instead of changing this one.';
end;
$$;--> statement-breakpoint

create trigger stock_movements_no_update
before update or delete on inventory.stock_movements
for each row execute function inventory.refuse_movement_change();--> statement-breakpoint

-- Stamp the writing transaction, and refuse a caller's own value.
--
-- Overwritten rather than defaulted, because a default only applies when the
-- column is omitted: a caller that sends its own `created_txid` would otherwise
-- choose which transaction the level guard below believes wrote this movement.
create or replace function inventory.stamp_movement_txid() returns trigger
language plpgsql as $$
begin
  new.created_txid := pg_current_xact_id();
  return new;
end;
$$;--> statement-breakpoint

create trigger stock_movements_stamp_txid
before insert on inventory.stock_movements
for each row execute function inventory.stamp_movement_txid();--> statement-breakpoint

-- **Stock changes only through inventory movements** (invariant 3), enforced.
--
-- `stock_levels` is a cache of Σ movements, so the database cannot tell a
-- legitimate refresh from a hand-edited number by looking at the level alone. What
-- it can insist on is that the transaction changing `on_hand` also inserted a
-- movement for the same SKU and location — which is the same technique the ledger
-- uses to stop a posted journal growing extra lines later (migration 0014).
--
-- Only `on_hand` is guarded. `reserved` moves without a movement by design: a
-- reservation promises stock rather than moving it, and §8's conditional UPDATE is
-- the only writer. `reorder_level` is configuration.
--
-- The check is deferred to the end of the statement rather than run per row so the
-- movement may be inserted either before or after the level is touched; requiring
-- one order would make every call site depend on an invisible rule.
create or replace function inventory.assert_level_has_movement() returns trigger
language plpgsql as $$
begin
  if new.on_hand = old.on_hand then
    return new;
  end if;

  if not exists (
    select 1
    from inventory.stock_movements m
    where m.org_id = new.org_id
      and m.sku_id = new.sku_id
      and m.location_id = new.location_id
      and m.created_txid = pg_current_xact_id()
  ) then
    raise exception 'STOCK_MOVEMENT_REQUIRED: on-hand changed with no stock movement in this transaction (invariant 3).';
  end if;

  return new;
end;
$$;--> statement-breakpoint

create constraint trigger stock_levels_require_movement
after update of on_hand on inventory.stock_levels
deferrable initially deferred
for each row execute function inventory.assert_level_has_movement();--> statement-breakpoint

-- An INSERT with a non-zero on-hand is the same claim as an update, and gets the
-- same treatment. A level row created at zero — which is what a reorder level
-- being set on an untouched SKU does — needs no movement.
create or replace function inventory.assert_new_level_has_movement() returns trigger
language plpgsql as $$
begin
  if new.on_hand = 0 then
    return new;
  end if;

  if not exists (
    select 1
    from inventory.stock_movements m
    where m.org_id = new.org_id
      and m.sku_id = new.sku_id
      and m.location_id = new.location_id
      and m.created_txid = pg_current_xact_id()
  ) then
    raise exception 'STOCK_MOVEMENT_REQUIRED: a level cannot be created holding stock with no movement behind it (invariant 3).';
  end if;

  return new;
end;
$$;--> statement-breakpoint

create constraint trigger stock_levels_new_require_movement
after insert on inventory.stock_levels
deferrable initially deferred
for each row execute function inventory.assert_new_level_has_movement();--> statement-breakpoint

-- Stock only moves in and out of a live location.
--
-- Checked on insert only: deactivating a location later must not make its existing
-- movements unreadable or its remaining stock impossible to transfer out, which is
-- precisely what somebody deactivating a location wants to do next.
create or replace function inventory.assert_movement_location() returns trigger
language plpgsql as $$
declare
  loc record;
begin
  select is_active, kind into loc
  from org.locations
  where org_id = new.org_id and id = new.location_id;

  if not found then
    raise exception 'STOCK_LOCATION_INVALID: no such location in this organization.';
  end if;
  if not loc.is_active then
    raise exception 'STOCK_LOCATION_INVALID: that location is not active.';
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger stock_movements_assert_location
before insert on inventory.stock_movements
for each row execute function inventory.assert_movement_location();--> statement-breakpoint

-- A count session's and an adjustment's `branch_id` is the branch of its location.
--
-- The column is a copy of a fact that already exists on `org.locations`, and it is
-- there because §6's `branch` row scope and the composite branch foreign key both
-- need it on the row itself. Two copies of one fact is the shape that drifts, and
-- the drift here is not cosmetic: a write-off whose `branch_id` names a branch the
-- stock is not in would be signed off by the wrong branch manager, which is the
-- one control standing between a shelf and an unexplained shortage.
create or replace function inventory.assert_location_branch() returns trigger
language plpgsql as $$
declare
  loc record;
begin
  select branch_id into loc
  from org.locations
  where org_id = new.org_id and id = new.location_id;

  -- `not found` rather than a null test: a warehouse's `branch_id` is legitimately
  -- null, so the record would read as missing.
  if not found then
    raise exception 'STOCK_LOCATION_INVALID: no such location in this organization.';
  end if;
  if coalesce(new.branch_id::text, '') <> coalesce(loc.branch_id::text, '') then
    raise exception 'STOCK_LOCATION_INVALID: this row must carry the branch of its location.';
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger count_sessions_assert_branch
before insert or update of org_id, location_id, branch_id on inventory.count_sessions
for each row execute function inventory.assert_location_branch();--> statement-breakpoint

create trigger adjustments_assert_branch
before insert or update of org_id, location_id, branch_id on inventory.adjustments
for each row execute function inventory.assert_location_branch();--> statement-breakpoint

-- A count's frozen snapshot stays frozen, and a closed session stays closed.
--
-- The snapshot is the whole reason a count is a *session*: comparing what staff
-- found against a level that moved while they were counting produces a variance
-- for every sale that happened during the count, and the people who did the
-- counting get blamed for it. A snapshot that could be refreshed mid-count would
-- reintroduce exactly that, silently, and the count would look more accurate for
-- it.
create or replace function inventory.freeze_count_line() returns trigger
language plpgsql as $$
declare
  session_status text;
begin
  if new.snapshot_qty is distinct from old.snapshot_qty
     or new.session_id is distinct from old.session_id
     or new.sku_id is distinct from old.sku_id
     or new.org_id is distinct from old.org_id then
    raise exception 'STOCK_COUNT_INVALID: a count line''s snapshot and subject are frozen when the session opens.';
  end if;

  select status::text into session_status
  from inventory.count_sessions
  where org_id = new.org_id and id = new.session_id;

  if session_status is distinct from 'open' then
    raise exception 'STOCK_COUNT_INVALID: this count session is % and takes no more counts.', coalesce(session_status, 'missing');
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger count_lines_freeze
before update on inventory.count_lines
for each row execute function inventory.freeze_count_line();--> statement-breakpoint

create or replace function inventory.assert_count_transition() returns trigger
language plpgsql as $$
begin
  if new.status = old.status then
    return new;
  end if;

  -- open → submitted → closed, or cancelled from either. Nothing reopens: the
  -- snapshot is stale by then, and a reopened count compared against it would
  -- report every movement since as a variance.
  if not (
    (old.status = 'open' and new.status in ('submitted', 'cancelled'))
    or (old.status = 'submitted' and new.status in ('closed', 'cancelled'))
  ) then
    raise exception 'STOCK_COUNT_INVALID: a count session cannot go from % to %.', old.status, new.status;
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger count_sessions_assert_transition
before update of status on inventory.count_sessions
for each row execute function inventory.assert_count_transition();--> statement-breakpoint

-- An adjustment's terms are frozen once it is raised, and its status moves once.
--
-- Everything a checker judged — which location, which direction, how much, why —
-- is fixed at the moment the approval request is created. Without this, a
-- pending write-off approved for two thousand taka of damaged stock could be
-- re-pointed at twenty thousand taka of sellable stock before the executor ran,
-- and the approval would still say approved.
create or replace function inventory.freeze_adjustment() returns trigger
language plpgsql as $$
begin
  if new.org_id is distinct from old.org_id
     or new.location_id is distinct from old.location_id
     or new.branch_id is distinct from old.branch_id
     or new.direction is distinct from old.direction
     or new.value_poisha is distinct from old.value_poisha
     or new.count_session_id is distinct from old.count_session_id
     or new.business_date is distinct from old.business_date
     or new.approval_request_id is distinct from old.approval_request_id
     or new.created_by is distinct from old.created_by then
    raise exception 'STOCK_ADJUSTMENT_FROZEN: an adjustment''s terms are fixed when its approval is raised.';
  end if;

  if old.status <> 'pending_approval' and new.status is distinct from old.status then
    raise exception 'STOCK_ADJUSTMENT_FROZEN: this adjustment is already %.', old.status;
  end if;
  if old.status = 'pending_approval' and new.status not in ('pending_approval', 'posted', 'rejected') then
    raise exception 'STOCK_ADJUSTMENT_FROZEN: an adjustment is posted or rejected, nothing else.';
  end if;
  -- A posted adjustment names its journal, and that journal never changes
  -- (invariant 2), so re-pointing it would be a second correction with no record.
  if old.journal_id is not null and new.journal_id is distinct from old.journal_id then
    raise exception 'STOCK_ADJUSTMENT_FROZEN: this adjustment already names a journal.';
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger adjustments_freeze
before update on inventory.adjustments
for each row execute function inventory.freeze_adjustment();--> statement-breakpoint

-- A transfer's lines and its endpoints are fixed at dispatch, and it is received
-- once.
--
-- The stock is already in the van by the time the row exists (step one writes the
-- `transfer_out` movements), so changing the destination afterwards would mean the
-- receiving location takes in units the dispatching location never sent it — and
-- the difference would sit in the in-transit location forever, looking like stock
-- lost in traffic.
create or replace function inventory.freeze_transfer() returns trigger
language plpgsql as $$
begin
  if new.org_id is distinct from old.org_id
     or new.from_location_id is distinct from old.from_location_id
     or new.to_location_id is distinct from old.to_location_id
     or new.transit_location_id is distinct from old.transit_location_id
     or new.created_by is distinct from old.created_by
     or new.dispatched_at is distinct from old.dispatched_at then
    raise exception 'STOCK_TRANSFER_INVALID: a transfer''s endpoints are fixed at dispatch.';
  end if;
  if old.status <> 'dispatched' and new.status is distinct from old.status then
    raise exception 'STOCK_TRANSFER_INVALID: this transfer is already %.', old.status;
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger stock_transfers_freeze
before update on inventory.stock_transfers
for each row execute function inventory.freeze_transfer();--> statement-breakpoint

-- The weighted average is per org, and its basis can only be what the levels say.
--
-- Not enforced as equality — the basis is maintained by the same transactions that
-- move stock and the nightly reconciliation is what compares the two — but the
-- average itself is refused if it is ever set on a SKU belonging to another org's
-- catalogue, which the composite foreign key already prevents, or reduced below
-- zero, which the CHECK prevents. What is left for a trigger is the one thing
-- neither can see: a cost row for an archived SKU is fine (its stock still has
-- value), but a cost row for a SKU with no stock and no basis is noise, so the
-- basis is held at or above zero rather than allowed to drift negative by
-- subtraction.
create or replace function inventory.clamp_cost_basis() returns trigger
language plpgsql as $$
begin
  if new.qty_basis < 0 then
    new.qty_basis := 0;
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger sku_costs_clamp_basis
before insert or update on inventory.sku_costs
for each row execute function inventory.clamp_cost_basis();
