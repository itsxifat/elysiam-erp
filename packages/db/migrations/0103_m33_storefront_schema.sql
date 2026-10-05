CREATE SCHEMA "storefront";
--> statement-breakpoint
CREATE TABLE "storefront"."hero_slides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"desktop_file_id" uuid NOT NULL,
	"mobile_file_id" uuid,
	"link" text DEFAULT '/' NOT NULL,
	"alt_text" text,
	"position" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hero_slides_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "hero_slides_link_length" CHECK (length("storefront"."hero_slides"."link") between 1 and 500),
	CONSTRAINT "hero_slides_alt_length" CHECK ("storefront"."hero_slides"."alt_text" is null or length("storefront"."hero_slides"."alt_text") <= 200),
	CONSTRAINT "hero_slides_position_bounded" CHECK ("storefront"."hero_slides"."position" between 0 and 999)
);
--> statement-breakpoint
CREATE TABLE "storefront"."legacy_ids" (
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"legacy_id" text NOT NULL,
	"erp_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legacy_ids_pk" PRIMARY KEY("org_id","kind","legacy_id"),
	CONSTRAINT "legacy_ids_kind" CHECK ("storefront"."legacy_ids"."kind" in ('product', 'variant', 'category', 'size_chart', 'customer', 'order',
        'discount', 'flash_sale', 'landing_page', 'custom_link')),
	CONSTRAINT "legacy_ids_legacy_id_shape" CHECK ("storefront"."legacy_ids"."legacy_id" ~ '^[!-~]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "storefront"."nav_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"parent_id" uuid,
	"kind" text NOT NULL,
	"label" text,
	"href" text,
	"category_id" uuid,
	"highlighted" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nav_items_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "nav_items_kind" CHECK ("storefront"."nav_items"."kind" in ('link', 'category', 'dropdown')),
	CONSTRAINT "nav_items_not_self_parent" CHECK ("storefront"."nav_items"."parent_id" is null or "storefront"."nav_items"."parent_id" <> "storefront"."nav_items"."id"),
	CONSTRAINT "nav_items_category_has_category" CHECK (("storefront"."nav_items"."kind" = 'category') = ("storefront"."nav_items"."category_id" is not null)),
	CONSTRAINT "nav_items_link_has_href" CHECK ("storefront"."nav_items"."kind" <> 'link' or "storefront"."nav_items"."href" is not null),
	CONSTRAINT "nav_items_label_length" CHECK ("storefront"."nav_items"."label" is null or length("storefront"."nav_items"."label") between 1 and 60),
	CONSTRAINT "nav_items_href_length" CHECK ("storefront"."nav_items"."href" is null or length("storefront"."nav_items"."href") between 1 and 500),
	CONSTRAINT "nav_items_position_bounded" CHECK ("storefront"."nav_items"."position" between 0 and 999)
);
--> statement-breakpoint
CREATE TABLE "storefront"."size_charts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"columns" text[] NOT NULL,
	"rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "size_charts_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "size_charts_name_length" CHECK (length("storefront"."size_charts"."name") between 1 and 120),
	CONSTRAINT "size_charts_columns_bounded" CHECK (cardinality("storefront"."size_charts"."columns") between 1 and 12),
	CONSTRAINT "size_charts_rows_shape" CHECK (jsonb_typeof("storefront"."size_charts"."rows") = 'array' and jsonb_array_length("storefront"."size_charts"."rows") <= 60)
);
--> statement-breakpoint
CREATE TABLE "storefront"."settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"site_name" text NOT NULL,
	"logo_file_id" uuid,
	"site_info" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"social" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"announcement" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"promo_banner" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"testimonials" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"shipping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payments" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storefront_settings_site_name_length" CHECK (length("storefront"."settings"."site_name") between 1 and 120),
	CONSTRAINT "storefront_settings_shapes" CHECK (jsonb_typeof("storefront"."settings"."site_info") = 'object' and jsonb_typeof("storefront"."settings"."social") = 'object'
        and jsonb_typeof("storefront"."settings"."announcement") = 'object' and jsonb_typeof("storefront"."settings"."promo_banner") = 'object'
        and jsonb_typeof("storefront"."settings"."testimonials") = 'array' and jsonb_typeof("storefront"."settings"."shipping") = 'object'
        and jsonb_typeof("storefront"."settings"."payments") = 'object'),
	CONSTRAINT "storefront_settings_bounded" CHECK (pg_column_size("storefront"."settings"."site_info") + pg_column_size("storefront"."settings"."social")
        + pg_column_size("storefront"."settings"."announcement") + pg_column_size("storefront"."settings"."promo_banner")
        + pg_column_size("storefront"."settings"."testimonials") + pg_column_size("storefront"."settings"."shipping")
        + pg_column_size("storefront"."settings"."payments") < 65536)
);
--> statement-breakpoint
CREATE TABLE "storefront"."site_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"label" text NOT NULL,
	"key_id" text NOT NULL,
	"secret_sha256" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storefront_site_keys_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "storefront_site_keys_label_length" CHECK (length("storefront"."site_keys"."label") between 1 and 120),
	CONSTRAINT "storefront_site_keys_key_id_format" CHECK ("storefront"."site_keys"."key_id" ~ '^pk_[0-9a-f]{32}_[a-z2-7]{20}$'),
	CONSTRAINT "storefront_site_keys_secret_sha256_format" CHECK ("storefront"."site_keys"."secret_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "storefront_site_keys_revocation_complete" CHECK (("storefront"."site_keys"."revoked_at" is null) = ("storefront"."site_keys"."revoked_by" is null))
);
--> statement-breakpoint
CREATE TABLE "storefront"."web_locations" (
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_locations_pk" PRIMARY KEY("org_id","location_id")
);
--> statement-breakpoint
ALTER TABLE "catalog"."products" DROP CONSTRAINT "products_description_length";--> statement-breakpoint
ALTER TABLE "catalog"."categories" ADD COLUMN "web_visible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."categories" ADD COLUMN "featured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."categories" ADD COLUMN "gender" text;--> statement-breakpoint
ALTER TABLE "catalog"."categories" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "catalog"."categories" ADD COLUMN "image_file_id" uuid;--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD COLUMN "web_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD COLUMN "featured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD COLUMN "new_arrival" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD COLUMN "gender" text;--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD COLUMN "material" text;--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD COLUMN "care_instructions" text;--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD COLUMN "size_chart_id" uuid;--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD COLUMN "seo_title" text;--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD COLUMN "seo_description" text;--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD COLUMN "previous_slugs" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "storefront"."hero_slides" ADD CONSTRAINT "hero_slides_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."hero_slides" ADD CONSTRAINT "hero_slides_org_id_desktop_file_id_fk" FOREIGN KEY ("org_id","desktop_file_id") REFERENCES "files"."objects"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."hero_slides" ADD CONSTRAINT "hero_slides_org_id_mobile_file_id_fk" FOREIGN KEY ("org_id","mobile_file_id") REFERENCES "files"."objects"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."legacy_ids" ADD CONSTRAINT "legacy_ids_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."nav_items" ADD CONSTRAINT "nav_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."nav_items" ADD CONSTRAINT "nav_items_org_id_parent_id_fk" FOREIGN KEY ("org_id","parent_id") REFERENCES "storefront"."nav_items"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."nav_items" ADD CONSTRAINT "nav_items_org_id_category_id_fk" FOREIGN KEY ("org_id","category_id") REFERENCES "catalog"."categories"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."size_charts" ADD CONSTRAINT "size_charts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."settings" ADD CONSTRAINT "settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."settings" ADD CONSTRAINT "storefront_settings_org_id_logo_file_id_fk" FOREIGN KEY ("org_id","logo_file_id") REFERENCES "files"."objects"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."site_keys" ADD CONSTRAINT "site_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."web_locations" ADD CONSTRAINT "web_locations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."web_locations" ADD CONSTRAINT "web_locations_org_id_location_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "org"."locations"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hero_slides_org_idx" ON "storefront"."hero_slides" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "hero_slides_org_position_idx" ON "storefront"."hero_slides" USING btree ("org_id","position");--> statement-breakpoint
CREATE INDEX "legacy_ids_org_idx" ON "storefront"."legacy_ids" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "legacy_ids_org_erp_idx" ON "storefront"."legacy_ids" USING btree ("org_id","kind","erp_id");--> statement-breakpoint
CREATE INDEX "nav_items_org_idx" ON "storefront"."nav_items" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "nav_items_org_parent_idx" ON "storefront"."nav_items" USING btree ("org_id","parent_id","position");--> statement-breakpoint
CREATE INDEX "size_charts_org_idx" ON "storefront"."size_charts" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "size_charts_org_name_idx" ON "storefront"."size_charts" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "storefront_settings_org_idx" ON "storefront"."settings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "storefront_site_keys_org_idx" ON "storefront"."site_keys" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_site_keys_key_id_idx" ON "storefront"."site_keys" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "web_locations_org_idx" ON "storefront"."web_locations" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "catalog"."categories" ADD CONSTRAINT "categories_org_id_image_file_id_fk" FOREIGN KEY ("org_id","image_file_id") REFERENCES "files"."objects"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_org_web_idx" ON "catalog"."products" USING btree ("org_id","created_at") WHERE "catalog"."products"."web_visible" and "catalog"."products"."status" = 'active';--> statement-breakpoint
CREATE INDEX "products_previous_slugs_idx" ON "catalog"."products" USING gin ("previous_slugs");--> statement-breakpoint
CREATE INDEX "products_tags_idx" ON "catalog"."products" USING gin ("tags");--> statement-breakpoint
ALTER TABLE "catalog"."categories" ADD CONSTRAINT "categories_gender" CHECK ("catalog"."categories"."gender" is null or "catalog"."categories"."gender" in ('men', 'women', 'kids', 'unisex'));--> statement-breakpoint
ALTER TABLE "catalog"."categories" ADD CONSTRAINT "categories_description_length" CHECK ("catalog"."categories"."description" is null or length("catalog"."categories"."description") <= 2000);--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD CONSTRAINT "products_gender" CHECK ("catalog"."products"."gender" is null or "catalog"."products"."gender" in ('men', 'women', 'kids', 'unisex'));--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD CONSTRAINT "products_material_length" CHECK ("catalog"."products"."material" is null or length("catalog"."products"."material") <= 200);--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD CONSTRAINT "products_care_length" CHECK ("catalog"."products"."care_instructions" is null or length("catalog"."products"."care_instructions") <= 2000);--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD CONSTRAINT "products_tags_bounded" CHECK (cardinality("catalog"."products"."tags") <= 30
        and array_to_string("catalog"."products"."tags", ',') = lower(array_to_string("catalog"."products"."tags", ',')));--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD CONSTRAINT "products_seo_length" CHECK (("catalog"."products"."seo_title" is null or length("catalog"."products"."seo_title") <= 120)
        and ("catalog"."products"."seo_description" is null or length("catalog"."products"."seo_description") <= 320));--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD CONSTRAINT "products_previous_slugs_bounded" CHECK (cardinality("catalog"."products"."previous_slugs") <= 20);--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD CONSTRAINT "products_description_length" CHECK ("catalog"."products"."description" is null or length("catalog"."products"."description") <= 20000);