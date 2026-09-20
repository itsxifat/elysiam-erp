-- Foreign keys between tenant tables must include org_id (D-047).
--
-- PostgreSQL runs referential-integrity checks with row security bypassed, so
-- a plain `branch_id references org.branches(id)` lets one org reference
-- another org's row even though it cannot see it. Verified against a running
-- database before this migration was written: org A inserted a location
-- pointing at org B's branch and the insert succeeded.
--
-- Three consequences, all reproduced:
--   1. Cross-org referential corruption — org A owns a location bound to org
--      B's branch, which from M07 is a stock location belonging to another
--      company.
--   2. Cross-org denial of service — org B cannot delete its own branch,
--      because a referencing row it cannot see blocks it, with an error it
--      cannot act on.
--   3. An existence oracle — a real foreign uuid inserts cleanly while a
--      nonexistent one raises "Key is not present in table", giving org A a
--      binary probe on any uuid in any org.
--
-- The fix carries org_id through the reference, so the constraint can only be
-- satisfied by a row in the same org. This is the pattern every future
-- intra-tenant foreign key follows: orders.branch_id, stock_levels.location_id,
-- journal_lines.account_id.

alter table "org"."branches"
  add constraint "branches_org_id_id_key" unique ("org_id", "id");
--> statement-breakpoint

alter table "org"."locations"
  drop constraint if exists "locations_branch_id_branches_id_fk";
--> statement-breakpoint

alter table "org"."locations"
  add constraint "locations_org_id_branch_id_fk"
  foreign key ("org_id", "branch_id") references "org"."branches" ("org_id", "id")
  on delete restrict;
--> statement-breakpoint

-- Duplicate org_id indexes: the Drizzle schema declares `<table>_org_idx` and
-- tenantTableSql() also emitted `<table>_org_id_idx`. Byte-identical
-- definitions, both maintained on every write. The Drizzle one stays, because
-- `pnpm db:generate` can see it.
drop index if exists "org"."branches_org_id_idx";
--> statement-breakpoint
drop index if exists "org"."locations_org_id_idx";
--> statement-breakpoint
drop index if exists "org"."settings_org_id_idx";
--> statement-breakpoint
drop index if exists "org"."feature_flags_org_id_idx";
