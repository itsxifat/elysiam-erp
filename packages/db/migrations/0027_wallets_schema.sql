-- Wallets, cash entries, transfers and daily closings (M08; architecture §6, §7).
--
-- Generated from `packages/db/src/schema/wallets/index.ts` by drizzle-kit and
-- placed at this milestone's assigned number. The isolation policies, the
-- grants and the integrity triggers Drizzle cannot express follow in 0028 and
-- 0029; the analytics role's cross-org read for the super-admin consolidated
-- view is 0030.
--
-- The absence worth noting: there is no `balance_poisha` column on any of these
-- tables. A wallet's balance is derived from `ledger.journal_lines` on every
-- read. A maintained column would drift the first time a journal was posted by
-- a path that forgot to update it, and the drift stays silent until somebody
-- counts the till (M08 check 1).

CREATE SCHEMA "wallets";
--> statement-breakpoint
CREATE TYPE "wallets"."cash_entry_kind" AS ENUM('cash_in', 'cash_out', 'petty_cash');--> statement-breakpoint
CREATE TYPE "wallets"."cash_entry_status" AS ENUM('pending_approval', 'posted', 'rejected');--> statement-breakpoint
CREATE TYPE "wallets"."closing_status" AS ENUM('balanced', 'pending_approval', 'posted', 'rejected');--> statement-breakpoint
CREATE TABLE "wallets"."cash_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"branch_id" uuid,
	"wallet_id" uuid NOT NULL,
	"kind" "wallets"."cash_entry_kind" NOT NULL,
	"status" "wallets"."cash_entry_status" NOT NULL,
	"category_account_id" uuid NOT NULL,
	"amount_poisha" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"memo" text,
	"receipt_file_id" uuid,
	"approval_request_id" uuid,
	"journal_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_entries_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "cash_entries_amount_positive" CHECK ("wallets"."cash_entries"."amount_poisha" > 0),
	CONSTRAINT "cash_entries_petty_cash_has_receipt" CHECK ("wallets"."cash_entries"."kind" <> 'petty_cash' or "wallets"."cash_entries"."receipt_file_id" is not null),
	CONSTRAINT "cash_entries_status_journal" CHECK (case "wallets"."cash_entries"."status"
            when 'posted' then "wallets"."cash_entries"."journal_id" is not null
            when 'pending_approval' then "wallets"."cash_entries"."journal_id" is null and "wallets"."cash_entries"."approval_request_id" is not null
            else "wallets"."cash_entries"."journal_id" is null
          end),
	CONSTRAINT "cash_entries_memo_length" CHECK ("wallets"."cash_entries"."memo" is null or length("wallets"."cash_entries"."memo") <= 500)
);
--> statement-breakpoint
CREATE TABLE "wallets"."wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"ledger_account_id" uuid NOT NULL,
	"branch_id" uuid,
	"provider" text,
	"account_ref_masked" text,
	"requires_daily_closing" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "wallets_provider_length" CHECK ("wallets"."wallets"."provider" is null or length("wallets"."wallets"."provider") between 1 and 80),
	CONSTRAINT "wallets_account_ref_length" CHECK ("wallets"."wallets"."account_ref_masked" is null or length("wallets"."wallets"."account_ref_masked") <= 40)
);
--> statement-breakpoint
CREATE TABLE "wallets"."closings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"branch_id" uuid,
	"wallet_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"expected_poisha" bigint NOT NULL,
	"counted_poisha" bigint NOT NULL,
	"variance_poisha" bigint NOT NULL,
	"status" "wallets"."closing_status" NOT NULL,
	"approval_request_id" uuid,
	"journal_id" uuid,
	"counted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_closings_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "wallet_closings_variance_is_difference" CHECK ("wallets"."closings"."variance_poisha" = "wallets"."closings"."counted_poisha" - "wallets"."closings"."expected_poisha"),
	CONSTRAINT "wallet_closings_counted_not_negative" CHECK ("wallets"."closings"."counted_poisha" >= 0),
	CONSTRAINT "wallet_closings_status_shape" CHECK (case "wallets"."closings"."status"
            when 'balanced' then "wallets"."closings"."variance_poisha" = 0 and "wallets"."closings"."journal_id" is null
            when 'posted' then "wallets"."closings"."variance_poisha" <> 0 and "wallets"."closings"."journal_id" is not null
            when 'pending_approval' then "wallets"."closings"."variance_poisha" <> 0 and "wallets"."closings"."journal_id" is null
                 and "wallets"."closings"."approval_request_id" is not null
            else "wallets"."closings"."journal_id" is null
          end)
);
--> statement-breakpoint
CREATE TABLE "wallets"."transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"from_wallet_id" uuid NOT NULL,
	"to_wallet_id" uuid NOT NULL,
	"amount_poisha" bigint NOT NULL,
	"charge_poisha" bigint DEFAULT 0 NOT NULL,
	"charge_account_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"memo" text,
	"journal_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_transfers_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "wallet_transfers_amount_positive" CHECK ("wallets"."transfers"."amount_poisha" > 0),
	CONSTRAINT "wallet_transfers_charge_not_negative" CHECK ("wallets"."transfers"."charge_poisha" >= 0),
	CONSTRAINT "wallet_transfers_distinct_wallets" CHECK ("wallets"."transfers"."from_wallet_id" <> "wallets"."transfers"."to_wallet_id"),
	CONSTRAINT "wallet_transfers_charge_has_account" CHECK (("wallets"."transfers"."charge_poisha" > 0) = ("wallets"."transfers"."charge_account_id" is not null)),
	CONSTRAINT "wallet_transfers_memo_length" CHECK ("wallets"."transfers"."memo" is null or length("wallets"."transfers"."memo") <= 500)
);
--> statement-breakpoint
ALTER TABLE "wallets"."cash_entries" ADD CONSTRAINT "cash_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets"."cash_entries" ADD CONSTRAINT "cash_entries_org_id_wallet_id_fk" FOREIGN KEY ("org_id","wallet_id") REFERENCES "wallets"."wallets"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets"."cash_entries" ADD CONSTRAINT "cash_entries_org_id_category_account_id_fk" FOREIGN KEY ("org_id","category_account_id") REFERENCES "ledger"."accounts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets"."cash_entries" ADD CONSTRAINT "cash_entries_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets"."cash_entries" ADD CONSTRAINT "cash_entries_org_id_receipt_file_id_fk" FOREIGN KEY ("org_id","receipt_file_id") REFERENCES "files"."objects"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets"."cash_entries" ADD CONSTRAINT "cash_entries_org_id_approval_request_id_fk" FOREIGN KEY ("org_id","approval_request_id") REFERENCES "approvals"."approval_requests"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets"."cash_entries" ADD CONSTRAINT "cash_entries_org_id_journal_id_fk" FOREIGN KEY ("org_id","journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets"."wallets" ADD CONSTRAINT "wallets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets"."wallets" ADD CONSTRAINT "wallets_org_id_ledger_account_id_fk" FOREIGN KEY ("org_id","ledger_account_id") REFERENCES "ledger"."accounts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets"."wallets" ADD CONSTRAINT "wallets_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets"."closings" ADD CONSTRAINT "closings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets"."closings" ADD CONSTRAINT "wallet_closings_org_id_wallet_id_fk" FOREIGN KEY ("org_id","wallet_id") REFERENCES "wallets"."wallets"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets"."closings" ADD CONSTRAINT "wallet_closings_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets"."closings" ADD CONSTRAINT "wallet_closings_org_id_approval_request_id_fk" FOREIGN KEY ("org_id","approval_request_id") REFERENCES "approvals"."approval_requests"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets"."closings" ADD CONSTRAINT "wallet_closings_org_id_journal_id_fk" FOREIGN KEY ("org_id","journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets"."transfers" ADD CONSTRAINT "transfers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets"."transfers" ADD CONSTRAINT "wallet_transfers_org_id_from_wallet_id_fk" FOREIGN KEY ("org_id","from_wallet_id") REFERENCES "wallets"."wallets"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets"."transfers" ADD CONSTRAINT "wallet_transfers_org_id_to_wallet_id_fk" FOREIGN KEY ("org_id","to_wallet_id") REFERENCES "wallets"."wallets"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets"."transfers" ADD CONSTRAINT "wallet_transfers_org_id_charge_account_id_fk" FOREIGN KEY ("org_id","charge_account_id") REFERENCES "ledger"."accounts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets"."transfers" ADD CONSTRAINT "wallet_transfers_org_id_journal_id_fk" FOREIGN KEY ("org_id","journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_entries_org_idx" ON "wallets"."cash_entries" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "cash_entries_org_wallet_date_idx" ON "wallets"."cash_entries" USING btree ("org_id","wallet_id","business_date");--> statement-breakpoint
CREATE INDEX "cash_entries_org_branch_idx" ON "wallets"."cash_entries" USING btree ("org_id","branch_id");--> statement-breakpoint
CREATE INDEX "cash_entries_org_status_idx" ON "wallets"."cash_entries" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "wallets_org_idx" ON "wallets"."wallets" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "wallets_org_branch_idx" ON "wallets"."wallets" USING btree ("org_id","branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_org_account_idx" ON "wallets"."wallets" USING btree ("org_id","ledger_account_id");--> statement-breakpoint
CREATE INDEX "wallet_closings_org_idx" ON "wallets"."closings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "wallet_closings_org_branch_idx" ON "wallets"."closings" USING btree ("org_id","branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_closings_org_wallet_date_idx" ON "wallets"."closings" USING btree ("org_id","wallet_id","business_date");--> statement-breakpoint
CREATE INDEX "wallet_transfers_org_idx" ON "wallets"."transfers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "wallet_transfers_org_date_idx" ON "wallets"."transfers" USING btree ("org_id","business_date");
