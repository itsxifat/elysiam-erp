-- M51 (D-930 to D-936): label to label, one video per lot, and the return station.
--
-- * `packing.recordings`: tenant isolation (the policy is `tenantTableSql()`'s, pasted as every
--   tenant policy in this repo is, D-048). Started and stopped, never deleted: INSERT, SELECT,
--   UPDATE. A recording starts from the lot's label scan, by its scanner, at its time, on an open
--   session, on a camera that is on; its start, source and idle time are fixed and its stop set
--   once.
-- * `packing.sessions`: a session is a packing (`pack`, a confirmed order, completed with it
--   packed, as 0130) or a return (`return`, an order on its way back or partly delivered,
--   completed with it returned). The kind is fixed.
-- * `packing.videos`: a part's recording and lot are fixed; a camera's part belongs either to the
--   session's closed M38c window (0154) or to a stopped recording that camera filmed; a browser's
--   part with a recording belongs to a recording no IP camera films.
--
-- 0130, 0135, 0136 and 0154 are not edited (invariant 9): their functions are replaced here.

alter table "packing"."recordings" enable row level security;
--> statement-breakpoint
alter table "packing"."recordings" force row level security;
--> statement-breakpoint
drop policy if exists "recordings_org_isolation" on "packing"."recordings";
--> statement-breakpoint
create policy "recordings_org_isolation" on "packing"."recordings"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "packing"."recordings" to "erp_app";
--> statement-breakpoint

create or replace function packing.assert_session_change() returns trigger
language plpgsql as $$
declare
  order_status text;
begin
  if (new.id, new.org_id, new.order_id, new.order_no, new.video_required, new.started_by,
      new.started_at, new.created_at, new.kind)
     is distinct from
     (old.id, old.org_id, old.order_id, old.order_no, old.video_required, old.started_by,
      old.started_at, old.created_at, old.kind) then
    raise exception 'CONFLICT: a packing session''s order and opening are fixed.';
  end if;
  if old.status = 'completed' then
    raise exception 'CONFLICT: a completed packing session does not change.';
  end if;
  if new.status = 'completed' then
    select o.status::text into order_status
      from sales.orders o
     where o.org_id = new.org_id and o.id = new.order_id;
    if new.kind = 'pack' and order_status is distinct from 'packed' then
      raise exception 'CONFLICT: a packing session completes only with its order packed.';
    end if;
    if new.kind = 'return' and order_status is distinct from 'returned' then
      raise exception 'CONFLICT: a return inspection completes only with its order returned.';
    end if;
  end if;
  return new;
end;
$$;
--> statement-breakpoint

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
  if new.kind = 'pack' and order_status is distinct from 'confirmed' then
    raise exception 'CONFLICT: only a confirmed order is packed.';
  end if;
  if new.kind = 'return'
     and (order_status is null or order_status not in ('return_in_transit', 'partially_delivered')) then
    raise exception 'CONFLICT: only a parcel on its way back is received as a return.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint

create or replace function packing.assert_recording_insert() returns trigger
language plpgsql as $$
begin
  if new.stopped_at is not null or new.stopped_by is not null or new.stop_reason is not null then
    raise exception 'CONFLICT: a recording starts before it stops.';
  end if;
  if not exists (
    select 1 from packing.sessions s
     where s.org_id = new.org_id and s.id = new.session_id and s.status = 'open'
  ) then
    raise exception 'CONFLICT: a recording starts only while its session is open.';
  end if;
  if not exists (
    select 1 from packing.scans c
     where c.org_id = new.org_id and c.session_id = new.session_id and c.lot_no = new.lot_no
       and c.outcome = 'label' and c.scanned_at = new.started_at and c.scanned_by = new.started_by
  ) then
    raise exception 'CONFLICT: a recording starts with its lot''s label scan.';
  end if;
  if new.camera_id is not null and not exists (
    select 1 from packing.cameras c
     where c.org_id = new.org_id and c.id = new.camera_id and c.enabled
  ) then
    raise exception 'CONFLICT: a camera that is switched off does not record.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger recordings_insert_shape
before insert on packing.recordings
for each row execute function packing.assert_recording_insert();
--> statement-breakpoint

create or replace function packing.assert_recording_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.session_id, new.lot_no, new.video_required, new.camera_id,
      new.idle_ms, new.started_at, new.started_by, new.created_at)
     is distinct from
     (old.id, old.org_id, old.session_id, old.lot_no, old.video_required, old.camera_id,
      old.idle_ms, old.started_at, old.started_by, old.created_at) then
    raise exception 'CONFLICT: a recording''s lot, source and start are fixed.';
  end if;
  if old.stopped_at is not null
     and (new.stopped_at, new.stopped_by, new.stop_reason)
         is distinct from (old.stopped_at, old.stopped_by, old.stop_reason) then
    raise exception 'CONFLICT: a recording''s stop is set once.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger recordings_path
before update on packing.recordings
for each row execute function packing.assert_recording_change();
--> statement-breakpoint

create or replace function packing.assert_video_source() returns trigger
language plpgsql as $$
declare
  rec_session uuid;
  rec_lot integer;
  rec_camera uuid;
  rec_stopped timestamptz;
begin
  if tg_op = 'UPDATE' then
    if (new.source, new.camera_id, new.recording_id, new.lot_no)
       is distinct from (old.source, old.camera_id, old.recording_id, old.lot_no) then
      raise exception 'CONFLICT: a packing video''s source is fixed.';
    end if;
    return new;
  end if;
  if new.recording_id is not null then
    select r.session_id, r.lot_no, r.camera_id, r.stopped_at
      into rec_session, rec_lot, rec_camera, rec_stopped
      from packing.recordings r
     where r.org_id = new.org_id and r.id = new.recording_id;
    if rec_session is distinct from new.session_id or rec_lot is distinct from new.lot_no then
      raise exception 'CONFLICT: a packing video belongs to its own lot''s recording.';
    end if;
    if new.source = 'camera' and (
      rec_stopped is null or rec_camera is null
      or (rec_camera is distinct from new.camera_id and not exists (
        select 1 from packing.session_cameras c
         where c.org_id = new.org_id and c.session_id = new.session_id
           and c.camera_id = new.camera_id
      ))
    ) then
      raise exception 'CONFLICT: a camera''s video belongs to a stopped recording that camera filmed.';
    end if;
    if new.source = 'browser' and rec_camera is not null then
      raise exception 'CONFLICT: an IP camera films that lot; this computer''s video is not its.';
    end if;
    return new;
  end if;
  if new.source = 'camera' and not exists (
    select 1 from packing.sessions s
     where s.org_id = new.org_id and s.id = new.session_id and s.recording_to is not null
       and (s.camera_id = new.camera_id
            or exists (
              select 1 from packing.session_cameras c
               where c.org_id = s.org_id and c.session_id = s.id and c.camera_id = new.camera_id
            ))
  ) then
    raise exception 'CONFLICT: a camera''s video belongs to a packing that camera filmed.';
  end if;
  return new;
end;
$$;
