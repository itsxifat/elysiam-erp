CREATE SCHEMA "analytics";
--> statement-breakpoint
CREATE TABLE "analytics"."daily_agent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"user_id" text NOT NULL,
	"orders_confirmed" integer DEFAULT 0 NOT NULL,
	"orders_delivered" integer DEFAULT 0 NOT NULL,
	"delivered_revenue_poisha" bigint DEFAULT 0 NOT NULL,
	"pickup_count" integer DEFAULT 0 NOT NULL,
	"pickup_seconds" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "daily_agent_org_date_user_key" UNIQUE("org_id","business_date","user_id"),
	CONSTRAINT "daily_agent_not_negative" CHECK ("analytics"."daily_agent"."orders_confirmed" >= 0 and "analytics"."daily_agent"."orders_delivered" >= 0
          and "analytics"."daily_agent"."delivered_revenue_poisha" >= 0 and "analytics"."daily_agent"."pickup_count" >= 0
          and "analytics"."daily_agent"."pickup_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "analytics"."daily_branch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"branch_id" uuid NOT NULL,
	"orders_placed" integer DEFAULT 0 NOT NULL,
	"orders_confirmed" integer DEFAULT 0 NOT NULL,
	"orders_delivered" integer DEFAULT 0 NOT NULL,
	"orders_returned" integer DEFAULT 0 NOT NULL,
	"orders_cancelled" integer DEFAULT 0 NOT NULL,
	"delivered_revenue_poisha" bigint DEFAULT 0 NOT NULL,
	"gross_profit_poisha" bigint DEFAULT 0 NOT NULL,
	"delivered_outside_dhaka" integer DEFAULT 0 NOT NULL,
	"returned_outside_dhaka" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "daily_branch_org_date_branch_key" UNIQUE("org_id","business_date","branch_id"),
	CONSTRAINT "daily_branch_metrics_not_negative" CHECK ("analytics"."daily_branch"."orders_placed" >= 0 and "analytics"."daily_branch"."orders_confirmed" >= 0
        and "analytics"."daily_branch"."orders_delivered" >= 0 and "analytics"."daily_branch"."orders_returned" >= 0
        and "analytics"."daily_branch"."orders_cancelled" >= 0 and "analytics"."daily_branch"."delivered_revenue_poisha" >= 0
        and "analytics"."daily_branch"."delivered_outside_dhaka" >= 0 and "analytics"."daily_branch"."returned_outside_dhaka" >= 0)
);
--> statement-breakpoint
CREATE TABLE "analytics"."daily_campaign" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"campaign_id" uuid,
	"spend_poisha" bigint DEFAULT 0 NOT NULL,
	"orders_confirmed" integer DEFAULT 0 NOT NULL,
	"orders_delivered" integer DEFAULT 0 NOT NULL,
	"orders_returned" integer DEFAULT 0 NOT NULL,
	"delivered_revenue_poisha" bigint DEFAULT 0 NOT NULL,
	"placed_revenue_poisha" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "daily_campaign_org_date_campaign_key" UNIQUE NULLS NOT DISTINCT("org_id","business_date","campaign_id"),
	CONSTRAINT "daily_campaign_not_negative" CHECK ("analytics"."daily_campaign"."spend_poisha" >= 0 and "analytics"."daily_campaign"."orders_confirmed" >= 0
          and "analytics"."daily_campaign"."orders_delivered" >= 0 and "analytics"."daily_campaign"."orders_returned" >= 0
          and "analytics"."daily_campaign"."delivered_revenue_poisha" >= 0 and "analytics"."daily_campaign"."placed_revenue_poisha" >= 0)
);
--> statement-breakpoint
CREATE TABLE "analytics"."daily_channel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"channel" text NOT NULL,
	"orders_placed" integer DEFAULT 0 NOT NULL,
	"orders_confirmed" integer DEFAULT 0 NOT NULL,
	"orders_delivered" integer DEFAULT 0 NOT NULL,
	"orders_returned" integer DEFAULT 0 NOT NULL,
	"orders_cancelled" integer DEFAULT 0 NOT NULL,
	"delivered_revenue_poisha" bigint DEFAULT 0 NOT NULL,
	"gross_profit_poisha" bigint DEFAULT 0 NOT NULL,
	"delivered_outside_dhaka" integer DEFAULT 0 NOT NULL,
	"returned_outside_dhaka" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "daily_channel_org_date_channel_key" UNIQUE("org_id","business_date","channel"),
	CONSTRAINT "daily_channel_metrics_not_negative" CHECK ("analytics"."daily_channel"."orders_placed" >= 0 and "analytics"."daily_channel"."orders_confirmed" >= 0
        and "analytics"."daily_channel"."orders_delivered" >= 0 and "analytics"."daily_channel"."orders_returned" >= 0
        and "analytics"."daily_channel"."orders_cancelled" >= 0 and "analytics"."daily_channel"."delivered_revenue_poisha" >= 0
        and "analytics"."daily_channel"."delivered_outside_dhaka" >= 0 and "analytics"."daily_channel"."returned_outside_dhaka" >= 0)
);
--> statement-breakpoint
CREATE TABLE "analytics"."daily_org" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"orders_placed" integer DEFAULT 0 NOT NULL,
	"orders_confirmed" integer DEFAULT 0 NOT NULL,
	"orders_delivered" integer DEFAULT 0 NOT NULL,
	"orders_returned" integer DEFAULT 0 NOT NULL,
	"orders_cancelled" integer DEFAULT 0 NOT NULL,
	"delivered_revenue_poisha" bigint DEFAULT 0 NOT NULL,
	"gross_profit_poisha" bigint DEFAULT 0 NOT NULL,
	"delivered_outside_dhaka" integer DEFAULT 0 NOT NULL,
	"returned_outside_dhaka" integer DEFAULT 0 NOT NULL,
	"spend_poisha" bigint DEFAULT 0 NOT NULL,
	"pickup_count" integer DEFAULT 0 NOT NULL,
	"pickup_seconds" bigint DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_org_org_date_key" UNIQUE("org_id","business_date"),
	CONSTRAINT "daily_org_metrics_not_negative" CHECK ("analytics"."daily_org"."orders_placed" >= 0 and "analytics"."daily_org"."orders_confirmed" >= 0
        and "analytics"."daily_org"."orders_delivered" >= 0 and "analytics"."daily_org"."orders_returned" >= 0
        and "analytics"."daily_org"."orders_cancelled" >= 0 and "analytics"."daily_org"."delivered_revenue_poisha" >= 0
        and "analytics"."daily_org"."delivered_outside_dhaka" >= 0 and "analytics"."daily_org"."returned_outside_dhaka" >= 0),
	CONSTRAINT "daily_org_spend_pickups_not_negative" CHECK ("analytics"."daily_org"."spend_poisha" >= 0 and "analytics"."daily_org"."pickup_count" >= 0 and "analytics"."daily_org"."pickup_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "analytics"."narratives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"month" text NOT NULL,
	"generated_on" date NOT NULL,
	"provider" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"body" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "narratives_org_month_day_key" UNIQUE("org_id","month","generated_on"),
	CONSTRAINT "narratives_month_format" CHECK ("analytics"."narratives"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "narratives_hash_format" CHECK ("analytics"."narratives"."payload_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "narratives_body_bounded" CHECK (length("analytics"."narratives"."body") between 1 and 8000)
);
--> statement-breakpoint
ALTER TABLE "analytics"."daily_agent" ADD CONSTRAINT "daily_agent_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics"."daily_branch" ADD CONSTRAINT "daily_branch_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics"."daily_campaign" ADD CONSTRAINT "daily_campaign_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics"."daily_channel" ADD CONSTRAINT "daily_channel_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics"."daily_org" ADD CONSTRAINT "daily_org_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics"."narratives" ADD CONSTRAINT "narratives_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_agent_org_idx" ON "analytics"."daily_agent" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "daily_branch_org_idx" ON "analytics"."daily_branch" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "daily_campaign_org_idx" ON "analytics"."daily_campaign" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "daily_channel_org_idx" ON "analytics"."daily_channel" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "daily_org_org_idx" ON "analytics"."daily_org" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "narratives_org_idx" ON "analytics"."narratives" USING btree ("org_id");