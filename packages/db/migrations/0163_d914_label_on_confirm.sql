-- D-914: an order is ready for its label once it is confirmed, with its consignment once the
-- courier gives one. An own rider's order, one booked by hand and one whose booking failed never
-- get a consignment from a booking job, so `consignment_no` is null until (or unless) one comes.
ALTER TABLE "packing"."label_orders" DROP CONSTRAINT "label_orders_consignment_length";--> statement-breakpoint
ALTER TABLE "packing"."label_orders" ALTER COLUMN "consignment_no" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "packing"."label_orders" ADD CONSTRAINT "label_orders_consignment_length" CHECK ("packing"."label_orders"."consignment_no" is null or length("packing"."label_orders"."consignment_no") between 1 and 120);
--> statement-breakpoint

-- The orders confirmed before D-914 that never reached "Ready for label" (no row: no consignment
-- ever came back) and whose slip the hub has not printed: listed now with no consignment, ready
-- since they were confirmed, for a person to print (nothing is printed by this migration). Orders
-- on hold are listed too, so they show once released. `sales.orders` is read here once, by the
-- owner, never by the packing module's code (invariant 12).
--
-- FORCE is lifted for this one statement on the two tables it touches, as 0154 and 0162 do and for
-- their reason: a cross-brand statement cannot satisfy a policy comparing `org_id` with one
-- `app.org_id`, and FORCE is what binds the owner running it. `erp_app` is not the owner, so the
-- policies bind it whatever FORCE says; FORCE is back before the migration's transaction ends.
-- On a new database (migrations run before the seed) there is nothing to copy.
alter table "packing"."label_orders" no force row level security;
--> statement-breakpoint
alter table "sales"."orders" no force row level security;
--> statement-breakpoint
insert into packing.label_orders (org_id, order_id, order_no, consignment_no, location_id, booked_at)
select o.org_id, o.id, o.order_no, null, o.location_id, coalesce(o.confirmed_at, o.updated_at)
from sales.orders o
where o.status in ('confirmed', 'on_hold')
  and o.slip_printed_at is null
  and not exists (
    select 1 from packing.label_orders lo where lo.org_id = o.org_id and lo.order_id = o.id
  )
on conflict (org_id, order_id) do nothing;
--> statement-breakpoint
alter table "sales"."orders" force row level security;
--> statement-breakpoint
alter table "packing"."label_orders" force row level security;