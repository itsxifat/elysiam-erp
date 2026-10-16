CREATE TABLE "packing"."handover_scans" (
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"lot_no" integer NOT NULL,
	"code" text NOT NULL,
	"scanned_by" text NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"terminal_id" uuid,
	CONSTRAINT "handover_scans_pkey" PRIMARY KEY("org_id","order_id","lot_no"),
	CONSTRAINT "handover_scans_lot_no" CHECK ("packing"."handover_scans"."lot_no" between 1 and 20),
	CONSTRAINT "handover_scans_code_length" CHECK (length("packing"."handover_scans"."code") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "packing"."label_orders" (
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_no" text DEFAULT '' NOT NULL,
	"consignment_no" text NOT NULL,
	"location_id" uuid,
	"booked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "label_orders_pkey" PRIMARY KEY("org_id","order_id"),
	CONSTRAINT "label_orders_consignment_length" CHECK (length("packing"."label_orders"."consignment_no") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "packing"."label_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"auto_print" boolean,
	"auto_slip" boolean DEFAULT false NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "packing"."lot_closures" (
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"lot_no" integer NOT NULL,
	"closed_by" text NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lot_closures_pkey" PRIMARY KEY("org_id","session_id","lot_no"),
	CONSTRAINT "lot_closures_lot_no" CHECK ("packing"."lot_closures"."lot_no" between 1 and 20)
);
--> statement-breakpoint
CREATE TABLE "packing"."order_lots" (
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"lot_count" integer NOT NULL,
	"set_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_lots_pkey" PRIMARY KEY("org_id","order_id"),
	CONSTRAINT "order_lots_count" CHECK ("packing"."order_lots"."lot_count" between 1 and 20)
);
--> statement-breakpoint
CREATE TABLE "packing"."session_cameras" (
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"camera_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packing_session_cameras_pkey" PRIMARY KEY("org_id","session_id","camera_id")
);
--> statement-breakpoint
CREATE TABLE "packing"."terminal_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"label" text NOT NULL,
	"token_sha256" text NOT NULL,
	"bound_by" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_user_id" text,
	"user_since" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packing_terminal_devices_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "packing_terminal_devices_label_length" CHECK (length("packing"."terminal_devices"."label") between 1 and 60),
	CONSTRAINT "packing_terminal_devices_token_shape" CHECK ("packing"."terminal_devices"."token_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "packing_terminal_devices_revocation_complete" CHECK (("packing"."terminal_devices"."revoked_at" is null) = ("packing"."terminal_devices"."revoked_by" is null))
);
--> statement-breakpoint
CREATE TABLE "packing"."terminal_members" (
	"org_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"assigned_by" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packing_terminal_members_pkey" PRIMARY KEY("org_id","terminal_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "packing"."terminals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"location_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packing_terminals_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "packing_terminals_kind" CHECK ("packing"."terminals"."kind" in ('packing', 'label')),
	CONSTRAINT "packing_terminals_name_length" CHECK (length("packing"."terminals"."name") between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "packing"."print_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid,
	"order_no" text DEFAULT '' NOT NULL,
	"document" text NOT NULL,
	"lot_no" integer DEFAULT 1 NOT NULL,
	"lot_count" integer DEFAULT 1 NOT NULL,
	"printer_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"requested_by" text,
	"copies" integer DEFAULT 1 NOT NULL,
	"consignment_no" text,
	"auto_key" text,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sending_at" timestamp with time zone,
	"printed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"device_id" uuid,
	"confirmed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "print_jobs_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "print_jobs_document" CHECK ("packing"."print_jobs"."document" in ('label', 'packing_slip', 'test')),
	CONSTRAINT "print_jobs_source" CHECK ("packing"."print_jobs"."source" in ('auto', 'manual', 'reprint', 'test')),
	CONSTRAINT "print_jobs_state" CHECK ("packing"."print_jobs"."state" in ('queued', 'sending', 'printed', 'failed', 'cancelled')),
	CONSTRAINT "print_jobs_lots" CHECK ("packing"."print_jobs"."lot_count" between 1 and 20 and "packing"."print_jobs"."lot_no" between 1 and "packing"."print_jobs"."lot_count"),
	CONSTRAINT "print_jobs_copies" CHECK ("packing"."print_jobs"."copies" between 1 and 5),
	CONSTRAINT "print_jobs_attempts" CHECK ("packing"."print_jobs"."attempts" between 0 and 20),
	CONSTRAINT "print_jobs_who" CHECK (("packing"."print_jobs"."source" = 'auto') = ("packing"."print_jobs"."requested_by" is null)
          and ("packing"."print_jobs"."source" = 'auto') = ("packing"."print_jobs"."auto_key" is not null)),
	CONSTRAINT "print_jobs_reason" CHECK (("packing"."print_jobs"."source" = 'reprint') = ("packing"."print_jobs"."reason" is not null)
          and ("packing"."print_jobs"."reason" is null or length("packing"."print_jobs"."reason") between 3 and 200)),
	CONSTRAINT "print_jobs_test" CHECK (("packing"."print_jobs"."source" = 'test') = ("packing"."print_jobs"."document" = 'test')
          and ("packing"."print_jobs"."document" = 'test') = ("packing"."print_jobs"."order_id" is null)),
	CONSTRAINT "print_jobs_progress" CHECK (("packing"."print_jobs"."state" = 'printed') = ("packing"."print_jobs"."printed_at" is not null)
          and ("packing"."print_jobs"."state" = 'cancelled') = ("packing"."print_jobs"."cancelled_at" is not null)),
	CONSTRAINT "print_jobs_error_length" CHECK ("packing"."print_jobs"."last_error" is null or length("packing"."print_jobs"."last_error") <= 300)
);
--> statement-breakpoint
CREATE TABLE "packing"."printers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"name" text NOT NULL,
	"connection" text NOT NULL,
	"language" text NOT NULL,
	"host" text,
	"port" integer,
	"ipp_path" text DEFAULT '/ipp/print' NOT NULL,
	"dpi" integer DEFAULT 203 NOT NULL,
	"medium" text NOT NULL,
	"width_um" integer NOT NULL,
	"height_um" integer NOT NULL,
	"documents" text[] DEFAULT '{}'::text[] NOT NULL,
	"copies" integer DEFAULT 1 NOT NULL,
	"username" text DEFAULT '' NOT NULL,
	"password_sealed" "bytea",
	"password_fingerprint" text,
	"key_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"status_detail" text,
	"status_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deleted_by" text,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "printers_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "printers_name_length" CHECK (length("packing"."printers"."name") between 1 and 60),
	CONSTRAINT "printers_connection" CHECK ("packing"."printers"."connection" in ('ipp', 'ipps', 'raw', 'browser')),
	CONSTRAINT "printers_language" CHECK ("packing"."printers"."language" in ('pdf', 'tspl', 'zpl', 'escpos')),
	CONSTRAINT "printers_connection_language" CHECK (("packing"."printers"."connection" = 'raw') = ("packing"."printers"."language" <> 'pdf')),
	CONSTRAINT "printers_host" CHECK (("packing"."printers"."connection" = 'browser') = ("packing"."printers"."host" is null)
          and ("packing"."printers"."host" is null or "packing"."printers"."host" ~ '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)[0-9.]+$')),
	CONSTRAINT "printers_port" CHECK ("packing"."printers"."port" is null or "packing"."printers"."port" between 1 and 65535),
	CONSTRAINT "printers_dpi" CHECK ("packing"."printers"."dpi" in (203, 300)),
	CONSTRAINT "printers_medium" CHECK ("packing"."printers"."medium" in ('4x6', '100x150', 'a5', 'a4', 'custom')),
	CONSTRAINT "printers_size" CHECK ("packing"."printers"."width_um" between 20000 and 330000 and "packing"."printers"."height_um" between 20000 and 1000000),
	CONSTRAINT "printers_documents" CHECK (cardinality("packing"."printers"."documents") >= 1 and "packing"."printers"."documents" <@ array['label', 'packing_slip']::text[]),
	CONSTRAINT "printers_copies" CHECK ("packing"."printers"."copies" between 1 and 5),
	CONSTRAINT "printers_password_complete" CHECK (("packing"."printers"."password_sealed" is null) = ("packing"."printers"."password_fingerprint" is null)
          and ("packing"."printers"."password_sealed" is null or ("packing"."printers"."key_id" is not null and "packing"."printers"."connection" = 'ipps'))),
	CONSTRAINT "printers_status" CHECK ("packing"."printers"."status" in ('unknown', 'online', 'offline', 'error')),
	CONSTRAINT "printers_deleted" CHECK (("packing"."printers"."deleted_at" is null) = ("packing"."printers"."deleted_by" is null)
          and ("packing"."printers"."deleted_at" is null or (not "packing"."printers"."enabled" and "packing"."printers"."password_sealed" is null)))
);
--> statement-breakpoint
ALTER TABLE "packing"."cameras" ADD COLUMN "terminal_id" uuid;--> statement-breakpoint
ALTER TABLE "packing"."scans" ADD COLUMN "lot_no" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "packing"."sessions" ADD COLUMN "terminal_id" uuid;--> statement-breakpoint
ALTER TABLE "packing"."handover_scans" ADD CONSTRAINT "handover_scans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."handover_scans" ADD CONSTRAINT "handover_scans_scanned_by_users_id_fk" FOREIGN KEY ("scanned_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."handover_scans" ADD CONSTRAINT "handover_scans_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."handover_scans" ADD CONSTRAINT "handover_scans_org_id_terminal_id_fk" FOREIGN KEY ("org_id","terminal_id") REFERENCES "packing"."terminals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."label_orders" ADD CONSTRAINT "label_orders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."label_orders" ADD CONSTRAINT "label_orders_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."label_settings" ADD CONSTRAINT "label_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."label_settings" ADD CONSTRAINT "label_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."lot_closures" ADD CONSTRAINT "lot_closures_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."lot_closures" ADD CONSTRAINT "lot_closures_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."lot_closures" ADD CONSTRAINT "lot_closures_org_id_session_id_fk" FOREIGN KEY ("org_id","session_id") REFERENCES "packing"."sessions"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."order_lots" ADD CONSTRAINT "order_lots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."order_lots" ADD CONSTRAINT "order_lots_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."order_lots" ADD CONSTRAINT "order_lots_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."session_cameras" ADD CONSTRAINT "session_cameras_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."session_cameras" ADD CONSTRAINT "packing_session_cameras_org_id_session_id_fk" FOREIGN KEY ("org_id","session_id") REFERENCES "packing"."sessions"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."session_cameras" ADD CONSTRAINT "packing_session_cameras_org_id_camera_id_fk" FOREIGN KEY ("org_id","camera_id") REFERENCES "packing"."cameras"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."terminal_devices" ADD CONSTRAINT "terminal_devices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."terminal_devices" ADD CONSTRAINT "terminal_devices_bound_by_users_id_fk" FOREIGN KEY ("bound_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."terminal_devices" ADD CONSTRAINT "terminal_devices_last_user_id_users_id_fk" FOREIGN KEY ("last_user_id") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."terminal_devices" ADD CONSTRAINT "terminal_devices_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."terminal_devices" ADD CONSTRAINT "packing_terminal_devices_org_id_terminal_id_fk" FOREIGN KEY ("org_id","terminal_id") REFERENCES "packing"."terminals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."terminal_members" ADD CONSTRAINT "terminal_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."terminal_members" ADD CONSTRAINT "terminal_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."terminal_members" ADD CONSTRAINT "terminal_members_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."terminal_members" ADD CONSTRAINT "packing_terminal_members_org_id_terminal_id_fk" FOREIGN KEY ("org_id","terminal_id") REFERENCES "packing"."terminals"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."terminals" ADD CONSTRAINT "terminals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."terminals" ADD CONSTRAINT "terminals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."terminals" ADD CONSTRAINT "terminals_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."terminals" ADD CONSTRAINT "packing_terminals_org_id_location_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "org"."locations"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."print_jobs" ADD CONSTRAINT "print_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."print_jobs" ADD CONSTRAINT "print_jobs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."print_jobs" ADD CONSTRAINT "print_jobs_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."print_jobs" ADD CONSTRAINT "print_jobs_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."print_jobs" ADD CONSTRAINT "print_jobs_org_id_printer_id_fk" FOREIGN KEY ("org_id","printer_id") REFERENCES "packing"."printers"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."print_jobs" ADD CONSTRAINT "print_jobs_org_id_terminal_id_fk" FOREIGN KEY ("org_id","terminal_id") REFERENCES "packing"."terminals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."print_jobs" ADD CONSTRAINT "print_jobs_org_id_device_id_fk" FOREIGN KEY ("org_id","device_id") REFERENCES "packing"."terminal_devices"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."printers" ADD CONSTRAINT "printers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."printers" ADD CONSTRAINT "printers_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."printers" ADD CONSTRAINT "printers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."printers" ADD CONSTRAINT "printers_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."printers" ADD CONSTRAINT "printers_org_id_terminal_id_fk" FOREIGN KEY ("org_id","terminal_id") REFERENCES "packing"."terminals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "handover_scans_org_scanned_idx" ON "packing"."handover_scans" USING btree ("org_id","scanned_at");--> statement-breakpoint
CREATE INDEX "label_orders_org_booked_idx" ON "packing"."label_orders" USING btree ("org_id","booked_at");--> statement-breakpoint
CREATE INDEX "label_settings_org_idx" ON "packing"."label_settings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "lot_closures_org_idx" ON "packing"."lot_closures" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "order_lots_org_idx" ON "packing"."order_lots" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "packing_session_cameras_org_idx" ON "packing"."session_cameras" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "packing_session_cameras_camera_idx" ON "packing"."session_cameras" USING btree ("org_id","camera_id");--> statement-breakpoint
CREATE UNIQUE INDEX "packing_terminal_devices_token_idx" ON "packing"."terminal_devices" USING btree ("token_sha256");--> statement-breakpoint
CREATE INDEX "packing_terminal_devices_org_idx" ON "packing"."terminal_devices" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "packing_terminal_devices_terminal_idx" ON "packing"."terminal_devices" USING btree ("org_id","terminal_id");--> statement-breakpoint
CREATE INDEX "packing_terminal_members_org_idx" ON "packing"."terminal_members" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "packing_terminal_members_user_idx" ON "packing"."terminal_members" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "packing_terminals_org_name_idx" ON "packing"."terminals" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "packing_terminals_org_idx" ON "packing"."terminals" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "print_jobs_auto_key_idx" ON "packing"."print_jobs" USING btree ("org_id","auto_key");--> statement-breakpoint
CREATE INDEX "print_jobs_org_idx" ON "packing"."print_jobs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "print_jobs_org_created_idx" ON "packing"."print_jobs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "print_jobs_order_idx" ON "packing"."print_jobs" USING btree ("org_id","order_id","document","lot_no");--> statement-breakpoint
CREATE INDEX "print_jobs_terminal_state_idx" ON "packing"."print_jobs" USING btree ("org_id","terminal_id","state");--> statement-breakpoint
CREATE INDEX "print_jobs_printer_state_idx" ON "packing"."print_jobs" USING btree ("org_id","printer_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "printers_org_name_live_idx" ON "packing"."printers" USING btree ("org_id","name") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "printers_org_idx" ON "packing"."printers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "printers_terminal_idx" ON "packing"."printers" USING btree ("org_id","terminal_id");--> statement-breakpoint
ALTER TABLE "packing"."cameras" ADD CONSTRAINT "packing_cameras_org_id_terminal_id_fk" FOREIGN KEY ("org_id","terminal_id") REFERENCES "packing"."terminals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing"."sessions" ADD CONSTRAINT "packing_sessions_org_id_terminal_id_fk" FOREIGN KEY ("org_id","terminal_id") REFERENCES "packing"."terminals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "packing_sessions_terminal_idx" ON "packing"."sessions" USING btree ("org_id","terminal_id","completed_at");--> statement-breakpoint
ALTER TABLE "packing"."scans" ADD CONSTRAINT "packing_scans_lot_no" CHECK ("packing"."scans"."lot_no" between 1 and 20);