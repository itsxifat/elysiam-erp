-- The mother's grants and its two database-enforced rules (D-480, D-487, D-488).
--
-- `mother_owner` owns every object and runs the migrations; `mother_app` is what the API
-- and the worker connect as. Nothing is granted wholesale: each table gets the verbs its
-- code uses and no others, so a bug that tries to do more fails with a permission error
-- rather than doing it.
--
-- * auth.*: Better Auth's own tables. It creates, updates and deletes sessions,
--   verifications and second factors; a person is never deleted, only switched off
--   (D-489), so `auth.users` has no DELETE.
-- * mother.brands: the registry. Never deleted (a brand switched off keeps its history).
-- * mother.brand_daily*, brand_snapshots: a pull replaces a window of days in one
--   transaction (delete, then insert), as the brand's own rollup job does (D-484).
-- * mother.audit_log: INSERT and SELECT only, and a trigger that refuses UPDATE, DELETE
--   and TRUNCATE for every role, the owner included.
-- * mother.two_factor_resets: a decided request is frozen by a trigger (D-488).

grant usage on schema "auth", "mother" to "mother_app";
--> statement-breakpoint
grant select, insert, update on "auth"."users" to "mother_app";
--> statement-breakpoint
grant select, insert, update, delete on "auth"."sessions", "auth"."accounts", "auth"."verifications", "auth"."two_factors" to "mother_app";
--> statement-breakpoint
grant select, insert, update on "mother"."brands" to "mother_app";
--> statement-breakpoint
grant select, insert, delete on "mother"."brand_daily", "mother"."brand_daily_channel", "mother"."brand_daily_campaign", "mother"."brand_daily_ledger", "mother"."brand_snapshots" to "mother_app";
--> statement-breakpoint
grant select, insert, update on "mother"."pull_runs" to "mother_app";
--> statement-breakpoint
grant select, insert on "mother"."audit_log" to "mother_app";
--> statement-breakpoint
grant usage on sequence "mother"."audit_log_id_seq" to "mother_app";
--> statement-breakpoint
grant select, insert, update on "mother"."two_factor_resets" to "mother_app";
--> statement-breakpoint
create function "mother"."refuse_audit_change"() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'MOTHER_AUDIT_IMMUTABLE: the audit log is append-only';
end;
$$;
--> statement-breakpoint
create trigger "audit_log_append_only"
  before update or delete on "mother"."audit_log"
  for each row execute function "mother"."refuse_audit_change"();
--> statement-breakpoint
create trigger "audit_log_no_truncate"
  before truncate on "mother"."audit_log"
  for each statement execute function "mother"."refuse_audit_change"();
--> statement-breakpoint
create function "mother"."freeze_decided_reset"() returns trigger
  language plpgsql
  as $$
begin
  if old.status <> 'pending' then
    raise exception 'MOTHER_RESET_DECIDED: a decided request does not change';
  end if;
  if new.target_user_id <> old.target_user_id
     or new.requested_by <> old.requested_by
     or new.reason <> old.reason
     or new.created_at <> old.created_at then
    raise exception 'MOTHER_RESET_TERMS_FIXED: a request''s terms are fixed when it is raised';
  end if;
  if new.status <> 'pending' then
    new.decided_at := now();
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger "two_factor_resets_frozen"
  before update on "mother"."two_factor_resets"
  for each row execute function "mother"."freeze_decided_reset"();
