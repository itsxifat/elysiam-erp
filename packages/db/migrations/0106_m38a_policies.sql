-- M38a: tenant isolation, grants and the integrity triggers for stock in hand, the opening
-- stock window and scanned counts; and an internal EAN-13 for every SKU that has none
-- (D-602, D-603, D-606).
--
-- The policies are `tenantTableSql()`'s output, pasted verbatim like every other tenant
-- table's (D-048). The grants are where the thinking is:
--
-- * `opening_stock_windows`: select, insert, update. Never delete: a brand whose row was
--   deleted would read as open again, which is a reopen nobody approved.
-- * `stock_in_hand_entries` and `stock_in_hand_lines`: update and delete too, for the
--   draft flow only (warehouse counts, accounts prices; a draft entered twice is thrown
--   away). The triggers below confine both to a draft: a posted entry has moved stock and
--   posted a journal, and neither can be taken back by editing the paperwork.
-- * `count_scans`: append-only. Who scanned what is the record a disputed count is
--   settled from.
--
-- No analytics read on any of them: `unit_cost_poisha` is purchase cost (invariant 5).

alter table "inventory"."opening_stock_windows" enable row level security;--> statement-breakpoint
alter table "inventory"."opening_stock_windows" force row level security;--> statement-breakpoint
drop policy if exists "opening_stock_windows_org_isolation" on "inventory"."opening_stock_windows";--> statement-breakpoint
create policy "opening_stock_windows_org_isolation" on "inventory"."opening_stock_windows"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "inventory" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "inventory"."opening_stock_windows" to "erp_app";--> statement-breakpoint

alter table "inventory"."stock_in_hand_entries" enable row level security;--> statement-breakpoint
alter table "inventory"."stock_in_hand_entries" force row level security;--> statement-breakpoint
drop policy if exists "stock_in_hand_entries_org_isolation" on "inventory"."stock_in_hand_entries";--> statement-breakpoint
create policy "stock_in_hand_entries_org_isolation" on "inventory"."stock_in_hand_entries"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "inventory" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update, delete on "inventory"."stock_in_hand_entries" to "erp_app";--> statement-breakpoint

alter table "inventory"."stock_in_hand_lines" enable row level security;--> statement-breakpoint
alter table "inventory"."stock_in_hand_lines" force row level security;--> statement-breakpoint
drop policy if exists "stock_in_hand_lines_org_isolation" on "inventory"."stock_in_hand_lines";--> statement-breakpoint
create policy "stock_in_hand_lines_org_isolation" on "inventory"."stock_in_hand_lines"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "inventory" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update, delete on "inventory"."stock_in_hand_lines" to "erp_app";--> statement-breakpoint

alter table "inventory"."count_scans" enable row level security;--> statement-breakpoint
alter table "inventory"."count_scans" force row level security;--> statement-breakpoint
drop policy if exists "count_scans_org_isolation" on "inventory"."count_scans";--> statement-breakpoint
create policy "count_scans_org_isolation" on "inventory"."count_scans"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "inventory" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert on "inventory"."count_scans" to "erp_app";--> statement-breakpoint

-- A stock-in-hand entry carries its location's branch (§6's branch row scope), like a
-- count session and an adjustment. 0033's function already says exactly that.
create trigger stock_in_hand_entries_assert_branch
before insert or update of org_id, location_id, branch_id on inventory.stock_in_hand_entries
for each row execute function inventory.assert_location_branch();--> statement-breakpoint

-- The opening stock window, in the database (D-602).
--
-- A brand with no row is open. A draft cannot be written, and an entry cannot be posted,
-- while the brand's window is closed: the service says so first with a typed error, and
-- this is the second gate for any path that does not go through the service. The window
-- row is read `for share`, so it waits for a close in progress and a close waits for it.
create or replace function inventory.assert_opening_window_open(p_org uuid) returns void
language plpgsql as $$
declare
  v_status text;
begin
  select status into v_status
  from inventory.opening_stock_windows
  where org_id = p_org
  for share;
  if found and v_status = 'closed' then
    raise exception 'OPENING_STOCK_CLOSED: this brand''s opening stock window is closed.';
  end if;
end;
$$;--> statement-breakpoint

-- An entry: drafts change freely; posting is one transition, from a draft whose every line
-- is costed, while the window is open; a posted entry never changes and is never deleted.
create or replace function inventory.guard_stock_in_hand_entry() returns trigger
language plpgsql as $$
declare
  v_lines integer;
  v_uncosted integer;
