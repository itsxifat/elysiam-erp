-- Foreign keys between tenant tables must carry org_id (D-047).
--
-- PostgreSQL runs referential-integrity checks with row security bypassed, so
-- a plain `branch_id references org.branches(id)` can be satisfied by another
-- org's row. Verified against a running database before this was written: as
-- erp_app in org A's context, inserting a location pointing at org B's branch
-- succeeded, while org A could see none of org B's branches.
--
-- Three consequences, all reproduced:
--   1. Cross-org referential corruption — org A owns a location bound to org
--      B's branch, which from M07 is a stock location belonging to another
--      company.
--   2. Cross-org denial of service — org B cannot delete its own branch,
--      blocked by a referencing row it cannot see, with an error it cannot act
--      on.
--   3. An existence oracle — a real foreign uuid inserted cleanly while a
--      nonexistent one raised "Key is not present in table", giving org A a
--      binary probe on any uuid in any org. After this migration both produce
--      the identical error.
--
-- The generated statements below are reordered by hand: Drizzle emits the
-- foreign key before the unique constraint it references, which fails on a
-- fresh database. The index drops at the end are also hand-written, because
-- those indexes were only ever emitted by tenantTableSql() and Drizzle has
-- never known about them.

ALTER TABLE "org"."branches" ADD CONSTRAINT "branches_org_id_id_key" UNIQUE("org_id","id");
--> statement-breakpoint

ALTER TABLE "org"."locations" DROP CONSTRAINT "locations_branch_id_branches_id_fk";
--> statement-breakpoint

ALTER TABLE "org"."locations" ADD CONSTRAINT "locations_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- Duplicate org_id indexes. The Drizzle schema declares `<table>_org_idx` and
-- tenantTableSql() also emitted `<table>_org_id_idx` — byte-identical
-- definitions, both maintained on every write. The Drizzle one stays, because
-- `pnpm db:generate` can see it.
DROP INDEX IF EXISTS "org"."branches_org_id_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "org"."locations_org_id_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "org"."settings_org_id_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "org"."feature_flags_org_id_idx";
