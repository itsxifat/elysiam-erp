-- The order desk's two reads that the M10 indexes do not serve (M11; architecture §9, §24).
--
-- * `orders_org_phone_created_idx` answers the duplicate warning — "has this number
--   ordered this SKU in the last 24 hours" — which the desk asks on every entry, while the
--   agent is still on the phone. The trigram index from 0043 answers a fragment of a
--   number, not equality inside a time window, and without this the check reads every
--   order the number has ever placed.
-- * `orders_org_channel_created_idx` answers the order list's and the buyer list's channel
--   filter, both of which always come with a date range.
--
-- Plain CREATE INDEX rather than CONCURRENTLY: the migrator runs each file in a
-- transaction, and CONCURRENTLY refuses to run inside one. Both are built while the order
-- table is small; a brand with millions of rows would take the lock for seconds, which is
-- the trade every index in this repository has made.

CREATE INDEX "orders_org_phone_created_idx" ON "sales"."orders" USING btree ("org_id","ship_phone_e164","created_at");--> statement-breakpoint
CREATE INDEX "orders_org_channel_created_idx" ON "sales"."orders" USING btree ("org_id","channel","created_at");
