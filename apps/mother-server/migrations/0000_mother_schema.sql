CREATE SCHEMA "auth";
--> statement-breakpoint
CREATE SCHEMA "mother";
--> statement-breakpoint
CREATE TABLE "auth"."accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"password" text,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mother"."audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" text,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE "mother"."brand_daily" (
	"brand_id" uuid NOT NULL,
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
	"computed_at" timestamp with time zone,
	"pulled_at" timestamp with time zone NOT NULL,
	CONSTRAINT "brand_daily_brand_id_business_date_pk" PRIMARY KEY("brand_id","business_date")
);
--> statement-breakpoint
CREATE TABLE "mother"."brand_daily_campaign" (
	"brand_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"campaign_key" text NOT NULL,
	"campaign_name" text,
	"spend_poisha" bigint DEFAULT 0 NOT NULL,
	"orders_confirmed" integer DEFAULT 0 NOT NULL,
	"orders_delivered" integer DEFAULT 0 NOT NULL,
	"orders_returned" integer DEFAULT 0 NOT NULL,
	"delivered_revenue_poisha" bigint DEFAULT 0 NOT NULL,
	"placed_revenue_poisha" bigint DEFAULT 0 NOT NULL,
	"pulled_at" timestamp with time zone NOT NULL,
	CONSTRAINT "brand_daily_campaign_brand_id_business_date_campaign_key_pk" PRIMARY KEY("brand_id","business_date","campaign_key")
);
--> statement-breakpoint
CREATE TABLE "mother"."brand_daily_channel" (
	"brand_id" uuid NOT NULL,
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
	"pulled_at" timestamp with time zone NOT NULL,
	CONSTRAINT "brand_daily_channel_brand_id_business_date_channel_pk" PRIMARY KEY("brand_id","business_date","channel")
);
--> statement-breakpoint
CREATE TABLE "mother"."brand_daily_ledger" (
	"brand_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"subtype" text NOT NULL,
	"account_class" text NOT NULL,
	"debit_poisha" bigint NOT NULL,
	"credit_poisha" bigint NOT NULL,
	"pulled_at" timestamp with time zone NOT NULL,
	CONSTRAINT "brand_daily_ledger_brand_id_business_date_account_class_subtype_pk" PRIMARY KEY("brand_id","business_date","account_class","subtype"),
	CONSTRAINT "brand_daily_ledger_class" CHECK ("mother"."brand_daily_ledger"."account_class" in ('income', 'expense')),
	CONSTRAINT "brand_daily_ledger_sides" CHECK ("mother"."brand_daily_ledger"."debit_poisha" >= 0 and "mother"."brand_daily_ledger"."credit_poisha" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mother"."brand_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"as_of" date NOT NULL,
	"cash_hand_poisha" bigint NOT NULL,
	"cash_bank_poisha" bigint NOT NULL,
	"cash_bkash_poisha" bigint NOT NULL,
	"cash_mfs_other_poisha" bigint NOT NULL,
	"stock_value_poisha" bigint NOT NULL,
	"goods_in_transit_poisha" bigint NOT NULL,
	"cod_held_poisha" bigint NOT NULL,
	"supplier_payables_poisha" bigint NOT NULL,
	"receivables_poisha" bigint NOT NULL,
	"open_orders" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"staff_headcount" integer NOT NULL,
	"active_skus" integer NOT NULL,
	"low_stock_skus" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mother"."brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"admin_url" text NOT NULL,
	"read_connection_cipher" "bytea" NOT NULL,
	"read_connection_key_id" text NOT NULL,
	"read_connection_fingerprint" text NOT NULL,
	"owner_link_key_cipher" "bytea",
	"owner_link_key_id" text,
	"owner_link_key_fingerprint" text,
	"owner_link_key_created_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"brand_org_id" uuid,
	"schema_status" text DEFAULT 'unknown' NOT NULL,
	"brand_migrations" integer,
	"last_attempt_at" timestamp with time zone,
	"figures_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brands_slug_format" CHECK ("mother"."brands"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "brands_schema_status" CHECK ("mother"."brands"."schema_status" in ('ok', 'version_mismatch', 'unknown')),
	CONSTRAINT "brands_owner_link_key_whole" CHECK (("mother"."brands"."owner_link_key_cipher" is null) = ("mother"."brands"."owner_link_key_fingerprint" is null))
);
--> statement-breakpoint
CREATE TABLE "mother"."pull_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"is_full" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"error_code" text,
	"from_date" date,
	"to_date" date,
	"days" integer,
	CONSTRAINT "pull_runs_trigger" CHECK ("mother"."pull_runs"."trigger" in ('schedule', 'nightly', 'owner', 'first')),
	CONSTRAINT "pull_runs_status" CHECK ("mother"."pull_runs"."status" in ('running', 'ok', 'failed', 'version_mismatch'))
);
--> statement-breakpoint
CREATE TABLE "auth"."sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "mother"."two_factor_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_user_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "two_factor_resets_status" CHECK ("mother"."two_factor_resets"."status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "two_factor_resets_not_self" CHECK ("mother"."two_factor_resets"."requested_by" <> "mother"."two_factor_resets"."target_user_id"),
	CONSTRAINT "two_factor_resets_decider" CHECK ("mother"."two_factor_resets"."decided_by" is null or ("mother"."two_factor_resets"."decided_by" <> "mother"."two_factor_resets"."requested_by"
          and "mother"."two_factor_resets"."decided_by" <> "mother"."two_factor_resets"."target_user_id")),
	CONSTRAINT "two_factor_resets_decided_whole" CHECK (("mother"."two_factor_resets"."status" = 'pending') = ("mother"."two_factor_resets"."decided_by" is null and "mother"."two_factor_resets"."decided_at" is null))
);
--> statement-breakpoint
CREATE TABLE "auth"."two_factors" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth"."users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"two_factor_enabled" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"invited_by" text,
	"last_sign_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth"."verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mother"."brand_daily" ADD CONSTRAINT "brand_daily_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "mother"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mother"."brand_daily_campaign" ADD CONSTRAINT "brand_daily_campaign_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "mother"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mother"."brand_daily_channel" ADD CONSTRAINT "brand_daily_channel_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "mother"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mother"."brand_daily_ledger" ADD CONSTRAINT "brand_daily_ledger_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "mother"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mother"."brand_snapshots" ADD CONSTRAINT "brand_snapshots_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "mother"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mother"."pull_runs" ADD CONSTRAINT "pull_runs_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "mother"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mother"."two_factor_resets" ADD CONSTRAINT "two_factor_resets_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mother"."two_factor_resets" ADD CONSTRAINT "two_factor_resets_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "auth"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mother"."two_factor_resets" ADD CONSTRAINT "two_factor_resets_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "auth"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."two_factors" ADD CONSTRAINT "two_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "auth"."accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_log_occurred_idx" ON "mother"."audit_log" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "mother"."audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "brand_snapshots_brand_taken_idx" ON "mother"."brand_snapshots" USING btree ("brand_id","taken_at");--> statement-breakpoint
CREATE UNIQUE INDEX "brands_slug_idx" ON "mother"."brands" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "pull_runs_brand_started_idx" ON "mother"."pull_runs" USING btree ("brand_id","started_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "auth"."sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "two_factor_resets_target_idx" ON "mother"."two_factor_resets" USING btree ("target_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "two_factor_resets_one_pending_idx" ON "mother"."two_factor_resets" USING btree ("target_user_id") WHERE "mother"."two_factor_resets"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "two_factors_user_idx" ON "auth"."two_factors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "auth"."verifications" USING btree ("identifier");