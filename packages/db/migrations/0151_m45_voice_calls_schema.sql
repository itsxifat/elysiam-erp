CREATE TABLE "inbox"."calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"provider_call_id" text NOT NULL,
	"direction" text DEFAULT 'inbound' NOT NULL,
	"status" text DEFAULT 'ringing' NOT NULL,
	"offer_sdp" text,
	"rang_user_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"answered_by" text,
	"declined_by" text,
	"started_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"end_reason" text,
	"callback_needed" boolean DEFAULT false NOT NULL,
	"callback_done_by" text,
	"callback_done_at" timestamp with time zone,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calls_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "calls_direction" CHECK ("inbox"."calls"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "calls_status" CHECK ("inbox"."calls"."status" in ('ringing', 'answering', 'connected', 'missed', 'declined', 'completed', 'failed')),
	CONSTRAINT "calls_provider_id" CHECK (char_length("inbox"."calls"."provider_call_id") between 1 and 256),
	CONSTRAINT "calls_offer_sdp" CHECK (char_length("inbox"."calls"."offer_sdp") <= 16000),
	CONSTRAINT "calls_rang" CHECK (cardinality("inbox"."calls"."rang_user_ids") <= 100),
	CONSTRAINT "calls_duration" CHECK ("inbox"."calls"."duration_seconds" is null or "inbox"."calls"."duration_seconds" >= 0),
	CONSTRAINT "calls_end_reason" CHECK (char_length("inbox"."calls"."end_reason") <= 40),
	CONSTRAINT "calls_answering_has_person" CHECK ("inbox"."calls"."status" not in ('answering', 'connected') or "inbox"."calls"."answered_by" is not null),
	CONSTRAINT "calls_callback_done_whole" CHECK (("inbox"."calls"."callback_done_by" is null) = ("inbox"."calls"."callback_done_at" is null))
);
--> statement-breakpoint
CREATE TABLE "inbox"."media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"direction" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"file_id" uuid,
	"mime" text,
	"size_bytes" integer,
	"duration_ms" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "media_kind" CHECK ("inbox"."media"."kind" in ('audio', 'image')),
	CONSTRAINT "media_direction" CHECK ("inbox"."media"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "media_status" CHECK ("inbox"."media"."status" in ('pending', 'stored', 'failed', 'expired')),
	CONSTRAINT "media_position" CHECK ("inbox"."media"."position" between 0 and 9),
	CONSTRAINT "media_stored_has_file" CHECK (("inbox"."media"."status" = 'stored') = ("inbox"."media"."file_id" is not null)),
	CONSTRAINT "media_duration" CHECK ("inbox"."media"."duration_ms" is null or "inbox"."media"."duration_ms" between 0 and 600000),
	CONSTRAINT "media_error_code" CHECK (char_length("inbox"."media"."error_code") <= 40)
);
--> statement-breakpoint
ALTER TABLE "inbox"."calls" ADD CONSTRAINT "calls_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."calls" ADD CONSTRAINT "calls_answered_by_users_id_fk" FOREIGN KEY ("answered_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."calls" ADD CONSTRAINT "calls_declined_by_users_id_fk" FOREIGN KEY ("declined_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."calls" ADD CONSTRAINT "calls_callback_done_by_users_id_fk" FOREIGN KEY ("callback_done_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."calls" ADD CONSTRAINT "calls_org_id_conversation_id_fk" FOREIGN KEY ("org_id","conversation_id") REFERENCES "inbox"."conversations"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."calls" ADD CONSTRAINT "calls_org_id_channel_id_fk" FOREIGN KEY ("org_id","channel_id") REFERENCES "inbox"."channels"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."calls" ADD CONSTRAINT "calls_org_id_message_id_fk" FOREIGN KEY ("org_id","message_id") REFERENCES "inbox"."messages"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."media" ADD CONSTRAINT "media_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."media" ADD CONSTRAINT "media_org_id_message_id_fk" FOREIGN KEY ("org_id","message_id") REFERENCES "inbox"."messages"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."media" ADD CONSTRAINT "media_org_id_conversation_id_fk" FOREIGN KEY ("org_id","conversation_id") REFERENCES "inbox"."conversations"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."media" ADD CONSTRAINT "media_org_id_file_id_fk" FOREIGN KEY ("org_id","file_id") REFERENCES "files"."objects"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calls_org_idx" ON "inbox"."calls" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calls_org_provider_idx" ON "inbox"."calls" USING btree ("org_id","provider_call_id");--> statement-breakpoint
CREATE INDEX "calls_org_conversation_idx" ON "inbox"."calls" USING btree ("org_id","conversation_id","started_at");--> statement-breakpoint
CREATE INDEX "calls_org_live_idx" ON "inbox"."calls" USING btree ("org_id","status") WHERE "inbox"."calls"."status" in ('ringing', 'answering', 'connected');--> statement-breakpoint
CREATE INDEX "media_org_idx" ON "inbox"."media" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_org_message_position_idx" ON "inbox"."media" USING btree ("org_id","message_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "media_org_file_idx" ON "inbox"."media" USING btree ("org_id","file_id");--> statement-breakpoint
CREATE INDEX "media_org_conversation_idx" ON "inbox"."media" USING btree ("org_id","conversation_id");--> statement-breakpoint
CREATE INDEX "media_org_occurred_idx" ON "inbox"."media" USING btree ("org_id","occurred_at");