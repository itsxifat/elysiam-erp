-- Tenant isolation and integrity for M41: presence and desk profiles (`team`), auto-assign's
-- offers, the verification calls and the brand's order workflow settings (`sales`)
-- (invariant 4, §5, §6, §9; D-710 to D-719).
--
-- The policies are `tenantTableSql()`'s, pasted verbatim as every tenant policy in this repo
-- is (D-048). The grants are where the decisions are:
--
-- * `team.presence`: upserted by the heartbeat; never deleted.
-- * `team.desk_profiles`: written on the Staff page; never deleted.
-- * `sales.order_offers`: offered, then answered once (the trigger below); never deleted.
-- * `sales.call_attempts`: the record of every call; INSERT and SELECT only, and the trigger
--   below holds the table's owner to the same rule.
-- * `sales.workflow_settings`: one row per brand, written and edited, never deleted.
--
-- No analytics read on any of them.

grant usage on schema "team" to "erp_app";
--> statement-breakpoint
alter table "team"."presence" enable row level security;
--> statement-breakpoint
alter table "team"."presence" force row level security;
--> statement-breakpoint
drop policy if exists "presence_org_isolation" on "team"."presence";
--> statement-breakpoint
create policy "presence_org_isolation" on "team"."presence"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "team"."presence" to "erp_app";
--> statement-breakpoint
alter table "team"."desk_profiles" enable row level security;
--> statement-breakpoint
alter table "team"."desk_profiles" force row level security;
--> statement-breakpoint
drop policy if exists "desk_profiles_org_isolation" on "team"."desk_profiles";
--> statement-breakpoint
create policy "desk_profiles_org_isolation" on "team"."desk_profiles"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "team"."desk_profiles" to "erp_app";
--> statement-breakpoint
alter table "sales"."order_offers" enable row level security;
--> statement-breakpoint
alter table "sales"."order_offers" force row level security;
--> statement-breakpoint
drop policy if exists "order_offers_org_isolation" on "sales"."order_offers";
--> statement-breakpoint
create policy "order_offers_org_isolation" on "sales"."order_offers"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "sales"."order_offers" to "erp_app";
--> statement-breakpoint
alter table "sales"."call_attempts" enable row level security;
--> statement-breakpoint
alter table "sales"."call_attempts" force row level security;
--> statement-breakpoint
drop policy if exists "call_attempts_org_isolation" on "sales"."call_attempts";
--> statement-breakpoint
create policy "call_attempts_org_isolation" on "sales"."call_attempts"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert on "sales"."call_attempts" to "erp_app";
--> statement-breakpoint
alter table "sales"."workflow_settings" enable row level security;
--> statement-breakpoint
alter table "sales"."workflow_settings" force row level security;
--> statement-breakpoint
drop policy if exists "workflow_settings_org_isolation" on "sales"."workflow_settings";
--> statement-breakpoint
create policy "workflow_settings_org_isolation" on "sales"."workflow_settings"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "sales"."workflow_settings" to "erp_app";
--> statement-breakpoint

-- A call attempt is the record a "nobody ever called me" complaint is settled from (D-718).
-- The grants withhold UPDATE and DELETE from `erp_app`; this trigger is what makes the
-- append-only claim true of the table, its owner included, like `sales.order_events` (0041)
-- and `packing.scans` (0133).
create or replace function "sales"."refuse_call_attempt_change"() returns trigger
language plpgsql as $$
begin
  raise exception 'CONFLICT: a call attempt is never changed or removed.'
    using errcode = 'check_violation';
end;
$$;
--> statement-breakpoint
create trigger "call_attempts_append_only"
before update or delete on "sales"."call_attempts"
for each row execute function "sales"."refuse_call_attempt_change"();
--> statement-breakpoint

-- An offer is answered once (D-717): from `offered` to accepted, declined, expired or
-- withdrawn, with the moment it was answered; nothing about whom it went to, for which order or
-- until when ever changes, and an answered offer never changes again. Who declined what is what
-- keeps an order from going round the same person twice, so a rewritten offer would quietly
-- break the fairness the engine promises.
create or replace function "sales"."assert_offer_change"() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'CONFLICT: an order offer is never removed.'
      using errcode = 'check_violation';
  end if;
  if (new.id, new.org_id, new.order_id, new.user_id, new.offered_at, new.expires_at,
      new.created_at)
     is distinct from
     (old.id, old.org_id, old.order_id, old.user_id, old.offered_at, old.expires_at,
      old.created_at) then
    raise exception 'CONFLICT: an order offer''s person, order and deadline are fixed.'
      using errcode = 'check_violation';
  end if;
  if old.status <> 'offered' then
    raise exception 'CONFLICT: this offer was already answered.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger "order_offers_answered_once"
before update or delete on "sales"."order_offers"
for each row execute function "sales"."assert_offer_change"();
