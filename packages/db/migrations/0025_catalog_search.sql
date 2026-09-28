-- Catalog search (M06 acceptance check 2: SKU search under 200 ms p95 on 20k SKUs).
--
-- `pg_trgm` and two GIN indexes. The reason it is trigram search and not
-- full-text search is what people actually type into a catalog box: a fragment of
-- a SKU code (`0001-RED`), a misremembered product name, or a name in Bangla.
--
-- * `to_tsvector` would be wrong twice over here. It tokenises on word
--   boundaries, so `ELY-SHRT-0001-RED-M` becomes tokens a substring query cannot
--   reach — searching `0001` finds nothing. And there is no Bangla stemmer in
--   PostgreSQL's default configuration, so a Bangla product name would be indexed
--   by the `simple` dictionary with no stemming and no stop words, which is
--   trigram search with extra steps.
-- * `LIKE '%…%'` without a trigram index is a sequential scan over every SKU in
--   the brand, which is the 200 ms the check is about.
--
-- `gin_trgm_ops` supports `LIKE '%x%'`, `ILIKE` and the `%` similarity operator
-- from the same index, so the same index serves "contains" filtering and
-- similarity ranking.
--
-- The extension is created in `public` rather than in `catalog`: an extension is
-- a database-wide object, and putting the operator classes in a module's schema
-- would mean every other module's search had to qualify them or extend its
-- `search_path`. `if not exists` because another milestone may get here first.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint

-- Products are searched by `search_text`, which is the name, the slug and every
-- SKU code of that product joined together — maintained by the trigger in 0026.
-- A trigram index cannot span a join, and a product whose SKU code matches has to
-- be findable by that code, which is why the column exists at all.
CREATE INDEX "products_search_trgm_idx" ON "catalog"."products" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint

-- SKUs are searched by code directly, for the scanner-and-keyboard path: the
-- picker types the tail of a code and wants that one row, not its product.
CREATE INDEX "skus_code_trgm_idx" ON "catalog"."skus" USING gin ("code" gin_trgm_ops);--> statement-breakpoint

-- Exact-prefix lookups — a barcode scan, a code pasted from a courier sheet — go
-- through the btree unique indexes from 0023 and never touch these.
--
-- `pg_trgm` splits on non-alphanumerics, so a two-character search fragment
-- produces no trigrams and the planner falls back to a scan. The repository
-- therefore requires three characters before it searches, rather than quietly
-- becoming slow at two.
COMMENT ON INDEX "catalog"."products_search_trgm_idx" IS 'M06 check 2: substring product search. Needs a 3-character fragment to be selective.';--> statement-breakpoint
COMMENT ON INDEX "catalog"."skus_code_trgm_idx" IS 'M06 check 2: substring SKU code search.';
