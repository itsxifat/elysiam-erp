-- M39b: variant prices, buying prices and product management (D-635 to D-649).
--
-- Three things Drizzle cannot express, beside 0118's columns and table:
--
-- 1. Tenant isolation and grants for `supply.sku_purchase_prices` (the standard buying price,
--    D-638), `tenantTableSql()`'s output pasted verbatim like every other tenant table's
--    (D-048). Select, insert, update and delete for `erp_app`: a standard price is a
--    preference that is set, changed and removed, never history. No analytics read:
--    `standard_unit_cost_poisha` is purchase cost (invariant 5).
-- 2. The composite foreign keys that name only one column to clear on delete
--    (`on delete set null (column)`, PostgreSQL 15+): a photo's colour (D-643) and a
--    category's default size chart (D-646). Setting the whole key to null would null
--    `org_id` too, which the NOT NULL refuses; clearing only the reference is the point.
-- 3. The price-history trigger, widened to the regular price (D-640): a row whenever the
--    selling price or the regular price changes, so "why was this struck through at ৳1,890"
--    has the same evidence a price change has.

alter table "supply"."sku_purchase_prices" enable row level security;--> statement-breakpoint
alter table "supply"."sku_purchase_prices" force row level security;--> statement-breakpoint
drop policy if exists "sku_purchase_prices_org_isolation" on "supply"."sku_purchase_prices";--> statement-breakpoint
create policy "sku_purchase_prices_org_isolation" on "supply"."sku_purchase_prices"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "supply" to "erp_app";--> statement-breakpoint
grant select, insert, update, delete on "supply"."sku_purchase_prices" to "erp_app";--> statement-breakpoint

-- A photo shows one of the brand's colours, or every colour (null). Deleting a colour value
-- (M39a: only one no variant uses) clears the photo's colour rather than being refused.
alter table "catalog"."product_images"
  add constraint "product_images_org_id_colour_value_id_fk"
  foreign key ("org_id", "colour_value_id")
  references "catalog"."attribute_values" ("org_id", "id")
  on delete set null ("colour_value_id");
--> statement-breakpoint

-- A category's default size chart is a convenience for new products (D-646); deleting the
-- chart clears the default. A product's own chart keeps 0104's restrict.
alter table "catalog"."categories"
  add constraint "categories_org_id_default_size_chart_id_fk"
  foreign key ("org_id", "default_size_chart_id")
  references "storefront"."size_charts" ("org_id", "id")
  on delete set null ("default_size_chart_id");
--> statement-breakpoint
create index "categories_org_default_size_chart_idx"
  on "catalog"."categories" ("org_id", "default_size_chart_id")
  where "default_size_chart_id" is not null;
--> statement-breakpoint

-- The price history, widened to the regular price. Replaces 0026's function; same rule: a
-- price cannot change without a history row, written by the database, never the service.
create or replace function catalog.sku_record_price()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE'
     and new.price_poisha = old.price_poisha
     and new.compare_at_poisha is not distinct from old.compare_at_poisha then
    return null;
  end if;

  insert into catalog.sku_price_history
    (org_id, sku_id, from_poisha, to_poisha, compare_at_from_poisha, compare_at_to_poisha,
     changed_by, reason)
  values (
    new.org_id,
    new.id,
    case when tg_op = 'UPDATE' then old.price_poisha end,
    new.price_poisha,
    case when tg_op = 'UPDATE' then old.compare_at_poisha end,
    new.compare_at_poisha,
    nullif(current_setting('app.user_id', true), ''),
    nullif(current_setting('app.price_reason', true), '')
  );
  return null;
end;
$$;
--> statement-breakpoint
drop trigger if exists skus_record_price on "catalog"."skus";
--> statement-breakpoint
create trigger skus_record_price
  after insert or update of price_poisha, compare_at_poisha on "catalog"."skus"
  for each row execute function catalog.sku_record_price();
