-- Tenant isolation for M15's three courier tables (invariant 4, §5).
--
-- The policy text is `tenantTableSql()`'s, pasted verbatim like every tenant policy in
-- this repo: a policy that differs by one character fails silently, returning rows rather
-- than throwing (D-048).
--
-- The grants are the decision in this file:
--
-- * `courier.consignment_escalations` is append-only. A note about chasing a missing
--   parcel is a record of what somebody did, and it is what a dispute with the courier is
--   settled with — so it can be added to and never tidied.
-- * `courier.settlement_fetch_runs` is append-only. It is the only record that an
--   unattended fetch saw a statement it could not import; an UPDATE could turn "refused"
--   into "created" after the fact.
-- * `courier.selection_rules` gets UPDATE **and DELETE**, the one table in this schema
--   that does. It is configuration, replaced as a set when an operator saves it, and the
--   audit row written in the same transaction holds the whole set before and after. 0067
--   leaves it out of the schema's no-delete trigger for the same reason.
--
-- No analytics read on any of them, as in 0049: nothing consolidated needs these rows.

alter table "courier"."selection_rules" enable row level security;--> statement-breakpoint
alter table "courier"."selection_rules" force row level security;--> statement-breakpoint
drop policy if exists "selection_rules_org_isolation" on "courier"."selection_rules";--> statement-breakpoint
create policy "selection_rules_org_isolation" on "courier"."selection_rules"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "courier" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update, delete on "courier"."selection_rules" to "erp_app";--> statement-breakpoint
alter table "courier"."consignment_escalations" enable row level security;--> statement-breakpoint
alter table "courier"."consignment_escalations" force row level security;--> statement-breakpoint
drop policy if exists "consignment_escalations_org_isolation" on "courier"."consignment_escalations";--> statement-breakpoint
create policy "consignment_escalations_org_isolation" on "courier"."consignment_escalations"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "courier" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert on "courier"."consignment_escalations" to "erp_app";--> statement-breakpoint
alter table "courier"."settlement_fetch_runs" enable row level security;--> statement-breakpoint
alter table "courier"."settlement_fetch_runs" force row level security;--> statement-breakpoint
drop policy if exists "settlement_fetch_runs_org_isolation" on "courier"."settlement_fetch_runs";--> statement-breakpoint
create policy "settlement_fetch_runs_org_isolation" on "courier"."settlement_fetch_runs"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "courier" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert on "courier"."settlement_fetch_runs" to "erp_app";