begin
  if tg_op = 'DELETE' then
    if old.status = 'posted' then
      raise exception 'STOCK_IN_HAND_IMMUTABLE: a posted stock-in-hand entry cannot be removed.';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'STOCK_IN_HAND_INVALID: an entry is written as a draft and then posted.';
    end if;
    perform inventory.assert_opening_window_open(new.org_id);
    return new;
  end if;

  if old.status = 'posted' then
    raise exception 'STOCK_IN_HAND_IMMUTABLE: a posted stock-in-hand entry cannot change.';
  end if;
  if new.org_id is distinct from old.org_id or new.id is distinct from old.id
     or new.created_by is distinct from old.created_by then
    raise exception 'STOCK_IN_HAND_INVALID: an entry''s identity cannot change.';
  end if;

  perform inventory.assert_opening_window_open(new.org_id);

  if new.status = 'posted' then
    select count(*), count(*) filter (where unit_cost_poisha is null)
      into v_lines, v_uncosted
    from inventory.stock_in_hand_lines
    where org_id = new.org_id and entry_id = new.id;
    if v_lines = 0 then
      raise exception 'STOCK_IN_HAND_INVALID: an entry with no lines has nothing to post.';
    end if;
    if v_uncosted > 0 then
      raise exception 'STOCK_IN_HAND_COST_REQUIRED: every line is priced before an entry posts.';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;--> statement-breakpoint

create trigger stock_in_hand_entries_guard
before insert or update or delete on inventory.stock_in_hand_entries
for each row execute function inventory.guard_stock_in_hand_entry();--> statement-breakpoint

-- A line belongs to a draft. `not found` on delete is the cascade from deleting a draft.
create or replace function inventory.guard_stock_in_hand_line() returns trigger
language plpgsql as $$
declare
  v_status text;
begin
  if tg_op = 'DELETE' then
    select status into v_status
    from inventory.stock_in_hand_entries
    where org_id = old.org_id and id = old.entry_id;
    if found and v_status = 'posted' then
      raise exception 'STOCK_IN_HAND_IMMUTABLE: a posted entry''s lines cannot be removed.';
    end if;
    return old;
  end if;

  select status into v_status
  from inventory.stock_in_hand_entries
  where org_id = new.org_id and id = new.entry_id;
  if not found then
    raise exception 'STOCK_IN_HAND_INVALID: no such stock-in-hand entry in this organization.';
  end if;
  if v_status = 'posted' then
    raise exception 'STOCK_IN_HAND_IMMUTABLE: a posted entry''s lines cannot change.';
  end if;
  if tg_op = 'UPDATE' and (new.entry_id is distinct from old.entry_id
       or new.org_id is distinct from old.org_id) then
    raise exception 'STOCK_IN_HAND_INVALID: a line cannot move to another entry.';
  end if;
  new.updated_at := now();
  return new;
end;
$$;--> statement-breakpoint

create trigger stock_in_hand_lines_guard
before insert or update or delete on inventory.stock_in_hand_lines
for each row execute function inventory.guard_stock_in_hand_line();--> statement-breakpoint

-- The window's one hard transition (D-602): closed → open rests on an approved
-- `opening_stock_reopen` of this brand, decided after the close, so neither a code path
-- nor a hand-written UPDATE can reopen it alone. Closing only narrows what may happen, and
-- stamps who and when. Compared as text: the sibling migration adds the enum value, and a
-- new enum value is not used as a literal near the transaction that adds it.
create or replace function inventory.guard_opening_stock_window() returns trigger
language plpgsql as $$
declare
  v_type text;
  v_status text;
  v_decided timestamptz;
begin
  if tg_op = 'INSERT' then
    -- A first row is written open, or closed by the close itself, which stamps it.
    if new.status = 'closed' and (new.closed_at is null or new.closed_by is null) then
      raise exception 'OPENING_STOCK_INVALID: a closed window says who closed it and when.';
    end if;
    if new.reopen_approval_id is not null then
      raise exception 'OPENING_STOCK_INVALID: a window is reopened only from closed.';
    end if;
    return new;
  end if;

  if new.org_id is distinct from old.org_id then
    raise exception 'OPENING_STOCK_INVALID: a window belongs to its brand.';
  end if;

  if old.status = 'closed' and new.status = 'open' then
    if new.reopen_approval_id is null
       or new.reopen_approval_id is not distinct from old.reopen_approval_id then
      raise exception 'OPENING_STOCK_REOPEN_UNAPPROVED: reopening needs its own approved request.';
    end if;
    select type::text, status::text, decided_at
      into v_type, v_status, v_decided
    from approvals.approval_requests
    where org_id = new.org_id and id = new.reopen_approval_id;
    if not found or v_type <> 'opening_stock_reopen' or v_status <> 'approved'
       or v_decided is null or v_decided < old.closed_at then
      raise exception 'OPENING_STOCK_REOPEN_UNAPPROVED: reopening needs an approved request decided after the close.';
    end if;
  elsif old.status = 'open' and new.status = 'closed' then
    if new.closed_at is null or new.closed_by is null
       or new.closed_at is not distinct from old.closed_at then
      raise exception 'OPENING_STOCK_INVALID: a close says who closed it and when.';
    end if;
  elsif new.reopen_approval_id is distinct from old.reopen_approval_id
        or new.closed_at is distinct from old.closed_at
        or new.status is distinct from old.status then
    raise exception 'OPENING_STOCK_INVALID: the window changes only by closing or reopening it.';
  end if;

  new.updated_at := now();
  return new;
