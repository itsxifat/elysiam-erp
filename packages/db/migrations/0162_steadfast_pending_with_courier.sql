-- D-902: Steadfast's `pending` is the courier having the parcel, `picked_up`, where it was
-- `pickup_pending`. The map changed in code; a parcel stored at Steadfast's `pending` before it
-- still reads `pickup_pending` here. Left alone, its next poll would see `picked_up`, count it a
-- change of status and restart its stuck-parcel clock (a parcel the rider never reported for
-- eight days would leave the queue for three), and D-903's sweep would read it as not received.
-- So the stored status follows the corrected word now, and `status_changed_at` does not move:
-- the parcel has held this status since the courier first said it.
--
-- The courier's events stay as they were (they are immutable, 0050): D-903 reads every stored
-- word through today's map, so an old `pending` event already counts as the courier having it.
--
-- One update across every brand, by the owner, as 0160 does: FORCE is lifted on the two tables it
-- reads for this statement (a cross-brand statement cannot satisfy a policy comparing `org_id`
-- with one `app.org_id`), and is back before the transaction ends.
alter table "courier"."consignments" no force row level security;
--> statement-breakpoint
alter table "courier"."courier_accounts" no force row level security;
--> statement-breakpoint
update courier.consignments c
set status = 'picked_up', updated_at = now()
from courier.courier_accounts a
where a.org_id = c.org_id
  and a.id = c.courier_account_id
  and a.provider_code = 'steadfast'
  and c.status = 'pickup_pending'
  and lower(trim(c.raw_status)) = 'pending';
--> statement-breakpoint
alter table "courier"."courier_accounts" force row level security;
--> statement-breakpoint
alter table "courier"."consignments" force row level security;
