CREATE SCHEMA "approvals";
--> statement-breakpoint
CREATE SCHEMA "audit";
--> statement-breakpoint
CREATE SCHEMA "demo";
--> statement-breakpoint
CREATE TYPE "approvals"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "approvals"."approval_type" AS ENUM('wallet_adjustment', 'stock_write_off', 'stock_gain', 'supplier_payment', 'settlement_posting', 'closing_variance', 'back_dated_entry', 'payroll_run', 'bonus_rule', 'reseller_payout_batch', 'period_reopen');--> statement-breakpoint
CREATE TYPE "audit"."audit_operation" AS ENUM('create', 'update', 'delete', 'approve', 'reject', 'login', 'logout');--> statement-breakpoint
CREATE TABLE "approvals"."approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"type" "approvals"."approval_type" NOT NULL,
	"status" "approvals"."approval_status" DEFAULT 'pending' NOT NULL,
	"requested_by" text NOT NULL,
	"amount_poisha" bigint,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_requests_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "approval_requests_maker_is_not_checker" CHECK ("approvals"."approval_requests"."decided_by" <> "approvals"."approval_requests"."requested_by"),
	CONSTRAINT "approval_requests_decision_is_complete" CHECK (("approvals"."approval_requests"."status" = 'pending' and "approvals"."approval_requests"."decided_by" is null and "approvals"."approval_requests"."decided_at" is null)
          or ("approvals"."approval_requests"."status" = 'cancelled' and "approvals"."approval_requests"."decided_by" is null)
          or ("approvals"."approval_requests"."status" in ('approved', 'rejected') and "approvals"."approval_requests"."decided_by" is not null and "approvals"."approval_requests"."decided_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "approvals"."approval_thresholds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"type" "approvals"."approval_type" NOT NULL,
	"threshold_poisha" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit"."audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_user_id" text,
	"operation" "audit"."audit_operation" NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"user_agent" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo"."costed_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"unit_cost_poisha" bigint NOT NULL,
	"sell_price_poisha" bigint NOT NULL,
	"available_qty" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "costed_items_org_sku_key" UNIQUE("org_id","sku")
);
--> statement-breakpoint
ALTER TABLE "approvals"."approval_requests" ADD CONSTRAINT "approval_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals"."approval_thresholds" ADD CONSTRAINT "approval_thresholds_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit"."audit_log" ADD CONSTRAINT "audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo"."costed_items" ADD CONSTRAINT "costed_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_requests_org_idx" ON "approvals"."approval_requests" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "approval_requests_pending_idx" ON "approvals"."approval_requests" USING btree ("org_id","status","type");--> statement-breakpoint
CREATE INDEX "approval_requests_requester_idx" ON "approvals"."approval_requests" USING btree ("org_id","requested_by");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_thresholds_org_type_idx" ON "approvals"."approval_thresholds" USING btree ("org_id","type");--> statement-breakpoint
CREATE INDEX "approval_thresholds_org_idx" ON "approvals"."approval_thresholds" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "audit_log_org_idx" ON "audit"."audit_log" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit"."audit_log" USING btree ("org_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit"."audit_log" USING btree ("org_id","actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit"."audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "costed_items_org_idx" ON "demo"."costed_items" USING btree ("org_id");