-- Tenant isolation for the courier schema (invariant 4, §5).
--
-- Emitted by `tenantTableSql()` in `packages/db/src/rls.ts` and pasted verbatim,
-- the way every tenant policy in this repo is: a policy that differs by one
-- character fails silently, returning rows rather than throwing, and the wrong
-- rows look like the right ones (D-048).
--
-- The grants are where the thinking is:
--
-- * `courier.consignment_events` is **append-only**. An event is what a courier
--   said at a moment, and the unique index on `dedupe_key` is the first of the
--   three layers behind acceptance check 3 — a duplicate webhook cannot insert.
--   UPDATE would let the row that proves a status was already applied be edited
--   into one that does not, and DELETE would let a double transition be made
--   possible after the fact.
-- * `courier.settlement_lines` is append-only for the same reason in a different
--   register: the exceptions report is this table, and an exception a person
--   cleared last week has to still say what it said then. Re-importing a
--   corrected statement is a new settlement, not an edit of the old one.
-- * `courier.return_receipt_lines` is append-only: the split between sellable and
--   damaged units is an inspection somebody performed, and it has already been
--   turned into stock movements (invariant 3) that cannot be edited either.
-- * `courier.courier_accounts`, `.consignments`, `.webhook_deliveries`,
--   `.return_receipts` and `.settlements` get UPDATE and never DELETE. Each has
--   legitimate transitions — a status arrives, a webhook is processed, a
--   settlement is approved — which triggers in 0050 and 0051 confine. DELETE
--   would make "what did this courier owe us in March" answerable differently on
--   two different days, and for `courier_accounts` it would orphan every parcel
--   the account ever booked.
--
-- No analytics read on any of them. §5's cross-org exception 2 is for the
-- analytics rollups, and the consolidated COD picture a super admin sees is a sum
-- of ledger balances — so it reads `ledger.*` through `erp_analytics` (migration
-- 0030) and needs nothing here. A read-only role is still a role that can read
-- (D-049), and these rows carry recipient references, courier credentials and raw
-- webhook bodies.

alter table "courier"."courier_accounts" enable row level security;--> statement-breakpoint
alter table "courier"."courier_accounts" force row level security;--> statement-breakpoint
drop policy if exists "courier_accounts_org_isolation" on "courier"."courier_accounts";--> statement-breakpoint
create policy "courier_accounts_org_isolation" on "courier"."courier_accounts"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "courier" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "courier"."courier_accounts" to "erp_app";--> statement-breakpoint
alter table "courier"."consignments" enable row level security;--> statement-breakpoint
alter table "courier"."consignments" force row level security;--> statement-breakpoint
drop policy if exists "consignments_org_isolation" on "courier"."consignments";--> statement-breakpoint
create policy "consignments_org_isolation" on "courier"."consignments"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "courier" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "courier"."consignments" to "erp_app";--> statement-breakpoint
alter table "courier"."consignment_events" enable row level security;--> statement-breakpoint
alter table "courier"."consignment_events" force row level security;--> statement-breakpoint
drop policy if exists "consignment_events_org_isolation" on "courier"."consignment_events";--> statement-breakpoint
create policy "consignment_events_org_isolation" on "courier"."consignment_events"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "courier" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert on "courier"."consignment_events" to "erp_app";--> statement-breakpoint
alter table "courier"."webhook_deliveries" enable row level security;--> statement-breakpoint
alter table "courier"."webhook_deliveries" force row level security;--> statement-breakpoint
drop policy if exists "webhook_deliveries_org_isolation" on "courier"."webhook_deliveries";--> statement-breakpoint
create policy "webhook_deliveries_org_isolation" on "courier"."webhook_deliveries"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "courier" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "courier"."webhook_deliveries" to "erp_app";--> statement-breakpoint
alter table "courier"."return_receipts" enable row level security;--> statement-breakpoint
alter table "courier"."return_receipts" force row level security;--> statement-breakpoint
drop policy if exists "return_receipts_org_isolation" on "courier"."return_receipts";--> statement-breakpoint
create policy "return_receipts_org_isolation" on "courier"."return_receipts"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "courier" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "courier"."return_receipts" to "erp_app";--> statement-breakpoint
alter table "courier"."return_receipt_lines" enable row level security;--> statement-breakpoint
alter table "courier"."return_receipt_lines" force row level security;--> statement-breakpoint
drop policy if exists "return_receipt_lines_org_isolation" on "courier"."return_receipt_lines";--> statement-breakpoint
create policy "return_receipt_lines_org_isolation" on "courier"."return_receipt_lines"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "courier" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert on "courier"."return_receipt_lines" to "erp_app";--> statement-breakpoint
alter table "courier"."settlements" enable row level security;--> statement-breakpoint
alter table "courier"."settlements" force row level security;--> statement-breakpoint
drop policy if exists "settlements_org_isolation" on "courier"."settlements";--> statement-breakpoint
create policy "settlements_org_isolation" on "courier"."settlements"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "courier" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update on "courier"."settlements" to "erp_app";--> statement-breakpoint
alter table "courier"."settlement_lines" enable row level security;--> statement-breakpoint
alter table "courier"."settlement_lines" force row level security;--> statement-breakpoint
drop policy if exists "settlement_lines_org_isolation" on "courier"."settlement_lines";--> statement-breakpoint
create policy "settlement_lines_org_isolation" on "courier"."settlement_lines"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "courier" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert on "courier"."settlement_lines" to "erp_app";
