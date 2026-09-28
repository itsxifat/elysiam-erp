-- Tenant isolation for the inventory schema (M07; invariant 4, §5).
--
-- Emitted by `tenantTableSql()` in `packages/db/src/rls.ts` and pasted verbatim,
-- the way every tenant policy in this repo is: a policy that differs by one
-- character fails silently, returning rows rather than throwing, and the wrong
-- rows look like the right ones (D-048).
--
-- The grants are where the thinking is, and they are invariant 3 expressed as
-- privileges rather than as care:
--
-- * `stock_movements` is **append-only** — SELECT and INSERT, nothing else. It is
--   the record of how every unit got where it is, and a movement that could be
--   edited afterwards would make that record unfalsifiable: the nightly
--   reconciliation rebuilds levels from these rows, so a corrected movement
--   corrects the answer too and reports itself as healthy.
-- * `stock_levels` gets UPDATE — it is a cache that every movement refreshes —
--   but no DELETE. Deleting a level row loses its reorder level and makes the
--   SKU disappear from availability screens while its movements still exist.
-- * `adjustment_lines`, `stock_transfer_lines` and `reconciliations` are
--   append-only for the same reason as the movements: a write-off's lines are
--   the evidence of what was written off, a transfer's lines are what was put in
--   the van, and a reconciliation row is what the job found that night.
--   "No drift reported" and "the job has not run since Tuesday" have to stay
--   distinguishable, and only a row that cannot be deleted keeps them so.
-- * `reservations`, `count_sessions`, `count_lines`, `adjustments` and
--   `stock_transfers` get UPDATE for exactly one transition each, which 0033's
--   triggers confine them to, and no DELETE. A released reservation, a cancelled
--   count and a rejected write-off are all things somebody will need to look up
--   precisely because they did not happen.
--
-- No analytics read on any of them. Stock value is cost information (invariant 5)
-- and §5's cross-org exceptions do not include it; a read-only role is still a
-- role that can read (D-049). §18's consolidated stock value, when it arrives,
-- opens what it needs and nothing more.

alter table "inventory"."stock_levels" enable row level security;
--> statement-breakpoint
alter table "inventory"."stock_levels" force row level security;
--> statement-breakpoint
drop policy if exists "stock_levels_org_isolation" on "inventory"."stock_levels";
--> statement-breakpoint
create policy "stock_levels_org_isolation" on "inventory"."stock_levels"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "inventory" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "inventory"."stock_levels" to "erp_app";
--> statement-breakpoint
alter table "inventory"."stock_movements" enable row level security;
--> statement-breakpoint
alter table "inventory"."stock_movements" force row level security;
--> statement-breakpoint
drop policy if exists "stock_movements_org_isolation" on "inventory"."stock_movements";
--> statement-breakpoint
create policy "stock_movements_org_isolation" on "inventory"."stock_movements"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "inventory" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert on "inventory"."stock_movements" to "erp_app";
--> statement-breakpoint
alter table "inventory"."sku_costs" enable row level security;
--> statement-breakpoint
alter table "inventory"."sku_costs" force row level security;
--> statement-breakpoint
drop policy if exists "sku_costs_org_isolation" on "inventory"."sku_costs";
--> statement-breakpoint
create policy "sku_costs_org_isolation" on "inventory"."sku_costs"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "inventory" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "inventory"."sku_costs" to "erp_app";
--> statement-breakpoint
alter table "inventory"."reservations" enable row level security;
--> statement-breakpoint
alter table "inventory"."reservations" force row level security;
--> statement-breakpoint
drop policy if exists "reservations_org_isolation" on "inventory"."reservations";
--> statement-breakpoint
create policy "reservations_org_isolation" on "inventory"."reservations"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "inventory" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "inventory"."reservations" to "erp_app";
--> statement-breakpoint
alter table "inventory"."stock_transfers" enable row level security;
--> statement-breakpoint
alter table "inventory"."stock_transfers" force row level security;
--> statement-breakpoint
drop policy if exists "stock_transfers_org_isolation" on "inventory"."stock_transfers";
--> statement-breakpoint
create policy "stock_transfers_org_isolation" on "inventory"."stock_transfers"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "inventory" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "inventory"."stock_transfers" to "erp_app";
--> statement-breakpoint
alter table "inventory"."stock_transfer_lines" enable row level security;
--> statement-breakpoint
alter table "inventory"."stock_transfer_lines" force row level security;
--> statement-breakpoint
drop policy if exists "stock_transfer_lines_org_isolation" on "inventory"."stock_transfer_lines";
--> statement-breakpoint
create policy "stock_transfer_lines_org_isolation" on "inventory"."stock_transfer_lines"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "inventory" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert on "inventory"."stock_transfer_lines" to "erp_app";
--> statement-breakpoint
alter table "inventory"."count_sessions" enable row level security;
--> statement-breakpoint
alter table "inventory"."count_sessions" force row level security;
--> statement-breakpoint
drop policy if exists "count_sessions_org_isolation" on "inventory"."count_sessions";
--> statement-breakpoint
create policy "count_sessions_org_isolation" on "inventory"."count_sessions"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "inventory" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "inventory"."count_sessions" to "erp_app";
--> statement-breakpoint
alter table "inventory"."count_lines" enable row level security;
--> statement-breakpoint
alter table "inventory"."count_lines" force row level security;
--> statement-breakpoint
drop policy if exists "count_lines_org_isolation" on "inventory"."count_lines";
--> statement-breakpoint
create policy "count_lines_org_isolation" on "inventory"."count_lines"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "inventory" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "inventory"."count_lines" to "erp_app";
--> statement-breakpoint
alter table "inventory"."adjustments" enable row level security;
--> statement-breakpoint
alter table "inventory"."adjustments" force row level security;
--> statement-breakpoint
drop policy if exists "adjustments_org_isolation" on "inventory"."adjustments";
--> statement-breakpoint
create policy "adjustments_org_isolation" on "inventory"."adjustments"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "inventory" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "inventory"."adjustments" to "erp_app";
--> statement-breakpoint
alter table "inventory"."adjustment_lines" enable row level security;
--> statement-breakpoint
alter table "inventory"."adjustment_lines" force row level security;
--> statement-breakpoint
drop policy if exists "adjustment_lines_org_isolation" on "inventory"."adjustment_lines";
--> statement-breakpoint
create policy "adjustment_lines_org_isolation" on "inventory"."adjustment_lines"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "inventory" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert on "inventory"."adjustment_lines" to "erp_app";
--> statement-breakpoint
alter table "inventory"."reconciliations" enable row level security;
--> statement-breakpoint
alter table "inventory"."reconciliations" force row level security;
--> statement-breakpoint
drop policy if exists "reconciliations_org_isolation" on "inventory"."reconciliations";
--> statement-breakpoint
create policy "reconciliations_org_isolation" on "inventory"."reconciliations"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "inventory" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert on "inventory"."reconciliations" to "erp_app";
