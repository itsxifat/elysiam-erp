CREATE SCHEMA "files";
--> statement-breakpoint
CREATE TYPE "files"."file_status" AS ENUM('pending', 'stored');--> statement-breakpoint
CREATE TYPE "files"."file_visibility" AS ENUM('private', 'public');--> statement-breakpoint
CREATE TABLE "files"."objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"driver" text NOT NULL,
	"visibility" "files"."file_visibility" DEFAULT 'private' NOT NULL,
	"status" "files"."file_status" DEFAULT 'pending' NOT NULL,
	"purpose" text NOT NULL,
	"owner_user_id" text,
	"mime" text NOT NULL,
	"size_bytes" bigint,
	"sha256" text,
	"original_name" text,
	"variants" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_objects_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "file_objects_storage_key_key" UNIQUE("storage_key"),
	CONSTRAINT "file_objects_key_matches_id" CHECK (position("files"."objects"."id"::text in "files"."objects"."storage_key") > 0),
	CONSTRAINT "file_objects_visibility_matches_prefix" CHECK (("files"."objects"."visibility" = 'private' and "files"."objects"."storage_key" like 'private/%')
       or ("files"."objects"."visibility" = 'public' and "files"."objects"."storage_key" like 'public/%')),
	CONSTRAINT "file_objects_driver_known" CHECK ("files"."objects"."driver" in ('local', 'r2')),
	CONSTRAINT "file_objects_stored_is_complete" CHECK (("files"."objects"."status" = 'pending' and "files"."objects"."sha256" is null and "files"."objects"."size_bytes" is null)
       or ("files"."objects"."status" = 'stored'
           and "files"."objects"."sha256" ~ '^[0-9a-f]{64}$'
           and "files"."objects"."size_bytes" is not null
           and "files"."objects"."size_bytes" > 0
           and "files"."objects"."size_bytes" <= 104857600))
);
--> statement-breakpoint
ALTER TABLE "files"."objects" ADD CONSTRAINT "objects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files"."objects" ADD CONSTRAINT "objects_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "iam"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_objects_org_idx" ON "files"."objects" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "file_objects_org_sha256_idx" ON "files"."objects" USING btree ("org_id","sha256");--> statement-breakpoint
CREATE INDEX "file_objects_org_purpose_idx" ON "files"."objects" USING btree ("org_id","purpose");
