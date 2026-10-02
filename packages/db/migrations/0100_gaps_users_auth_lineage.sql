-- NOT VALID on memberships_not_self_granted: 0101 clears any self-grant and validates it,
-- with RLS lifted for the owner only inside that migration's transaction.
CREATE TABLE "iam"."membership_granters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"granted_by" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_granters_not_self" CHECK ("iam"."membership_granters"."granted_by" <> "iam"."membership_granters"."user_id"),
	CONSTRAINT "membership_granters_reason_known" CHECK ("iam"."membership_granters"."reason" in ('role_granted', 'link_issued', 'backfill'))
);
--> statement-breakpoint
ALTER TABLE "iam"."credential_resets" DROP CONSTRAINT "credential_resets_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "iam"."membership_granters" ADD CONSTRAINT "membership_granters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."membership_granters" ADD CONSTRAINT "membership_granters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "membership_granters_org_idx" ON "iam"."membership_granters" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "membership_granters_org_user_idx" ON "iam"."membership_granters" USING btree ("org_id","user_id");--> statement-breakpoint
ALTER TABLE "iam"."credential_resets" ADD CONSTRAINT "credential_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."memberships" ADD CONSTRAINT "memberships_not_self_granted" CHECK ("iam"."memberships"."granted_by" is distinct from "iam"."memberships"."user_id") NOT VALID;