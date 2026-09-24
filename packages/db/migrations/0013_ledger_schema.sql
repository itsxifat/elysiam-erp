CREATE SCHEMA "ledger";
--> statement-breakpoint
CREATE TYPE "ledger"."account_class" AS ENUM('asset', 'liability', 'equity', 'income', 'expense');--> statement-breakpoint
CREATE TYPE "ledger"."account_subtype" AS ENUM('wallet_cash', 'wallet_bank', 'wallet_bkash', 'wallet_mfs_other', 'courier_receivable', 'inventory', 'goods_in_transit', 'supplier_advance', 'employee_loan_receivable', 'other_receivable', 'supplier_payable', 'reseller_payable', 'salary_payable', 'investor_payable', 'loan_payable', 'customer_advance', 'other_payable', 'owner_capital', 'investor_capital', 'retained_earnings', 'profit_distribution', 'sales_revenue', 'sales_discounts', 'delivery_charge_income', 'other_income', 'inventory_adjustment_gain', 'cogs', 'courier_charges', 'return_charges', 'ad_spend', 'salary_expense', 'bonus_expense', 'interest_expense', 'inventory_writeoff', 'purchase_price_variance', 'cash_over_short', 'bank_charges', 'operating_expense');--> statement-breakpoint
CREATE TYPE "ledger"."normal_balance" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "ledger"."party_type" AS ENUM('supplier', 'courier', 'reseller', 'investor', 'employee', 'lender');--> statement-breakpoint
CREATE TYPE "ledger"."period_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TABLE "ledger"."journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"journal_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"branch_id" uuid,
	"party_type" "ledger"."party_type",
	"party_id" uuid,
	"debit_poisha" bigint DEFAULT 0 NOT NULL,
	"credit_poisha" bigint DEFAULT 0 NOT NULL,
	"memo" text,
	CONSTRAINT "journal_lines_debit_not_negative" CHECK ("ledger"."journal_lines"."debit_poisha" >= 0),
	CONSTRAINT "journal_lines_credit_not_negative" CHECK ("ledger"."journal_lines"."credit_poisha" >= 0),
	CONSTRAINT "journal_lines_one_side" CHECK (("ledger"."journal_lines"."debit_poisha" > 0) <> ("ledger"."journal_lines"."credit_poisha" > 0)),
	CONSTRAINT "journal_lines_party_complete" CHECK (("ledger"."journal_lines"."party_type" is null) = ("ledger"."journal_lines"."party_id" is null)),
	CONSTRAINT "journal_lines_memo_length" CHECK ("ledger"."journal_lines"."memo" is null or length("ledger"."journal_lines"."memo") <= 500)
);
--> statement-breakpoint
CREATE TABLE "ledger"."journals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"memo" text,
	"reverses_journal_id" uuid,
	"content_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_txid" "xid8" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journals_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "journals_idempotency_key_matches_source" CHECK ("ledger"."journals"."idempotency_key" = "ledger"."journals"."source_type" || ':' || "ledger"."journals"."source_id"::text || ':' || split_part("ledger"."journals"."idempotency_key", ':', 3)
          and split_part("ledger"."journals"."idempotency_key", ':', 3) ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "journals_source_type_format" CHECK ("ledger"."journals"."source_type" ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "journals_memo_length" CHECK ("ledger"."journals"."memo" is null or length("ledger"."journals"."memo") <= 500),
	CONSTRAINT "journals_not_self_reversal" CHECK ("ledger"."journals"."reverses_journal_id" <> "ledger"."journals"."id")
);
--> statement-breakpoint
CREATE TABLE "ledger"."periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" "ledger"."period_status" NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"reopened_at" timestamp with time zone,
	"reopen_approval_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "periods_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "periods_whole_month" CHECK (extract(day from "ledger"."periods"."starts_on") = 1
          and "ledger"."periods"."ends_on" = ("ledger"."periods"."starts_on" + interval '1 month' - interval '1 day')::date),
	CONSTRAINT "periods_closed_has_closer" CHECK ("ledger"."periods"."status" <> 'closed' or ("ledger"."periods"."closed_at" is not null and "ledger"."periods"."closed_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "ledger"."accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"class" "ledger"."account_class" NOT NULL,
	"subtype" "ledger"."account_subtype" NOT NULL,
	"normal_balance" "ledger"."normal_balance" NOT NULL,
	"branch_id" uuid,
	"party_type" "ledger"."party_type",
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "accounts_wallet_cash_has_branch" CHECK ("ledger"."accounts"."subtype" <> 'wallet_cash' or "ledger"."accounts"."branch_id" is not null),
	CONSTRAINT "accounts_code_format" CHECK ("ledger"."accounts"."code" ~ '^[0-9A-Z][0-9A-Z-]{0,31}$')
);
--> statement-breakpoint
ALTER TABLE "ledger"."journal_lines" ADD CONSTRAINT "journal_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."journal_lines" ADD CONSTRAINT "journal_lines_org_id_journal_id_fk" FOREIGN KEY ("org_id","journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."journal_lines" ADD CONSTRAINT "journal_lines_org_id_account_id_fk" FOREIGN KEY ("org_id","account_id") REFERENCES "ledger"."accounts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."journal_lines" ADD CONSTRAINT "journal_lines_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."journals" ADD CONSTRAINT "journals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."journals" ADD CONSTRAINT "journals_org_id_reverses_journal_id_fk" FOREIGN KEY ("org_id","reverses_journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."periods" ADD CONSTRAINT "periods_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."periods" ADD CONSTRAINT "periods_org_id_reopen_approval_id_fk" FOREIGN KEY ("org_id","reopen_approval_id") REFERENCES "approvals"."approval_requests"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."accounts" ADD CONSTRAINT "accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."accounts" ADD CONSTRAINT "accounts_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_lines_org_idx" ON "ledger"."journal_lines" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_lines_journal_line_idx" ON "ledger"."journal_lines" USING btree ("journal_id","line_no");--> statement-breakpoint
CREATE INDEX "journal_lines_org_journal_idx" ON "ledger"."journal_lines" USING btree ("org_id","journal_id");--> statement-breakpoint
CREATE INDEX "journal_lines_org_account_idx" ON "ledger"."journal_lines" USING btree ("org_id","account_id");--> statement-breakpoint
CREATE INDEX "journal_lines_org_branch_idx" ON "ledger"."journal_lines" USING btree ("org_id","branch_id");--> statement-breakpoint
CREATE INDEX "journal_lines_org_party_idx" ON "ledger"."journal_lines" USING btree ("org_id","party_type","party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journals_org_idempotency_key_idx" ON "ledger"."journals" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "journals_org_idx" ON "ledger"."journals" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "journals_org_business_date_idx" ON "ledger"."journals" USING btree ("org_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "journals_reverses_journal_idx" ON "ledger"."journals" USING btree ("org_id","reverses_journal_id") WHERE "ledger"."journals"."reverses_journal_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "periods_org_starts_on_idx" ON "ledger"."periods" USING btree ("org_id","starts_on");--> statement-breakpoint
CREATE INDEX "periods_org_idx" ON "ledger"."periods" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_org_code_idx" ON "ledger"."accounts" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "accounts_org_idx" ON "ledger"."accounts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "accounts_org_subtype_idx" ON "ledger"."accounts" USING btree ("org_id","subtype");--> statement-breakpoint
CREATE INDEX "accounts_branch_idx" ON "ledger"."accounts" USING btree ("org_id","branch_id");