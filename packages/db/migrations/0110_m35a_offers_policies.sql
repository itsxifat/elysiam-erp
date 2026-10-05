-- Tenant isolation for M35a's tables (invariant 4, §5).
--
-- Emitted by `tenantTableSql()` in `packages/db/src/rls.ts` and pasted verbatim, as every
-- tenant policy in this repo is (D-048). The grants are where the decisions are:
--
-- * `promo.discount_tiers`: INSERT and SELECT only. A tier is part of a discount's terms,
--   and the terms are fixed once the discount exists (D-541).
-- * `promo.flash_sales`: UPDATE as the sale is edited, switched on and off; never DELETE.
--   A sale that sold units is the record of the price they sold at.
-- * `promo.flash_sale_items`: UPDATE for the price, the limit, switching a SKU off and the
--   sold count; never DELETE, because claims name the row.
-- * `promo.flash_claims`: UPDATE only to release a claim (0105 refuses any other change);
--   never DELETE.
--
-- No analytics read on any of them.

alter table "promo"."discount_tiers" enable row level security;
--> statement-breakpoint
alter table "promo"."discount_tiers" force row level security;
--> statement-breakpoint
drop policy if exists "discount_tiers_org_isolation" on "promo"."discount_tiers";
--> statement-breakpoint
create policy "discount_tiers_org_isolation" on "promo"."discount_tiers"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "promo" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert on "promo"."discount_tiers" to "erp_app";
--> statement-breakpoint
alter table "promo"."flash_sales" enable row level security;
--> statement-breakpoint
alter table "promo"."flash_sales" force row level security;
--> statement-breakpoint
drop policy if exists "flash_sales_org_isolation" on "promo"."flash_sales";
--> statement-breakpoint
create policy "flash_sales_org_isolation" on "promo"."flash_sales"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "promo" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "promo"."flash_sales" to "erp_app";
--> statement-breakpoint
alter table "promo"."flash_sale_items" enable row level security;
--> statement-breakpoint
alter table "promo"."flash_sale_items" force row level security;
--> statement-breakpoint
drop policy if exists "flash_sale_items_org_isolation" on "promo"."flash_sale_items";
--> statement-breakpoint
create policy "flash_sale_items_org_isolation" on "promo"."flash_sale_items"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "promo" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "promo"."flash_sale_items" to "erp_app";
--> statement-breakpoint
alter table "promo"."flash_claims" enable row level security;
--> statement-breakpoint
alter table "promo"."flash_claims" force row level security;
--> statement-breakpoint
drop policy if exists "flash_claims_org_isolation" on "promo"."flash_claims";
--> statement-breakpoint
create policy "flash_claims_org_isolation" on "promo"."flash_claims"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "promo" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "promo"."flash_claims" to "erp_app";
