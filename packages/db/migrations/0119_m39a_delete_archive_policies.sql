-- Delete and archive everywhere (M39a, D-621 to D-634).
--
-- 0118 made four foreign keys cascade so a row nothing references can be deleted with the
-- rows that exist only because of it: a SKU's price history and its empty stock rows, a
-- location's empty stock rows, a discount's tiers, a flash sale's items. `erp_app` gains no
-- DELETE on any of those tables, so the cascade is the only way a row leaves them, and the
-- triggers below refuse every other delete, for every role, `erp_owner` included:
--
--   1. a price history row while its SKU exists (the evidence for every price it had);
--   2. a stock level that holds or reserves a piece, ever, and an empty one while its SKU
--      and its location both exist (invariant 3: stock changes only through movements);
--   3. a discount's tier while its discount exists (terms are frozen, D-541);
--   4. a flash sale item while its sale exists (claims name it, D-542).
--
-- Each parent keeps every other foreign key `restrict`, so a SKU with a movement, an order
-- line, a till line, a supply line, a courier return line or a lead is never deleted, nor a
-- discount with a redemption, nor a sale with a claim. The module's own pre-check names
-- those first (the `CatalogReferences` port and its siblings, D-621); these are the backstop.
--
-- The functions run as the caller (`security invoker`, the default), like every guard in
-- 0026 and 0104: a `security definer` here would run as `erp_owner` and read across brands.
-- During a cascade PostgreSQL runs the delete as the referencing table's owner with row
-- security off, so each read below names the row's own `org_id`.
--
-- Then the grants a delete of an unused row needs (D-630 to D-632), and a guard for the one
-- parent whose children name it by text rather than by key (SMS templates).

-- 1. Price history leaves only with its SKU.
create or replace function catalog.refuse_price_history_delete()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from catalog.skus s where s.org_id = old.org_id and s.id = old.sku_id
  ) then
    raise exception 'CATALOG_IN_USE: a SKU''s price history stays while the SKU exists'
      using errcode = 'foreign_key_violation';
  end if;
  return old;
end;
$$;
--> statement-breakpoint
drop trigger if exists sku_price_history_delete_guard on "catalog"."sku_price_history";
--> statement-breakpoint
create trigger sku_price_history_delete_guard
  before delete on "catalog"."sku_price_history"
  for each row execute function catalog.refuse_price_history_delete();
--> statement-breakpoint

-- 2. A stock level leaves only empty, and only with its SKU or its location.
create or replace function inventory.refuse_stock_level_delete()
returns trigger
language plpgsql
as $$
begin
  if old.on_hand <> 0 or old.reserved <> 0 then
    raise exception 'INVENTORY_IN_USE: a stock level holding % pieces (% reserved) is never deleted',
      old.on_hand, old.reserved
      using errcode = 'foreign_key_violation';
  end if;
  if exists (
       select 1 from catalog.skus s where s.org_id = old.org_id and s.id = old.sku_id
     )
     and exists (
       select 1 from org.locations l where l.org_id = old.org_id and l.id = old.location_id
     ) then
    raise exception 'INVENTORY_IN_USE: a stock level leaves only with its SKU or its location'
      using errcode = 'foreign_key_violation';
  end if;
  return old;
end;
$$;
--> statement-breakpoint
drop trigger if exists stock_levels_delete_guard on "inventory"."stock_levels";
--> statement-breakpoint
create trigger stock_levels_delete_guard
  before delete on "inventory"."stock_levels"
  for each row execute function inventory.refuse_stock_level_delete();
--> statement-breakpoint

-- 3. A discount's tiers leave only with the discount.
create or replace function promo.refuse_tier_delete()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from promo.codes c where c.org_id = old.org_id and c.id = old.code_id
  ) then
    raise exception 'PROMO_IN_USE: a discount''s tiers are its terms and stay while it exists'
      using errcode = 'foreign_key_violation';
  end if;
  return old;
end;
$$;
--> statement-breakpoint
drop trigger if exists discount_tiers_delete_guard on "promo"."discount_tiers";
--> statement-breakpoint
create trigger discount_tiers_delete_guard
  before delete on "promo"."discount_tiers"
  for each row execute function promo.refuse_tier_delete();
--> statement-breakpoint

-- 4. A flash sale's items leave only with the sale.
create or replace function promo.refuse_flash_item_delete()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from promo.flash_sales f where f.org_id = old.org_id and f.id = old.flash_sale_id
  ) then
    raise exception 'PROMO_IN_USE: a flash sale''s items are switched off, never removed'
      using errcode = 'foreign_key_violation';
  end if;
  return old;
end;
$$;
--> statement-breakpoint
drop trigger if exists flash_sale_items_delete_guard on "promo"."flash_sale_items";
--> statement-breakpoint
create trigger flash_sale_items_delete_guard
  before delete on "promo"."flash_sale_items"
  for each row execute function promo.refuse_flash_item_delete();
--> statement-breakpoint

-- 5. An SMS template that was ever sent stays. `notify.messages` and `notify.emails` name it
-- by key rather than by a foreign key (a system message's key exists before any template row
-- does), so this is the only thing that holds the history to it.
create or replace function notify.refuse_sent_template_delete()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from notify.messages m where m.org_id = old.org_id and m.template_key = old.key
  ) then
    raise exception 'NOTIFY_IN_USE: template % was sent, so it is switched off rather than deleted',
      old.key
      using errcode = 'foreign_key_violation';
  end if;
  return old;
end;
$$;
--> statement-breakpoint
drop trigger if exists templates_delete_guard on "notify"."templates";
--> statement-breakpoint
create trigger templates_delete_guard
  before delete on "notify"."templates"
  for each row execute function notify.refuse_sent_template_delete();
--> statement-breakpoint

-- 6. Deleting a row nothing references. Every child keeps its `restrict` key.
grant delete on "supply"."suppliers" to "erp_app";
--> statement-breakpoint
grant delete on "promo"."codes" to "erp_app";
--> statement-breakpoint
grant delete on "promo"."flash_sales" to "erp_app";
--> statement-breakpoint
grant delete on "notify"."templates" to "erp_app";
--> statement-breakpoint
grant delete on "marketing"."campaigns" to "erp_app";
