-- M38a: tenant isolation, grants and the integrity triggers for stock in hand, the opening
-- stock window and scanned counts; the window closed for every brand that already opened its
-- books or traded; and an internal EAN-13 for every SKU that has none (D-602, D-603, D-606).
--
-- The policies are `tenantTableSql()`'s output, pasted verbatim like every other tenant
-- table's (D-048). The grants are where the thinking is:
--
-- * `opening_stock_windows`: select, insert, update. Never delete: a brand whose row was
--   deleted would read as open again, which is a reopen nobody approved.
-- * `stock_in_hand_entries` and `stock_in_hand_lines`: update and delete too, for the
--   draft flow only (warehouse counts, accounts prices; a draft entered twice is thrown
--   away). The triggers below confine both to a draft: a posted entry has moved stock and
--   posted a journal, and neither can be taken back by editing the paperwork. The one
--   change a posted entry takes is its approved reversal (posted → reversed).
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
-- A brand with no row is open. A draft cannot be written, a line changed, an entry posted or
-- reversed while the brand's window is closed: the service says so first with a typed error,
-- and this is the second gate for any path that does not go through the service. The window
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
-- is costed, to the entry's own journal for exactly what the lines are worth, while the
-- window is open; the one change after that is an approved reversal, while the window is
-- still open, naming the ledger's reversal of that journal. A reversed entry never changes,
-- and neither a posted nor a reversed entry is ever deleted.
--
-- Approval types are compared as text: 0113 adds them to the enum, and a new enum value is
-- not used as a literal near the transaction that adds it.
create or replace function inventory.guard_stock_in_hand_entry() returns trigger
language plpgsql as $$
declare
  v_lines integer;
  v_uncosted integer;
  v_value numeric;
  v_source_type text;
  v_source_id uuid;
  v_debits numeric;
  v_type text;
  v_status text;
  v_payload jsonb;
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
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

  if old.status = 'reversed' then
    raise exception 'STOCK_IN_HAND_IMMUTABLE: a reversed stock-in-hand entry cannot change.';
  end if;
  if new.org_id is distinct from old.org_id or new.id is distinct from old.id
     or new.created_by is distinct from old.created_by then
    raise exception 'STOCK_IN_HAND_INVALID: an entry''s identity cannot change.';
  end if;

  if old.status = 'posted' then
    if new.status <> 'reversed'
       or new.location_id is distinct from old.location_id
       or new.branch_id is distinct from old.branch_id
       or new.memo is distinct from old.memo
       or new.occurred_at is distinct from old.occurred_at
       or new.business_date is distinct from old.business_date
       or new.journal_id is distinct from old.journal_id
       or new.posted_by is distinct from old.posted_by
       or new.posted_at is distinct from old.posted_at then
      raise exception 'STOCK_IN_HAND_IMMUTABLE: a posted stock-in-hand entry cannot change; reverse it instead.';
    end if;
    perform inventory.assert_opening_window_open(new.org_id);

    -- The ledger's own reversal of this entry's journal (invariant 2).
    perform 1 from ledger.journals
    where org_id = new.org_id and id = new.reversal_journal_id
      and reverses_journal_id = old.journal_id;
    if not found then
      raise exception 'STOCK_IN_HAND_INVALID: a reversal names the journal that reverses this entry''s.';
    end if;

    -- An approved `stock_in_hand_reversal` for this entry.
    select type::text, status::text, payload into v_type, v_status, v_payload
    from approvals.approval_requests
    where org_id = new.org_id and id = new.reversal_approval_id;
    if not found or v_type <> 'stock_in_hand_reversal' or v_status <> 'approved'
       or v_payload ->> 'entryId' is distinct from new.id::text then
      raise exception 'STOCK_IN_HAND_INVALID: a reversal needs its own approved request.';
    end if;

    new.updated_at := now();
    return new;
  end if;

  -- A draft.
  if new.status = 'reversed' then
    raise exception 'STOCK_IN_HAND_INVALID: only a posted entry can be reversed.';
  end if;
  perform inventory.assert_opening_window_open(new.org_id);

  if new.status = 'posted' then
    select count(*), count(*) filter (where unit_cost_poisha is null),
           sum(qty::numeric * unit_cost_poisha)
      into v_lines, v_uncosted, v_value
    from inventory.stock_in_hand_lines
    where org_id = new.org_id and entry_id = new.id;
    if v_lines = 0 then
      raise exception 'STOCK_IN_HAND_INVALID: an entry with no lines has nothing to post.';
    end if;
    if v_uncosted > 0 then
      raise exception 'STOCK_IN_HAND_COST_REQUIRED: every line is priced before an entry posts.';
    end if;

    -- The entry's own journal, for exactly what its lines are worth.
    select source_type, source_id into v_source_type, v_source_id
    from ledger.journals
    where org_id = new.org_id and id = new.journal_id;
    if not found or v_source_type <> 'stock_in_hand' or v_source_id <> new.id then
      raise exception 'STOCK_IN_HAND_INVALID: a posted entry names its own stock-in-hand journal.';
    end if;
    select coalesce(sum(debit_poisha), 0) into v_debits
    from ledger.journal_lines
    where org_id = new.org_id and journal_id = new.journal_id;
    if v_debits <> v_value then
      raise exception 'STOCK_IN_HAND_INVALID: the journal does not post what the lines are worth.';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;--> statement-breakpoint

