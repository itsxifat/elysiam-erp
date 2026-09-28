-- Finding a supplier, and finding what a supplier delivered (M09).
--
-- Two indexes, both for the same screen: the supplier picker on the supply-entry form.
-- The person filling it in has a challan in their hand and knows the mill by half its
-- name — "Pahartoli", "Rahman acc" — or by the phone number they just called.
--
-- Trigram rather than full-text search, for the reason M06's catalog search gives at
-- length: `to_tsvector` tokenises on word boundaries, so a fragment of a code
-- (`SUP-014`) or a phone number cannot be reached by a substring query, and there is no
-- Bangla stemmer in PostgreSQL's default configuration — a Bangla supplier name would
-- be indexed by the `simple` dictionary, which is trigram search with extra steps.
-- Without an index, `ILIKE '%…%'` is a sequential scan over every supplier in the
-- brand, which is fine at fifty suppliers and is not the shape to build on.
--
-- `pg_trgm` is created by migration 0025 in `public`; `create extension if not exists`
-- here so this migration also stands alone on a database where the catalog's search
-- migration has not run.
--
-- The composite index is the supplier statement's own lookup: entries for one supplier
-- in date order, which is exactly how the statement reads them, so the ordering comes
-- off the index rather than out of a sort.

create extension if not exists pg_trgm with schema public;--> statement-breakpoint

create index "suppliers_org_name_trgm_idx" on "supply"."suppliers"
  using gin (name public.gin_trgm_ops);--> statement-breakpoint

create index "suppliers_org_contact_trgm_idx" on "supply"."suppliers"
  using gin ((coalesce(code, '') || ' ' || coalesce(phone, '')) public.gin_trgm_ops);--> statement-breakpoint

create index "supplies_org_supplier_date_idx" on "supply"."supplies"
  using btree ("org_id", "supplier_id", "business_date" desc);
