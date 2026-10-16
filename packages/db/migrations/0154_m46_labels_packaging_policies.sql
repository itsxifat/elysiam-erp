-- Tenant isolation and integrity for M46: terminals, the computers bound to them, who works at
-- each, printers, the print queue and its log, the auto-print rule, the orders ready for a label,
-- lots, lot closures, handover scans and a packing's other cameras (invariant 4, §5; D-800 to
-- D-826).
--
-- The policies are `tenantTableSql()`'s, pasted verbatim as every tenant policy in this repo is
-- (D-048). The grants are where the decisions are:
--
-- * `terminals`, `terminal_devices`, `printers`: created and changed, never deleted (the print
--   log and the packing record name them; switched off or revoked instead).
-- * `terminal_members`: a person is assigned and later taken off: INSERT and DELETE.
-- * `print_jobs`: the print log. Written once with what is printed, where and why; only its
--   progress moves (the trigger below). Never deleted.
-- * `label_settings`, `label_orders`, `order_lots`: one row each, written and replaced.
-- * `lot_closures`, `handover_scans`, `session_cameras`: records, INSERT and SELECT only.
--
-- No analytics read on any of them.

alter table "packing"."terminals" enable row level security;
--> statement-breakpoint
alter table "packing"."terminals" force row level security;
--> statement-breakpoint
drop policy if exists "terminals_org_isolation" on "packing"."terminals";
--> statement-breakpoint
create policy "terminals_org_isolation" on "packing"."terminals"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "packing"."terminals" to "erp_app";
--> statement-breakpoint
alter table "packing"."terminal_members" enable row level security;
--> statement-breakpoint
alter table "packing"."terminal_members" force row level security;
--> statement-breakpoint
drop policy if exists "terminal_members_org_isolation" on "packing"."terminal_members";
--> statement-breakpoint
create policy "terminal_members_org_isolation" on "packing"."terminal_members"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, delete on "packing"."terminal_members" to "erp_app";
--> statement-breakpoint
alter table "packing"."terminal_devices" enable row level security;
--> statement-breakpoint
alter table "packing"."terminal_devices" force row level security;
--> statement-breakpoint
drop policy if exists "terminal_devices_org_isolation" on "packing"."terminal_devices";
--> statement-breakpoint
create policy "terminal_devices_org_isolation" on "packing"."terminal_devices"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "packing"."terminal_devices" to "erp_app";
--> statement-breakpoint
alter table "packing"."printers" enable row level security;
--> statement-breakpoint
alter table "packing"."printers" force row level security;
--> statement-breakpoint
drop policy if exists "printers_org_isolation" on "packing"."printers";
--> statement-breakpoint
create policy "printers_org_isolation" on "packing"."printers"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "packing"."printers" to "erp_app";
--> statement-breakpoint
alter table "packing"."print_jobs" enable row level security;
--> statement-breakpoint
alter table "packing"."print_jobs" force row level security;
--> statement-breakpoint
drop policy if exists "print_jobs_org_isolation" on "packing"."print_jobs";
--> statement-breakpoint
create policy "print_jobs_org_isolation" on "packing"."print_jobs"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "packing"."print_jobs" to "erp_app";
--> statement-breakpoint
alter table "packing"."label_settings" enable row level security;
--> statement-breakpoint
alter table "packing"."label_settings" force row level security;
--> statement-breakpoint
drop policy if exists "label_settings_org_isolation" on "packing"."label_settings";
--> statement-breakpoint
create policy "label_settings_org_isolation" on "packing"."label_settings"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "packing"."label_settings" to "erp_app";
--> statement-breakpoint
alter table "packing"."label_orders" enable row level security;
--> statement-breakpoint
alter table "packing"."label_orders" force row level security;
--> statement-breakpoint
drop policy if exists "label_orders_org_isolation" on "packing"."label_orders";
--> statement-breakpoint
create policy "label_orders_org_isolation" on "packing"."label_orders"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "packing"."label_orders" to "erp_app";
--> statement-breakpoint
alter table "packing"."order_lots" enable row level security;
--> statement-breakpoint
alter table "packing"."order_lots" force row level security;
--> statement-breakpoint
drop policy if exists "order_lots_org_isolation" on "packing"."order_lots";
--> statement-breakpoint
create policy "order_lots_org_isolation" on "packing"."order_lots"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "packing"."order_lots" to "erp_app";
--> statement-breakpoint
alter table "packing"."lot_closures" enable row level security;
--> statement-breakpoint
alter table "packing"."lot_closures" force row level security;
--> statement-breakpoint
drop policy if exists "lot_closures_org_isolation" on "packing"."lot_closures";
--> statement-breakpoint
create policy "lot_closures_org_isolation" on "packing"."lot_closures"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert on "packing"."lot_closures" to "erp_app";
--> statement-breakpoint
alter table "packing"."handover_scans" enable row level security;
--> statement-breakpoint
alter table "packing"."handover_scans" force row level security;
--> statement-breakpoint
drop policy if exists "handover_scans_org_isolation" on "packing"."handover_scans";
--> statement-breakpoint
create policy "handover_scans_org_isolation" on "packing"."handover_scans"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert on "packing"."handover_scans" to "erp_app";
--> statement-breakpoint
alter table "packing"."session_cameras" enable row level security;
--> statement-breakpoint
alter table "packing"."session_cameras" force row level security;
--> statement-breakpoint
drop policy if exists "session_cameras_org_isolation" on "packing"."session_cameras";
--> statement-breakpoint
create policy "session_cameras_org_isolation" on "packing"."session_cameras"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert on "packing"."session_cameras" to "erp_app";
--> statement-breakpoint

