CREATE TABLE "inbox"."saved_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"shortcut" text NOT NULL,
	"body" text NOT NULL,
	"category" text,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_replies_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "saved_replies_title" CHECK (char_length("inbox"."saved_replies"."title") between 1 and 80),
	CONSTRAINT "saved_replies_shortcut" CHECK ("inbox"."saved_replies"."shortcut" ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
	CONSTRAINT "saved_replies_body" CHECK (char_length("inbox"."saved_replies"."body") between 1 and 1000),
	CONSTRAINT "saved_replies_category" CHECK (char_length("inbox"."saved_replies"."category") between 1 and 40),
	CONSTRAINT "saved_replies_usage" CHECK ("inbox"."saved_replies"."usage_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "inbox"."contacts" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "inbox"."contacts" ADD COLUMN "handle" text;--> statement-breakpoint
ALTER TABLE "inbox"."contacts" ADD COLUMN "profile_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbox"."saved_replies" ADD CONSTRAINT "saved_replies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."saved_replies" ADD CONSTRAINT "saved_replies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_replies_org_idx" ON "inbox"."saved_replies" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_replies_org_shortcut_idx" ON "inbox"."saved_replies" USING btree ("org_id","shortcut");--> statement-breakpoint
ALTER TABLE "inbox"."contacts" ADD CONSTRAINT "contacts_avatar_url" CHECK ("inbox"."contacts"."avatar_url" is null or (char_length("inbox"."contacts"."avatar_url") <= 2048 and "inbox"."contacts"."avatar_url" like 'https://%'));--> statement-breakpoint
ALTER TABLE "inbox"."contacts" ADD CONSTRAINT "contacts_handle" CHECK (char_length("inbox"."contacts"."handle") <= 64);