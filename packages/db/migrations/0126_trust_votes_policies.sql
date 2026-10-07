-- Tenant isolation and the grants for the admins' trust votes (D-654, D-655).
--
-- The policy is `tenantTableSql()`'s, pasted verbatim as every tenant policy in this repo is
-- (D-048). The grants are the decision: SELECT, INSERT and DELETE for erp_app, never UPDATE.
-- A vote is cast or withdrawn, never edited; the audit log keeps both. No analytics read.
--
-- A trigger also refuses a vote cast in someone else's name: when the transaction names its
-- acting user (`withOrg` always does), the voter is that user.

alter table "iam"."trust_votes" enable row level security;
--> statement-breakpoint
alter table "iam"."trust_votes" force row level security;
--> statement-breakpoint
drop policy if exists "trust_votes_org_isolation" on "iam"."trust_votes";
--> statement-breakpoint
create policy "trust_votes_org_isolation" on "iam"."trust_votes"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "iam" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, delete on "iam"."trust_votes" to "erp_app";
--> statement-breakpoint
create or replace function iam.guard_trust_vote()
returns trigger
language plpgsql
set search_path = pg_catalog, iam
as $$
declare
  v_actor text := nullif(current_setting('app.user_id', true), '');
begin
  if v_actor is not null and new.voter_user_id <> v_actor then
    raise exception 'TRUST_VOTE_INVALID: a vote is cast by the acting user'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
drop trigger if exists trust_votes_guard on "iam"."trust_votes";
--> statement-breakpoint
create trigger trust_votes_guard
  before insert on "iam"."trust_votes"
  for each row execute function iam.guard_trust_vote();
