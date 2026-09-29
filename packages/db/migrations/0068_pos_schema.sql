-- Branches and showroom POS (M23; architecture §14, §7).
--
-- Generated from `packages/db/src/schema/pos/index.ts` by drizzle-kit (in a drift
-- probe, never against this folder) and placed at this milestone's assigned
-- number. Isolation policies and grants follow in 0069; the integrity triggers
-- Drizzle cannot express are 0070.
--
-- Two shapes worth noting before reading on:
--
-- * **The till's documents keep the till's ids.** `sales.id`, `returns.id`,
--   `shifts.id` and `branch_closings.id` have no default: the PWA generates them,
--   offline if need be, and every re-sync of the same sale lands on the same row,
--   the same stock movements and the same journal key (`pos_sale:<id>:sold`).
-- * **No till balance anywhere.** Cash is derived from `ledger.journal_lines`, as
--   in M08. The only cost kept is what each sold unit left the shelf at, named so
--   `serializeFor` strips it from roles without `read:cost` (invariant 5, D-014).

CREATE SCHEMA "pos";
--> statement-breakpoint
CREATE TYPE "pos"."document_kind" AS ENUM('sale', 'return');
--> statement-breakpoint
CREATE TYPE "pos"."document_status" AS ENUM('posted', 'held', 'voided');
--> statement-breakpoint
CREATE TYPE "pos"."hold_reason" AS ENUM('stock_shortfall', 'price_mismatch', 'discount_above_ceiling', 'shift_closed', 'outside_posting_window', 'sku_unavailable', 'sale_not_posted', 'return_mismatch');
--> statement-breakpoint
CREATE TYPE "pos"."review_status" AS ENUM('open', 'posted', 'voided');
--> statement-breakpoint
CREATE TYPE "pos"."shift_status" AS ENUM('open', 'closed');
--> statement-breakpoint
CREATE TYPE "pos"."tender" AS ENUM('cash', 'bkash', 'card');
--> statement-breakpoint
CREATE TABLE "pos"."branch_closing_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"branch_closing_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"wallet_closing_id" uuid NOT NULL,
	"counted_poisha" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_branch_closing_wallets_counted" CHECK ("pos"."branch_closing_wallets"."counted_poisha" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pos"."branch_closings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"closed_by" text NOT NULL,
	"sales_count" integer NOT NULL,
	"net_sales_poisha" bigint NOT NULL,
	"refunds_poisha" bigint NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_branch_closings_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "pos_branch_closings_sales_count" CHECK ("pos"."branch_closings"."sales_count" >= 0),
	CONSTRAINT "pos_branch_closings_note_length" CHECK ("pos"."branch_closings"."note" is null or length("pos"."branch_closings"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "pos"."registers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"cash_wallet_id" uuid NOT NULL,
	"bkash_wallet_id" uuid,
	"card_wallet_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_shift_no" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_registers_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "pos_registers_code_format" CHECK ("pos"."registers"."code" ~ '^[A-Z0-9]{2,8}$'),
	CONSTRAINT "pos_registers_name_length" CHECK (length("pos"."registers"."name") between 1 and 80),
	CONSTRAINT "pos_registers_last_shift_no" CHECK ("pos"."registers"."last_shift_no" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pos"."return_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"sale_id" uuid NOT NULL,
	"sale_line_no" integer NOT NULL,
	"sku_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"refund_poisha" bigint NOT NULL,
	"unit_cost_poisha" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_return_lines_org_return_line_key" UNIQUE("org_id","return_id","line_no"),
	CONSTRAINT "pos_return_lines_qty_positive" CHECK ("pos"."return_lines"."qty" > 0),
	CONSTRAINT "pos_return_lines_line_no_positive" CHECK ("pos"."return_lines"."line_no" > 0),
	CONSTRAINT "pos_return_lines_refund_not_negative" CHECK ("pos"."return_lines"."refund_poisha" >= 0),
	CONSTRAINT "pos_return_lines_cost_not_negative" CHECK ("pos"."return_lines"."unit_cost_poisha" is null or "pos"."return_lines"."unit_cost_poisha" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pos"."return_tenders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"tender" "pos"."tender" NOT NULL,
	"amount_poisha" bigint NOT NULL,
	"wallet_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_return_tenders_amount_positive" CHECK ("pos"."return_tenders"."amount_poisha" > 0)
);
--> statement-breakpoint
CREATE TABLE "pos"."returns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"receipt_no" text NOT NULL,
	"created_by" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"posted_on" date,
	"status" "pos"."document_status" NOT NULL,
	"refund_poisha" bigint NOT NULL,
	"cogs_poisha" bigint,
	"journal_id" uuid,
	"reason" text,
	"payload_hash" text NOT NULL,
	"void_reason" text,
	"voided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_returns_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "pos_returns_refund_not_negative" CHECK ("pos"."returns"."refund_poisha" >= 0),
	CONSTRAINT "pos_returns_receipt_length" CHECK (length("pos"."returns"."receipt_no") between 1 and 40),
	CONSTRAINT "pos_returns_reason_length" CHECK ("pos"."returns"."reason" is null or length("pos"."returns"."reason") <= 200),
	CONSTRAINT "pos_returns_status_shape" CHECK (case "pos"."returns"."status"
            when 'posted' then "pos"."returns"."posted_on" is not null and "pos"."returns"."cogs_poisha" is not null
                 and ("pos"."returns"."journal_id" is not null or ("pos"."returns"."refund_poisha" = 0 and "pos"."returns"."cogs_poisha" = 0))
            when 'held' then "pos"."returns"."journal_id" is null and "pos"."returns"."posted_on" is null
            else "pos"."returns"."journal_id" is null and "pos"."returns"."void_reason" is not null and "pos"."returns"."voided_by" is not null
          end)
);
--> statement-breakpoint
CREATE TABLE "pos"."review_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"kind" "pos"."document_kind" NOT NULL,
	"sale_id" uuid,
	"return_id" uuid,
	"reasons" "pos"."hold_reason"[] NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "pos"."review_status" DEFAULT 'open' NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_review_items_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "pos_review_items_document" CHECK (("pos"."review_items"."kind" = 'sale' and "pos"."review_items"."sale_id" is not null and "pos"."review_items"."return_id" is null)
          or ("pos"."review_items"."kind" = 'return' and "pos"."review_items"."return_id" is not null and "pos"."review_items"."sale_id" is null)),
	CONSTRAINT "pos_review_items_has_reason" CHECK (cardinality("pos"."review_items"."reasons") > 0),
	CONSTRAINT "pos_review_items_resolution_shape" CHECK (("pos"."review_items"."status" = 'open') = ("pos"."review_items"."resolved_at" is null and "pos"."review_items"."resolved_by" is null)),
	CONSTRAINT "pos_review_items_note_length" CHECK ("pos"."review_items"."resolution_note" is null or length("pos"."review_items"."resolution_note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "pos"."sale_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"sku_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_poisha" bigint NOT NULL,
	"discount_poisha" bigint NOT NULL,
	"net_poisha" bigint NOT NULL,
	"catalog_price_poisha" bigint,
	"unit_cost_poisha" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_sale_lines_org_sale_line_key" UNIQUE("org_id","sale_id","line_no"),
	CONSTRAINT "pos_sale_lines_qty_positive" CHECK ("pos"."sale_lines"."qty" > 0),
	CONSTRAINT "pos_sale_lines_line_no_positive" CHECK ("pos"."sale_lines"."line_no" > 0),
	CONSTRAINT "pos_sale_lines_price_not_negative" CHECK ("pos"."sale_lines"."unit_price_poisha" >= 0),
	CONSTRAINT "pos_sale_lines_net_is_difference" CHECK ("pos"."sale_lines"."discount_poisha" >= 0
          and "pos"."sale_lines"."discount_poisha" <= "pos"."sale_lines"."unit_price_poisha" * "pos"."sale_lines"."qty"
          and "pos"."sale_lines"."net_poisha" = "pos"."sale_lines"."unit_price_poisha" * "pos"."sale_lines"."qty" - "pos"."sale_lines"."discount_poisha"),
	CONSTRAINT "pos_sale_lines_cost_not_negative" CHECK ("pos"."sale_lines"."unit_cost_poisha" is null or "pos"."sale_lines"."unit_cost_poisha" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pos"."sale_tenders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"tender" "pos"."tender" NOT NULL,
	"amount_poisha" bigint NOT NULL,
	"wallet_id" uuid NOT NULL,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_sale_tenders_amount_positive" CHECK ("pos"."sale_tenders"."amount_poisha" > 0),
	CONSTRAINT "pos_sale_tenders_reference_length" CHECK ("pos"."sale_tenders"."reference" is null or length("pos"."sale_tenders"."reference") between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "pos"."sales" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"receipt_no" text NOT NULL,
	"seller_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"posted_on" date,
	"status" "pos"."document_status" NOT NULL,
	"gross_poisha" bigint NOT NULL,
	"discount_poisha" bigint NOT NULL,
	"net_poisha" bigint NOT NULL,
	"cash_received_poisha" bigint NOT NULL,
	"change_poisha" bigint NOT NULL,
	"cogs_poisha" bigint,
	"journal_id" uuid,
	"payload_hash" text NOT NULL,
	"exchange_return_id" uuid,
	"void_reason" text,
	"voided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_sales_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "pos_sales_net_is_difference" CHECK ("pos"."sales"."net_poisha" = "pos"."sales"."gross_poisha" - "pos"."sales"."discount_poisha"),
	CONSTRAINT "pos_sales_discount_within_gross" CHECK ("pos"."sales"."discount_poisha" >= 0 and "pos"."sales"."discount_poisha" <= "pos"."sales"."gross_poisha"),
	CONSTRAINT "pos_sales_cash_shape" CHECK ("pos"."sales"."change_poisha" >= 0 and "pos"."sales"."cash_received_poisha" >= "pos"."sales"."change_poisha"),
	CONSTRAINT "pos_sales_receipt_length" CHECK (length("pos"."sales"."receipt_no") between 1 and 40),
	CONSTRAINT "pos_sales_status_shape" CHECK (case "pos"."sales"."status"
            when 'posted' then "pos"."sales"."posted_on" is not null and "pos"."sales"."cogs_poisha" is not null
                 and ("pos"."sales"."journal_id" is not null or ("pos"."sales"."net_poisha" = 0 and "pos"."sales"."cogs_poisha" = 0))
            when 'held' then "pos"."sales"."journal_id" is null and "pos"."sales"."posted_on" is null
            else "pos"."sales"."journal_id" is null and "pos"."sales"."void_reason" is not null and "pos"."sales"."voided_by" is not null
          end)
);
--> statement-breakpoint
CREATE TABLE "pos"."shifts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"shift_no" integer NOT NULL,
	"status" "pos"."shift_status" DEFAULT 'open' NOT NULL,
	"opened_by" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"opening_float_poisha" bigint NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"counted_cash_poisha" bigint,
	"expected_cash_poisha" bigint,
	"variance_poisha" bigint,
	"close_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_shifts_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "pos_shifts_float_not_negative" CHECK ("pos"."shifts"."opening_float_poisha" >= 0),
	CONSTRAINT "pos_shifts_no_positive" CHECK ("pos"."shifts"."shift_no" > 0),
	CONSTRAINT "pos_shifts_close_shape" CHECK (case "pos"."shifts"."status"
            when 'open' then "pos"."shifts"."closed_at" is null and "pos"."shifts"."closed_by" is null
                 and "pos"."shifts"."counted_cash_poisha" is null and "pos"."shifts"."variance_poisha" is null
            else "pos"."shifts"."closed_at" is not null and "pos"."shifts"."closed_by" is not null
                 and "pos"."shifts"."counted_cash_poisha" >= 0 and "pos"."shifts"."expected_cash_poisha" is not null
                 and "pos"."shifts"."variance_poisha" = "pos"."shifts"."counted_cash_poisha" - "pos"."shifts"."expected_cash_poisha"
          end)
);
--> statement-breakpoint
ALTER TABLE "pos"."branch_closing_wallets" ADD CONSTRAINT "branch_closing_wallets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."branch_closing_wallets" ADD CONSTRAINT "pos_branch_closing_wallets_org_id_closing_id_fk" FOREIGN KEY ("org_id","branch_closing_id") REFERENCES "pos"."branch_closings"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."branch_closing_wallets" ADD CONSTRAINT "pos_branch_closing_wallets_org_id_wallet_id_fk" FOREIGN KEY ("org_id","wallet_id") REFERENCES "wallets"."wallets"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."branch_closing_wallets" ADD CONSTRAINT "pos_branch_closing_wallets_org_id_wallet_closing_id_fk" FOREIGN KEY ("org_id","wallet_closing_id") REFERENCES "wallets"."closings"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."branch_closings" ADD CONSTRAINT "branch_closings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."branch_closings" ADD CONSTRAINT "pos_branch_closings_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."registers" ADD CONSTRAINT "registers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."registers" ADD CONSTRAINT "pos_registers_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."registers" ADD CONSTRAINT "pos_registers_org_id_location_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "org"."locations"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."registers" ADD CONSTRAINT "pos_registers_org_id_cash_wallet_id_fk" FOREIGN KEY ("org_id","cash_wallet_id") REFERENCES "wallets"."wallets"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."registers" ADD CONSTRAINT "pos_registers_org_id_bkash_wallet_id_fk" FOREIGN KEY ("org_id","bkash_wallet_id") REFERENCES "wallets"."wallets"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."registers" ADD CONSTRAINT "pos_registers_org_id_card_wallet_id_fk" FOREIGN KEY ("org_id","card_wallet_id") REFERENCES "wallets"."wallets"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."return_lines" ADD CONSTRAINT "return_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."return_lines" ADD CONSTRAINT "pos_return_lines_org_id_return_id_fk" FOREIGN KEY ("org_id","return_id") REFERENCES "pos"."returns"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."return_lines" ADD CONSTRAINT "pos_return_lines_org_id_sale_line_fk" FOREIGN KEY ("org_id","sale_id","sale_line_no") REFERENCES "pos"."sale_lines"("org_id","sale_id","line_no") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."return_lines" ADD CONSTRAINT "pos_return_lines_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."return_tenders" ADD CONSTRAINT "return_tenders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."return_tenders" ADD CONSTRAINT "pos_return_tenders_org_id_return_id_fk" FOREIGN KEY ("org_id","return_id") REFERENCES "pos"."returns"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."return_tenders" ADD CONSTRAINT "pos_return_tenders_org_id_wallet_id_fk" FOREIGN KEY ("org_id","wallet_id") REFERENCES "wallets"."wallets"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."returns" ADD CONSTRAINT "returns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."returns" ADD CONSTRAINT "pos_returns_org_id_register_id_fk" FOREIGN KEY ("org_id","register_id") REFERENCES "pos"."registers"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."returns" ADD CONSTRAINT "pos_returns_org_id_shift_id_fk" FOREIGN KEY ("org_id","shift_id") REFERENCES "pos"."shifts"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."returns" ADD CONSTRAINT "pos_returns_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."returns" ADD CONSTRAINT "pos_returns_org_id_location_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "org"."locations"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."returns" ADD CONSTRAINT "pos_returns_org_id_sale_id_fk" FOREIGN KEY ("org_id","sale_id") REFERENCES "pos"."sales"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."returns" ADD CONSTRAINT "pos_returns_org_id_journal_id_fk" FOREIGN KEY ("org_id","journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."review_items" ADD CONSTRAINT "review_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."review_items" ADD CONSTRAINT "pos_review_items_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."review_items" ADD CONSTRAINT "pos_review_items_org_id_sale_id_fk" FOREIGN KEY ("org_id","sale_id") REFERENCES "pos"."sales"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."review_items" ADD CONSTRAINT "pos_review_items_org_id_return_id_fk" FOREIGN KEY ("org_id","return_id") REFERENCES "pos"."returns"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale_lines" ADD CONSTRAINT "sale_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale_lines" ADD CONSTRAINT "pos_sale_lines_org_id_sale_id_fk" FOREIGN KEY ("org_id","sale_id") REFERENCES "pos"."sales"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale_lines" ADD CONSTRAINT "pos_sale_lines_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale_tenders" ADD CONSTRAINT "sale_tenders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale_tenders" ADD CONSTRAINT "pos_sale_tenders_org_id_sale_id_fk" FOREIGN KEY ("org_id","sale_id") REFERENCES "pos"."sales"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sale_tenders" ADD CONSTRAINT "pos_sale_tenders_org_id_wallet_id_fk" FOREIGN KEY ("org_id","wallet_id") REFERENCES "wallets"."wallets"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sales" ADD CONSTRAINT "sales_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sales" ADD CONSTRAINT "pos_sales_org_id_register_id_fk" FOREIGN KEY ("org_id","register_id") REFERENCES "pos"."registers"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sales" ADD CONSTRAINT "pos_sales_org_id_shift_id_fk" FOREIGN KEY ("org_id","shift_id") REFERENCES "pos"."shifts"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sales" ADD CONSTRAINT "pos_sales_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sales" ADD CONSTRAINT "pos_sales_org_id_location_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "org"."locations"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."sales" ADD CONSTRAINT "pos_sales_org_id_journal_id_fk" FOREIGN KEY ("org_id","journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."shifts" ADD CONSTRAINT "shifts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."shifts" ADD CONSTRAINT "pos_shifts_org_id_register_id_fk" FOREIGN KEY ("org_id","register_id") REFERENCES "pos"."registers"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos"."shifts" ADD CONSTRAINT "pos_shifts_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "pos_branch_closing_wallets_org_idx" ON "pos"."branch_closing_wallets" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "pos_branch_closing_wallets_org_closing_wallet_idx" ON "pos"."branch_closing_wallets" USING btree ("org_id","branch_closing_id","wallet_id");
--> statement-breakpoint
CREATE INDEX "pos_branch_closings_org_idx" ON "pos"."branch_closings" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "pos_branch_closings_org_branch_date_idx" ON "pos"."branch_closings" USING btree ("org_id","branch_id","business_date");
--> statement-breakpoint
CREATE INDEX "pos_registers_org_idx" ON "pos"."registers" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "pos_registers_org_branch_idx" ON "pos"."registers" USING btree ("org_id","branch_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "pos_registers_org_code_idx" ON "pos"."registers" USING btree ("org_id","code");
--> statement-breakpoint
CREATE INDEX "pos_return_lines_org_idx" ON "pos"."return_lines" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "pos_return_lines_org_sale_line_idx" ON "pos"."return_lines" USING btree ("org_id","sale_id","sale_line_no");
--> statement-breakpoint
CREATE INDEX "pos_return_tenders_org_idx" ON "pos"."return_tenders" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "pos_return_tenders_org_return_tender_idx" ON "pos"."return_tenders" USING btree ("org_id","return_id","tender");
--> statement-breakpoint
CREATE INDEX "pos_returns_org_idx" ON "pos"."returns" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "pos_returns_org_branch_date_idx" ON "pos"."returns" USING btree ("org_id","branch_id","business_date");
--> statement-breakpoint
CREATE INDEX "pos_returns_org_shift_idx" ON "pos"."returns" USING btree ("org_id","shift_id");
--> statement-breakpoint
CREATE INDEX "pos_returns_org_sale_idx" ON "pos"."returns" USING btree ("org_id","sale_id");
--> statement-breakpoint
CREATE INDEX "pos_review_items_org_idx" ON "pos"."review_items" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "pos_review_items_org_branch_status_idx" ON "pos"."review_items" USING btree ("org_id","branch_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "pos_review_items_org_open_sale_idx" ON "pos"."review_items" USING btree ("org_id","sale_id") WHERE "pos"."review_items"."status" = 'open' and "pos"."review_items"."sale_id" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "pos_review_items_org_open_return_idx" ON "pos"."review_items" USING btree ("org_id","return_id") WHERE "pos"."review_items"."status" = 'open' and "pos"."review_items"."return_id" is not null;
--> statement-breakpoint
CREATE INDEX "pos_sale_lines_org_idx" ON "pos"."sale_lines" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "pos_sale_tenders_org_idx" ON "pos"."sale_tenders" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sale_tenders_org_sale_tender_idx" ON "pos"."sale_tenders" USING btree ("org_id","sale_id","tender");
--> statement-breakpoint
CREATE INDEX "pos_sales_org_idx" ON "pos"."sales" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "pos_sales_org_branch_date_idx" ON "pos"."sales" USING btree ("org_id","branch_id","business_date");
--> statement-breakpoint
CREATE INDEX "pos_sales_org_shift_idx" ON "pos"."sales" USING btree ("org_id","shift_id");
--> statement-breakpoint
CREATE INDEX "pos_sales_org_receipt_idx" ON "pos"."sales" USING btree ("org_id","receipt_no");
--> statement-breakpoint
CREATE INDEX "pos_sales_org_status_idx" ON "pos"."sales" USING btree ("org_id","status");
--> statement-breakpoint
CREATE INDEX "pos_shifts_org_idx" ON "pos"."shifts" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "pos_shifts_org_branch_date_idx" ON "pos"."shifts" USING btree ("org_id","branch_id","business_date");
--> statement-breakpoint
CREATE UNIQUE INDEX "pos_shifts_org_register_open_idx" ON "pos"."shifts" USING btree ("org_id","register_id") WHERE "pos"."shifts"."status" = 'open';
--> statement-breakpoint
CREATE UNIQUE INDEX "pos_shifts_org_register_no_idx" ON "pos"."shifts" USING btree ("org_id","register_id","shift_no");
