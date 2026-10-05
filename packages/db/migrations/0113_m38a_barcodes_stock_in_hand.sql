ALTER TYPE "approvals"."approval_type" ADD VALUE 'opening_stock_reopen';--> statement-breakpoint
CREATE TABLE "inventory"."count_scans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"code" text NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "count_scans_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "count_scans_qty_positive" CHECK ("inventory"."count_scans"."qty" between 1 and 1000),
	CONSTRAINT "count_scans_code_length" CHECK (length("inventory"."count_scans"."code") between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "inventory"."opening_stock_windows" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"reopen_approval_id" uuid,
	"reopened_at" timestamp with time zone,
	"reopened_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opening_stock_windows_status_known" CHECK ("inventory"."opening_stock_windows"."status" in ('open', 'closed')),
	CONSTRAINT "opening_stock_windows_closed_is_complete" CHECK ("inventory"."opening_stock_windows"."status" <> 'closed' or ("inventory"."opening_stock_windows"."closed_at" is not null and "inventory"."opening_stock_windows"."closed_by" is not null)),
	CONSTRAINT "opening_stock_windows_reopen_is_complete" CHECK (("inventory"."opening_stock_windows"."reopen_approval_id" is null) = ("inventory"."opening_stock_windows"."reopened_at" is null)
          and ("inventory"."opening_stock_windows"."reopened_at" is null) = ("inventory"."opening_stock_windows"."reopened_by" is null))
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_in_hand_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"branch_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"memo" text,
	"occurred_at" timestamp with time zone,
	"business_date" date,
	"journal_id" uuid,
	"created_by" text NOT NULL,
	"posted_by" text,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_in_hand_entries_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "stock_in_hand_entries_status_known" CHECK ("inventory"."stock_in_hand_entries"."status" in ('draft', 'posted')),
	CONSTRAINT "stock_in_hand_entries_memo_length" CHECK ("inventory"."stock_in_hand_entries"."memo" is null or length("inventory"."stock_in_hand_entries"."memo") <= 500),
	CONSTRAINT "stock_in_hand_entries_posted_is_complete" CHECK (case "inventory"."stock_in_hand_entries"."status"
            when 'posted' then "inventory"."stock_in_hand_entries"."journal_id" is not null and "inventory"."stock_in_hand_entries"."occurred_at" is not null
              and "inventory"."stock_in_hand_entries"."business_date" is not null and "inventory"."stock_in_hand_entries"."posted_by" is not null
              and "inventory"."stock_in_hand_entries"."posted_at" is not null
            else "inventory"."stock_in_hand_entries"."journal_id" is null and "inventory"."stock_in_hand_entries"."occurred_at" is null
              and "inventory"."stock_in_hand_entries"."business_date" is null and "inventory"."stock_in_hand_entries"."posted_by" is null
              and "inventory"."stock_in_hand_entries"."posted_at" is null
          end)
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_in_hand_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"sku_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"unit_cost_poisha" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_in_hand_lines_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "stock_in_hand_lines_qty_positive" CHECK ("inventory"."stock_in_hand_lines"."qty" > 0 and "inventory"."stock_in_hand_lines"."qty" <= 1000000),
	CONSTRAINT "stock_in_hand_lines_cost_positive" CHECK ("inventory"."stock_in_hand_lines"."unit_cost_poisha" is null or ("inventory"."stock_in_hand_lines"."unit_cost_poisha" > 0 and "inventory"."stock_in_hand_lines"."unit_cost_poisha" <= 9000000000000000)),
	CONSTRAINT "stock_in_hand_lines_line_no_positive" CHECK ("inventory"."stock_in_hand_lines"."line_no" > 0)
);
--> statement-breakpoint
ALTER TABLE "approvals"."approval_requests" DROP CONSTRAINT "approval_requests_never_auto_approved";--> statement-breakpoint
ALTER TABLE "approvals"."approval_thresholds" DROP CONSTRAINT "approval_thresholds_never_for_controls";--> statement-breakpoint
ALTER TABLE "catalog"."sku_settings" ADD COLUMN "last_barcode_sequence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory"."count_scans" ADD CONSTRAINT "count_scans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."count_scans" ADD CONSTRAINT "count_scans_org_id_session_id_fk" FOREIGN KEY ("org_id","session_id") REFERENCES "inventory"."count_sessions"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."count_scans" ADD CONSTRAINT "count_scans_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."opening_stock_windows" ADD CONSTRAINT "opening_stock_windows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."opening_stock_windows" ADD CONSTRAINT "opening_stock_windows_org_id_reopen_approval_id_fk" FOREIGN KEY ("org_id","reopen_approval_id") REFERENCES "approvals"."approval_requests"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_in_hand_entries" ADD CONSTRAINT "stock_in_hand_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_in_hand_entries" ADD CONSTRAINT "stock_in_hand_entries_org_id_location_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "org"."locations"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_in_hand_entries" ADD CONSTRAINT "stock_in_hand_entries_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_in_hand_entries" ADD CONSTRAINT "stock_in_hand_entries_org_id_journal_id_fk" FOREIGN KEY ("org_id","journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_in_hand_lines" ADD CONSTRAINT "stock_in_hand_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_in_hand_lines" ADD CONSTRAINT "stock_in_hand_lines_org_id_entry_id_fk" FOREIGN KEY ("org_id","entry_id") REFERENCES "inventory"."stock_in_hand_entries"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_in_hand_lines" ADD CONSTRAINT "stock_in_hand_lines_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "count_scans_org_idx" ON "inventory"."count_scans" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "count_scans_org_session_idx" ON "inventory"."count_scans" USING btree ("org_id","session_id");--> statement-breakpoint
CREATE INDEX "opening_stock_windows_org_idx" ON "inventory"."opening_stock_windows" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "stock_in_hand_entries_org_idx" ON "inventory"."stock_in_hand_entries" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "stock_in_hand_entries_org_status_idx" ON "inventory"."stock_in_hand_entries" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "stock_in_hand_entries_org_branch_idx" ON "inventory"."stock_in_hand_entries" USING btree ("org_id","branch_id");--> statement-breakpoint
CREATE INDEX "stock_in_hand_lines_org_idx" ON "inventory"."stock_in_hand_lines" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "stock_in_hand_lines_org_sku_idx" ON "inventory"."stock_in_hand_lines" USING btree ("org_id","sku_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_in_hand_lines_org_entry_sku_idx" ON "inventory"."stock_in_hand_lines" USING btree ("org_id","entry_id","sku_id");--> statement-breakpoint
ALTER TABLE "approvals"."approval_requests" ADD CONSTRAINT "approval_requests_never_auto_approved" CHECK ("approvals"."approval_requests"."status"::text <> 'auto_approved' or "approvals"."approval_requests"."type"::text not in ('period_reopen', 'bonus_rule', 'threshold_change', 'back_dated_entry', 'credential_reset', 'opening_stock_reopen'));--> statement-breakpoint
ALTER TABLE "approvals"."approval_thresholds" ADD CONSTRAINT "approval_thresholds_never_for_controls" CHECK ("approvals"."approval_thresholds"."type"::text not in ('period_reopen', 'bonus_rule', 'threshold_change', 'back_dated_entry', 'credential_reset', 'opening_stock_reopen'));--> statement-breakpoint
ALTER TABLE "catalog"."sku_settings" ADD CONSTRAINT "sku_settings_barcode_sequence_range" CHECK ("catalog"."sku_settings"."last_barcode_sequence" between 0 and 99999999999);