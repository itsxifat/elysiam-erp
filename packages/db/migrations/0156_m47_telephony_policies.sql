-- Tenant isolation and integrity for M47: phone calls through Envo (invariant 4; D-830 to
-- D-853).
--
-- The policies are `tenantTableSql()`'s, pasted verbatim as every tenant policy in this repo is
-- (D-048). The grants and triggers are where the decisions are:
--
-- * `connections`: the brand's Envo connections, written and edited, never deleted (calls name
--   them; a connection is switched off instead).
-- * `extension_assignments`: a person is given an extension and later taken off it: INSERT and
--   DELETE (both audited by the service, D-846).
-- * `calls`: inserted (a click, or Envo's first word about a call), then only its progress moves
--   (the trigger below). Never deleted; a recording past its retention leaves its row `expired`.
-- * `webhook_events`: Envo's bodies, stored once, then only marked processed (trigger below).
--
-- No analytics read on any of them.

alter table "telephony"."connections" enable row level security;
--> statement-breakpoint
alter table "telephony"."connections" force row level security;
--> statement-breakpoint
drop policy if exists "connections_org_isolation" on "telephony"."connections";
--> statement-breakpoint
create policy "connections_org_isolation" on "telephony"."connections"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "telephony" to "erp_app";
--> statement-breakpoint
grant select, insert, update on "telephony"."connections" to "erp_app";
--> statement-breakpoint
alter table "telephony"."extension_assignments" enable row level security;
--> statement-breakpoint
alter table "telephony"."extension_assignments" force row level security;
--> statement-breakpoint
drop policy if exists "extension_assignments_org_isolation" on "telephony"."extension_assignments";
--> statement-breakpoint
create policy "extension_assignments_org_isolation" on "telephony"."extension_assignments"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, delete on "telephony"."extension_assignments" to "erp_app";
--> statement-breakpoint
alter table "telephony"."calls" enable row level security;
--> statement-breakpoint
alter table "telephony"."calls" force row level security;
--> statement-breakpoint
drop policy if exists "calls_org_isolation" on "telephony"."calls";
--> statement-breakpoint
create policy "calls_org_isolation" on "telephony"."calls"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "telephony"."calls" to "erp_app";
--> statement-breakpoint
alter table "telephony"."webhook_events" enable row level security;
--> statement-breakpoint
alter table "telephony"."webhook_events" force row level security;
--> statement-breakpoint
drop policy if exists "webhook_events_org_isolation" on "telephony"."webhook_events";
--> statement-breakpoint
create policy "webhook_events_org_isolation" on "telephony"."webhook_events"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "telephony"."webhook_events" to "erp_app";
--> statement-breakpoint

-- A connection's identity is fixed: the brand, who added it and when.
create or replace function telephony.assert_connection_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.created_by, new.created_at)
     is distinct from (old.id, old.org_id, old.created_by, old.created_at) then
    raise exception 'CONFLICT: a connection''s identity is fixed.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger connections_identity
before update on telephony.connections
for each row execute function telephony.assert_connection_change();
--> statement-breakpoint

-- A call is the call it was (D-837): its brand, connection, how the ERP first heard of it, when
-- it happened and when it was asked for never change. Envo's id, the person, the customer, the
-- order and its owner, the extension, the start, the answer and the end are each set once. The
-- status moves forward only (requested, dialing, ringing, answered, ended; a click that Envo
-- refused fails) and a finished call stays finished; an answered call stays answered. Its
-- numbers may still be learned until it ends, and after only where they were missing. The
-- recording goes none or failed to pending, pending to stored or failed, stored to expired (its
-- file cleared), and an expired one never changes. The verification outcome is recorded once.
create or replace function telephony.call_rank(status text) returns integer
language sql immutable as $$
  select case status
    when 'requested' then 0 when 'dialing' then 1 when 'ringing' then 2
    when 'answered' then 3 when 'ended' then 4 when 'failed' then 4 else -1 end
