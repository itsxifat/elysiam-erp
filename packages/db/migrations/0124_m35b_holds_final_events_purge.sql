-- M35b, after the ledger audit (notes 2 and 11). Two changes to 0119's rules, as a migration of
-- their own because a committed migration is never edited (invariant 9).
--
-- * A marketplace hold ends once: released or converted is final. 0119 refused a change only to
--   a converted hold, so a released hold could have been marked held (or converted) again
--   without its units being held again. The code never does that; the table now cannot.
-- * `marketplace.ncom_events` (one claim per webhook event) may be pruned: the marketplace's
--   sweep deletes claims older than 90 days, long past any redelivery ncom makes.

create or replace function marketplace.assert_ncom_hold_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.order_ref, new.location_id, new.created_at)
     is distinct from (old.id, old.org_id, old.order_ref, old.location_id, old.created_at) then
    raise exception 'CONFLICT: a marketplace hold names one reference at one place.';
  end if;
  if old.state <> 'held' then
    raise exception 'CONFLICT: a hold that has ended does not change.';
  end if;
  if new.state = 'held' and new.lines is distinct from old.lines then
    raise exception 'CONFLICT: a live hold''s lines are fixed.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
grant delete on "marketplace"."ncom_events" to "erp_app";
