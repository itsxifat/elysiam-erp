CREATE TABLE "iam"."trust_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"voter_user_id" text NOT NULL,
	"candidate_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trust_votes_not_self" CHECK ("iam"."trust_votes"."voter_user_id" <> "iam"."trust_votes"."candidate_user_id")
);
--> statement-breakpoint
ALTER TABLE "iam"."trust_votes" ADD CONSTRAINT "trust_votes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."trust_votes" ADD CONSTRAINT "trust_votes_voter_user_id_users_id_fk" FOREIGN KEY ("voter_user_id") REFERENCES "iam"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."trust_votes" ADD CONSTRAINT "trust_votes_candidate_user_id_users_id_fk" FOREIGN KEY ("candidate_user_id") REFERENCES "iam"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trust_votes_org_voter_candidate_idx" ON "iam"."trust_votes" USING btree ("org_id","voter_user_id","candidate_user_id");--> statement-breakpoint
CREATE INDEX "trust_votes_org_idx" ON "iam"."trust_votes" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "trust_votes_org_candidate_idx" ON "iam"."trust_votes" USING btree ("org_id","candidate_user_id");