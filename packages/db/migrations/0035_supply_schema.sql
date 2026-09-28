-- Suppliers, supply entries, returns, payments and advance applications
-- (M09; architecture §7, §8).
--
-- Matches `packages/db/src/schema/supply/index.ts`. The isolation policies and
-- grants follow in 0036, the integrity triggers Drizzle cannot express in 0037,
-- and the supplier lookup index in 0038.
--
-- Two absences are the design, and both are explained at length in the schema file:
--
-- * **No total on a supply header.** The entry's value is Σ qty × unit cost over its
--   lines, summed on read. A stored total is a second number that can disagree with
--   the lines it came from, and the supplier's own statement is what would discover
--   the disagreement, months later.
-- * **No supplier balance column.** What a supplier is owed and what they hold as an
--   advance are both derived from `ledger.journal_lines` for the party. A maintained
--   column drifts the first time a journal is posted by a path that forgot to update
--   it, which is exactly what M09 check 2 would then fail to catch.
--
-- `supply_lines.unit_cost_poisha` is nullable, and that is D-005: warehouse records a
-- qty-only draft, accounts prices it. The line carries the header's status so a CHECK
-- can require the cost the moment the entry is received — a CHECK sees only its own
-- row, and a trigger in 0037 keeps the two statuses equal.

