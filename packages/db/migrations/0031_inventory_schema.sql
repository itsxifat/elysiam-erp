-- Stock levels, movements, reservations and costing (M07; architecture §8).
--
-- Generated from `packages/db/src/schema/inventory/index.ts` by drizzle-kit and
-- placed at this milestone's assigned number. The isolation policies and grants
-- follow in 0032, the integrity triggers Drizzle cannot express in 0033, and the
-- link that makes a branch manager's authority over a stock write-off real in
-- 0034.
--
-- Invariant 3 is the whole point of this file, and the three CHECKs that carry it
-- are on `stock_levels`: `on_hand >= 0`, `reserved >= 0`, `reserved <= on_hand`.
-- The third is the one that is easy to leave out, and without it the last five
-- units can be written off while five are reserved for a confirmed order — which
-- leaves an order nothing can fulfil and nothing that said so.
--
-- `stock_levels` has a natural primary key, `(org_id, sku_id, location_id)`, and
-- no surrogate id. That is deliberate: reserving stock is one conditional UPDATE
-- that has to name its row without reading it first (§8), and a surrogate key
-- invites the `select … then update` version, which loses units under concurrency
-- in a way no single-threaded test finds.
--
-- `stock_movements.dedupe_key` exists because §20's queues are at-least-once: a
-- retried "record the dispatch for this order" would otherwise ship the stock
-- twice.

