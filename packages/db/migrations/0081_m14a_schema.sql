-- The balancing figure when a brand opens its books mid-life (M14a; D-213).
--
-- Its own account rather than retained earnings, because the two are different facts:
-- retained earnings is what the business earned, and this is what it was holding on the
-- day it started recording. An accountant clears this to the real equity accounts once
-- the opening figures are agreed, which they can only do if it is visible.
--
-- Also M14a's `migration` schema: import batches and their rows.
CREATE SCHEMA "migration";
--> statement-breakpoint
ALTER TYPE "ledger"."account_subtype" ADD VALUE 'opening_equity';--> statement-breakpoint
CREATE TABLE "migration"."batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"content_sha256" text NOT NULL,
	"file_name" text NOT NULL,
	"row_count" integer NOT NULL,
	"rows" jsonb,
	"summary" jsonb NOT NULL,
	"status" text NOT NULL,
	"opening_id" uuid,
	"created_by" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "migration_batches_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "migration_batches_kind" CHECK ("migration"."batches"."kind" in ('skus', 'opening_stock', 'supplier_balances', 'wallet_balances', 'courier_cod', 'customers')),
	CONSTRAINT "migration_batches_status" CHECK ("migration"."batches"."status" in ('applied', 'staged', 'discarded', 'posted')),
	CONSTRAINT "migration_batches_hash_shape" CHECK ("migration"."batches"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "migration_batches_file_name_length" CHECK (length("migration"."batches"."file_name") between 1 and 200),
	CONSTRAINT "migration_batches_row_count" CHECK ("migration"."batches"."row_count" >= 0),
	CONSTRAINT "migration_batches_posted_has_opening" CHECK (("migration"."batches"."status" = 'posted') = ("migration"."batches"."opening_id" is not null)),
	CONSTRAINT "migration_batches_applied_has_no_rows" CHECK (("migration"."batches"."status" = 'applied') = ("migration"."batches"."rows" is null)),
	CONSTRAINT "migration_batches_decided_whole" CHECK (("migration"."batches"."decided_by" is null) = ("migration"."batches"."decided_at" is null)
        and (("migration"."batches"."status" in ('discarded', 'posted')) = ("migration"."batches"."decided_at" is not null)))
);
--> statement-breakpoint
CREATE TABLE "migration"."openings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"journal_id" uuid NOT NULL,
	"posted_by" text NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_off_by" text,
	"signed_off_at" timestamp with time zone,
	"sign_off_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "migration_openings_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "migration_openings_sign_off_whole" CHECK (("migration"."openings"."signed_off_by" is null) = ("migration"."openings"."signed_off_at" is null)),
	CONSTRAINT "migration_openings_note_length" CHECK ("migration"."openings"."sign_off_note" is null or length("migration"."openings"."sign_off_note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "org"."organizations" ADD COLUMN "is_training" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "migration"."batches" ADD CONSTRAINT "batches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration"."batches" ADD CONSTRAINT "migration_batches_org_id_opening_id_fk" FOREIGN KEY ("org_id","opening_id") REFERENCES "migration"."openings"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration"."openings" ADD CONSTRAINT "openings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration"."openings" ADD CONSTRAINT "migration_openings_org_id_journal_id_fk" FOREIGN KEY ("org_id","journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "migration_batches_org_idx" ON "migration"."batches" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "migration_batches_org_kind_status_idx" ON "migration"."batches" USING btree ("org_id","kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_batches_org_kind_hash_idx" ON "migration"."batches" USING btree ("org_id","kind","content_sha256") WHERE status <> 'discarded';--> statement-breakpoint
CREATE UNIQUE INDEX "migration_openings_org_idx" ON "migration"."openings" USING btree ("org_id");