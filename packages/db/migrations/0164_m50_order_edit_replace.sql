-- M50: order edit, replace and returns with offers.
--
-- D-921: an edited order releases the discounts it carried and takes the ones the person chose,
-- so one code may be applied to one order again once its earlier use is released. The unique
-- index now counts applied redemptions only; a released one stays as history (0079's trigger
-- still lets a redemption be released once and never changed otherwise).
--
-- D-922: a packed order is never edited. It is cancelled and a replacement is created in the
-- same transaction; `replaces_order_id` links the replacement to it, tenant-safe like every
-- foreign key between tenant tables (D-047).
DROP INDEX "promo"."promo_redemptions_org_code_order_idx";--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD COLUMN "replaces_order_id" uuid;--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_org_id_replaces_order_id_fk" FOREIGN KEY ("org_id","replaces_order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_org_replaces_idx" ON "sales"."orders" USING btree ("org_id","replaces_order_id") WHERE "sales"."orders"."replaces_order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "promo_redemptions_org_code_order_applied_idx" ON "promo"."redemptions" USING btree ("org_id","code_id","order_id") WHERE "promo"."redemptions"."order_id" is not null and "promo"."redemptions"."status" = 'applied';--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_replaces_not_self" CHECK ("sales"."orders"."replaces_order_id" is null or "sales"."orders"."replaces_order_id" <> "sales"."orders"."id");