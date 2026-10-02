-- Tenant isolation for M20's tables (invariant 4, §5).
--
-- The same policy every tenant table in this repo carries (`tenantTableSql()` in
-- `packages/db/src/rls.ts`). The grants are where the decisions are:
--
-- * `hr.targets`: UPDATE for the progress rollup and for cancelling; never DELETE. A
--   target a bonus was paid against is named by its award. 0083 freezes its terms.
-- * `hr.target_members`: INSERT and SELECT only. Who a target counts is decided when it
--   is set, and changing it afterwards would rewrite a month's progress.
-- * `hr.target_weeks`: UPDATE for `achieved` only (0083 refuses any other change).
-- * `hr.bonus_rules`: INSERT and SELECT; a rule's terms live in its versions.
-- * `hr.bonus_rule_versions`: UPDATE for status changes only (0083 freezes the JSON).
-- * `hr.bonus_awards`: INSERT and DELETE, because re-applying the rules replaces a draft
--   run's awards; 0083 refuses both once the run is submitted. Never UPDATE.
-- * `hr.desk_events`: INSERT and SELECT only. It is an event log.
--
-- No analytics read on any of them: M24's rollups come from the outbox, not from HR.
--
-- `events.outbox.actor_user_id` (0081) needs no grant of its own: the table's grants are
-- table-wide.

alter table "hr"."targets" enable row level security;
--> statement-breakpoint
alter table "hr"."targets" force row level security;
--> statement-breakpoint
drop policy if exists "targets_org_isolation" on "hr"."targets";
--> statement-breakpoint
create policy "targets_org_isolation" on "hr"."targets"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "hr" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "hr"."targets" to "erp_app";
--> statement-breakpoint
alter table "hr"."target_members" enable row level security;
--> statement-breakpoint
alter table "hr"."target_members" force row level security;
--> statement-breakpoint
drop policy if exists "target_members_org_isolation" on "hr"."target_members";
--> statement-breakpoint
create policy "target_members_org_isolation" on "hr"."target_members"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "hr" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert on "hr"."target_members" to "erp_app";
--> statement-breakpoint
alter table "hr"."target_weeks" enable row level security;
--> statement-breakpoint
alter table "hr"."target_weeks" force row level security;
--> statement-breakpoint
drop policy if exists "target_weeks_org_isolation" on "hr"."target_weeks";
--> statement-breakpoint
create policy "target_weeks_org_isolation" on "hr"."target_weeks"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "hr" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "hr"."target_weeks" to "erp_app";
--> statement-breakpoint
alter table "hr"."bonus_rules" enable row level security;
--> statement-breakpoint
alter table "hr"."bonus_rules" force row level security;
--> statement-breakpoint
drop policy if exists "bonus_rules_org_isolation" on "hr"."bonus_rules";
--> statement-breakpoint
create policy "bonus_rules_org_isolation" on "hr"."bonus_rules"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "hr" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert on "hr"."bonus_rules" to "erp_app";
--> statement-breakpoint
alter table "hr"."bonus_rule_versions" enable row level security;
--> statement-breakpoint
alter table "hr"."bonus_rule_versions" force row level security;
--> statement-breakpoint
drop policy if exists "bonus_rule_versions_org_isolation" on "hr"."bonus_rule_versions";
--> statement-breakpoint
create policy "bonus_rule_versions_org_isolation" on "hr"."bonus_rule_versions"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "hr" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "hr"."bonus_rule_versions" to "erp_app";
--> statement-breakpoint
alter table "hr"."bonus_awards" enable row level security;
--> statement-breakpoint
alter table "hr"."bonus_awards" force row level security;
--> statement-breakpoint
drop policy if exists "bonus_awards_org_isolation" on "hr"."bonus_awards";
--> statement-breakpoint
create policy "bonus_awards_org_isolation" on "hr"."bonus_awards"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "hr" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, delete on "hr"."bonus_awards" to "erp_app";
--> statement-breakpoint
alter table "hr"."desk_events" enable row level security;
--> statement-breakpoint
alter table "hr"."desk_events" force row level security;
--> statement-breakpoint
drop policy if exists "desk_events_org_isolation" on "hr"."desk_events";
--> statement-breakpoint
create policy "desk_events_org_isolation" on "hr"."desk_events"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "hr" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert on "hr"."desk_events" to "erp_app";
