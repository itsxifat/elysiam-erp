-- The owner's reporting reads (§5 exception 3; D-469, D-483).
--
-- With one brand per database (D-469), the owner's cross-brand figures are read from each
-- brand's database through `erp_analytics`, the role that already reads every org's ledger
-- and daily rollup and can write nothing. This widens what it may READ, by the least that
-- the owner's figures need, and nothing it may write:
--
-- * `analytics.daily_channel` and `analytics.daily_campaign`, whole: counts and sums per
--   day, no buyer and no cost.
-- * Column grants, never the whole table, where a table also holds a person's details or a
--   cost. Every column named below is a count, a status, a code, a name the brand gave a
--   product, place, courier or campaign, a selling price or a date. Not granted, and so
--   unreadable by this role: the buyer's name, phone and address, an order's notes and
--   source, who took it, a line's dispatch cost, a SKU's barcode, every staff member's
--   phone, national id, payout details and salary.
-- * `drizzle.__drizzle_migrations`, so a reader can see which version of this schema the
--   database holds before it reads anything else.
--
-- Each tenant table gets the generated cross-org SELECT policy (`<table>_analytics_all_orgs`,
-- as `tenantTableSql` writes it), because FORCE RLS shows this role nothing otherwise. The
-- guard (`findAnalyticsReadProblems`) holds the role to exactly the tables in
-- `ANALYTICS_READABLE` and the columns in `ANALYTICS_READABLE_COLUMNS`.

grant usage on schema "analytics" to "erp_analytics";
--> statement-breakpoint
grant select on "analytics"."daily_channel" to "erp_analytics";
--> statement-breakpoint
drop policy if exists "daily_channel_analytics_all_orgs" on "analytics"."daily_channel";
--> statement-breakpoint
create policy "daily_channel_analytics_all_orgs" on "analytics"."daily_channel"
  for select to "erp_analytics"
  using (true);
--> statement-breakpoint
grant select on "analytics"."daily_campaign" to "erp_analytics";
--> statement-breakpoint
drop policy if exists "daily_campaign_analytics_all_orgs" on "analytics"."daily_campaign";
--> statement-breakpoint
create policy "daily_campaign_analytics_all_orgs" on "analytics"."daily_campaign"
  for select to "erp_analytics"
  using (true);
--> statement-breakpoint
grant usage on schema "sales" to "erp_analytics";
--> statement-breakpoint
grant select (id, org_id, order_no, channel, status, items_poisha, discount_poisha,
  delivery_charge_poisha, created_at, confirmed_at, delivered_at, returned_at, cancelled_at)
  on "sales"."orders" to "erp_analytics";
--> statement-breakpoint
drop policy if exists "orders_analytics_all_orgs" on "sales"."orders";
--> statement-breakpoint
create policy "orders_analytics_all_orgs" on "sales"."orders"
  for select to "erp_analytics"
  using (true);
--> statement-breakpoint
grant select (org_id, order_id, sku_id, sku_code, product_name, qty, unit_price_poisha,
  discount_poisha, delivered_qty, returned_qty)
  on "sales"."order_lines" to "erp_analytics";
--> statement-breakpoint
drop policy if exists "order_lines_analytics_all_orgs" on "sales"."order_lines";
--> statement-breakpoint
create policy "order_lines_analytics_all_orgs" on "sales"."order_lines"
  for select to "erp_analytics"
  using (true);
--> statement-breakpoint
grant select (id, org_id, code, name) on "sales"."couriers" to "erp_analytics";
--> statement-breakpoint
drop policy if exists "couriers_analytics_all_orgs" on "sales"."couriers";
--> statement-breakpoint
create policy "couriers_analytics_all_orgs" on "sales"."couriers"
  for select to "erp_analytics"
  using (true);
--> statement-breakpoint
grant usage on schema "catalog" to "erp_analytics";
--> statement-breakpoint
grant select (id, org_id, product_id, code, status) on "catalog"."skus" to "erp_analytics";
--> statement-breakpoint
drop policy if exists "skus_analytics_all_orgs" on "catalog"."skus";
--> statement-breakpoint
create policy "skus_analytics_all_orgs" on "catalog"."skus"
  for select to "erp_analytics"
  using (true);
--> statement-breakpoint
grant select (id, org_id, name, status) on "catalog"."products" to "erp_analytics";
--> statement-breakpoint
drop policy if exists "products_analytics_all_orgs" on "catalog"."products";
--> statement-breakpoint
create policy "products_analytics_all_orgs" on "catalog"."products"
  for select to "erp_analytics"
  using (true);
--> statement-breakpoint
grant usage on schema "inventory" to "erp_analytics";
--> statement-breakpoint
grant select (org_id, sku_id, location_id, on_hand, reserved, reorder_level)
  on "inventory"."stock_levels" to "erp_analytics";
--> statement-breakpoint
drop policy if exists "stock_levels_analytics_all_orgs" on "inventory"."stock_levels";
--> statement-breakpoint
create policy "stock_levels_analytics_all_orgs" on "inventory"."stock_levels"
  for select to "erp_analytics"
  using (true);
--> statement-breakpoint
grant usage on schema "org" to "erp_analytics";
--> statement-breakpoint
grant select (id, org_id, code, name) on "org"."branches" to "erp_analytics";
--> statement-breakpoint
drop policy if exists "branches_analytics_all_orgs" on "org"."branches";
--> statement-breakpoint
create policy "branches_analytics_all_orgs" on "org"."branches"
  for select to "erp_analytics"
  using (true);
--> statement-breakpoint
grant select (id, org_id, code, name) on "org"."locations" to "erp_analytics";
--> statement-breakpoint
drop policy if exists "locations_analytics_all_orgs" on "org"."locations";
--> statement-breakpoint
create policy "locations_analytics_all_orgs" on "org"."locations"
  for select to "erp_analytics"
  using (true);
--> statement-breakpoint
grant usage on schema "hr" to "erp_analytics";
--> statement-breakpoint
grant select (id, org_id, branch_id, code, full_name, designation, status, join_date, leave_date)
  on "hr"."employees" to "erp_analytics";
--> statement-breakpoint
drop policy if exists "employees_analytics_all_orgs" on "hr"."employees";
--> statement-breakpoint
create policy "employees_analytics_all_orgs" on "hr"."employees"
  for select to "erp_analytics"
  using (true);
--> statement-breakpoint
grant usage on schema "marketing" to "erp_analytics";
--> statement-breakpoint
grant select (id, org_id, name) on "marketing"."campaigns" to "erp_analytics";
--> statement-breakpoint
drop policy if exists "campaigns_analytics_all_orgs" on "marketing"."campaigns";
--> statement-breakpoint
create policy "campaigns_analytics_all_orgs" on "marketing"."campaigns"
  for select to "erp_analytics"
  using (true);
--> statement-breakpoint
grant usage on schema "drizzle" to "erp_analytics";
--> statement-breakpoint
grant select on "drizzle"."__drizzle_migrations" to "erp_analytics";
