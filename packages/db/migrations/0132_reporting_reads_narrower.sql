-- The owner's reporting reads, narrower (D-483, the M32 ledger audit of 2026-10-07): the
-- least the owner's figures need, and the mother reads none of these. 0131 is live, so its
-- grants are taken back here rather than edited.
revoke select (confirmed_at, returned_at, cancelled_at) on sales.orders from erp_analytics;
--> statement-breakpoint
revoke select (qty, unit_price_poisha, discount_poisha, returned_qty) on sales.order_lines from erp_analytics;
--> statement-breakpoint
revoke select (join_date, leave_date) on hr.employees from erp_analytics;
