-- Tenant isolation for the pos schema (M23; invariant 4, §5).
--
-- Emitted in the exact form `tenantTableSql()` in `packages/db/src/rls.ts`
-- produces, like every tenant policy in this repo: a policy that differs by one
-- character fails silently, returning rows rather than throwing (D-048).
--
-- The grants are where the thinking is. Nothing here grants DELETE:
--
-- * **Append-only:** `sale_tenders`, `return_tenders`, `branch_closings` and
--   `branch_closing_wallets`. A tender is the record of which wallet a journal
--   debited, and a branch closing is the record of what a manager signed off; the
--   journals behind both cannot change (invariant 2), so neither can they.
-- * **UPDATE, no DELETE:** registers (renamed, deactivated), shifts (closed once),
--   sales and returns (held -> posted or voided, once), their lines (the unit cost
--   is written once, when the document posts) and review items (resolved once).
--   0070's triggers confine each UPDATE to exactly that transition. A deleted sale
--   would leave its stock movements and journal pointing at nothing, and "what did
--   this till take on Tuesday" would have two answers on two different days.
--
-- No analytics read on any of them yet (D-049): M24's rollups opt in per table.

alter table "pos"."registers" enable row level security;--> statement-breakpoint
alter table "pos"."registers" force row level security;--> statement-breakpoint
drop policy if exists "registers_org_isolation" on "pos"."registers";--> statement-breakpoint
create policy "registers_org_isolation" on "pos"."registers"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "pos" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "pos"."registers" to "erp_app";--> statement-breakpoint
alter table "pos"."shifts" enable row level security;--> statement-breakpoint
alter table "pos"."shifts" force row level security;--> statement-breakpoint
drop policy if exists "shifts_org_isolation" on "pos"."shifts";--> statement-breakpoint
create policy "shifts_org_isolation" on "pos"."shifts"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "pos" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "pos"."shifts" to "erp_app";--> statement-breakpoint
alter table "pos"."sales" enable row level security;--> statement-breakpoint
alter table "pos"."sales" force row level security;--> statement-breakpoint
drop policy if exists "sales_org_isolation" on "pos"."sales";--> statement-breakpoint
create policy "sales_org_isolation" on "pos"."sales"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "pos" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "pos"."sales" to "erp_app";--> statement-breakpoint
alter table "pos"."sale_lines" enable row level security;--> statement-breakpoint
alter table "pos"."sale_lines" force row level security;--> statement-breakpoint
drop policy if exists "sale_lines_org_isolation" on "pos"."sale_lines";--> statement-breakpoint
create policy "sale_lines_org_isolation" on "pos"."sale_lines"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "pos" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "pos"."sale_lines" to "erp_app";--> statement-breakpoint
alter table "pos"."sale_tenders" enable row level security;--> statement-breakpoint
alter table "pos"."sale_tenders" force row level security;--> statement-breakpoint
drop policy if exists "sale_tenders_org_isolation" on "pos"."sale_tenders";--> statement-breakpoint
create policy "sale_tenders_org_isolation" on "pos"."sale_tenders"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "pos" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert on "pos"."sale_tenders" to "erp_app";--> statement-breakpoint
alter table "pos"."returns" enable row level security;--> statement-breakpoint
alter table "pos"."returns" force row level security;--> statement-breakpoint
drop policy if exists "returns_org_isolation" on "pos"."returns";--> statement-breakpoint
create policy "returns_org_isolation" on "pos"."returns"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "pos" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "pos"."returns" to "erp_app";--> statement-breakpoint
alter table "pos"."return_lines" enable row level security;--> statement-breakpoint
alter table "pos"."return_lines" force row level security;--> statement-breakpoint
drop policy if exists "return_lines_org_isolation" on "pos"."return_lines";--> statement-breakpoint
create policy "return_lines_org_isolation" on "pos"."return_lines"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "pos" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "pos"."return_lines" to "erp_app";--> statement-breakpoint
alter table "pos"."return_tenders" enable row level security;--> statement-breakpoint
alter table "pos"."return_tenders" force row level security;--> statement-breakpoint
drop policy if exists "return_tenders_org_isolation" on "pos"."return_tenders";--> statement-breakpoint
create policy "return_tenders_org_isolation" on "pos"."return_tenders"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "pos" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert on "pos"."return_tenders" to "erp_app";--> statement-breakpoint
alter table "pos"."review_items" enable row level security;--> statement-breakpoint
alter table "pos"."review_items" force row level security;--> statement-breakpoint
drop policy if exists "review_items_org_isolation" on "pos"."review_items";--> statement-breakpoint
create policy "review_items_org_isolation" on "pos"."review_items"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "pos" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "pos"."review_items" to "erp_app";--> statement-breakpoint
alter table "pos"."branch_closings" enable row level security;--> statement-breakpoint
alter table "pos"."branch_closings" force row level security;--> statement-breakpoint
drop policy if exists "branch_closings_org_isolation" on "pos"."branch_closings";--> statement-breakpoint
create policy "branch_closings_org_isolation" on "pos"."branch_closings"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "pos" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert on "pos"."branch_closings" to "erp_app";--> statement-breakpoint
alter table "pos"."branch_closing_wallets" enable row level security;--> statement-breakpoint
alter table "pos"."branch_closing_wallets" force row level security;--> statement-breakpoint
drop policy if exists "branch_closing_wallets_org_isolation" on "pos"."branch_closing_wallets";--> statement-breakpoint
create policy "branch_closing_wallets_org_isolation" on "pos"."branch_closing_wallets"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "pos" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert on "pos"."branch_closing_wallets" to "erp_app";
