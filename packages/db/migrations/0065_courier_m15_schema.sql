-- Couriers, M15: selection rules, stuck-parcel escalations, settlement fetch, and the two
-- columns the stuck-parcel queue and the performance report need (architecture §9, §20).
--
-- Mirrors `packages/db/src/schema/courier/index.ts`. Policies and grants follow in 0066,
-- the append-only and consistency triggers in 0067.
--
-- Two new consignment columns, both written from M15 on and both nullable, because rows
-- M12 wrote cannot be backfilled from here: `delivery_zone_id` lives on `sales.orders`,
-- and a migration reading the orders module's table would be the one cross-module read
-- nobody reviews. Parcels booked before this migration appear in the performance report
-- as "no zone", and the stuck-parcel query falls back to `last_status_at` for them.
--
-- Both settlement uniqueness keys — M12's statement reference (0048) and M15's fetch
-- fingerprint — now leave rejected batches out. Rejecting a batch is how a person says
-- "fix the exceptions with the courier, then import it again", and a rejected batch that kept
-- the key made that re-import impossible, for a fetched statement permanently (M15 ledger
-- audit M4). 0048's index is replaced here rather than edited (invariant 9).
--
-- `settlements.source` defaults to 'upload' so every existing batch — all of them uploads —
-- is described correctly without an UPDATE.

ALTER TABLE "courier"."consignments" ADD COLUMN "delivery_zone_id" uuid;--> statement-breakpoint
ALTER TABLE "courier"."consignments" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "courier"."settlements" ADD COLUMN "source" text DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "courier"."settlements" ADD COLUMN "source_fingerprint" text;--> statement-breakpoint
CREATE TABLE "courier"."consignment_escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"consignment_id" uuid NOT NULL,
	"note" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consignment_escalations_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "consignment_escalations_note_length" CHECK (char_length("courier"."consignment_escalations"."note") between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "courier"."selection_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"priority" integer NOT NULL,
	"delivery_zone_id" uuid,
	"min_cod_poisha" bigint,
	"max_cod_poisha" bigint,
	"courier_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "selection_rules_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "selection_rules_priority_range" CHECK ("courier"."selection_rules"."priority" between 0 and 10000),
	CONSTRAINT "selection_rules_cod_not_negative" CHECK (("courier"."selection_rules"."min_cod_poisha" is null or "courier"."selection_rules"."min_cod_poisha" >= 0) and ("courier"."selection_rules"."max_cod_poisha" is null or "courier"."selection_rules"."max_cod_poisha" >= 0)),
	CONSTRAINT "selection_rules_cod_band_ordered" CHECK ("courier"."selection_rules"."min_cod_poisha" is null or "courier"."selection_rules"."max_cod_poisha" is null or "courier"."selection_rules"."min_cod_poisha" <= "courier"."selection_rules"."max_cod_poisha")
);
--> statement-breakpoint
CREATE TABLE "courier"."settlement_fetch_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"courier_account_id" uuid NOT NULL,
	"since_date" date NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"statements_seen" integer NOT NULL,
	"statements_created" integer NOT NULL,
	"statements_duplicate" integer NOT NULL,
	"statements_refused" integer NOT NULL,
	"outcomes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_fetch_runs_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "settlement_fetch_runs_counts_add_up" CHECK ("courier"."settlement_fetch_runs"."statements_seen" >= 0 and "courier"."settlement_fetch_runs"."statements_created" >= 0
        and "courier"."settlement_fetch_runs"."statements_duplicate" >= 0 and "courier"."settlement_fetch_runs"."statements_refused" >= 0
        and "courier"."settlement_fetch_runs"."statements_created" + "courier"."settlement_fetch_runs"."statements_duplicate" + "courier"."settlement_fetch_runs"."statements_refused" = "courier"."settlement_fetch_runs"."statements_seen")
);
--> statement-breakpoint
ALTER TABLE "courier"."consignment_escalations" ADD CONSTRAINT "consignment_escalations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."consignment_escalations" ADD CONSTRAINT "consignment_escalations_org_id_consignment_id_fk" FOREIGN KEY ("org_id","consignment_id") REFERENCES "courier"."consignments"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."selection_rules" ADD CONSTRAINT "selection_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."selection_rules" ADD CONSTRAINT "selection_rules_org_id_delivery_zone_id_fk" FOREIGN KEY ("org_id","delivery_zone_id") REFERENCES "sales"."delivery_zones"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."selection_rules" ADD CONSTRAINT "selection_rules_org_id_courier_id_fk" FOREIGN KEY ("org_id","courier_id") REFERENCES "sales"."couriers"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."settlement_fetch_runs" ADD CONSTRAINT "settlement_fetch_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."settlement_fetch_runs" ADD CONSTRAINT "settlement_fetch_runs_org_id_courier_account_id_fk" FOREIGN KEY ("org_id","courier_account_id") REFERENCES "courier"."courier_accounts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."consignments" ADD CONSTRAINT "consignments_org_id_delivery_zone_id_fk" FOREIGN KEY ("org_id","delivery_zone_id") REFERENCES "sales"."delivery_zones"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consignment_escalations_org_idx" ON "courier"."consignment_escalations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "consignment_escalations_org_consignment_idx" ON "courier"."consignment_escalations" USING btree ("org_id","consignment_id","created_at");--> statement-breakpoint
CREATE INDEX "selection_rules_org_idx" ON "courier"."selection_rules" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "selection_rules_org_priority_idx" ON "courier"."selection_rules" USING btree ("org_id","priority");--> statement-breakpoint
CREATE INDEX "settlement_fetch_runs_org_idx" ON "courier"."settlement_fetch_runs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "settlement_fetch_runs_org_account_idx" ON "courier"."settlement_fetch_runs" USING btree ("org_id","courier_account_id","started_at");--> statement-breakpoint
CREATE INDEX "consignments_org_booked_idx" ON "courier"."consignments" USING btree ("org_id","booked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_org_account_fingerprint_idx" ON "courier"."settlements" USING btree ("org_id","courier_account_id","source_fingerprint") WHERE "courier"."settlements"."source_fingerprint" is not null and "courier"."settlements"."status" <> 'rejected';--> statement-breakpoint
DROP INDEX "courier"."settlements_org_courier_reference_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_org_courier_reference_idx" ON "courier"."settlements" USING btree ("org_id","courier_account_id","reference") WHERE "courier"."settlements"."reference" is not null and "courier"."settlements"."status" <> 'rejected';--> statement-breakpoint
ALTER TABLE "courier"."settlements" ADD CONSTRAINT "settlements_source" CHECK ("courier"."settlements"."source" in ('upload', 'api'));--> statement-breakpoint
ALTER TABLE "courier"."settlements" ADD CONSTRAINT "settlements_fingerprint_iff_api" CHECK (("courier"."settlements"."source" = 'api') = ("courier"."settlements"."source_fingerprint" is not null));
