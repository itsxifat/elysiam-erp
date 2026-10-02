CREATE TABLE "sales"."order_advances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"method" text NOT NULL,
	"transaction_ref" text NOT NULL,
	"amount_poisha" bigint NOT NULL,
	"applied_poisha" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"reject_reason" text,
	"wallet_account_id" uuid,
	"received_journal_id" uuid,
	"kept_poisha" bigint DEFAULT 0 NOT NULL,
	"kept_journal_id" uuid,
	"settled_by" text,
	"settled_at" timestamp with time zone,
	"refund_journal_id" uuid,
	"refund_wallet_account_id" uuid,
	"refund_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_advances_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "order_advances_method" CHECK ("sales"."order_advances"."method" in ('bkash', 'nagad', 'bank')),
	CONSTRAINT "order_advances_ref_format" CHECK ("sales"."order_advances"."transaction_ref" ~ '^[A-Z0-9]{6,30}$'),
	CONSTRAINT "order_advances_amounts" CHECK ("sales"."order_advances"."amount_poisha" > 0 and "sales"."order_advances"."amount_poisha" <= 9000000000000000
          and "sales"."order_advances"."applied_poisha" >= 0 and "sales"."order_advances"."kept_poisha" >= 0
          and "sales"."order_advances"."applied_poisha" + "sales"."order_advances"."kept_poisha" <= "sales"."order_advances"."amount_poisha"),
	CONSTRAINT "order_advances_status" CHECK ("sales"."order_advances"."status" in ('pending', 'rejected', 'verified', 'applied', 'refund_due', 'refunded', 'forfeited')),
	CONSTRAINT "order_advances_four_eyes" CHECK (("sales"."order_advances"."status" = 'pending') = ("sales"."order_advances"."decided_by" is null)
          and ("sales"."order_advances"."decided_by" is null or "sales"."order_advances"."decided_by" <> "sales"."order_advances"."recorded_by")
          and ("sales"."order_advances"."decided_by" is null) = ("sales"."order_advances"."decided_at" is null)),
	CONSTRAINT "order_advances_rejected_has_reason" CHECK (("sales"."order_advances"."status" = 'rejected') = ("sales"."order_advances"."reject_reason" is not null)),
	CONSTRAINT "order_advances_received_journal" CHECK (("sales"."order_advances"."status" in ('pending', 'rejected')) = ("sales"."order_advances"."received_journal_id" is null)
          and ("sales"."order_advances"."received_journal_id" is null) = ("sales"."order_advances"."wallet_account_id" is null)),
	CONSTRAINT "order_advances_kept" CHECK (("sales"."order_advances"."kept_poisha" > 0) = ("sales"."order_advances"."kept_journal_id" is not null)
          and ("sales"."order_advances"."kept_poisha" = 0 or "sales"."order_advances"."status" in ('forfeited', 'refund_due', 'refunded'))),
	CONSTRAINT "order_advances_where_the_money_is" CHECK (case "sales"."order_advances"."status"
            when 'pending' then "sales"."order_advances"."applied_poisha" = 0
            when 'rejected' then "sales"."order_advances"."applied_poisha" = 0
            when 'verified' then "sales"."order_advances"."applied_poisha" < "sales"."order_advances"."amount_poisha"
            when 'applied' then "sales"."order_advances"."applied_poisha" = "sales"."order_advances"."amount_poisha"
            when 'forfeited' then "sales"."order_advances"."kept_poisha" > 0
              and "sales"."order_advances"."applied_poisha" + "sales"."order_advances"."kept_poisha" = "sales"."order_advances"."amount_poisha"
            else "sales"."order_advances"."applied_poisha" + "sales"."order_advances"."kept_poisha" < "sales"."order_advances"."amount_poisha"
          end),
	CONSTRAINT "order_advances_settled" CHECK (("sales"."order_advances"."status" in ('refunded', 'forfeited')) = ("sales"."order_advances"."settled_by" is not null)
          and ("sales"."order_advances"."settled_by" is null) = ("sales"."order_advances"."settled_at" is null)
          and ("sales"."order_advances"."status" = 'refunded') = ("sales"."order_advances"."refund_journal_id" is not null)
          and ("sales"."order_advances"."status" = 'refunded') = ("sales"."order_advances"."refund_wallet_account_id" is not null)
          and ("sales"."order_advances"."refund_ref" is null or "sales"."order_advances"."status" = 'refunded')),
	CONSTRAINT "order_advances_text_lengths" CHECK (("sales"."order_advances"."note" is null or length("sales"."order_advances"."note") <= 500)
          and ("sales"."order_advances"."reject_reason" is null or length("sales"."order_advances"."reject_reason") between 1 and 500)
          and ("sales"."order_advances"."refund_ref" is null or "sales"."order_advances"."refund_ref" ~ '^[A-Z0-9]{6,30}$'))
);
--> statement-breakpoint
CREATE TABLE "sales"."order_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reason_code" text NOT NULL,
	"note" text,
	"business_date" date NOT NULL,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_returns_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "order_returns_kind" CHECK ("sales"."order_returns"."kind" in ('return', 'exchange')),
	CONSTRAINT "order_returns_reason_code" CHECK ("sales"."order_returns"."reason_code" in ('customer_refused', 'customer_unreachable', 'wrong_address', 'changed_mind', 'size_issue', 'quality_issue', 'wrong_item', 'damaged_in_transit', 'late_delivery', 'price_dispute', 'other')),
	CONSTRAINT "order_returns_note_length" CHECK ("sales"."order_returns"."note" is null or length("sales"."order_returns"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "sales"."order_advances" ADD CONSTRAINT "order_advances_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."order_advances" ADD CONSTRAINT "order_advances_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."order_advances" ADD CONSTRAINT "order_advances_org_id_wallet_account_id_fk" FOREIGN KEY ("org_id","wallet_account_id") REFERENCES "ledger"."accounts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."order_advances" ADD CONSTRAINT "order_advances_org_id_refund_wallet_account_id_fk" FOREIGN KEY ("org_id","refund_wallet_account_id") REFERENCES "ledger"."accounts"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."order_advances" ADD CONSTRAINT "order_advances_org_id_received_journal_id_fk" FOREIGN KEY ("org_id","received_journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."order_advances" ADD CONSTRAINT "order_advances_org_id_kept_journal_id_fk" FOREIGN KEY ("org_id","kept_journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."order_advances" ADD CONSTRAINT "order_advances_org_id_refund_journal_id_fk" FOREIGN KEY ("org_id","refund_journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."order_returns" ADD CONSTRAINT "order_returns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales"."order_returns" ADD CONSTRAINT "order_returns_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_advances_org_idx" ON "sales"."order_advances" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "order_advances_org_order_idx" ON "sales"."order_advances" USING btree ("org_id","order_id");--> statement-breakpoint
CREATE INDEX "order_advances_org_status_idx" ON "sales"."order_advances" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "order_advances_org_live_ref_idx" ON "sales"."order_advances" USING btree ("org_id","method","transaction_ref") WHERE "sales"."order_advances"."status" <> 'rejected';--> statement-breakpoint
CREATE INDEX "order_returns_org_idx" ON "sales"."order_returns" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_returns_org_order_idx" ON "sales"."order_returns" USING btree ("org_id","order_id");--> statement-breakpoint
CREATE INDEX "order_returns_org_date_idx" ON "sales"."order_returns" USING btree ("org_id","business_date");