-- Identity isolation (architecture §6, §5 exception 4, D-050).
--
-- GENERATED from packages/db/src/rls.ts, except the self policy at the end,
-- which is specific to memberships and explained there.
--
-- The five Better Auth tables are global: a user is not an org's property, and
-- an org_id on them would stop one person working for three brands. They are
-- declared in GLOBAL_TABLES so the guard does not flag them — the guard is
-- opt-out precisely so that has to be a decision.


--> statement-breakpoint
-- iam.memberships
alter table "iam"."memberships" enable row level security;
alter table "iam"."memberships" force row level security;
drop policy if exists "memberships_org_isolation" on "iam"."memberships";
create policy "memberships_org_isolation" on "iam"."memberships"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
grant usage on schema "iam" to "erp_app", "erp_analytics";
grant select, insert, update, delete on "iam"."memberships" to "erp_app";

--> statement-breakpoint
-- iam.membership_branches
alter table "iam"."membership_branches" enable row level security;
alter table "iam"."membership_branches" force row level security;
drop policy if exists "membership_branches_org_isolation" on "iam"."membership_branches";
create policy "membership_branches_org_isolation" on "iam"."membership_branches"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
grant usage on schema "iam" to "erp_app", "erp_analytics";
grant select, insert, update, delete on "iam"."membership_branches" to "erp_app";

--> statement-breakpoint
-- iam.users: global (§5 exception 4).
grant usage on schema "iam" to "erp_app", "erp_analytics";
grant select on "iam"."users" to "erp_app", "erp_analytics";
grant insert, update, delete on "iam"."users" to "erp_app";

--> statement-breakpoint
-- iam.sessions: global (§5 exception 4).
grant usage on schema "iam" to "erp_app", "erp_analytics";
grant select on "iam"."sessions" to "erp_app", "erp_analytics";
grant insert, update, delete on "iam"."sessions" to "erp_app";

--> statement-breakpoint
-- iam.accounts: global (§5 exception 4).
grant usage on schema "iam" to "erp_app", "erp_analytics";
grant select on "iam"."accounts" to "erp_app", "erp_analytics";
grant insert, update, delete on "iam"."accounts" to "erp_app";

--> statement-breakpoint
-- iam.verifications: global (§5 exception 4).
grant usage on schema "iam" to "erp_app", "erp_analytics";
grant select on "iam"."verifications" to "erp_app", "erp_analytics";
grant insert, update, delete on "iam"."verifications" to "erp_app";

--> statement-breakpoint
-- iam.two_factors: global (§5 exception 4).
grant usage on schema "iam" to "erp_app", "erp_analytics";
grant select on "iam"."two_factors" to "erp_app", "erp_analytics";
grant insert, update, delete on "iam"."two_factors" to "erp_app";

--> statement-breakpoint
-- The second policy on memberships.
--
-- Tenant tables answer "what is in this org". Memberships must also answer
-- "which orgs may I enter", which is asked BEFORE an org is chosen and so
-- cannot be scoped by app.org_id. PostgreSQL ORs permissive policies, so this
-- sits alongside the standard org policy: a user sees their own memberships
-- anywhere, plus everyone's memberships in the org they are acting in.
--
-- Scoped to app.user_id exactly. Widen it and it becomes "any authenticated
-- user reads every membership in every org".
drop policy if exists "memberships_own_rows" on "iam"."memberships";
create policy "memberships_own_rows" on "iam"."memberships"
  for select
  using (user_id = nullif(current_setting('app.user_id', true), ''));
