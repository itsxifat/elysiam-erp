CREATE TABLE "packing"."cameras" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rtsp_url" text NOT NULL,
	"username" text DEFAULT '' NOT NULL,
	"password_sealed" "bytea",
	"password_fingerprint" text,
	"key_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_segment_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_at" timestamp with time zone,
	"status_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packing_cameras_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "packing_cameras_org_name_key" UNIQUE("org_id","name"),
	CONSTRAINT "packing_cameras_name_length" CHECK (length("packing"."cameras"."name") between 1 and 60),
	CONSTRAINT "packing_cameras_rtsp_url" CHECK ("packing"."cameras"."rtsp_url" ~* '^rtsp://[^/@[:space:]]+(/[^[:space:]]*)?$' and length("packing"."cameras"."rtsp_url") <= 500),
	CONSTRAINT "packing_cameras_username" CHECK (length("packing"."cameras"."username") <= 64 and position(':' in "packing"."cameras"."username") = 0),
	CONSTRAINT "packing_cameras_password_complete" CHECK (("packing"."cameras"."password_sealed" is null) = ("packing"."cameras"."password_fingerprint" is null)
          and ("packing"."cameras"."password_sealed" is null or "packing"."cameras"."key_id" is not null)),
	CONSTRAINT "packing_cameras_error_code" CHECK ("packing"."cameras"."last_error_code" is null or "packing"."cameras"."last_error_code" ~ '^[a-z_]{1,40}$')
);
--> statement-breakpoint
ALTER TABLE "packing"."sessions" ADD COLUMN "camera_id" uuid;--> statement-breakpoint
ALTER TABLE "packing"."sessions" ADD COLUMN "recording_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "packing"."sessions" ADD COLUMN "recording_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "packing"."sessions" ADD COLUMN "recording_by" text;--> statement-breakpoint
ALTER TABLE "packing"."videos" ADD COLUMN "source" text DEFAULT 'browser' NOT NULL;--> statement-breakpoint
ALTER TABLE "packing"."videos" ADD COLUMN "camera_id" uuid;--> statement-breakpoint
ALTER TABLE "packing"."cameras" ADD CONSTRAINT "cameras_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."cameras" ADD CONSTRAINT "cameras_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."cameras" ADD CONSTRAINT "cameras_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "packing_cameras_org_idx" ON "packing"."cameras" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "packing"."sessions" ADD CONSTRAINT "sessions_recording_by_users_id_fk" FOREIGN KEY ("recording_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."sessions" ADD CONSTRAINT "packing_sessions_org_id_camera_id_fk" FOREIGN KEY ("org_id","camera_id") REFERENCES "packing"."cameras"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."videos" ADD CONSTRAINT "packing_videos_org_id_camera_id_fk" FOREIGN KEY ("org_id","camera_id") REFERENCES "packing"."cameras"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "packing_sessions_camera_window_idx" ON "packing"."sessions" USING btree ("org_id","camera_id","recording_from");--> statement-breakpoint
ALTER TABLE "packing"."sessions" ADD CONSTRAINT "packing_sessions_recording_camera" CHECK ("packing"."sessions"."recording_from" is null or "packing"."sessions"."camera_id" is not null);--> statement-breakpoint
ALTER TABLE "packing"."sessions" ADD CONSTRAINT "packing_sessions_recording_by" CHECK (("packing"."sessions"."recording_from" is null) = ("packing"."sessions"."recording_by" is null));--> statement-breakpoint
ALTER TABLE "packing"."sessions" ADD CONSTRAINT "packing_sessions_recording_window" CHECK ("packing"."sessions"."recording_to" is null
          or ("packing"."sessions"."recording_from" is not null
              and "packing"."sessions"."recording_to" >= "packing"."sessions"."recording_from"
              and "packing"."sessions"."recording_to" <= "packing"."sessions"."recording_from" + interval '15 minutes'));--> statement-breakpoint
ALTER TABLE "packing"."videos" ADD CONSTRAINT "packing_videos_source" CHECK ("packing"."videos"."source" in ('browser', 'camera'));--> statement-breakpoint
ALTER TABLE "packing"."videos" ADD CONSTRAINT "packing_videos_source_camera" CHECK (("packing"."videos"."source" = 'camera') = ("packing"."videos"."camera_id" is not null));