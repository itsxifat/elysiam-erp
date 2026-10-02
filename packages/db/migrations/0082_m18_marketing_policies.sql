-- Tenant isolation for M18's tables (invariant 4, §5).
--
-- Emitted by `tenantTableSql()` in `packages/db/src/rls.ts` and pasted verbatim, as every
-- tenant policy in this repo is (D-048). The grants are where the decisions are:
--
-- * `marketing.campaigns`: UPDATE to rename, re-date or archive; never DELETE. Spend,
--   leads, refs and promo codes name a campaign, and a removed one would orphan them.
-- * `marketing.campaign_refs`: DELETE, because a mistyped Meta id or UTM must be
--   removable — attribution is read from the current mappings (D-250), so removing a ref
--   un-attributes exactly what it attributed. No UPDATE: a ref is replaced, not edited.
-- * `marketing.ad_spend`: UPDATE, because a day's figure is replaced (by a person, or by a
--   re-import of a day it imported); never DELETE. A figure set to zero is still a record
--   that somebody said so.
-- * `marketing.leads`: UPDATE for status and details; never DELETE.
-- * `marketing.meta_connections`: UPDATE to change settings or the sealed token.
-- * `marketing.capi_events`: UPDATE as the send job records the outcome (0083 makes a sent
--   or skipped row final); never DELETE. It is the conversion log.
--
-- No analytics read on any of them yet (D-049); M24's rollups opt in per table.

alter table "marketing"."campaigns" enable row level security;
--> statement-breakpoint
alter table "marketing"."campaigns" force row level security;
--> statement-breakpoint
drop policy if exists "campaigns_org_isolation" on "marketing"."campaigns";
--> statement-breakpoint
create policy "campaigns_org_isolation" on "marketing"."campaigns"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "marketing" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "marketing"."campaigns" to "erp_app";
--> statement-breakpoint
alter table "marketing"."campaign_refs" enable row level security;
--> statement-breakpoint
alter table "marketing"."campaign_refs" force row level security;
--> statement-breakpoint
drop policy if exists "campaign_refs_org_isolation" on "marketing"."campaign_refs";
--> statement-breakpoint
create policy "campaign_refs_org_isolation" on "marketing"."campaign_refs"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "marketing" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, delete on "marketing"."campaign_refs" to "erp_app";
--> statement-breakpoint
alter table "marketing"."ad_spend" enable row level security;
--> statement-breakpoint
alter table "marketing"."ad_spend" force row level security;
--> statement-breakpoint
drop policy if exists "ad_spend_org_isolation" on "marketing"."ad_spend";
--> statement-breakpoint
create policy "ad_spend_org_isolation" on "marketing"."ad_spend"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "marketing" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "marketing"."ad_spend" to "erp_app";
--> statement-breakpoint
alter table "marketing"."leads" enable row level security;
--> statement-breakpoint
alter table "marketing"."leads" force row level security;
--> statement-breakpoint
drop policy if exists "leads_org_isolation" on "marketing"."leads";
--> statement-breakpoint
create policy "leads_org_isolation" on "marketing"."leads"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "marketing" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "marketing"."leads" to "erp_app";
--> statement-breakpoint
alter table "marketing"."meta_connections" enable row level security;
--> statement-breakpoint
alter table "marketing"."meta_connections" force row level security;
--> statement-breakpoint
drop policy if exists "meta_connections_org_isolation" on "marketing"."meta_connections";
--> statement-breakpoint
create policy "meta_connections_org_isolation" on "marketing"."meta_connections"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "marketing" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "marketing"."meta_connections" to "erp_app";
--> statement-breakpoint
alter table "marketing"."capi_events" enable row level security;
--> statement-breakpoint
alter table "marketing"."capi_events" force row level security;
--> statement-breakpoint
drop policy if exists "capi_events_org_isolation" on "marketing"."capi_events";
--> statement-breakpoint
create policy "capi_events_org_isolation" on "marketing"."capi_events"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "marketing" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "marketing"."capi_events" to "erp_app";
