ALTER TABLE "loans"."loans" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "loans"."loans" ADD COLUMN "voided_by" text;--> statement-breakpoint
ALTER TABLE "loans"."loans" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "loans"."loans" ADD COLUMN "void_journal_id" uuid;--> statement-breakpoint
ALTER TABLE "loans"."loans" ADD CONSTRAINT "loans_org_id_void_journal_id_fk" FOREIGN KEY ("org_id","void_journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "loan_payments_org_journal_idx" ON "loans"."payments" USING btree ("org_id","journal_id") WHERE journal_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "loans_org_received_journal_idx" ON "loans"."loans" USING btree ("org_id","received_journal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loans_org_void_journal_idx" ON "loans"."loans" USING btree ("org_id","void_journal_id") WHERE void_journal_id is not null;--> statement-breakpoint
ALTER TABLE "loans"."loans" ADD CONSTRAINT "loans_void_complete" CHECK (num_nonnulls("loans"."loans"."voided_at", "loans"."loans"."voided_by", "loans"."loans"."void_reason", "loans"."loans"."void_journal_id") in (0, 4));--> statement-breakpoint
ALTER TABLE "loans"."loans" ADD CONSTRAINT "loans_void_reason_length" CHECK ("loans"."loans"."void_reason" is null or length("loans"."loans"."void_reason") between 1 and 500);