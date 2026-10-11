CREATE SCHEMA "inbox";
--> statement-breakpoint
CREATE TABLE "inbox"."channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"access_token_sealed" "bytea",
	"access_token_key_id" text,
	"access_token_fingerprint" text,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "channels_kind" CHECK ("inbox"."channels"."kind" in ('messenger', 'instagram', 'whatsapp')),
	CONSTRAINT "channels_external_id" CHECK ("inbox"."channels"."external_id" ~ '^[0-9]{1,30}$'),
	CONSTRAINT "channels_token_whole" CHECK (("inbox"."channels"."access_token_sealed" is null) = ("inbox"."channels"."access_token_fingerprint" is null))
);
--> statement-breakpoint
CREATE TABLE "inbox"."contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"display_name" text,
	"stage" text DEFAULT 'visitor' NOT NULL,
	"stage_set_by" text,
	"stage_set_at" timestamp with time zone,
	"phone_e164" text,
	"customer_id" uuid,
	"district_id" integer,
	"thana_id" integer,
	"area" text,
	"address_line" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "contacts_stage" CHECK ("inbox"."contacts"."stage" in ('visitor', 'lead', 'customer', 'not_qualified', 'fraud')),
	CONSTRAINT "contacts_phone" CHECK ("inbox"."contacts"."phone_e164" is null or "inbox"."contacts"."phone_e164" ~ '^\+8801[13-9][0-9]{8}$'),
	CONSTRAINT "contacts_display_name" CHECK (char_length("inbox"."contacts"."display_name") <= 200),
	CONSTRAINT "contacts_area" CHECK (char_length("inbox"."contacts"."area") <= 160),
	CONSTRAINT "contacts_address_line" CHECK (char_length("inbox"."contacts"."address_line") <= 500),
	CONSTRAINT "contacts_tags" CHECK (cardinality("inbox"."contacts"."tags") <= 20)
);
--> statement-breakpoint
CREATE TABLE "inbox"."conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"assigned_to" text,
	"assigned_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_preview" text,
	"last_direction" text,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "conversations_status" CHECK ("inbox"."conversations"."status" in ('open', 'closed')),
	CONSTRAINT "conversations_last_direction" CHECK ("inbox"."conversations"."last_direction" is null or "inbox"."conversations"."last_direction" in ('inbound', 'outbound')),
	CONSTRAINT "conversations_unread" CHECK ("inbox"."conversations"."unread_count" >= 0),
	CONSTRAINT "conversations_assignment_whole" CHECK (("inbox"."conversations"."assigned_to" is null) = ("inbox"."conversations"."assigned_at" is null))
);
--> statement-breakpoint
CREATE TABLE "inbox"."identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"external_user_id" text NOT NULL,
	"profile_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identities_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "identities_external_user_id" CHECK (char_length("inbox"."identities"."external_user_id") between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "inbox"."interests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sku_id" uuid,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interests_org_id_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "inbox"."messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"body" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_message_id" text,
	"status" text NOT NULL,
	"sent_by" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"error_code" text,
	"error_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "messages_direction" CHECK ("inbox"."messages"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "messages_status" CHECK (("inbox"."messages"."direction" = 'inbound' and "inbox"."messages"."status" = 'received')
        or ("inbox"."messages"."direction" = 'outbound'
            and "inbox"."messages"."status" in ('queued', 'sent', 'delivered', 'read', 'failed'))),
	CONSTRAINT "messages_body" CHECK (char_length("inbox"."messages"."body") <= 4096),
	CONSTRAINT "messages_provider_id" CHECK (char_length("inbox"."messages"."provider_message_id") <= 256),
	CONSTRAINT "messages_error_detail" CHECK (char_length("inbox"."messages"."error_detail") <= 500)
);
--> statement-breakpoint
CREATE TABLE "inbox"."notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"body" text NOT NULL,
	"author_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notes_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "notes_body" CHECK (char_length("inbox"."notes"."body") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "inbox"."settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"app_secret_sealed" "bytea",
	"app_secret_key_id" text,
	"app_secret_fingerprint" text,
	"verify_token_sealed" "bytea",
	"verify_token_key_id" text,
	"verify_token_fingerprint" text,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "settings_app_secret_whole" CHECK (("inbox"."settings"."app_secret_sealed" is null) = ("inbox"."settings"."app_secret_fingerprint" is null)),
	CONSTRAINT "settings_verify_token_whole" CHECK (("inbox"."settings"."verify_token_sealed" is null) = ("inbox"."settings"."verify_token_fingerprint" is null))
);
--> statement-breakpoint
CREATE TABLE "inbox"."webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"object" text NOT NULL,
	"body_sha256" text NOT NULL,
	"body" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"outcome" jsonb,
	CONSTRAINT "webhook_events_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "webhook_events_object" CHECK ("inbox"."webhook_events"."object" in ('page', 'instagram', 'whatsapp_business_account')),
	CONSTRAINT "webhook_events_sha" CHECK ("inbox"."webhook_events"."body_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "inbox"."channels" ADD CONSTRAINT "channels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."contacts" ADD CONSTRAINT "contacts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."contacts" ADD CONSTRAINT "contacts_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "ref"."districts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."contacts" ADD CONSTRAINT "contacts_thana_id_thanas_id_fk" FOREIGN KEY ("thana_id") REFERENCES "ref"."thanas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."contacts" ADD CONSTRAINT "contacts_org_id_customer_id_fk" FOREIGN KEY ("org_id","customer_id") REFERENCES "sales"."customers"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversations" ADD CONSTRAINT "conversations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversations" ADD CONSTRAINT "conversations_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversations" ADD CONSTRAINT "conversations_org_id_channel_id_fk" FOREIGN KEY ("org_id","channel_id") REFERENCES "inbox"."channels"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversations" ADD CONSTRAINT "conversations_org_id_contact_id_fk" FOREIGN KEY ("org_id","contact_id") REFERENCES "inbox"."contacts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversations" ADD CONSTRAINT "conversations_org_id_identity_id_fk" FOREIGN KEY ("org_id","identity_id") REFERENCES "inbox"."identities"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."identities" ADD CONSTRAINT "identities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."identities" ADD CONSTRAINT "identities_org_id_contact_id_fk" FOREIGN KEY ("org_id","contact_id") REFERENCES "inbox"."contacts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."identities" ADD CONSTRAINT "identities_org_id_channel_id_fk" FOREIGN KEY ("org_id","channel_id") REFERENCES "inbox"."channels"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."interests" ADD CONSTRAINT "interests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."interests" ADD CONSTRAINT "interests_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."interests" ADD CONSTRAINT "interests_org_id_contact_id_fk" FOREIGN KEY ("org_id","contact_id") REFERENCES "inbox"."contacts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."interests" ADD CONSTRAINT "interests_org_id_product_id_fk" FOREIGN KEY ("org_id","product_id") REFERENCES "catalog"."products"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."interests" ADD CONSTRAINT "interests_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."messages" ADD CONSTRAINT "messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."messages" ADD CONSTRAINT "messages_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."messages" ADD CONSTRAINT "messages_org_id_conversation_id_fk" FOREIGN KEY ("org_id","conversation_id") REFERENCES "inbox"."conversations"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."notes" ADD CONSTRAINT "notes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."notes" ADD CONSTRAINT "notes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."notes" ADD CONSTRAINT "notes_org_id_contact_id_fk" FOREIGN KEY ("org_id","contact_id") REFERENCES "inbox"."contacts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."settings" ADD CONSTRAINT "settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."webhook_events" ADD CONSTRAINT "webhook_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channels_org_kind_idx" ON "inbox"."channels" USING btree ("org_id","kind");--> statement-breakpoint
CREATE INDEX "channels_org_idx" ON "inbox"."channels" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "contacts_org_idx" ON "inbox"."contacts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "contacts_org_phone_idx" ON "inbox"."contacts" USING btree ("org_id","phone_e164");--> statement-breakpoint
CREATE INDEX "contacts_org_customer_idx" ON "inbox"."contacts" USING btree ("org_id","customer_id");--> statement-breakpoint
CREATE INDEX "conversations_org_idx" ON "inbox"."conversations" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_org_identity_idx" ON "inbox"."conversations" USING btree ("org_id","identity_id");--> statement-breakpoint
CREATE INDEX "conversations_org_last_idx" ON "inbox"."conversations" USING btree ("org_id","last_message_at");--> statement-breakpoint
CREATE INDEX "conversations_org_assignee_idx" ON "inbox"."conversations" USING btree ("org_id","assigned_to");--> statement-breakpoint
CREATE INDEX "conversations_org_contact_idx" ON "inbox"."conversations" USING btree ("org_id","contact_id");--> statement-breakpoint
CREATE INDEX "identities_org_idx" ON "inbox"."identities" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identities_org_channel_user_idx" ON "inbox"."identities" USING btree ("org_id","channel_id","external_user_id");--> statement-breakpoint
CREATE INDEX "identities_org_contact_idx" ON "inbox"."identities" USING btree ("org_id","contact_id");--> statement-breakpoint
CREATE INDEX "interests_org_idx" ON "inbox"."interests" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "interests_org_contact_product_idx" ON "inbox"."interests" USING btree ("org_id","contact_id","product_id");--> statement-breakpoint
CREATE INDEX "messages_org_idx" ON "inbox"."messages" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_org_provider_idx" ON "inbox"."messages" USING btree ("org_id","provider_message_id") WHERE "inbox"."messages"."provider_message_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_org_conversation_idx" ON "inbox"."messages" USING btree ("org_id","conversation_id","occurred_at");--> statement-breakpoint
CREATE INDEX "notes_org_idx" ON "inbox"."notes" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "notes_org_contact_idx" ON "inbox"."notes" USING btree ("org_id","contact_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_org_idx" ON "inbox"."settings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "webhook_events_org_idx" ON "inbox"."webhook_events" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_org_sha_idx" ON "inbox"."webhook_events" USING btree ("org_id","body_sha256");