-- Tenant isolation for the sales schema (M10; invariant 4, §5).
--
-- Emitted by `tenantTableSql()` in `packages/db/src/rls.ts` and pasted verbatim, the way
-- every tenant policy in this repo is: a policy that differs by one character fails
-- silently, returning rows rather than throwing, and the wrong rows look like the right
-- ones (D-048).
--
-- The grants are where the decisions are:
--
-- * `order_events` is **append-only** — SELECT and INSERT, nothing else. It is the
--   order's own history: when it went on hold, who confirmed it, why it was cancelled.
--   A timeline that can be edited answers those questions differently on different
--   days, and those are exactly the questions a return dispute or a fraud argument
--   turns on.
-- * `orders`, `order_lines`, `customers`, `customer_addresses` and `order_counters` get
--   UPDATE and no DELETE. A cancelled order is evidence; deleting one would lose the
--   reason, the reservation history and the customer's counter movements while the
--   journals it caused stayed behind. `order_counters` must never lose a row either —
--   resetting a month's counter reissues numbers that are already printed on invoices.
-- * `couriers`, `delivery_zones` and `delivery_zone_areas` get DELETE, because they are
--   configuration: an org that mis-typed a zone should be able to remove it, and the
--   restrict-on-delete foreign keys stop it removing one an order still points at.
--
-- No analytics read on any of them. §5's cross-org exceptions do not include order data,
-- and a read-only role is still a role that can read (D-049). §18's leaderboard reads
-- normalized metrics from its own rollups, never from here.

alter table "sales"."couriers" enable row level security;
--> statement-breakpoint
alter table "sales"."couriers" force row level security;
--> statement-breakpoint
drop policy if exists "couriers_org_isolation" on "sales"."couriers";
--> statement-breakpoint
create policy "couriers_org_isolation" on "sales"."couriers"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "sales" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update, delete on "sales"."couriers" to "erp_app";
--> statement-breakpoint
alter table "sales"."delivery_zones" enable row level security;
--> statement-breakpoint
alter table "sales"."delivery_zones" force row level security;
--> statement-breakpoint
drop policy if exists "delivery_zones_org_isolation" on "sales"."delivery_zones";
--> statement-breakpoint
create policy "delivery_zones_org_isolation" on "sales"."delivery_zones"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "sales" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update, delete on "sales"."delivery_zones" to "erp_app";
--> statement-breakpoint
alter table "sales"."delivery_zone_areas" enable row level security;
--> statement-breakpoint
alter table "sales"."delivery_zone_areas" force row level security;
--> statement-breakpoint
drop policy if exists "delivery_zone_areas_org_isolation" on "sales"."delivery_zone_areas";
--> statement-breakpoint
create policy "delivery_zone_areas_org_isolation" on "sales"."delivery_zone_areas"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "sales" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update, delete on "sales"."delivery_zone_areas" to "erp_app";
--> statement-breakpoint
alter table "sales"."customers" enable row level security;
--> statement-breakpoint
alter table "sales"."customers" force row level security;
--> statement-breakpoint
drop policy if exists "customers_org_isolation" on "sales"."customers";
--> statement-breakpoint
create policy "customers_org_isolation" on "sales"."customers"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "sales" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "sales"."customers" to "erp_app";
--> statement-breakpoint
alter table "sales"."customer_addresses" enable row level security;
--> statement-breakpoint
alter table "sales"."customer_addresses" force row level security;
--> statement-breakpoint
drop policy if exists "customer_addresses_org_isolation" on "sales"."customer_addresses";
--> statement-breakpoint
create policy "customer_addresses_org_isolation" on "sales"."customer_addresses"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "sales" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "sales"."customer_addresses" to "erp_app";
--> statement-breakpoint
alter table "sales"."order_counters" enable row level security;
--> statement-breakpoint
alter table "sales"."order_counters" force row level security;
--> statement-breakpoint
drop policy if exists "order_counters_org_isolation" on "sales"."order_counters";
--> statement-breakpoint
create policy "order_counters_org_isolation" on "sales"."order_counters"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "sales" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "sales"."order_counters" to "erp_app";
--> statement-breakpoint
alter table "sales"."orders" enable row level security;
--> statement-breakpoint
alter table "sales"."orders" force row level security;
--> statement-breakpoint
drop policy if exists "orders_org_isolation" on "sales"."orders";
--> statement-breakpoint
create policy "orders_org_isolation" on "sales"."orders"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "sales" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "sales"."orders" to "erp_app";
--> statement-breakpoint
alter table "sales"."order_lines" enable row level security;
--> statement-breakpoint
alter table "sales"."order_lines" force row level security;
--> statement-breakpoint
drop policy if exists "order_lines_org_isolation" on "sales"."order_lines";
--> statement-breakpoint
create policy "order_lines_org_isolation" on "sales"."order_lines"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "sales" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "sales"."order_lines" to "erp_app";
--> statement-breakpoint
alter table "sales"."order_events" enable row level security;
--> statement-breakpoint
alter table "sales"."order_events" force row level security;
--> statement-breakpoint
drop policy if exists "order_events_org_isolation" on "sales"."order_events";
--> statement-breakpoint
create policy "order_events_org_isolation" on "sales"."order_events"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "sales" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert on "sales"."order_events" to "erp_app";
