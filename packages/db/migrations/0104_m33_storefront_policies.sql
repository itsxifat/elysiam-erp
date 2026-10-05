-- Tenant isolation, the size-chart reference and the slug history for M33: the brand's
-- website, run from its ERP (invariant 4, §5, §31; D-500 to D-506).
--
-- The policies are `tenantTableSql()`'s, pasted verbatim as every tenant policy in this repo
-- is (D-048). The grants are where the decisions are:
--
-- * `settings`: no DELETE. One row per brand; switching the website off is a setting, not
--   a missing row, and a deleted row would quietly fall back to the defaults.
-- * `web_locations`: INSERT and DELETE, no UPDATE. The set is replaced as a whole when the
--   brand changes where the website sells from; a row has nothing else to change.
-- * `hero_slides`, `nav_items`, `size_charts`: ordinary content, read and written in full.
-- * `legacy_ids`: INSERT and DELETE, no UPDATE. An old id maps to what it became once; an
--   import that is discarded takes its rows with it (M36).
-- * `site_keys`: UPDATE and no DELETE. A key is revoked, never removed, like the intake's.
--
-- No analytics read on any of them (D-049): nothing in §18 needs another brand's website.
--
-- The public storefront request reads these tables as `erp_app` inside `withOrg()` for the
-- org its key id names, like the intake: no bypass and no cross-org lookup.
--
-- The functions below run as the caller (`security invoker`, the default), so the reads and
-- the release they do are still subject to the org policy. A `security definer` here would
-- run as `erp_owner` and walk every brand's products.

alter table "storefront"."settings" enable row level security;
--> statement-breakpoint
alter table "storefront"."settings" force row level security;
--> statement-breakpoint
drop policy if exists "settings_org_isolation" on "storefront"."settings";
--> statement-breakpoint
create policy "settings_org_isolation" on "storefront"."settings"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "storefront" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "storefront"."settings" to "erp_app";
--> statement-breakpoint
alter table "storefront"."web_locations" enable row level security;
--> statement-breakpoint
alter table "storefront"."web_locations" force row level security;
--> statement-breakpoint
drop policy if exists "web_locations_org_isolation" on "storefront"."web_locations";
--> statement-breakpoint
create policy "web_locations_org_isolation" on "storefront"."web_locations"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "storefront" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, delete on "storefront"."web_locations" to "erp_app";
--> statement-breakpoint
alter table "storefront"."hero_slides" enable row level security;
--> statement-breakpoint
alter table "storefront"."hero_slides" force row level security;
--> statement-breakpoint
drop policy if exists "hero_slides_org_isolation" on "storefront"."hero_slides";
--> statement-breakpoint
create policy "hero_slides_org_isolation" on "storefront"."hero_slides"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "storefront" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update, delete on "storefront"."hero_slides" to "erp_app";
--> statement-breakpoint
alter table "storefront"."nav_items" enable row level security;
--> statement-breakpoint
alter table "storefront"."nav_items" force row level security;
--> statement-breakpoint
drop policy if exists "nav_items_org_isolation" on "storefront"."nav_items";
--> statement-breakpoint
create policy "nav_items_org_isolation" on "storefront"."nav_items"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "storefront" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update, delete on "storefront"."nav_items" to "erp_app";
--> statement-breakpoint
alter table "storefront"."size_charts" enable row level security;
--> statement-breakpoint
alter table "storefront"."size_charts" force row level security;
--> statement-breakpoint
drop policy if exists "size_charts_org_isolation" on "storefront"."size_charts";
--> statement-breakpoint
create policy "size_charts_org_isolation" on "storefront"."size_charts"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "storefront" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update, delete on "storefront"."size_charts" to "erp_app";
--> statement-breakpoint
alter table "storefront"."legacy_ids" enable row level security;
--> statement-breakpoint
alter table "storefront"."legacy_ids" force row level security;
--> statement-breakpoint
drop policy if exists "legacy_ids_org_isolation" on "storefront"."legacy_ids";
--> statement-breakpoint
create policy "legacy_ids_org_isolation" on "storefront"."legacy_ids"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "storefront" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, delete on "storefront"."legacy_ids" to "erp_app";
--> statement-breakpoint
alter table "storefront"."site_keys" enable row level security;
--> statement-breakpoint
alter table "storefront"."site_keys" force row level security;
--> statement-breakpoint
drop policy if exists "site_keys_org_isolation" on "storefront"."site_keys";
--> statement-breakpoint
create policy "site_keys_org_isolation" on "storefront"."site_keys"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "storefront" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "storefront"."site_keys" to "erp_app";
--> statement-breakpoint

