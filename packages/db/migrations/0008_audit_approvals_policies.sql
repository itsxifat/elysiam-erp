-- Isolation for audit, approvals and the demo resource (architecture §5, §25).
--
-- GENERATED from packages/db/src/rls.ts, like 0001 and 0004. Every tenant table
-- gets an identical block, because a hand-written policy that differs by one
-- character fails silently: it returns rows rather than throwing, and the wrong
-- rows look like the right ones.
--
-- `audit.audit_log` is APPEND_ONLY: insert and select, no update or delete. A
-- log whose rows can be edited is not evidence of anything, and the grant is
-- the only thing that makes that true rather than merely intended.

--> statement-breakpoint
-- audit.audit_log
alter table "audit"."audit_log" enable row level security;
alter table "audit"."audit_log" force row level security;
drop policy if exists "audit_log_org_isolation" on "audit"."audit_log";
create policy "audit_log_org_isolation" on "audit"."audit_log"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
grant usage on schema "audit" to "erp_app", "erp_analytics";
grant select, insert on "audit"."audit_log" to "erp_app";
--> statement-breakpoint
-- approvals.approval_requests
alter table "approvals"."approval_requests" enable row level security;
alter table "approvals"."approval_requests" force row level security;
drop policy if exists "approval_requests_org_isolation" on "approvals"."approval_requests";
create policy "approval_requests_org_isolation" on "approvals"."approval_requests"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
grant usage on schema "approvals" to "erp_app", "erp_analytics";
grant select, insert, update, delete on "approvals"."approval_requests" to "erp_app";
--> statement-breakpoint
-- approvals.approval_thresholds
alter table "approvals"."approval_thresholds" enable row level security;
alter table "approvals"."approval_thresholds" force row level security;
drop policy if exists "approval_thresholds_org_isolation" on "approvals"."approval_thresholds";
create policy "approval_thresholds_org_isolation" on "approvals"."approval_thresholds"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
grant usage on schema "approvals" to "erp_app", "erp_analytics";
grant select, insert, update, delete on "approvals"."approval_thresholds" to "erp_app";
--> statement-breakpoint
-- demo.costed_items
alter table "demo"."costed_items" enable row level security;
alter table "demo"."costed_items" force row level security;
drop policy if exists "costed_items_org_isolation" on "demo"."costed_items";
create policy "costed_items_org_isolation" on "demo"."costed_items"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
grant usage on schema "demo" to "erp_app", "erp_analytics";
grant select, insert, update, delete on "demo"."costed_items" to "erp_app";
