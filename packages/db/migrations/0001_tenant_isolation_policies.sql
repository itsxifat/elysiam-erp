-- Tenant isolation (architecture §5, D-043).
--
-- GENERATED from packages/db/src/rls.ts. Every tenant table gets an identical
-- block, because a hand-written policy that differs by one character fails
-- silently: it returns rows rather than throwing, and the wrong rows look like
-- the right ones.
--
-- The policy compares org_id against
--   nullif(current_setting('app.org_id', true), '')::uuid
-- rather than the bare current_setting in the original §5 text. set_config with
-- the transaction-local flag reverts to the empty string, not to unset, so on
-- any reused pooled connection the bare version raises
-- "invalid input syntax for type uuid" instead of returning zero rows.
--
-- Never edit this file. Fix a policy with a new migration (invariant 9).


--> statement-breakpoint
-- org.branches
alter table "org"."branches" enable row level security;
alter table "org"."branches" force row level security;
drop policy if exists "branches_org_isolation" on "org"."branches";
create policy "branches_org_isolation" on "org"."branches"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
create index if not exists "branches_org_id_idx" on "org"."branches" (org_id);
grant usage on schema "org" to "erp_app", "erp_analytics";
grant select, insert, update, delete on "org"."branches" to "erp_app";

--> statement-breakpoint
-- org.locations
alter table "org"."locations" enable row level security;
alter table "org"."locations" force row level security;
drop policy if exists "locations_org_isolation" on "org"."locations";
create policy "locations_org_isolation" on "org"."locations"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
create index if not exists "locations_org_id_idx" on "org"."locations" (org_id);
grant usage on schema "org" to "erp_app", "erp_analytics";
grant select, insert, update, delete on "org"."locations" to "erp_app";

--> statement-breakpoint
-- org.settings
alter table "org"."settings" enable row level security;
alter table "org"."settings" force row level security;
drop policy if exists "settings_org_isolation" on "org"."settings";
create policy "settings_org_isolation" on "org"."settings"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
create index if not exists "settings_org_id_idx" on "org"."settings" (org_id);
grant usage on schema "org" to "erp_app", "erp_analytics";
grant select, insert, update, delete on "org"."settings" to "erp_app";

--> statement-breakpoint
-- org.feature_flags
alter table "org"."feature_flags" enable row level security;
alter table "org"."feature_flags" force row level security;
drop policy if exists "feature_flags_org_isolation" on "org"."feature_flags";
create policy "feature_flags_org_isolation" on "org"."feature_flags"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
create index if not exists "feature_flags_org_id_idx" on "org"."feature_flags" (org_id);
grant usage on schema "org" to "erp_app", "erp_analytics";
grant select, insert, update, delete on "org"."feature_flags" to "erp_app";

--> statement-breakpoint
-- org.organizations: global by design (§5 exception 5).
-- Readable by the app so the org switcher works; writable only by erp_owner.
grant usage on schema "org" to "erp_app", "erp_analytics";
grant select on "org"."organizations" to "erp_app", "erp_analytics";

--> statement-breakpoint
-- ref.divisions: global reference data.
grant usage on schema "ref" to "erp_app", "erp_analytics";
grant select on "ref"."divisions" to "erp_app", "erp_analytics";

--> statement-breakpoint
-- ref.districts: global reference data.
grant usage on schema "ref" to "erp_app", "erp_analytics";
grant select on "ref"."districts" to "erp_app", "erp_analytics";

--> statement-breakpoint
-- ref.thanas: global reference data.
grant usage on schema "ref" to "erp_app", "erp_analytics";
grant select on "ref"."thanas" to "erp_app", "erp_analytics";
