ALTER TABLE "sales"."customer_addresses" ALTER COLUMN "district_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sales"."customer_addresses" ALTER COLUMN "thana_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sales"."orders" ALTER COLUMN "ship_district_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sales"."orders" ALTER COLUMN "ship_thana_id" DROP NOT NULL;