-- Integrity for the owner's answers to M47 (D-858, D-859, D-860), after 0157 changed the columns.
--
-- * `telephony.calls`: the recording now stays with Envo (D-858), so the call keeps only Envo's
--   address for it (`recording_url`, set once) and its storage columns are gone. The trigger
--   function is replaced so it no longer names them. The person's wrap-up (D-859) is written
--   once, on an ended call, by the person on it, and never changes after.
-- * `sales.customers`: the pinned note (D-860) is ordinary editable data; its shape is the
--   table's checks (`customers_pinned_note`, `customers_pinned_note_whole`).
--
-- No new grants: `erp_app` already holds SELECT, INSERT and UPDATE on both tables (0040, 0156),
-- and no column grant narrows either. `iam.users` is global (no `org_id`), so the new user
-- columns reference it alone, as `telephony.calls.user_id` does; RLS on the row's own `org_id`
-- is what keeps a brand's row its own.

-- A call is the call it was (D-837): its brand, connection, how the ERP first heard of it, when
-- it happened and when it was asked for never change. Envo's id, the person, the customer, the
-- order and its owner, the extension, the start, the answer, the end and the recording's
-- address are each set once. The status moves forward only (requested, dialing, ringing,
-- answered, ended; a click that Envo refused fails) and a finished call stays finished; an
-- answered call stays answered. Its numbers may still be learned until it ends, and after only
-- where they were missing. The verification outcome is recorded once. The wrap-up is written
-- once, by the person on the call after it ended, and is then fixed.
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
     or (old.order_id is not null
         and (new.order_id, new.order_no) is distinct from (old.order_id, old.order_no))
     or (old.customer_name is not null and new.customer_name is distinct from old.customer_name)
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
  -- Envo measures the seconds when it sends each event, so a late call.started (talk 0) must not
  -- undo call.ended's: once known, talk time and duration only grow.
  if (old.talk_seconds is not null
      and (new.talk_seconds is null or new.talk_seconds < old.talk_seconds))
     or (old.duration_seconds is not null
         and (new.duration_seconds is null or new.duration_seconds < old.duration_seconds)) then
    raise exception 'CONFLICT: a call''s talk time and duration only grow.'
      using errcode = 'check_violation';
  end if;
  -- The wrap-up (D-859): its parts come together (`calls_wrap_up_whole`), once.
  if old.wrapped_up_at is not null
     and (new.wrap_up_result, new.wrap_up_note, new.wrap_up_call_back_at,
          new.wrapped_up_by_user_id, new.wrapped_up_at)
         is distinct from
         (old.wrap_up_result, old.wrap_up_note, old.wrap_up_call_back_at,
          old.wrapped_up_by_user_id, old.wrapped_up_at) then
    raise exception 'CONFLICT: a call''s wrap-up is written once.'
      using errcode = 'check_violation';
  end if;
  if old.wrapped_up_at is null and new.wrapped_up_at is not null
     and (new.status <> 'ended' or new.user_id is null
          or new.wrapped_up_by_user_id is distinct from new.user_id) then
    raise exception 'CONFLICT: only the person on a call wraps it up, once it has ended.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