create trigger stock_in_hand_entries_guard
before insert or update or delete on inventory.stock_in_hand_entries
for each row execute function inventory.guard_stock_in_hand_entry();--> statement-breakpoint

-- A line belongs to a draft, and changes only while the window is open. `not found` on
-- delete is the cascade from deleting a draft.
create or replace function inventory.guard_stock_in_hand_line() returns trigger
language plpgsql as $$
declare
  v_status text;
begin
  if tg_op = 'DELETE' then
    select status into v_status
    from inventory.stock_in_hand_entries
    where org_id = old.org_id and id = old.entry_id;
    if found and v_status <> 'draft' then
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
  if v_status <> 'draft' then
    raise exception 'STOCK_IN_HAND_IMMUTABLE: a posted entry''s lines cannot change.';
  end if;
  if tg_op = 'UPDATE' and (new.entry_id is distinct from old.entry_id
       or new.org_id is distinct from old.org_id) then
    raise exception 'STOCK_IN_HAND_INVALID: a line cannot move to another entry.';
  end if;
  perform inventory.assert_opening_window_open(new.org_id);
  new.updated_at := now();
  return new;
end;
$$;--> statement-breakpoint

create trigger stock_in_hand_lines_guard
before insert or update or delete on inventory.stock_in_hand_lines
for each row execute function inventory.guard_stock_in_hand_line();--> statement-breakpoint

