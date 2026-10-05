CREATE TABLE "iam"."owner_link_uses" (
	"jti" text PRIMARY KEY NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "iam"."sessions" ADD COLUMN "owner_link" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "iam"."users" ADD COLUMN "is_owner" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "owner_link_uses_used_at_idx" ON "iam"."owner_link_uses" USING btree ("used_at");