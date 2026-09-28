-- What the catalog refuses, whoever writes it (M06, architecture §8).
--
-- Four guarantees, each one a trigger rather than a service rule, and each with a
-- failure mode that a service rule would not have prevented:
--
-- 1. A category tree that cannot loop, with a maintained path.
-- 2. A SKU's identity — its code and its place in the matrix — frozen after
--    creation, because it is printed on labels already in a warehouse.
-- 3. A price that cannot change without a history row.
-- 4. A product's search text that cannot fall behind its name or its SKUs.
--
-- The service enforces the same things in better words; these are here for the
-- repair script at 2 a.m., the importer that skips the service, and the next
-- module that writes a SKU without reading this one.

-- 1. The category tree.
--
-- `path` and `depth` are derived, so they are computed here rather than passed
-- in: a caller that supplies its own path can supply a wrong one, and a wrong
-- path silently breaks the "everything under Menswear" filter without breaking
-- anything visible.
--
-- The cycle check matters more than it looks. A parent chain that loops turns
-- every recursive read of the tree into a hang — not an error, a hang — and the
-- CHECK constraint in 0023 only catches the one-row case (`parent_id = id`). A
-- two-row loop (A's parent is B, B's parent is A) passes that check and is
-- created by two perfectly ordinary UPDATEs.
create or replace function catalog.category_before_write()
returns trigger
language plpgsql
as $$
declare
  parent_path text;
  parent_depth integer;
  ancestor uuid;
  hops integer := 0;
begin
  if new.parent_id is null then
    new.path := '/' || new.slug;
    new.depth := 0;
    return new;
  end if;

  select c.path, c.depth into parent_path, parent_depth
  from catalog.categories c
  where c.org_id = new.org_id and c.id = new.parent_id;

  if parent_path is null then
    -- The composite foreign key already refuses a parent in another org. This is
    -- the same-org-but-missing case, and it is raised rather than left to the FK
    -- so the message names the catalog rather than a constraint name.
    raise exception 'CATALOG_CATEGORY_INVALID: no parent category % in this organization', new.parent_id
      using errcode = 'foreign_key_violation';
  end if;

  -- Walk up from the proposed parent. Reaching this row means the edge closes a
  -- loop. Bounded by the depth CHECK plus a hard stop, so a tree already corrupt
  -- by some other route cannot make this walk the hang it is preventing.
  ancestor := new.parent_id;
  while ancestor is not null and hops <= 8 loop
    if ancestor = new.id then
      raise exception 'CATALOG_CATEGORY_CYCLE: that would make category % its own ancestor', new.id
        using errcode = 'check_violation';
    end if;
    select c.parent_id into ancestor from catalog.categories c
    where c.org_id = new.org_id and c.id = ancestor;
    hops := hops + 1;
  end loop;

  new.path := parent_path || '/' || new.slug;
  new.depth := parent_depth + 1;
  return new;
end;
$$;
--> statement-breakpoint
drop trigger if exists categories_before_write on "catalog"."categories";
--> statement-breakpoint
create trigger categories_before_write
  before insert or update on "catalog"."categories"
  for each row execute function catalog.category_before_write();
--> statement-breakpoint

-- Re-path the subtree when a category is renamed or moved.
--
-- A statement-level AFTER trigger would be cheaper, but this has to run per row
-- to know which subtree moved. It recurses through the same trigger on each
-- child, which is what keeps a three-level rename correct; `pg_trigger_depth()`
-- is not guarded because the depth CHECK bounds the recursion at four levels.
create or replace function catalog.category_after_move()
returns trigger
language plpgsql
as $$
begin
  if new.path is distinct from old.path then
    update catalog.categories c
    set path = new.path || substring(c.path from length(old.path) + 1),
        depth = new.depth + (c.depth - old.depth)
    where c.org_id = new.org_id and c.parent_id = new.id;
  end if;
  return null;
end;
$$;
--> statement-breakpoint
drop trigger if exists categories_after_move on "catalog"."categories";
--> statement-breakpoint
create trigger categories_after_move
  after update on "catalog"."categories"
  for each row execute function catalog.category_after_move();
--> statement-breakpoint

