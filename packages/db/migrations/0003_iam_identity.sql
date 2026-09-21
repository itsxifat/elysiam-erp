CREATE SCHEMA "iam";
--> statement-breakpoint
CREATE TYPE "iam"."membership_role" AS ENUM('org_admin', 'sales', 'accounts', 'marketing', 'hr', 'branch_manager', 'warehouse', 'reseller', 'investor');--> statement-breakpoint
CREATE TABLE "iam"."accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"password" text,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iam"."membership_branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iam"."memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "iam"."membership_role" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iam"."sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"active_org_id" uuid,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "iam"."two_factors" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "iam"."users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"phone_number" text,
	"phone_number_verified" boolean DEFAULT false NOT NULL,
	"two_factor_enabled" boolean DEFAULT false NOT NULL,
	"is_super_admin" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_phone_number_unique" UNIQUE("phone_number")
);
--> statement-breakpoint
CREATE TABLE "iam"."verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "iam"."accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."membership_branches" ADD CONSTRAINT "membership_branches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."membership_branches" ADD CONSTRAINT "membership_branches_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "iam"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."membership_branches" ADD CONSTRAINT "membership_branches_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."sessions" ADD CONSTRAINT "sessions_active_org_id_organizations_id_fk" FOREIGN KEY ("active_org_id") REFERENCES "org"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."two_factors" ADD CONSTRAINT "two_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "iam"."accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_branches_unique_idx" ON "iam"."membership_branches" USING btree ("membership_id","branch_id");--> statement-breakpoint
CREATE INDEX "membership_branches_org_idx" ON "iam"."membership_branches" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_user_role_idx" ON "iam"."memberships" USING btree ("org_id","user_id","role");--> statement-breakpoint
CREATE INDEX "memberships_org_idx" ON "iam"."memberships" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "iam"."memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "iam"."sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "iam"."sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "two_factors_user_idx" ON "iam"."two_factors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "iam"."verifications" USING btree ("identifier");