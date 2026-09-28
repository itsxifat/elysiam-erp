-- Buyer and order lookup (M10; architecture §9, §29).
--
-- Three reads dominate the order desk, and each one gets the index it needs rather than
-- the index that looks reasonable:
--
-- * **"who is this number"** — an agent takes a call and types a phone number, often a
--   fragment of one. `customers_org_phone_idx` (0039) already answers the exact lookup
--   that keys a buyer; this adds a trigram index so the *partial* one does not become a
--   sequential scan over every buyer the brand has ever had.
-- * **"find this order"** — by number, by the buyer's name, by the phone on the parcel.
--   A trigram index on `order_no` is what makes the last five digits a usable search,
--   which is how a customer reads their number out over the phone.
-- * **"what is on my desk"** — `orders_org_unassigned_idx` and `orders_org_assigned_idx`
--   (0039) serve the two queues; nothing more is needed here.
--
-- `pg_trgm` rather than `to_tsvector`, for the same reason M06 chose it for the catalog
-- (0025): these are identifiers and names, not prose. Tokenising `OUR-2609-00042` on
-- word boundaries makes "2609" a term and "0004" nothing at all, and no Bangla stemmer
-- ships with PostgreSQL, so a buyer called আফসানা would be one token either way.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX "customers_phone_trgm_idx" ON "sales"."customers" USING gin ("phone_e164" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "customers_name_trgm_idx" ON "sales"."customers" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "orders_no_trgm_idx" ON "sales"."orders" USING gin ("order_no" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "orders_ship_phone_trgm_idx" ON "sales"."orders" USING gin ("ship_phone_e164" gin_trgm_ops);
--> statement-breakpoint
COMMENT ON INDEX "sales"."customers_phone_trgm_idx" IS 'M10: partial phone lookup at the order desk. Needs a 3-character fragment to be selective.';
--> statement-breakpoint
COMMENT ON INDEX "sales"."orders_no_trgm_idx" IS 'M10: searching an order by the tail of its number, as a customer reads it out.';
