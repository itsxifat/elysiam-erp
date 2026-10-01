-- Tenant isolation for M16's tables (invariant 4, §5).
--
-- Emitted by `tenantTableSql()` in `packages/db/src/rls.ts` and pasted verbatim, as every
-- tenant policy in this repo is (D-048). The grants are where the decisions are:
--
-- * `promo.codes`: UPDATE for status changes and the use counter; never DELETE. A code
--   with redemptions is archived, not removed, because the redemptions name it.
-- * `promo.redemptions`: UPDATE only to release an applied redemption (0077 refuses any
--   other change); never DELETE. It is the ledger of every discount a code gave.
-- * `notify.opt_outs`: DELETE, because opting back in is the buyer's right.
-- * `notify.messages`: UPDATE as the send job records the outcome; never DELETE. It is
--   the delivery log.
-- * `sales.occasion_issues`: INSERT and SELECT only. The row is what makes the daily job
--   idempotent, so nothing may change or remove it.
--
-- No analytics read on any of them.

alter table "promo"."codes" enable row level security;
--> statement-breakpoint
alter table "promo"."codes" force row level security;
--> statement-breakpoint
drop policy if exists "codes_org_isolation" on "promo"."codes";
--> statement-breakpoint
create policy "codes_org_isolation" on "promo"."codes"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "promo" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "promo"."codes" to "erp_app";
--> statement-breakpoint
alter table "promo"."redemptions" enable row level security;
--> statement-breakpoint
alter table "promo"."redemptions" force row level security;
--> statement-breakpoint
drop policy if exists "redemptions_org_isolation" on "promo"."redemptions";
--> statement-breakpoint
create policy "redemptions_org_isolation" on "promo"."redemptions"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "promo" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "promo"."redemptions" to "erp_app";
--> statement-breakpoint
alter table "notify"."templates" enable row level security;
--> statement-breakpoint
alter table "notify"."templates" force row level security;
--> statement-breakpoint
drop policy if exists "templates_org_isolation" on "notify"."templates";
--> statement-breakpoint
create policy "templates_org_isolation" on "notify"."templates"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "notify" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "notify"."templates" to "erp_app";
--> statement-breakpoint
alter table "notify"."opt_outs" enable row level security;
--> statement-breakpoint
alter table "notify"."opt_outs" force row level security;
--> statement-breakpoint
drop policy if exists "opt_outs_org_isolation" on "notify"."opt_outs";
--> statement-breakpoint
create policy "opt_outs_org_isolation" on "notify"."opt_outs"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "notify" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, delete on "notify"."opt_outs" to "erp_app";
--> statement-breakpoint
alter table "notify"."messages" enable row level security;
--> statement-breakpoint
alter table "notify"."messages" force row level security;
--> statement-breakpoint
drop policy if exists "messages_org_isolation" on "notify"."messages";
--> statement-breakpoint
create policy "messages_org_isolation" on "notify"."messages"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "notify" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "notify"."messages" to "erp_app";
--> statement-breakpoint
alter table "sales"."customer_segments" enable row level security;
--> statement-breakpoint
alter table "sales"."customer_segments" force row level security;
--> statement-breakpoint
drop policy if exists "customer_segments_org_isolation" on "sales"."customer_segments";
--> statement-breakpoint
create policy "customer_segments_org_isolation" on "sales"."customer_segments"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "sales" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "sales"."customer_segments" to "erp_app";
--> statement-breakpoint
alter table "sales"."occasion_issues" enable row level security;
--> statement-breakpoint
alter table "sales"."occasion_issues" force row level security;
--> statement-breakpoint
drop policy if exists "occasion_issues_org_isolation" on "sales"."occasion_issues";
--> statement-breakpoint
create policy "occasion_issues_org_isolation" on "sales"."occasion_issues"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "sales" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert on "sales"."occasion_issues" to "erp_app";
