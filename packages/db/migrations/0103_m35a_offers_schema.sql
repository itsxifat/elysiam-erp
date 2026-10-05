CREATE TABLE "promo"."flash_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"flash_sale_item_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"sale_price_poisha" bigint NOT NULL,
	"released_qty" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flash_claims_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "flash_claims_qty" CHECK ("promo"."flash_claims"."qty" > 0),
	CONSTRAINT "flash_claims_price" CHECK ("promo"."flash_claims"."sale_price_poisha" > 0 and "promo"."flash_claims"."sale_price_poisha" <= 9000000000000000),
	CONSTRAINT "flash_claims_status" CHECK ("promo"."flash_claims"."status" in ('claimed', 'released')),
	CONSTRAINT "flash_claims_release_shape" CHECK (("promo"."flash_claims"."status" = 'claimed' and "promo"."flash_claims"."released_qty" = 0 and "promo"."flash_claims"."released_at" is null)
        or ("promo"."flash_claims"."status" = 'released' and "promo"."flash_claims"."released_qty" between 0 and "promo"."flash_claims"."qty"
            and "promo"."flash_claims"."released_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "promo"."flash_sale_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"flash_sale_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"sale_price_poisha" bigint NOT NULL,
	"unit_limit" integer,
	"units_sold" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flash_sale_items_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "flash_sale_items_price" CHECK ("promo"."flash_sale_items"."sale_price_poisha" > 0 and "promo"."flash_sale_items"."sale_price_poisha" <= 9000000000000000),
	CONSTRAINT "flash_sale_items_sold_within_limit" CHECK ("promo"."flash_sale_items"."units_sold" >= 0 and ("promo"."flash_sale_items"."unit_limit" is null
        or ("promo"."flash_sale_items"."unit_limit" > 0 and "promo"."flash_sale_items"."units_sold" <= "promo"."flash_sale_items"."unit_limit")))
);
--> statement-breakpoint
CREATE TABLE "promo"."flash_sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"subtitle" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"slug" text NOT NULL,
	"banner_file_id" uuid,
	"enabled" boolean DEFAULT false NOT NULL,
	"show_on_home" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flash_sales_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "flash_sales_slug_shape" CHECK ("promo"."flash_sales"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("promo"."flash_sales"."slug") <= 80),
	CONSTRAINT "flash_sales_text_lengths" CHECK (length(btrim("promo"."flash_sales"."title")) between 1 and 120 and length("promo"."flash_sales"."subtitle") <= 160
        and length("promo"."flash_sales"."description") <= 1000),
	CONSTRAINT "flash_sales_priority" CHECK ("promo"."flash_sales"."priority" between -100 and 100),
	CONSTRAINT "flash_sales_window" CHECK ("promo"."flash_sales"."starts_at" is null or "promo"."flash_sales"."ends_at" is null or "promo"."flash_sales"."starts_at" < "promo"."flash_sales"."ends_at")
);
--> statement-breakpoint
CREATE TABLE "promo"."discount_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"min_subtotal_poisha" bigint NOT NULL,
	"kind" text NOT NULL,
	"value_bps" integer DEFAULT 0 NOT NULL,
	"value_poisha" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_discount_tiers_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "promo_discount_tiers_position" CHECK ("promo"."discount_tiers"."position" between 0 and 9),
	CONSTRAINT "promo_discount_tiers_min" CHECK ("promo"."discount_tiers"."min_subtotal_poisha" >= 0 and "promo"."discount_tiers"."min_subtotal_poisha" <= 9000000000000000),
	CONSTRAINT "promo_discount_tiers_value" CHECK (("promo"."discount_tiers"."kind" = 'percent' and "promo"."discount_tiers"."value_bps" between 1 and 10000)
        or ("promo"."discount_tiers"."kind" = 'flat' and "promo"."discount_tiers"."value_poisha" > 0
            and "promo"."discount_tiers"."value_poisha" <= 9000000000000000))
);
--> statement-breakpoint
ALTER TABLE "promo"."codes" DROP CONSTRAINT "promo_codes_kind";--> statement-breakpoint
ALTER TABLE "promo"."codes" DROP CONSTRAINT "promo_codes_value";--> statement-breakpoint
ALTER TABLE "promo"."codes" ALTER COLUMN "code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD COLUMN "method" text DEFAULT 'code' NOT NULL;--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD COLUMN "title" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD COLUMN "buy_quantity" integer;--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD COLUMN "get_quantity" integer;--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD COLUMN "get_discount_bps" integer;--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD COLUMN "min_quantity" integer;--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD COLUMN "first_order_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD COLUMN "starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD COLUMN "ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD COLUMN "product_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD COLUMN "allow_stacking" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "promo"."flash_claims" ADD CONSTRAINT "flash_claims_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."flash_claims" ADD CONSTRAINT "flash_claims_org_id_flash_sale_item_id_fk" FOREIGN KEY ("org_id","flash_sale_item_id") REFERENCES "promo"."flash_sale_items"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."flash_claims" ADD CONSTRAINT "flash_claims_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."flash_sale_items" ADD CONSTRAINT "flash_sale_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."flash_sale_items" ADD CONSTRAINT "flash_sale_items_org_id_flash_sale_id_fk" FOREIGN KEY ("org_id","flash_sale_id") REFERENCES "promo"."flash_sales"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."flash_sale_items" ADD CONSTRAINT "flash_sale_items_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."flash_sales" ADD CONSTRAINT "flash_sales_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."flash_sales" ADD CONSTRAINT "flash_sales_org_id_banner_file_id_fk" FOREIGN KEY ("org_id","banner_file_id") REFERENCES "files"."objects"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."discount_tiers" ADD CONSTRAINT "discount_tiers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."discount_tiers" ADD CONSTRAINT "promo_discount_tiers_org_id_code_id_fk" FOREIGN KEY ("org_id","code_id") REFERENCES "promo"."codes"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flash_claims_org_idx" ON "promo"."flash_claims" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flash_claims_org_order_item_idx" ON "promo"."flash_claims" USING btree ("org_id","order_id","flash_sale_item_id");--> statement-breakpoint
CREATE INDEX "flash_claims_org_item_idx" ON "promo"."flash_claims" USING btree ("org_id","flash_sale_item_id");--> statement-breakpoint
CREATE INDEX "flash_sale_items_org_idx" ON "promo"."flash_sale_items" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flash_sale_items_org_sale_sku_idx" ON "promo"."flash_sale_items" USING btree ("org_id","flash_sale_id","sku_id");--> statement-breakpoint
CREATE INDEX "flash_sale_items_org_sku_idx" ON "promo"."flash_sale_items" USING btree ("org_id","sku_id");--> statement-breakpoint
CREATE INDEX "flash_sales_org_idx" ON "promo"."flash_sales" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flash_sales_org_slug_idx" ON "promo"."flash_sales" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "flash_sales_org_enabled_idx" ON "promo"."flash_sales" USING btree ("org_id","enabled");--> statement-breakpoint
CREATE INDEX "promo_discount_tiers_org_idx" ON "promo"."discount_tiers" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "promo_discount_tiers_org_code_position_idx" ON "promo"."discount_tiers" USING btree ("org_id","code_id","position");--> statement-breakpoint
CREATE INDEX "promo_codes_org_method_status_idx" ON "promo"."codes" USING btree ("org_id","method","status");--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD CONSTRAINT "promo_codes_method" CHECK ("promo"."codes"."method" in ('code', 'automatic'));--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD CONSTRAINT "promo_codes_method_code" CHECK (("promo"."codes"."method" = 'code') = ("promo"."codes"."code" is not null)
        and ("promo"."codes"."method" = 'code' or length(btrim("promo"."codes"."title")) > 0));--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD CONSTRAINT "promo_codes_min_quantity" CHECK ("promo"."codes"."min_quantity" is null or "promo"."codes"."min_quantity" > 0);--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD CONSTRAINT "promo_codes_instant_window" CHECK ("promo"."codes"."starts_at" is null or "promo"."codes"."ends_at" is null or "promo"."codes"."starts_at" < "promo"."codes"."ends_at");--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD CONSTRAINT "promo_codes_priority" CHECK ("promo"."codes"."priority" between -100 and 100);--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD CONSTRAINT "promo_codes_personal_is_code" CHECK ("promo"."codes"."customer_id" is null or "promo"."codes"."method" = 'code');--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD CONSTRAINT "promo_codes_text_lengths" CHECK (length("promo"."codes"."title") <= 120 and length("promo"."codes"."description") <= 1000);--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD CONSTRAINT "promo_codes_kind" CHECK ("promo"."codes"."kind" in ('percent', 'flat', 'free_delivery', 'buy_x_get_y', 'tiered'));--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD CONSTRAINT "promo_codes_value" CHECK (("promo"."codes"."kind" = 'percent' and "promo"."codes"."value_bps" between 1 and 10000)
        or ("promo"."codes"."kind" = 'flat' and "promo"."codes"."value_poisha" > 0)
        or "promo"."codes"."kind" = 'free_delivery'
        or ("promo"."codes"."kind" = 'buy_x_get_y' and "promo"."codes"."buy_quantity" between 1 and 1000
            and "promo"."codes"."get_quantity" between 1 and 1000
            and "promo"."codes"."get_discount_bps" between 1 and 10000)
        or "promo"."codes"."kind" = 'tiered');