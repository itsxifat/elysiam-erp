CREATE TABLE "notify"."email_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"secure" boolean NOT NULL,
	"username" text DEFAULT '' NOT NULL,
	"password_sealed" "bytea",
	"key_id" text,
	"fingerprint" text,
	"from_name" text NOT NULL,
	"from_email" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notify_email_settings_port" CHECK ("notify"."email_settings"."port" between 1 and 65535),
	CONSTRAINT "notify_email_settings_host" CHECK ("notify"."email_settings"."host" ~ '^[A-Za-z0-9.-]{1,253}$'),
	CONSTRAINT "notify_email_settings_from_email" CHECK ("notify"."email_settings"."from_email" ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'),
	CONSTRAINT "notify_email_settings_password_complete" CHECK (("notify"."email_settings"."password_sealed" is null) = ("notify"."email_settings"."key_id" is null)
          and ("notify"."email_settings"."key_id" is null) = ("notify"."email_settings"."fingerprint" is null))
);
--> statement-breakpoint
CREATE TABLE "notify"."emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"locale" text DEFAULT 'bn' NOT NULL,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"body_sealed" "bytea",
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"provider_message_id" text,
	"error" text,
	"sent_at" timestamp with time zone,
	"ref_type" text,
	"ref_id" uuid,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notify_emails_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "notify_emails_state" CHECK ("notify"."emails"."state" in ('queued', 'sent', 'failed', 'skipped')),
	CONSTRAINT "notify_emails_locale" CHECK ("notify"."emails"."locale" in ('bn', 'en')),
	CONSTRAINT "notify_emails_template_key" CHECK ("notify"."emails"."template_key" ~ '^[a-z][a-z0-9_.]{2,63}$'),
	CONSTRAINT "notify_emails_sent_complete" CHECK (("notify"."emails"."state" = 'sent') = ("notify"."emails"."sent_at" is not null)),
	CONSTRAINT "notify_emails_body_only_while_queued" CHECK ("notify"."emails"."body_sealed" is null or "notify"."emails"."state" = 'queued')
);
--> statement-breakpoint
CREATE TABLE "storefront"."account_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_codes_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "account_codes_purpose" CHECK ("storefront"."account_codes"."purpose" in ('verify_email', 'reset_password')),
	CONSTRAINT "account_codes_hash_shape" CHECK ("storefront"."account_codes"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "account_codes_attempts" CHECK ("storefront"."account_codes"."attempts" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "storefront"."checkout_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_key_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_sha256" text NOT NULL,
	"order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_submissions_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "checkout_submissions_key_shape" CHECK ("storefront"."checkout_submissions"."idempotency_key" ~ '^[!-~]{8,255}$'),
	CONSTRAINT "checkout_submissions_sha_shape" CHECK ("storefront"."checkout_submissions"."request_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "storefront"."customer_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"password_hash" text,
	"google_sub" text,
	"name" text NOT NULL,
	"phone_e164" text,
	"customer_id" uuid,
	"locale" text DEFAULT 'bn' NOT NULL,
	"addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_sign_in_at" timestamp with time zone,
	"source" text DEFAULT 'website' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_accounts_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "customer_accounts_email_shape" CHECK ("storefront"."customer_accounts"."email" = lower(btrim("storefront"."customer_accounts"."email"))
          and "storefront"."customer_accounts"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
          and length("storefront"."customer_accounts"."email") <= 254),
	CONSTRAINT "customer_accounts_password_hash_shape" CHECK ("storefront"."customer_accounts"."password_hash" is null
          or "storefront"."customer_accounts"."password_hash" ~ '^[$]2[aby][$][0-9]{2}[$][./A-Za-z0-9]{53}$'),
	CONSTRAINT "customer_accounts_can_sign_in" CHECK ("storefront"."customer_accounts"."password_hash" is not null or "storefront"."customer_accounts"."google_sub" is not null),
	CONSTRAINT "customer_accounts_google_verified" CHECK ("storefront"."customer_accounts"."google_sub" is null or "storefront"."customer_accounts"."email_verified_at" is not null),
	CONSTRAINT "customer_accounts_phone_shape" CHECK ("storefront"."customer_accounts"."phone_e164" is null or "storefront"."customer_accounts"."phone_e164" ~ '^[+]8801[3-9][0-9]{8}$'),
	CONSTRAINT "customer_accounts_name_length" CHECK (length("storefront"."customer_accounts"."name") between 1 and 120),
	CONSTRAINT "customer_accounts_locale" CHECK ("storefront"."customer_accounts"."locale" in ('bn', 'en')),
	CONSTRAINT "customer_accounts_addresses_array" CHECK (jsonb_typeof("storefront"."customer_accounts"."addresses") = 'array' and jsonb_array_length("storefront"."customer_accounts"."addresses") <= 10),
	CONSTRAINT "customer_accounts_source" CHECK ("storefront"."customer_accounts"."source" in ('website', 'google', 'legacy_import'))
);
--> statement-breakpoint
CREATE TABLE "storefront"."gateway_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'sslcommerz' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"mode" text DEFAULT 'sandbox' NOT NULL,
	"store_id" text NOT NULL,
	"password_sealed" "bytea" NOT NULL,
	"key_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_settings_provider" CHECK ("storefront"."gateway_settings"."provider" in ('sslcommerz')),
	CONSTRAINT "gateway_settings_mode" CHECK ("storefront"."gateway_settings"."mode" in ('sandbox', 'live')),
	CONSTRAINT "gateway_settings_store_id_length" CHECK (length("storefront"."gateway_settings"."store_id") between 1 and 30),
	CONSTRAINT "gateway_settings_fingerprint_shape" CHECK ("storefront"."gateway_settings"."fingerprint" ~ '^[0-9a-f]{12}$')
);
--> statement-breakpoint
CREATE TABLE "storefront"."order_view_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"token_sha256" text NOT NULL,
	"purpose" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_view_tokens_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "order_view_tokens_hash_shape" CHECK ("storefront"."order_view_tokens"."token_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "order_view_tokens_purpose" CHECK ("storefront"."order_view_tokens"."purpose" in ('confirmation', 'email'))
);
--> statement-breakpoint
CREATE TABLE "storefront"."payment_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" text DEFAULT 'sslcommerz' NOT NULL,
	"mode" text NOT NULL,
	"tran_id" text NOT NULL,
	"amount_poisha" bigint NOT NULL,
	"status" text DEFAULT 'initiating' NOT NULL,
	"gateway_url" text,
	"session_key" text,
	"val_id" text,
	"validated_amount_poisha" bigint,
	"card_type" text,
	"bank_tran_id" text,
	"risky" boolean DEFAULT false NOT NULL,
	"failure_reason" text,
	"advance_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_sessions_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "payment_sessions_provider" CHECK ("storefront"."payment_sessions"."provider" in ('sslcommerz')),
	CONSTRAINT "payment_sessions_mode" CHECK ("storefront"."payment_sessions"."mode" in ('sandbox', 'live')),
	CONSTRAINT "payment_sessions_tran_id_shape" CHECK ("storefront"."payment_sessions"."tran_id" ~ '^[A-Z0-9]{20,30}$'),
	CONSTRAINT "payment_sessions_amount" CHECK ("storefront"."payment_sessions"."amount_poisha" > 0 and "storefront"."payment_sessions"."amount_poisha" <= 9000000000000000),
	CONSTRAINT "payment_sessions_status" CHECK ("storefront"."payment_sessions"."status" in ('initiating', 'ready', 'failed', 'validating', 'paid', 'refused', 'cancelled', 'expired')),
	CONSTRAINT "payment_sessions_paid_complete" CHECK (("storefront"."payment_sessions"."status" = 'paid') = ("storefront"."payment_sessions"."advance_id" is not null)
          and ("storefront"."payment_sessions"."status" <> 'paid' or ("storefront"."payment_sessions"."val_id" is not null
               and "storefront"."payment_sessions"."validated_amount_poisha" = "storefront"."payment_sessions"."amount_poisha")))
);
--> statement-breakpoint
CREATE TABLE "storefront"."web_orders" (
	"order_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid,
	"email" text,
	"locale" text DEFAULT 'bn' NOT NULL,
	"payment_method" text NOT NULL,
	"phone_e164" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_orders_pkey" PRIMARY KEY("org_id","order_id"),
	CONSTRAINT "web_orders_payment_method" CHECK ("storefront"."web_orders"."payment_method" in ('cod', 'sslcommerz')),
	CONSTRAINT "web_orders_locale" CHECK ("storefront"."web_orders"."locale" in ('bn', 'en')),
	CONSTRAINT "web_orders_phone_shape" CHECK ("storefront"."web_orders"."phone_e164" ~ '^[+]8801[3-9][0-9]{8}$')
);
--> statement-breakpoint
ALTER TABLE "sales"."order_advances" DROP CONSTRAINT "order_advances_method";--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD COLUMN "stock_held_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notify"."email_settings" ADD CONSTRAINT "email_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notify"."emails" ADD CONSTRAINT "emails_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."account_codes" ADD CONSTRAINT "account_codes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."account_codes" ADD CONSTRAINT "account_codes_org_id_account_id_fk" FOREIGN KEY ("org_id","account_id") REFERENCES "storefront"."customer_accounts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."checkout_submissions" ADD CONSTRAINT "checkout_submissions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."checkout_submissions" ADD CONSTRAINT "checkout_submissions_org_id_site_key_id_fk" FOREIGN KEY ("org_id","site_key_id") REFERENCES "storefront"."site_keys"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."checkout_submissions" ADD CONSTRAINT "checkout_submissions_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."customer_accounts" ADD CONSTRAINT "customer_accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."customer_accounts" ADD CONSTRAINT "customer_accounts_org_id_customer_id_fk" FOREIGN KEY ("org_id","customer_id") REFERENCES "sales"."customers"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."gateway_settings" ADD CONSTRAINT "gateway_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."order_view_tokens" ADD CONSTRAINT "order_view_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."order_view_tokens" ADD CONSTRAINT "order_view_tokens_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "storefront"."web_orders"("org_id","order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."payment_sessions" ADD CONSTRAINT "payment_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."payment_sessions" ADD CONSTRAINT "payment_sessions_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "storefront"."web_orders"("org_id","order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."payment_sessions" ADD CONSTRAINT "payment_sessions_org_id_advance_id_fk" FOREIGN KEY ("org_id","advance_id") REFERENCES "sales"."order_advances"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."web_orders" ADD CONSTRAINT "web_orders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."web_orders" ADD CONSTRAINT "web_orders_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront"."web_orders" ADD CONSTRAINT "web_orders_org_id_account_id_fk" FOREIGN KEY ("org_id","account_id") REFERENCES "storefront"."customer_accounts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notify_email_settings_org_idx" ON "notify"."email_settings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "notify_emails_org_idx" ON "notify"."emails" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "notify_emails_org_state_idx" ON "notify"."emails" USING btree ("org_id","state","created_at");--> statement-breakpoint
CREATE INDEX "notify_emails_org_ref_idx" ON "notify"."emails" USING btree ("org_id","ref_type","ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notify_emails_org_dedupe_idx" ON "notify"."emails" USING btree ("org_id","dedupe_key") WHERE "notify"."emails"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "account_codes_org_idx" ON "storefront"."account_codes" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "account_codes_org_account_idx" ON "storefront"."account_codes" USING btree ("org_id","account_id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "account_codes_org_hash_idx" ON "storefront"."account_codes" USING btree ("org_id","purpose","code_hash");--> statement-breakpoint
CREATE INDEX "checkout_submissions_org_idx" ON "storefront"."checkout_submissions" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_submissions_org_key_idx" ON "storefront"."checkout_submissions" USING btree ("org_id","site_key_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "customer_accounts_org_idx" ON "storefront"."customer_accounts" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_accounts_org_email_idx" ON "storefront"."customer_accounts" USING btree ("org_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_accounts_org_google_idx" ON "storefront"."customer_accounts" USING btree ("org_id","google_sub") WHERE "storefront"."customer_accounts"."google_sub" is not null;--> statement-breakpoint
CREATE INDEX "customer_accounts_org_customer_idx" ON "storefront"."customer_accounts" USING btree ("org_id","customer_id");--> statement-breakpoint
CREATE INDEX "customer_accounts_org_phone_idx" ON "storefront"."customer_accounts" USING btree ("org_id","phone_e164");--> statement-breakpoint
CREATE INDEX "gateway_settings_org_idx" ON "storefront"."gateway_settings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "order_view_tokens_org_idx" ON "storefront"."order_view_tokens" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_view_tokens_org_hash_idx" ON "storefront"."order_view_tokens" USING btree ("org_id","token_sha256");--> statement-breakpoint
CREATE INDEX "order_view_tokens_org_order_idx" ON "storefront"."order_view_tokens" USING btree ("org_id","order_id");--> statement-breakpoint
CREATE INDEX "payment_sessions_org_idx" ON "storefront"."payment_sessions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "payment_sessions_org_order_idx" ON "storefront"."payment_sessions" USING btree ("org_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_sessions_tran_id_idx" ON "storefront"."payment_sessions" USING btree ("tran_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_sessions_org_val_id_idx" ON "storefront"."payment_sessions" USING btree ("org_id","val_id") WHERE "storefront"."payment_sessions"."status" = 'paid';--> statement-breakpoint
CREATE INDEX "web_orders_org_idx" ON "storefront"."web_orders" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "web_orders_org_account_idx" ON "storefront"."web_orders" USING btree ("org_id","account_id","created_at");--> statement-breakpoint
CREATE INDEX "web_orders_org_email_idx" ON "storefront"."web_orders" USING btree ("org_id","email");--> statement-breakpoint
CREATE INDEX "web_orders_org_phone_idx" ON "storefront"."web_orders" USING btree ("org_id","phone_e164");--> statement-breakpoint
ALTER TABLE "sales"."order_advances" ADD CONSTRAINT "order_advances_method" CHECK ("sales"."order_advances"."method" in ('bkash', 'nagad', 'bank', 'sslcommerz'));--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_stock_held_has_location" CHECK ("sales"."orders"."stock_held_at" is null or "sales"."orders"."location_id" is not null);