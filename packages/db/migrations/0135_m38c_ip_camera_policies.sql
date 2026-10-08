-- Tenant isolation and integrity for M38c: the packing table's IP cameras and the camera
-- recording's window on a packing session (invariant 4, §5, §31; D-668 to D-676).
--
-- The policy is `tenantTableSql()`'s, pasted verbatim as every tenant policy in this repo is
-- (D-048). `packing.cameras` is created and edited, never deleted (a session and a video name
-- the camera that filmed them; a camera is switched off instead), so `erp_app` gets SELECT,
-- INSERT and UPDATE. No analytics read.

alter table "packing"."cameras" enable row level security;
--> statement-breakpoint
alter table "packing"."cameras" force row level security;
--> statement-breakpoint
drop policy if exists "cameras_org_isolation" on "packing"."cameras";
--> statement-breakpoint
create policy "cameras_org_isolation" on "packing"."cameras"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "packing"."cameras" to "erp_app";
--> statement-breakpoint

-- A camera keeps its identity and who added it.
create or replace function packing.assert_camera_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.created_by, new.created_at)
     is distinct from (old.id, old.org_id, old.created_by, old.created_at) then
    raise exception 'CONFLICT: a camera''s identity is fixed.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger cameras_identity
before update on packing.cameras
for each row execute function packing.assert_camera_change();
--> statement-breakpoint

-- A session opens with no recording: the window starts only at a scan the station accepted.
create or replace function packing.assert_session_recording_insert() returns trigger
language plpgsql as $$
begin
  if new.recording_from is not null or new.recording_to is not null or new.recording_by is not null then
    raise exception 'CONFLICT: a packing session opens before its camera records.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger sessions_insert_recording
before insert on packing.sessions
for each row execute function packing.assert_session_recording_insert();
--> statement-breakpoint

-- The camera recording's window (D-671): the camera may change only until recording starts;
-- the start, who started it and the end are each set once and never moved. The start is set
-- on an open session (by its first accepted scan), and the end either with the finish or by
-- the fifteen-minute sweep of a session still open. 0130's `sessions_path` already refuses any
-- change to a completed session, so a window cannot be rewritten after the box is closed.
create or replace function packing.assert_session_recording_change() returns trigger
language plpgsql as $$
begin
  if old.recording_from is not null then
    if new.camera_id is distinct from old.camera_id then
      raise exception 'CONFLICT: the camera of a packing is fixed once it records.';
    end if;
    if (new.recording_from, new.recording_by) is distinct from (old.recording_from, old.recording_by) then
      raise exception 'CONFLICT: a camera recording''s start is set once.';
    end if;
  elsif new.recording_from is not null and old.status <> 'open' then
    raise exception 'CONFLICT: a camera recording starts only while the packing is open.';
  end if;
  if old.recording_to is not null and new.recording_to is distinct from old.recording_to then
    raise exception 'CONFLICT: a camera recording''s end is set once.';
  end if;
  if new.camera_id is not null and new.camera_id is distinct from old.camera_id then
    if not exists (
      select 1 from packing.cameras c
       where c.org_id = new.org_id and c.id = new.camera_id and c.enabled
    ) then
      raise exception 'CONFLICT: that camera is switched off.';
    end if;
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger sessions_recording_path
before update on packing.sessions
for each row execute function packing.assert_session_recording_change();
--> statement-breakpoint

-- A video part keeps who filmed it (D-674). A camera's part belongs to a session that camera
-- filmed, whose window is closed: it is cut from that window, never uploaded by a browser.
create or replace function packing.assert_video_source() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if (new.source, new.camera_id) is distinct from (old.source, old.camera_id) then
      raise exception 'CONFLICT: a packing video''s source is fixed.';
    end if;
    return new;
  end if;
  if new.source = 'camera' and not exists (
    select 1 from packing.sessions s
     where s.org_id = new.org_id and s.id = new.session_id
       and s.camera_id = new.camera_id and s.recording_to is not null
  ) then
    raise exception 'CONFLICT: a camera''s video belongs to a packing that camera filmed.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger videos_source
before insert or update on packing.videos
for each row execute function packing.assert_video_source();