-- A terminal, a bound computer and a printer keep their identity: their brand, kind, who made
-- them and when; a revoked computer stays revoked, a deleted printer stays deleted.
create or replace function packing.assert_terminal_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.kind, new.created_by, new.created_at)
     is distinct from (old.id, old.org_id, old.kind, old.created_by, old.created_at) then
    raise exception 'CONFLICT: a terminal''s identity is fixed.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger terminals_identity
before update on packing.terminals
for each row execute function packing.assert_terminal_change();
--> statement-breakpoint
create or replace function packing.assert_terminal_device_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.terminal_id, new.token_sha256, new.bound_by, new.created_at)
     is distinct from (old.id, old.org_id, old.terminal_id, old.token_sha256, old.bound_by, old.created_at) then
    raise exception 'CONFLICT: a bound computer''s terminal and token are fixed.';
  end if;
  if old.revoked_at is not null
     and (new.revoked_at, new.revoked_by) is distinct from (old.revoked_at, old.revoked_by) then
    raise exception 'CONFLICT: a revoked computer stays revoked.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger terminal_devices_identity
before update on packing.terminal_devices
for each row execute function packing.assert_terminal_device_change();
--> statement-breakpoint
create or replace function packing.assert_printer_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.created_by, new.created_at)
     is distinct from (old.id, old.org_id, old.created_by, old.created_at) then
    raise exception 'CONFLICT: a printer''s identity is fixed.';
  end if;
  if old.deleted_at is not null
     and (new.deleted_at, new.deleted_by) is distinct from (old.deleted_at, old.deleted_by) then
    raise exception 'CONFLICT: a deleted printer stays deleted.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger printers_identity
before update on packing.printers
for each row execute function packing.assert_printer_change();
--> statement-breakpoint

-- The print log (D-818): what was printed, for which order and lot, where, by whom and why is
-- written once. Only the job's progress moves, and a finished job (printed or cancelled) never
-- moves again: a print that happened stays on the record as it happened.
create or replace function packing.assert_print_job_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.order_id, new.order_no, new.document, new.lot_no, new.lot_count,
      new.printer_id, new.terminal_id, new.source, new.reason, new.requested_by, new.copies,
      new.consignment_no, new.auto_key, new.created_at)
     is distinct from
     (old.id, old.org_id, old.order_id, old.order_no, old.document, old.lot_no, old.lot_count,
      old.printer_id, old.terminal_id, old.source, old.reason, old.requested_by, old.copies,
      old.consignment_no, old.auto_key, old.created_at) then
    raise exception 'CONFLICT: a print job''s document, order, printer and reason are fixed.';
  end if;
  if old.state in ('printed', 'cancelled') and new is distinct from old then
    raise exception 'CONFLICT: a finished print job is on the record as it happened.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger print_jobs_path
before update on packing.print_jobs
for each row execute function packing.assert_print_job_change();
--> statement-breakpoint

-- M38c's camera part rule (0135), widened for a terminal's several cameras (D-804): a camera's
-- part belongs to a packing that camera filmed, as its first camera or one of its others, whose
-- window is closed.
create or replace function packing.assert_video_source() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if (new.source, new.camera_id) is distinct from (old.source, old.camera_id) then
      raise exception 'CONFLICT: a packing video''s source is fixed.';
    end if;
    return new;
  end if;
  if new.source = 'camera' and not exists (
    select 1 from packing.sessions s
     where s.org_id = new.org_id and s.id = new.session_id and s.recording_to is not null
       and (s.camera_id = new.camera_id
            or exists (
              select 1 from packing.session_cameras c
               where c.org_id = s.org_id and c.session_id = s.id and c.camera_id = new.camera_id
            ))
  ) then
    raise exception 'CONFLICT: a camera''s video belongs to a packing that camera filmed.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint

-- Orders already booked when M46 arrives are ready for their label like any later one (D-817):
-- the consignments booked for orders still at the hub. The courier's and the orders' tables are
-- read here once, by the owner, never by the packing module's code (invariant 12).
--
-- FORCE is lifted for this one statement on the three tables it touches, as 0057 does and for
-- its reason: a cross-org backfill cannot satisfy a policy comparing `org_id` with one
-- `app.org_id`, and FORCE is what binds the owner running it. `erp_app` is not the owner, so the
-- policies bind it whatever FORCE says; FORCE is back before the migration's transaction ends.
-- On a new database (migrations run before the seed) there is nothing to copy.
alter table "packing"."label_orders" no force row level security;
--> statement-breakpoint
alter table "courier"."consignments" no force row level security;
--> statement-breakpoint
alter table "sales"."orders" no force row level security;
--> statement-breakpoint
insert into packing.label_orders (org_id, order_id, order_no, consignment_no, location_id, booked_at)
select distinct on (c.org_id, c.order_id)
       c.org_id, c.order_id, o.order_no, c.consignment_no, o.location_id,
       coalesce(c.booked_at, c.created_at)
from courier.consignments c
join sales.orders o on o.org_id = c.org_id and o.id = c.order_id
where c.booking_state = 'booked' and c.consignment_no is not null
  and length(c.consignment_no) between 1 and 120
  and o.status in ('confirmed', 'packed')
order by c.org_id, c.order_id, coalesce(c.booked_at, c.created_at) desc
on conflict (org_id, order_id) do nothing;
--> statement-breakpoint
alter table "sales"."orders" force row level security;
--> statement-breakpoint
alter table "courier"."consignments" force row level security;
--> statement-breakpoint
alter table "packing"."label_orders" force row level security;
