-- Investors, capital, distributions, withdrawals and documents (M25; architecture §7, §15).
--
-- Mirrors `packages/db/src/schema/investors/index.ts` at this milestone's assigned
-- number. The isolation policies and grants are 0059; the integrity triggers
-- Drizzle cannot express are 0060.
--
-- Two things worth noticing before the DDL.
--
-- **The two new approval types come first.** §6's maker-checker list has always
-- named "investor withdrawals and distributions", and `approvals.approval_type`
-- had no value for either — so until this runs, neither could be raised at all.
-- `ADD VALUE` is deliberately the first statement and the values are used as
-- literals **nowhere in this file**: PostgreSQL refuses a value added by
-- `ALTER TYPE` earlier in the same transaction, and the migrator runs a file in
-- one (the same reason 0011's threshold CHECKs compare the type as text).
--
-- **No balance columns.** An investor's capital and the profit owed to them are
-- derived from these rows, each of which names the immutable journal that moved
-- the money. A maintained `capital_poisha` drifts the first time a row is written
-- by a path that forgets it, and with an investor reading their own statement that
-- drift is the one failure worth designing against.

ALTER TYPE "approvals"."approval_type" ADD VALUE IF NOT EXISTS 'investor_distribution';--> statement-breakpoint
ALTER TYPE "approvals"."approval_type" ADD VALUE IF NOT EXISTS 'investor_withdrawal';--> statement-breakpoint
CREATE SCHEMA "investors";
--> statement-breakpoint
CREATE TYPE "investors"."distribution_basis" AS ENUM('share_bps', 'capital');--> statement-breakpoint
CREATE TYPE "investors"."distribution_status" AS ENUM('pending_approval', 'declared', 'rejected');--> statement-breakpoint
CREATE TYPE "investors"."investor_document_kind" AS ENUM('kyc', 'agreement', 'other');--> statement-breakpoint
CREATE TYPE "investors"."investor_status" AS ENUM('active', 'exited');--> statement-breakpoint
CREATE TYPE "investors"."withdrawal_kind" AS ENUM('capital', 'profit');--> statement-breakpoint
CREATE TYPE "investors"."withdrawal_status" AS ENUM('requested', 'reviewed', 'approved', 'paid', 'rejected');--> statement-breakpoint
CREATE TABLE "investors"."investors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"user_id" text,
	"phone_masked" text,
	"email" text,
	"share_bps" integer DEFAULT 0 NOT NULL,
	"status" "investors"."investor_status" DEFAULT 'active' NOT NULL,
	"joined_on" date NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investors_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "investors_code_length" CHECK (length("investors"."investors"."code") between 1 and 32),
	CONSTRAINT "investors_name_length" CHECK (length("investors"."investors"."name") between 1 and 160),
	CONSTRAINT "investors_phone_masked_length" CHECK ("investors"."investors"."phone_masked" is null or length("investors"."investors"."phone_masked") <= 20),
	CONSTRAINT "investors_share_bps_range" CHECK ("investors"."investors"."share_bps" between 0 and 10000),
	CONSTRAINT "investors_notes_length" CHECK ("investors"."investors"."notes" is null or length("investors"."investors"."notes") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "investors"."investments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"investor_id" uuid NOT NULL,
	"amount_poisha" bigint NOT NULL,
	"wallet_account_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"lock_in_until" date,
	"terms" text,
	"memo" text,
	"journal_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investments_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "investments_amount_positive" CHECK ("investors"."investments"."amount_poisha" > 0),
	CONSTRAINT "investments_lock_in_after_date" CHECK ("investors"."investments"."lock_in_until" is null or "investors"."investments"."lock_in_until" >= "investors"."investments"."business_date"),
	CONSTRAINT "investments_terms_length" CHECK ("investors"."investments"."terms" is null or length("investors"."investments"."terms") <= 2000),
	CONSTRAINT "investments_memo_length" CHECK ("investors"."investments"."memo" is null or length("investors"."investments"."memo") <= 500)
);
--> statement-breakpoint
CREATE TABLE "investors"."distributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"period_starts_on" date NOT NULL,
	"period_ends_on" date NOT NULL,
	"total_poisha" bigint NOT NULL,
	"basis" "investors"."distribution_basis" NOT NULL,
	"status" "investors"."distribution_status" NOT NULL,
	"approval_request_id" uuid,
	"journal_id" uuid,
	"declared_on" date,
	"memo" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "distributions_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "distributions_total_positive" CHECK ("investors"."distributions"."total_poisha" > 0),
	CONSTRAINT "distributions_period_ordered" CHECK ("investors"."distributions"."period_ends_on" >= "investors"."distributions"."period_starts_on"),
	CONSTRAINT "distributions_status_journal" CHECK (case "investors"."distributions"."status"
            when 'declared' then "investors"."distributions"."journal_id" is not null and "investors"."distributions"."declared_on" is not null
            when 'pending_approval' then "investors"."distributions"."journal_id" is null and "investors"."distributions"."approval_request_id" is not null
            else "investors"."distributions"."journal_id" is null
          end),
	CONSTRAINT "distributions_memo_length" CHECK ("investors"."distributions"."memo" is null or length("investors"."distributions"."memo") <= 500)
);
--> statement-breakpoint
CREATE TABLE "investors"."distribution_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"distribution_id" uuid NOT NULL,
	"investor_id" uuid NOT NULL,
	"weight" bigint NOT NULL,
	"amount_poisha" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "distribution_lines_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "distribution_lines_amount_not_negative" CHECK ("investors"."distribution_lines"."amount_poisha" >= 0),
	CONSTRAINT "distribution_lines_weight_not_negative" CHECK ("investors"."distribution_lines"."weight" >= 0)
);
--> statement-breakpoint
CREATE TABLE "investors"."withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"investor_id" uuid NOT NULL,
	"kind" "investors"."withdrawal_kind" NOT NULL,
	"amount_poisha" bigint NOT NULL,
	"status" "investors"."withdrawal_status" NOT NULL,
	"reason" text,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"wallet_account_id" uuid,
	"approval_request_id" uuid,
	"journal_id" uuid,
	"paid_on" date,
	"paid_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawals_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "withdrawals_amount_positive" CHECK ("investors"."withdrawals"."amount_poisha" > 0),
	CONSTRAINT "withdrawals_reason_length" CHECK ("investors"."withdrawals"."reason" is null or length("investors"."withdrawals"."reason") <= 500),
	CONSTRAINT "withdrawals_status_shape" CHECK (case "investors"."withdrawals"."status"
            when 'requested' then "investors"."withdrawals"."reviewed_by" is null and "investors"."withdrawals"."approval_request_id" is null
                 and "investors"."withdrawals"."journal_id" is null and "investors"."withdrawals"."paid_on" is null
            when 'reviewed' then "investors"."withdrawals"."reviewed_by" is not null and "investors"."withdrawals"."wallet_account_id" is not null
                 and "investors"."withdrawals"."approval_request_id" is not null and "investors"."withdrawals"."journal_id" is null
            when 'approved' then "investors"."withdrawals"."reviewed_by" is not null and "investors"."withdrawals"."wallet_account_id" is not null
                 and "investors"."withdrawals"."approval_request_id" is not null and "investors"."withdrawals"."journal_id" is null
            when 'paid' then "investors"."withdrawals"."journal_id" is not null and "investors"."withdrawals"."paid_on" is not null
                 and "investors"."withdrawals"."paid_by" is not null and "investors"."withdrawals"."wallet_account_id" is not null
            else "investors"."withdrawals"."journal_id" is null
          end),
	CONSTRAINT "withdrawals_reviewer_is_not_requester" CHECK ("investors"."withdrawals"."reviewed_by" is null or "investors"."withdrawals"."reviewed_by" <> "investors"."withdrawals"."requested_by")
);
--> statement-breakpoint
CREATE TABLE "investors"."documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"investor_id" uuid NOT NULL,
	"investment_id" uuid,
	"kind" "investors"."investor_document_kind" NOT NULL,
	"title" text NOT NULL,
	"file_id" uuid NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investor_documents_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "investor_documents_title_length" CHECK (length("investors"."documents"."title") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "investors"."investors" ADD CONSTRAINT "investors_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors"."investments" ADD CONSTRAINT "investments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors"."investments" ADD CONSTRAINT "investments_org_id_investor_id_fk" FOREIGN KEY ("org_id","investor_id") REFERENCES "investors"."investors"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors"."investments" ADD CONSTRAINT "investments_org_id_wallet_account_id_fk" FOREIGN KEY ("org_id","wallet_account_id") REFERENCES "ledger"."accounts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors"."investments" ADD CONSTRAINT "investments_org_id_journal_id_fk" FOREIGN KEY ("org_id","journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors"."distributions" ADD CONSTRAINT "distributions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors"."distributions" ADD CONSTRAINT "distributions_org_id_approval_request_id_fk" FOREIGN KEY ("org_id","approval_request_id") REFERENCES "approvals"."approval_requests"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors"."distributions" ADD CONSTRAINT "distributions_org_id_journal_id_fk" FOREIGN KEY ("org_id","journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors"."distribution_lines" ADD CONSTRAINT "distribution_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors"."distribution_lines" ADD CONSTRAINT "distribution_lines_org_id_distribution_id_fk" FOREIGN KEY ("org_id","distribution_id") REFERENCES "investors"."distributions"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors"."distribution_lines" ADD CONSTRAINT "distribution_lines_org_id_investor_id_fk" FOREIGN KEY ("org_id","investor_id") REFERENCES "investors"."investors"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors"."withdrawals" ADD CONSTRAINT "withdrawals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors"."withdrawals" ADD CONSTRAINT "withdrawals_org_id_investor_id_fk" FOREIGN KEY ("org_id","investor_id") REFERENCES "investors"."investors"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors"."withdrawals" ADD CONSTRAINT "withdrawals_org_id_wallet_account_id_fk" FOREIGN KEY ("org_id","wallet_account_id") REFERENCES "ledger"."accounts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors"."withdrawals" ADD CONSTRAINT "withdrawals_org_id_approval_request_id_fk" FOREIGN KEY ("org_id","approval_request_id") REFERENCES "approvals"."approval_requests"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors"."withdrawals" ADD CONSTRAINT "withdrawals_org_id_journal_id_fk" FOREIGN KEY ("org_id","journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors"."documents" ADD CONSTRAINT "documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors"."documents" ADD CONSTRAINT "investor_documents_org_id_investor_id_fk" FOREIGN KEY ("org_id","investor_id") REFERENCES "investors"."investors"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors"."documents" ADD CONSTRAINT "investor_documents_org_id_investment_id_fk" FOREIGN KEY ("org_id","investment_id") REFERENCES "investors"."investments"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors"."documents" ADD CONSTRAINT "investor_documents_org_id_file_id_fk" FOREIGN KEY ("org_id","file_id") REFERENCES "files"."objects"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "investors_org_idx" ON "investors"."investors" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "investors_org_status_idx" ON "investors"."investors" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "investors_org_code_idx" ON "investors"."investors" USING btree ("org_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "investors_org_user_idx" ON "investors"."investors" USING btree ("org_id","user_id") WHERE user_id is not null;--> statement-breakpoint
CREATE INDEX "investments_org_idx" ON "investors"."investments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "investments_org_investor_idx" ON "investors"."investments" USING btree ("org_id","investor_id","business_date");--> statement-breakpoint
CREATE INDEX "distributions_org_idx" ON "investors"."distributions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "distributions_org_status_idx" ON "investors"."distributions" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "distributions_org_period_idx" ON "investors"."distributions" USING btree ("org_id","period_starts_on","period_ends_on") WHERE status <> 'rejected';--> statement-breakpoint
CREATE INDEX "distribution_lines_org_idx" ON "investors"."distribution_lines" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "distribution_lines_org_investor_idx" ON "investors"."distribution_lines" USING btree ("org_id","investor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "distribution_lines_org_distribution_investor_idx" ON "investors"."distribution_lines" USING btree ("org_id","distribution_id","investor_id");--> statement-breakpoint
CREATE INDEX "withdrawals_org_idx" ON "investors"."withdrawals" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "withdrawals_org_investor_idx" ON "investors"."withdrawals" USING btree ("org_id","investor_id");--> statement-breakpoint
CREATE INDEX "withdrawals_org_status_idx" ON "investors"."withdrawals" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "investor_documents_org_idx" ON "investors"."documents" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "investor_documents_org_investor_idx" ON "investors"."documents" USING btree ("org_id","investor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "investor_documents_org_file_idx" ON "investors"."documents" USING btree ("org_id","file_id");
