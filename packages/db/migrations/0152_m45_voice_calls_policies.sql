-- Tenant isolation and integrity for M45: the inbox's kept media and its calls (invariant 4;
-- D-780 to D-788).
--
-- The policies are `tenantTableSql()`'s, pasted verbatim as every tenant policy in this repo is
-- (D-048). The grants and triggers are where the decisions are:
--
-- * `media`: inserted with its message, then only its keeping moves (pending to stored or
--   failed, stored to expired when the retention rule deletes the file). Which message, which
--   attachment, its kind and direction never change; never deleted (D-783).
-- * `calls`: inserted at Meta's `connect`, then its state moves (trigger below); never deleted.
--
-- No analytics read on either.

alter table "inbox"."media" enable row level security;
--> statement-breakpoint
alter table "inbox"."media" force row level security;
--> statement-breakpoint
drop policy if exists "media_org_isolation" on "inbox"."media";
--> statement-breakpoint
create policy "media_org_isolation" on "inbox"."media"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "inbox"."media" to "erp_app";
--> statement-breakpoint
alter table "inbox"."calls" enable row level security;
--> statement-breakpoint
alter table "inbox"."calls" force row level security;
--> statement-breakpoint
drop policy if exists "calls_org_isolation" on "inbox"."calls";
--> statement-breakpoint
create policy "calls_org_isolation" on "inbox"."calls"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "inbox"."calls" to "erp_app";
--> statement-breakpoint

-- A kept attachment belongs to one message's one attachment, as what it was; only its keeping
-- moves: pending to stored or failed (a failed one may be tried again), and stored to expired
-- once, with the file cleared. An expired one never comes back.
create or replace function inbox.assert_media_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.message_id, new.conversation_id, new.position, new.kind,
      new.direction, new.occurred_at, new.created_at)
     is distinct from
     (old.id, old.org_id, old.message_id, old.conversation_id, old.position, old.kind,
      old.direction, old.occurred_at, old.created_at) then
    raise exception 'CONFLICT: a kept attachment''s message and place are fixed.'
      using errcode = 'check_violation';
  end if;
  if old.status = 'expired' and row(new.*) is distinct from row(old.*) then
    raise exception 'CONFLICT: an expired attachment does not change.'
      using errcode = 'check_violation';
  end if;
  if old.status = 'stored' and new.status not in ('stored', 'expired') then
    raise exception 'CONFLICT: a kept attachment is only ever expired.'
      using errcode = 'check_violation';
  end if;
  if old.status = 'stored' and new.status = 'stored'
     and new.file_id is distinct from old.file_id then
    raise exception 'CONFLICT: a kept attachment''s file is fixed.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger media_path
before update on inbox.media
for each row execute function inbox.assert_media_change();
--> statement-breakpoint

-- A call is the call Meta announced: its brand, conversation, channel, Meta's id, direction and
-- when it started never change, and a finished call (missed, declined, completed, failed) keeps
-- its outcome. What may still move once it is over: its end, Meta's duration and reason (the
-- terminate webhook can follow the agent's own hang-up), the SDP offer being cleared, and the
-- call-back item being dealt with once.
create or replace function inbox.assert_call_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.conversation_id, new.channel_id, new.provider_call_id,
      new.direction, new.started_at, new.created_at)
     is distinct from
     (old.id, old.org_id, old.conversation_id, old.channel_id, old.provider_call_id,
      old.direction, old.started_at, old.created_at) then
    raise exception 'CONFLICT: a call''s origin is fixed.'
      using errcode = 'check_violation';
  end if;
  if old.message_id is not null and new.message_id is distinct from old.message_id then
    raise exception 'CONFLICT: a call''s thread entry is set once.'
      using errcode = 'check_violation';
  end if;
  if old.status in ('missed', 'declined', 'completed', 'failed') then
    if new.status is distinct from old.status
       or new.answered_by is distinct from old.answered_by
       or new.declined_by is distinct from old.declined_by
       or new.connected_at is distinct from old.connected_at
       or (new.offer_sdp is not null and new.offer_sdp is distinct from old.offer_sdp) then
      raise exception 'CONFLICT: this call is over.'
        using errcode = 'check_violation';
    end if;
  end if;
  if old.callback_done_at is not null
     and (new.callback_done_at is distinct from old.callback_done_at
          or new.callback_done_by is distinct from old.callback_done_by
          or new.callback_needed is distinct from old.callback_needed) then
    raise exception 'CONFLICT: this call back was already dealt with.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger calls_path
before update on inbox.calls
for each row execute function inbox.assert_call_change();
