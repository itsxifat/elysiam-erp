CREATE TABLE "supply"."sku_purchase_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"supplier_id" uuid,
	"standard_unit_cost_poisha" bigint NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sku_purchase_prices_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "sku_purchase_prices_cost_positive" CHECK ("supply"."sku_purchase_prices"."standard_unit_cost_poisha" > 0 and "supply"."sku_purchase_prices"."standard_unit_cost_poisha" <= 9000000000000000),
	CONSTRAINT "sku_purchase_prices_updated_by_length" CHECK ("supply"."sku_purchase_prices"."updated_by" is null or length("supply"."sku_purchase_prices"."updated_by") <= 120)
);
--> statement-breakpoint
ALTER TABLE "catalog"."sku_price_history" DROP CONSTRAINT "sku_price_history_changed";--> statement-breakpoint
ALTER TABLE "catalog"."categories" ADD COLUMN "default_size_chart_id" uuid;--> statement-breakpoint
ALTER TABLE "catalog"."product_images" ADD COLUMN "colour_value_id" uuid;--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD COLUMN "weight_grams" integer;--> statement-breakpoint
ALTER TABLE "catalog"."sku_price_history" ADD COLUMN "compare_at_from_poisha" bigint;--> statement-breakpoint
ALTER TABLE "catalog"."sku_price_history" ADD COLUMN "compare_at_to_poisha" bigint;--> statement-breakpoint
ALTER TABLE "catalog"."skus" ADD COLUMN "compare_at_poisha" bigint;--> statement-breakpoint
ALTER TABLE "catalog"."skus" ADD COLUMN "weight_grams" integer;--> statement-breakpoint
ALTER TABLE "supply"."sku_purchase_prices" ADD CONSTRAINT "sku_purchase_prices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."sku_purchase_prices" ADD CONSTRAINT "sku_purchase_prices_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."sku_purchase_prices" ADD CONSTRAINT "sku_purchase_prices_org_id_supplier_id_fk" FOREIGN KEY ("org_id","supplier_id") REFERENCES "supply"."suppliers"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sku_purchase_prices_org_idx" ON "supply"."sku_purchase_prices" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "sku_purchase_prices_org_supplier_idx" ON "supply"."sku_purchase_prices" USING btree ("org_id","supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sku_purchase_prices_org_sku_supplier_idx" ON "supply"."sku_purchase_prices" USING btree ("org_id","sku_id",coalesce("supplier_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX "product_images_org_colour_idx" ON "catalog"."product_images" USING btree ("org_id","colour_value_id");--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD CONSTRAINT "products_weight_bounded" CHECK ("catalog"."products"."weight_grams" is null or "catalog"."products"."weight_grams" between 1 and 100000);--> statement-breakpoint
ALTER TABLE "catalog"."sku_price_history" ADD CONSTRAINT "sku_price_history_changed" CHECK ("catalog"."sku_price_history"."from_poisha" is null or "catalog"."sku_price_history"."from_poisha" <> "catalog"."sku_price_history"."to_poisha"
        or "catalog"."sku_price_history"."compare_at_from_poisha" is distinct from "catalog"."sku_price_history"."compare_at_to_poisha");--> statement-breakpoint
ALTER TABLE "catalog"."skus" ADD CONSTRAINT "skus_compare_at_above_price" CHECK ("catalog"."skus"."compare_at_poisha" is null
        or ("catalog"."skus"."compare_at_poisha" > "catalog"."skus"."price_poisha"
            and "catalog"."skus"."compare_at_poisha" <= 9000000000000000));--> statement-breakpoint
ALTER TABLE "catalog"."skus" ADD CONSTRAINT "skus_weight_bounded" CHECK ("catalog"."skus"."weight_grams" is null or "catalog"."skus"."weight_grams" between 1 and 100000);