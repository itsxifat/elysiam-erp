CREATE SCHEMA "org";
--> statement-breakpoint
CREATE SCHEMA "ref";
--> statement-breakpoint
CREATE TYPE "org"."branch_kind" AS ENUM('hq', 'showroom', 'warehouse');--> statement-breakpoint
CREATE TYPE "org"."location_kind" AS ENUM('warehouse', 'showroom', 'damaged', 'in_transit');--> statement-breakpoint
CREATE TABLE "org"."branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" "org"."branch_kind" NOT NULL,
	"address_line" text,
	"district_id" integer,
	"thana_id" integer,
	"phone" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org"."feature_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org"."locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"branch_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" "org"."location_kind" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org"."organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"legal_name" text NOT NULL,
	"display_name" text NOT NULL,
	"brand" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"timezone" text DEFAULT 'Asia/Dhaka' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "org"."settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ref"."districts" (
	"id" integer PRIMARY KEY NOT NULL,
	"division_id" integer NOT NULL,
	"name_en" text NOT NULL,
	"name_bn" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ref"."divisions" (
	"id" integer PRIMARY KEY NOT NULL,
	"name_en" text NOT NULL,
	"name_bn" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ref"."thanas" (
	"id" integer PRIMARY KEY NOT NULL,
	"district_id" integer NOT NULL,
	"name_en" text NOT NULL,
	"name_bn" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org"."branches" ADD CONSTRAINT "branches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."branches" ADD CONSTRAINT "branches_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "ref"."districts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."branches" ADD CONSTRAINT "branches_thana_id_thanas_id_fk" FOREIGN KEY ("thana_id") REFERENCES "ref"."thanas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."feature_flags" ADD CONSTRAINT "feature_flags_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."locations" ADD CONSTRAINT "locations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."locations" ADD CONSTRAINT "locations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "org"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."settings" ADD CONSTRAINT "settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref"."districts" ADD CONSTRAINT "districts_division_id_divisions_id_fk" FOREIGN KEY ("division_id") REFERENCES "ref"."divisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref"."thanas" ADD CONSTRAINT "thanas_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "ref"."districts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "branches_org_code_idx" ON "org"."branches" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "branches_org_idx" ON "org"."branches" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flags_org_key_idx" ON "org"."feature_flags" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "feature_flags_org_idx" ON "org"."feature_flags" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "locations_org_code_idx" ON "org"."locations" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "locations_org_idx" ON "org"."locations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "locations_branch_idx" ON "org"."locations" USING btree ("branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_org_key_idx" ON "org"."settings" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "settings_org_idx" ON "org"."settings" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "districts_division_name_idx" ON "ref"."districts" USING btree ("division_id","name_en");--> statement-breakpoint
CREATE UNIQUE INDEX "thanas_district_name_idx" ON "ref"."thanas" USING btree ("district_id","name_en");