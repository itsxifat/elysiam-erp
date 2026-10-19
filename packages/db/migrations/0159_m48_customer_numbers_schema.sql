CREATE TABLE "sales"."customer_phones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"phone_e164" text NOT NULL,
	"rank" integer NOT NULL,
	"kind" text DEFAULT 'mobile' NOT NULL,
	"relation" text DEFAULT 'own' NOT NULL,
	"note" text,
	"source" text NOT NULL,
	"added_by_user_id" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_by_user_id" text,
	"retire_reason" text,
	"retire_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_phones_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "customer_phones_phone_e164" CHECK ("sales"."customer_phones"."phone_e164" ~ '^\+8801[13456789][0-9]{8}$'),
	CONSTRAINT "customer_phones_rank" CHECK ("sales"."customer_phones"."rank" >= 1),
	CONSTRAINT "customer_phones_kind" CHECK ("sales"."customer_phones"."kind" in ('mobile', 'whatsapp', 'home', 'office', 'shop', 'other')),
	CONSTRAINT "customer_phones_relation" CHECK ("sales"."customer_phones"."relation" in ('own', 'household', 'relative', 'work', 'someone_else', 'other')),
	CONSTRAINT "customer_phones_source" CHECK ("sales"."customer_phones"."source" in ('staff', 'order', 'website', 'inbox', 'call', 'import')),
	CONSTRAINT "customer_phones_note" CHECK ("sales"."customer_phones"."note" is null
          or (char_length("sales"."customer_phones"."note") <= 500 and char_length(btrim("sales"."customer_phones"."note")) >= 1)),
	CONSTRAINT "customer_phones_staff_note" CHECK ("sales"."customer_phones"."source" <> 'staff' or "sales"."customer_phones"."note" is not null),
	CONSTRAINT "customer_phones_retired_whole" CHECK (("sales"."customer_phones"."retired_at" is null) = ("sales"."customer_phones"."retire_reason" is null)
          and ("sales"."customer_phones"."retired_at" is not null
               or ("sales"."customer_phones"."retired_by_user_id" is null and "sales"."customer_phones"."retire_note" is null))),
	CONSTRAINT "customer_phones_retire_reason" CHECK ("sales"."customer_phones"."retire_reason" is null
          or "sales"."customer_phones"."retire_reason" in ('changed_number', 'wrong_number', 'not_theirs', 'other')),
	CONSTRAINT "customer_phones_retire_note" CHECK ("sales"."customer_phones"."retire_note" is null or char_length("sales"."customer_phones"."retire_note") <= 500)
);
--> statement-breakpoint
DROP INDEX "sales"."customers_org_phone_idx";--> statement-breakpoint
ALTER TABLE "sales"."customers" ADD COLUMN "merged_into_customer_id" uuid;--> statement-breakpoint
ALTER TABLE "sales"."customers" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales"."customers" ADD COLUMN "merged_by_user_id" text;--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD COLUMN "placed_for" text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD COLUMN "recipient_customer_id" uuid;--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD COLUMN "placed_for_note" text;--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD COLUMN "buyer_check" text;--> statement-breakpoint
ALTER TABLE "sales"."customer_phones" ADD CONSTRAINT "customer_phones_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."customer_phones" ADD CONSTRAINT "customer_phones_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."customer_phones" ADD CONSTRAINT "customer_phones_retired_by_user_id_users_id_fk" FOREIGN KEY ("retired_by_user_id") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."customer_phones" ADD CONSTRAINT "customer_phones_org_id_customer_id_fk" FOREIGN KEY ("org_id","customer_id") REFERENCES "sales"."customers"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_phones_org_idx" ON "sales"."customer_phones" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "customer_phones_org_customer_idx" ON "sales"."customer_phones" USING btree ("org_id","customer_id");--> statement-breakpoint
CREATE INDEX "customer_phones_org_phone_idx" ON "sales"."customer_phones" USING btree ("org_id","phone_e164") WHERE "sales"."customer_phones"."retired_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_phones_org_customer_phone_idx" ON "sales"."customer_phones" USING btree ("org_id","customer_id","phone_e164") WHERE "sales"."customer_phones"."retired_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_phones_org_primary_idx" ON "sales"."customer_phones" USING btree ("org_id","customer_id") WHERE "sales"."customer_phones"."rank" = 1 and "sales"."customer_phones"."retired_at" is null;--> statement-breakpoint
ALTER TABLE "sales"."customers" ADD CONSTRAINT "customers_merged_by_user_id_users_id_fk" FOREIGN KEY ("merged_by_user_id") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."customers" ADD CONSTRAINT "customers_org_id_merged_into_fk" FOREIGN KEY ("org_id","merged_into_customer_id") REFERENCES "sales"."customers"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_org_id_recipient_customer_id_fk" FOREIGN KEY ("org_id","recipient_customer_id") REFERENCES "sales"."customers"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_org_buyer_check_idx" ON "sales"."orders" USING btree ("org_id","created_at") WHERE "sales"."orders"."buyer_check" is not null;--> statement-breakpoint
CREATE INDEX "customers_org_phone_idx" ON "sales"."customers" USING btree ("org_id","phone_e164");--> statement-breakpoint
ALTER TABLE "sales"."customers" ADD CONSTRAINT "customers_merged_whole" CHECK (("sales"."customers"."merged_into_customer_id" is null) = ("sales"."customers"."merged_at" is null)
          and "sales"."customers"."merged_into_customer_id" is distinct from "sales"."customers"."id");--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_placed_for" CHECK ("sales"."orders"."placed_for" in ('self', 'someone_else'));--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_placed_for_note" CHECK ("sales"."orders"."placed_for_note" is null or char_length("sales"."orders"."placed_for_note") <= 500);--> statement-breakpoint
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_buyer_check" CHECK ("sales"."orders"."buyer_check" is null or "sales"."orders"."buyer_check" in ('shared_number'));