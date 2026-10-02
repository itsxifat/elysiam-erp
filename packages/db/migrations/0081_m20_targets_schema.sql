CREATE TYPE "hr"."bonus_rule_version_status" AS ENUM('draft', 'pending_approval', 'approved', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "hr"."target_metric" AS ENUM('confirmed_orders', 'delivered_orders', 'delivered_revenue');--> statement-breakpoint
CREATE TYPE "hr"."target_scope" AS ENUM('employee', 'team');--> statement-breakpoint
CREATE TYPE "hr"."target_status" AS ENUM('active', 'cancelled');--> statement-breakpoint
CREATE TABLE "hr"."bonus_awards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"rule_version_id" uuid NOT NULL,
	"payroll_input_id" uuid NOT NULL,
	"target_value" bigint NOT NULL,
	"achieved" bigint NOT NULL,
	"pct_bps" integer NOT NULL,
	"amount_poisha" bigint NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bonus_awards_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "bonus_awards_amount_positive" CHECK ("hr"."bonus_awards"."amount_poisha" > 0),
	CONSTRAINT "bonus_awards_target_positive" CHECK ("hr"."bonus_awards"."target_value" > 0)
);
--> statement-breakpoint
CREATE TABLE "hr"."bonus_rule_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"status" "hr"."bonus_rule_version_status" DEFAULT 'draft' NOT NULL,
	"approval_request_id" uuid,
	"decided_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bonus_rule_versions_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "bonus_rule_versions_version_positive" CHECK ("hr"."bonus_rule_versions"."version" >= 1),
	CONSTRAINT "bonus_rule_versions_submitted_has_request" CHECK ("hr"."bonus_rule_versions"."status" = 'draft' or "hr"."bonus_rule_versions"."approval_request_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "hr"."bonus_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"metric" "hr"."target_metric" NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bonus_rules_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "bonus_rules_name_length" CHECK (length("hr"."bonus_rules"."name") between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "hr"."desk_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"assignee_user_id" text,
	"actor_user_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "desk_events_kind" CHECK ("hr"."desk_events"."kind" in ('created', 'assigned', 'claimed', 'confirmed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "hr"."target_members" (
	"org_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "target_members_pkey" PRIMARY KEY("org_id","target_id","employee_id")
);
--> statement-breakpoint
CREATE TABLE "hr"."target_weeks" (
	"org_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"week_no" smallint NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"working_days" smallint NOT NULL,
	"planned" bigint NOT NULL,
	"achieved" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "target_weeks_pkey" PRIMARY KEY("org_id","target_id","week_no"),
	CONSTRAINT "target_weeks_week_no" CHECK ("hr"."target_weeks"."week_no" between 1 and 6),
	CONSTRAINT "target_weeks_dates" CHECK ("hr"."target_weeks"."ends_on" >= "hr"."target_weeks"."starts_on"),
	CONSTRAINT "target_weeks_working_days" CHECK ("hr"."target_weeks"."working_days" between 0 and 7),
	CONSTRAINT "target_weeks_planned_non_negative" CHECK ("hr"."target_weeks"."planned" >= 0),
	CONSTRAINT "target_weeks_achieved_non_negative" CHECK ("hr"."target_weeks"."achieved" >= 0)
);
--> statement-breakpoint
CREATE TABLE "hr"."targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"month" text NOT NULL,
	"metric" "hr"."target_metric" NOT NULL,
	"scope" "hr"."target_scope" NOT NULL,
	"employee_id" uuid,
	"team_name" text,
	"branch_id" uuid,
	"calendar_id" uuid NOT NULL,
	"target_value" bigint NOT NULL,
	"achieved" bigint DEFAULT 0 NOT NULL,
	"progress_at" timestamp with time zone,
	"status" "hr"."target_status" DEFAULT 'active' NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "targets_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "targets_month_format" CHECK ("hr"."targets"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "targets_value_positive" CHECK ("hr"."targets"."target_value" > 0),
	CONSTRAINT "targets_achieved_non_negative" CHECK ("hr"."targets"."achieved" >= 0),
	CONSTRAINT "targets_scope_shape" CHECK (("hr"."targets"."scope" = 'employee' and "hr"."targets"."employee_id" is not null and "hr"."targets"."team_name" is null)
          or ("hr"."targets"."scope" = 'team' and "hr"."targets"."employee_id" is null and "hr"."targets"."team_name" is not null)),
	CONSTRAINT "targets_team_name_length" CHECK ("hr"."targets"."team_name" is null or length("hr"."targets"."team_name") between 1 and 80),
	CONSTRAINT "targets_note_length" CHECK ("hr"."targets"."note" is null or length("hr"."targets"."note") <= 300),
	CONSTRAINT "targets_cancel_shape" CHECK (("hr"."targets"."status" = 'cancelled') = ("hr"."targets"."cancelled_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "events"."outbox" ADD COLUMN "actor_user_id" text;--> statement-breakpoint
ALTER TABLE "hr"."bonus_awards" ADD CONSTRAINT "bonus_awards_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."bonus_awards" ADD CONSTRAINT "bonus_awards_org_id_run_id_fk" FOREIGN KEY ("org_id","run_id") REFERENCES "hr"."payroll_runs"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."bonus_awards" ADD CONSTRAINT "bonus_awards_org_id_employee_id_fk" FOREIGN KEY ("org_id","employee_id") REFERENCES "hr"."employees"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."bonus_awards" ADD CONSTRAINT "bonus_awards_org_id_target_id_fk" FOREIGN KEY ("org_id","target_id") REFERENCES "hr"."targets"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."bonus_awards" ADD CONSTRAINT "bonus_awards_org_id_rule_version_id_fk" FOREIGN KEY ("org_id","rule_version_id") REFERENCES "hr"."bonus_rule_versions"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."bonus_awards" ADD CONSTRAINT "bonus_awards_org_id_payroll_input_id_fk" FOREIGN KEY ("org_id","payroll_input_id") REFERENCES "hr"."payroll_inputs"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."bonus_rule_versions" ADD CONSTRAINT "bonus_rule_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."bonus_rule_versions" ADD CONSTRAINT "bonus_rule_versions_org_id_rule_id_fk" FOREIGN KEY ("org_id","rule_id") REFERENCES "hr"."bonus_rules"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."bonus_rule_versions" ADD CONSTRAINT "bonus_rule_versions_org_id_approval_request_id_fk" FOREIGN KEY ("org_id","approval_request_id") REFERENCES "approvals"."approval_requests"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."bonus_rules" ADD CONSTRAINT "bonus_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."desk_events" ADD CONSTRAINT "desk_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."target_members" ADD CONSTRAINT "target_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."target_members" ADD CONSTRAINT "target_members_org_id_target_id_fk" FOREIGN KEY ("org_id","target_id") REFERENCES "hr"."targets"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."target_members" ADD CONSTRAINT "target_members_org_id_employee_id_fk" FOREIGN KEY ("org_id","employee_id") REFERENCES "hr"."employees"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."target_weeks" ADD CONSTRAINT "target_weeks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."target_weeks" ADD CONSTRAINT "target_weeks_org_id_target_id_fk" FOREIGN KEY ("org_id","target_id") REFERENCES "hr"."targets"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."targets" ADD CONSTRAINT "targets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."targets" ADD CONSTRAINT "targets_org_id_employee_id_fk" FOREIGN KEY ("org_id","employee_id") REFERENCES "hr"."employees"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."targets" ADD CONSTRAINT "targets_org_id_calendar_id_fk" FOREIGN KEY ("org_id","calendar_id") REFERENCES "hr"."work_calendars"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr"."targets" ADD CONSTRAINT "targets_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bonus_awards_org_run_idx" ON "hr"."bonus_awards" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bonus_awards_org_run_target_version_idx" ON "hr"."bonus_awards" USING btree ("org_id","run_id","target_id","rule_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bonus_awards_org_input_idx" ON "hr"."bonus_awards" USING btree ("org_id","payroll_input_id");--> statement-breakpoint
CREATE INDEX "bonus_rule_versions_org_idx" ON "hr"."bonus_rule_versions" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bonus_rule_versions_org_rule_version_idx" ON "hr"."bonus_rule_versions" USING btree ("org_id","rule_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "bonus_rule_versions_org_rule_approved_idx" ON "hr"."bonus_rule_versions" USING btree ("org_id","rule_id") WHERE status = 'approved';--> statement-breakpoint
CREATE UNIQUE INDEX "bonus_rule_versions_org_rule_pending_idx" ON "hr"."bonus_rule_versions" USING btree ("org_id","rule_id") WHERE status = 'pending_approval';--> statement-breakpoint
CREATE UNIQUE INDEX "bonus_rule_versions_org_approval_idx" ON "hr"."bonus_rule_versions" USING btree ("org_id","approval_request_id") WHERE approval_request_id is not null;--> statement-breakpoint
CREATE INDEX "bonus_rules_org_idx" ON "hr"."bonus_rules" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bonus_rules_org_name_idx" ON "hr"."bonus_rules" USING btree ("org_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "desk_events_org_event_idx" ON "hr"."desk_events" USING btree ("org_id","event_id");--> statement-breakpoint
CREATE INDEX "desk_events_org_order_idx" ON "hr"."desk_events" USING btree ("org_id","order_id");--> statement-breakpoint
CREATE INDEX "desk_events_org_occurred_idx" ON "hr"."desk_events" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "target_members_org_employee_idx" ON "hr"."target_members" USING btree ("org_id","employee_id");--> statement-breakpoint
CREATE INDEX "targets_org_idx" ON "hr"."targets" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "targets_org_month_idx" ON "hr"."targets" USING btree ("org_id","month");--> statement-breakpoint
CREATE UNIQUE INDEX "targets_org_month_metric_employee_idx" ON "hr"."targets" USING btree ("org_id","month","metric","employee_id") WHERE status = 'active' and scope = 'employee';