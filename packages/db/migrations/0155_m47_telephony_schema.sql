CREATE SCHEMA "telephony";
--> statement-breakpoint
CREATE TABLE "telephony"."calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"envo_call_id" text,
	"first_seen" text NOT NULL,
	"direction" text DEFAULT 'unknown' NOT NULL,
	"status" text NOT NULL,
	"from_number" text,
	"to_number" text,
	"customer_phone_e164" text,
	"extension" text,
	"user_id" text,
	"customer_id" uuid,
	"customer_name" text,
	"order_id" uuid,
	"order_no" text,
	"order_owner_user_id" text,
	"answered" boolean DEFAULT false NOT NULL,
	"disposition" text,
	"talk_seconds" integer,
	"duration_seconds" integer,
	"occurred_at" timestamp with time zone NOT NULL,
	"requested_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"error_code" text,
	"error_detail" text,
	"recording_status" text DEFAULT 'none' NOT NULL,
	"recording_url" text,
	"recording_file_id" uuid,
	"recording_bytes" integer,
	"recording_attempts" integer DEFAULT 0 NOT NULL,
	"recording_error" text,
	"outcome_attempt_id" uuid,
	"outcome" text,
	"last_event" text,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calls_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "calls_first_seen" CHECK ("telephony"."calls"."first_seen" in ('click', 'webhook', 'sync')),
	CONSTRAINT "calls_direction" CHECK ("telephony"."calls"."direction" in ('inbound', 'outbound', 'internal', 'unknown')),
	CONSTRAINT "calls_status" CHECK ("telephony"."calls"."status" in ('requested', 'dialing', 'failed', 'ringing', 'answered', 'ended')),
	CONSTRAINT "calls_envo_call_id" CHECK ("telephony"."calls"."envo_call_id" is null or "telephony"."calls"."envo_call_id" ~ '^[0-9]{1,20}([.][0-9]{1,10})?$'),
	CONSTRAINT "calls_click_or_envo" CHECK ("telephony"."calls"."first_seen" = 'click' or "telephony"."calls"."envo_call_id" is not null),
	CONSTRAINT "calls_numbers" CHECK (char_length("telephony"."calls"."from_number") <= 40 and char_length("telephony"."calls"."to_number") <= 40),
	CONSTRAINT "calls_customer_phone" CHECK ("telephony"."calls"."customer_phone_e164" is null or "telephony"."calls"."customer_phone_e164" ~ '^[+]8801[13-9][0-9]{8}$'),
	CONSTRAINT "calls_extension" CHECK ("telephony"."calls"."extension" is null or "telephony"."calls"."extension" ~ '^[0-9]{2,8}$'),
	CONSTRAINT "calls_disposition" CHECK ("telephony"."calls"."disposition" is null or "telephony"."calls"."disposition" in ('answered', 'no_answer', 'busy', 'failed', 'congestion', 'unknown')),
	CONSTRAINT "calls_seconds" CHECK (("telephony"."calls"."talk_seconds" is null or "telephony"."calls"."talk_seconds" >= 0) and ("telephony"."calls"."duration_seconds" is null or "telephony"."calls"."duration_seconds" >= 0)),
	CONSTRAINT "calls_error_code" CHECK (char_length("telephony"."calls"."error_code") <= 40),
	CONSTRAINT "calls_error_detail" CHECK (char_length("telephony"."calls"."error_detail") <= 300),
	CONSTRAINT "calls_recording_status" CHECK ("telephony"."calls"."recording_status" in ('none', 'pending', 'stored', 'failed', 'expired')),
	CONSTRAINT "calls_recording_stored_has_file" CHECK (("telephony"."calls"."recording_status" = 'stored') = ("telephony"."calls"."recording_file_id" is not null)),
	CONSTRAINT "calls_recording_url" CHECK (char_length("telephony"."calls"."recording_url") <= 500),
	CONSTRAINT "calls_recording_error" CHECK (char_length("telephony"."calls"."recording_error") <= 40),
	CONSTRAINT "calls_outcome" CHECK ("telephony"."calls"."outcome" is null or "telephony"."calls"."outcome" in ('reached', 'no_answer', 'busy', 'wrong_number', 'call_back')),
	CONSTRAINT "calls_outcome_whole" CHECK (("telephony"."calls"."outcome" is null) = ("telephony"."calls"."outcome_attempt_id" is null)),
	CONSTRAINT "calls_last_event" CHECK (char_length("telephony"."calls"."last_event") <= 20),
	CONSTRAINT "calls_customer_name" CHECK (char_length("telephony"."calls"."customer_name") <= 120),
	CONSTRAINT "calls_order_no" CHECK (char_length("telephony"."calls"."order_no") <= 40),
	CONSTRAINT "calls_order_whole" CHECK (("telephony"."calls"."order_id" is null) = ("telephony"."calls"."order_no" is null))
);
--> statement-breakpoint
CREATE TABLE "telephony"."connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"api_key_sealed" "bytea",
	"api_key_key_id" text,
	"api_key_fingerprint" text,
	"webhook_secret_sealed" "bytea",
	"webhook_secret_key_id" text,
	"webhook_secret_fingerprint" text,
	"recording_retention_days" integer DEFAULT 365 NOT NULL,
	"envo_server_id" integer,
	"envo_server_name" text,
	"last_tested_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_test_error" text,
	"last_webhook_at" timestamp with time zone,
	"last_webhook_event" text,
	"last_signature_failure_at" timestamp with time zone,
	"last_signature_failure_reason" text,
	"sync_cursor" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_sync_error" text,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "connections_name" CHECK (char_length("telephony"."connections"."name") between 1 and 60),
	CONSTRAINT "connections_base_url" CHECK (char_length("telephony"."connections"."base_url") <= 200 and "telephony"."connections"."base_url" ~ '^https?://[^/?#@ ]+$'),
	CONSTRAINT "connections_api_key_whole" CHECK (("telephony"."connections"."api_key_sealed" is null) = ("telephony"."connections"."api_key_fingerprint" is null)),
	CONSTRAINT "connections_webhook_secret_whole" CHECK (("telephony"."connections"."webhook_secret_sealed" is null) = ("telephony"."connections"."webhook_secret_fingerprint" is null)),
	CONSTRAINT "connections_retention" CHECK ("telephony"."connections"."recording_retention_days" between 30 and 3650),
	CONSTRAINT "connections_server_name" CHECK (char_length("telephony"."connections"."envo_server_name") <= 80),
	CONSTRAINT "connections_test_error" CHECK (char_length("telephony"."connections"."last_test_error") <= 300),
	CONSTRAINT "connections_webhook_event" CHECK (char_length("telephony"."connections"."last_webhook_event") <= 40),
	CONSTRAINT "connections_signature_reason" CHECK (char_length("telephony"."connections"."last_signature_failure_reason") <= 40),
	CONSTRAINT "connections_sync_error" CHECK (char_length("telephony"."connections"."last_sync_error") <= 300)
);
--> statement-breakpoint
CREATE TABLE "telephony"."extension_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"extension" text NOT NULL,
	"user_id" text NOT NULL,
	"assigned_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_assignments_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "extension_assignments_extension" CHECK ("telephony"."extension_assignments"."extension" ~ '^[0-9]{2,8}$')
);
--> statement-breakpoint
CREATE TABLE "telephony"."webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"event" text NOT NULL,
	"envo_call_id" text NOT NULL,
	"delivery_id" text,
	"body" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "webhook_events_event" CHECK ("telephony"."webhook_events"."event" in ('call.started', 'call.answered', 'call.ended')),
	CONSTRAINT "webhook_events_envo_call_id" CHECK ("telephony"."webhook_events"."envo_call_id" ~ '^[0-9]{1,20}([.][0-9]{1,10})?$'),
	CONSTRAINT "webhook_events_delivery_id" CHECK (char_length("telephony"."webhook_events"."delivery_id") <= 64),
	CONSTRAINT "webhook_events_outcome" CHECK (char_length("telephony"."webhook_events"."outcome") <= 40)
);
--> statement-breakpoint
ALTER TABLE "telephony"."calls" ADD CONSTRAINT "calls_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telephony"."calls" ADD CONSTRAINT "calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telephony"."calls" ADD CONSTRAINT "calls_order_owner_user_id_users_id_fk" FOREIGN KEY ("order_owner_user_id") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telephony"."calls" ADD CONSTRAINT "calls_org_id_connection_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "telephony"."connections"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telephony"."calls" ADD CONSTRAINT "calls_org_id_customer_id_fk" FOREIGN KEY ("org_id","customer_id") REFERENCES "sales"."customers"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telephony"."calls" ADD CONSTRAINT "calls_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telephony"."calls" ADD CONSTRAINT "calls_org_id_recording_file_id_fk" FOREIGN KEY ("org_id","recording_file_id") REFERENCES "files"."objects"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telephony"."calls" ADD CONSTRAINT "calls_org_id_outcome_attempt_id_fk" FOREIGN KEY ("org_id","outcome_attempt_id") REFERENCES "sales"."call_attempts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telephony"."connections" ADD CONSTRAINT "connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telephony"."extension_assignments" ADD CONSTRAINT "extension_assignments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telephony"."extension_assignments" ADD CONSTRAINT "extension_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telephony"."extension_assignments" ADD CONSTRAINT "extension_assignments_org_id_connection_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "telephony"."connections"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telephony"."webhook_events" ADD CONSTRAINT "webhook_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telephony"."webhook_events" ADD CONSTRAINT "webhook_events_org_id_connection_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "telephony"."connections"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calls_org_idx" ON "telephony"."calls" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calls_org_envo_idx" ON "telephony"."calls" USING btree ("org_id","connection_id","envo_call_id") WHERE "telephony"."calls"."envo_call_id" is not null;--> statement-breakpoint
CREATE INDEX "calls_org_occurred_idx" ON "telephony"."calls" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "calls_org_user_idx" ON "telephony"."calls" USING btree ("org_id","user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "calls_org_order_idx" ON "telephony"."calls" USING btree ("org_id","order_id");--> statement-breakpoint
CREATE INDEX "calls_org_customer_idx" ON "telephony"."calls" USING btree ("org_id","customer_id");--> statement-breakpoint
CREATE INDEX "calls_org_phone_idx" ON "telephony"."calls" USING btree ("org_id","customer_phone_e164");--> statement-breakpoint
CREATE INDEX "calls_org_pending_clicks_idx" ON "telephony"."calls" USING btree ("org_id","connection_id","requested_at") WHERE "telephony"."calls"."envo_call_id" is null and "telephony"."calls"."status" in ('requested', 'dialing');--> statement-breakpoint
CREATE INDEX "calls_org_recording_idx" ON "telephony"."calls" USING btree ("org_id","ended_at") WHERE "telephony"."calls"."recording_status" = 'stored';--> statement-breakpoint
CREATE INDEX "connections_org_idx" ON "telephony"."connections" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_org_name_idx" ON "telephony"."connections" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "extension_assignments_org_idx" ON "telephony"."extension_assignments" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "extension_assignments_extension_idx" ON "telephony"."extension_assignments" USING btree ("org_id","connection_id","extension");--> statement-breakpoint
CREATE UNIQUE INDEX "extension_assignments_user_idx" ON "telephony"."extension_assignments" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "webhook_events_org_idx" ON "telephony"."webhook_events" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_org_call_event_idx" ON "telephony"."webhook_events" USING btree ("org_id","connection_id","envo_call_id","event");--> statement-breakpoint
CREATE INDEX "webhook_events_org_unprocessed_idx" ON "telephony"."webhook_events" USING btree ("org_id","received_at") WHERE "telephony"."webhook_events"."processed_at" is null;