end;
$$;--> statement-breakpoint

create trigger opening_stock_windows_guard
before insert or update on inventory.opening_stock_windows
for each row execute function inventory.guard_opening_stock_window();--> statement-breakpoint

-- A scan counts only on an open count.
create or replace function inventory.guard_count_scan() returns trigger
language plpgsql as $$
declare
  v_status text;
begin
  select status::text into v_status
  from inventory.count_sessions
  where org_id = new.org_id and id = new.session_id;
  if not found then
    raise exception 'STOCK_COUNT_INVALID: no such count in this organization.';
  end if;
  if v_status <> 'open' then
    raise exception 'STOCK_COUNT_INVALID: scans are added only while a count is open.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger count_scans_guard
before insert on inventory.count_scans
for each row execute function inventory.guard_count_scan();--> statement-breakpoint

-- Internal EAN-13 numbers (D-603): `2`, an eleven-digit sequence, the check digit. The same
-- arithmetic as `internalEan13` in @elysium/domain, which a test holds equal to this.
create or replace function catalog.internal_ean13(p_sequence bigint) returns text
language plpgsql immutable as $$
declare
  v_body text;
  v_total integer := 0;
  v_index integer;
begin
  if p_sequence < 1 or p_sequence > 99999999999 then
    raise exception 'CATALOG_BARCODE_INVALID: an internal barcode sequence is 1 to 99999999999.';
  end if;
  v_body := '2' || lpad(p_sequence::text, 11, '0');
  for v_index in 1..12 loop
    v_total := v_total + substr(v_body, v_index, 1)::integer
      * (case when v_index % 2 = 1 then 1 else 3 end);
  end loop;
  return v_body || ((10 - v_total % 10) % 10)::text;
end;
$$;--> statement-breakpoint

-- The backfill: every SKU without a barcode gets the brand's next internal numbers, in the
-- order the SKUs were made. Numbering starts above both the brand's counter and every
-- 2-prefixed thirteen-digit barcode the brand already holds (a supplier's in-store code),
-- so a backfilled number can never equal one that exists.
--
-- FORCE is lifted for these statements and restored, as 0057 explains: `erp_owner` runs
-- migrations, FORCE makes the owner subject to the org policy, and a migration has no
-- `app.org_id`, so the update would otherwise match no row and say nothing.
alter table "catalog"."skus" no force row level security;--> statement-breakpoint
alter table "catalog"."sku_settings" no force row level security;--> statement-breakpoint

insert into catalog.sku_settings (org_id, org_code, last_sequence)
select distinct s.org_id, 'ORG', 0
from catalog.skus s
where s.barcode is null
on conflict (org_id) do nothing;--> statement-breakpoint

with floor_by_org as (
  select ss.org_id,
         greatest(
           ss.last_barcode_sequence,
           coalesce((
             select max(substr(x.barcode, 2, 11)::bigint)
             from catalog.skus x
             where x.org_id = ss.org_id and x.barcode ~ '^2[0-9]{12}$'
           ), 0)
         ) as start_after
  from catalog.sku_settings ss
),
numbered as (
  select s.org_id, s.id,
         f.start_after + row_number() over (partition by s.org_id order by s.created_at, s.code) as seq
  from catalog.skus s
  join floor_by_org f on f.org_id = s.org_id
  where s.barcode is null
)
update catalog.skus s
set barcode = catalog.internal_ean13(n.seq), updated_at = now()
from numbered n
where s.org_id = n.org_id and s.id = n.id;--> statement-breakpoint

update catalog.sku_settings ss
set last_barcode_sequence = greatest(
      ss.last_barcode_sequence,
      coalesce((
        select max(substr(x.barcode, 2, 11)::bigint)
        from catalog.skus x
        where x.org_id = ss.org_id and x.barcode ~ '^2[0-9]{12}$'
      ), 0)
    ),
    updated_at = now();--> statement-breakpoint

alter table "catalog"."sku_settings" force row level security;--> statement-breakpoint
alter table "catalog"."skus" force row level security;
