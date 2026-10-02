CREATE SCHEMA "loans";
--> statement-breakpoint
ALTER TYPE "approvals"."approval_type" ADD VALUE 'loan_repayment';--> statement-breakpoint
CREATE TABLE "loans"."instalments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"due_on" date NOT NULL,
	"principal_poisha" bigint NOT NULL,
	"interest_poisha" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_instalments_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "loan_instalments_seq_positive" CHECK ("loans"."instalments"."seq" >= 1),
	CONSTRAINT "loan_instalments_parts" CHECK ("loans"."instalments"."principal_poisha" >= 0 and "loans"."instalments"."interest_poisha" >= 0
        and "loans"."instalments"."principal_poisha" + "loans"."instalments"."interest_poisha" > 0)
);
--> statement-breakpoint
CREATE TABLE "loans"."payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"instalment_id" uuid NOT NULL,
	"wallet_account_id" uuid NOT NULL,
	"principal_poisha" bigint NOT NULL,
	"interest_poisha" bigint NOT NULL,
	"status" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"approval_request_id" uuid,
	"journal_id" uuid,
	"memo" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_payments_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "loan_payments_status" CHECK ("loans"."payments"."status" in ('pending_approval', 'posted', 'rejected')),
	CONSTRAINT "loan_payments_status_journal" CHECK (("loans"."payments"."status" = 'posted') = ("loans"."payments"."journal_id" is not null)),
	CONSTRAINT "loan_payments_pending_has_approval" CHECK ("loans"."payments"."status" <> 'pending_approval' or "loans"."payments"."approval_request_id" is not null),
	CONSTRAINT "loan_payments_parts" CHECK ("loans"."payments"."principal_poisha" >= 0 and "loans"."payments"."interest_poisha" >= 0
        and "loans"."payments"."principal_poisha" + "loans"."payments"."interest_poisha" > 0),
	CONSTRAINT "loan_payments_memo_length" CHECK ("loans"."payments"."memo" is null or length("loans"."payments"."memo") <= 500)
);
--> statement-breakpoint
CREATE TABLE "loans"."reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"instalment_id" uuid NOT NULL,
	"reminded_on" date NOT NULL,
	"sms_state" text NOT NULL,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_reminders_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "loan_reminders_sms_state" CHECK ("loans"."reminders"."sms_state" in ('queued', 'suppressed', 'no_phone', 'failed')),
	CONSTRAINT "loan_reminders_sms_message" CHECK (("loans"."reminders"."sms_state" in ('queued', 'suppressed')) = ("loans"."reminders"."message_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "loans"."loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"lender_id" uuid NOT NULL,
	"reference" text,
	"principal_poisha" bigint NOT NULL,
	"rate_bps" integer NOT NULL,
	"method" text NOT NULL,
	"tenure_months" integer NOT NULL,
	"received_on" date NOT NULL,
	"first_due_on" date NOT NULL,
	"reminder_days" integer DEFAULT 3 NOT NULL,
	"reminder_phone" text,
	"wallet_account_id" uuid NOT NULL,
	"received_journal_id" uuid NOT NULL,
	"memo" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loans_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "loans_principal_positive" CHECK ("loans"."loans"."principal_poisha" > 0),
	CONSTRAINT "loans_rate_range" CHECK ("loans"."loans"."rate_bps" between 0 and 10000),
	CONSTRAINT "loans_method" CHECK ("loans"."loans"."method" in ('flat', 'reducing')),
	CONSTRAINT "loans_tenure_range" CHECK ("loans"."loans"."tenure_months" between 1 and 360),
	CONSTRAINT "loans_reminder_days_range" CHECK ("loans"."loans"."reminder_days" between 0 and 30),
	CONSTRAINT "loans_reminder_phone_e164" CHECK ("loans"."loans"."reminder_phone" is null or "loans"."loans"."reminder_phone" ~ '^\+8801[3-9][0-9]{8}$'),
	CONSTRAINT "loans_first_due_after_receipt" CHECK ("loans"."loans"."first_due_on" > "loans"."loans"."received_on"),
	CONSTRAINT "loans_reference_length" CHECK ("loans"."loans"."reference" is null or length("loans"."loans"."reference") <= 80),
	CONSTRAINT "loans_memo_length" CHECK ("loans"."loans"."memo" is null or length("loans"."loans"."memo") <= 500)
);
--> statement-breakpoint
CREATE TABLE "loans"."lenders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lenders_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "lenders_name_length" CHECK (length("loans"."lenders"."name") between 1 and 160),
	CONSTRAINT "lenders_kind" CHECK ("loans"."lenders"."kind" in ('bank', 'person', 'other')),
	CONSTRAINT "lenders_notes_length" CHECK ("loans"."lenders"."notes" is null or length("loans"."lenders"."notes") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "loans"."instalments" ADD CONSTRAINT "instalments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans"."instalments" ADD CONSTRAINT "loan_instalments_org_id_loan_id_fk" FOREIGN KEY ("org_id","loan_id") REFERENCES "loans"."loans"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans"."payments" ADD CONSTRAINT "payments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans"."payments" ADD CONSTRAINT "loan_payments_org_id_loan_id_fk" FOREIGN KEY ("org_id","loan_id") REFERENCES "loans"."loans"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans"."payments" ADD CONSTRAINT "loan_payments_org_id_instalment_id_fk" FOREIGN KEY ("org_id","instalment_id") REFERENCES "loans"."instalments"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans"."payments" ADD CONSTRAINT "loan_payments_org_id_wallet_account_id_fk" FOREIGN KEY ("org_id","wallet_account_id") REFERENCES "ledger"."accounts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans"."payments" ADD CONSTRAINT "loan_payments_org_id_approval_request_id_fk" FOREIGN KEY ("org_id","approval_request_id") REFERENCES "approvals"."approval_requests"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans"."payments" ADD CONSTRAINT "loan_payments_org_id_journal_id_fk" FOREIGN KEY ("org_id","journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans"."reminders" ADD CONSTRAINT "reminders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans"."reminders" ADD CONSTRAINT "loan_reminders_org_id_loan_id_fk" FOREIGN KEY ("org_id","loan_id") REFERENCES "loans"."loans"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans"."reminders" ADD CONSTRAINT "loan_reminders_org_id_instalment_id_fk" FOREIGN KEY ("org_id","instalment_id") REFERENCES "loans"."instalments"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans"."reminders" ADD CONSTRAINT "loan_reminders_org_id_message_id_fk" FOREIGN KEY ("org_id","message_id") REFERENCES "notify"."messages"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans"."loans" ADD CONSTRAINT "loans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans"."loans" ADD CONSTRAINT "loans_org_id_lender_id_fk" FOREIGN KEY ("org_id","lender_id") REFERENCES "loans"."lenders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans"."loans" ADD CONSTRAINT "loans_org_id_wallet_account_id_fk" FOREIGN KEY ("org_id","wallet_account_id") REFERENCES "ledger"."accounts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans"."loans" ADD CONSTRAINT "loans_org_id_received_journal_id_fk" FOREIGN KEY ("org_id","received_journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans"."lenders" ADD CONSTRAINT "lenders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loan_instalments_org_idx" ON "loans"."instalments" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_instalments_org_loan_seq_idx" ON "loans"."instalments" USING btree ("org_id","loan_id","seq");--> statement-breakpoint
CREATE INDEX "loan_instalments_org_due_idx" ON "loans"."instalments" USING btree ("org_id","due_on");--> statement-breakpoint
CREATE INDEX "loan_payments_org_idx" ON "loans"."payments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "loan_payments_org_loan_idx" ON "loans"."payments" USING btree ("org_id","loan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_payments_org_instalment_live_idx" ON "loans"."payments" USING btree ("org_id","instalment_id") WHERE status <> 'rejected';--> statement-breakpoint
CREATE INDEX "loan_reminders_org_idx" ON "loans"."reminders" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_reminders_org_instalment_idx" ON "loans"."reminders" USING btree ("org_id","instalment_id");--> statement-breakpoint
CREATE INDEX "loans_org_idx" ON "loans"."loans" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "loans_org_lender_idx" ON "loans"."loans" USING btree ("org_id","lender_id");--> statement-breakpoint
CREATE INDEX "lenders_org_idx" ON "loans"."lenders" USING btree ("org_id");