CREATE SCHEMA "marketing";
--> statement-breakpoint
CREATE TABLE "marketing"."ad_spend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"spend_date" date NOT NULL,
	"amount_poisha" bigint NOT NULL,
	"source" text NOT NULL,
	"note" text,
	"entered_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_spend_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "ad_spend_amount" CHECK ("marketing"."ad_spend"."amount_poisha" >= 0),
	CONSTRAINT "ad_spend_source" CHECK ("marketing"."ad_spend"."source" in ('manual', 'meta'))
);
--> statement-breakpoint
CREATE TABLE "marketing"."campaign_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_refs_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "campaign_refs_kind" CHECK ("marketing"."campaign_refs"."kind" in ('meta_campaign', 'meta_ad', 'utm_campaign')),
	CONSTRAINT "campaign_refs_value" CHECK (length("marketing"."campaign_refs"."value") between 1 and 120 and "marketing"."campaign_refs"."value" = btrim("marketing"."campaign_refs"."value")
        and ("marketing"."campaign_refs"."kind" <> 'utm_campaign' or "marketing"."campaign_refs"."value" = lower("marketing"."campaign_refs"."value")))
);
--> statement-breakpoint
CREATE TABLE "marketing"."campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"product_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"status" text DEFAULT 'active' NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "campaigns_name_length" CHECK (length("marketing"."campaigns"."name") between 1 and 200),
	CONSTRAINT "campaigns_platform" CHECK ("marketing"."campaigns"."platform" in ('meta', 'google', 'tiktok', 'other')),
	CONSTRAINT "campaigns_status" CHECK ("marketing"."campaigns"."status" in ('active', 'archived')),
	CONSTRAINT "campaigns_origin" CHECK ("marketing"."campaigns"."origin" in ('manual', 'meta_import')),
	CONSTRAINT "campaigns_window" CHECK ("marketing"."campaigns"."starts_on" is null or "marketing"."campaigns"."ends_on" is null or "marketing"."campaigns"."starts_on" <= "marketing"."campaigns"."ends_on")
);
--> statement-breakpoint
CREATE TABLE "marketing"."capi_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"event_name" text NOT NULL,
	"event_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"payload" jsonb,
	"value_poisha" bigint,
	"event_time" timestamp with time zone,
	"response" jsonb,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capi_events_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "capi_events_name" CHECK ("marketing"."capi_events"."event_name" in ('Purchase')),
	CONSTRAINT "capi_events_status" CHECK ("marketing"."capi_events"."status" in ('queued', 'sent', 'failed', 'skipped')),
	CONSTRAINT "capi_events_value" CHECK ("marketing"."capi_events"."value_poisha" is null or "marketing"."capi_events"."value_poisha" >= 0)
);
--> statement-breakpoint
CREATE TABLE "marketing"."leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"phone_e164" text NOT NULL,
	"name" text,
	"channel" text NOT NULL,
	"campaign_id" uuid,
	"sku_id" uuid,
	"size" text,
	"age_band" text,
	"profession" text,
	"status" text DEFAULT 'new' NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "leads_phone_shape" CHECK ("marketing"."leads"."phone_e164" ~ '^\+[0-9]{8,15}$'),
	CONSTRAINT "leads_channel" CHECK ("marketing"."leads"."channel" in ('facebook', 'whatsapp', 'instagram', 'tiktok', 'landing_page',
        'website', 'phone', 'walk_in', 'reseller')),
	CONSTRAINT "leads_age_band" CHECK ("marketing"."leads"."age_band" is null or "marketing"."leads"."age_band" in ('under_18', '18_24', '25_34', '35_44',
        '45_54', '55_plus')),
	CONSTRAINT "leads_status" CHECK ("marketing"."leads"."status" in ('new', 'contacted', 'converted', 'lost'))
);
--> statement-breakpoint
CREATE TABLE "marketing"."meta_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"ad_account_id" text,
	"pixel_id" text,
	"token" "bytea",
	"token_key_id" text,
	"token_fingerprint" text,
	"spend_import_enabled" boolean DEFAULT false NOT NULL,
	"capi_enabled" boolean DEFAULT false NOT NULL,
	"send_name_and_city" boolean DEFAULT false NOT NULL,
	"test_event_code" text,
	"last_import_at" timestamp with time zone,
	"last_import_status" text,
	"last_import_error" text,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_connections_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "meta_connections_ids" CHECK (("marketing"."meta_connections"."ad_account_id" is null or "marketing"."meta_connections"."ad_account_id" ~ '^[0-9]{1,30}$')
        and ("marketing"."meta_connections"."pixel_id" is null or "marketing"."meta_connections"."pixel_id" ~ '^[0-9]{1,30}$')),
	CONSTRAINT "meta_connections_token_sealed" CHECK (("marketing"."meta_connections"."token" is null) = ("marketing"."meta_connections"."token_key_id" is null)
        and ("marketing"."meta_connections"."token" is null) = ("marketing"."meta_connections"."token_fingerprint" is null)),
	CONSTRAINT "meta_connections_import_status" CHECK ("marketing"."meta_connections"."last_import_status" is null or "marketing"."meta_connections"."last_import_status" in ('ok', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "marketing"."ad_spend" ADD CONSTRAINT "ad_spend_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing"."ad_spend" ADD CONSTRAINT "ad_spend_org_id_campaign_id_fk" FOREIGN KEY ("org_id","campaign_id") REFERENCES "marketing"."campaigns"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing"."campaign_refs" ADD CONSTRAINT "campaign_refs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing"."campaign_refs" ADD CONSTRAINT "campaign_refs_org_id_campaign_id_fk" FOREIGN KEY ("org_id","campaign_id") REFERENCES "marketing"."campaigns"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing"."campaigns" ADD CONSTRAINT "campaigns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing"."capi_events" ADD CONSTRAINT "capi_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing"."capi_events" ADD CONSTRAINT "capi_events_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing"."leads" ADD CONSTRAINT "leads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing"."leads" ADD CONSTRAINT "leads_org_id_campaign_id_fk" FOREIGN KEY ("org_id","campaign_id") REFERENCES "marketing"."campaigns"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing"."leads" ADD CONSTRAINT "leads_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing"."meta_connections" ADD CONSTRAINT "meta_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_spend_org_idx" ON "marketing"."ad_spend" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_spend_org_campaign_date_idx" ON "marketing"."ad_spend" USING btree ("org_id","campaign_id","spend_date");--> statement-breakpoint
CREATE INDEX "ad_spend_org_date_idx" ON "marketing"."ad_spend" USING btree ("org_id","spend_date");--> statement-breakpoint
CREATE INDEX "campaign_refs_org_idx" ON "marketing"."campaign_refs" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_refs_org_kind_value_idx" ON "marketing"."campaign_refs" USING btree ("org_id","kind","value");--> statement-breakpoint
CREATE INDEX "campaign_refs_org_campaign_idx" ON "marketing"."campaign_refs" USING btree ("org_id","campaign_id");--> statement-breakpoint
CREATE INDEX "campaigns_org_idx" ON "marketing"."campaigns" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "capi_events_org_idx" ON "marketing"."capi_events" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capi_events_org_order_event_idx" ON "marketing"."capi_events" USING btree ("org_id","order_id","event_name");--> statement-breakpoint
CREATE INDEX "capi_events_org_created_idx" ON "marketing"."capi_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "leads_org_idx" ON "marketing"."leads" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "leads_org_created_idx" ON "marketing"."leads" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "leads_org_phone_idx" ON "marketing"."leads" USING btree ("org_id","phone_e164");--> statement-breakpoint
CREATE UNIQUE INDEX "meta_connections_org_idx" ON "marketing"."meta_connections" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD CONSTRAINT "promo_codes_org_id_campaign_id_fk" FOREIGN KEY ("org_id","campaign_id") REFERENCES "marketing"."campaigns"("org_id","id") ON DELETE restrict ON UPDATE no action;