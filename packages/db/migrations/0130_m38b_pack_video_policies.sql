-- Tenant isolation and integrity for M38b: the packing station, its scans, the packing videos
-- and the brand's packing settings (invariant 4, §5, §9, §22; D-610 to D-615).
--
-- The policies are `tenantTableSql()`'s, pasted verbatim as every tenant policy in this repo
-- is (D-048). The grants are where the decisions are:
--
-- * `packing.settings`: one row per brand, written and edited, never deleted.
-- * `packing.sessions`: opened, then completed once; never deleted.
-- * `packing.scans`: the record of every scan, refused ones included; INSERT and SELECT only.
-- * `packing.videos`: registered, the file attached once, the deletion recorded by the
--   retention job; the row itself is never deleted.
--
-- No analytics read on any of them.

alter table "packing"."settings" enable row level security;
--> statement-breakpoint
alter table "packing"."settings" force row level security;
--> statement-breakpoint
drop policy if exists "settings_org_isolation" on "packing"."settings";
--> statement-breakpoint
create policy "settings_org_isolation" on "packing"."settings"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "packing" to "erp_app";
--> statement-breakpoint
grant select, insert, update on "packing"."settings" to "erp_app";
--> statement-breakpoint
alter table "packing"."sessions" enable row level security;
--> statement-breakpoint
alter table "packing"."sessions" force row level security;
--> statement-breakpoint
drop policy if exists "sessions_org_isolation" on "packing"."sessions";
--> statement-breakpoint
create policy "sessions_org_isolation" on "packing"."sessions"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "packing"."sessions" to "erp_app";
--> statement-breakpoint
alter table "packing"."scans" enable row level security;
--> statement-breakpoint
alter table "packing"."scans" force row level security;
--> statement-breakpoint
drop policy if exists "scans_org_isolation" on "packing"."scans";
--> statement-breakpoint
create policy "scans_org_isolation" on "packing"."scans"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert on "packing"."scans" to "erp_app";
--> statement-breakpoint
alter table "packing"."videos" enable row level security;
--> statement-breakpoint
alter table "packing"."videos" force row level security;
--> statement-breakpoint
drop policy if exists "videos_org_isolation" on "packing"."videos";
--> statement-breakpoint
create policy "videos_org_isolation" on "packing"."videos"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "packing"."videos" to "erp_app";
--> statement-breakpoint

-- A session is one order's, opened by one person; it completes once, and only with its order
-- packed (the state machine's `pack`, earlier in the same transaction, D-610). Nothing about
-- a completed session changes again.
create or replace function packing.assert_session_change() returns trigger
language plpgsql as $$
declare
  order_status text;
begin
  if (new.id, new.org_id, new.order_id, new.order_no, new.video_required, new.started_by,
      new.started_at, new.created_at)
     is distinct from
     (old.id, old.org_id, old.order_id, old.order_no, old.video_required, old.started_by,
      old.started_at, old.created_at) then
    raise exception 'CONFLICT: a packing session''s order and opening are fixed.';
  end if;
  if old.status = 'completed' then
    raise exception 'CONFLICT: a completed packing session does not change.';
  end if;
  if new.status = 'completed' then
    select o.status::text into order_status
      from sales.orders o
     where o.org_id = new.org_id and o.id = new.order_id;
    if order_status is distinct from 'packed' then
      raise exception 'CONFLICT: a packing session completes only with its order packed.';
    end if;
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger sessions_path
before update on packing.sessions
for each row execute function packing.assert_session_change();
--> statement-breakpoint

-- A session is opened only for a confirmed order (D-610).
create or replace function packing.assert_session_insert() returns trigger
language plpgsql as $$
declare
  order_status text;
begin
  if new.status <> 'open' then
    raise exception 'CONFLICT: a packing session opens before it completes.';
  end if;
  select o.status::text into order_status
    from sales.orders o
   where o.org_id = new.org_id and o.id = new.order_id;
  if order_status is distinct from 'confirmed' then
    raise exception 'CONFLICT: only a confirmed order is packed.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger sessions_insert_shape
before insert on packing.sessions
for each row execute function packing.assert_session_insert();
--> statement-breakpoint

-- A session that is already completed takes no more scans.
create or replace function packing.assert_session_open() returns trigger
language plpgsql as $$
declare
  session_status text;
begin
  select s.status into session_status
    from packing.sessions s
   where s.org_id = new.org_id and s.id = new.session_id;
  if session_status is distinct from 'open' then
    raise exception 'CONFLICT: this packing session is finished.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger scans_session_open
before insert on packing.scans
for each row execute function packing.assert_session_open();
--> statement-breakpoint

-- A video part is one session's, recorded by one person; its file is attached once (a stored,
-- private `packing-video` of the same brand) and replaced by nothing but the retention job's
-- deletion record (D-612). A deleted part stays deleted.
create or replace function packing.assert_video_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.session_id, new.part, new.recorded_by, new.started_at, new.mime,
      new.created_at)
     is distinct from
     (old.id, old.org_id, old.session_id, old.part, old.recorded_by, old.started_at, old.mime,
      old.created_at) then
    raise exception 'CONFLICT: a packing video''s session and recording are fixed.';
  end if;
  if old.deleted_at is not null then
    raise exception 'CONFLICT: a deleted packing video stays deleted.';
  end if;
  if old.file_id is not null then
    -- The only change to an attached part: the retention job's deletion of that very file.
    if new.file_id is not null
       or new.deleted_at is null
       or new.deleted_file_id is distinct from old.file_id
       or (new.duration_ms, new.size_bytes, new.uploaded_at)
          is distinct from (old.duration_ms, old.size_bytes, old.uploaded_at) then
      raise exception 'CONFLICT: a packing video''s file is attached once.';
    end if;
  elsif new.file_id is not null then
    if new.deleted_at is not null then
      raise exception 'CONFLICT: a packing video is attached or deleted, not both at once.';
    end if;
    if not exists (
      select 1 from files.objects f
       where f.org_id = new.org_id and f.id = new.file_id
         and f.purpose = 'packing-video' and f.status = 'stored' and f.visibility = 'private'
    ) then
      raise exception 'CONFLICT: a packing video''s file must be a stored, private packing video.';
    end if;
  elsif new.deleted_at is not null then
    raise exception 'CONFLICT: only an attached packing video is deleted.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger videos_path
before update on packing.videos
for each row execute function packing.assert_video_change();
--> statement-breakpoint

-- A part is registered without a file; the file follows once its upload is finalized.
create or replace function packing.assert_video_insert() returns trigger
language plpgsql as $$
begin
  if new.file_id is not null or new.deleted_at is not null then
    raise exception 'CONFLICT: a packing video is registered before its file arrives.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger videos_insert_shape
before insert on packing.videos
for each row execute function packing.assert_video_insert();
