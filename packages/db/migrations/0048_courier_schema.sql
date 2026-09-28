-- Couriers: accounts, consignments, status events, returns and settlements
-- (M12; architecture §9, §20, §21).
--
-- Mirrors `packages/db/src/schema/courier/index.ts` and is placed at this
-- milestone's assigned number. The isolation policies and grants follow in 0049,
-- the append-only and immutability triggers in 0050, and the settlement's own
-- state guard in 0051.
--
-- Two absences are load-bearing and are explained at length in the Drizzle file:
--
--  * No credential is readable. `courier_accounts.credentials` and
--    `.webhook_secret` are `bytea` holding AES-256-GCM ciphertext, so an API key
--    is not in a backup, in a `pg_dump`, or in a `select *` (invariant 10, §25).
--  * No cost column exists anywhere in this schema. A returned unit's value is
--    `sales.order_lines.dispatch_unit_cost_poisha`, which the orders module owns;
--    a copy here would be a fourth home for purchase cost (invariant 5).
--
-- The one foreign key added by ALTER at the end is `consignments.settlement_id`:
-- the two tables reference each other, so one constraint has to wait until both
-- tables exist.

CREATE SCHEMA "courier";
--> statement-breakpoint
CREATE TYPE "courier"."parcel_status" AS ENUM('booked', 'pickup_pending', 'picked_up', 'in_transit', 'out_for_delivery', 'hold', 'delivered', 'partial_delivered', 'return_in_transit', 'returned_to_merchant', 'cancelled', 'unknown');--> statement-breakpoint
CREATE TYPE "courier"."booking_state" AS ENUM('pending', 'booked', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "courier"."consignment_event_source" AS ENUM('webhook', 'poll', 'manual');--> statement-breakpoint
CREATE TYPE "courier"."settlement_status" AS ENUM('imported', 'pending_approval', 'posted', 'rejected');--> statement-breakpoint
CREATE TYPE "courier"."settlement_match" AS ENUM('matched', 'unmatched', 'amount_mismatch', 'duplicate', 'already_settled');--> statement-breakpoint
CREATE TABLE "courier"."courier_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"courier_id" uuid NOT NULL,
	"provider_code" text NOT NULL,
	"label" text NOT NULL,
	"mode" text DEFAULT 'sandbox' NOT NULL,
	"base_url" text,
	"credentials" bytea,
	"credentials_key_id" text,
	"credentials_fingerprint" text,
	"webhook_secret" bytea,
	"supports_webhook" boolean DEFAULT false NOT NULL,
	"poll_after_hours" smallint DEFAULT 6 NOT NULL,
	"settlement_wallet_id" uuid,
	"verified" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "courier_accounts_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "courier_accounts_provider_format" CHECK ("courier"."courier_accounts"."provider_code" ~ '^[a-z][a-z0-9_]{1,31}$'),
	CONSTRAINT "courier_accounts_mode" CHECK ("courier"."courier_accounts"."mode" in ('sandbox', 'live')),
	CONSTRAINT "courier_accounts_poll_window" CHECK ("courier"."courier_accounts"."poll_after_hours" between 1 and 168),
	CONSTRAINT "courier_accounts_credentials_have_key" CHECK (("courier"."courier_accounts"."credentials" is null) = ("courier"."courier_accounts"."credentials_key_id" is null)),
	CONSTRAINT "courier_accounts_active_has_credentials" CHECK ("courier"."courier_accounts"."is_active" = false or "courier"."courier_accounts"."credentials" is not null or "courier"."courier_accounts"."provider_code" = 'fake')
);
--> statement-breakpoint
CREATE TABLE "courier"."consignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"courier_account_id" uuid NOT NULL,
	"courier_id" uuid NOT NULL,
	"branch_id" uuid,
	"consignment_no" text,
	"tracking_code" text,
	"reference" text NOT NULL,
	"booking_state" "courier"."booking_state" DEFAULT 'pending' NOT NULL,
	"booking_attempts" smallint DEFAULT 0 NOT NULL,
	"booking_failure_code" text,
	"booking_failure_message" text,
	"status" "courier"."parcel_status" DEFAULT 'booked' NOT NULL,
	"raw_status" text,
	"cod_amount_poisha" bigint NOT NULL,
	"collected_poisha" bigint,
	"booked_at" timestamp with time zone,
	"handover_confirmed_at" timestamp with time zone,
	"handover_confirmed_by" text,
	"delivered_at" timestamp with time zone,
	"returned_at" timestamp with time zone,
	"last_status_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"settlement_id" uuid,
	"settled_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consignments_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "consignments_cod_not_negative" CHECK ("courier"."consignments"."cod_amount_poisha" >= 0),
	CONSTRAINT "consignments_cod_bounded" CHECK ("courier"."consignments"."cod_amount_poisha" <= 9000000000000000),
	CONSTRAINT "consignments_collected_not_negative" CHECK ("courier"."consignments"."collected_poisha" is null or "courier"."consignments"."collected_poisha" >= 0),
	CONSTRAINT "consignments_booked_has_number" CHECK ("courier"."consignments"."booking_state" <> 'booked' or ("courier"."consignments"."consignment_no" is not null and "courier"."consignments"."booked_at" is not null)),
	CONSTRAINT "consignments_settled_has_settlement" CHECK (("courier"."consignments"."settlement_id" is null) = ("courier"."consignments"."settled_at" is null))
);
--> statement-breakpoint
CREATE TABLE "courier"."consignment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"consignment_id" uuid NOT NULL,
	"source" "courier"."consignment_event_source" NOT NULL,
	"status" "courier"."parcel_status" NOT NULL,
	"raw_status" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"webhook_delivery_id" uuid,
	"applied_trigger" text,
	"order_from_status" text,
	"order_to_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consignment_events_org_id_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "courier"."webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"courier_account_id" uuid NOT NULL,
	"provider_code" text NOT NULL,
	"body_hash" text NOT NULL,
	"body" jsonb NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"event_count" smallint DEFAULT 0 NOT NULL,
	"process_error" text,
	CONSTRAINT "webhook_deliveries_org_id_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "courier"."return_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"consignment_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"branch_id" uuid,
	"location_id" uuid NOT NULL,
	"damaged_location_id" uuid,
	"received_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"received_by" text NOT NULL,
	"reason" text NOT NULL,
	"inspection_note" text,
	"journal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "return_receipts_org_id_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "courier"."return_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"sellable_qty" integer DEFAULT 0 NOT NULL,
	"damaged_qty" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "return_receipt_lines_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "return_receipt_lines_sellable_not_negative" CHECK ("courier"."return_receipt_lines"."sellable_qty" >= 0),
	CONSTRAINT "return_receipt_lines_damaged_not_negative" CHECK ("courier"."return_receipt_lines"."damaged_qty" >= 0),
	CONSTRAINT "return_receipt_lines_received_something" CHECK ("courier"."return_receipt_lines"."sellable_qty" + "courier"."return_receipt_lines"."damaged_qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "courier"."settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"courier_account_id" uuid NOT NULL,
	"courier_id" uuid NOT NULL,
	"branch_id" uuid,
	"reference" text,
	"settlement_date" date NOT NULL,
	"posting_business_date" date,
	"deferred_from_closed_period" boolean DEFAULT false NOT NULL,
	"status" "courier"."settlement_status" DEFAULT 'imported' NOT NULL,
	"file_object_id" uuid,
	"wallet_id" uuid NOT NULL,
	"file_gross_poisha" bigint NOT NULL,
	"file_charges_poisha" bigint NOT NULL,
	"file_net_poisha" bigint NOT NULL,
	"file_row_count" integer NOT NULL,
	"matched_gross_poisha" bigint NOT NULL,
	"matched_charges_poisha" bigint NOT NULL,
	"matched_delivery_charges_poisha" bigint NOT NULL,
	"matched_return_charges_poisha" bigint NOT NULL,
	"matched_other_charges_poisha" bigint NOT NULL,
	"matched_net_poisha" bigint NOT NULL,
	"matched_row_count" integer NOT NULL,
	"exception_count" integer NOT NULL,
	"approval_request_id" uuid,
	"charges_journal_id" uuid,
	"cash_journal_id" uuid,
	"imported_by" text NOT NULL,
	"posted_at" timestamp with time zone,
	"rejected_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlements_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "settlements_row_counts_sane" CHECK ("courier"."settlements"."file_row_count" >= 0 and "courier"."settlements"."matched_row_count" >= 0 and "courier"."settlements"."exception_count" >= 0 and "courier"."settlements"."matched_row_count" + "courier"."settlements"."exception_count" = "courier"."settlements"."file_row_count"),
	CONSTRAINT "settlements_charges_add_up" CHECK ("courier"."settlements"."matched_charges_poisha" = "courier"."settlements"."matched_delivery_charges_poisha" + "courier"."settlements"."matched_return_charges_poisha" + "courier"."settlements"."matched_other_charges_poisha"),
	CONSTRAINT "settlements_matched_gross_is_charges_plus_net" CHECK ("courier"."settlements"."matched_gross_poisha" = "courier"."settlements"."matched_charges_poisha" + "courier"."settlements"."matched_net_poisha"),
	CONSTRAINT "settlements_no_backdating" CHECK ("courier"."settlements"."posting_business_date" is null or "courier"."settlements"."posting_business_date" >= "courier"."settlements"."settlement_date"),
	CONSTRAINT "settlements_deferred_has_later_date" CHECK ("courier"."settlements"."deferred_from_closed_period" = false or "courier"."settlements"."posting_business_date" is null or "courier"."settlements"."posting_business_date" > "courier"."settlements"."settlement_date"),
	CONSTRAINT "settlements_posted_has_journal" CHECK ("courier"."settlements"."status" <> 'posted' or ("courier"."settlements"."posted_at" is not null and "courier"."settlements"."posting_business_date" is not null and ("courier"."settlements"."charges_journal_id" is not null or "courier"."settlements"."cash_journal_id" is not null))),
	CONSTRAINT "settlements_rejected_has_reason" CHECK ("courier"."settlements"."status" <> 'rejected' or "courier"."settlements"."rejected_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "courier"."settlement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"settlement_id" uuid NOT NULL,
	"row_no" integer NOT NULL,
	"consignment_no" text NOT NULL,
	"reference" text,
	"match" "courier"."settlement_match" NOT NULL,
	"consignment_id" uuid,
	"order_id" uuid,
	"cod_collected_poisha" bigint NOT NULL,
	"delivery_charge_poisha" bigint NOT NULL,
	"return_charge_poisha" bigint NOT NULL,
	"other_charge_poisha" bigint NOT NULL,
	"net_poisha" bigint NOT NULL,
	"expected_poisha" bigint,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_lines_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "settlement_lines_row_no_positive" CHECK ("courier"."settlement_lines"."row_no" > 0),
	CONSTRAINT "settlement_lines_charges_not_negative" CHECK ("courier"."settlement_lines"."delivery_charge_poisha" >= 0 and "courier"."settlement_lines"."return_charge_poisha" >= 0 and "courier"."settlement_lines"."other_charge_poisha" >= 0),
	CONSTRAINT "settlement_lines_cod_not_negative" CHECK ("courier"."settlement_lines"."cod_collected_poisha" >= 0),
	CONSTRAINT "settlement_lines_net_is_gross_less_charges" CHECK ("courier"."settlement_lines"."net_poisha" = "courier"."settlement_lines"."cod_collected_poisha" - "courier"."settlement_lines"."delivery_charge_poisha" - "courier"."settlement_lines"."return_charge_poisha" - "courier"."settlement_lines"."other_charge_poisha"),
	CONSTRAINT "settlement_lines_matched_has_consignment" CHECK ("courier"."settlement_lines"."match" <> 'matched' or ("courier"."settlement_lines"."consignment_id" is not null and "courier"."settlement_lines"."order_id" is not null)),
	CONSTRAINT "settlement_lines_exception_has_note" CHECK ("courier"."settlement_lines"."match" = 'matched' or "courier"."settlement_lines"."note" is not null)
);
--> statement-breakpoint
ALTER TABLE "courier"."courier_accounts" ADD CONSTRAINT "courier_accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."courier_accounts" ADD CONSTRAINT "courier_accounts_org_id_courier_id_fk" FOREIGN KEY ("org_id","courier_id") REFERENCES "sales"."couriers"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."courier_accounts" ADD CONSTRAINT "courier_accounts_org_id_settlement_wallet_id_fk" FOREIGN KEY ("org_id","settlement_wallet_id") REFERENCES "wallets"."wallets"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."consignments" ADD CONSTRAINT "consignments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."consignments" ADD CONSTRAINT "consignments_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."consignments" ADD CONSTRAINT "consignments_org_id_courier_account_id_fk" FOREIGN KEY ("org_id","courier_account_id") REFERENCES "courier"."courier_accounts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."consignments" ADD CONSTRAINT "consignments_org_id_courier_id_fk" FOREIGN KEY ("org_id","courier_id") REFERENCES "sales"."couriers"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."consignments" ADD CONSTRAINT "consignments_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."consignment_events" ADD CONSTRAINT "consignment_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."consignment_events" ADD CONSTRAINT "consignment_events_org_id_consignment_id_fk" FOREIGN KEY ("org_id","consignment_id") REFERENCES "courier"."consignments"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_org_id_courier_account_id_fk" FOREIGN KEY ("org_id","courier_account_id") REFERENCES "courier"."courier_accounts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."consignment_events" ADD CONSTRAINT "consignment_events_org_id_webhook_delivery_id_fk" FOREIGN KEY ("org_id","webhook_delivery_id") REFERENCES "courier"."webhook_deliveries"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."return_receipts" ADD CONSTRAINT "return_receipts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."return_receipts" ADD CONSTRAINT "return_receipts_org_id_consignment_id_fk" FOREIGN KEY ("org_id","consignment_id") REFERENCES "courier"."consignments"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."return_receipts" ADD CONSTRAINT "return_receipts_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."return_receipts" ADD CONSTRAINT "return_receipts_org_id_location_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "org"."locations"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."return_receipts" ADD CONSTRAINT "return_receipts_org_id_damaged_location_id_fk" FOREIGN KEY ("org_id","damaged_location_id") REFERENCES "org"."locations"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."return_receipts" ADD CONSTRAINT "return_receipts_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."return_receipts" ADD CONSTRAINT "return_receipts_org_id_journal_id_fk" FOREIGN KEY ("org_id","journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."return_receipt_lines" ADD CONSTRAINT "return_receipt_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."return_receipt_lines" ADD CONSTRAINT "return_receipt_lines_org_id_receipt_id_fk" FOREIGN KEY ("org_id","receipt_id") REFERENCES "courier"."return_receipts"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."return_receipt_lines" ADD CONSTRAINT "return_receipt_lines_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."settlements" ADD CONSTRAINT "settlements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."settlements" ADD CONSTRAINT "settlements_org_id_courier_account_id_fk" FOREIGN KEY ("org_id","courier_account_id") REFERENCES "courier"."courier_accounts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."settlements" ADD CONSTRAINT "settlements_org_id_courier_id_fk" FOREIGN KEY ("org_id","courier_id") REFERENCES "sales"."couriers"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."settlements" ADD CONSTRAINT "settlements_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."settlements" ADD CONSTRAINT "settlements_org_id_wallet_id_fk" FOREIGN KEY ("org_id","wallet_id") REFERENCES "wallets"."wallets"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."settlements" ADD CONSTRAINT "settlements_org_id_file_object_id_fk" FOREIGN KEY ("org_id","file_object_id") REFERENCES "files"."objects"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."settlements" ADD CONSTRAINT "settlements_org_id_approval_request_id_fk" FOREIGN KEY ("org_id","approval_request_id") REFERENCES "approvals"."approval_requests"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."settlements" ADD CONSTRAINT "settlements_org_id_charges_journal_id_fk" FOREIGN KEY ("org_id","charges_journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."settlements" ADD CONSTRAINT "settlements_org_id_cash_journal_id_fk" FOREIGN KEY ("org_id","cash_journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."settlement_lines" ADD CONSTRAINT "settlement_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."settlement_lines" ADD CONSTRAINT "settlement_lines_org_id_settlement_id_fk" FOREIGN KEY ("org_id","settlement_id") REFERENCES "courier"."settlements"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier"."settlement_lines" ADD CONSTRAINT "settlement_lines_org_id_consignment_id_fk" FOREIGN KEY ("org_id","consignment_id") REFERENCES "courier"."consignments"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- The circular one, deliberately last: a consignment names the settlement that
-- closed it, and a settlement line names the consignment it covers.
ALTER TABLE "courier"."consignments" ADD CONSTRAINT "consignments_org_id_settlement_id_fk" FOREIGN KEY ("org_id","settlement_id") REFERENCES "courier"."settlements"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "courier_accounts_org_idx" ON "courier"."courier_accounts" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "courier_accounts_org_courier_idx" ON "courier"."courier_accounts" USING btree ("org_id","courier_id");--> statement-breakpoint
CREATE INDEX "consignments_org_idx" ON "courier"."consignments" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consignments_org_account_no_idx" ON "courier"."consignments" USING btree ("org_id","courier_account_id","consignment_no") WHERE "courier"."consignments"."consignment_no" is not null;--> statement-breakpoint
CREATE INDEX "consignments_org_order_idx" ON "courier"."consignments" USING btree ("org_id","order_id");--> statement-breakpoint
CREATE INDEX "consignments_org_status_idx" ON "courier"."consignments" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "consignments_org_active_idx" ON "courier"."consignments" USING btree ("org_id","last_status_at") WHERE "courier"."consignments"."status" not in ('delivered', 'partial_delivered', 'returned_to_merchant', 'cancelled');--> statement-breakpoint
CREATE INDEX "consignments_org_unsettled_idx" ON "courier"."consignments" USING btree ("org_id","courier_id","delivered_at") WHERE "courier"."consignments"."settlement_id" is null;--> statement-breakpoint
CREATE INDEX "consignment_events_org_idx" ON "courier"."consignment_events" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consignment_events_org_dedupe_idx" ON "courier"."consignment_events" USING btree ("org_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "consignment_events_org_consignment_idx" ON "courier"."consignment_events" USING btree ("org_id","consignment_id","occurred_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_org_idx" ON "courier"."webhook_deliveries" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_org_account_hash_idx" ON "courier"."webhook_deliveries" USING btree ("org_id","courier_account_id","body_hash");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_org_received_idx" ON "courier"."webhook_deliveries" USING btree ("org_id","received_at");--> statement-breakpoint
CREATE INDEX "return_receipts_org_idx" ON "courier"."return_receipts" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "return_receipts_org_consignment_idx" ON "courier"."return_receipts" USING btree ("org_id","consignment_id");--> statement-breakpoint
CREATE INDEX "return_receipts_org_date_idx" ON "courier"."return_receipts" USING btree ("org_id","business_date");--> statement-breakpoint
CREATE INDEX "return_receipt_lines_org_idx" ON "courier"."return_receipt_lines" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "return_receipt_lines_receipt_sku_idx" ON "courier"."return_receipt_lines" USING btree ("org_id","receipt_id","sku_id");--> statement-breakpoint
CREATE INDEX "settlements_org_idx" ON "courier"."settlements" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "settlements_org_courier_date_idx" ON "courier"."settlements" USING btree ("org_id","courier_id","settlement_date");--> statement-breakpoint
CREATE INDEX "settlements_org_status_idx" ON "courier"."settlements" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_org_courier_reference_idx" ON "courier"."settlements" USING btree ("org_id","courier_account_id","reference") WHERE "courier"."settlements"."reference" is not null;--> statement-breakpoint
CREATE INDEX "settlement_lines_org_idx" ON "courier"."settlement_lines" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_lines_settlement_row_idx" ON "courier"."settlement_lines" USING btree ("org_id","settlement_id","row_no");--> statement-breakpoint
CREATE INDEX "settlement_lines_org_exceptions_idx" ON "courier"."settlement_lines" USING btree ("org_id","settlement_id") WHERE "courier"."settlement_lines"."match" <> 'matched';
