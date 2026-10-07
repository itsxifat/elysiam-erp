CREATE TABLE "packing"."scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"scan_id" uuid NOT NULL,
	"code" text NOT NULL,
	"sku_id" uuid,
	"outcome" text NOT NULL,
	"scanned_by" text NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packing_scans_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "packing_scans_session_scan_key" UNIQUE("org_id","session_id","scan_id"),
	CONSTRAINT "packing_scans_outcome" CHECK ("packing"."scans"."outcome" in ('accepted', 'removed', 'unknown_code', 'wrong_item', 'wrong_variant', 'over')),
	CONSTRAINT "packing_scans_sku_named" CHECK (("packing"."scans"."sku_id" is null) = ("packing"."scans"."outcome" = 'unknown_code')),
	CONSTRAINT "packing_scans_code_length" CHECK (length("packing"."scans"."code") <= 120)
);
--> statement-breakpoint
CREATE TABLE "packing"."sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_no" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"video_required" boolean NOT NULL,
	"started_by" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_by" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packing_sessions_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "packing_sessions_org_order_key" UNIQUE("org_id","order_id"),
	CONSTRAINT "packing_sessions_status" CHECK ("packing"."sessions"."status" in ('open', 'completed')),
	CONSTRAINT "packing_sessions_completion" CHECK (("packing"."sessions"."status" = 'completed') = ("packing"."sessions"."completed_at" is not null and "packing"."sessions"."completed_by" is not null)),
	CONSTRAINT "packing_sessions_order_no_shape" CHECK (length("packing"."sessions"."order_no") between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "packing"."settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"video_enabled" boolean DEFAULT true NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "packing"."videos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"part" integer NOT NULL,
	"recorded_by" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"mime" text NOT NULL,
	"file_id" uuid,
	"duration_ms" integer,
	"size_bytes" bigint,
	"uploaded_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deleted_reason" text,
	"deleted_file_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packing_videos_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "packing_videos_session_part_key" UNIQUE("org_id","session_id","part"),
	CONSTRAINT "packing_videos_part" CHECK ("packing"."videos"."part" between 1 and 99),
	CONSTRAINT "packing_videos_mime" CHECK ("packing"."videos"."mime" in ('video/webm', 'video/mp4')),
	CONSTRAINT "packing_videos_upload_complete" CHECK (("packing"."videos"."file_id" is null or ("packing"."videos"."uploaded_at" is not null and "packing"."videos"."duration_ms" is not null and "packing"."videos"."size_bytes" is not null))),
	CONSTRAINT "packing_videos_duration" CHECK ("packing"."videos"."duration_ms" is null or "packing"."videos"."duration_ms" between 0 and 3600000),
	CONSTRAINT "packing_videos_deletion_complete" CHECK (("packing"."videos"."deleted_at" is null and "packing"."videos"."deleted_reason" is null and "packing"."videos"."deleted_file_id" is null)
       or ("packing"."videos"."deleted_at" is not null and "packing"."videos"."file_id" is null and "packing"."videos"."deleted_file_id" is not null
           and "packing"."videos"."deleted_reason" in ('delivered', 'partially_delivered', 'returned', 'cancelled', 'exchange')))
);
--> statement-breakpoint
ALTER TABLE "packing"."scans" ADD CONSTRAINT "scans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."scans" ADD CONSTRAINT "scans_scanned_by_users_id_fk" FOREIGN KEY ("scanned_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."scans" ADD CONSTRAINT "packing_scans_org_id_session_id_fk" FOREIGN KEY ("org_id","session_id") REFERENCES "packing"."sessions"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."scans" ADD CONSTRAINT "packing_scans_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."sessions" ADD CONSTRAINT "sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."sessions" ADD CONSTRAINT "sessions_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."sessions" ADD CONSTRAINT "sessions_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."sessions" ADD CONSTRAINT "packing_sessions_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."settings" ADD CONSTRAINT "settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."videos" ADD CONSTRAINT "videos_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."videos" ADD CONSTRAINT "videos_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."videos" ADD CONSTRAINT "packing_videos_org_id_session_id_fk" FOREIGN KEY ("org_id","session_id") REFERENCES "packing"."sessions"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."videos" ADD CONSTRAINT "packing_videos_org_id_file_id_fk" FOREIGN KEY ("org_id","file_id") REFERENCES "files"."objects"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "packing_scans_org_idx" ON "packing"."scans" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "packing_scans_session_idx" ON "packing"."scans" USING btree ("org_id","session_id","scanned_at");--> statement-breakpoint
CREATE INDEX "packing_sessions_org_idx" ON "packing"."sessions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "packing_sessions_org_started_idx" ON "packing"."sessions" USING btree ("org_id","started_at");--> statement-breakpoint
CREATE INDEX "packing_settings_org_idx" ON "packing"."settings" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "packing_videos_file_idx" ON "packing"."videos" USING btree ("org_id","file_id");--> statement-breakpoint
CREATE INDEX "packing_videos_org_idx" ON "packing"."videos" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "packing_videos_session_idx" ON "packing"."videos" USING btree ("org_id","session_id");