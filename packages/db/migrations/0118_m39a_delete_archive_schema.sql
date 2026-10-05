ALTER TABLE "catalog"."sku_price_history" DROP CONSTRAINT "sku_price_history_org_id_sku_id_fk";
--> statement-breakpoint
ALTER TABLE "inventory"."stock_levels" DROP CONSTRAINT "stock_levels_org_id_sku_id_fk";
--> statement-breakpoint
ALTER TABLE "inventory"."stock_levels" DROP CONSTRAINT "stock_levels_org_id_location_id_fk";
--> statement-breakpoint
ALTER TABLE "promo"."flash_sale_items" DROP CONSTRAINT "flash_sale_items_org_id_flash_sale_id_fk";
--> statement-breakpoint
ALTER TABLE "promo"."discount_tiers" DROP CONSTRAINT "promo_discount_tiers_org_id_code_id_fk";
--> statement-breakpoint
ALTER TABLE "catalog"."attribute_values" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."attributes" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "promo"."flash_sales" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "catalog"."sku_price_history" ADD CONSTRAINT "sku_price_history_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_levels" ADD CONSTRAINT "stock_levels_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_levels" ADD CONSTRAINT "stock_levels_org_id_location_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "org"."locations"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."flash_sale_items" ADD CONSTRAINT "flash_sale_items_org_id_flash_sale_id_fk" FOREIGN KEY ("org_id","flash_sale_id") REFERENCES "promo"."flash_sales"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."discount_tiers" ADD CONSTRAINT "promo_discount_tiers_org_id_code_id_fk" FOREIGN KEY ("org_id","code_id") REFERENCES "promo"."codes"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."flash_sales" ADD CONSTRAINT "flash_sales_archived_off" CHECK ("promo"."flash_sales"."archived_at" is null or not "promo"."flash_sales"."enabled");