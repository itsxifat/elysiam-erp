-- Tenant isolation and the allowed changes for M14a's tables (invariant 4, §5; D-215).
--
-- The isolation block is `tenantTableSql()` from `packages/db/src/rls.ts`, pasted verbatim
-- as every tenant policy in this repo is (D-048). The grants and triggers are the
-- decisions:
--
-- * `migration.batches`: INSERT and SELECT, and UPDATE of four columns only. A staged
--   batch is discarded or posted, once; nothing else about an imported file ever changes,
--   because the opening journal was built from exactly these rows. Never DELETE.
-- * `migration.openings`: INSERT and SELECT, and UPDATE of the sign-off only, once. The
--   opening is the record that a brand's books were opened from these files; it is never
--   removed; a mistake found after it is corrected through the owning module (D-213).
--
-- No analytics read on either.

alter table "migration"."batches" enable row level security;
--> statement-breakpoint
alter table "migration"."batches" force row level security;
--> statement-breakpoint
drop policy if exists "batches_org_isolation" on "migration"."batches";
--> statement-breakpoint
create policy "batches_org_isolation" on "migration"."batches"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "migration" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert on "migration"."batches" to "erp_app";
--> statement-breakpoint
grant update ("status", "opening_id", "decided_by", "decided_at", "updated_at")
  on "migration"."batches" to "erp_app";
--> statement-breakpoint
alter table "migration"."openings" enable row level security;
--> statement-breakpoint
alter table "migration"."openings" force row level security;
--> statement-breakpoint
drop policy if exists "openings_org_isolation" on "migration"."openings";
--> statement-breakpoint
create policy "openings_org_isolation" on "migration"."openings"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "migration" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert on "migration"."openings" to "erp_app";
--> statement-breakpoint
grant update ("signed_off_by", "signed_off_at", "sign_off_note", "updated_at")
  on "migration"."openings" to "erp_app";
--> statement-breakpoint

-- A staged batch becomes discarded or posted, once, and nothing else changes. Raised with
-- a code from `packages/contracts/src/errors.ts`, so the module answers 409, not 500.
create or replace function migration.assert_batch_transition() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'MIGRATION_BATCH_IMMUTABLE: an imported file is discarded, never removed.';
  end if;
  if old.status <> 'staged' then
    raise exception 'MIGRATION_BATCH_IMMUTABLE: only a staged file can be discarded or posted.';
  end if;
  if new.status not in ('discarded', 'posted') then
    raise exception 'MIGRATION_BATCH_IMMUTABLE: a staged file is discarded or posted.';
  end if;
  if (to_jsonb(new) - array['status', 'opening_id', 'decided_by', 'decided_at', 'updated_at'])
     is distinct from
     (to_jsonb(old) - array['status', 'opening_id', 'decided_by', 'decided_at', 'updated_at']) then
    raise exception 'MIGRATION_BATCH_IMMUTABLE: an imported file''s contents never change.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger migration_batches_transition
before update or delete on migration.batches
for each row execute function migration.assert_batch_transition();
--> statement-breakpoint

-- The opening is signed off once, and is otherwise permanent.
create or replace function migration.assert_opening_sign_off() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'MIGRATION_OPENING_IMMUTABLE: the opening of a brand''s books is permanent.';
  end if;
  if old.signed_off_at is not null then
    raise exception 'MIGRATION_OPENING_IMMUTABLE: the reconciliation is already signed off.';
  end if;
  if new.signed_off_at is null or new.signed_off_by is null then
    raise exception 'MIGRATION_OPENING_IMMUTABLE: only a sign-off may change the opening.';
  end if;
  if (to_jsonb(new) - array['signed_off_by', 'signed_off_at', 'sign_off_note', 'updated_at'])
     is distinct from
     (to_jsonb(old) - array['signed_off_by', 'signed_off_at', 'sign_off_note', 'updated_at']) then
    raise exception 'MIGRATION_OPENING_IMMUTABLE: only a sign-off may change the opening.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger migration_openings_sign_off
before update or delete on migration.openings
for each row execute function migration.assert_opening_sign_off();
