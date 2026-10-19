-- Integrity for M48's customer numbers and people (D-870 to D-889), after 0159 made the tables.
--
-- * `sales.customer_phones`: a buyer's numbers, each with its rank, kind, relation and the staff's
--   note. Tenant table: RLS ENABLE + FORCE and the standard policy. `erp_app` may read, add and
--   change them (rank, note, retiring) and never delete one: a retired number stays in the
--   person's history (D-873).
-- * Every buyer's current number becomes their rank-1 own number (D-870), `order` when they have
--   an order and `import` otherwise, with no note: it shows "needs details" until staff write one.
-- * `telephony.calls`: a call's customer is still set once, except that a merge (D-885) may move it
--   from the merged record to the record it was merged into.

alter table "sales"."customer_phones" enable row level security;
--> statement-breakpoint
alter table "sales"."customer_phones" force row level security;
--> statement-breakpoint
drop policy if exists "customer_phones_org_isolation" on "sales"."customer_phones";
--> statement-breakpoint
create policy "customer_phones_org_isolation" on "sales"."customer_phones"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "sales"."customer_phones" to "erp_app";
--> statement-breakpoint

-- Search finds a buyer by any of their numbers, fragments included (D-877), as 0043 does for the
-- buyer's own column.
create index if not exists "customer_phones_phone_trgm_idx" on "sales"."customer_phones"
  using gin ("phone_e164" gin_trgm_ops) where "retired_at" is null;
--> statement-breakpoint

-- The backfill reads and writes every brand's rows once, by the owner, as 0154 does: FORCE is
-- lifted for these statements on the tables they touch (a cross-org statement cannot satisfy a
-- policy comparing `org_id` with one `app.org_id`), and is back before the transaction ends.
alter table "sales"."customer_phones" no force row level security;
--> statement-breakpoint
alter table "sales"."customers" no force row level security;
--> statement-breakpoint
alter table "sales"."orders" no force row level security;
--> statement-breakpoint
insert into sales.customer_phones
  (org_id, customer_id, phone_e164, rank, kind, relation, note, source, added_at)
select c.org_id, c.id, c.phone_e164, 1, 'mobile', 'own', null,
       case when exists (select 1 from sales.orders o
                         where o.org_id = c.org_id and o.customer_id = c.id)
            then 'order' else 'import' end,
       c.created_at
from sales.customers c
where not exists (select 1 from sales.customer_phones p
                  where p.org_id = c.org_id and p.customer_id = c.id);
--> statement-breakpoint
alter table "sales"."orders" force row level security;
--> statement-breakpoint
alter table "sales"."customers" force row level security;
--> statement-breakpoint
alter table "sales"."customer_phones" force row level security;
--> statement-breakpoint

-- 0158's function, with one clause changed: the customer may move from a record to the one it was
-- merged into (D-885). Everything else about a call is as 0158 left it.
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
     or (old.customer_id is not null and new.customer_id is distinct from old.customer_id
         and not exists (select 1 from sales.customers c
                         where c.org_id = old.org_id and c.id = old.customer_id
                           and c.merged_into_customer_id = new.customer_id))
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
