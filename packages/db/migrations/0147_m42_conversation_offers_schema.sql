CREATE TABLE "inbox"."conversation_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'offered' NOT NULL,
	"offered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_offers_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "conversation_offers_status" CHECK ("inbox"."conversation_offers"."status" in ('offered', 'accepted', 'declined', 'expired', 'withdrawn')),
	CONSTRAINT "conversation_offers_answered" CHECK (("inbox"."conversation_offers"."status" = 'offered') = ("inbox"."conversation_offers"."responded_at" is null)),
	CONSTRAINT "conversation_offers_expiry" CHECK ("inbox"."conversation_offers"."expires_at" > "inbox"."conversation_offers"."offered_at")
);
--> statement-breakpoint
ALTER TABLE "inbox"."conversation_offers" ADD CONSTRAINT "conversation_offers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversation_offers" ADD CONSTRAINT "conversation_offers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversation_offers" ADD CONSTRAINT "conversation_offers_org_id_conversation_id_fk" FOREIGN KEY ("org_id","conversation_id") REFERENCES "inbox"."conversations"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_offers_org_idx" ON "inbox"."conversation_offers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "conversation_offers_org_conversation_idx" ON "inbox"."conversation_offers" USING btree ("org_id","conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_offers_org_user_idx" ON "inbox"."conversation_offers" USING btree ("org_id","user_id","offered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_offers_live_conversation_idx" ON "inbox"."conversation_offers" USING btree ("org_id","conversation_id") WHERE "inbox"."conversation_offers"."status" = 'offered';--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_offers_live_user_idx" ON "inbox"."conversation_offers" USING btree ("org_id","user_id") WHERE "inbox"."conversation_offers"."status" = 'offered';