-- `org.locations` needs the composite unique constraint every tenant parent carries
-- (D-047) before anything can reference it.
--
-- `branches` has had it since M01. `locations` did not, because until this milestone
-- nothing pointed at a location — and a composite foreign key needs a unique
-- constraint to reference. It has to be `(org_id, id)` rather than the existing
-- `(org_id, code)` index: a code is a label people change, and a reference through it
-- would move a year of stock movements to a different location the day somebody
-- renamed a warehouse.
ALTER TABLE "org"."locations" ADD CONSTRAINT "locations_org_id_id_key" UNIQUE("org_id","id");
--> statement-breakpoint
CREATE SCHEMA "inventory";
--> statement-breakpoint
CREATE TYPE "inventory"."adjustment_direction" AS ENUM('loss', 'gain');
--> statement-breakpoint
CREATE TYPE "inventory"."adjustment_status" AS ENUM('pending_approval', 'posted', 'rejected');
--> statement-breakpoint
CREATE TYPE "inventory"."count_status" AS ENUM('open', 'submitted', 'closed', 'cancelled');
--> statement-breakpoint
CREATE TYPE "inventory"."movement_kind" AS ENUM('opening_balance', 'supply_receipt', 'supplier_return', 'dispatch', 'customer_return', 'pos_sale', 'pos_return', 'transfer_out', 'transfer_in', 'adjustment_gain', 'adjustment_loss', 'count_correction');
--> statement-breakpoint
CREATE TYPE "inventory"."reservation_status" AS ENUM('active', 'consumed', 'released');
--> statement-breakpoint
CREATE TYPE "inventory"."transfer_status" AS ENUM('dispatched', 'received', 'cancelled');
--> statement-breakpoint
CREATE TABLE "inventory"."adjustment_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"unit_cost_poisha" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adjustment_lines_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "adjustment_lines_qty_positive" CHECK ("inventory"."adjustment_lines"."qty" > 0),
	CONSTRAINT "adjustment_lines_unit_cost_not_negative" CHECK ("inventory"."adjustment_lines"."unit_cost_poisha" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory"."adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"branch_id" uuid,
	"direction" "inventory"."adjustment_direction" NOT NULL,
	"status" "inventory"."adjustment_status" DEFAULT 'pending_approval' NOT NULL,
	"count_session_id" uuid,
	"value_poisha" bigint NOT NULL,
	"reason" text NOT NULL,
	"approval_request_id" uuid,
	"journal_id" uuid,
	"business_date" date NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adjustments_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "adjustments_value_not_negative" CHECK ("inventory"."adjustments"."value_poisha" >= 0),
	CONSTRAINT "adjustments_reason_length" CHECK (length("inventory"."adjustments"."reason") between 1 and 500),
	CONSTRAINT "adjustments_status_journal" CHECK (case "inventory"."adjustments"."status"
            when 'posted' then "inventory"."adjustments"."journal_id" is not null and "inventory"."adjustments"."approval_request_id" is not null
            when 'pending_approval' then "inventory"."adjustments"."journal_id" is null and "inventory"."adjustments"."approval_request_id" is not null
            else "inventory"."adjustments"."journal_id" is null
          end)
);
--> statement-breakpoint
CREATE TABLE "inventory"."count_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"snapshot_qty" integer NOT NULL,
	"counted_qty" integer,
	"counted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "count_lines_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "count_lines_snapshot_not_negative" CHECK ("inventory"."count_lines"."snapshot_qty" >= 0),
	CONSTRAINT "count_lines_counted_not_negative" CHECK ("inventory"."count_lines"."counted_qty" is null or "inventory"."count_lines"."counted_qty" >= 0),
	CONSTRAINT "count_lines_counted_is_complete" CHECK (("inventory"."count_lines"."counted_qty" is null) = ("inventory"."count_lines"."counted_by" is null))
);
--> statement-breakpoint
CREATE TABLE "inventory"."count_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"branch_id" uuid,
	"status" "inventory"."count_status" DEFAULT 'open' NOT NULL,
	"memo" text,
	"frozen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "count_sessions_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "count_sessions_closed_is_complete" CHECK (("inventory"."count_sessions"."status" in ('closed', 'cancelled')) = ("inventory"."count_sessions"."closed_at" is not null)),
	CONSTRAINT "count_sessions_memo_length" CHECK ("inventory"."count_sessions"."memo" is null or length("inventory"."count_sessions"."memo") <= 500)
);
--> statement-breakpoint
CREATE TABLE "inventory"."reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"levels_checked" integer NOT NULL,
	"drift_count" integer NOT NULL,
	"cost_drift_count" integer DEFAULT 0 NOT NULL,
	"details" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliations_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "reconciliations_counts_not_negative" CHECK ("inventory"."reconciliations"."levels_checked" >= 0 and "inventory"."reconciliations"."drift_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory"."reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"status" "inventory"."reservation_status" DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "reservations_qty_positive" CHECK ("inventory"."reservations"."qty" > 0),
	CONSTRAINT "reservations_ref_type_format" CHECK ("inventory"."reservations"."ref_type" ~ '^[a-z][a-z0-9_]{0,31}$')
);
--> statement-breakpoint
CREATE TABLE "inventory"."sku_costs" (
	"org_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"wac_poisha" bigint NOT NULL,
	"qty_basis" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sku_costs_pkey" PRIMARY KEY("org_id","sku_id"),
	CONSTRAINT "sku_costs_wac_not_negative" CHECK ("inventory"."sku_costs"."wac_poisha" >= 0),
	CONSTRAINT "sku_costs_wac_bounded" CHECK ("inventory"."sku_costs"."wac_poisha" <= 9000000000000000),
	CONSTRAINT "sku_costs_basis_not_negative" CHECK ("inventory"."sku_costs"."qty_basis" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_levels" (
	"org_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"reorder_level" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_levels_pkey" PRIMARY KEY("org_id","sku_id","location_id"),
	CONSTRAINT "stock_levels_on_hand_not_negative" CHECK ("inventory"."stock_levels"."on_hand" >= 0),
	CONSTRAINT "stock_levels_reserved_not_negative" CHECK ("inventory"."stock_levels"."reserved" >= 0),
	CONSTRAINT "stock_levels_reserved_within_on_hand" CHECK ("inventory"."stock_levels"."reserved" <= "inventory"."stock_levels"."on_hand"),
	CONSTRAINT "stock_levels_reorder_not_negative" CHECK ("inventory"."stock_levels"."reorder_level" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" "inventory"."movement_kind" NOT NULL,
	"qty_delta" integer NOT NULL,
	"unit_cost_poisha" bigint,
	"ref_type" text NOT NULL,
	"ref_id" uuid,
	"dedupe_key" text,
	"business_date" date NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"memo" text,
	"created_by" text NOT NULL,
	"created_txid" "xid8" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "stock_movements_sign_matches_kind" CHECK (("inventory"."stock_movements"."kind"::text in ('opening_balance', 'supply_receipt', 'customer_return', 'pos_return', 'transfer_in', 'adjustment_gain') and "inventory"."stock_movements"."qty_delta" > 0)
          or ("inventory"."stock_movements"."kind"::text in ('supplier_return', 'dispatch', 'pos_sale', 'transfer_out', 'adjustment_loss') and "inventory"."stock_movements"."qty_delta" < 0)
          or ("inventory"."stock_movements"."kind"::text = 'count_correction' and "inventory"."stock_movements"."qty_delta" <> 0)),
	CONSTRAINT "stock_movements_unit_cost_not_negative" CHECK ("inventory"."stock_movements"."unit_cost_poisha" is null or "inventory"."stock_movements"."unit_cost_poisha" >= 0),
	CONSTRAINT "stock_movements_unit_cost_bounded" CHECK ("inventory"."stock_movements"."unit_cost_poisha" is null or "inventory"."stock_movements"."unit_cost_poisha" <= 9000000000000000),
	CONSTRAINT "stock_movements_ref_type_format" CHECK ("inventory"."stock_movements"."ref_type" ~ '^[a-z][a-z0-9_]{0,31}$'),
	CONSTRAINT "stock_movements_memo_length" CHECK ("inventory"."stock_movements"."memo" is null or length("inventory"."stock_movements"."memo") <= 500)
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_transfer_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"transfer_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_transfer_lines_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "stock_transfer_lines_qty_positive" CHECK ("inventory"."stock_transfer_lines"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"from_location_id" uuid NOT NULL,
	"to_location_id" uuid NOT NULL,
	"transit_location_id" uuid NOT NULL,
	"status" "inventory"."transfer_status" DEFAULT 'dispatched' NOT NULL,
	"memo" text,
	"created_by" text NOT NULL,
	"received_by" text,
	"dispatched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_transfers_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "stock_transfers_distinct_locations" CHECK ("inventory"."stock_transfers"."from_location_id" <> "inventory"."stock_transfers"."to_location_id"),
	CONSTRAINT "stock_transfers_received_is_complete" CHECK (("inventory"."stock_transfers"."status" = 'received' and "inventory"."stock_transfers"."received_at" is not null and "inventory"."stock_transfers"."received_by" is not null)
          or ("inventory"."stock_transfers"."status" <> 'received' and "inventory"."stock_transfers"."received_at" is null and "inventory"."stock_transfers"."received_by" is null)),
	CONSTRAINT "stock_transfers_memo_length" CHECK ("inventory"."stock_transfers"."memo" is null or length("inventory"."stock_transfers"."memo") <= 500)
);
--> statement-breakpoint
ALTER TABLE "inventory"."adjustment_lines" ADD CONSTRAINT "adjustment_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."adjustment_lines" ADD CONSTRAINT "adjustment_lines_org_id_adjustment_id_fk" FOREIGN KEY ("org_id","adjustment_id") REFERENCES "inventory"."adjustments"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."adjustment_lines" ADD CONSTRAINT "adjustment_lines_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."adjustments" ADD CONSTRAINT "adjustments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."adjustments" ADD CONSTRAINT "adjustments_org_id_location_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "org"."locations"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."adjustments" ADD CONSTRAINT "adjustments_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."adjustments" ADD CONSTRAINT "adjustments_org_id_count_session_id_fk" FOREIGN KEY ("org_id","count_session_id") REFERENCES "inventory"."count_sessions"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."adjustments" ADD CONSTRAINT "adjustments_org_id_approval_request_id_fk" FOREIGN KEY ("org_id","approval_request_id") REFERENCES "approvals"."approval_requests"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."adjustments" ADD CONSTRAINT "adjustments_org_id_journal_id_fk" FOREIGN KEY ("org_id","journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."count_lines" ADD CONSTRAINT "count_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."count_lines" ADD CONSTRAINT "count_lines_org_id_session_id_fk" FOREIGN KEY ("org_id","session_id") REFERENCES "inventory"."count_sessions"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."count_lines" ADD CONSTRAINT "count_lines_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."count_sessions" ADD CONSTRAINT "count_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."count_sessions" ADD CONSTRAINT "count_sessions_org_id_location_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "org"."locations"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."count_sessions" ADD CONSTRAINT "count_sessions_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."reconciliations" ADD CONSTRAINT "reconciliations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."reservations" ADD CONSTRAINT "reservations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."reservations" ADD CONSTRAINT "reservations_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."reservations" ADD CONSTRAINT "reservations_org_id_location_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "org"."locations"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."sku_costs" ADD CONSTRAINT "sku_costs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."sku_costs" ADD CONSTRAINT "sku_costs_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_levels" ADD CONSTRAINT "stock_levels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_levels" ADD CONSTRAINT "stock_levels_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_levels" ADD CONSTRAINT "stock_levels_org_id_location_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "org"."locations"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_org_id_location_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "org"."locations"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_org_id_transfer_id_fk" FOREIGN KEY ("org_id","transfer_id") REFERENCES "inventory"."stock_transfers"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_org_id_sku_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "catalog"."skus"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_transfers" ADD CONSTRAINT "stock_transfers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_transfers" ADD CONSTRAINT "stock_transfers_org_id_from_location_id_fk" FOREIGN KEY ("org_id","from_location_id") REFERENCES "org"."locations"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_transfers" ADD CONSTRAINT "stock_transfers_org_id_to_location_id_fk" FOREIGN KEY ("org_id","to_location_id") REFERENCES "org"."locations"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inventory"."stock_transfers" ADD CONSTRAINT "stock_transfers_org_id_transit_location_id_fk" FOREIGN KEY ("org_id","transit_location_id") REFERENCES "org"."locations"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "adjustment_lines_org_idx" ON "inventory"."adjustment_lines" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "adjustment_lines_org_adjustment_sku_idx" ON "inventory"."adjustment_lines" USING btree ("org_id","adjustment_id","sku_id");
--> statement-breakpoint
CREATE INDEX "adjustments_org_idx" ON "inventory"."adjustments" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "adjustments_org_status_idx" ON "inventory"."adjustments" USING btree ("org_id","status");
--> statement-breakpoint
CREATE INDEX "adjustments_org_branch_idx" ON "inventory"."adjustments" USING btree ("org_id","branch_id");
--> statement-breakpoint
CREATE INDEX "adjustments_org_session_idx" ON "inventory"."adjustments" USING btree ("org_id","count_session_id");
--> statement-breakpoint
CREATE INDEX "count_lines_org_idx" ON "inventory"."count_lines" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "count_lines_org_session_sku_idx" ON "inventory"."count_lines" USING btree ("org_id","session_id","sku_id");
--> statement-breakpoint
CREATE INDEX "count_sessions_org_idx" ON "inventory"."count_sessions" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "count_sessions_org_branch_idx" ON "inventory"."count_sessions" USING btree ("org_id","branch_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "count_sessions_org_open_location_idx" ON "inventory"."count_sessions" USING btree ("org_id","location_id") WHERE "inventory"."count_sessions"."status" in ('open', 'submitted');
--> statement-breakpoint
CREATE INDEX "reconciliations_org_idx" ON "inventory"."reconciliations" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "reconciliations_org_date_idx" ON "inventory"."reconciliations" USING btree ("org_id","business_date");
--> statement-breakpoint
CREATE INDEX "reservations_org_idx" ON "inventory"."reservations" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "reservations_org_ref_idx" ON "inventory"."reservations" USING btree ("org_id","ref_type","ref_id");
--> statement-breakpoint
CREATE INDEX "reservations_org_sku_idx" ON "inventory"."reservations" USING btree ("org_id","sku_id","location_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_org_active_ref_idx" ON "inventory"."reservations" USING btree ("org_id","ref_type","ref_id","sku_id","location_id") WHERE "inventory"."reservations"."status" = 'active';
--> statement-breakpoint
CREATE INDEX "sku_costs_org_idx" ON "inventory"."sku_costs" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "stock_levels_org_idx" ON "inventory"."stock_levels" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "stock_levels_org_sku_idx" ON "inventory"."stock_levels" USING btree ("org_id","sku_id");
--> statement-breakpoint
CREATE INDEX "stock_levels_org_location_idx" ON "inventory"."stock_levels" USING btree ("org_id","location_id");
--> statement-breakpoint
CREATE INDEX "stock_movements_org_idx" ON "inventory"."stock_movements" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "stock_movements_org_sku_location_idx" ON "inventory"."stock_movements" USING btree ("org_id","sku_id","location_id");
--> statement-breakpoint
CREATE INDEX "stock_movements_org_date_idx" ON "inventory"."stock_movements" USING btree ("org_id","business_date");
--> statement-breakpoint
CREATE INDEX "stock_movements_org_ref_idx" ON "inventory"."stock_movements" USING btree ("org_id","ref_type","ref_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_org_dedupe_idx" ON "inventory"."stock_movements" USING btree ("org_id","dedupe_key") WHERE "inventory"."stock_movements"."dedupe_key" is not null;
--> statement-breakpoint
CREATE INDEX "stock_transfer_lines_org_idx" ON "inventory"."stock_transfer_lines" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "stock_transfer_lines_org_transfer_sku_idx" ON "inventory"."stock_transfer_lines" USING btree ("org_id","transfer_id","sku_id");
--> statement-breakpoint
CREATE INDEX "stock_transfers_org_idx" ON "inventory"."stock_transfers" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "stock_transfers_org_status_idx" ON "inventory"."stock_transfers" USING btree ("org_id","status");
