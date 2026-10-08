-- M38c ledger audit (N1, N2, N4): the camera recording's window, held by the database.
--
-- 0135's `sessions_recording_path` keeps the window set once. This adds what the audit found
-- the service alone held:
--
-- * N1: a packing's camera is fixed once a piece is in the box. A camera chosen after an
--   accepted scan would start at the second correct piece, not the first (D-671).
-- * N2: the window starts only from the session's first accepted scan, by its scanner, two
--   seconds before it (`scanned_at` - 2 s; the service computes it in milliseconds, so the
--   scan lies within the millisecond after `recording_from + 2 s`).
-- * N4: a recording starts only on a camera that is switched on.
--
-- 0134 and 0135 are not edited (invariant 9); this is a second trigger beside 0135's.

create or replace function packing.assert_session_recording_scan() returns trigger
language plpgsql as $$
declare
  first_accepted timestamptz;
  first_scanner text;
begin
  if new.camera_id is distinct from old.camera_id and exists (
    select 1 from packing.scans s
     where s.org_id = new.org_id and s.session_id = new.id and s.outcome = 'accepted'
  ) then
    raise exception 'CONFLICT: the camera of a packing is fixed once a piece is in the box.';
  end if;
  if old.recording_from is null and new.recording_from is not null then
    if not exists (
      select 1 from packing.cameras c
       where c.org_id = new.org_id and c.id = new.camera_id and c.enabled
    ) then
      raise exception 'CONFLICT: a camera that is switched off does not record.';
    end if;
    select s.scanned_at, s.scanned_by into first_accepted, first_scanner
      from packing.scans s
     where s.org_id = new.org_id and s.session_id = new.id and s.outcome = 'accepted'
     order by s.scanned_at, s.id
     limit 1;
    if first_accepted is null
       or first_accepted < new.recording_from + interval '2 seconds'
       or first_accepted >= new.recording_from + interval '2.001 seconds'
       or first_scanner is distinct from new.recording_by then
      raise exception 'CONFLICT: a camera recording starts two seconds before the first accepted scan.';
    end if;
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger sessions_recording_scan
before update on packing.sessions
for each row execute function packing.assert_session_recording_scan();
