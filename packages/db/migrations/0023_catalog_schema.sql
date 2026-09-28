-- The catalog schema (architecture §8, M06).
--
-- Categories, attributes and their values, products, SKUs as a variant matrix,
-- barcodes, the selling price, and images. Written by hand rather than generated,
-- like every migration from 0013 on: drizzle-kit's snapshot chain in this
-- repository already carries a collision it refuses to diff past, and the
-- statements below mirror `packages/db/src/schema/catalog/index.ts` exactly.
--
-- **There is no cost column in this migration and there must never be one.**
-- Invariant 5 keeps purchase cost in supply, inventory and the ledger. The
-- catalog is the schema most likely to acquire one by accident, because a product
-- page is where somebody wants to show margin — and §6's reseller allow-list
-- reads from these tables, so a cost column here reaches a reseller. `price_poisha`
-- is the *selling* price and is the only money in this schema.
CREATE SCHEMA "catalog";
--> statement-breakpoint
CREATE TYPE "catalog"."attribute_kind" AS ENUM('size', 'colour', 'custom');--> statement-breakpoint
CREATE TYPE "catalog"."product_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "catalog"."sku_status" AS ENUM('active', 'archived');--> statement-breakpoint

-- The per-org SKU counter and prefix.
--
-- A table, not a Postgres sequence: a sequence is one global object, so the five
-- brands would share a numbering and `ELY-SHRT-0001` would exist in one brand and
-- simply be skipped in another. The counter is taken with a single
-- `insert … on conflict do update … returning`, never a select then an update.
CREATE TABLE "catalog"."sku_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"org_code" text NOT NULL,
	"last_sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sku_settings_org_code_format" CHECK ("catalog"."sku_settings"."org_code" ~ '^[A-Z0-9]{2,8}$'),
	CONSTRAINT "sku_settings_sequence_not_negative" CHECK ("catalog"."sku_settings"."last_sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "catalog"."categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"code" text NOT NULL,
	"path" text DEFAULT '' NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "categories_not_self_parent" CHECK ("catalog"."categories"."parent_id" is null or "catalog"."categories"."parent_id" <> "catalog"."categories"."id"),
	CONSTRAINT "categories_code_format" CHECK ("catalog"."categories"."code" ~ '^[A-Z0-9]{1,8}$'),
	CONSTRAINT "categories_slug_format" CHECK ("catalog"."categories"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "categories_name_length" CHECK (length("catalog"."categories"."name") between 1 and 120),
	CONSTRAINT "categories_depth_bounded" CHECK ("catalog"."categories"."depth" between 0 and 3)
);
--> statement-breakpoint
CREATE TABLE "catalog"."attributes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" "catalog"."attribute_kind" DEFAULT 'custom' NOT NULL,
	"is_variant" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attributes_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "attributes_code_format" CHECK ("catalog"."attributes"."code" ~ '^[A-Z][A-Z0-9_]{0,31}$'),
	CONSTRAINT "attributes_name_length" CHECK (length("catalog"."attributes"."name") between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "catalog"."attribute_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"attribute_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attribute_values_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "attribute_values_code_format" CHECK ("catalog"."attribute_values"."code" ~ '^[A-Z0-9]{1,8}$'),
	CONSTRAINT "attribute_values_label_length" CHECK (length("catalog"."attribute_values"."label") between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "catalog"."products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"category_id" uuid,
	"sequence" integer NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"status" "catalog"."product_status" DEFAULT 'draft' NOT NULL,
	"search_text" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "products_sequence_positive" CHECK ("catalog"."products"."sequence" >= 1),
	CONSTRAINT "products_name_length" CHECK (length("catalog"."products"."name") between 1 and 200),
	CONSTRAINT "products_slug_format" CHECK ("catalog"."products"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "products_description_length" CHECK ("catalog"."products"."description" is null or length("catalog"."products"."description") <= 4000)
);
--> statement-breakpoint

-- One SKU: one cell of a product's variant matrix.
--
-- `variant_key` is the canonical identity of the combination (attribute=value
-- pairs sorted by attribute id, built by `variantKey()` in @elysium/domain), and
-- the unique index on (org_id, product_id, variant_key) is what makes M06's
-- check 1 the database's rule rather than the service's: the matrix can only be
-- extended, because a second attempt to create a combination that already exists
-- is refused whoever makes it. Every existing SKU has M07 stock movements and
-- M10 orders behind it, so regenerating the matrix is not a tidy-up, it is data
-- loss with printed labels still in a warehouse.
CREATE TABLE "catalog"."skus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"code" text NOT NULL,
	"variant_key" text NOT NULL,
	"barcode" text,
	"price_poisha" bigint NOT NULL,
	"status" "catalog"."sku_status" DEFAULT 'active' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skus_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "skus_code_format" CHECK ("catalog"."skus"."code" ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' and length("catalog"."skus"."code") <= 64),
	CONSTRAINT "skus_price_positive" CHECK ("catalog"."skus"."price_poisha" > 0),
	CONSTRAINT "skus_price_bounded" CHECK ("catalog"."skus"."price_poisha" <= 9000000000000000),
	CONSTRAINT "skus_barcode_printable_ascii" CHECK ("catalog"."skus"."barcode" is null or "catalog"."skus"."barcode" ~ '^[ -~]{1,48}$')
);
--> statement-breakpoint
CREATE TABLE "catalog"."sku_values" (
	"org_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"attribute_id" uuid NOT NULL,
	"value_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog"."sku_price_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"from_poisha" bigint,
	"to_poisha" bigint NOT NULL,
	"changed_by" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sku_price_history_to_positive" CHECK ("catalog"."sku_price_history"."to_poisha" > 0),
	CONSTRAINT "sku_price_history_changed" CHECK ("catalog"."sku_price_history"."from_poisha" is null or "catalog"."sku_price_history"."from_poisha" <> "catalog"."sku_price_history"."to_poisha"),
	CONSTRAINT "sku_price_history_reason_length" CHECK ("catalog"."sku_price_history"."reason" is null or length("catalog"."sku_price_history"."reason") <= 200)
);
--> statement-breakpoint
CREATE TABLE "catalog"."product_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"alt_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_images_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "product_images_position_not_negative" CHECK ("catalog"."product_images"."position" >= 0),
	CONSTRAINT "product_images_alt_length" CHECK ("catalog"."product_images"."alt_text" is null or length("catalog"."product_images"."alt_text") <= 200)
);
--> statement-breakpoint

-- Foreign keys.
--
-- Every key between two tenant tables carries `org_id` on both sides, against the
-- parent's `unique (org_id, id)` (D-047). PostgreSQL runs referential-integrity
-- checks with row security bypassed, so a plain `product_id references products(id)`
-- would let one brand's SKU point at another brand's product — corrupting
-- integrity, blocking the other brand from deleting its own row, and answering
-- "does this id exist" for a caller who cannot see it.
ALTER TABLE "catalog"."sku_settings" ADD CONSTRAINT "sku_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."categories" ADD CONSTRAINT "categories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."categories" ADD CONSTRAINT "categories_org_id_parent_id_fk" FOREIGN KEY ("org_id","parent_id") REFERENCES "catalog"."categories"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."attributes" ADD CONSTRAINT "attributes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."attribute_values" ADD CONSTRAINT "attribute_values_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."attribute_values" ADD CONSTRAINT "attribute_values_org_id_attribute_id_fk" FOREIGN KEY ("org_id","attribute_id") REFERENCES "catalog"."attributes"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD CONSTRAINT "products_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."products" ADD CONSTRAINT "products_org_id_category_id_fk" FOREIGN KEY ("org_id","category_id") REFERENCES "catalog"."categories"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."skus" ADD CONSTRAINT "skus_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."skus" ADD CONSTRAINT "skus_org_id_product_id_fk" FOREIGN KEY ("org_id","product_id") REFERENCES "catalog"."products"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."sku_values" ADD CONSTRAINT "sku_values_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."sku_values" ADD CONSTRAINT "sku_values_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."sku_values" ADD CONSTRAINT "sku_values_org_id_attribute_id_fk" FOREIGN KEY ("org_id","attribute_id") REFERENCES "catalog"."attributes"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."sku_values" ADD CONSTRAINT "sku_values_org_id_value_id_fk" FOREIGN KEY ("org_id","value_id") REFERENCES "catalog"."attribute_values"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."sku_price_history" ADD CONSTRAINT "sku_price_history_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."sku_price_history" ADD CONSTRAINT "sku_price_history_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."product_images" ADD CONSTRAINT "product_images_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."product_images" ADD CONSTRAINT "product_images_org_id_product_id_fk" FOREIGN KEY ("org_id","product_id") REFERENCES "catalog"."products"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."product_images" ADD CONSTRAINT "product_images_org_id_file_id_fk" FOREIGN KEY ("org_id","file_id") REFERENCES "files"."objects"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Indexes.
CREATE INDEX "sku_settings_org_idx" ON "catalog"."sku_settings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "categories_org_idx" ON "catalog"."categories" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "categories_org_parent_idx" ON "catalog"."categories" USING btree ("org_id","parent_id");--> statement-breakpoint
CREATE INDEX "categories_org_path_idx" ON "catalog"."categories" USING btree ("org_id","path");--> statement-breakpoint
-- `coalesce` because NULL never compares equal in a unique index, so a plain
-- (org_id, parent_id, slug) index would let every root category share a slug.
CREATE UNIQUE INDEX "categories_org_parent_slug_idx" ON "catalog"."categories" USING btree ("org_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),"slug");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_org_code_idx" ON "catalog"."categories" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "attributes_org_idx" ON "catalog"."attributes" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attributes_org_code_idx" ON "catalog"."attributes" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "attribute_values_org_idx" ON "catalog"."attribute_values" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "attribute_values_org_attribute_idx" ON "catalog"."attribute_values" USING btree ("org_id","attribute_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_values_org_attribute_code_idx" ON "catalog"."attribute_values" USING btree ("org_id","attribute_id","code");--> statement-breakpoint
CREATE INDEX "products_org_idx" ON "catalog"."products" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "products_org_status_idx" ON "catalog"."products" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "products_org_category_idx" ON "catalog"."products" USING btree ("org_id","category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_org_sequence_idx" ON "catalog"."products" USING btree ("org_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "products_org_slug_idx" ON "catalog"."products" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "skus_org_idx" ON "catalog"."skus" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "skus_org_product_idx" ON "catalog"."skus" USING btree ("org_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skus_org_code_idx" ON "catalog"."skus" USING btree ("org_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "skus_org_product_variant_idx" ON "catalog"."skus" USING btree ("org_id","product_id","variant_key");--> statement-breakpoint
CREATE UNIQUE INDEX "skus_org_barcode_idx" ON "catalog"."skus" USING btree ("org_id","barcode") WHERE "catalog"."skus"."barcode" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sku_values_pk" ON "catalog"."sku_values" USING btree ("org_id","sku_id","attribute_id");--> statement-breakpoint
CREATE INDEX "sku_values_org_idx" ON "catalog"."sku_values" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "sku_values_org_value_idx" ON "catalog"."sku_values" USING btree ("org_id","value_id");--> statement-breakpoint
CREATE INDEX "sku_price_history_org_idx" ON "catalog"."sku_price_history" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "sku_price_history_org_sku_idx" ON "catalog"."sku_price_history" USING btree ("org_id","sku_id","created_at");--> statement-breakpoint
CREATE INDEX "product_images_org_idx" ON "catalog"."product_images" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "product_images_org_product_idx" ON "catalog"."product_images" USING btree ("org_id","product_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "product_images_org_product_file_idx" ON "catalog"."product_images" USING btree ("org_id","product_id","file_id");