-- The window's two transitions (D-602), stamped here rather than trusted from the caller.
--
-- * open → closed: `closed_at` is the database's clock, to the millisecond (what a reopen
--   request's payload repeats back, as JSON), and says who closed it.
-- * closed → open: rests on an approved `opening_stock_reopen` of this brand, decided after
--   the close, raised for *this* close (its payload's `closedAt` is this `closed_at`), and
--   not the one that reopened it last time. So neither a code path nor a hand-written UPDATE
--   can reopen it alone, and a request left over from an earlier close reopens nothing.
--
-- Outside those two, nothing about the window changes: not who closed it, not when, not
-- what reopened it.
create or replace function inventory.guard_opening_stock_window() returns trigger
language plpgsql as $$
declare
  v_type text;
  v_status text;
  v_decided timestamptz;
  v_payload jsonb;
begin
  if tg_op = 'INSERT' then
    if new.reopen_approval_id is not null or new.reopened_at is not null
       or new.reopened_by is not null then
      raise exception 'OPENING_STOCK_INVALID: a window is reopened only from closed.';
    end if;
    if new.status = 'closed' then
      if new.closed_by is null then
        raise exception 'OPENING_STOCK_INVALID: a closed window says who closed it.';
      end if;
      new.closed_at := date_trunc('milliseconds', now());
    elsif new.closed_at is not null or new.closed_by is not null then
      raise exception 'OPENING_STOCK_INVALID: an open window has not been closed.';
    end if;
    return new;
  end if;

  if new.org_id is distinct from old.org_id then
    raise exception 'OPENING_STOCK_INVALID: a window belongs to its brand.';
  end if;

  if old.status = 'open' and new.status = 'closed' then
    if new.closed_by is null then
      raise exception 'OPENING_STOCK_INVALID: a close says who closed it.';
    end if;
    if new.reopen_approval_id is distinct from old.reopen_approval_id
       or new.reopened_at is distinct from old.reopened_at
       or new.reopened_by is distinct from old.reopened_by then
      raise exception 'OPENING_STOCK_INVALID: closing the window does not change how it was reopened.';
    end if;
    new.closed_at := date_trunc('milliseconds', now());
  elsif old.status = 'closed' and new.status = 'open' then
    if new.reopen_approval_id is null
       or new.reopen_approval_id is not distinct from old.reopen_approval_id
       or new.reopened_by is null then
      raise exception 'OPENING_STOCK_REOPEN_UNAPPROVED: reopening needs its own approved request.';
    end if;
    if new.closed_at is distinct from old.closed_at or new.closed_by is distinct from old.closed_by then
      raise exception 'OPENING_STOCK_INVALID: reopening the window keeps the record of its close.';
    end if;
    select type::text, status::text, decided_at, payload
      into v_type, v_status, v_decided, v_payload
    from approvals.approval_requests
    where org_id = new.org_id and id = new.reopen_approval_id;
    if not found or v_type <> 'opening_stock_reopen' or v_status <> 'approved'
       or v_decided is null or v_decided < old.closed_at then
      raise exception 'OPENING_STOCK_REOPEN_UNAPPROVED: reopening needs an approved request decided after the close.';
    end if;
    if v_payload ->> 'closedAt' is distinct from
       to_char(old.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') then
      raise exception 'OPENING_STOCK_REOPEN_UNAPPROVED: that request was raised for an earlier close; ask again.';
    end if;
    new.reopened_at := now();
  elsif new.status is distinct from old.status
        or new.closed_at is distinct from old.closed_at
        or new.closed_by is distinct from old.closed_by
        or new.reopen_approval_id is distinct from old.reopen_approval_id
        or new.reopened_at is distinct from old.reopened_at
        or new.reopened_by is distinct from old.reopened_by then
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

-- Brand by brand, with `app.org_id` set, as 0042 and 0111 do: every table read or written
-- below has RLS ENABLE and FORCE, so `erp_owner` running this migration sees no row without
-- an org context, and a bare statement would quietly change nothing. The test of this block
-- ("the migration's backfill" in `stock-in-hand.e2e.test.ts`) runs it again, through the
-- driver, against brands with history, and reads back the rows it wrote.
--
-- 1. The window, closed for a brand that already opened its books (M14a's one opening
--    journal, D-213) or has moved stock any other way. Stock in hand credits equity; a
--    brand already trading on the ERP takes stock in from a supplier or an approved
--    adjustment (D-421), and needs an approved reopen to count stock in against equity
--    again. A brand with no history stays open (no row). Closed by `system`.
--
-- 2. The barcode backfill: every SKU without a barcode gets the brand's next internal
--    numbers, in the order the SKUs were made. Numbering starts above both the brand's
--    counter and every 2-prefixed thirteen-digit barcode the brand already holds (a
--    supplier's in-store code), so a backfilled number never equals one that exists. A held
--    code above 90,000,000,000 is left out of that floor: it would leave too few numbers
--    above it, and the unique index still refuses an equal number rather than repeat one.
--    A brand with SKUs but no counter row gets one the way the SKU counter makes it
--    (`takeSequence`: the slug's first three letters, the highest product sequence).
-- m38a:backfill:start
DO $$
DECLARE
  org_row record;
  v_start bigint;
BEGIN
  FOR org_row IN SELECT id, slug FROM "org"."organizations" ORDER BY id LOOP
    PERFORM set_config('app.org_id', org_row.id::text, true);

    IF EXISTS (
         SELECT 1 FROM "ledger"."journals" j
         WHERE j.org_id = org_row.id
           AND j.idempotency_key = 'opening_balance:' || org_row.id::text || ':posted'
       )
       OR EXISTS (
         SELECT 1 FROM "inventory"."stock_movements" m
         WHERE m.org_id = org_row.id AND m.kind::text <> 'opening_balance'
       ) THEN
      INSERT INTO "inventory"."opening_stock_windows" (org_id, status, closed_by)
      VALUES (org_row.id, 'closed', 'system')
      ON CONFLICT (org_id) DO NOTHING;
    END IF;

    IF EXISTS (
         SELECT 1 FROM "catalog"."skus" s WHERE s.org_id = org_row.id AND s.barcode IS NULL
       ) THEN
      INSERT INTO "catalog"."sku_settings" (org_id, org_code, last_sequence)
      VALUES (
        org_row.id,
        coalesce(upper(substring(regexp_replace(org_row.slug, '[^A-Za-z0-9]', '', 'g') from 1 for 3)), 'ORG'),
        coalesce((SELECT max(p.sequence) FROM "catalog"."products" p WHERE p.org_id = org_row.id), 0)
      )
      ON CONFLICT (org_id) DO NOTHING;

      SELECT greatest(
               ss.last_barcode_sequence,
               coalesce((
                 SELECT max(substr(x.barcode, 2, 11)::bigint)
                 FROM "catalog"."skus" x
                 WHERE x.org_id = org_row.id AND x.barcode ~ '^2[0-9]{12}$'
                   AND substr(x.barcode, 2, 11)::bigint <= 90000000000
               ), 0)
             )
        INTO v_start
      FROM "catalog"."sku_settings" ss
      WHERE ss.org_id = org_row.id;

      WITH numbered AS (
        SELECT s.id, v_start + row_number() OVER (ORDER BY s.created_at, s.code) AS seq
        FROM "catalog"."skus" s
        WHERE s.org_id = org_row.id AND s.barcode IS NULL
      )
      UPDATE "catalog"."skus" s
      SET barcode = catalog.internal_ean13(n.seq), updated_at = now()
      FROM numbered n
      WHERE s.org_id = org_row.id AND s.id = n.id;

      UPDATE "catalog"."sku_settings" ss
      SET last_barcode_sequence = greatest(
            ss.last_barcode_sequence,
            coalesce((
              SELECT max(substr(x.barcode, 2, 11)::bigint)
              FROM "catalog"."skus" x
              WHERE x.org_id = org_row.id AND x.barcode ~ '^2[0-9]{12}$'
                AND substr(x.barcode, 2, 11)::bigint <= 90000000000
            ), 0)
          ),
          updated_at = now()
      WHERE ss.org_id = org_row.id;
    END IF;
  END LOOP;

  -- Leave no org context behind for whatever statement runs next in this transaction.
  PERFORM set_config('app.org_id', '', true);
END;
$$;
-- m38a:backfill:end
