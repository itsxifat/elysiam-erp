-- The owner removed the fraud check from scope on 2026-10-02 (D-291).
--
-- Drops M13's six fraud tables, the fraud verdict on orders (trust score, decision,
-- override reason) and the decision enum. The schema goes with CASCADE because 0047 put
-- its integrity trigger functions in it.
ALTER TABLE "fraud"."overrides" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fraud"."rules" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fraud"."order_phones" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fraud"."phone_flags" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fraud"."phone_signals" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fraud"."provider_checks" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "fraud"."overrides" CASCADE;--> statement-breakpoint
DROP TABLE "fraud"."rules" CASCADE;--> statement-breakpoint
DROP TABLE "fraud"."order_phones" CASCADE;--> statement-breakpoint
DROP TABLE "fraud"."phone_flags" CASCADE;--> statement-breakpoint
DROP TABLE "fraud"."phone_signals" CASCADE;--> statement-breakpoint
DROP TABLE "fraud"."provider_checks" CASCADE;--> statement-breakpoint
ALTER TABLE "sales"."orders" DROP CONSTRAINT "orders_trust_score_range";--> statement-breakpoint
ALTER TABLE "sales"."orders" DROP COLUMN "trust_score";--> statement-breakpoint
ALTER TABLE "sales"."orders" DROP COLUMN "fraud_decision";--> statement-breakpoint
ALTER TABLE "sales"."orders" DROP COLUMN "fraud_override_reason";--> statement-breakpoint
DROP TYPE "sales"."fraud_decision";--> statement-breakpoint
DROP SCHEMA "fraud" CASCADE;