CREATE SCHEMA "supply";
--> statement-breakpoint
CREATE TYPE "supply"."supply_status" AS ENUM('draft', 'received');--> statement-breakpoint
CREATE TYPE "supply"."supplier_payment_kind" AS ENUM('advance', 'payment');--> statement-breakpoint
CREATE TYPE "supply"."supplier_payment_status" AS ENUM('pending_approval', 'posted', 'rejected');--> statement-breakpoint
CREATE TABLE "supply"."suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"address" text,
	"payment_terms_days" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "suppliers_code_shape" CHECK ("supply"."suppliers"."code" ~ '^[0-9A-Z][0-9A-Z-]{0,23}$'),
	CONSTRAINT "suppliers_name_length" CHECK (length("supply"."suppliers"."name") between 1 and 160),
	CONSTRAINT "suppliers_phone_length" CHECK ("supply"."suppliers"."phone" is null or length("supply"."suppliers"."phone") <= 32),
	CONSTRAINT "suppliers_email_length" CHECK ("supply"."suppliers"."email" is null or length("supply"."suppliers"."email") <= 160),
	CONSTRAINT "suppliers_address_length" CHECK ("supply"."suppliers"."address" is null or length("supply"."suppliers"."address") <= 500),
	CONSTRAINT "suppliers_terms_range" CHECK ("supply"."suppliers"."payment_terms_days" is null or ("supply"."suppliers"."payment_terms_days" between 0 and 365))
);
--> statement-breakpoint
CREATE TABLE "supply"."supplier_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"phone" text,
	"email" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_contacts_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "supplier_contacts_name_length" CHECK (length("supply"."supplier_contacts"."name") between 1 and 120),
	CONSTRAINT "supplier_contacts_phone_length" CHECK ("supply"."supplier_contacts"."phone" is null or length("supply"."supplier_contacts"."phone") <= 32)
);
--> statement-breakpoint
CREATE TABLE "supply"."supplier_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_notes_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "supplier_notes_body_length" CHECK (length("supply"."supplier_notes"."body") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "supply"."supplier_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"file_object_id" uuid NOT NULL,
	"label" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_documents_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "supplier_documents_label_length" CHECK (length("supply"."supplier_documents"."label") between 1 and 160)
);
--> statement-breakpoint
CREATE TABLE "supply"."supplies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"branch_id" uuid,
	"status" "supply"."supply_status" DEFAULT 'draft' NOT NULL,
	"invoice_number" text,
	"occurred_at" timestamp with time zone,
	"business_date" date,
	"attachment_file_id" uuid,
	"journal_id" uuid,
	"created_by" text NOT NULL,
	"received_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplies_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "supplies_invoice_length" CHECK ("supply"."supplies"."invoice_number" is null or length("supply"."supplies"."invoice_number") between 1 and 64),
	CONSTRAINT "supplies_status_journal" CHECK (case "supply"."supplies"."status"
            when 'received' then "supply"."supplies"."journal_id" is not null and "supply"."supplies"."occurred_at" is not null
                 and "supply"."supplies"."business_date" is not null and "supply"."supplies"."received_by" is not null
            else "supply"."supplies"."journal_id" is null and "supply"."supplies"."received_by" is null
          end)
);
--> statement-breakpoint
CREATE TABLE "supply"."supply_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"supply_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"qty" integer NOT NULL,
	"unit_cost_poisha" bigint,
	"status" "supply"."supply_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supply_lines_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "supply_lines_qty_positive" CHECK ("supply"."supply_lines"."qty" > 0),
	CONSTRAINT "supply_lines_line_no_positive" CHECK ("supply"."supply_lines"."line_no" > 0),
	CONSTRAINT "supply_lines_cost_not_negative" CHECK ("supply"."supply_lines"."unit_cost_poisha" is null or "supply"."supply_lines"."unit_cost_poisha" >= 0),
	CONSTRAINT "supply_lines_costed_when_received" CHECK ("supply"."supply_lines"."status" <> 'received' or "supply"."supply_lines"."unit_cost_poisha" is not null)
);
--> statement-breakpoint
CREATE TABLE "supply"."returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"supply_id" uuid,
	"location_id" uuid NOT NULL,
	"branch_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"reason" text NOT NULL,
	"journal_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supply_returns_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "supply_returns_reason_length" CHECK (length("supply"."returns"."reason") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "supply"."return_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"original_unit_cost_poisha" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supply_return_lines_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "supply_return_lines_qty_positive" CHECK ("supply"."return_lines"."qty" > 0),
	CONSTRAINT "supply_return_lines_cost_not_negative" CHECK ("supply"."return_lines"."original_unit_cost_poisha" >= 0)
);
--> statement-breakpoint
CREATE TABLE "supply"."supplier_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"wallet_account_id" uuid NOT NULL,
	"branch_id" uuid,
	"kind" "supply"."supplier_payment_kind" NOT NULL,
	"status" "supply"."supplier_payment_status" NOT NULL,
	"amount_poisha" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"memo" text,
	"approval_request_id" uuid,
	"journal_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_payments_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "supplier_payments_amount_positive" CHECK ("supply"."supplier_payments"."amount_poisha" > 0),
	CONSTRAINT "supplier_payments_memo_length" CHECK ("supply"."supplier_payments"."memo" is null or length("supply"."supplier_payments"."memo") <= 500),
	CONSTRAINT "supplier_payments_status_journal" CHECK (case "supply"."supplier_payments"."status"
            when 'posted' then "supply"."supplier_payments"."journal_id" is not null
            when 'pending_approval' then "supply"."supplier_payments"."journal_id" is null and "supply"."supplier_payments"."approval_request_id" is not null
            else "supply"."supplier_payments"."journal_id" is null
          end)
);
--> statement-breakpoint
CREATE TABLE "supply"."advance_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"supply_id" uuid NOT NULL,
	"amount_poisha" bigint NOT NULL,
	"business_date" date NOT NULL,
	"journal_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "advance_applications_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "advance_applications_amount_positive" CHECK ("supply"."advance_applications"."amount_poisha" > 0)
);
--> statement-breakpoint
ALTER TABLE "supply"."suppliers" ADD CONSTRAINT "suppliers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."supplier_contacts" ADD CONSTRAINT "supplier_contacts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."supplier_contacts" ADD CONSTRAINT "supplier_contacts_org_id_supplier_id_fk" FOREIGN KEY ("org_id","supplier_id") REFERENCES "supply"."suppliers"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."supplier_notes" ADD CONSTRAINT "supplier_notes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."supplier_notes" ADD CONSTRAINT "supplier_notes_org_id_supplier_id_fk" FOREIGN KEY ("org_id","supplier_id") REFERENCES "supply"."suppliers"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."supplier_documents" ADD CONSTRAINT "supplier_documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."supplier_documents" ADD CONSTRAINT "supplier_documents_org_id_supplier_id_fk" FOREIGN KEY ("org_id","supplier_id") REFERENCES "supply"."suppliers"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."supplier_documents" ADD CONSTRAINT "supplier_documents_org_id_file_object_id_fk" FOREIGN KEY ("org_id","file_object_id") REFERENCES "files"."objects"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."supplies" ADD CONSTRAINT "supplies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."supplies" ADD CONSTRAINT "supplies_org_id_supplier_id_fk" FOREIGN KEY ("org_id","supplier_id") REFERENCES "supply"."suppliers"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."supplies" ADD CONSTRAINT "supplies_org_id_location_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "org"."locations"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."supplies" ADD CONSTRAINT "supplies_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."supplies" ADD CONSTRAINT "supplies_org_id_attachment_file_id_fk" FOREIGN KEY ("org_id","attachment_file_id") REFERENCES "files"."objects"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."supplies" ADD CONSTRAINT "supplies_org_id_journal_id_fk" FOREIGN KEY ("org_id","journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."supply_lines" ADD CONSTRAINT "supply_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."supply_lines" ADD CONSTRAINT "supply_lines_org_id_supply_id_fk" FOREIGN KEY ("org_id","supply_id") REFERENCES "supply"."supplies"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."supply_lines" ADD CONSTRAINT "supply_lines_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."returns" ADD CONSTRAINT "returns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."returns" ADD CONSTRAINT "supply_returns_org_id_supplier_id_fk" FOREIGN KEY ("org_id","supplier_id") REFERENCES "supply"."suppliers"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."returns" ADD CONSTRAINT "supply_returns_org_id_supply_id_fk" FOREIGN KEY ("org_id","supply_id") REFERENCES "supply"."supplies"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."returns" ADD CONSTRAINT "supply_returns_org_id_location_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "org"."locations"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."returns" ADD CONSTRAINT "supply_returns_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."returns" ADD CONSTRAINT "supply_returns_org_id_journal_id_fk" FOREIGN KEY ("org_id","journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."return_lines" ADD CONSTRAINT "return_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."return_lines" ADD CONSTRAINT "supply_return_lines_org_id_return_id_fk" FOREIGN KEY ("org_id","return_id") REFERENCES "supply"."returns"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."return_lines" ADD CONSTRAINT "supply_return_lines_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."supplier_payments" ADD CONSTRAINT "supplier_payments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."supplier_payments" ADD CONSTRAINT "supplier_payments_org_id_supplier_id_fk" FOREIGN KEY ("org_id","supplier_id") REFERENCES "supply"."suppliers"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."supplier_payments" ADD CONSTRAINT "supplier_payments_org_id_wallet_account_id_fk" FOREIGN KEY ("org_id","wallet_account_id") REFERENCES "ledger"."accounts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."supplier_payments" ADD CONSTRAINT "supplier_payments_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."supplier_payments" ADD CONSTRAINT "supplier_payments_org_id_approval_request_id_fk" FOREIGN KEY ("org_id","approval_request_id") REFERENCES "approvals"."approval_requests"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."supplier_payments" ADD CONSTRAINT "supplier_payments_org_id_journal_id_fk" FOREIGN KEY ("org_id","journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."advance_applications" ADD CONSTRAINT "advance_applications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."advance_applications" ADD CONSTRAINT "advance_applications_org_id_supplier_id_fk" FOREIGN KEY ("org_id","supplier_id") REFERENCES "supply"."suppliers"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."advance_applications" ADD CONSTRAINT "advance_applications_org_id_payment_id_fk" FOREIGN KEY ("org_id","payment_id") REFERENCES "supply"."supplier_payments"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."advance_applications" ADD CONSTRAINT "advance_applications_org_id_supply_id_fk" FOREIGN KEY ("org_id","supply_id") REFERENCES "supply"."supplies"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply"."advance_applications" ADD CONSTRAINT "advance_applications_org_id_journal_id_fk" FOREIGN KEY ("org_id","journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "suppliers_org_idx" ON "supply"."suppliers" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_org_code_idx" ON "supply"."suppliers" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "supplier_contacts_org_idx" ON "supply"."supplier_contacts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "supplier_contacts_org_supplier_idx" ON "supply"."supplier_contacts" USING btree ("org_id","supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_notes_org_idx" ON "supply"."supplier_notes" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "supplier_notes_org_supplier_idx" ON "supply"."supplier_notes" USING btree ("org_id","supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_documents_org_idx" ON "supply"."supplier_documents" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "supplier_documents_org_supplier_idx" ON "supply"."supplier_documents" USING btree ("org_id","supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_documents_org_file_idx" ON "supply"."supplier_documents" USING btree ("org_id","file_object_id");--> statement-breakpoint
CREATE INDEX "supplies_org_idx" ON "supply"."supplies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "supplies_org_supplier_idx" ON "supply"."supplies" USING btree ("org_id","supplier_id");--> statement-breakpoint
CREATE INDEX "supplies_org_status_idx" ON "supply"."supplies" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "supplies_org_date_idx" ON "supply"."supplies" USING btree ("org_id","business_date");--> statement-breakpoint
CREATE INDEX "supplies_org_branch_idx" ON "supply"."supplies" USING btree ("org_id","branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplies_org_supplier_invoice_idx" ON "supply"."supplies" USING btree ("org_id","supplier_id","invoice_number") WHERE status = 'received' and invoice_number is not null;--> statement-breakpoint
CREATE INDEX "supply_lines_org_idx" ON "supply"."supply_lines" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "supply_lines_org_supply_idx" ON "supply"."supply_lines" USING btree ("org_id","supply_id");--> statement-breakpoint
CREATE INDEX "supply_lines_org_sku_idx" ON "supply"."supply_lines" USING btree ("org_id","sku_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supply_lines_org_supply_sku_idx" ON "supply"."supply_lines" USING btree ("org_id","supply_id","sku_id");--> statement-breakpoint
CREATE INDEX "returns_org_idx" ON "supply"."returns" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "returns_org_supplier_idx" ON "supply"."returns" USING btree ("org_id","supplier_id");--> statement-breakpoint
CREATE INDEX "returns_org_date_idx" ON "supply"."returns" USING btree ("org_id","business_date");--> statement-breakpoint
CREATE INDEX "returns_org_branch_idx" ON "supply"."returns" USING btree ("org_id","branch_id");--> statement-breakpoint
CREATE INDEX "return_lines_org_idx" ON "supply"."return_lines" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "return_lines_org_return_idx" ON "supply"."return_lines" USING btree ("org_id","return_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supply_return_lines_org_return_sku_idx" ON "supply"."return_lines" USING btree ("org_id","return_id","sku_id");--> statement-breakpoint
CREATE INDEX "supplier_payments_org_idx" ON "supply"."supplier_payments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "supplier_payments_org_supplier_idx" ON "supply"."supplier_payments" USING btree ("org_id","supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_payments_org_status_idx" ON "supply"."supplier_payments" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "supplier_payments_org_date_idx" ON "supply"."supplier_payments" USING btree ("org_id","business_date");--> statement-breakpoint
CREATE INDEX "supplier_payments_org_branch_idx" ON "supply"."supplier_payments" USING btree ("org_id","branch_id");--> statement-breakpoint
CREATE INDEX "advance_applications_org_idx" ON "supply"."advance_applications" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "advance_applications_org_payment_idx" ON "supply"."advance_applications" USING btree ("org_id","payment_id");--> statement-breakpoint
CREATE INDEX "advance_applications_org_supply_idx" ON "supply"."advance_applications" USING btree ("org_id","supply_id");--> statement-breakpoint
CREATE UNIQUE INDEX "advance_applications_org_payment_supply_idx" ON "supply"."advance_applications" USING btree ("org_id","payment_id","supply_id");
