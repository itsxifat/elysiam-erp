-- Tenant isolation for the catalog (invariant 4, architecture §5, §8).
--
-- Emitted by `tenantTableSql()` in packages/db/src/rls.ts and pasted verbatim, the
-- way every tenant policy in this repository is. A policy that differs by one
-- character fails silently — it returns rows rather than throwing, and the wrong
-- rows look like the right ones (D-048) — so the expression is generated, never
-- typed.
--
-- Why it does visible work here rather than satisfying a rule: five fashion
-- brands share one database and they compete. A product name, its selling price
-- and its SKU list are commercially sensitive between them, and a SKU id appears
-- in a URL, so a uuid copied out of one brand's console must not resolve in
-- another's.
--
-- Grants:
--
-- * Full read/write on the catalogue proper. A product is drafted, renamed,
--   repriced, given images and archived; none of those are records of something
--   that happened, they are the row's own state.
-- * `sku_price_history` is **append-only** — select and insert, no update or
--   delete. It is the answer to "why is this shirt ৳300 cheaper than last week",
--   asked exactly when nobody remembers, and an answer that can be edited is not
--   one. It is also listed in `APPEND_ONLY_TABLES` so the privilege guard
--   enumerates it rather than trusting this file.
-- * No analytics read on any of them. §18's metrics need revenue and quantities,
--   which come from orders; nothing there needs a cross-org read of another
--   brand's product names and prices, and a read-only role is still a role that
--   can read (D-049).
alter table "catalog"."sku_settings" enable row level security;--> statement-breakpoint
alter table "catalog"."sku_settings" force row level security;--> statement-breakpoint
drop policy if exists "sku_settings_org_isolation" on "catalog"."sku_settings";--> statement-breakpoint
create policy "sku_settings_org_isolation" on "catalog"."sku_settings"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "catalog" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update, delete on "catalog"."sku_settings" to "erp_app";--> statement-breakpoint

alter table "catalog"."categories" enable row level security;--> statement-breakpoint
alter table "catalog"."categories" force row level security;--> statement-breakpoint
drop policy if exists "categories_org_isolation" on "catalog"."categories";--> statement-breakpoint
create policy "categories_org_isolation" on "catalog"."categories"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant select, insert, update, delete on "catalog"."categories" to "erp_app";--> statement-breakpoint

alter table "catalog"."attributes" enable row level security;--> statement-breakpoint
alter table "catalog"."attributes" force row level security;--> statement-breakpoint
drop policy if exists "attributes_org_isolation" on "catalog"."attributes";--> statement-breakpoint
create policy "attributes_org_isolation" on "catalog"."attributes"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant select, insert, update, delete on "catalog"."attributes" to "erp_app";--> statement-breakpoint

alter table "catalog"."attribute_values" enable row level security;--> statement-breakpoint
alter table "catalog"."attribute_values" force row level security;--> statement-breakpoint
drop policy if exists "attribute_values_org_isolation" on "catalog"."attribute_values";--> statement-breakpoint
create policy "attribute_values_org_isolation" on "catalog"."attribute_values"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant select, insert, update, delete on "catalog"."attribute_values" to "erp_app";--> statement-breakpoint

alter table "catalog"."products" enable row level security;--> statement-breakpoint
alter table "catalog"."products" force row level security;--> statement-breakpoint
drop policy if exists "products_org_isolation" on "catalog"."products";--> statement-breakpoint
create policy "products_org_isolation" on "catalog"."products"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant select, insert, update, delete on "catalog"."products" to "erp_app";--> statement-breakpoint

alter table "catalog"."skus" enable row level security;--> statement-breakpoint
alter table "catalog"."skus" force row level security;--> statement-breakpoint
drop policy if exists "skus_org_isolation" on "catalog"."skus";--> statement-breakpoint
create policy "skus_org_isolation" on "catalog"."skus"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant select, insert, update, delete on "catalog"."skus" to "erp_app";--> statement-breakpoint

alter table "catalog"."sku_values" enable row level security;--> statement-breakpoint
alter table "catalog"."sku_values" force row level security;--> statement-breakpoint
drop policy if exists "sku_values_org_isolation" on "catalog"."sku_values";--> statement-breakpoint
create policy "sku_values_org_isolation" on "catalog"."sku_values"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant select, insert, update, delete on "catalog"."sku_values" to "erp_app";--> statement-breakpoint

alter table "catalog"."sku_price_history" enable row level security;--> statement-breakpoint
alter table "catalog"."sku_price_history" force row level security;--> statement-breakpoint
drop policy if exists "sku_price_history_org_isolation" on "catalog"."sku_price_history";--> statement-breakpoint
create policy "sku_price_history_org_isolation" on "catalog"."sku_price_history"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant select, insert on "catalog"."sku_price_history" to "erp_app";--> statement-breakpoint

alter table "catalog"."product_images" enable row level security;--> statement-breakpoint
alter table "catalog"."product_images" force row level security;--> statement-breakpoint
drop policy if exists "product_images_org_isolation" on "catalog"."product_images";--> statement-breakpoint
create policy "product_images_org_isolation" on "catalog"."product_images"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant select, insert, update, delete on "catalog"."product_images" to "erp_app";
