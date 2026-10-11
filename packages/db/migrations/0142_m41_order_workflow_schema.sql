CREATE SCHEMA "team";
--> statement-breakpoint
CREATE TABLE "sales"."call_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"call_back_at" timestamp with time zone,
	"note" text,
	"called_by" text NOT NULL,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_attempts_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "call_attempts_outcome" CHECK ("sales"."call_attempts"."outcome" in ('reached', 'no_answer', 'busy', 'wrong_number', 'call_back')),
	CONSTRAINT "call_attempts_call_back" CHECK (("sales"."call_attempts"."outcome" = 'call_back') = ("sales"."call_attempts"."call_back_at" is not null)),
	CONSTRAINT "call_attempts_note_length" CHECK ("sales"."call_attempts"."note" is null or length("sales"."call_attempts"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "sales"."order_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'offered' NOT NULL,
	"offered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_offers_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "order_offers_status" CHECK ("sales"."order_offers"."status" in ('offered', 'accepted', 'declined', 'expired', 'withdrawn')),
	CONSTRAINT "order_offers_answered" CHECK (("sales"."order_offers"."status" = 'offered') = ("sales"."order_offers"."responded_at" is null)),
	CONSTRAINT "order_offers_expiry" CHECK ("sales"."order_offers"."expires_at" > "sales"."order_offers"."offered_at")
);
--> statement-breakpoint
CREATE TABLE "sales"."workflow_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"auto_assign" boolean DEFAULT false NOT NULL,
	"offer_seconds" integer DEFAULT 45 NOT NULL,
	"max_open" integer DEFAULT 25 NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_settings_offer_seconds" CHECK ("sales"."workflow_settings"."offer_seconds" between 15 and 300),
	CONSTRAINT "workflow_settings_max_open" CHECK ("sales"."workflow_settings"."max_open" between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "team"."desk_profiles" (
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"work_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"hub_location_id" uuid,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "desk_profiles_pkey" PRIMARY KEY("org_id","user_id"),
	CONSTRAINT "desk_profiles_work_types" CHECK ("team"."desk_profiles"."work_types" <@ array['orders', 'messages']::text[])
);
--> statement-breakpoint
CREATE TABLE "team"."presence" (
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_active_at" timestamp with time zone,
	"state" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"paused_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presence_pkey" PRIMARY KEY("org_id","user_id"),
	CONSTRAINT "presence_state" CHECK ("team"."presence"."state" in ('active', 'idle')),
	CONSTRAINT "presence_paused_at" CHECK (("team"."presence"."paused") = ("team"."presence"."paused_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD COLUMN "call_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD COLUMN "last_call_outcome" text;--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD COLUMN "last_call_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD COLUMN "call_back_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD COLUMN "slip_printed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales"."call_attempts" ADD CONSTRAINT "call_attempts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."call_attempts" ADD CONSTRAINT "call_attempts_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."order_offers" ADD CONSTRAINT "order_offers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."order_offers" ADD CONSTRAINT "order_offers_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."workflow_settings" ADD CONSTRAINT "workflow_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team"."desk_profiles" ADD CONSTRAINT "desk_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team"."desk_profiles" ADD CONSTRAINT "desk_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team"."desk_profiles" ADD CONSTRAINT "desk_profiles_org_id_hub_location_id_fk" FOREIGN KEY ("org_id","hub_location_id") REFERENCES "org"."locations"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team"."presence" ADD CONSTRAINT "presence_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team"."presence" ADD CONSTRAINT "presence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "call_attempts_org_idx" ON "sales"."call_attempts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "call_attempts_org_order_idx" ON "sales"."call_attempts" USING btree ("org_id","order_id","called_at");--> statement-breakpoint
CREATE INDEX "order_offers_org_idx" ON "sales"."order_offers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "order_offers_org_order_idx" ON "sales"."order_offers" USING btree ("org_id","order_id");--> statement-breakpoint
CREATE INDEX "order_offers_org_user_idx" ON "sales"."order_offers" USING btree ("org_id","user_id","offered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_offers_live_order_idx" ON "sales"."order_offers" USING btree ("org_id","order_id") WHERE "sales"."order_offers"."status" = 'offered';--> statement-breakpoint
CREATE UNIQUE INDEX "order_offers_live_user_idx" ON "sales"."order_offers" USING btree ("org_id","user_id") WHERE "sales"."order_offers"."status" = 'offered';--> statement-breakpoint
CREATE INDEX "desk_profiles_org_idx" ON "team"."desk_profiles" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "presence_org_idx" ON "team"."presence" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "orders_org_call_back_idx" ON "sales"."orders" USING btree ("org_id","call_back_at") WHERE "sales"."orders"."call_back_at" is not null;--> statement-breakpoint
CREATE INDEX "orders_org_location_status_idx" ON "sales"."orders" USING btree ("org_id","location_id","status");--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_call_attempts_not_negative" CHECK ("sales"."orders"."call_attempts" >= 0);--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_last_call_outcome" CHECK ("sales"."orders"."last_call_outcome" is null or "sales"."orders"."last_call_outcome" in
          ('reached', 'no_answer', 'busy', 'wrong_number', 'call_back'));--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_call_back_needs_outcome" CHECK ("sales"."orders"."call_back_at" is null or "sales"."orders"."last_call_outcome" = 'call_back');