-- 2. A SKU's identity is frozen.
--
-- The code is printed on a label on a box, scanned at a showroom till and quoted
-- on a courier's sheet; the variant key is what M06 check 1 rests on, and the
-- product it belongs to is what M07's movements and M10's order lines join
-- through. Renaming a SKU in place makes every one of those disagree with the
-- database, and nothing detects it.
--
-- A price change, a barcode change, an archive and a reorder are all allowed:
-- those are the row's state, not its identity.
create or replace function catalog.sku_freeze_identity()
returns trigger
language plpgsql
as $$
begin
  if new.org_id is distinct from old.org_id
     or new.product_id is distinct from old.product_id
     or new.code is distinct from old.code
     or new.variant_key is distinct from old.variant_key then
    raise exception 'CATALOG_SKU_IMMUTABLE: SKU % can be repriced, rebarcoded, reordered or archived, nothing else',
      old.code
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
drop trigger if exists skus_freeze_identity on "catalog"."skus";
--> statement-breakpoint
create trigger skus_freeze_identity
  before update on "catalog"."skus"
  for each row execute function catalog.sku_freeze_identity();
--> statement-breakpoint

-- A product's sequence number is frozen for the same reason: every SKU code
-- under it contains that number as a stored string.
create or replace function catalog.product_freeze_sequence()
returns trigger
language plpgsql
as $$
begin
  if new.org_id is distinct from old.org_id or new.sequence is distinct from old.sequence then
    raise exception 'CATALOG_PRODUCT_IMMUTABLE: a product keeps the sequence number its SKU codes were built from'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
drop trigger if exists products_freeze_sequence on "catalog"."products";
--> statement-breakpoint
create trigger products_freeze_sequence
  before update on "catalog"."products"
  for each row execute function catalog.product_freeze_sequence();
--> statement-breakpoint

-- 3. A price cannot change without a history row.
--
-- Written by the database rather than by the service, because a service that
-- writes both can forget one — and the row it forgets is the evidence. The
-- `changed_by` and `reason` come from transaction-local settings the service sets
-- beside the update, so a bulk reprice records who and why without the trigger
-- needing to know anything about the caller.
create or replace function catalog.sku_record_price()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.price_poisha = old.price_poisha then
    return null;
  end if;

  insert into catalog.sku_price_history (org_id, sku_id, from_poisha, to_poisha, changed_by, reason)
  values (
    new.org_id,
    new.id,
    case when tg_op = 'UPDATE' then old.price_poisha end,
    new.price_poisha,
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
  after insert or update of price_poisha on "catalog"."skus"
  for each row execute function catalog.sku_record_price();
--> statement-breakpoint

-- 4. Search text that cannot fall behind.
--
-- `search_text` is what the trigram index in 0025 covers: the product's name and
-- slug plus every SKU code under it. Maintained here rather than in the service
-- because the failure is invisible — a renamed product that is still findable by
-- its old name looks like nothing at all until somebody cannot find it.
--
-- Lower-cased at write time so the query is a plain `like '%fragment%'` on an
-- already-folded column: `ilike` against a `gin_trgm_ops` index works, but
-- folding once on write beats folding on every scanned row.
create or replace function catalog.product_search_text()
returns trigger
language plpgsql
as $$
begin
  new.search_text := lower(
    new.name || ' ' || new.slug || ' ' ||
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
--> statement-breakpoint
drop trigger if exists products_search_text on "catalog"."products";
--> statement-breakpoint
create trigger products_search_text
  before insert or update on "catalog"."products"
  for each row execute function catalog.product_search_text();
--> statement-breakpoint

-- A SKU added, renamed or removed changes its product's search text. Touching
-- `updated_at` is what re-runs the function above; doing the concatenation in two
-- places would mean two spellings of the same rule.
create or replace function catalog.sku_touch_product()
returns trigger
language plpgsql
as $$
begin
  -- Two branches rather than one assignment from a CASE over OLD/NEW: plpgsql
  -- will not infer a record type from a conditional of two row variables, and
  -- the error surfaces at insert time rather than at migration time.
  if tg_op = 'DELETE' then
    update catalog.products set updated_at = now()
    where org_id = old.org_id and id = old.product_id;
  else
    update catalog.products set updated_at = now()
    where org_id = new.org_id and id = new.product_id;
  end if;
  return null;
end;
$$;
--> statement-breakpoint
drop trigger if exists skus_touch_product on "catalog"."skus";
--> statement-breakpoint
create trigger skus_touch_product
  after insert or delete on "catalog"."skus"
  for each row execute function catalog.sku_touch_product();
--> statement-breakpoint

-- The functions above run as the caller (`security invoker`, the default), so
-- every statement inside them is still subject to the org policy from 0024. A
-- `security definer` here would run as `erp_owner` and quietly bypass row
-- security for the reads they do — the one mistake that would turn these guards
-- into a cross-tenant hole. Left as invoker deliberately, and stated because the
-- temptation to add `security definer` arrives the first time one of them cannot
-- read a row it expected to see.
