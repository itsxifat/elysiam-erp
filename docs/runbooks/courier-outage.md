# Courier outage

What to do when a courier's API (Steadfast, Pathao, RedX) is down, slow or refusing, and how
to catch up afterwards (architecture §9, §20, §21). Nothing here touches money by hand:
deliveries, returns and settlements still post only through their own flows.

## How it shows

- The order desk's bookings stay **pending**, then turn **failed**. Each booking is retried
  five times with backoff (5 seconds up to 15 minutes) and then dead-lettered: the parcel is
  flagged `failed`, every org admin gets `delivery.booking_failed`, and Sentry gets a
  `job dead-lettered on delivery.book_parcel` event (`monitoring.md`).
- Parcel statuses stop moving: the status poll and webhooks bring nothing, and parcels pile
  up in **Courier → Stuck** (`/courier/stuck`).
- A settlement fetch fails, or finds nothing.
- The courier's own status page or merchant support says so.

Confirm it is the courier and not us: `/health/ready` is green, other couriers are booking,
and the worker logs show the courier's error code (`kamal app logs $K --roles worker | grep -i courier`).
Courier errors are logged as codes; the parcel's address and phone never reach the log.

## During the outage

1. **Tell the desks.** Agents keep confirming orders; nothing is lost. Bookings that fail are
   flagged, not dropped.
2. **Decide whether to wait or move.** For a short outage (under two hours), wait. For a
   longer one, new orders can go with another courier the brand has an account with:
   - New orders: the brand's selection rules choose which courier an order gets. Point them
     at the other courier for now. There is no screen for them yet: an org admin sends
     `PUT /v1/courier/selection-rules` (`GET` first, to keep the current rules to restore).
   - Orders already assigned: a parcel goes with its order's courier (M15). Change the
     order's courier on the order, then book it.
3. **Do not hand parcels over without a consignment.** A parcel handed to a rider with no
   booking has no tracking, no COD reconciliation and no settlement match.
4. **Pickups already made** with the courier continue offline at their end; their statuses
   arrive when the API returns.

## After it recovers

1. **Re-book the failed parcels.** **Courier → Parcels** shows each parcel's booking state;
   book the failed ones again from the order desk, or in bulk (`POST /v1/courier/parcels/bulk`). A failed booking leaves
   no live parcel, so the order books afresh; a booking that did reach the courier before
   failing here is visible at the courier, so check the merchant panel for duplicates first.
2. **Catch up statuses.** **Courier → Stuck** → re-poll (`POST /v1/courier/stuck/repoll`).
   Webhooks the courier queued arrive on their own.
3. **Catch up settlements.** **Courier → Settlements** → fetch again
   (`POST /v1/courier/settlements/fetch`), or upload the courier's statement file. A
   settlement dated in a month already closed posts to the earliest open period (D-037).
4. **Restore the selection rules** if they were changed.
5. **Clear the failed-jobs view.** Super admin: `GET /v1/jobs/failed` lists what
   dead-lettered; each re-booked parcel answers its own entry.

## If the courier changed its API

A refusal that will not go away after the outage (new fields, a new host) is not an outage.
Every adapter but the fake one is marked UNVERIFIED in decisions.md: the host, paths and
status words are configuration (`COURIER_*_BASE_URL` and friends in `.env.example`). Change
the configuration if that is enough; otherwise it is a code change and a release.

## Record

| Date | Courier | From–to | Orders affected | Moved to | Re-booked | Notes | By  |
| ---- | ------- | ------- | --------------- | -------- | --------- | ----- | --- |
|      |         |         |                 |          |           |       |     |
