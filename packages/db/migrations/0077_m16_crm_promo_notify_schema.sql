CREATE SCHEMA "notify";
--> statement-breakpoint
CREATE SCHEMA "promo";
--> statement-breakpoint
CREATE TABLE "sales"."customer_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"recency" smallint NOT NULL,
	"frequency" smallint NOT NULL,
	"monetary" smallint NOT NULL,
	"segment" text NOT NULL,
	"computed_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_segments_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "customer_segments_scores" CHECK ("sales"."customer_segments"."recency" between 0 and 5 and "sales"."customer_segments"."frequency" between 0 and 5 and "sales"."customer_segments"."monetary" between 0 and 5),
	CONSTRAINT "customer_segments_segment" CHECK ("sales"."customer_segments"."segment" in ('champions', 'loyal', 'new', 'promising', 'at_risk', 'hibernating', 'needs_attention', 'prospect'))
);
--> statement-breakpoint
CREATE TABLE "sales"."occasion_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"occasion" text NOT NULL,
	"year" integer NOT NULL,
	"promo_code_id" uuid,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "occasion_issues_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "occasion_issues_occasion" CHECK ("sales"."occasion_issues"."occasion" in ('birthday', 'anniversary')),
	CONSTRAINT "occasion_issues_year" CHECK ("sales"."occasion_issues"."year" between 2000 and 2999)
);
--> statement-breakpoint
CREATE TABLE "notify"."messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"channel" text DEFAULT 'sms' NOT NULL,
	"category" text NOT NULL,
	"phone" text NOT NULL,
	"locale" text DEFAULT 'bn' NOT NULL,
	"body" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"send_after" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"provider" text,
	"provider_message_id" text,
	"error" text,
	"sent_at" timestamp with time zone,
	"ref_type" text,
	"ref_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notify_messages_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "notify_messages_channel" CHECK ("notify"."messages"."channel" in ('sms')),
	CONSTRAINT "notify_messages_category" CHECK ("notify"."messages"."category" in ('otp', 'transactional', 'marketing')),
	CONSTRAINT "notify_messages_locale" CHECK ("notify"."messages"."locale" in ('bn', 'en')),
	CONSTRAINT "notify_messages_phone_shape" CHECK ("notify"."messages"."phone" ~ '^01[3-9][0-9]{8}$'),
	CONSTRAINT "notify_messages_state" CHECK ("notify"."messages"."state" in ('queued', 'sent', 'failed', 'suppressed')),
	CONSTRAINT "notify_messages_sent_complete" CHECK (("notify"."messages"."state" = 'sent') = ("notify"."messages"."sent_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "notify"."opt_outs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"channel" text DEFAULT 'sms' NOT NULL,
	"reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notify_opt_outs_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "notify_opt_outs_phone_shape" CHECK ("notify"."opt_outs"."phone" ~ '^01[3-9][0-9]{8}$'),
	CONSTRAINT "notify_opt_outs_channel" CHECK ("notify"."opt_outs"."channel" in ('sms'))
);
--> statement-breakpoint
CREATE TABLE "notify"."templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"channel" text DEFAULT 'sms' NOT NULL,
	"category" text NOT NULL,
	"body_bn" text NOT NULL,
	"body_en" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notify_templates_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "notify_templates_key_shape" CHECK ("notify"."templates"."key" ~ '^[a-z][a-z0-9_.]{2,63}$'),
	CONSTRAINT "notify_templates_channel" CHECK ("notify"."templates"."channel" in ('sms')),
	CONSTRAINT "notify_templates_category" CHECK ("notify"."templates"."category" in ('otp', 'transactional', 'marketing')),
	CONSTRAINT "notify_templates_bodies" CHECK (length("notify"."templates"."body_bn") between 1 and 1000 and length("notify"."templates"."body_en") between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "promo"."codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"kind" text NOT NULL,
	"value_bps" integer DEFAULT 0 NOT NULL,
	"value_poisha" bigint DEFAULT 0 NOT NULL,
	"min_order_poisha" bigint,
	"max_discount_poisha" bigint,
	"total_limit" integer,
	"per_customer_limit" integer,
	"used_count" integer DEFAULT 0 NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sku_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"category_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"customer_id" uuid,
	"campaign_id" uuid,
	"origin" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_codes_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "promo_codes_code_shape" CHECK ("promo"."codes"."code" ~ '^[A-Z0-9][A-Z0-9_-]{2,39}$'),
	CONSTRAINT "promo_codes_kind" CHECK ("promo"."codes"."kind" in ('percent', 'flat', 'free_delivery')),
	CONSTRAINT "promo_codes_value" CHECK (("promo"."codes"."kind" = 'percent' and "promo"."codes"."value_bps" between 1 and 10000)
        or ("promo"."codes"."kind" = 'flat' and "promo"."codes"."value_poisha" > 0)
        or "promo"."codes"."kind" = 'free_delivery'),
	CONSTRAINT "promo_codes_amounts" CHECK (("promo"."codes"."min_order_poisha" is null or "promo"."codes"."min_order_poisha" >= 0)
        and ("promo"."codes"."max_discount_poisha" is null or "promo"."codes"."max_discount_poisha" > 0)),
	CONSTRAINT "promo_codes_limits" CHECK (("promo"."codes"."total_limit" is null or "promo"."codes"."total_limit" > 0)
        and ("promo"."codes"."per_customer_limit" is null or "promo"."codes"."per_customer_limit" > 0)),
	CONSTRAINT "promo_codes_used_within_limit" CHECK ("promo"."codes"."used_count" >= 0 and ("promo"."codes"."total_limit" is null or "promo"."codes"."used_count" <= "promo"."codes"."total_limit")),
	CONSTRAINT "promo_codes_window" CHECK ("promo"."codes"."valid_from" is null or "promo"."codes"."valid_to" is null or "promo"."codes"."valid_from" <= "promo"."codes"."valid_to"),
	CONSTRAINT "promo_codes_origin" CHECK ("promo"."codes"."origin" in ('manual', 'occasion')),
	CONSTRAINT "promo_codes_status" CHECK ("promo"."codes"."status" in ('active', 'paused', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "promo"."redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code_id" uuid NOT NULL,
	"order_id" uuid,
	"pos_sale_id" uuid,
	"customer_id" uuid,
	"discount_poisha" bigint NOT NULL,
	"delivery_discount_poisha" bigint NOT NULL,
	"status" text DEFAULT 'applied' NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_redemptions_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "promo_redemptions_one_target" CHECK (("promo"."redemptions"."order_id" is null) <> ("promo"."redemptions"."pos_sale_id" is null)),
	CONSTRAINT "promo_redemptions_amounts" CHECK ("promo"."redemptions"."discount_poisha" >= 0 and "promo"."redemptions"."delivery_discount_poisha" >= 0
        and "promo"."redemptions"."discount_poisha" + "promo"."redemptions"."delivery_discount_poisha" > 0),
	CONSTRAINT "promo_redemptions_status" CHECK ("promo"."redemptions"."status" in ('applied', 'released')),
	CONSTRAINT "promo_redemptions_release_complete" CHECK (("promo"."redemptions"."status" = 'released') = ("promo"."redemptions"."released_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "sales"."customer_segments" ADD CONSTRAINT "customer_segments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."customer_segments" ADD CONSTRAINT "customer_segments_org_id_customer_id_fk" FOREIGN KEY ("org_id","customer_id") REFERENCES "sales"."customers"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."occasion_issues" ADD CONSTRAINT "occasion_issues_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."occasion_issues" ADD CONSTRAINT "occasion_issues_org_id_customer_id_fk" FOREIGN KEY ("org_id","customer_id") REFERENCES "sales"."customers"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."occasion_issues" ADD CONSTRAINT "occasion_issues_org_id_promo_code_id_fk" FOREIGN KEY ("org_id","promo_code_id") REFERENCES "promo"."codes"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."occasion_issues" ADD CONSTRAINT "occasion_issues_org_id_message_id_fk" FOREIGN KEY ("org_id","message_id") REFERENCES "notify"."messages"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notify"."messages" ADD CONSTRAINT "messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notify"."opt_outs" ADD CONSTRAINT "opt_outs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notify"."templates" ADD CONSTRAINT "templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD CONSTRAINT "codes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."codes" ADD CONSTRAINT "promo_codes_org_id_customer_id_fk" FOREIGN KEY ("org_id","customer_id") REFERENCES "sales"."customers"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."redemptions" ADD CONSTRAINT "redemptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."redemptions" ADD CONSTRAINT "promo_redemptions_org_id_code_id_fk" FOREIGN KEY ("org_id","code_id") REFERENCES "promo"."codes"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."redemptions" ADD CONSTRAINT "promo_redemptions_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."redemptions" ADD CONSTRAINT "promo_redemptions_org_id_pos_sale_id_fk" FOREIGN KEY ("org_id","pos_sale_id") REFERENCES "pos"."sales"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."redemptions" ADD CONSTRAINT "promo_redemptions_org_id_customer_id_fk" FOREIGN KEY ("org_id","customer_id") REFERENCES "sales"."customers"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_segments_org_idx" ON "sales"."customer_segments" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_segments_org_customer_idx" ON "sales"."customer_segments" USING btree ("org_id","customer_id");--> statement-breakpoint
CREATE INDEX "customer_segments_org_segment_idx" ON "sales"."customer_segments" USING btree ("org_id","segment");--> statement-breakpoint
CREATE INDEX "occasion_issues_org_idx" ON "sales"."occasion_issues" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "occasion_issues_org_customer_occasion_year_idx" ON "sales"."occasion_issues" USING btree ("org_id","customer_id","occasion","year");--> statement-breakpoint
CREATE INDEX "notify_messages_org_idx" ON "notify"."messages" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "notify_messages_org_state_idx" ON "notify"."messages" USING btree ("org_id","state","send_after");--> statement-breakpoint
CREATE INDEX "notify_messages_org_ref_idx" ON "notify"."messages" USING btree ("org_id","ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "notify_opt_outs_org_idx" ON "notify"."opt_outs" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notify_opt_outs_org_phone_channel_idx" ON "notify"."opt_outs" USING btree ("org_id","phone","channel");--> statement-breakpoint
CREATE INDEX "notify_templates_org_idx" ON "notify"."templates" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notify_templates_org_key_channel_idx" ON "notify"."templates" USING btree ("org_id","key","channel");--> statement-breakpoint
CREATE INDEX "promo_codes_org_idx" ON "promo"."codes" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "promo_codes_org_code_idx" ON "promo"."codes" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "promo_codes_org_customer_idx" ON "promo"."codes" USING btree ("org_id","customer_id");--> statement-breakpoint
CREATE INDEX "promo_redemptions_org_idx" ON "promo"."redemptions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "promo_redemptions_org_code_customer_idx" ON "promo"."redemptions" USING btree ("org_id","code_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "promo_redemptions_org_code_order_idx" ON "promo"."redemptions" USING btree ("org_id","code_id","order_id") WHERE "promo"."redemptions"."order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "promo_redemptions_org_code_sale_idx" ON "promo"."redemptions" USING btree ("org_id","code_id","pos_sale_id") WHERE "promo"."redemptions"."pos_sale_id" is not null;