$$;
--> statement-breakpoint
create or replace function telephony.assert_call_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.connection_id, new.first_seen, new.occurred_at, new.requested_at,
      new.created_at)
     is distinct from
     (old.id, old.org_id, old.connection_id, old.first_seen, old.occurred_at, old.requested_at,
      old.created_at) then
    raise exception 'CONFLICT: a call''s origin is fixed.'
      using errcode = 'check_violation';
  end if;
  if (old.envo_call_id is not null and new.envo_call_id is distinct from old.envo_call_id)
     or (old.user_id is not null and new.user_id is distinct from old.user_id)
     or (old.customer_id is not null and new.customer_id is distinct from old.customer_id)
     or (old.order_id is not null and new.order_id is distinct from old.order_id)
     or (old.order_owner_user_id is not null
         and new.order_owner_user_id is distinct from old.order_owner_user_id)
     or (old.extension is not null and new.extension is distinct from old.extension)
     or (old.customer_phone_e164 is not null
         and new.customer_phone_e164 is distinct from old.customer_phone_e164)
     or (old.started_at is not null and new.started_at is distinct from old.started_at)
     or (old.answered_at is not null and new.answered_at is distinct from old.answered_at)
     or (old.ended_at is not null and new.ended_at is distinct from old.ended_at)
     or (old.error_code is not null and new.error_code is distinct from old.error_code)
     or (old.recording_url is not null and new.recording_url is distinct from old.recording_url)
     or (old.outcome_attempt_id is not null
         and (new.outcome_attempt_id, new.outcome) is distinct from
             (old.outcome_attempt_id, old.outcome)) then
    raise exception 'CONFLICT: that part of a call is set once.'
      using errcode = 'check_violation';
  end if;
  if old.direction <> 'unknown' and new.direction is distinct from old.direction then
    raise exception 'CONFLICT: a call''s direction is fixed once known.'
      using errcode = 'check_violation';
  end if;
  if old.answered and not new.answered then
    raise exception 'CONFLICT: an answered call stays answered.'
      using errcode = 'check_violation';
  end if;
  if old.status in ('ended', 'failed') and new.status is distinct from old.status then
    raise exception 'CONFLICT: this call is over.'
      using errcode = 'check_violation';
  end if;
  if telephony.call_rank(new.status) < telephony.call_rank(old.status)
     or (new.status = 'failed' and old.status not in ('requested', 'dialing', 'failed')) then
    raise exception 'CONFLICT: a call''s status only moves forward.'
      using errcode = 'check_violation';
  end if;
  if old.status = 'ended'
     and ((old.from_number is not null and new.from_number is distinct from old.from_number)
          or (old.to_number is not null and new.to_number is distinct from old.to_number)) then
    raise exception 'CONFLICT: a finished call''s numbers are fixed.'
      using errcode = 'check_violation';
  end if;
  if new.recording_status is distinct from old.recording_status then
    if not (
      (old.recording_status in ('none', 'failed') and new.recording_status in ('pending', 'failed'))
      or (old.recording_status = 'pending' and new.recording_status in ('stored', 'failed'))
      or (old.recording_status = 'stored' and new.recording_status = 'expired')
    ) then
      raise exception 'CONFLICT: a recording does not go from % to %.',
        old.recording_status, new.recording_status
        using errcode = 'check_violation';
    end if;
  end if;
  if old.recording_status = 'expired' and (new.recording_file_id, new.recording_bytes)
     is distinct from (old.recording_file_id, old.recording_bytes) then
    raise exception 'CONFLICT: an expired recording does not come back.'
      using errcode = 'check_violation';
  end if;
  if old.recording_status = 'stored' and new.recording_status = 'stored'
     and new.recording_file_id is distinct from old.recording_file_id then
    raise exception 'CONFLICT: a kept recording''s file is fixed.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger calls_path
before update on telephony.calls
for each row execute function telephony.assert_call_change();
--> statement-breakpoint

-- A webhook body is what Envo sent: only when it was processed and what it came to are written,
-- once.
create or replace function telephony.assert_webhook_event_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.connection_id, new.event, new.envo_call_id, new.delivery_id,
      new.body, new.received_at, new.created_at)
     is distinct from
     (old.id, old.org_id, old.connection_id, old.event, old.envo_call_id, old.delivery_id,
      old.body, old.received_at, old.created_at) then
    raise exception 'CONFLICT: a webhook body is kept as it arrived.'
      using errcode = 'check_violation';
  end if;
  if old.processed_at is not null
     and (new.processed_at, new.outcome) is distinct from (old.processed_at, old.outcome) then
    raise exception 'CONFLICT: a webhook body is processed once.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger webhook_events_path
before update on telephony.webhook_events
for each row execute function telephony.assert_webhook_event_change();