-- A product points at a size chart of its own brand (D-502). Declared here rather than in the
-- catalog's Drizzle file, which would then import the storefront's while the storefront's
-- imports the catalog's. Restrict: a chart in use is not deleted (the service says which
-- products use it first).
alter table "catalog"."products"
  add constraint "products_org_id_size_chart_id_fk"
  foreign key ("org_id", "size_chart_id")
  references "storefront"."size_charts" ("org_id", "id")
  on delete restrict;
--> statement-breakpoint
create index "products_org_size_chart_idx" on "catalog"."products" ("org_id", "size_chart_id")
  where "size_chart_id" is not null;
--> statement-breakpoint

-- Old addresses (D-500; the domain's `recordSlugChange` and `releaseSlug`).
--
-- Before a write: a slug the product leaves goes to the front of its history; the history
-- loses repeats, the product's own current slug and any slug that is another product's
-- current slug in this brand, and keeps the newest twenty. After a write that sets a slug:
-- every other product of the brand forgets that slug, because the address now belongs to the
-- product standing at it. Together they keep a slug in at most one place across the brand's
-- current slugs and histories, which is what lets a redirect never have to choose.
create or replace function catalog.product_slug_history()
returns trigger
language plpgsql
as $$
declare
  history text[] := coalesce(new.previous_slugs, '{}'::text[]);
begin
  if tg_op = 'UPDATE' and new.slug is distinct from old.slug then
    history := array_prepend(old.slug, history);
  end if;

  select coalesce(array_agg(kept.entry order by kept.first_at), '{}'::text[])
    into history
  from (
    select listed.entry, min(listed.place) as first_at
    from unnest(history) with ordinality as listed(entry, place)
    where listed.entry <> new.slug
      and listed.entry ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
      and not exists (
        select 1 from catalog.products other
        where other.org_id = new.org_id and other.id <> new.id and other.slug = listed.entry
      )
    group by listed.entry
  ) kept;

  new.previous_slugs := history[1:20];
  return new;
end;
$$;
--> statement-breakpoint
drop trigger if exists products_slug_history on "catalog"."products";
--> statement-breakpoint
create trigger products_slug_history
  before insert or update of slug, previous_slugs on "catalog"."products"
  for each row execute function catalog.product_slug_history();
--> statement-breakpoint
create or replace function catalog.product_slug_release()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' or new.slug is distinct from old.slug then
    update catalog.products
       set previous_slugs = array_remove(previous_slugs, new.slug)
     where org_id = new.org_id
       and id <> new.id
       and previous_slugs @> array[new.slug];
  end if;
  return null;
end;
$$;
--> statement-breakpoint
drop trigger if exists products_slug_release on "catalog"."products";
--> statement-breakpoint
create trigger products_slug_release
  after insert or update of slug on "catalog"."products"
  for each row execute function catalog.product_slug_release();
--> statement-breakpoint

-- Search text (0026) gains the website's words: tags and material (D-506's `q`). Existing rows
-- have neither yet, so nothing needs recomputing.
create or replace function catalog.product_search_text()
returns trigger
language plpgsql
as $$
begin
  new.search_text := lower(
    new.name || ' ' || new.slug || ' ' ||
    coalesce(array_to_string(new.tags, ' '), '') || ' ' ||
    coalesce(new.material, '') || ' ' ||
    coalesce(
      (select string_agg(s.code, ' ' order by s.code)
       from catalog.skus s
       where s.org_id = new.org_id and s.product_id = new.id),
      ''
    )
  );
  return new;
end;
$$;
