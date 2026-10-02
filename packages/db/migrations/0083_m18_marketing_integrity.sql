-- What M18's tables refuse, in the database (M18; architecture §11, invariant 10).
--
-- Every rule below is also kept by the service that writes these rows. The duplication is
-- deliberate, as in 0070 and 0079: a service can be refactored or bypassed, a trigger
-- cannot. Each refusal starts with a code from `packages/contracts/src/errors.ts`.

-- A day's spend figure keeps its identity: the campaign and the date are what make the
-- import idempotent (M18 check 2), so they never change. A figure a person entered is not
-- overwritten by the Meta import (D-252); only another manual entry replaces it.
create or replace function marketing.assert_spend_change() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'MARKETING_SPEND_IMMUTABLE: a spend figure is replaced, never removed.';
  end if;
  if new.campaign_id <> old.campaign_id or new.spend_date <> old.spend_date
     or new.org_id <> old.org_id then
    raise exception 'MARKETING_SPEND_IMMUTABLE: a spend figure keeps its campaign and day.';
  end if;
  if old.source = 'manual' and new.source <> 'manual' then
    raise exception 'MARKETING_SPEND_IMMUTABLE: an imported figure never replaces one a person entered.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger ad_spend_change
before update or delete on marketing.ad_spend
for each row execute function marketing.assert_spend_change();--> statement-breakpoint

-- A conversion that was sent, or deliberately not sent, is final: a second send of the
-- same order would be a second purchase in the brand's Meta reports. Only the send job's
-- outcome columns may change, and only while the row is still queued or failed.
create or replace function marketing.assert_capi_outcome() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'MARKETING_CAPI_IMMUTABLE: the conversion log keeps every event.';
  end if;
  if old.status in ('sent', 'skipped') then
    raise exception 'MARKETING_CAPI_IMMUTABLE: a sent or skipped conversion is final.';
  end if;
  if (to_jsonb(new) - array['status', 'attempts', 'payload', 'value_poisha', 'event_time',
                             'response', 'last_error', 'sent_at', 'updated_at'])
     is distinct from
     (to_jsonb(old) - array['status', 'attempts', 'payload', 'value_poisha', 'event_time',
                             'response', 'last_error', 'sent_at', 'updated_at']) then
    raise exception 'MARKETING_CAPI_IMMUTABLE: only the send outcome may change.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger capi_events_outcome
before update or delete on marketing.capi_events
for each row execute function marketing.assert_capi_outcome();--> statement-breakpoint

-- A sent conversion's `event_id` is the order id (§11), never anything else: it is the
-- deduplication key Meta reads, and a row that disagreed with its own order would be a
-- second purchase the day it was retried.
alter table marketing.capi_events
  add constraint capi_events_event_id_is_order check (event_id = order_id::text);
