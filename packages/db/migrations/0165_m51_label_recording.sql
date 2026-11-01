CREATE TABLE "packing"."recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"lot_no" integer NOT NULL,
	"video_required" boolean NOT NULL,
	"camera_id" uuid,
	"idle_ms" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"started_by" text NOT NULL,
	"stopped_at" timestamp with time zone,
	"stopped_by" text,
	"stop_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packing_recordings_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "packing_recordings_session_lot_key" UNIQUE("org_id","session_id","lot_no"),
	CONSTRAINT "packing_recordings_lot_no" CHECK ("packing"."recordings"."lot_no" between 1 and 20),
	CONSTRAINT "packing_recordings_idle" CHECK ("packing"."recordings"."idle_ms" between 3000 and 60000),
	CONSTRAINT "packing_recordings_stop" CHECK (("packing"."recordings"."stopped_at" is null and "packing"."recordings"."stopped_by" is null and "packing"."recordings"."stop_reason" is null)
       or ("packing"."recordings"."stopped_at" is not null and "packing"."recordings"."stop_reason" is not null
           and "packing"."recordings"."stopped_at" >= "packing"."recordings"."started_at"
           and "packing"."recordings"."stopped_at" <= "packing"."recordings"."started_at" + interval '15 minutes')),
	CONSTRAINT "packing_recordings_stop_reason" CHECK ("packing"."recordings"."stop_reason" is null or "packing"."recordings"."stop_reason" in ('label', 'closed', 'finished', 'received', 'timed_out')),
	CONSTRAINT "packing_recordings_stopped_by" CHECK ("packing"."recordings"."stop_reason" is null or ("packing"."recordings"."stop_reason" = 'timed_out') = ("packing"."recordings"."stopped_by" is null))
);
--> statement-breakpoint
ALTER TABLE "packing"."sessions" DROP CONSTRAINT "packing_sessions_org_order_key";--> statement-breakpoint
ALTER TABLE "packing"."scans" DROP CONSTRAINT "packing_scans_outcome";--> statement-breakpoint
ALTER TABLE "packing"."scans" DROP CONSTRAINT "packing_scans_sku_named";--> statement-breakpoint
ALTER TABLE "packing"."sessions" ADD COLUMN "kind" text DEFAULT 'pack' NOT NULL;--> statement-breakpoint
ALTER TABLE "packing"."settings" ADD COLUMN "idle_pause_ms" integer DEFAULT 10000 NOT NULL;--> statement-breakpoint
ALTER TABLE "packing"."videos" ADD COLUMN "recording_id" uuid;--> statement-breakpoint
ALTER TABLE "packing"."videos" ADD COLUMN "lot_no" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "packing"."recordings" ADD CONSTRAINT "recordings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."recordings" ADD CONSTRAINT "recordings_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."recordings" ADD CONSTRAINT "recordings_stopped_by_users_id_fk" FOREIGN KEY ("stopped_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."recordings" ADD CONSTRAINT "packing_recordings_org_id_session_id_fk" FOREIGN KEY ("org_id","session_id") REFERENCES "packing"."sessions"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."recordings" ADD CONSTRAINT "packing_recordings_org_id_camera_id_fk" FOREIGN KEY ("org_id","camera_id") REFERENCES "packing"."cameras"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "packing_recordings_org_idx" ON "packing"."recordings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "packing_recordings_camera_idx" ON "packing"."recordings" USING btree ("org_id","camera_id","started_at");--> statement-breakpoint
CREATE INDEX "packing_recordings_open_idx" ON "packing"."recordings" USING btree ("org_id","started_at") WHERE "packing"."recordings"."stopped_at" is null;--> statement-breakpoint
ALTER TABLE "packing"."videos" ADD CONSTRAINT "packing_videos_org_id_recording_id_fk" FOREIGN KEY ("org_id","recording_id") REFERENCES "packing"."recordings"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "packing_sessions_kind_started_idx" ON "packing"."sessions" USING btree ("org_id","kind","started_at");--> statement-breakpoint
CREATE INDEX "packing_videos_recording_idx" ON "packing"."videos" USING btree ("org_id","recording_id");--> statement-breakpoint
ALTER TABLE "packing"."sessions" ADD CONSTRAINT "packing_sessions_org_order_kind_key" UNIQUE("org_id","order_id","kind");--> statement-breakpoint
ALTER TABLE "packing"."scans" ADD CONSTRAINT "packing_scans_outcome" CHECK ("packing"."scans"."outcome" in ('accepted', 'removed', 'unknown_code', 'wrong_item', 'wrong_variant', 'over', 'label'));--> statement-breakpoint
ALTER TABLE "packing"."scans" ADD CONSTRAINT "packing_scans_sku_named" CHECK (("packing"."scans"."sku_id" is null) = ("packing"."scans"."outcome" in ('unknown_code', 'label')));--> statement-breakpoint
ALTER TABLE "packing"."sessions" ADD CONSTRAINT "packing_sessions_kind" CHECK ("packing"."sessions"."kind" in ('pack', 'return'));--> statement-breakpoint
ALTER TABLE "packing"."settings" ADD CONSTRAINT "packing_settings_idle_pause" CHECK ("packing"."settings"."idle_pause_ms" between 3000 and 60000);--> statement-breakpoint
ALTER TABLE "packing"."videos" ADD CONSTRAINT "packing_videos_lot_no" CHECK ("packing"."videos"."lot_no" between 1 and 20);