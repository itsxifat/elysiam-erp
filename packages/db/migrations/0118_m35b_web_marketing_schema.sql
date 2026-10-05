CREATE SCHEMA "marketplace";
--> statement-breakpoint
CREATE SCHEMA "packing";
--> statement-breakpoint
ALTER TYPE "sales"."order_channel" ADD VALUE 'marketplace';--> statement-breakpoint
CREATE TABLE "marketplace"."ncom_events" (
	"org_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"topic" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ncom_events_pkey" PRIMARY KEY("org_id","event_id"),
	CONSTRAINT "ncom_events_event_id_shape" CHECK ("marketplace"."ncom_events"."event_id" ~ '^[!-~]{1,128}$'),
	CONSTRAINT "ncom_events_topic_shape" CHECK ("marketplace"."ncom_events"."topic" ~ '^[a-z_]{1,40}([.][a-z_]{1,40})?$')
);
--> statement-breakpoint
CREATE TABLE "marketplace"."ncom_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_ref" text NOT NULL,
	"state" text DEFAULT 'held' NOT NULL,
	"location_id" uuid NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"held_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"converted_order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ncom_holds_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "ncom_holds_order_ref_shape" CHECK ("marketplace"."ncom_holds"."order_ref" ~ '^[!-~]{1,128}$'),
	CONSTRAINT "ncom_holds_state" CHECK ("marketplace"."ncom_holds"."state" in ('held', 'released', 'converted')),
	CONSTRAINT "ncom_holds_state_complete" CHECK (("marketplace"."ncom_holds"."state" = 'held' and "marketplace"."ncom_holds"."released_at" is null and "marketplace"."ncom_holds"."converted_order_id" is null)
          or ("marketplace"."ncom_holds"."state" = 'released' and "marketplace"."ncom_holds"."released_at" is not null)
          or ("marketplace"."ncom_holds"."state" = 'converted' and "marketplace"."ncom_holds"."released_at" is not null and "marketplace"."ncom_holds"."converted_order_id" is not null)),
	CONSTRAINT "ncom_holds_lines_bounded" CHECK (pg_column_size("marketplace"."ncom_holds"."lines") < 65536)
);
--> statement-breakpoint
CREATE TABLE "marketplace"."ncom_orders" (
	"order_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"ncom_order_id" text NOT NULL,
	"ncom_order_number" text DEFAULT '' NOT NULL,
	"idempotency_key" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"last_inbound_key" text,
	"store_name" text DEFAULT '' NOT NULL,
	"store_url" text DEFAULT '' NOT NULL,
	"page_title" text DEFAULT '' NOT NULL,
	"page_url" text DEFAULT '' NOT NULL,
	"offer_key" text DEFAULT '' NOT NULL,
	"offer_label" text DEFAULT '' NOT NULL,
	"offer_price_poisha" bigint,
	"regular_price_poisha" bigint,
	"discount_code" text DEFAULT '' NOT NULL,
	"foreign_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"foreign_poisha" bigint DEFAULT 0 NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stock_held" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ncom_orders_pkey" PRIMARY KEY("org_id","order_id"),
	CONSTRAINT "ncom_orders_ids_shape" CHECK ("marketplace"."ncom_orders"."ncom_order_id" ~ '^[!-~]{1,128}$'
      and "marketplace"."ncom_orders"."idempotency_key" ~ '^[!-~]{1,255}$'),
	CONSTRAINT "ncom_orders_revision" CHECK ("marketplace"."ncom_orders"."revision" >= 0),
	CONSTRAINT "ncom_orders_money" CHECK ("marketplace"."ncom_orders"."foreign_poisha" >= 0 and coalesce("marketplace"."ncom_orders"."offer_price_poisha", 0) >= 0
          and coalesce("marketplace"."ncom_orders"."regular_price_poisha", 0) >= 0),
	CONSTRAINT "ncom_orders_sections_bounded" CHECK (pg_column_size("marketplace"."ncom_orders"."foreign_items") + pg_column_size("marketplace"."ncom_orders"."warnings") < 65536)
);
--> statement-breakpoint
CREATE TABLE "marketplace"."ncom_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"base_revision" integer NOT NULL,
	"revision" integer NOT NULL,
	"payload_sealed" "bytea",
	"key_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"status_code" integer,
	"error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ncom_outbox_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "ncom_outbox_topic" CHECK ("marketplace"."ncom_outbox"."topic" in ('order.updated', 'order.cancelled')),
	CONSTRAINT "ncom_outbox_status" CHECK ("marketplace"."ncom_outbox"."status" in ('pending', 'delivered', 'refused', 'failed')),
	CONSTRAINT "ncom_outbox_revision" CHECK ("marketplace"."ncom_outbox"."revision" = "marketplace"."ncom_outbox"."base_revision" + 1),
	CONSTRAINT "ncom_outbox_attempts" CHECK ("marketplace"."ncom_outbox"."attempts" between 0 and 8),
	CONSTRAINT "ncom_outbox_payload_only_while_pending" CHECK (("marketplace"."ncom_outbox"."payload_sealed" is null or "marketplace"."ncom_outbox"."status" = 'pending')
          and ("marketplace"."ncom_outbox"."status" <> 'pending' or ("marketplace"."ncom_outbox"."payload_sealed" is not null and "marketplace"."ncom_outbox"."key_id" is not null))),
	CONSTRAINT "ncom_outbox_delivered_complete" CHECK (("marketplace"."ncom_outbox"."status" = 'delivered') = ("marketplace"."ncom_outbox"."delivered_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "marketplace"."ncom_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"accept_orders" boolean DEFAULT false NOT NULL,
	"include_drafts" boolean DEFAULT true NOT NULL,
	"allow_search" boolean DEFAULT true NOT NULL,
	"allow_categories" boolean DEFAULT true NOT NULL,
	"allow_reserve" boolean DEFAULT true NOT NULL,
	"default_weight_grams" integer DEFAULT 0 NOT NULL,
	"public_base_url" text DEFAULT '' NOT NULL,
	"base_url" text DEFAULT 'https://ncom.bd/api/v1' NOT NULL,
	"connector_key_id" text DEFAULT '' NOT NULL,
	"order_key_id" text DEFAULT '' NOT NULL,
	"connector_secret_sealed" "bytea",
	"connector_secret_fingerprint" text,
	"order_secret_sealed" "bytea",
	"order_secret_fingerprint" text,
	"api_key_sealed" "bytea",
	"api_key_fingerprint" text,
	"webhook_secret_sealed" "bytea",
	"webhook_secret_fingerprint" text,
	"key_id" text,
	"last_request_at" timestamp with time zone,
	"last_request_kind" text,
	"request_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_refusal_reason" text,
	"last_refusal_at" timestamp with time zone,
	"last_order_at" timestamp with time zone,
	"orders_received" integer DEFAULT 0 NOT NULL,
	"last_webhook_at" timestamp with time zone,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ncom_settings_weight" CHECK ("marketplace"."ncom_settings"."default_weight_grams" between 0 and 100000),
	CONSTRAINT "ncom_settings_urls" CHECK ("marketplace"."ncom_settings"."base_url" ~ '^https://' and ("marketplace"."ncom_settings"."public_base_url" = '' or "marketplace"."ncom_settings"."public_base_url" ~ '^https://')),
	CONSTRAINT "ncom_settings_key_ids" CHECK (length("marketplace"."ncom_settings"."connector_key_id") <= 120 and length("marketplace"."ncom_settings"."order_key_id") <= 120),
	CONSTRAINT "ncom_settings_secrets_complete" CHECK (("marketplace"."ncom_settings"."connector_secret_sealed" is null) = ("marketplace"."ncom_settings"."connector_secret_fingerprint" is null)
          and ("marketplace"."ncom_settings"."order_secret_sealed" is null) = ("marketplace"."ncom_settings"."order_secret_fingerprint" is null)
          and ("marketplace"."ncom_settings"."api_key_sealed" is null) = ("marketplace"."ncom_settings"."api_key_fingerprint" is null)
          and ("marketplace"."ncom_settings"."webhook_secret_sealed" is null) = ("marketplace"."ncom_settings"."webhook_secret_fingerprint" is null)
          and (("marketplace"."ncom_settings"."connector_secret_sealed" is null and "marketplace"."ncom_settings"."order_secret_sealed" is null
                and "marketplace"."ncom_settings"."api_key_sealed" is null and "marketplace"."ncom_settings"."webhook_secret_sealed" is null)
               or "marketplace"."ncom_settings"."key_id" is not null)),
	CONSTRAINT "ncom_settings_orders_received" CHECK ("marketplace"."ncom_settings"."orders_received" >= 0)
);
--> statement-breakpoint
CREATE TABLE "packing"."scanner_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"token_sha256" text NOT NULL,
	"via" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scanner_devices_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "scanner_devices_label_length" CHECK (length("packing"."scanner_devices"."label") between 1 and 80),
	CONSTRAINT "scanner_devices_token_shape" CHECK ("packing"."scanner_devices"."token_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "scanner_devices_via" CHECK ("packing"."scanner_devices"."via" in ('password', 'console')),
	CONSTRAINT "scanner_devices_revocation_complete" CHECK (("packing"."scanner_devices"."revoked_at" is null) = ("packing"."scanner_devices"."revoked_by" is null)),
	CONSTRAINT "scanner_devices_expiry" CHECK ("packing"."scanner_devices"."expires_at" > "packing"."scanner_devices"."created_at")
);
--> statement-breakpoint
CREATE TABLE "storefront"."custom_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"base_type" text NOT NULL,
	"category_id" uuid,
	"custom_path" text,
	"highlight_product_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"banner" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"modal" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"views" bigint DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_links_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "custom_links_code_shape" CHECK ("storefront"."custom_links"."code" ~ '^[1-9][0-9]{4}$'),
	CONSTRAINT "custom_links_title_length" CHECK (length("storefront"."custom_links"."title") between 1 and 120),
	CONSTRAINT "custom_links_base_type" CHECK ("storefront"."custom_links"."base_type" in ('category', 'shop', 'custom')),
	CONSTRAINT "custom_links_base_complete" CHECK (("storefront"."custom_links"."base_type" <> 'category' or "storefront"."custom_links"."category_id" is not null)
          and ("storefront"."custom_links"."base_type" <> 'custom' or "storefront"."custom_links"."custom_path" is not null)),
	CONSTRAINT "custom_links_custom_path_shape" CHECK ("storefront"."custom_links"."custom_path" is null or ("storefront"."custom_links"."custom_path" ~ '^/[^/]' and length("storefront"."custom_links"."custom_path") <= 300)),
	CONSTRAINT "custom_links_highlights_bounded" CHECK (cardinality("storefront"."custom_links"."highlight_product_ids") <= 24),
	CONSTRAINT "custom_links_views" CHECK ("storefront"."custom_links"."views" >= 0),
	CONSTRAINT "custom_links_sections_bounded" CHECK (pg_column_size("storefront"."custom_links"."banner") + pg_column_size("storefront"."custom_links"."modal") < 16384)
);
--> statement-breakpoint
CREATE TABLE "storefront"."tracking_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"event_name" text NOT NULL,
	"source" text NOT NULL,
	"test_mode" boolean DEFAULT false NOT NULL,
	"order_id" uuid,
	"user_masked" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"match_keys" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"custom_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"value_poisha" bigint,
	"currency" text,
	"payload_sealed" "bytea",
	"key_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ga4" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracking_events_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "tracking_events_event_id_shape" CHECK ("storefront"."tracking_events"."event_id" ~ '^[!-~]{1,100}$'),
	CONSTRAINT "tracking_events_event_name_shape" CHECK ("storefront"."tracking_events"."event_name" ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'),
	CONSTRAINT "tracking_events_source" CHECK ("storefront"."tracking_events"."source" in ('client', 'server')),
	CONSTRAINT "tracking_events_status" CHECK ("storefront"."tracking_events"."status" in ('waiting', 'queued', 'success', 'partial', 'error', 'skipped')),
	CONSTRAINT "tracking_events_payload_only_while_pending" CHECK ("storefront"."tracking_events"."payload_sealed" is null or "storefront"."tracking_events"."status" in ('waiting', 'queued')),
	CONSTRAINT "tracking_events_payload_keyed" CHECK ("storefront"."tracking_events"."payload_sealed" is null or "storefront"."tracking_events"."key_id" is not null),
	CONSTRAINT "tracking_events_sections_bounded" CHECK (pg_column_size("storefront"."tracking_events"."custom_data") + pg_column_size("storefront"."tracking_events"."meta") + pg_column_size("storefront"."tracking_events"."ga4") < 65536)
);
--> statement-breakpoint
CREATE TABLE "storefront"."tracking_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"meta_pixel_enabled" boolean DEFAULT false NOT NULL,
	"meta_capi_enabled" boolean DEFAULT false NOT NULL,
	"meta_pixel_id" text DEFAULT '' NOT NULL,
	"meta_dataset_id" text DEFAULT '' NOT NULL,
	"meta_api_version" text DEFAULT 'v21.0' NOT NULL,
	"meta_token_sealed" "bytea",
	"meta_token_fingerprint" text,
	"meta_test_event_code" text DEFAULT '' NOT NULL,
	"default_country_code" text DEFAULT '880' NOT NULL,
	"ga4_client_enabled" boolean DEFAULT false NOT NULL,
	"ga4_mp_enabled" boolean DEFAULT false NOT NULL,
	"ga4_measurement_id" text DEFAULT '' NOT NULL,
	"ga4_secret_sealed" "bytea",
	"ga4_secret_fingerprint" text,
	"key_id" text,
	"proxy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"test_mode" boolean DEFAULT false NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"log_retention_days" integer DEFAULT 30 NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracking_settings_pixel_id_shape" CHECK ("storefront"."tracking_settings"."meta_pixel_id" ~ '^[0-9]{0,24}$'),
	CONSTRAINT "tracking_settings_dataset_id_shape" CHECK ("storefront"."tracking_settings"."meta_dataset_id" ~ '^[0-9]{0,24}$'),
	CONSTRAINT "tracking_settings_api_version" CHECK ("storefront"."tracking_settings"."meta_api_version" ~ '^v[0-9]{1,3}[.][0-9]$'),
	CONSTRAINT "tracking_settings_measurement_id_shape" CHECK ("storefront"."tracking_settings"."ga4_measurement_id" ~ '^(G-[A-Z0-9]{4,20})?$'),
	CONSTRAINT "tracking_settings_country_code" CHECK ("storefront"."tracking_settings"."default_country_code" ~ '^[0-9]{1,4}$'),
	CONSTRAINT "tracking_settings_retention" CHECK ("storefront"."tracking_settings"."log_retention_days" between 1 and 365),
	CONSTRAINT "tracking_settings_secrets_complete" CHECK (("storefront"."tracking_settings"."meta_token_sealed" is null) = ("storefront"."tracking_settings"."meta_token_fingerprint" is null)
          and ("storefront"."tracking_settings"."ga4_secret_sealed" is null) = ("storefront"."tracking_settings"."ga4_secret_fingerprint" is null)
          and (("storefront"."tracking_settings"."meta_token_sealed" is null and "storefront"."tracking_settings"."ga4_secret_sealed" is null)
               or "storefront"."tracking_settings"."key_id" is not null)),
	CONSTRAINT "tracking_settings_sections_bounded" CHECK (pg_column_size("storefront"."tracking_settings"."proxy") + pg_column_size("storefront"."tracking_settings"."events") < 16384)
);
--> statement-breakpoint
ALTER TABLE "marketplace"."ncom_events" ADD CONSTRAINT "ncom_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."ncom_holds" ADD CONSTRAINT "ncom_holds_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."ncom_holds" ADD CONSTRAINT "ncom_holds_org_id_location_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "org"."locations"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."ncom_holds" ADD CONSTRAINT "ncom_holds_org_id_converted_order_id_fk" FOREIGN KEY ("org_id","converted_order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."ncom_orders" ADD CONSTRAINT "ncom_orders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."ncom_orders" ADD CONSTRAINT "ncom_orders_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."ncom_outbox" ADD CONSTRAINT "ncom_outbox_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."ncom_outbox" ADD CONSTRAINT "ncom_outbox_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "marketplace"."ncom_orders"("org_id","order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace"."ncom_settings" ADD CONSTRAINT "ncom_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."scanner_devices" ADD CONSTRAINT "scanner_devices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."scanner_devices" ADD CONSTRAINT "scanner_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."custom_links" ADD CONSTRAINT "custom_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."custom_links" ADD CONSTRAINT "custom_links_org_id_category_id_fk" FOREIGN KEY ("org_id","category_id") REFERENCES "catalog"."categories"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."tracking_events" ADD CONSTRAINT "tracking_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."tracking_events" ADD CONSTRAINT "tracking_events_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."tracking_settings" ADD CONSTRAINT "tracking_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ncom_events_org_idx" ON "marketplace"."ncom_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "ncom_events_org_received_idx" ON "marketplace"."ncom_events" USING btree ("org_id","received_at");--> statement-breakpoint
CREATE INDEX "ncom_holds_org_idx" ON "marketplace"."ncom_holds" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ncom_holds_org_ref_idx" ON "marketplace"."ncom_holds" USING btree ("org_id","order_ref");--> statement-breakpoint
CREATE INDEX "ncom_holds_org_state_idx" ON "marketplace"."ncom_holds" USING btree ("org_id","state","held_at");--> statement-breakpoint
CREATE INDEX "ncom_orders_org_idx" ON "marketplace"."ncom_orders" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ncom_orders_org_ncom_id_idx" ON "marketplace"."ncom_orders" USING btree ("org_id","ncom_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ncom_orders_org_key_idx" ON "marketplace"."ncom_orders" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "ncom_outbox_org_idx" ON "marketplace"."ncom_outbox" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ncom_outbox_org_key_idx" ON "marketplace"."ncom_outbox" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "ncom_outbox_org_order_idx" ON "marketplace"."ncom_outbox" USING btree ("org_id","order_id","revision");--> statement-breakpoint
CREATE INDEX "ncom_outbox_due_idx" ON "marketplace"."ncom_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "ncom_settings_org_idx" ON "marketplace"."ncom_settings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "scanner_devices_org_idx" ON "packing"."scanner_devices" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "scanner_devices_org_user_idx" ON "packing"."scanner_devices" USING btree ("org_id","user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scanner_devices_token_idx" ON "packing"."scanner_devices" USING btree ("token_sha256");--> statement-breakpoint
CREATE INDEX "custom_links_org_idx" ON "storefront"."custom_links" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_links_org_code_idx" ON "storefront"."custom_links" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "tracking_events_org_idx" ON "storefront"."tracking_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "tracking_events_org_created_idx" ON "storefront"."tracking_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "tracking_events_org_status_idx" ON "storefront"."tracking_events" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE INDEX "tracking_events_expires_idx" ON "storefront"."tracking_events" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tracking_events_org_server_event_idx" ON "storefront"."tracking_events" USING btree ("org_id","event_id") WHERE "storefront"."tracking_events"."source" = 'server';--> statement-breakpoint
CREATE INDEX "tracking_settings_org_idx" ON "storefront"."tracking_settings" USING btree ("org_id");