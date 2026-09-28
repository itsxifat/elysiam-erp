-- Customers, delivery zones and orders (M10; architecture §9).
--
-- Matches `packages/db/src/schema/orders/index.ts`. The isolation policies and grants
-- follow in 0040, the integrity triggers Drizzle cannot express in 0041, D-009's
-- placeholder zones in 0042 and the buyer-lookup indexes in 0043.
--
-- Two constraints in here carry more than their weight:
--
-- * `orders_cod_matches_formula` re-derives §9's COD from the four columns it is made
--   of. The domain computes it and this makes a row that disagrees impossible to write —
--   which matters because the COD is the number a rider collects and a customer
--   disputes, and an import or a data repair that set the columns individually would
--   otherwise be discovered by the customer rather than by us.
-- * `order_lines_fulfilled_within_qty` keeps `delivered_qty + returned_qty <= qty`. A
--   courier webhook reporting four of three units delivered would otherwise post
--   revenue and COGS for a unit that never existed.
--
-- `delivery_zone_areas_org_area_idx` is declared NULLS NOT DISTINCT on purpose. A row
-- with no `thana_id` maps a whole district, and PostgreSQL's default treatment of NULL
-- as distinct would let one district be mapped to three zones at once, making every
-- charge lookup a coin toss.

CREATE SCHEMA "sales";
--> statement-breakpoint
CREATE TYPE "sales"."fraud_decision" AS ENUM('allow', 'warn', 'require_advance', 'block');
--> statement-breakpoint
CREATE TYPE "sales"."order_channel" AS ENUM('facebook', 'whatsapp', 'instagram', 'tiktok', 'landing_page', 'website', 'phone', 'walk_in', 'reseller');
--> statement-breakpoint
CREATE TYPE "sales"."order_status" AS ENUM('pending', 'confirmed', 'on_hold', 'packed', 'shipped', 'delivered', 'partially_delivered', 'return_in_transit', 'returned', 'cancelled', 'exchange');
--> statement-breakpoint
CREATE TABLE "sales"."couriers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "couriers_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "couriers_code_format" CHECK ("sales"."couriers"."code" ~ '^[a-z][a-z0-9_]{1,31}$')
);
--> statement-breakpoint
CREATE TABLE "sales"."delivery_zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name_en" text NOT NULL,
	"name_bn" text NOT NULL,
	"charge_poisha" bigint NOT NULL,
	"default_courier_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_zones_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "delivery_zones_code_format" CHECK ("sales"."delivery_zones"."code" ~ '^[a-z][a-z0-9_]{1,31}$'),
	CONSTRAINT "delivery_zones_charge_not_negative" CHECK ("sales"."delivery_zones"."charge_poisha" >= 0),
	CONSTRAINT "delivery_zones_charge_bounded" CHECK ("sales"."delivery_zones"."charge_poisha" <= 9000000000000000)
);
--> statement-breakpoint
CREATE TABLE "sales"."delivery_zone_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"district_id" integer NOT NULL,
	"thana_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_zone_areas_org_id_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "sales"."customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"phone_e164" text NOT NULL,
	"name" text NOT NULL,
	"birthday" date,
	"anniversary" date,
	"gender" text,
	"age_band" text,
	"profession" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"orders_total" integer DEFAULT 0 NOT NULL,
	"delivered_count" integer DEFAULT 0 NOT NULL,
	"returned_count" integer DEFAULT 0 NOT NULL,
	"cancelled_count" integer DEFAULT 0 NOT NULL,
	"ltv_poisha" bigint DEFAULT 0 NOT NULL,
	"first_order_at" timestamp with time zone,
	"last_order_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "customers_phone_e164" CHECK ("sales"."customers"."phone_e164" ~ '^\+8801[13456789][0-9]{8}$'),
	CONSTRAINT "customers_name_length" CHECK (length("sales"."customers"."name") between 1 and 200),
	CONSTRAINT "customers_counters_not_negative" CHECK ("sales"."customers"."orders_total" >= 0 and "sales"."customers"."delivered_count" >= 0
          and "sales"."customers"."returned_count" >= 0 and "sales"."customers"."cancelled_count" >= 0),
	CONSTRAINT "customers_ltv_not_negative" CHECK ("sales"."customers"."ltv_poisha" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sales"."customer_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"label" text,
	"district_id" integer NOT NULL,
	"thana_id" integer NOT NULL,
	"area" text,
	"address_line" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_addresses_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "customer_addresses_line_length" CHECK (length("sales"."customer_addresses"."address_line") between 3 and 500)
);
--> statement-breakpoint
CREATE TABLE "sales"."order_counters" (
	"org_id" uuid NOT NULL,
	"period" text NOT NULL,
	"last_no" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_counters_pkey" PRIMARY KEY("org_id","period"),
	CONSTRAINT "order_counters_period_format" CHECK ("sales"."order_counters"."period" ~ '^[0-9]{4}$'),
	CONSTRAINT "order_counters_last_no_not_negative" CHECK ("sales"."order_counters"."last_no" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sales"."orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"branch_id" uuid,
	"order_no" text NOT NULL,
	"channel" "sales"."order_channel" NOT NULL,
	"source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"customer_id" uuid NOT NULL,
	"ship_name" text NOT NULL,
	"ship_phone_e164" text NOT NULL,
	"ship_district_id" integer NOT NULL,
	"ship_thana_id" integer NOT NULL,
	"ship_area" text,
	"ship_address_line" text NOT NULL,
	"delivery_zone_id" uuid,
	"courier_id" uuid,
	"location_id" uuid,
	"items_poisha" bigint NOT NULL,
	"discount_poisha" bigint DEFAULT 0 NOT NULL,
	"delivery_charge_poisha" bigint DEFAULT 0 NOT NULL,
	"advance_paid_poisha" bigint DEFAULT 0 NOT NULL,
	"cod_amount_poisha" bigint NOT NULL,
	"promo_code_id" uuid,
	"status" "sales"."order_status" DEFAULT 'pending' NOT NULL,
	"hold_reason" text,
	"trust_score" smallint,
	"fraud_decision" "sales"."fraud_decision",
	"fraud_override_reason" text,
	"assigned_to" text,
	"created_by" text NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"packed_at" timestamp with time zone,
	"handed_over_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"returned_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"reseller_id" uuid,
	"exchange_of_order_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "orders_no_format" CHECK ("sales"."orders"."order_no" ~ '^[A-Z][A-Z0-9]{1,5}-[0-9]{4}-[0-9]{5,}$'),
	CONSTRAINT "orders_ship_phone_e164" CHECK ("sales"."orders"."ship_phone_e164" ~ '^\+8801[13456789][0-9]{8}$'),
	CONSTRAINT "orders_amounts_not_negative" CHECK ("sales"."orders"."items_poisha" >= 0 and "sales"."orders"."discount_poisha" >= 0
          and "sales"."orders"."delivery_charge_poisha" >= 0 and "sales"."orders"."advance_paid_poisha" >= 0
          and "sales"."orders"."cod_amount_poisha" >= 0),
	CONSTRAINT "orders_amounts_bounded" CHECK ("sales"."orders"."items_poisha" <= 9000000000000000 and "sales"."orders"."cod_amount_poisha" <= 9000000000000000),
	CONSTRAINT "orders_cod_matches_formula" CHECK ("sales"."orders"."cod_amount_poisha" = "sales"."orders"."items_poisha" - "sales"."orders"."discount_poisha"
          + "sales"."orders"."delivery_charge_poisha" - "sales"."orders"."advance_paid_poisha"),
	CONSTRAINT "orders_discount_within_items" CHECK ("sales"."orders"."discount_poisha" <= "sales"."orders"."items_poisha"),
	CONSTRAINT "orders_trust_score_range" CHECK ("sales"."orders"."trust_score" is null or ("sales"."orders"."trust_score" between 0 and 100)),
	CONSTRAINT "orders_exchange_not_self" CHECK ("sales"."orders"."exchange_of_order_id" is null or "sales"."orders"."exchange_of_order_id" <> "sales"."orders"."id")
);
--> statement-breakpoint
CREATE TABLE "sales"."order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"sku_code" text NOT NULL,
	"product_name" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_poisha" bigint NOT NULL,
	"discount_poisha" bigint DEFAULT 0 NOT NULL,
	"delivered_qty" integer DEFAULT 0 NOT NULL,
	"returned_qty" integer DEFAULT 0 NOT NULL,
	"reseller_price_poisha" bigint,
	"dispatch_unit_cost_poisha" bigint,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_lines_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "order_lines_qty_positive" CHECK ("sales"."order_lines"."qty" > 0),
	CONSTRAINT "order_lines_price_not_negative" CHECK ("sales"."order_lines"."unit_price_poisha" >= 0),
	CONSTRAINT "order_lines_price_bounded" CHECK ("sales"."order_lines"."unit_price_poisha" <= 9000000000000000),
	CONSTRAINT "order_lines_discount_within_line" CHECK ("sales"."order_lines"."discount_poisha" >= 0
          and "sales"."order_lines"."discount_poisha" <= "sales"."order_lines"."unit_price_poisha" * "sales"."order_lines"."qty"),
	CONSTRAINT "order_lines_fulfilled_within_qty" CHECK ("sales"."order_lines"."delivered_qty" >= 0 and "sales"."order_lines"."returned_qty" >= 0
          and "sales"."order_lines"."delivered_qty" + "sales"."order_lines"."returned_qty" <= "sales"."order_lines"."qty"),
	CONSTRAINT "order_lines_dispatch_cost_not_negative" CHECK ("sales"."order_lines"."dispatch_unit_cost_poisha" is null or "sales"."order_lines"."dispatch_unit_cost_poisha" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sales"."order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"from_status" "sales"."order_status",
	"to_status" "sales"."order_status" NOT NULL,
	"trigger" text NOT NULL,
	"reason" text,
	"actor_user_id" text,
	"business_date" date NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_events_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "order_events_trigger_format" CHECK ("sales"."order_events"."trigger" ~ '^[a-z][a-z0-9_]{0,31}$'),
	CONSTRAINT "order_events_reason_length" CHECK ("sales"."order_events"."reason" is null or length("sales"."order_events"."reason") <= 500)
);
--> statement-breakpoint
ALTER TABLE "sales"."couriers" ADD CONSTRAINT "couriers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."delivery_zones" ADD CONSTRAINT "delivery_zones_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."delivery_zones" ADD CONSTRAINT "delivery_zones_org_id_default_courier_id_fk" FOREIGN KEY ("org_id","default_courier_id") REFERENCES "sales"."couriers"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."delivery_zone_areas" ADD CONSTRAINT "delivery_zone_areas_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."delivery_zone_areas" ADD CONSTRAINT "delivery_zone_areas_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "ref"."districts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."delivery_zone_areas" ADD CONSTRAINT "delivery_zone_areas_thana_id_thanas_id_fk" FOREIGN KEY ("thana_id") REFERENCES "ref"."thanas"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."delivery_zone_areas" ADD CONSTRAINT "delivery_zone_areas_org_id_zone_id_fk" FOREIGN KEY ("org_id","zone_id") REFERENCES "sales"."delivery_zones"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."customers" ADD CONSTRAINT "customers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."customer_addresses" ADD CONSTRAINT "customer_addresses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."customer_addresses" ADD CONSTRAINT "customer_addresses_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "ref"."districts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."customer_addresses" ADD CONSTRAINT "customer_addresses_thana_id_thanas_id_fk" FOREIGN KEY ("thana_id") REFERENCES "ref"."thanas"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."customer_addresses" ADD CONSTRAINT "customer_addresses_org_id_customer_id_fk" FOREIGN KEY ("org_id","customer_id") REFERENCES "sales"."customers"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."order_counters" ADD CONSTRAINT "order_counters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_ship_district_id_districts_id_fk" FOREIGN KEY ("ship_district_id") REFERENCES "ref"."districts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_ship_thana_id_thanas_id_fk" FOREIGN KEY ("ship_thana_id") REFERENCES "ref"."thanas"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_org_id_customer_id_fk" FOREIGN KEY ("org_id","customer_id") REFERENCES "sales"."customers"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_org_id_delivery_zone_id_fk" FOREIGN KEY ("org_id","delivery_zone_id") REFERENCES "sales"."delivery_zones"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_org_id_courier_id_fk" FOREIGN KEY ("org_id","courier_id") REFERENCES "sales"."couriers"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_org_id_location_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "org"."locations"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_org_id_exchange_of_order_id_fk" FOREIGN KEY ("org_id","exchange_of_order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."order_lines" ADD CONSTRAINT "order_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."order_lines" ADD CONSTRAINT "order_lines_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."order_lines" ADD CONSTRAINT "order_lines_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."order_events" ADD CONSTRAINT "order_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sales"."order_events" ADD CONSTRAINT "order_events_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "couriers_org_idx" ON "sales"."couriers" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "couriers_org_code_idx" ON "sales"."couriers" USING btree ("org_id","code");
--> statement-breakpoint
CREATE INDEX "delivery_zones_org_idx" ON "sales"."delivery_zones" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_zones_org_code_idx" ON "sales"."delivery_zones" USING btree ("org_id","code");
--> statement-breakpoint
CREATE INDEX "delivery_zone_areas_org_idx" ON "sales"."delivery_zone_areas" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "delivery_zone_areas_org_zone_idx" ON "sales"."delivery_zone_areas" USING btree ("org_id","zone_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_zone_areas_org_area_idx" ON "sales"."delivery_zone_areas" USING btree ("org_id","district_id","thana_id") NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE INDEX "customers_org_idx" ON "sales"."customers" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "customers_org_phone_idx" ON "sales"."customers" USING btree ("org_id","phone_e164");
--> statement-breakpoint
CREATE INDEX "customers_org_last_order_idx" ON "sales"."customers" USING btree ("org_id","last_order_at");
--> statement-breakpoint
CREATE INDEX "customer_addresses_org_idx" ON "sales"."customer_addresses" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "customer_addresses_org_customer_idx" ON "sales"."customer_addresses" USING btree ("org_id","customer_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "customer_addresses_org_default_idx" ON "sales"."customer_addresses" USING btree ("org_id","customer_id") WHERE "sales"."customer_addresses"."is_default";
--> statement-breakpoint
CREATE INDEX "order_counters_org_idx" ON "sales"."order_counters" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "orders_org_idx" ON "sales"."orders" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "orders_org_no_idx" ON "sales"."orders" USING btree ("org_id","order_no");
--> statement-breakpoint
CREATE INDEX "orders_org_status_idx" ON "sales"."orders" USING btree ("org_id","status");
--> statement-breakpoint
CREATE INDEX "orders_org_customer_idx" ON "sales"."orders" USING btree ("org_id","customer_id");
--> statement-breakpoint
CREATE INDEX "orders_org_assigned_idx" ON "sales"."orders" USING btree ("org_id","assigned_to");
--> statement-breakpoint
CREATE INDEX "orders_org_created_idx" ON "sales"."orders" USING btree ("org_id","created_at");
--> statement-breakpoint
CREATE INDEX "orders_org_unassigned_idx" ON "sales"."orders" USING btree ("org_id","created_at") WHERE "sales"."orders"."assigned_to" is null;
--> statement-breakpoint
CREATE INDEX "order_lines_org_idx" ON "sales"."order_lines" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "order_lines_org_order_idx" ON "sales"."order_lines" USING btree ("org_id","order_id");
--> statement-breakpoint
CREATE INDEX "order_lines_org_sku_idx" ON "sales"."order_lines" USING btree ("org_id","sku_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "order_lines_org_order_sku_idx" ON "sales"."order_lines" USING btree ("org_id","order_id","sku_id");
--> statement-breakpoint
CREATE INDEX "order_events_org_idx" ON "sales"."order_events" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "order_events_org_order_idx" ON "sales"."order_events" USING btree ("org_id","order_id","occurred_at");
--> statement-breakpoint
CREATE INDEX "order_events_org_date_idx" ON "sales"."order_events" USING btree ("org_id","business_date");
