ALTER TYPE "approvals"."approval_type" ADD VALUE 'credential_reset';--> statement-breakpoint
CREATE TABLE "iam"."credential_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"requested_by" text NOT NULL,
	"reason" text NOT NULL,
	"approval_request_id" uuid,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"link_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_resets_kind_known" CHECK ("iam"."credential_resets"."kind" in ('invite', 'password', 'two_factor')),
	CONSTRAINT "credential_resets_status_known" CHECK ("iam"."credential_resets"."status" in ('pending_approval', 'approved', 'completed', 'rejected', 'cancelled', 'expired')),
	CONSTRAINT "credential_resets_not_self" CHECK ("iam"."credential_resets"."requested_by" <> "iam"."credential_resets"."user_id"),
	CONSTRAINT "credential_resets_invite_unapproved" CHECK ("iam"."credential_resets"."kind" <> 'invite' or "iam"."credential_resets"."approval_request_id" is null),
	CONSTRAINT "credential_resets_pending_has_approval" CHECK ("iam"."credential_resets"."status" not in ('pending_approval', 'approved') or "iam"."credential_resets"."approval_request_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "approvals"."approval_requests" DROP CONSTRAINT "approval_requests_never_auto_approved";--> statement-breakpoint
ALTER TABLE "approvals"."approval_thresholds" DROP CONSTRAINT "approval_thresholds_never_for_controls";--> statement-breakpoint
ALTER TABLE "iam"."users" ADD COLUMN "last_sign_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "iam"."credential_resets" ADD CONSTRAINT "credential_resets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."credential_resets" ADD CONSTRAINT "credential_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credential_resets_org_idx" ON "iam"."credential_resets" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "credential_resets_org_user_idx" ON "iam"."credential_resets" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "credential_resets_org_requester_idx" ON "iam"."credential_resets" USING btree ("org_id","requested_by");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_resets_one_open_idx" ON "iam"."credential_resets" USING btree ("org_id","user_id","kind") WHERE "iam"."credential_resets"."status" in ('pending_approval', 'approved');--> statement-breakpoint
ALTER TABLE "approvals"."approval_requests" ADD CONSTRAINT "approval_requests_never_auto_approved" CHECK ("approvals"."approval_requests"."status"::text <> 'auto_approved' or "approvals"."approval_requests"."type"::text not in ('period_reopen', 'bonus_rule', 'threshold_change', 'back_dated_entry', 'credential_reset'));--> statement-breakpoint
ALTER TABLE "approvals"."approval_thresholds" ADD CONSTRAINT "approval_thresholds_never_for_controls" CHECK ("approvals"."approval_thresholds"."type"::text not in ('period_reopen', 'bonus_rule', 'threshold_change', 'back_dated_entry', 'credential_reset'));