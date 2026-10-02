-- Tenant isolation for M24's tables (invariant 4, §5), and the analytics role's one new
-- read (D-049, D-329).
--
-- Emitted by `tenantTableSql()` in `packages/db/src/rls.ts` and pasted verbatim, as every
-- tenant policy in this repo is (D-048). The grants are where the decisions are:
--
-- * The five `analytics.daily_*` rollups: SELECT, INSERT, UPDATE and DELETE for `erp_app`.
--   A rollup is a cache rebuilt from the owning modules (D-320): the job deletes an org's
--   day and inserts it again in one `withOrg()` transaction, so a rerun replaces rather
--   than adds, and a campaign mapping changed since (D-250) moves its orders between rows.
--   Nothing here is evidence of anything; the evidence is in the tables they summarise.
-- * `analytics.daily_org` alone opts in to `analyticsReadsAllOrgs`: `erp_analytics` may
--   SELECT every org's rows there and nowhere else in this schema (D-329). The leaderboard,
--   the insight rules' group medians and the super-admin consolidated dashboard read it
--   through `withAnalytics()` (§5 exceptions 2 and 3). It holds counts and sums per day — no
--   buyer, phone or address — but it does hold `gross_profit_poisha`, so with delivered
--   revenue beside it the role can derive every brand's daily cost of goods: the code that
--   reads it across brands for anyone but Super Admin must leave that column out. The
--   branch, channel, campaign and agent rollups stay single-brand: nothing compares them.
-- * `analytics.narratives`: SELECT and INSERT. A day's narrative is written once and read
--   back for the rest of the day; it is never edited and the analytics role cannot read
--   it.

alter table "analytics"."daily_org" enable row level security;
--> statement-breakpoint
alter table "analytics"."daily_org" force row level security;
--> statement-breakpoint
drop policy if exists "daily_org_org_isolation" on "analytics"."daily_org";
--> statement-breakpoint
create policy "daily_org_org_isolation" on "analytics"."daily_org"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "analytics" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update, delete on "analytics"."daily_org" to "erp_app";
--> statement-breakpoint
grant select on "analytics"."daily_org" to "erp_analytics";
--> statement-breakpoint
drop policy if exists "daily_org_analytics_all_orgs" on "analytics"."daily_org";
--> statement-breakpoint
create policy "daily_org_analytics_all_orgs" on "analytics"."daily_org"
  for select to "erp_analytics"
  using (true);
--> statement-breakpoint
alter table "analytics"."daily_branch" enable row level security;
--> statement-breakpoint
alter table "analytics"."daily_branch" force row level security;
--> statement-breakpoint
drop policy if exists "daily_branch_org_isolation" on "analytics"."daily_branch";
--> statement-breakpoint
create policy "daily_branch_org_isolation" on "analytics"."daily_branch"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "analytics" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update, delete on "analytics"."daily_branch" to "erp_app";
--> statement-breakpoint
alter table "analytics"."daily_channel" enable row level security;
--> statement-breakpoint
alter table "analytics"."daily_channel" force row level security;
--> statement-breakpoint
drop policy if exists "daily_channel_org_isolation" on "analytics"."daily_channel";
--> statement-breakpoint
create policy "daily_channel_org_isolation" on "analytics"."daily_channel"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "analytics" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update, delete on "analytics"."daily_channel" to "erp_app";
--> statement-breakpoint
alter table "analytics"."daily_campaign" enable row level security;
--> statement-breakpoint
alter table "analytics"."daily_campaign" force row level security;
--> statement-breakpoint
drop policy if exists "daily_campaign_org_isolation" on "analytics"."daily_campaign";
--> statement-breakpoint
create policy "daily_campaign_org_isolation" on "analytics"."daily_campaign"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "analytics" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update, delete on "analytics"."daily_campaign" to "erp_app";
--> statement-breakpoint
alter table "analytics"."daily_agent" enable row level security;
--> statement-breakpoint
alter table "analytics"."daily_agent" force row level security;
--> statement-breakpoint
drop policy if exists "daily_agent_org_isolation" on "analytics"."daily_agent";
--> statement-breakpoint
create policy "daily_agent_org_isolation" on "analytics"."daily_agent"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "analytics" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update, delete on "analytics"."daily_agent" to "erp_app";
--> statement-breakpoint
alter table "analytics"."narratives" enable row level security;
--> statement-breakpoint
alter table "analytics"."narratives" force row level security;
--> statement-breakpoint
drop policy if exists "narratives_org_isolation" on "analytics"."narratives";
--> statement-breakpoint
create policy "narratives_org_isolation" on "analytics"."narratives"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "analytics" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert on "analytics"."narratives" to "erp_app";
